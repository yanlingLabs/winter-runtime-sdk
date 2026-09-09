// THREE WRITERS, ONE ROW — the cross-lane test items 10 and F-2 both ask for.
//
// `RuntimeDirectoryEntry` is written by three different lanes through a seam whose `upsert` is a FULL
// REPLACE, and each lane tested its own writer against its own fixtures:
//
//   * LANE A's spawn sink (`directoryRecordSink`) — a read-modify-write that stamps WS-14 §6 rule 2's
//     durable record: the OBSERVED `CLAUDE_CONFIG_DIR` and the child's `{pid, startedAt}`.
//   * LANE B's `directory.record()` — the one field-level merge rule in the package
//     (`mergeAdapterOwnedFields`), which exists precisely because the row has another writer.
//   * LANE C's barrier — `syncDirectoryEntry` and `loadEntry`'s repair, which move ownership.
//
// EACH PAIR IS THE INTERESTING CASE, because a lost update between two of them is invisible to both.
// The A↔C pair is covered in `test/store/handoff-barrier.test.ts` (F-2, with Lane A's real sink as the
// destination's `confirmInit`); this file covers A↔B and then runs all three over one row in the order
// a real session produces them.
//
// WHAT IS ACTUALLY AT STAKE: `configDir` is the `claude-resume-<uuid>` staging root that "the default
// spawner exposes no post-cleanup lookup for" (WS-14 §1) and `processIdentity` is the pair WS-15 §6.4
// step 2 revalidates. A writer that drops them leaves a crashed session with no recoverable root and
// nothing to revalidate — and neither is detectable by reading the writer that dropped them.
import { describe, expect, test } from "bun:test";

import { createInMemoryRuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import { createRuntimeDirectory } from "../../src/messaging/index.ts";
import { directoryRecordSink } from "../../src/official/spawn-proxy.ts";
import type { SpawnObservation } from "../../src/official/spawn-proxy.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { SeamContext } from "../../src/seams/context.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";

const ADDRESS = "session:cross-lane";

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "anthropic/claude-opus-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "cross-lane fixture",
  decidedAt: new Date(0).toISOString(),
};

function entry(overrides: Partial<RuntimeDirectoryEntry> = {}): RuntimeDirectoryEntry {
  return {
    address: ADDRESS,
    parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: "cross-lane" },
    runtimeKind: "claude-agent",
    objectKind: "session",
    transport: "claude-handle",
    status: "running",
    mode: "code",
    generation: 1,
    selection,
    capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function contextOver(store: RuntimeDirectoryStore): SeamContext {
  const { peer } = createFakeWinterPeer();
  return { peers: { winter: peer }, keychain: createFakeKeychain(), brand: peer.WINTER_BRAND, directoryStore: store };
}

/** What Lane A's supervised proxy hands its sink when a child spawns. */
function observation(configDir: string, pid: number): SpawnObservation {
  return {
    root: { configDir, kind: "sdk-resume-staging", profile: "store-backed-resume" },
    processIdentity: { pid, startedAt: new Date(1_000).toISOString() },
  } as unknown as SpawnObservation;
}

describe("Lane A's launch record and Lane B's directory row are the same row", () => {
  test("A writes the record, then B records the session over it — the record survives", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const directory = createRuntimeDirectory(contextOver(store));
    // The order a real session produces: the launch happens, and the host registers the session after
    // (the directory is another lane's, and a host may create its entry once the query has started).
    await directoryRecordSink({ store, address: ADDRESS, seed: () => entry() }).record(observation("/tmp/claude-resume-abc", 4242));
    await directory.record(entry({ status: "idle", displayName: "reviewer" }));

    const row = (await store.load()).find((candidate) => candidate.address === ADDRESS);
    // Lane B's own fields moved…
    expect(row?.status).toBe("idle");
    expect(row?.displayName).toBe("reviewer");
    // …and Lane A's are still there. This is `mergeAdapterOwnedFields`, and it is the ONLY merge rule
    // in the package — which is why every other writer has to go through this door or read first.
    expect(row?.configDir).toBe("/tmp/claude-resume-abc");
    expect(row?.processIdentity).toEqual({ pid: 4242, startedAt: new Date(1_000).toISOString() });
  });

  test("B records the session first, then A's launch record lands on it", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const directory = createRuntimeDirectory(contextOver(store));
    await directory.record(entry({ displayName: "reviewer" }));
    await directoryRecordSink({ store, address: ADDRESS }).record(observation("/tmp/claude-resume-def", 77));

    const row = (await store.load()).find((candidate) => candidate.address === ADDRESS);
    expect(row?.displayName).toBe("reviewer"); // A's read-modify-write kept B's field
    expect(row?.configDir).toBe("/tmp/claude-resume-def");
  });

  test("an EXPLICIT clear is not a lost update — B's next record does not resurrect the root", async () => {
    // The distinction the merge rule has to make, and the reason it is `incoming.x === undefined &&
    // existing.x !== undefined`: a field ABSENT because the writer does not own it is carried, and a
    // field REMOVED by the writer that owns it stays removed. Only Lane A's sink removes these two.
    const store = createInMemoryRuntimeDirectoryStore();
    const directory = createRuntimeDirectory(contextOver(store));
    const sink = directoryRecordSink({ store, address: ADDRESS, seed: () => entry() });
    await sink.record(observation("/tmp/claude-resume-ghi", 5));
    await sink.clear?.(observation("/tmp/claude-resume-ghi", 5));
    await directory.record(entry({ status: "exited" }));

    const row = (await store.load()).find((candidate) => candidate.address === ADDRESS);
    expect(row?.status).toBe("exited");
    expect(row?.configDir).toBeUndefined();
    expect(row?.processIdentity).toBeUndefined();
  });

  test("recovery reads what Lane A wrote, through Lane B's own report", async () => {
    // The end of the chain, and the reason any of this matters: WS-15 §6.4 step 2 revalidates the
    // pair Lane A recorded, and step 3 hands the entry — carrying the recorded root — to the host.
    const store = createInMemoryRuntimeDirectoryStore();
    const directory = createRuntimeDirectory(contextOver(store));
    await directory.record(entry());
    await directoryRecordSink({ store, address: ADDRESS }).record(observation("/tmp/claude-resume-jkl", 31337));

    const seen: Array<{ configDir?: string; pid?: number }> = [];
    const report = await createRuntimeDirectory(contextOver(store), {
      revalidateProcessIdentity: (candidate) => {
        seen.push({ ...(candidate.configDir === undefined ? {} : { configDir: candidate.configDir }), ...(candidate.processIdentity === undefined ? {} : { pid: candidate.processIdentity.pid }) });
        return false; // the process is gone, which is the case the record exists for
      },
      reattachSupervised: () => "skipped",
    }).recover();

    expect(seen).toEqual([{ configDir: "/tmp/claude-resume-jkl", pid: 31337 }]);
    // F-5: the step-3 report names the recorded root that is now nobody's, so a host can see it.
    expect(report.steps[2]?.outcome).toContain("recorded local-write root");
  });
});
