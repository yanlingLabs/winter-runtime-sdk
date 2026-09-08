// SMOKE: `@yanlinglabs/winter-conformance` loads and works here, hermetically.
//
// The point of this file is narrow and worth stating: it proves that the ROUTER REPOSITORY can reach
// the SDK repository's conformance package at all — the `link:` dependency resolves, the goldens ship
// with it, and the trace normalizer runs — so that when Lane A or Lane D writes a differential, a
// failure is about the differential and not about the wiring.
//
// IT NEVER CALLS `runOfficialCapture`. That function installs the pinned official SDK into a
// throwaway npm prefix and needs network egress; WS-02 §6 makes that fetch an ephemeral,
// checksum-verified, deliberate act. Asserting it is a function is the whole of what a hermetic
// suite may say about it.
import { describe, expect, test } from "bun:test";

import { compareTraces, goldenTracePath, listGoldenTraces, loadGoldenTrace, normalizeTrace, runOfficialCapture } from "../../src/testing/index.ts";
import type { ConformanceTraceEntry } from "../../src/testing/index.ts";

describe("the conformance harness", () => {
  test("the committed goldens are reachable from this repository", () => {
    const goldens = listGoldenTraces();
    expect(goldens.length).toBeGreaterThan(0);
    expect(goldens.every((name) => name.endsWith(".json"))).toBe(true);
  });

  test("a golden loads as trace entries, and its path is a real file", async () => {
    const [first] = listGoldenTraces();
    expect(first).toBeDefined();
    const trace = loadGoldenTrace(first!);
    expect(Array.isArray(trace)).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
    expect(await Bun.file(goldenTracePath(first!)).exists()).toBe(true);
  });

  test("normalizeTrace is idempotent and compareTraces finds no difference with itself", () => {
    const [first] = listGoldenTraces();
    const trace = loadGoldenTrace(first!);
    const once = normalizeTrace(trace);
    const twice = normalizeTrace(once);
    expect(compareTraces(once, twice)).toEqual([]);
    expect(compareTraces(once, once)).toEqual([]);
  });

  test("compareTraces actually reports a difference (the check is not vacuous)", () => {
    const a: ConformanceTraceEntry[] = [{ sequence: 0, direction: "runtime-to-host", kind: "system", payload: { subtype: "init" } }];
    const b: ConformanceTraceEntry[] = [{ sequence: 0, direction: "runtime-to-host", kind: "assistant", payload: { subtype: "text" } }];
    const diffs = compareTraces(normalizeTrace(a), normalizeTrace(b));
    expect(diffs).toEqual(["kind@0: system != assistant", "payload@0 (system) differs"]);
  });

  test("the normalizer strips the volatile fields a differential must not compare", () => {
    const entry: ConformanceTraceEntry = {
      sequence: 7,
      direction: "runtime-to-host",
      kind: "result",
      payload: { session_id: "s_abc", duration_ms: 1234, kept: "yes", nested: { uuid: "u", kept: 1 } },
    };
    const [normalized] = normalizeTrace([entry]);
    expect(normalized?.sequence).toBe(0);
    expect(normalized?.payload).toEqual({ kept: "yes", nested: { kept: 1 } });
  });

  test("the official capture is present and is NOT invoked here", () => {
    expect(typeof runOfficialCapture).toBe("function");
  });
});
