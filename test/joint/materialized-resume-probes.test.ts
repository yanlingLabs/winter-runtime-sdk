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
import { createMaterializedResumeDecorator, materializedResumeReportForPin } from "../../src/store/index.ts";
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
      const bed = officialRuntimeBed();
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

      // A DECORATOR GIVEN NOTHING STILL REPORTS `fallback`. R-7b-12 opens the door by handing the
      // barrier the PIN's report, never by a decorator deciding for itself — so this stays true and is
      // what makes `materializedResumeReportForPin` the single place the door is opened.
      const shipped = createMaterializedResumeDecorator(context, {});
      expect(shipped.door).toBe("fallback");

      // ================================================================================================
      // R-7b-12's TRIPWIRE — the recorded verdict is re-derived here, on the real artifact, per pin.
      //
      // `src/store/pinned-probes.ts` is what `createRuntimeSdk` reads to open PREFERRED, and it travels
      // as DATA because each probe costs a process tree and the constructor is a startup path. Data that
      // nothing re-measures is a claim, so this run compares itself to the record: a pin whose behaviour
      // changed (a mirror that re-sends what it read, a runtime that re-anchors a resumed chain) fails
      // here rather than opening a door onto a store step 5 would then refuse.
      //
      // A PIN BUMP FAILS THIS TOO, and deliberately: an unrecorded version has no report, so the
      // comparison below has nothing to match and the bump is a reviewed event rather than a silent
      // inheritance.
      // ================================================================================================
      const recorded = materializedResumeReportForPin(bed?.version);
      expect({ pin: bed?.version, recorded: recorded !== undefined }).toEqual({ pin: bed?.version, recorded: true });
      expect(recorded?.door).toBe(report.door);
      expect(recorded?.results.map((entry) => `${entry.probe}:${entry.passed ? "pass" : "fail"}`).sort()).toEqual(results.map((entry) => `${entry.probe}:${entry.passed ? "pass" : "fail"}`).sort());
    },
    PROBE_TIMEOUT,
  );
});
