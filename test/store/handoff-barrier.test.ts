// WS-05 §12: the eight steps, and the three ways they end.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WINTER_BRAND, envName, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import {
  acquireHandoffLease,
  canonicalTranscriptPath,
  createHandoffBarrier,
  createMaterializedResumeDecorator,
  HANDOFF_STEPS,
  HandoffLeaseError,
  HandoffPlanError,
  localTranscriptPath,
  releaseHandoffLease,
  resolveEngineTempLayout,
  RESUME_STAGING_PREFIX,
  validateSessionTranscript,
  type HandoffBarrierDeps,
  type HandoffSourceOwner,
  type HandoffStepReport,
} from "../../src/store/index.ts";
import { SharedStoreUnavailableError } from "../../src/store/index.ts";
import { createRuntimeSdk, runtimeSdkInternals } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { selectionFor, sidecarPathFor, withStoreBed, type StoreBed } from "./support.ts";

const OK: HandoffStepReport = { ok: true };

/** A source owner that proves every step it is asked about — the baseline the failures deviate from. */
function idleOwner(overrides: Partial<HandoffSourceOwner> = {}): HandoffSourceOwner {
  return {
    runtimeKind: "winter-agent",
    drainToIdleBoundary: () => OK,
    drainStream: () => OK,
    close: () => OK,
    ...overrides,
  } as HandoffSourceOwner;
}

function barrierFor(bed: StoreBed, deps: Partial<HandoffBarrierDeps> = {}) {
  const full: HandoffBarrierDeps = {
    shared: bed.shared,
    winterHome: bed.home,
    leaseRoot: join(bed.home, "runtimes", "handoff-leases"),
    stagingRootFor: (uuid) => join(bed.home, "staging", `${RESUME_STAGING_PREFIX}${uuid}`),
    tempLayoutFor: () => {
      mkdirSync(bed.tempBase, { recursive: true });
      return resolveEngineTempLayout({
        brand: WINTER_BRAND,
        tempProjectKey: bed.key.projectKey,
        backendUuid: bed.key.sessionId,
        uid: 4242,
        env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase },
      });
    },
    ...deps,
  };
  return createHandoffBarrier(bed.context, full);
}

/** A destination that confirms whatever it is given, recording the target for assertions. */
function confirmingDestination(seen: { target?: unknown }, report: HandoffStepReport = OK) {
  return {
    runtimeKind: "claude-agent" as const,
    confirmInit(target: unknown) {
      seen.target = target;
      return report;
    },
  };
}

describe("the wiring the spine will do in one line", () => {
  test("both factories construct with the spine's OWN fake peer, and only a real handoff needs a store", async () => {
    // The exact call `src/sdk.ts` will make: `stubHandoffBarrier(context)` -> `createHandoffBarrier(context)`,
    // for EVERY `createRuntimeSdk` — including every spine test, whose peer exports five members and
    // neither a store class nor `resolveWinterHome`. If either factory resolved a store eagerly, this
    // line would throw there, and the "one-line swap" would not be one.
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain: createFakeKeychain() });
    const context = runtimeSdkInternals(sdk)!.context;

    const barrier = createHandoffBarrier(context);
    const decorator = createMaterializedResumeDecorator(context);
    // The decorator still ANSWERS the one question it can answer without a store (WS-13 §8.2 makes
    // FALLBACK the always-available door).
    expect(decorator.door).toBe("fallback");
    // A plan for an unknown session fails on the DIRECTORY, not on a missing store.
    await expect(barrier.plan({ projectKey: "p", sessionId: "s" }, "claude-agent")).rejects.toThrow(HandoffPlanError);
    // And the store is demanded only when a handoff actually runs.
    expect(() => barrier.shared).toThrow(SharedStoreUnavailableError);
  });
});

describe("plan() (R-7b-3: what the host renders)", () => {
  test("names WS-05 §12's eight steps in order, with the door and the continuity mode", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const plan = await barrierFor(bed).plan(bed.key, "claude-agent");
      expect(plan.from).toBe("winter-agent");
      expect(plan.to).toBe("claude-agent");
      expect(plan.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(plan.steps.map((step) => step.name)).toEqual(HANDOFF_STEPS.map((step) => step.name));
      expect(plan.decorationDoor).toBe("fallback");
      expect(plan.tempContinuity).toBe("clone-copy");
      expect((await barrierFor(bed).plan(bed.key, "winter-agent")).tempContinuity).toBe("adopt");
    });
  });

  test("a step already known to be unprovable is marked BEFORE anything runs", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const plan = await barrierFor(bed, {
        participants: {
          source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: "/spool", transcriptHealth: "repair-required" }) }),
        },
      }).plan(bed.key, "claude-agent");
      expect(plan.steps[3]!.knownUnprovable).toContain("/spool");
      expect(plan.steps[7]!.knownUnprovable).toContain("no destination runtime");
      expect(plan.steps[0]!.knownUnprovable).toBeUndefined();

      const sameRuntime = await barrierFor(bed).plan(bed.key, "winter-agent");
      expect(sameRuntime.steps[0]!.knownUnprovable).toContain("already owned");
    });
  });

  test("a session the directory has never heard of cannot be planned at all", async () => {
    await withStoreBed(async (bed) => {
      await expect(barrierFor(bed).plan(bed.key, "claude-agent")).rejects.toThrow(HandoffPlanError);
    });
  });
});

describe("the whole barrier, proved end to end", () => {
  test("Winter -> Claude: eight steps, the same backend uuid, and a staging root the resume can read", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(2);
      const seen: { target?: any } = {};
      const layoutBase = bed.tempBase;
      const barrier = barrierFor(bed, {
        participants: { source: () => idleOwner(), destination: () => confirmingDestination(seen) },
      });
      const plan = await barrier.plan(bed.key, "claude-agent");
      const outcome = await barrier.execute(plan);

      expect(outcome.kind).toBe("resumed");
      if (outcome.kind !== "resumed") throw new Error(outcome.detail);
      expect(outcome.selection.runtimeKind).toBe("claude-agent");
      expect(outcome.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(outcome.steps.every((step) => step.ok)).toBe(true);

      // Step 8's target: the SAME backend uuid and project key, plus what a `store-backed-resume`
      // launch needs — its staging root IS its CLAUDE_CONFIG_DIR (WS-14 §1).
      const target = outcome.target!;
      expect(seen.target).toBe(target);
      expect(target.backendSessionId).toBe(bed.key.sessionId);
      expect(target.projectKey).toBe(bed.key.projectKey);
      expect(target.compatibilityLevel).toBe("conversation");
      expect(target.profile).toBe("store-backed-resume");
      expect(target.stagingRoot).toContain(RESUME_STAGING_PREFIX);
      expect(target.resumePath.startsWith(target.stagingRoot!)).toBe(true);
      expect(readFileSync(target.resumePath, "utf8").trimEnd().split("\n").length).toBe(3); // 2 entries + the labeled note
      expect(target.address).toBe(entry.address);
      expect(target.door).toBe("fallback");

      // Step 6's commit, in the summary sidecar: producer, cursor and the source generation together.
      const summary = await bed.shared.canonical.readSessionSummary({ projectKey: bed.key.projectKey, sessionId: bed.key.sessionId });
      expect(summary!["producerRuntime"]).toBe("claude-agent");
      expect(summary!["dialectFamily"]).toBe("claude-code-jsonl");
      expect(summary!["compatibilityLevel"]).toBe("conversation");
      expect(summary!["sourceGenerationCompleted"]).toBe(1);
      expect(typeof summary!["projectionCursor"]).toBe("string");
      // ...and NOT in the transcript: the closed corpus never carries producer metadata.
      expect(readFileSync(canonicalTranscriptPath(bed.home, bed.key), "utf8")).not.toContain("winter_dialect_record");

      // The directory's derived copy followed.
      const stored = (await bed.directoryStore.load())[0]!;
      expect(stored.runtimeKind).toBe("claude-agent");
      expect(stored.generation).toBe(2);
      expect(await bed.directoryStore.cursors.get(entry.address)).toBe(String(summary!["projectionCursor"]));

      // Step 7: the vendor's computed path, under the shared root.
      expect(target.effectiveTempDir).toContain(join(`${WINTER_BRAND.tempRootName}-4242`, "claude-4242"));
      expect(target.effectiveTempDir.startsWith(layoutBase) || target.effectiveTempDir.startsWith("/private")).toBe(true);
    });
  });

  test("Claude -> Winter: the destination reads the canonical file, and adopts the vendor's temp dir", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selectionFor("claude-agent") });
      await bed.append(1);
      mkdirSync(bed.tempBase, { recursive: true });
      const layout = resolveEngineTempLayout({
        brand: WINTER_BRAND,
        tempProjectKey: bed.key.projectKey,
        backendUuid: bed.key.sessionId,
        uid: 4242,
        env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase },
      });
      mkdirSync(layout.vendorSessionDir, { recursive: true });
      writeFileSync(join(layout.vendorSessionDir, "note.txt"), "vendor scratch");

      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, {
        tempLayoutFor: () => layout,
        participants: {
          source: () => idleOwner({ runtimeKind: "claude-agent", effectiveTempDir: layout.vendorSessionDir }),
          destination: () => ({ runtimeKind: "winter-agent" as const, confirmInit: (target: unknown) => ((seen.target = target), OK) }),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "winter-agent"));

      expect(outcome.kind).toBe("resumed");
      const target = outcome.target!;
      expect(target.stagingRoot).toBeUndefined();
      expect(target.profile).toBeUndefined();
      expect(target.resumePath).toBe(canonicalTranscriptPath(bed.home, bed.key));
      // §9.1: adopted IN PLACE, so the vendor-side scratch is still where the transcript says it is.
      expect(target.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(readFileSync(join(target.effectiveTempDir, "note.txt"), "utf8")).toBe("vendor scratch");
      // A Winter destination decorates at render time: the canonical file gained no note.
      expect(((await bed.shared.store.load(bed.key)) ?? []).length).toBe(1);
    });
  });
});

describe("step 1 — the handoff lease", () => {
  test("a second handoff for the same session, in this process, is BLOCKED rather than queued", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const leaseRoot = join(bed.home, "runtimes", "handoff-leases");
      const held = acquireHandoffLease(leaseRoot, bed.key);
      try {
        const barrier = barrierFor(bed, { leaseRoot, participants: { source: () => idleOwner() } });
        const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
        expect(outcome.kind).toBe("blocked");
        if (outcome.kind !== "blocked") throw new Error("unreachable");
        expect(outcome.reason).toBe("lease-held");
        expect(outcome.step).toBe(1);
      } finally {
        releaseHandoffLease(held);
      }
    });
  });

  test("a lease held by another LIVE process is refused; a stale one is taken over", async () => {
    await withStoreBed(async (bed) => {
      const leaseRoot = join(bed.home, "runtimes", "handoff-leases");
      const path = join(leaseRoot, bed.key.projectKey, `${bed.key.sessionId}.lock`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ pid: 1, startTimeMs: Date.now() })); // pid 1 is always alive
      expect(() => acquireHandoffLease(leaseRoot, bed.key)).toThrow(HandoffLeaseError);

      writeFileSync(path, JSON.stringify({ pid: 999_999, startTimeMs: Date.now() })); // long gone
      const lease = acquireHandoffLease(leaseRoot, bed.key);
      expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
      releaseHandoffLease(lease);
      expect(() => acquireHandoffLease(leaseRoot, bed.key)).not.toThrow();
      releaseHandoffLease({ path });
    });
  });

  test("the lease is released whatever the outcome, so the next attempt is not poisoned", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner({ drainToIdleBoundary: () => ({ ok: false, reason: "a background task is still running" }) }) } });
      const first = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(first.kind).toBe("lossy-fork-offered");
      const second = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(second.kind).toBe("lossy-fork-offered"); // and NOT `blocked: lease-held`
      expect(second.step).toBe(2);
    });
  });
});

describe("steps 2 and 3 — the drains", () => {
  test("a turn that never reaches an idle boundary is step 2's fork, naming the step", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner({ drainToIdleBoundary: () => ({ ok: false, reason: "a workflow is mid-run" }) }) } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 2, reason: "a workflow is mid-run" });
      expect(outcome.steps.at(-1)).toMatchObject({ step: 2, ok: false });
    });
  });

  test("a stream that never reached its terminal result is step 3's fork", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner({ drainStream: () => ({ ok: false, reason: "stdout closed before the terminal result" }) }) } });
      expect(await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).toMatchObject({ kind: "lossy-fork-offered", step: 3 });
    });
  });

  test("step 3 waits for the pending appends: an append made mid-barrier is in the transcript step 5 validates", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const [a] = await bed.append(1);
      const late = bed.entry();
      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, {
        participants: {
          // The drain is where a real owner's last frames arrive — appended, not settled.
          source: () =>
            idleOwner({
              drainStream: async () => {
                await bed.shared.store.append(bed.key, [late]);
                return OK;
              },
            }),
          destination: () => confirmingDestination(seen),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      expect(readFileSync(canonicalTranscriptPath(bed.home, bed.key), "utf8")).toContain(late["uuid"] as string);
      expect(outcome.steps[2]!.detail).toContain("append batch(es) settled");
      void a;
    });
  });
});

describe("step 4 — the canonical tail against the recorded local-write root", () => {
  test("a lagging canonical store is RECONCILED in place, not refused", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const [a] = await bed.append(1);
      const b = bed.entry();
      const spool = join(bed.home, "spool");
      const path = localTranscriptPath(spool, bed.key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);

      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }),
          destination: () => confirmingDestination(seen),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      expect(outcome.steps[3]!.detail).toContain("reconciled");
      expect(((await bed.shared.store.load(bed.key)) ?? []).map((entry) => entry["uuid"])).toContain(b["uuid"]);
    });
  });

  test("a canonical store that disagrees with the local root is BLOCKED as repair-required", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const spool = join(bed.home, "spool");
      const path = localTranscriptPath(spool, bed.key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(bed.entry())}\n`); // a different history

      const barrier = barrierFor(bed, {
        participants: { source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "blocked", reason: "repair-required", step: 4 });
    });
  });

  test("a mirror error the barrier cannot reconcile BLOCKS with `mirror-error`", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      // The store's own health, set the way a real failed batch sets it.
      const failing = bed.entry();
      const shared = bed.shared;
      await shared.store.append({ ...bed.key, subpath: "subagents/agent-x" }, [failing]);
      await shared.settle(bed.key);
      // Force the flag directly through a failed append on the same session.
      (shared as unknown as { health: (key: SessionKey) => { transcriptHealth: string } }).health(bed.key);
      const barrier = barrierFor(bed, {
        participants: {
          source: () =>
            idleOwner({
              health: () => ({ launchedThroughProxy: false, transcriptHealth: "repair-required" }),
              // Lane A's own answer for a default-spawn session with a mirror error.
              eligibility: () => ({
                eligible: false,
                reason: "default-spawn-mirror-error",
                detail: "this session was launched with the default spawner, so its active local-write root was never recorded",
              }),
            }),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "blocked", reason: "mirror-error", step: 4 });
      expect(outcome.detail).toContain("default spawner");
    });
  });

  test("Lane A's other two refusals map onto `repair-required`", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      for (const reason of ["repair-required", "no-recorded-root"] as const) {
        const barrier = barrierFor(bed, {
          participants: { source: () => idleOwner({ eligibility: () => ({ eligible: false, reason, detail: `because ${reason}` }) }) },
        });
        expect(await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).toMatchObject({ kind: "blocked", reason: "repair-required", step: 4 });
      }
    });
  });

  test("a mirror error recorded on the store itself blocks even when the owner says nothing", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      // A failing batch, injected through the store facade's own error path.
      const broken = bed.shared as unknown as { canonical: { append: (key: SessionKey, entries: SessionStoreEntry[]) => Promise<void> } };
      const original = broken.canonical.append.bind(broken.canonical);
      broken.canonical.append = async () => {
        throw new Error("mirror is down");
      };
      await bed.shared.store.append(bed.key, [bed.entry()]);
      await bed.shared.settle(bed.key);
      broken.canonical.append = original;
      expect(bed.shared.health(bed.key).transcriptHealth).toBe("repair-required");

      const barrier = barrierFor(bed, { participants: { source: () => idleOwner() } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "blocked", reason: "mirror-error", step: 4 });
    });
  });
});

describe("step 5 — validation", () => {
  test("an unreachable parent is a fork naming step 5, and the source keeps the session", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(1);
      await bed.shared.store.append(bed.key, [bed.entry({ parentUuid: "11111111-0000-4000-8000-000000000000" })]);
      await bed.shared.settle(bed.key);

      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 5 });
      if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
      expect(outcome.reason).toContain("unreachable parentUuid");
      // Nothing moved: no producer record, and the directory still names the source.
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe(entry.runtimeKind);
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["producerRuntime"]).toBeUndefined();
    });
  });

  test("framing, uuids, tool pairing, compaction and subkeys each have their own answer", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      expect((await validateSessionTranscript(bed.shared, bed.key, bed.home)).ok).toBe(true);

      // tool_use with no result, and not at the tail.
      const call = bed.entry({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
      await bed.shared.store.append(bed.key, [call, bed.entry()]);
      await bed.shared.settle(bed.key);
      const unpaired = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(unpaired.ok).toBe(false);
      if (unpaired.ok) throw new Error("unreachable");
      expect(unpaired.reason).toContain("tool_use t1");

      // ...and paired, it validates again.
      await bed.shared.store.append(bed.key, [bed.entry({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })]);
      await bed.shared.settle(bed.key);
      expect((await validateSessionTranscript(bed.shared, bed.key, bed.home)).ok).toBe(true);

      // A compaction boundary with no summary in front of it.
      await bed.shared.store.append(bed.key, [bed.entry({ type: "compact_boundary" })]);
      await bed.shared.settle(bed.key);
      const compaction = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(compaction.ok).toBe(false);
      if (compaction.ok) throw new Error("unreachable");
      expect(compaction.reason).toContain("compact_summary");
      void a;
    });
  });

  test("framing is checked on the BYTES, because `load()` repairs the one thing bytes can show", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(2);
      const path = canonicalTranscriptPath(bed.home, bed.key);
      const lines = readFileSync(path, "utf8").split("\n");
      writeFileSync(path, [lines[0], '{"type":"user"', lines[1], ""].join("\n"));
      const validation = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(validation.ok).toBe(false);
      if (validation.ok) throw new Error("unreachable");
      expect(validation.reason).toContain("framing");
    });
  });

  test("a subkey that is listed but does not load fails the step", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      const subkey: SessionKey = { ...bed.key, subpath: "subagents/agent-a1" };
      // A child's chain is its OWN — `parentUuid` is the parent within this transcript, never the
      // spawning session's tail (WS-05 §5.2 keeps those two apart deliberately).
      await bed.shared.store.append(subkey, [bed.entry({ key: subkey, parentUuid: null })]);
      await bed.shared.settle(subkey);
      expect((await validateSessionTranscript(bed.shared, bed.key, bed.home)).ok).toBe(true);

      // Break the child's own chain.
      const childPath = join(bed.home, "projects", bed.key.projectKey, bed.key.sessionId, "subagents", "agent-a1.jsonl");
      appendFileSync(childPath, `${JSON.stringify({ type: "user", uuid: "x", parentUuid: "does-not-exist" })}\n`);
      const validation = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(validation.ok).toBe(false);
      if (validation.ok) throw new Error("unreachable");
      expect(validation.reason).toContain("subagents/agent-a1");
    });
  });

  test("the provider-state sidecar is reported and left alone", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      const sidecar = sidecarPathFor(bed.home, bed.key);
      writeFileSync(sidecar, '{"payload":"opaque"}\n');
      const before = readFileSync(sidecar);
      const validation = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(validation.ok).toBe(true);
      if (!validation.ok) throw new Error("unreachable");
      expect(validation.detail).toContain("provider-state sidecar");
      expect(validation.detail).toContain("left untouched");
      expect(readFileSync(sidecar)).toEqual(before);
    });
  });
});

describe("steps 6 to 8", () => {
  test("an advertised level is never silently downgraded", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      await bed.shared.store.append(bed.key, [{ type: "winter_dialect_record", compatibilityLevel: "agent-state" }]);
      await bed.shared.settle(bed.key);

      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination(seen) } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      expect(outcome.target!.compatibilityLevel).toBe("agent-state");
      expect((await bed.shared.canonical.readSessionSummary(bed.key))!["compatibilityLevel"]).toBe("agent-state");
    });
  });

  test("with no destination, step 8 is a fork — the next user message is never delivered on a guess", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner() } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
      if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
      expect(outcome.reason).toContain("confirm");
    });
  });

  test("a destination that refuses init is step 8's fork, with its own reason", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, {
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}, { ok: false, reason: "init reported a different session id" }) },
      });
      expect(await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).toMatchObject({ kind: "lossy-fork-offered", step: 8, reason: "init reported a different session id" });
    });
  });

  test("under the PREFERRED door the canonical file is byte-identical across the whole barrier", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(2);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        report: {
          door: "preferred",
          probedAt: new Date(0).toISOString(),
          results: (["neighbor-file-survival", "no-wash-back", "sidecar-round-trip", "crash-pairs"] as const).map((probe) => ({ probe, passed: true, evidence: "recorded" })),
        },
      });
      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, { decorator, participants: { source: () => idleOwner(), destination: () => confirmingDestination(seen) } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));

      expect(outcome.kind).toBe("resumed");
      expect(outcome.target!.door).toBe("preferred");
      expect(readFileSync(canonicalPath)).toEqual(before);
      expect(readFileSync(outcome.target!.resumePath, "utf8").trimEnd().split("\n")).toHaveLength(3);
      expect(bed.shared.decorations.list(bed.key)).toHaveLength(1);
    });
  });
});
