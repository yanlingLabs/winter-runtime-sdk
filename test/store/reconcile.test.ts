// WS-14 §5/§6 + WS-05 §12 step 4: the suffix-only door, and everything it refuses to do.
import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import {
  canonicalTranscriptPath,
  compareTranscriptTail,
  createTranscriptReconciler,
  isTranscriptPath,
  localTranscriptPath,
  reconcileLocalWriteRoot,
  scanLocalWriteRoot,
} from "../../src/store/index.ts";
import { sidecarPathFor, withStoreBed } from "./support.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { createSupervisedSpawnProxy, type TranscriptReconcile } from "../../src/official/spawn-proxy.ts";

/** Writes a transcript into a local-write root the way the official runtime's wrapper does. */
function writeLocal(root: string, key: { projectKey: string; sessionId: string; subpath?: string }, entries: SessionStoreEntry[]): string {
  const path = localTranscriptPath(root, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

describe("scanning a local-write root", () => {
  test("finds the session's transcript and its subagents, and NOTHING else that ends in .jsonl", async () => {
    await withStoreBed(async (bed) => {
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, [bed.entry()]);
      writeLocal(root, { ...bed.key, subpath: "subagents/agent-a1" }, [bed.entry()]);
      // Everything a real config dir also holds — and, from review r1's PLANT 13, the neighbours a
      // denylist keyed to one literal would have imported as sessions.
      writeFileSync(join(root, "settings.json"), "{}");
      mkdirSync(join(root, "projects", bed.key.projectKey, "statsig"), { recursive: true });
      writeFileSync(join(root, "projects", bed.key.projectKey, "statsig", "cache.jsonl"), "{}\n");
      writeFileSync(sidecarPathFor(root, bed.key), '{"payload":"opaque"}\n');
      writeFileSync(join(root, "projects", bed.key.projectKey, `${bed.key.sessionId}.events.jsonl`), '{"type":"x"}\n');
      // The one that matters: a neighbour holding opaque state. Imported as a session, it would put
      // `encrypted_content` into a model-readable transcript.
      writeFileSync(join(root, "projects", bed.key.projectKey, `${bed.key.sessionId}.reasoning.jsonl`), '{"encrypted_content":"ZZZ"}\n');
      mkdirSync(join(root, "projects", bed.key.projectKey, bed.key.sessionId, "subagents"), { recursive: true });
      writeFileSync(join(root, "projects", bed.key.projectKey, bed.key.sessionId, "subagents", "agent-a1.provider-state.jsonl"), '{"payload":"opaque"}\n');
      writeFileSync(join(root, "projects", bed.key.projectKey, bed.key.sessionId, "subagents", "notes.jsonl"), '{"type":"x"}\n');

      const found = scanLocalWriteRoot(root);
      expect(found.map((t) => t.key.subpath ?? "<main>").sort()).toEqual(["<main>", "subagents/agent-a1"]);
      expect(found.map((t) => t.key.sessionId)).toEqual([bed.key.sessionId, bed.key.sessionId]);
      expect(scanLocalWriteRoot(join(bed.home, "does-not-exist"))).toEqual([]);
    });
  });

  test("the predicate is an ALLOWLIST over the store's own naming rule, not a list of things to avoid", async () => {
    await withStoreBed(async (bed) => {
      const dir = join(bed.home, "projects", bed.key.projectKey);
      expect(isTranscriptPath(join(dir, `${bed.key.sessionId}.jsonl`))).toBe(true);
      expect(isTranscriptPath(join(dir, "agent-a1.jsonl"), "subagent")).toBe(true);
      for (const name of [
        `${bed.key.sessionId}.provider-state.jsonl`,
        `${bed.key.sessionId}.events.jsonl`,
        `${bed.key.sessionId}.reasoning.jsonl`,
        `${bed.key.sessionId}.jsonl.tail-quarantine`,
        "cache.jsonl",
        "index.jsonl",
        "agent-a1.jsonl", // a subagent name is not a SESSION name
      ]) {
        expect(isTranscriptPath(join(dir, name)), `${name} must not read as a session transcript`).toBe(false);
      }
      expect(isTranscriptPath(join(dir, `${bed.key.sessionId}.jsonl`), "subagent")).toBe(false);
      expect(isTranscriptPath(join(dir, "agent-a1.provider-state.jsonl"), "subagent")).toBe(false);
    });
  });
});

describe("the comparison (WS-05 §12 step 4)", () => {
  test("equal, behind, diverged and ahead each have their own answer", async () => {
    await withStoreBed(async (bed) => {
      const a = bed.entry();
      const b = bed.entry();
      const root = join(bed.home, "spool");
      const path = writeLocal(root, bed.key, [a, b]);

      expect(compareTranscriptTail({ localPath: path, canonicalLines: [JSON.stringify(a), JSON.stringify(b)] })).toEqual({ kind: "match", lines: 2 });

      const behind = compareTranscriptTail({ localPath: path, canonicalLines: [JSON.stringify(a)] });
      expect(behind.kind).toBe("behind" === "behind" ? "canonical-behind" : "match");
      if (behind.kind !== "canonical-behind") throw new Error("unreachable");
      expect(behind.missing.map((entry) => entry["uuid"])).toEqual([b["uuid"]]);

      const other = bed.entry();
      expect(compareTranscriptTail({ localPath: path, canonicalLines: [JSON.stringify(other)] }).kind).toBe("diverged");
      expect(compareTranscriptTail({ localPath: path, canonicalLines: [JSON.stringify(a), JSON.stringify(b), JSON.stringify(other)] }).kind).toBe("canonical-ahead");
    });
  });

  test("a torn final line is not a record, so it is neither missing nor a divergence", async () => {
    await withStoreBed(async (bed) => {
      const a = bed.entry();
      const root = join(bed.home, "spool");
      const path = writeLocal(root, bed.key, [a]);
      appendFileSync(path, '{"type":"user","uui');
      expect(compareTranscriptTail({ localPath: path, canonicalLines: [JSON.stringify(a)] })).toEqual({ kind: "match", lines: 1 });
    });
  });

  test("the same record spelled differently is still the same record", async () => {
    await withStoreBed(async (bed) => {
      const root = join(bed.home, "spool");
      const path = join(root, "projects", bed.key.projectKey, `${bed.key.sessionId}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      // A number the vendor wrote as `1e3`; the canonical side round-tripped it through JSON.
      writeFileSync(path, '{"type":"user","uuid":"u1","parentUuid":null,"n":1e3}\n');
      expect(compareTranscriptTail({ localPath: path, canonicalLines: ['{"type":"user","uuid":"u1","parentUuid":null,"n":1000}'] }).kind).toBe("match");
    });
  });
});

describe("reconciliation", () => {
  test("appends ONLY the suffix, clears the health flag, and leaves the neighbour file untouched", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      const sidecar = sidecarPathFor(bed.home, bed.key);
      writeFileSync(sidecar, '{"sessionId":"x","anchorUuid":"y","payload":"opaque"}\n');
      const sidecarBefore = readFileSync(sidecar);

      const b = bed.entry();
      const c = bed.entry();
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, [a!, b, c]);

      const report = await reconcileLocalWriteRoot(root, { shared: bed.shared });
      expect(report.status).toBe("reconciled");
      expect(report.appended).toBe(2);
      expect(report.cleared).toHaveLength(1);
      const entries = (await bed.shared.store.load(bed.key)) ?? [];
      expect(entries.map((entry) => entry["uuid"])).toEqual([a!["uuid"], b["uuid"], c["uuid"]]);
      expect(readFileSync(sidecar)).toEqual(sidecarBefore);
    });
  });

  test("a divergence is reported, never repaired — and the canonical file is not written to", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, [bed.entry(), bed.entry()]); // a different history entirely
      void a;

      const report = await reconcileLocalWriteRoot(root, { shared: bed.shared });
      expect(report.status).toBe("diverged");
      expect(report.appended).toBe(0);
      expect(report.cleared).toEqual([]);
      expect(readFileSync(canonicalPath)).toEqual(before);
    });
  });

  test("a subagent transcript reconciles onto its own subkey", async () => {
    await withStoreBed(async (bed) => {
      const subkey = { ...bed.key, subpath: "subagents/agent-a1" };
      await bed.append(1);
      const child = bed.entry({ key: subkey });
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, (await bed.shared.store.load(bed.key)) ?? []);
      writeLocal(root, subkey, [child]);

      const report = await reconcileLocalWriteRoot(root, { shared: bed.shared });
      expect(report.status).toBe("reconciled");
      expect(((await bed.shared.store.load(subkey)) ?? []).map((entry) => entry["uuid"])).toEqual([child["uuid"]]);
    });
  });

  test("`only` restricts reconciliation to one session, and leaves the other alone", async () => {
    await withStoreBed(async (bed) => {
      const other = { projectKey: bed.key.projectKey, sessionId: "99999999-2222-4333-8444-555555555555" };
      await bed.append(1);
      await bed.append(1, other);
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, [...((await bed.shared.store.load(bed.key)) ?? []), bed.entry()]);
      writeLocal(root, other, [...((await bed.shared.store.load(other)) ?? []), bed.entry({ key: other })]);

      const report = await reconcileLocalWriteRoot(root, { shared: bed.shared, only: { projectKey: bed.key.projectKey, sessionId: bed.key.sessionId } });
      expect(report.transcripts).toHaveLength(1);
      expect(((await bed.shared.store.load(bed.key)) ?? []).length).toBe(2);
      expect(((await bed.shared.store.load(other)) ?? []).length).toBe(1);
    });
  });
});

describe("the hook Lane A's spawn proxy takes", () => {
  test("it never throws, and a failure is recorded as a diverged report rather than lost", async () => {
    await withStoreBed(async (bed) => {
      const reconciler = createTranscriptReconciler({ shared: bed.shared });
      const [a] = await bed.append(1);
      const root = join(bed.home, "spool");
      writeLocal(root, bed.key, [a!, bed.entry()]);

      // The shape WS-14 §6 rule 3 calls it with, and the shape Lane A's `TranscriptReconcile` declares.
      await reconciler.hook({ observation: { root: { configDir: root } }, exit: { code: 0, signal: null } });
      expect(reconciler.reports).toHaveLength(1);
      expect(reconciler.reports[0]!.status).toBe("reconciled");
      expect(((await bed.shared.store.load(bed.key)) ?? []).length).toBe(2);

      // A root that cannot be read at all still resolves — the exit must not be stranded.
      await expect(reconciler.hook({ observation: { root: { configDir: "\u0000" } }, exit: { code: 1, signal: null } })).resolves.toBeUndefined();
      expect(reconciler.reports[1]!.status).toBe("diverged");
    });
  });
});

// ====================================================================================================
// N14 — THE CROSS-LANE ASSIGNABILITY THIS FILE'S COMMENT PROMISED AND DID NOT HAVE.
//
// `TranscriptReconcileHook` is a STRUCTURAL mirror of Lane A's `TranscriptReconcile`: this lane
// declares the shape rather than importing it, so it stays buildable without the official lane's
// module graph. That is the right call and it has one cost — nothing tells you when the mirror stops
// matching. The comment claimed a test pinned it "once both lanes are in one tree"; both lanes have
// been in one tree since the merge and no such test existed.
//
// THE PIN IS A COMPILE-TIME ONE, so it is written as an assignment rather than an assertion: if Lane
// A reshapes `SpawnObservation.root`, or widens what `reconcile` is handed, this file stops
// type-checking — which is the whole point, and is why `bun run typecheck` is the gate that carries
// it rather than `bun test`.
// ====================================================================================================
describe("N14 — Lane C's reconciler drops into Lane A's proxy", () => {
  test("the hook is assignable to the proxy's own `reconcile` option, and runs from it", async () => {
    await withStoreBed(async (bed) => {
      const reconciler = createTranscriptReconciler({ shared: bed.shared });
      // THE ASSIGNMENT IS THE ASSERTION. `TranscriptReconcile` is Lane A's own declared option type.
      const asProxyOption: TranscriptReconcile = reconciler.hook;
      expect(typeof asProxyOption).toBe("function");

      // …and it is accepted where the proxy actually takes it, with no cast at the call site.
      const proxy = createSupervisedSpawnProxy({
        brand: WINTER_BRAND,
        profile: "fresh-spool",
        configuredConfigDir: join(bed.home, "runtimes", "official-agent-spool"),
        sink: { record: () => undefined },
        reconcile: reconciler.hook,
      });
      expect(proxy).toBeDefined();
    });
  });
});
