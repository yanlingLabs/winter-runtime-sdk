// SMOKE: `@yanlinglabs/winter-conformance` loads and works here, hermetically.
//
// The point of this file is narrow and worth stating: it proves that the ROUTER REPOSITORY can reach
// the SDK repository's conformance package at all — the `link:` dependency resolves, the goldens ship
// with it, and the trace normalizer runs — so that when Lane A or Lane D writes a differential, a
// failure is about the differential and not about the wiring.
//
// WS-23: `runOfficialCapture` — which installed the pinned official SDK and captured it — went with the
// official runtime.
//
// EVERY CALL BELOW IS AWAITED (0.0.3, P8c-13): `./conformance.ts`'s functions became lazy — a dynamic
// `import()` of the optional `@yanlinglabs/winter-conformance` peer inside each function body, so this
// package's published `./testing` subpath does not require it — which made every one of them async.
import { describe, expect, test } from "bun:test";

import * as testing from "../../src/testing/index.ts";
import { compareTraces, goldenTracePath, listGoldenTraces, loadGoldenTrace, normalizeTrace } from "../../src/testing/index.ts";
import type { ConformanceTraceEntry } from "../../src/testing/index.ts";

describe("the conformance harness", () => {
  test("the committed goldens are reachable from this repository", async () => {
    const goldens = await listGoldenTraces();
    expect(goldens.length).toBeGreaterThan(0);
    expect(goldens.every((name) => name.endsWith(".json"))).toBe(true);
  });

  test("a golden loads as trace entries, and its path is a real file", async () => {
    const [first] = await listGoldenTraces();
    expect(first).toBeDefined();
    const trace = await loadGoldenTrace(first!);
    expect(Array.isArray(trace)).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
    expect(await Bun.file(await goldenTracePath(first!)).exists()).toBe(true);
  });

  test("normalizeTrace is idempotent and compareTraces finds no difference with itself", async () => {
    const [first] = await listGoldenTraces();
    const trace = await loadGoldenTrace(first!);
    const once = await normalizeTrace(trace);
    const twice = await normalizeTrace(once);
    expect(await compareTraces(once, twice)).toEqual([]);
    expect(await compareTraces(once, once)).toEqual([]);
  });

  test("compareTraces actually reports a difference (the check is not vacuous)", async () => {
    const a: ConformanceTraceEntry[] = [{ sequence: 0, direction: "runtime-to-host", kind: "system", payload: { subtype: "init" } }];
    const b: ConformanceTraceEntry[] = [{ sequence: 0, direction: "runtime-to-host", kind: "assistant", payload: { subtype: "text" } }];
    const diffs = await compareTraces(await normalizeTrace(a), await normalizeTrace(b));
    expect(diffs).toEqual(["kind@0: system != assistant", "payload@0 (system) differs"]);
  });

  test("the normalizer strips the volatile fields a differential must not compare", async () => {
    const entry: ConformanceTraceEntry = {
      sequence: 7,
      direction: "runtime-to-host",
      kind: "result",
      payload: { session_id: "s_abc", duration_ms: 1234, kept: "yes", nested: { uuid: "u", kept: 1 } },
    };
    const [normalized] = await normalizeTrace([entry]);
    expect(normalized?.sequence).toBe(0);
    expect(normalized?.payload).toEqual({ kept: "yes", nested: { kept: 1 } });
  });

  test("WS-23: the official capture is gone from the harness", () => {
    expect("runOfficialCapture" in testing).toBe(false);
  });
});
