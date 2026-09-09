// ITEMS 11 + 23 — WS-17 §8's FOUR PROBES, WITH THE PINNED RUNTIME ACTUALLY IN THEM.
//
// Lane C shipped the probes and the door they gate; three of the four name the pinned official
// runtime, which that lane had no bed for, so those legs recorded "unexercised" and
// `MaterializedResumeDecorator.door` stayed `"fallback"` — the honest outcome, and the reason this
// item exists rather than a defect. Lane A's bed is now in the same tree, so the probes can be run
// for real.
//
// THE DOOR OPENS ON FOUR MEASURED PASSES OR IT DOES NOT OPEN. This file runs them and RECORDS what
// happened; it deliberately does not assert "preferred", because a test that demanded the door open
// would be a test that fails when the measurement says otherwise — which is exactly backwards. What
// it asserts is that the run was REAL: every leg exercised, no leg recorded as unexercised, and the
// door's value consistent with the legs.
import { afterAll, describe, expect, test } from "bun:test";
import { WinterCompatibilitySessionStore, WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { SeamContext } from "../../src/seams/context.ts";
import { createMaterializedResumeDecorator } from "../../src/store/index.ts";
import type { MaterializedResumeProbeDetail } from "../../src/store/index.ts";
import type { MaterializedResumeProbeReport } from "../../src/seams/index.ts";
import { cleanupHermetic, officialRuntimeBed } from "../official/support.ts";
import { pinnedRuntimeProbeLegs } from "./probe-legs.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;
const PROBE_TIMEOUT = 600_000;

describeRuntime("WS-17 §8 — the four materialized-resume probes, driven against the pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "all four probes run with a real bed, and the door follows the measurement",
    async () => {
      const legs = pinnedRuntimeProbeLegs();
      expect(legs).toBeDefined();
      const { peer } = createFakeWinterPeer();
      // THE REAL STORE CLASS, spread onto the spine's fake: the probes build their own throwaway
      // stores from `context.peers`, and WS-05 §6's "the identical package/version on both legs" is a
      // statement about the injected instance — a probe over a fake store would measure the fake.
      const winter = { ...peer, WinterCompatibilitySessionStore } as unknown as typeof peer;
      const context: SeamContext = {
        peers: { winter },
        keychain: createFakeKeychain(),
        brand: WINTER_BRAND,
        directoryStore: createInMemoryRuntimeDirectoryStore(),
      };
      if (legs === undefined) throw new Error("unreachable: the suite is skipped without a bed");
      const decorator = createMaterializedResumeDecorator(context, { runtimeLegs: legs });
      // `probe()` returns the SEAM's report; the handle's own `probe()` carries the per-leg detail,
      // which is what makes an "unexercised" leg visible rather than folded into one boolean.
      const report: MaterializedResumeProbeReport = await decorator.probe();
      const results = report.results as MaterializedResumeProbeDetail[];

      // ---- what happened, printed so the record can be re-derived from a run rather than believed --
      for (const result of results) {
        const legLines = result.legs.map((leg) => `      ${leg.passed ? "PASS" : "FAIL"} ${leg.name}${leg.requiresPinnedRuntime ? " [pinned runtime]" : ""} — ${leg.evidence}`);
        console.log(`[probe] ${result.probe}: ${result.passed ? "PASS" : "FAIL"}\n${legLines.join("\n")}`);
      }
      console.log(`[probe] door after this run: ${report.door}`);

      // THE RUN WAS REAL. This is the assertion items 11/23 are actually about: every leg that names
      // the pinned runtime was EXERCISED, so a `fallback` verdict from here would be a measurement
      // rather than a missing bed.
      const unexercised = results.flatMap((result) => result.legs.filter((leg) => leg.evidence.startsWith("unexercised")).map((leg) => `${result.probe}/${leg.name}: ${leg.evidence}`));
      expect(unexercised).toEqual([]);
      const pinned = results.flatMap((result) => result.legs.filter((leg) => leg.requiresPinnedRuntime));
      expect(pinned.length).toBeGreaterThanOrEqual(3);

      // …and the door is consistent with the legs, in BOTH directions: it opens only on four passes,
      // and it must not stay shut when all four passed.
      expect(results).toHaveLength(4);
      const allPassed = results.every((result) => result.passed);
      expect(report.door).toBe(allPassed ? "preferred" : "fallback");

      // THE SHIPPED DEFAULT IS UNCHANGED BY THIS RUN, and that is the property worth pinning now that
      // the probes pass: a decorator built the way the BARRIER builds it — no report, no probe — still
      // reports `fallback`. Opening the door in production is a host supplying a measurement taken on
      // its own pin and platform, never a side effect of this file going green.
      const shipped = createMaterializedResumeDecorator(context, {});
      expect(shipped.door).toBe("fallback");
    },
    PROBE_TIMEOUT,
  );
});
