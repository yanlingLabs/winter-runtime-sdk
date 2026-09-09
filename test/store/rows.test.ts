// WS-17 §8, the store half: rows 8, 11 and 15.
//
// Each row is proven by NAMED tests here, and the close-out cites them from Lane D's
// `test/conformance/rows.test.ts`. Every one of them drives the REAL barrier over the REAL concrete
// store on an `mkdtemp` home — the doubles are only ever the two participants (a live runtime cannot
// be stood up hermetically), never the store, the transcript or the filesystem.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { WINTER_BRAND, envName, type SessionKey } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore, type RuntimeDirectoryEntry, type RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeKind } from "../../src/selection/runtime-selection.ts";
import {
  canonicalTranscriptPath,
  createHandoffBarrier,
  createTranscriptReconciler,
  localTranscriptPath,
  materializeTempContinuity,
  resolveEngineTempLayout,
  RESUME_STAGING_PREFIX,
  tempContinuityDisclosure,
  type CompatibilityLevel,
  type EngineTempLayout,
  type HandoffSourceOwner,
} from "../../src/store/index.ts";
import { selectionFor, withStoreBed, type StoreBed } from "./support.ts";

const LEVELS: CompatibilityLevel[] = ["conversation", "agent-state", "full-filesystem"];

function layoutFor(bed: StoreBed): EngineTempLayout {
  mkdirSync(bed.tempBase, { recursive: true });
  return resolveEngineTempLayout({
    brand: WINTER_BRAND,
    tempProjectKey: bed.key.projectKey,
    backendUuid: bed.key.sessionId,
    uid: 4242,
    env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase },
  });
}

/** One leg of WS-05 §12's gate matrix, driven through the real barrier. */
async function handoff(bed: StoreBed, to: RuntimeKind, layout: EngineTempLayout, recordedTempDir?: string) {
  const owner: HandoffSourceOwner = {
    runtimeKind: to === "winter-agent" ? "claude-agent" : "winter-agent",
    drainToIdleBoundary: () => ({ ok: true }),
    drainStream: () => ({ ok: true }),
    close: () => ({ ok: true }),
    ...(recordedTempDir === undefined ? {} : { effectiveTempDir: recordedTempDir }),
  };
  const barrier = createHandoffBarrier(bed.context, {
    shared: bed.shared,
    winterHome: bed.home,
    leaseRoot: join(bed.home, "runtimes", "handoff-leases"),
    stagingRootFor: (uuid) => join(bed.home, "staging", `${RESUME_STAGING_PREFIX}${uuid}`),
    tempLayoutFor: () => layout,
    participants: {
      source: () => owner,
      destination: () => ({ runtimeKind: to, confirmInit: () => ({ ok: true }) }),
    },
  });
  const outcome = await barrier.execute(await barrier.plan(bed.key, to));
  if (outcome.kind !== "resumed") throw new Error(`${to}: ${outcome.detail}`);
  // The barrier updates the directory's runtimeKind; the next leg reads it back as its `from`.
  return outcome;
}

describe("WS-17 row 8 — the shared store and the pinned dialect, at every advertised level", () => {
  for (const level of LEVELS) {
    test(`Claude -> Winter, Winter -> Claude and both round trips at level ${level}`, async () => {
      for (const order of [
        ["claude-agent", "winter-agent"],
        ["winter-agent", "claude-agent"],
        ["claude-agent", "winter-agent", "claude-agent"],
        ["winter-agent", "claude-agent", "winter-agent"],
      ] as RuntimeKind[][]) {
        await withStoreBed(async (bed) => {
          const start = order[0] === "claude-agent" ? "winter-agent" : "claude-agent";
          await bed.record({ runtimeKind: start, selection: selectionFor(start) });
          const entries = await bed.append(3);
          // The session advertises a level before any handoff; nothing may downgrade it.
          await bed.shared.store.append(bed.key, [{ type: "winter_dialect_record", compatibilityLevel: level }]);
          await bed.shared.settle(bed.key);

          const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
          const before = readFileSync(canonicalPath);
          const layout = layoutFor(bed);
          let recorded: string | undefined;

          for (const to of order) {
            const outcome = await handoff(bed, to, layout, recorded);
            recorded = outcome.target!.effectiveTempDir;
            // Step 8's own contract: the SAME backend uuid, the SAME project key, the SAME level.
            expect(outcome.target!.backendSessionId).toBe(bed.key.sessionId);
            expect(outcome.target!.projectKey).toBe(bed.key.projectKey);
            expect(outcome.target!.compatibilityLevel).toBe(level);
            // ...and the producer record says who owns it now.
            expect((await bed.shared.canonical.readSessionSummary(bed.key))!["producerRuntime"]).toBe(to);
          }

          // The history every leg produced is still there, in order, byte-identical for the entries
          // that existed before the first handoff.
          const after = readFileSync(canonicalPath);
          expect(after.subarray(0, before.length)).toEqual(before);
          const loaded = (await bed.shared.store.load(bed.key)) ?? [];
          expect(loaded.slice(0, 3).map((entry) => entry["uuid"])).toEqual(entries.map((entry) => entry["uuid"]));
          // A Claude leg gets one labeled note per handoff under the FALLBACK door, and nothing else.
          const claudeLegs = order.filter((kind) => kind === "claude-agent").length;
          expect(loaded).toHaveLength(3 + claudeLegs);
          // The transcript never carries producer/version metadata (WS-05 §5.2's closed corpus).
          expect(after.toString("utf8")).not.toContain("winter_dialect_record");
          expect(after.toString("utf8")).not.toContain("compatibilityLevel");
        });
      }
    });
  }

  test("the subagent level round-trips too: a subkey survives both directions", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selectionFor("claude-agent") });
      await bed.append(1);
      const subkey: SessionKey = { ...bed.key, subpath: "subagents/agent-a1" };
      const child = bed.entry({ key: subkey, parentUuid: null });
      await bed.shared.store.append(subkey, [child]);
      await bed.shared.settle(subkey);
      const childPath = join(bed.home, "projects", bed.key.projectKey, bed.key.sessionId, "subagents", "agent-a1.jsonl");
      const before = readFileSync(childPath);

      const layout = layoutFor(bed);
      await handoff(bed, "winter-agent", layout);
      await handoff(bed, "claude-agent", layout);

      expect(readFileSync(childPath)).toEqual(before);
      expect(await bed.shared.canonical.listSubkeys({ projectKey: bed.key.projectKey, sessionId: bed.key.sessionId })).toEqual(["subagents/agent-a1"]);
    });
  });
});

/**
 * A durable directory store over one JSON file — the router's stand-in for the host's
 * `runtime-state.db` (R-7b-2: "the router never opens the host's runtime-state.db... it receives an
 * implementation from the host"). Row 11 is a claim about WHERE the mappings live, so proving it needs
 * a store that survives being reconstructed, which the in-memory default cannot demonstrate.
 */
function fileBackedDirectoryStore(path: string): RuntimeDirectoryStore {
  const inner = createInMemoryRuntimeDirectoryStore();
  const state = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { entries: RuntimeDirectoryEntry[]; cursors: Record<string, string> }) : { entries: [], cursors: {} };
  const flush = async (): Promise<void> => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ entries: await inner.load(), cursors: await inner.cursors.all() }));
  };
  const seed = (async () => {
    for (const entry of state.entries) await inner.upsert(entry);
    for (const [address, cursor] of Object.entries(state.cursors)) await inner.cursors.set(address, cursor);
  })();
  return {
    ...inner,
    async load() {
      await seed;
      return inner.load();
    },
    async upsert(entry) {
      await seed;
      await inner.upsert(entry);
      await flush();
    },
    async remove(address) {
      await seed;
      await inner.remove(address);
      await flush();
    },
    cursors: {
      async get(address) {
        await seed;
        return inner.cursors.get(address);
      },
      async set(address, cursor) {
        await seed;
        await inner.cursors.set(address, cursor);
        await flush();
      },
      async remove(address) {
        await seed;
        await inner.cursors.remove(address);
        await flush();
      },
      async all() {
        await seed;
        return inner.cursors.all();
      },
    },
  };
}

describe("WS-17 row 11 — deleting and rebuilding the disposable product index", () => {
  test("runtime mappings, backend ids and cursors all survive, because none of them live there", async () => {
    const statePath = ["placeholder"];
    const stateRoot = ["placeholder"];
    await withStoreBed(
      async (bed) => {
        const entry = await bed.record();
        await bed.append(2);

        // The product index and its event log, exactly where WS-16 §3 puts them.
        const indexPath = join(bed.home, "sessions", "index.db");
        mkdirSync(join(bed.home, "sessions", "scope"), { recursive: true });
        writeFileSync(indexPath, "a rebuildable query index");
        writeFileSync(join(bed.home, "sessions", "scope", "s_abc.jsonl"), '{"type":"session_created"}\n');

        const layout = layoutFor(bed);
        const outcome = await handoff(bed, "claude-agent", layout);
        const cursorBefore = await bed.directoryStore.cursors.get(entry.address);
        expect(cursorBefore).toBe(String((await bed.shared.canonical.readSessionSummary(bed.key))!["projectionCursor"]));
        const transcriptBefore = readFileSync(canonicalTranscriptPath(bed.home, bed.key));

        // `recoverAll()` in one line: the index is deleted and rebuilt empty.
        rmSync(indexPath);
        writeFileSync(indexPath, "");

        // Reconstructed from the durable seam — a different file, which the rebuild never touched.
        const reopened = fileBackedDirectoryStore(statePath[0]!);
        const entries = await reopened.load();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.runtimeKind).toBe("claude-agent"); // the runtime mapping
        expect(entries[0]!.backendSessionId).toBe(bed.key.sessionId); // the backend id
        expect(entries[0]!.selection.providerId).toBe(entry.selection.providerId);
        expect(await reopened.cursors.get(entry.address)).toBe(cursorBefore); // the cursor
        // The transcript and the resume route are untouched by any of it.
        expect(readFileSync(canonicalTranscriptPath(bed.home, bed.key))).toEqual(transcriptBefore);
        expect(outcome.target!.backendSessionId).toBe(bed.key.sessionId);
        expect(readFileSync(join(bed.home, "sessions", "scope", "s_abc.jsonl"), "utf8")).toContain("session_created");
      },
      {
        directoryStore: (() => {
          // The bed's own home does not exist yet when the store is built, so this gets a `mkdtemp`
          // root of its own rather than a name in the shared temp directory (review r1, nit 1): a
          // failing test then leaves nothing behind but one directory this test removes.
          stateRoot[0] = mkdtempSync(join(tmpdir(), "runtime-sdk-row11-"));
          statePath[0] = join(stateRoot[0], "runtime-state.json");
          return fileBackedDirectoryStore(statePath[0]);
        })(),
      },
    );
    rmSync(stateRoot[0]!, { recursive: true, force: true });
  });

  test("the router never reads the product index: its name appears nowhere in this lane's source", async () => {
    const files = ["wiring.ts", "reconcile.ts", "temp-continuity.ts", "materialized-resume.ts", "handoff-barrier.ts", "index.ts"];
    for (const file of files) {
      const source = readFileSync(join(import.meta.dir, "..", "..", "src", "store", file), "utf8");
      expect(source, `${file} must not reach for the host's disposable index`).not.toContain("index.db");
    }
  });
});

describe("WS-17 row 15 — temp continuity, honest roots, pre-cleanup reconciliation, and the refusal", () => {
  test("the temp home stabilizes in the vendor engine dir across a full round trip", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      await bed.append(1);
      const layout = layoutFor(bed);
      mkdirSync(join(layout.winterSessionDir, "scratchpad"), { recursive: true });
      writeFileSync(join(layout.winterSessionDir, "scratchpad", "note.txt"), "from the winter leg");

      const first = await handoff(bed, "claude-agent", layout, layout.winterSessionDir);
      expect(first.target!.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(readFileSync(join(layout.vendorSessionDir, "scratchpad", "note.txt"), "utf8")).toBe("from the winter leg");

      const second = await handoff(bed, "winter-agent", layout, first.target!.effectiveTempDir);
      expect(second.target!.effectiveTempDir).toBe(layout.vendorSessionDir); // adopted, not moved back

      const third = await handoff(bed, "claude-agent", layout, second.target!.effectiveTempDir);
      expect(third.target!.effectiveTempDir).toBe(layout.vendorSessionDir); // recomputed onto the same path
      // The superseded Winter-side dir is still readable — the session's footprint, retained.
      expect(readFileSync(join(layout.winterSessionDir, "scratchpad", "note.txt"), "utf8")).toBe("from the winter leg");
    });
  });

  test("the vendor temp roots are reported honestly, including the one a copy left behind", async () => {
    await withStoreBed(async (bed) => {
      const layout = layoutFor(bed);
      mkdirSync(layout.winterSessionDir, { recursive: true });
      const result = materializeTempContinuity({ to: "claude-agent", layout, recordedTempDir: layout.winterSessionDir });
      const disclosure = tempContinuityDisclosure(layout, result);
      expect(disclosure.sharedRoot).toBe(layout.sharedRoot);
      expect(disclosure.winterEngineDir).toBe(layout.winterEngineDir);
      expect(disclosure.vendorEngineDir).toBe(layout.vendorEngineDir);
      expect(disclosure.effectiveTempDir).toBe(layout.vendorSessionDir);
      expect(disclosure.supersededDir).toBe(layout.winterSessionDir);
      // The dishonest report is the one that names only our own directory.
      expect(disclosure.vendorEngineDir).toContain("claude-");
    });
  });

  test("supervised PRE-CLEANUP reconciliation: the entries are in the store before the staging root is deleted", async () => {
    await withStoreBed(async (bed) => {
      await bed.record();
      const [a] = await bed.append(1);
      const late = bed.entry();
      const stagingRoot = join(bed.home, `${RESUME_STAGING_PREFIX}abc`);
      const path = localTranscriptPath(stagingRoot, bed.key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(a)}\n${JSON.stringify(late)}\n`);

      // WS-14 §6 rule 3's ordering, as the proxy calls it: reconcile on the observed exit...
      const reconciler = createTranscriptReconciler({ shared: bed.shared });
      await reconciler.hook({ observation: { root: { configDir: stagingRoot } }, exit: { code: 0, signal: null } });
      // ...and only THEN does the wrapper's cleanup remove the staging root.
      rmSync(stagingRoot, { recursive: true, force: true });

      expect(reconciler.reports[0]!.status).toBe("reconciled");
      expect(((await bed.shared.store.load(bed.key)) ?? []).map((entry) => entry["uuid"])).toEqual([a!["uuid"], late["uuid"]]);
      expect(existsSync(stagingRoot)).toBe(false);
      // And with the root gone, the handoff that follows has nothing left to reconcile against.
      const layout = layoutFor(bed);
      const outcome = await handoff(bed, "claude-agent", layout);
      expect(outcome.kind).toBe("resumed");
    });
  });

  test("a DEFAULT-SPAWN session with a mirror error is refused, never reconciled by guesswork", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selectionFor("claude-agent") });
      await bed.append(1);
      const barrier = createHandoffBarrier(bed.context, {
        shared: bed.shared,
        winterHome: bed.home,
        leaseRoot: join(bed.home, "runtimes", "handoff-leases"),
        tempLayoutFor: () => layoutFor(bed),
        participants: {
          source: () => ({
            runtimeKind: "claude-agent",
            drainToIdleBoundary: () => ({ ok: true }),
            drainStream: () => ({ ok: true }),
            close: () => ({ ok: true }),
            health: () => ({ launchedThroughProxy: false, transcriptHealth: "repair-required" as const }),
            // Lane A's `officialHandoffEligibility` output, verbatim.
            eligibility: () => ({
              eligible: false as const,
              reason: "default-spawn-mirror-error",
              detail:
                "this session was launched with the default spawner, so its active local-write root was never recorded; after a mirror error the only way to find it would be to scan temp directories by recency, which is forbidden — the session keeps its current owner",
            }),
          }),
          destination: () => ({ runtimeKind: "winter-agent" as const, confirmInit: () => ({ ok: true }) }),
        },
      });
      const outcome = await barrier.execute(await barrier.plan(bed.key, "winter-agent"));
      expect(outcome).toMatchObject({ kind: "blocked", reason: "mirror-error", step: 4 });
      expect(outcome.detail).toContain("scan temp directories by recency");
      // The source keeps the session: nothing was written, nothing was moved.
      expect((await bed.directoryStore.load())[0]!.runtimeKind).toBe("claude-agent");
      expect((await bed.shared.canonical.readSessionSummary(bed.key))?.["producerRuntime"]).toBeUndefined();
    });
  });
});
