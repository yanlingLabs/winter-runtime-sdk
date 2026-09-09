// WS-13 §8.2's two doors and WS-17 §8's four probes.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalTranscriptPath,
  classifyCrashPairs,
  createMaterializedResumeDecorator,
  HANDOFF_ENTRY_LABEL,
  materializedTranscriptPath,
  MaterializedResumeError,
} from "../../src/store/index.ts";
import { RESUME_STAGING_PREFIX, resumeStagingRoot } from "../../src/vendor-paths.ts";
import type { MaterializedResumeProbeDetail } from "../../src/store/index.ts";
import { sidecarPathFor, withStoreBed } from "./support.ts";

const passingReport = {
  door: "preferred" as const,
  probedAt: new Date(0).toISOString(),
  results: [
    { probe: "neighbor-file-survival" as const, passed: true, evidence: "recorded" },
    { probe: "no-wash-back" as const, passed: true, evidence: "recorded" },
    { probe: "sidecar-round-trip" as const, passed: true, evidence: "recorded" },
    { probe: "crash-pairs" as const, passed: true, evidence: "recorded" },
  ],
};

describe("the staging root", () => {
  test("is the vendor's own `claude-resume-<uuid>` under the SDK parent's tmpdir (WS-14 §1)", () => {
    const root = resumeStagingRoot("abc");
    expect(root).toBe(join(tmpdir(), `${RESUME_STAGING_PREFIX}abc`));
    expect(materializedTranscriptPath(root, { projectKey: "p", sessionId: "s" })).toBe(join(root, "projects", "p", "s.jsonl"));
  });
});

describe("the door is a measurement, not a preference", () => {
  test("it is `fallback` until a report shows all four probes passing", async () => {
    await withStoreBed(async (bed) => {
      expect(createMaterializedResumeDecorator(bed.context, { shared: bed.shared }).door).toBe("fallback");
      expect(createMaterializedResumeDecorator(bed.context, { shared: bed.shared, report: passingReport }).door).toBe("preferred");
      const oneFailed = { ...passingReport, results: passingReport.results.map((r, i) => (i === 1 ? { ...r, passed: false } : r)) };
      expect(createMaterializedResumeDecorator(bed.context, { shared: bed.shared, report: oneFailed }).door).toBe("fallback");
    });
  });
});

describe("FALLBACK — one labeled entry, staged for the barrier to commit", () => {
  test("the note is dialect-legal, can never read as an ordinary message, and does NOT touch the canonical file", async () => {
    await withStoreBed(async (bed) => {
      const [a] = await bed.append(1);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      const decorator = createMaterializedResumeDecorator(bed.context, { shared: bed.shared });
      const stagingRoot = join(bed.home, `${RESUME_STAGING_PREFIX}fallback`);
      const result = await decorator.decorate({
        session: bed.key,
        to: "claude-agent",
        materializedPath: materializedTranscriptPath(stagingRoot, bed.key),
        decoration: { kind: "handoff", from: "winter-agent", at: "2026-09-09T00:00:00.000Z", text: "carry this over" },
      });

      expect(result.door).toBe("fallback");
      // THE DECORATOR NEVER WRITES TO THE CANONICAL STORE (review r1, F1/F2). The note is handed back
      // for the barrier to commit once the destination has confirmed it started.
      expect(result.canonicalUntouched).toBe(true);
      expect(readFileSync(canonicalPath)).toEqual(before);
      expect(((await bed.shared.store.load(bed.key)) ?? [])).toHaveLength(1);

      const note = result.note!;
      expect(note["type"]).toBe("user");
      expect(note["parentUuid"]).toBe(a!["uuid"] as string);
      expect(note["sessionId"]).toBe(bed.key.sessionId);
      expect(note["cwd"]).toBe(a!["cwd"] as string); // taken from the transcript, never invented
      expect(String((note["message"] as { content: string }).content)).toContain(`[${HANDOFF_ENTRY_LABEL}:`);
      expect(String((note["message"] as { content: string }).content)).toContain("carry this over");
      // The closed corpus: nothing but dialect fields, no Winter-only marker.
      expect(Object.keys(note).sort()).toEqual(["cwd", "isSidechain", "message", "parentUuid", "sessionId", "timestamp", "type", "uuid", "version"]);
      // The copy is staged under BOTH doors and carries the note under both — a destination that starts
      // must see it whichever door is open.
      expect(readFileSync(result.resumePath, "utf8").trimEnd().split("\n")).toHaveLength(2);
      // ...but under FALLBACK it is NOT registered as a decoration: it is destined for the canonical file.
      expect(bed.shared.decorations.list(bed.key)).toEqual([]);
    });
  });
});

describe("PREFERRED — the decoration lives only in the copy", () => {
  test("the canonical file is byte-identical, and the copy carries the note", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(2);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      const decorator = createMaterializedResumeDecorator(bed.context, { shared: bed.shared, report: passingReport });
      const stagingRoot = join(bed.home, `${RESUME_STAGING_PREFIX}preferred`);

      const result = await decorator.decorate({
        session: bed.key,
        to: "claude-agent",
        materializedPath: materializedTranscriptPath(stagingRoot, bed.key),
        decoration: { kind: "handoff", from: "winter-agent", at: "2026-09-09T00:00:00.000Z", text: "carry this over" },
      });

      expect(result.door).toBe("preferred");
      expect(result.canonicalUntouched).toBe(true);
      expect(result.note).toBeUndefined(); // nothing is owed to the canonical file under this door
      expect(readFileSync(canonicalPath)).toEqual(before);
      const copy = readFileSync(result.resumePath, "utf8").trimEnd().split("\n");
      expect(copy).toHaveLength(3);
      expect(copy.slice(0, 2).join("\n")).toBe(before.toString("utf8").trimEnd());
      expect(bed.shared.decorations.list(bed.key)).toHaveLength(1);
      expect(bed.shared.decorations.has(bed.key, JSON.parse(copy[2]!).uuid)).toBe(true);
    });
  });

  test("a Winter destination gets nothing written at all — it decorates at render time", async () => {
    await withStoreBed(async (bed) => {
      await bed.append(1);
      const canonicalPath = canonicalTranscriptPath(bed.home, bed.key);
      const before = readFileSync(canonicalPath);
      for (const report of [undefined, passingReport]) {
        const decorator = createMaterializedResumeDecorator(bed.context, { shared: bed.shared, ...(report === undefined ? {} : { report }) });
        const result = await decorator.decorate({
          session: bed.key,
          to: "winter-agent",
          materializedPath: join(bed.home, "unused.jsonl"),
          decoration: { kind: "handoff", from: "claude-agent", at: "2026-09-09T00:00:00.000Z", text: "x" },
        });
        expect(result.resumePath).toBe(canonicalPath);
        expect(result.canonicalUntouched).toBe(true);
        expect(readFileSync(canonicalPath)).toEqual(before);
      }
    });
  });

  test("a transcript with nothing to anchor to refuses rather than inventing a cwd", async () => {
    await withStoreBed(async (bed) => {
      const decorator = createMaterializedResumeDecorator(bed.context, { shared: bed.shared });
      await expect(
        decorator.decorate({
          session: bed.key,
          to: "claude-agent",
          materializedPath: join(bed.home, "copy.jsonl"),
          decoration: { kind: "handoff", from: "winter-agent", at: "x", text: "y" },
        }),
      ).rejects.toThrow(MaterializedResumeError);
    });
  });
});

describe("WS-17 §8's four probes", () => {
  test("every probe runs, and the pinned-runtime legs are recorded as unexercised rather than passed", async () => {
    await withStoreBed(async (bed) => {
      const decorator = createMaterializedResumeDecorator(bed.context, { shared: bed.shared });
      const report = await decorator.probe();

      expect(report.results.map((result) => result.probe)).toEqual(["neighbor-file-survival", "no-wash-back", "sidecar-round-trip", "crash-pairs"]);
      const byId = new Map(report.results.map((result) => [result.probe, result as MaterializedResumeProbeDetail]));

      // The store-side legs of every probe pass on their own merits.
      for (const [probe, result] of byId) {
        const store = result.legs.filter((leg) => !leg.requiresPinnedRuntime);
        expect(store.length, `${probe} has store-side legs`).toBeGreaterThan(0);
        for (const leg of store) expect(leg.passed, `${probe} / ${leg.name}: ${leg.evidence}`).toBe(true);
      }

      // (a), (b) and (c) name the pinned runtime, so with no bed they are NOT passes...
      for (const probe of ["neighbor-file-survival", "no-wash-back", "sidecar-round-trip"] as const) {
        const pinned = byId.get(probe)!.legs.filter((leg) => leg.requiresPinnedRuntime);
        expect(pinned).toHaveLength(1);
        expect(pinned[0]!.passed).toBe(false);
        expect(pinned[0]!.evidence).toContain("unexercised");
        expect(byId.get(probe)!.passed).toBe(false);
      }
      // ...and (d) is entirely a store property, so it passes here.
      expect(byId.get("crash-pairs")!.passed).toBe(true);

      // Which is exactly why the door stays shut.
      expect(report.door).toBe("fallback");
      expect(decorator.door).toBe("fallback");
      expect(decorator.report).toBe(report);
    });
  });

  test("with a pinned-runtime bed supplied, every leg runs and the door opens", async () => {
    await withStoreBed(async (bed) => {
      // A stand-in for Lane A's real bed, doing what a fresh-process resume does to the store: it
      // appends a turn through the shared store and touches nothing else. It cannot prove what the
      // VENDOR does — only Lane A's bed can — which is why the probe records the bed's label.
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        runtimeLegs: {
          label: "a store-level stand-in (NOT the pinned runtime)",
          async freshProcessResume({ key, shared }) {
            const entries = (await shared.store.load(key)) ?? [];
            const parent = entries[entries.length - 1]?.["uuid"] ?? null;
            await shared.store.append(key, [{ type: "user", uuid: crypto.randomUUID(), parentUuid: parent, sessionId: key.sessionId, cwd: "/probe", version: "0.0.0", isSidechain: false }]);
            await shared.settle(key);
          },
        },
      });
      const report = await decorator.probe();
      for (const result of report.results) expect(result.passed, `${result.probe}: ${result.evidence}`).toBe(true);
      expect(report.door).toBe("preferred");
      expect(decorator.door).toBe("preferred");
    });
  });

  test("probe (a) really is watching the sidecar: a leg that touches it fails the probe", async () => {
    await withStoreBed(async (bed) => {
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        runtimeLegs: {
          label: "a bed that rewrites the neighbour file",
          async freshProcessResume({ home, key }) {
            writeFileSync(sidecarPathFor(home, key), "rewritten by the runtime\n");
          },
        },
      });
      const report = await decorator.probe();
      const neighbour = report.results.find((result) => result.probe === "neighbor-file-survival")!;
      expect(neighbour.passed).toBe(false);
      expect(report.door).toBe("fallback");
    });
  });
});

describe("WS-05 §13's crash pairs", () => {
  test("a record without its entry is collectable; an entry without its record degrades", () => {
    expect(classifyCrashPairs({ entryUuids: ["a", "b"], anchorUuids: ["a", "orphan"] })).toEqual({ collectable: ["orphan"], degraded: ["b"] });
    // No sidecar at all is not "every entry degraded" — it is a session that never had foreign state.
    expect(classifyCrashPairs({ entryUuids: ["a", "b"], anchorUuids: [] })).toEqual({ collectable: [], degraded: [] });
  });
});

describe("no probe leg is ever a hardcoded pass (review r1, F4/F13)", () => {
  test("a bed whose `freshProcessResume` does NOTHING does not open the door", async () => {
    await withStoreBed(async (bed) => {
      let calls = 0;
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        runtimeLegs: {
          label: "a bed that returns without producing anything",
          async freshProcessResume() {
            calls += 1;
          },
        },
      });
      const report = await decorator.probe();
      expect(calls).toBeGreaterThan(0); // it WAS called — the leg is not skipping the bed
      expect(report.door).toBe("fallback");
      for (const probe of ["neighbor-file-survival", "no-wash-back", "sidecar-round-trip"] as const) {
        const result = report.results.find((r) => r.probe === probe)! as MaterializedResumeProbeDetail;
        const pinned = result.legs.find((leg) => leg.requiresPinnedRuntime)!;
        expect(pinned.passed, `${probe}: ${pinned.evidence}`).toBe(false);
        expect(pinned.evidence).toContain("unexercised");
      }
    });
  });

  test("a bed that THROWS records a failed leg rather than aborting the probe run", async () => {
    await withStoreBed(async (bed) => {
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        runtimeLegs: {
          label: "a bed that cannot start the pinned runtime",
          async freshProcessResume() {
            throw new Error("no platform binary for this host");
          },
        },
      });
      const report = await decorator.probe();
      expect(report.results).toHaveLength(4);
      expect(report.door).toBe("fallback");
      const neighbour = report.results.find((r) => r.probe === "neighbor-file-survival")! as MaterializedResumeProbeDetail;
      const pinned = neighbour.legs.find((leg) => leg.requiresPinnedRuntime)!;
      expect(pinned.passed).toBe(false);
      expect(pinned.evidence).toContain("no platform binary for this host");
      // ...and the store-side legs still ran and still passed: one bad bed does not erase the run.
      expect(neighbour.legs.filter((leg) => !leg.requiresPinnedRuntime).every((leg) => leg.passed)).toBe(true);
    });
  });

  test("probe (c)'s pinned leg really drives the bed for every Claude leg", async () => {
    await withStoreBed(async (bed) => {
      const produced: string[] = [];
      const decorator = createMaterializedResumeDecorator(bed.context, {
        shared: bed.shared,
        runtimeLegs: {
          label: "a store-level stand-in",
          async freshProcessResume({ key, shared }) {
            const entries = (await shared.store.load(key)) ?? [];
            const parent = entries[entries.length - 1]?.["uuid"] ?? null;
            const uuid = crypto.randomUUID();
            produced.push(uuid);
            await shared.store.append(key, [{ type: "user", uuid, parentUuid: parent, sessionId: key.sessionId, cwd: "/probe", version: "0.0.0", isSidechain: false }]);
            await shared.settle(key);
          },
        },
      });
      const report = await decorator.probe();
      const roundTrip = report.results.find((r) => r.probe === "sidecar-round-trip")! as MaterializedResumeProbeDetail;
      const pinned = roundTrip.legs.find((leg) => leg.requiresPinnedRuntime)!;
      expect(pinned.passed, pinned.evidence).toBe(true);
      // Two orders, three Claude legs between them — every one produced by the bed.
      expect(produced.length).toBeGreaterThanOrEqual(3);
      expect(report.door).toBe("preferred");
    });
  });
});
