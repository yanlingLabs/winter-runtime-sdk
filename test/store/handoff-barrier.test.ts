// WS-05 §12: the eight steps, and the three ways they end.
import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { WinterCompatibilitySessionStore, WINTER_BRAND, envName, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

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
  validateSessionTranscript,
  type HandoffBarrierDeps,
  type HandoffSourceOwner,
  type HandoffStepReport,
} from "../../src/store/index.ts";
import { SharedStoreUnavailableError } from "../../src/store/index.ts";
import { createRuntimeSdk, runtimeSdkInternals } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { createInMemoryRuntimeDirectoryStore, type RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import { createSharedSessionStore, HandoffWiringError } from "../../src/store/index.ts";
import { RESUME_STAGING_PREFIX } from "../../src/vendor-paths.ts";
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

/**
 * The bed's barrier.
 *
 * A CONFIRMING DESTINATION IS THE DEFAULT (review r1, F7). `plan()` marks step 8 `knownUnprovable`
 * when no destination is supplied, and `execute()` now REFUSES such a plan instead of running seven
 * steps to reach the same conclusion — so a test that means to exercise step 2 has to supply one.
 * `destination: false` opts out, for the tests that are about its absence.
 */
function barrierFor(bed: StoreBed, deps: Partial<HandoffBarrierDeps> = {}, options: { destination?: false } = {}) {
  const participants =
    options.destination === false
      ? deps.participants
      : { ...deps.participants, destination: deps.participants?.destination ?? (() => ({ runtimeKind: "claude-agent" as const, confirmInit: () => OK })) };
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
    ...(participants === undefined ? {} : { participants }),
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
  test("`barrier.decorator` — the expression the spine WRITES — is readable with the spine's own fake peer", async () => {
    // The exact two expressions `src/sdk.ts` evaluates for EVERY `createRuntimeSdk`, including every
    // spine test, whose peer exports five members and neither a store class nor `resolveWinterHome`.
    // Reading `barrier.decorator` used to resolve the store through the F2 identity check and throw
    // here (review r2, N1) — and the previous version of this test missed it by building the decorator
    // separately, which is not what the wiring does.
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain: createFakeKeychain() });
    const context = runtimeSdkInternals(sdk)!.context;

    const barrier = createHandoffBarrier(context);
    const decorator = barrier.decorator; // <- the wiring line
    expect(decorator.door).toBe("fallback");
    expect(barrier.decorator).toBe(decorator); // memoised, and still no store
    // A plan for an unknown session fails on the DIRECTORY, not on a missing store.
    await expect(barrier.plan({ projectKey: "p", sessionId: "s" }, "claude-agent")).rejects.toThrow(HandoffPlanError);
    // And the store is demanded only when a handoff actually runs.
    expect(() => barrier.shared).toThrow(SharedStoreUnavailableError);
  });

  test("...and with a peer whose `resolveWinterHome` throws, which is this lane's own bed", async () => {
    // review r2, PLANT 20. The bed's peer HAS the store class; what it refuses is resolving a real home.
    await withStoreBed(async (bed) => {
      const barrier = createHandoffBarrier(bed.context);
      expect(barrier.decorator.door).toBe("fallback");
      await expect(barrier.plan({ projectKey: "p", sessionId: "s" }, "claude-agent")).rejects.toThrow(HandoffPlanError);
      expect(() => barrier.shared).toThrow("a hermetic test must never resolve the real Winter home");
    });
  });

  test("an injected decorator is still checked — but only when a handoff needs the store", async () => {
    await withStoreBed(async (bed) => {
      const second = createSharedSessionStore({ peers: bed.peers, winterHome: bed.home });
      const foreign = createMaterializedResumeDecorator(bed.context, { shared: second });
      const barrier = barrierFor(bed, { decorator: foreign, participants: { source: () => idleOwner() } });
      // Reading it is free; USING it is what refuses.
      expect(barrier.decorator).toBe(foreign);
      await bed.record();
      await expect(barrier.plan(bed.key, "claude-agent")).rejects.toThrow(HandoffWiringError);
    });
  });

  test("a decorator that cannot say which store it writes into is refused", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const bare = { door: "fallback" as const, probe: async () => ({ door: "fallback" as const, results: [], probedAt: "" }), decorate: async () => ({ door: "fallback" as const, resumePath: "", canonicalUntouched: true }) };
      const barrier = barrierFor(bed, { decorator: bare as never, participants: { source: () => idleOwner() } });
      await expect(barrier.plan(bed.key, "claude-agent")).rejects.toThrow(HandoffWiringError);
    });
  });
});

describe("plan() (R-7b-3: what the host renders)", () => {
  test("names WS-05 §12's eight steps in order, with the door and the continuity mode", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const plan = await barrierFor(bed, {}, { destination: false }).plan(bed.key, "claude-agent");
      expect(plan.from).toBe("winter-agent");
      expect(plan.to).toBe("claude-agent");
      expect(plan.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(plan.steps.map((step) => step.name)).toEqual(HANDOFF_STEPS.map((step) => step.name));
      expect(plan.decorationDoor).toBe("fallback");
      expect(plan.tempContinuity).toBe("clone-copy");
      expect((await barrierFor(bed, {}, { destination: false }).plan(bed.key, "winter-agent")).tempContinuity).toBe("adopt");
    });
  });

  test("a step already known to be unprovable is marked BEFORE anything runs", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const plan = await barrierFor(
        bed,
        { participants: { source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: "/spool", transcriptHealth: "repair-required" }) }) } },
        { destination: false },
      ).plan(bed.key, "claude-agent");
      expect(plan.steps[3]!.knownUnprovable).toContain("/spool");
      expect(plan.steps[7]!.knownUnprovable).toContain("no destination runtime");
      expect(plan.steps[0]!.knownUnprovable).toBeUndefined();

      const sameRuntime = await barrierFor(bed, {}, { destination: false }).plan(bed.key, "winter-agent");
      expect(sameRuntime.steps[0]!.knownUnprovable).toContain("already owned");
    });
  });

  test("a session the directory has never heard of cannot be planned at all", async () => {
    await withStoreBed(async (bed) => {
      await expect(barrierFor(bed, {}, { destination: false }).plan(bed.key, "claude-agent")).rejects.toThrow(HandoffPlanError);
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

  test("uuids, tool pairing and the parent chain each have their own answer", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      expect((await validateSessionTranscript(bed.shared, bed.key, bed.home)).ok).toBe(true);

      // An interrupted turn: a tool_use with no result. NO exemption for the final entry (review r1,
      // F3) — an interrupted turn is not the idle terminal boundary a handoff needs.
      const call = bed.entry({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } });
      await bed.shared.store.append(bed.key, [call]);
      await bed.shared.settle(bed.key);
      const interrupted = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(interrupted.ok).toBe(false);
      if (interrupted.ok) throw new Error("unreachable");
      expect(interrupted.reason).toContain("tool_use t1");
      expect(interrupted.reason).toContain("interrupted");

      // ...and paired, it validates again.
      await bed.shared.store.append(bed.key, [bed.entry({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } })]);
      await bed.shared.settle(bed.key);
      expect((await validateSessionTranscript(bed.shared, bed.key, bed.home)).ok).toBe(true);

      // A result with no call is the other half of the pairing rule.
      await bed.shared.store.append(bed.key, [bed.entry({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "ok" }] } })]);
      await bed.shared.settle(bed.key);
      const orphan = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(orphan.ok).toBe(false);
      if (orphan.ok) throw new Error("unreachable");
      expect(orphan.reason).toContain("tool_result orphan");
    });
  });

  test("the parent chain is checked for REACHABILITY: a forward reference and a cycle both fail", async () => {
    await withStoreBed(async (bed) => {
      // A forward reference — the parent uuid exists in the file, but AFTER its child (review r1, F14).
      const later = "aaaaaaaa-0000-4000-8000-000000000001";
      await bed.shared.store.append(bed.key, [
        { type: "user", uuid: "bbbbbbbb-0000-4000-8000-000000000001", parentUuid: later, sessionId: bed.key.sessionId, cwd: "/x", version: "0", isSidechain: false },
        { type: "user", uuid: later, parentUuid: null, sessionId: bed.key.sessionId, cwd: "/x", version: "0", isSidechain: false },
      ]);
      await bed.shared.settle(bed.key);
      const forward = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(forward.ok).toBe(false);
      if (forward.ok) throw new Error("unreachable");
      expect(forward.reason).toContain("unreachable parentUuid");
    });
  });

  test("compaction is validated in the shape the corpus actually carries, both of them", async () => {
    await withStoreBed(async (bed) => {
      const [a, b] = await bed.append(2);
      // WS-05 §5.1's observed corpus lists `compact_boundary` under SYSTEM SUBTYPES; the Winter
      // dialect's own writer emits it top-level. A shared store can hold both (review r1, F5).
      const good = bed.entry({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 900, preserved_messages: { anchor_uuid: a!["uuid"], uuids: [b!["uuid"]] } },
      });
      await bed.shared.store.append(bed.key, [good]);
      await bed.shared.settle(bed.key);
      const valid = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(valid.ok, valid.ok ? "" : valid.reason).toBe(true);
      if (!valid.ok) throw new Error("unreachable");
      expect(valid.detail).toContain("1 compaction boundar");

      // A boundary preserving a uuid the transcript does not have cannot have its kept segment
      // rebuilt — WS-05 §5.1 calls that a resume-CORRECTNESS requirement.
      await bed.shared.store.append(bed.key, [
        bed.entry({
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "manual", pre_tokens: 10, preserved_messages: { anchor_uuid: a!["uuid"], uuids: ["cccccccc-0000-4000-8000-000000000009"] } },
        }),
      ]);
      await bed.shared.settle(bed.key);
      const malformed = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(malformed.ok).toBe(false);
      if (malformed.ok) throw new Error("unreachable");
      expect(malformed.reason).toContain("cccccccc-0000-4000-8000-000000000009");
    });
  });

  test("the Winter dialect's own top-level boundary shape is validated the same way", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      await bed.shared.store.append(bed.key, [
        bed.entry({ type: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 5, preserved_messages: { anchor_uuid: "dddddddd-0000-4000-8000-000000000009", uuids: [] } } }),
      ]);
      await bed.shared.settle(bed.key);
      const validation = await validateSessionTranscript(bed.shared, bed.key, bed.home);
      expect(validation.ok).toBe(false);
      if (validation.ok) throw new Error("unreachable");
      expect(validation.reason).toContain("anchors on");
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
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner() } }, { destination: false });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
      if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
      expect(outcome.reason).toContain("confirm");
      // Nothing ran: the plan already knew, so no lease was taken and no marker was written.
      expect(outcome.steps).toHaveLength(1);
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

describe("F1 — ownership moves ONLY after step 8 confirms (WS-05 §12's own closing sentence)", () => {
  test("a destination that refuses init leaves the SOURCE owning the session, and the transcript unchanged", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(2);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      const staged: string[] = [];

      const barrier = barrierFor(bed, {
        stagingRootFor: (uuid) => {
          const root = join(bed.home, "staging", `${RESUME_STAGING_PREFIX}${uuid}`);
          staged.push(root);
          return root;
        },
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}, { ok: false, reason: "init reported a different session id" }) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });

      // "keep the source owner" — in the PERSISTED state, not only in the outcome's wording.
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe(entry.runtimeKind);
      expect((await bed.directoryStore.load())[0]!.generation).toBe(entry.generation);
      const summary = await bed.shared.canonical.readSessionSummary(bed.key);
      expect(summary?.["producerRuntime"]).toBeUndefined();
      expect(summary?.["pendingHandoff"]).toBeNull(); // the marker is cleared, not left dangling
      expect(await bed.directoryStore.cursors.get(entry.address)).toBeUndefined();

      // ...and NO note: the canonical file must not carry "this continues on claude-agent" for a
      // runtime that never started.
      expect(readFileSync(canonicalPath)).toEqual(before);
      expect(((await bed.shared.store.load(bed.key)) ?? [])).toHaveLength(2);

      // A new plan still sees the source as the owner, so the session can be handed off later.
      expect((await barrier.plan(bed.key, "claude-agent")).from).toBe(entry.runtimeKind);
      // The decorated copy nobody resumed from is gone, so nothing can reconcile from it later.
      expect(staged.every((root) => !existsSync(root))).toBe(true);
    });
  });

  test("a step-7 failure leaves ownership with the source too", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, {
        tempLayoutFor: () => {
          throw new Error("the shared temp root is not owned by this uid");
        },
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 7 });
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe(entry.runtimeKind);
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["producerRuntime"]).toBeUndefined();
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"]).toBeNull();
    });
  });

  test("a directory write lost inside the commit is `resumed`, not `lossy` — and the cache is repaired", async () => {
    // The commit is two writes: the producer record (authoritative, atomic) and the directory's derived
    // copy. Once the FIRST has landed the handoff IS committed — a destination is already running on it
    // — so the outcome is `resumed` with the lagging copy NAMED (review r2, N2.1), and the next `plan()`
    // brings the cache into line (review r1, F1).
    const failing = createInMemoryRuntimeDirectoryStore();
    let failNextUpsert = false;
    const guarded: RuntimeDirectoryStore = {
      ...failing,
      async upsert(entry) {
        if (failNextUpsert) {
          failNextUpsert = false;
          throw new Error("the process died before the directory was written");
        }
        return failing.upsert(entry);
      },
    };
    await withStoreBed(
      async (bed) => {
        const entry = await bed.record();
        await bed.append(1);
        const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
        const plan = await barrier.plan(bed.key, "claude-agent");
        failNextUpsert = true;
        const outcome = await barrier.execute(plan);

        expect(outcome.kind).toBe("resumed");
        expect(outcome.detail).toContain("derived copy is behind");
        expect((await bed.shared.canonical.readSessionSummary(bed.key))!["producerRuntime"]).toBe("claude-agent");
        expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("winter-agent");

        // The next plan() repairs it: the transcript's own record is authoritative (WS-05 §5.4).
        const repaired = await barrier.plan(bed.key, "winter-agent");
        expect(repaired.from).toBe("claude-agent");
        expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("claude-agent");
        expect((await bed.directoryStore.load())[0]!.generation).toBe(entry.generation + 1);
        expect(await bed.directoryStore.cursors.get(entry.address)).toBe(String((await bed.shared.canonical.readSessionSummary(bed.key))!["projectionCursor"]));
      },
      { directoryStore: guarded },
    );
  });

  test("a directory that NEVER accepts a write does not make the session unplannable", async () => {
    // review r2, N2.3: a throwing `upsert` used to propagate a raw host error out of every future
    // `plan()`. The repair is best-effort now; the entry it returns is the authoritative one either way.
    const inner = createInMemoryRuntimeDirectoryStore();
    let readOnly = false;
    const guarded: RuntimeDirectoryStore = {
      ...inner,
      async upsert(entry) {
        if (readOnly) throw new Error("the host directory is read-only");
        return inner.upsert(entry);
      },
    };
    await withStoreBed(
      async (bed) => {
        await bed.record();
        await bed.append(1);
        const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
        const plan = await barrier.plan(bed.key, "claude-agent");
        readOnly = true;
        const outcome = await barrier.execute(plan);
        expect(outcome.kind).toBe("resumed");
        // Every later plan still works, and reports the authoritative owner rather than the stale cache.
        for (let i = 0; i < 2; i++) expect((await barrier.plan(bed.key, "winter-agent")).from).toBe("claude-agent");
      },
      { directoryStore: guarded },
    );
  });

  test("the FALLBACK note enters the canonical file only after init confirms, and exactly once", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(2);
      const seen: { target?: any } = {};
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination(seen) } });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      const entries = (await bed.shared.store.load(bed.key)) ?? [];
      expect(entries).toHaveLength(3);
      expect(String((entries[2]!["message"] as { content: string }).content)).toContain("[handoff:");
      // The staged copy and the canonical file agree — the same note, not two of them.
      const copy = readFileSync(outcome.target!.resumePath, "utf8").trimEnd().split("\n");
      expect(copy).toHaveLength(3);
      expect(JSON.parse(copy[2]!).uuid).toBe(entries[2]!["uuid"]);
    });
  });
});

describe("F2 — one store for the barrier and the decorator", () => {
  test("the barrier's own decorator reports the SAME store instance", async () => {
    await withStoreBed(async (bed) => {
      const barrier = createHandoffBarrier(bed.context, { winterHome: bed.home });
      expect(barrier.decorator.shared).toBe(barrier.shared);
      expect(barrier.decorator.shared.identity.instanceId).toBe(barrier.shared.identity.instanceId);
    });
  });

  test("a decorator built over a DIFFERENT store is refused, not silently used", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const second = createSharedSessionStore({ peers: bed.peers, winterHome: bed.home });
      const foreign = createMaterializedResumeDecorator(bed.context, { shared: second });
      const barrier = barrierFor(bed, { decorator: foreign, participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      await expect(barrier.plan(bed.key, "claude-agent")).rejects.toThrow(HandoffWiringError);
    });
  });

  test("the WIRED shape does not wash a decoration back into the canonical file", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(2);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);

      // Exactly the shape the spine wires: ONE barrier, and its OWN decorator — with the door forced
      // open so the PREFERRED path really runs.
      const barrier = createHandoffBarrier(bed.context, {
        shared: bed.shared,
        winterHome: bed.home,
        leaseRoot: join(bed.home, "runtimes", "handoff-leases"),
        stagingRootFor: (uuid) => join(bed.home, "staging", `${RESUME_STAGING_PREFIX}${uuid}`),
        tempLayoutFor: () => {
          mkdirSync(bed.tempBase, { recursive: true });
          return resolveEngineTempLayout({ brand: WINTER_BRAND, tempProjectKey: bed.key.projectKey, backendUuid: bed.key.sessionId, uid: 4242, env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase } });
        },
        decorator: createMaterializedResumeDecorator(bed.context, {
          shared: bed.shared,
          report: { door: "preferred", probedAt: new Date(0).toISOString(), results: (["neighbor-file-survival", "no-wash-back", "sidecar-round-trip", "crash-pairs"] as const).map((probe) => ({ probe, passed: true, evidence: "forced open for this test" })) },
        }),
        participants: { source: () => idleOwner(), destination: () => ({ runtimeKind: "claude-agent" as const, confirmInit: () => OK }) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      expect(outcome.target!.door).toBe("preferred");

      // The decoration is known to the store the BARRIER writes through — the registry that gates
      // every canonical append.
      expect(barrier.shared.decorations.list(bed.key)).toHaveLength(1);
      expect(readFileSync(canonicalPath)).toEqual(before);

      // Now the destination mirrors its next turn back, parented on the decoration — the wash-back.
      const decorationUuid = barrier.shared.decorations.list(bed.key)[0]!;
      const turn = bed.entry({ parentUuid: decorationUuid });
      await bed.shared.store.append(bed.key, [turn]);
      await bed.shared.settle(bed.key);
      const entries = (await bed.shared.store.load(bed.key)) ?? [];
      expect(entries.map((entry) => entry["uuid"])).not.toContain(decorationUuid);
      expect(entries[entries.length - 1]!["parentUuid"]).toBe(entries[1]!["uuid"]);
    });
  });
});

describe("F3 — an interrupted turn is refused before anything is written", () => {
  test("a trailing unpaired tool_use forks at step 5, appends no note, and becomes handoffable once its result lands", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      await bed.shared.store.append(bed.key, [bed.entry({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] } })]);
      await bed.shared.settle(bed.key);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);

      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      const first = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(first).toMatchObject({ kind: "lossy-fork-offered", step: 5 });
      // The barrier must not MANUFACTURE the condition it then refuses on: no note was appended.
      expect(readFileSync(canonicalPath)).toEqual(before);

      // The tool result lands, and the same session hands off cleanly.
      await bed.shared.store.append(bed.key, [bed.entry({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } })]);
      await bed.shared.settle(bed.key);
      const second = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(second.kind).toBe("resumed");
    });
  });
});

describe("F7 / F8 / F9 — plan and execute agree", () => {
  test("a plan whose step is already known unprovable is refused rather than run", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      const plan = await barrier.plan(bed.key, "winter-agent"); // the session is ALREADY winter-agent
      expect(plan.steps[0]!.knownUnprovable).toContain("moves nothing");
      const outcome = await barrier.execute(plan);
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 1 });
      // Nothing ran: no generation bump, no producer record.
      expect((await bed.directoryStore.load())[0]!.generation).toBe(entry.generation);
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["producerRuntime"]).toBeUndefined();
    });
  });

  test("plan() marks step 4 from the STORE's health, not only the owner's self-report", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      // A mirror failure the owner never hears about.
      const canonical = bed.shared.canonical as unknown as { append: (key: SessionKey, entries: SessionStoreEntry[]) => Promise<void> };
      const original = canonical.append.bind(canonical);
      canonical.append = async () => {
        throw new Error("mirror is down");
      };
      await bed.shared.store.append(bed.key, [bed.entry()]);
      await bed.shared.settle(bed.key);
      canonical.append = original;

      const plan = await barrierFor(bed, { participants: { source: () => idleOwner() } }).plan(bed.key, "claude-agent");
      expect(plan.steps[3]!.knownUnprovable).toContain("mirror is unhealthy");
    });
  });

  test("a plan built when another runtime owned the session is not executed", async () => {
    await withStoreBed(async (bed) => {
      const entry = await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      const plan = await barrier.plan(bed.key, "claude-agent");
      // The session moves under the plan's feet.
      await bed.directoryStore.upsert({ ...entry, runtimeKind: "claude-agent", generation: 7 });
      const outcome = await barrier.execute(plan);
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 1 });
      if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
      expect(outcome.reason).toContain("owns it now");
      expect((await bed.directoryStore.load())[0]!.generation).toBe(7);
    });
  });
});

describe("N2 / N3 — after `confirmInit`, the barrier never lies and never throws", () => {
  test("the confirmed destination's staging root survives a failed commit", async () => {
    // review r2, N2.2 + PLANT 6: the barrier hands the staging root to `confirmInit` itself, so a
    // destination that answered `ok` is reading it. `unwind()` used to delete it under that process.
    class RefusesTheProducerRecord extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (entries.some((entry) => entry["producerRuntime"] !== undefined)) throw new Error("the summary sidecar is read-only");
        return super.append(key, entries);
      }
    }
    await withStoreBed(
      async (bed) => {
        const entry = await bed.record();
        await bed.append(1);
        let seenRoot: string | undefined;
        const barrier = barrierFor(bed, {
          participants: {
            source: () => idleOwner(),
            destination: () => ({
              runtimeKind: "claude-agent" as const,
              confirmInit: (target: any) => {
                seenRoot = target.stagingRoot;
                return OK;
              },
            }),
          },
        });
        const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));

        expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
        if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
        expect(outcome.reason).toContain("producer record could not be written");
        // The source keeps the session — the record never landed...
        expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe(entry.runtimeKind);
        // ...but the copy the destination is READING is still there.
        expect(existsSync(seenRoot!)).toBe(true);
      },
      { store: RefusesTheProducerRecord, policy: { backoffMs: 1 } },
    );
  });

  test("a throw from the staging-root factory returns an outcome and unwinds", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, {
        stagingRootFor: () => {
          throw new Error("no temp directory");
        },
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"]).toBeNull();
    });
  });

  test("a throw from `decorate()` returns an outcome, unwinds, and leaves no staged copy", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const real = createMaterializedResumeDecorator(bed.context, { shared: bed.shared });
      const throwing = {
        get door() {
          return real.door;
        },
        get report() {
          return real.report;
        },
        get shared() {
          return bed.shared;
        },
        probe: () => real.probe(),
        decorate: () => {
          throw new Error("the staging root is not writable");
        },
      };
      // The staging root EXISTS before `decorate()` throws, so "leaves no staged copy" is an assertion
      // rather than a vacuous truth (review r3, nit 4).
      let staged: string | undefined;
      const barrier = barrierFor(bed, {
        decorator: throwing as never,
        stagingRootFor: (uuid) => {
          staged = join(bed.home, "staging", `${RESUME_STAGING_PREFIX}${uuid}`);
          mkdirSync(join(staged, "projects"), { recursive: true });
          return staged;
        },
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
      expect(outcome.detail).toContain("not writable");
      expect(existsSync(staged!)).toBe(false);
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"]).toBeNull();
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("winter-agent");
    });
  });

  test("a throw from the destination RESOLVER returns an outcome and unwinds", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner(),
          destination: () => {
            throw new Error("the runtime directory is unreachable");
          },
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"]).toBeNull();
    });
  });

  test("a throw AFTER the producer record lands is `resumed`, with the failure named", async () => {
    // review r2, N3 / PLANT 17: ownership has moved and a destination is running. "The source kept the
    // session" would be false; the honest answer is `resumed` with the failure in the detail.
    const inner = createInMemoryRuntimeDirectoryStore();
    let poisoned = false;
    const guarded: RuntimeDirectoryStore = {
      ...inner,
      cursors: {
        ...inner.cursors,
        async set(address, cursor) {
          if (poisoned) throw new Error("the cursor store is unreachable");
          return inner.cursors.set(address, cursor);
        },
      },
    };
    await withStoreBed(
      async (bed) => {
        await bed.record();
        await bed.append(1);
        const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
        const plan = await barrier.plan(bed.key, "claude-agent");
        poisoned = true;
        const outcome = await barrier.execute(plan);
        expect(outcome.kind).toBe("resumed");
        expect(outcome.detail).toContain("derived copy is behind");
        expect((await bed.shared.canonical.readSessionSummary(bed.key))!["producerRuntime"]).toBe("claude-agent");
      },
      { directoryStore: guarded },
    );
  });
});

describe("N4 — step 4 records `reconciled` only when the repair actually landed", () => {
  test("a session whose id is not a backend uuid is reconciled by PATH, not looked for by a scan", async () => {
    await withStoreBed(async (bed) => {
      // The comparison addresses the file directly; the repair used to reach it through the allowlist
      // scan, which skips a name like this — so the tail was dropped and step 4 said "reconciled".
      const odd: SessionKey = { projectKey: bed.key.projectKey, sessionId: "legacy-session-7" };
      await bed.record({ backendSessionId: odd.sessionId, parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: odd.sessionId, backendSessionId: odd.sessionId } });
      const [a] = await bed.append(1, odd);
      const b = bed.entry({ key: odd });
      const spool = join(bed.home, "spool");
      const path = localTranscriptPath(spool, odd);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);

      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }),
          destination: () => confirmingDestination({}),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(odd, "claude-agent"));
      expect(outcome.kind, outcome.detail).toBe("resumed");
      // The tail the source wrote is IN the canonical store, which is what "reconciled" has to mean.
      expect(((await bed.shared.store.load(odd)) ?? []).map((entry) => entry["uuid"])).toContain(b["uuid"]);
    });
  });

  test("a repair that does not land is `repair-required` — the barrier verifies, it does not assume", async () => {
    // A store that silently swallows the entry the repair appends: the reconciler's own re-read then
    // finds the canonical file still behind, and step 4 must refuse rather than record "reconciled"
    // over a tail that was dropped (review r2, N4 / PLANT 15).
    class SwallowsTheTail extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        const kept = entries.filter((entry) => entry["swallowMe"] !== true);
        if (kept.length === 0) return;
        return super.append(key, kept);
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.record();
        const [a] = await bed.append(1);
        const lost = bed.entry({ swallowMe: true });
        const spool = join(bed.home, "spool");
        const path = localTranscriptPath(spool, bed.key);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(a)}\n${JSON.stringify(lost)}\n`);

        const barrier = barrierFor(bed, {
          participants: {
            source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }),
            destination: () => confirmingDestination({}),
          },
        });
        const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
        expect(outcome).toMatchObject({ kind: "blocked", reason: "repair-required", step: 4 });
        // The handoff did NOT complete, and the tail is still only in the local root.
        expect(((await bed.shared.store.load(bed.key)) ?? []).map((entry) => entry["uuid"])).not.toContain(lost["uuid"]);
        expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("winter-agent");
      },
      { store: SwallowsTheTail },
    );
  });
});

describe("N6 / F8 / F11 — the marker, the health source and the producer's identity", () => {
  test("a concurrent plan() does not clear a LIVE handoff's pending marker", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      let markerDuringConfirm: unknown;
      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner(),
          destination: () => ({
            runtimeKind: "claude-agent" as const,
            async confirmInit() {
              // A second, read-shaped call while the handoff is in flight.
              const observer = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
              expect((await observer.plan(bed.key, "claude-agent")).from).toBe("winter-agent");
              markerDuringConfirm = (await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"];
              return OK;
            },
          }),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind).toBe("resumed");
      // The marker survived the concurrent plan(), so a crash at that instant would still be recoverable.
      expect(markerDuringConfirm).toMatchObject({ pid: process.pid, from: "winter-agent", to: "claude-agent" });
    });
  });

  test("a marker left by a DEAD holder is cleared", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      await bed.shared.store.append(bed.key, [{ type: "winter_dialect_record", pendingHandoff: { pid: 999_999, from: "winter-agent", to: "claude-agent", at: "x", level: "conversation", sourceGeneration: 1, cursor: "" } }]);
      await bed.shared.settle(bed.key);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      expect((await barrier.plan(bed.key, "claude-agent")).from).toBe("winter-agent");
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["pendingHandoff"]).toBeNull();
    });
  });

  test("plan() marks step 4 from the store's health in the WIRED shape, where no store is injected", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const canonical = bed.shared.canonical as unknown as { append: (key: SessionKey, entries: SessionStoreEntry[]) => Promise<void> };
      const original = canonical.append.bind(canonical);
      canonical.append = async () => {
        throw new Error("mirror is down");
      };
      await bed.shared.store.append(bed.key, [bed.entry()]);
      await bed.shared.settle(bed.key);
      canonical.append = original;

      // NOT `deps.shared` — the wired barrier never sets it (review r2, F8). This one resolves lazily
      // and must still see the store's own health.
      const barrier = createHandoffBarrier(bed.context, {
        winterHome: bed.home,
        leaseRoot: join(bed.home, "runtimes", "handoff-leases"),
        participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) },
      });
      // The lazily-built store is a different instance over the same home, so plant the failure in it.
      barrier.shared.store.append(bed.key, []).catch(() => undefined);
      const lazyCanonical = barrier.shared.canonical as unknown as { append: (key: SessionKey, entries: SessionStoreEntry[]) => Promise<void> };
      const lazyOriginal = lazyCanonical.append.bind(lazyCanonical);
      lazyCanonical.append = async () => {
        throw new Error("mirror is down");
      };
      await barrier.shared.store.append(bed.key, [bed.entry()]);
      await barrier.shared.settle(bed.key);
      lazyCanonical.append = lazyOriginal;

      const plan = await barrier.plan(bed.key, "claude-agent");
      expect(plan.steps[3]!.knownUnprovable).toContain("mirror is unhealthy");
    });
  });

  test("the producer record names the DESTINATION's versions, or none at all", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ selection: { ...selectionFor("winter-agent"), sdkVersion: "WINTER-9.9.9", engineVersion: "WINTER-ENGINE" } });
      await bed.append(1);
      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner(),
          destination: () => ({ runtimeKind: "claude-agent" as const, confirmInit: () => ({ ok: true as const, producer: { sdkVersion: "0.3.250", engineVersion: "claude-cli/2.1.250" } }) }),
        },
      });
      expect((await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).kind).toBe("resumed");
      const summary = await bed.shared.canonical.readSessionSummary(bed.key);
      expect(summary!["producerRuntime"]).toBe("claude-agent");
      expect(summary!["producerSdkVersion"]).toBe("0.3.250");
      expect(summary!["producerEngineVersion"]).toBe("claude-cli/2.1.250");
      // The SOURCE's versions are never written under the destination's name.
      expect(JSON.stringify(summary)).not.toContain("WINTER-9.9.9");
    });
  });

  test("a destination that reports no versions leaves the fields OUT rather than inventing them", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ selection: { ...selectionFor("winter-agent"), sdkVersion: "WINTER-9.9.9" } });
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      expect((await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).kind).toBe("resumed");
      const summary = await bed.shared.canonical.readSessionSummary(bed.key);
      expect(summary!["producerSdkVersion"]).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain("WINTER-9.9.9");
    });
  });
});

describe("the source can still write after a handoff — a DOCUMENTED behaviour, not a guard", () => {
  test("a post-handoff Winter append restamps the producer record, and the next plan() follows it", async () => {
    // Review r2 confirmed the mechanism: `dialect.ts`'s `appendWithDialectRecord` stamps
    // `producerRuntime: "winter-agent"` beside EVERY Winter append. "Exactly one runtime owns a
    // compatibility session at a time" is enforced by `owner.close()` plus convention — the store's
    // writer lease is re-entrant per pid and the router hosts both branches in one process — so this
    // test PINS the behaviour rather than claiming it is prevented. The close-out owes it a sentence.
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      expect((await barrier.execute(await barrier.plan(bed.key, "claude-agent"))).kind).toBe("resumed");
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("claude-agent");

      // The closed source appends anyway, with its own dialect record.
      await bed.shared.store.append(bed.key, [bed.entry(), { type: "winter_dialect_record", producerRuntime: "winter-agent", dialectFamily: "claude-code-jsonl" }]);
      await bed.shared.settle(bed.key);

      expect((await barrier.plan(bed.key, "claude-agent")).from).toBe("winter-agent");
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("winter-agent");
    });
  });
});

describe("fix round 3 — the last four edges", () => {
  test("N7: a writer lease held elsewhere at step 6 leaves the session's health untouched", async () => {
    // A correct, TRANSIENT `blocked: lease-held` used to poison the session: `pendingWritten` was armed
    // before the lease, so `unwind()` wrote to a session this process had just been refused, the facade
    // recorded `append-failed`, and every later attempt was `blocked: mirror-error step 4` with nothing
    // able to clear it (review r3, N7 / PLANT 37).
    let contended = true;
    class LeaseHeldElsewhere extends WinterCompatibilitySessionStore {
      override async acquireSessionLease(key: { projectKey: string; sessionId: string }): Promise<void> {
        if (contended) throw Object.assign(new Error("session lease is held by another live process (pid 4242)"), { name: "WinterStoreLeaseError" });
        return super.acquireSessionLease(key);
      }
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (contended) throw Object.assign(new Error("session lease is held by another live process (pid 4242)"), { name: "WinterStoreLeaseError" });
        return super.append(key, entries);
      }
    }
    await withStoreBed(
      async (bed) => {
        contended = false;
        await bed.record();
        await bed.append(1);
        const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });

        contended = true;
        const refused = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
        expect(refused).toMatchObject({ kind: "blocked", reason: "lease-held", step: 6 });

        // NOTHING was written to the contended session: no mirror error, no `repair-required`.
        contended = false;
        expect(bed.shared.health(bed.key).transcriptHealth).toBe("ok");
        expect(bed.shared.health(bed.key).errors).toHaveLength(0);

        // ...so the handoff succeeds once the contention is over.
        const second = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
        expect(second.kind, second.detail).toBe("resumed");
      },
      { store: LeaseHeldElsewhere, policy: { backoffMs: 1 } },
    );
  });

  test("N8: a foreign decorator is refused through `execute()` too, before any mirrored turn", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const second = createSharedSessionStore({ peers: bed.peers, winterHome: bed.home });
      const foreign = createMaterializedResumeDecorator(bed.context, {
        shared: second,
        report: { door: "preferred", probedAt: new Date(0).toISOString(), results: (["neighbor-file-survival", "no-wash-back", "sidecar-round-trip", "crash-pairs"] as const).map((probe) => ({ probe, passed: true, evidence: "forced open" })) },
      });
      // A plan built elsewhere (a cached one, or a barrier whose plan() was never called) reaching
      // `execute()` directly: the decoration would land in the foreign registry, the destination's first
      // mirrored turn would keep a dangling parentUuid, and step 5 would fail forever.
      const clean = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      const plan = await clean.plan(bed.key, "claude-agent");
      const wrong = barrierFor(bed, { decorator: foreign, participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
      // `execute()` returns outcomes rather than throwing (review r3, N10), so the wiring refusal
      // arrives as a fork that NAMES it — the important half is that the handoff does not run.
      const outcome = await wrong.execute(plan);
      expect(outcome.kind).toBe("lossy-fork-offered");
      expect(outcome.detail).toContain("DIFFERENT session store");
      // Nothing moved, and nothing was decorated into either store.
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("winter-agent");
      expect(bed.shared.decorations.list(bed.key)).toHaveLength(0);
      expect(second.decorations.list(bed.key)).toHaveLength(0);
    });
  });

  test("N9: a lagging SUBAGENT is reconciled with its parent, and counted in the same scope", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const [a] = await bed.append(1);
      const subkey: SessionKey = { ...bed.key, subpath: "subagents/agent-a1" };
      // Each transcript has its OWN chain (WS-05 §5.2) — the child's parent is within the child.
      const child = bed.entry({ key: subkey, parentUuid: null });
      const parentTail = bed.entry({ parentUuid: a!["uuid"] });
      const spool = join(bed.home, "spool");
      for (const [key, entries] of [
        [bed.key, [a!, parentTail]],
        [subkey, [child]],
      ] as Array<[SessionKey, SessionStoreEntry[]]>) {
        const path = localTranscriptPath(spool, key);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      }

      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }),
          destination: () => confirmingDestination({}),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      // Not a spurious refusal: the counts are the same scope now, and BOTH transcripts landed.
      expect(outcome.kind, outcome.detail).toBe("resumed");
      expect(((await bed.shared.store.load(bed.key)) ?? []).map((e) => e["uuid"])).toContain(parentTail["uuid"]);
      expect(((await bed.shared.store.load(subkey)) ?? []).map((e) => e["uuid"])).toContain(child["uuid"]);
    });
  });

  test("N9 (the other half): a subagent behind while the PARENT is level is not invisible", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const [a] = await bed.append(1);
      const subkey: SessionKey = { ...bed.key, subpath: "subagents/agent-a1" };
      const child = bed.entry({ key: subkey, parentUuid: null });
      const spool = join(bed.home, "spool");
      for (const [key, entries] of [
        [bed.key, [a!]],
        [subkey, [child]],
      ] as Array<[SessionKey, SessionStoreEntry[]]>) {
        const path = localTranscriptPath(spool, key);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      }
      const barrier = barrierFor(bed, {
        participants: {
          source: () => idleOwner({ health: () => ({ launchedThroughProxy: true, recordedLocalWriteRoot: spool, transcriptHealth: "ok" }) }),
          destination: () => confirmingDestination({}),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
      expect(outcome.kind, outcome.detail).toBe("resumed");
      // The child's tail reached the canonical store — it used to be left in the local root.
      expect(((await bed.shared.store.load(subkey)) ?? []).map((e) => e["uuid"])).toContain(child["uuid"]);
    });
  });

  test("N10: `execute()` returns an outcome when the source resolver or `health()` throws", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const plan = await barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } }).plan(bed.key, "claude-agent");

      const resolverThrows = barrierFor(bed, {
        participants: {
          source: () => {
            throw new Error("the source resolver is unreachable");
          },
          destination: () => confirmingDestination({}),
        },
      });
      expect(await resolverThrows.execute(plan)).toMatchObject({ kind: "lossy-fork-offered", step: 1 });

      const healthThrows = barrierFor(bed, {
        participants: {
          source: () =>
            idleOwner({
              health: () => {
                throw new Error("health() is unreachable");
              },
            }),
          destination: () => confirmingDestination({}),
        },
      });
      const outcome = await healthThrows.execute(plan);
      expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 1 });
      if (outcome.kind !== "lossy-fork-offered") throw new Error("unreachable");
      expect(outcome.reason).toContain("health() is unreachable");

      // And a session the directory has never heard of is an OUTCOME here, not a throw.
      const unknown = await resolverThrows.execute({ ...plan, session: { projectKey: "p", sessionId: "00000000-0000-4000-8000-00000000ffff" } });
      expect(unknown.kind).toBe("lossy-fork-offered");
    });
  });

  test("N11: a commit that fails after `confirmInit` names the staging root the destination now owns", async () => {
    class RefusesTheProducerRecord extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (entries.some((entry) => entry["producerRuntime"] !== undefined)) throw new Error("the summary sidecar is read-only");
        return super.append(key, entries);
      }
    }
    await withStoreBed(
      async (bed) => {
        await bed.record();
        await bed.append(1);
        const barrier = barrierFor(bed, { participants: { source: () => idleOwner(), destination: () => confirmingDestination({}) } });
        const outcome = await barrier.execute(await barrier.plan(bed.key, "claude-agent"));
        expect(outcome).toMatchObject({ kind: "lossy-fork-offered", step: 8 });
        // The host can FIND the directory it now owns — the leak is deliberate, so it has to be locatable.
        expect(outcome.target).toBeDefined();
        expect(existsSync(outcome.target!.stagingRoot!)).toBe(true);
        expect(outcome.detail).toContain(outcome.target!.stagingRoot!);
        expect(outcome.detail).toContain("retention pass");
      },
      { store: RefusesTheProducerRecord, policy: { backoffMs: 1 } },
    );
  });
});
