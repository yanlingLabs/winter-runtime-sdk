// R-7b-12 — THE PREFERRED MATERIALIZED-RESUME DOOR, KEYED TO THE PIN.
//
// Until this landed, `docs/probes/materialized-resume.md` recorded two statements that were both true
// and disagreed: PREFERRED was MEASURED OPEN on 0.3.250 (four probes, both platforms) and the SHIPPED
// door was FALLBACK, because the barrier built its decorator with neither a report nor a probe run.
// Keying the decorator to the pin's own report is what closes that gap — deliberately, by version, and
// re-derived in CI (`test/joint/materialized-resume-probes.test.ts`) rather than asserted here.
//
// THE THREE ARMS BELOW ARE THE WHOLE RULE: the pinned version opens it, an unrecorded version does
// not, and no official peer at all does not. FALLBACK is the always-available door, so every arm that
// is not a measured pass lands on it.
import { describe, expect, test } from "bun:test";

import { createRuntimeSdk, materializedResumeReportForPin, runtimeSdkInternals, MATERIALIZED_RESUME_PROBE_REPORTS } from "../../src/index.ts";
import { PINNED_OFFICIAL_RUNTIME } from "../../src/official/env-allowlist.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { OfficialSdkModule } from "../../src/seams/official-sdk-shapes.ts";

/** An official peer that reports a version, and nothing else this test needs. */
function peerAtVersion(version: string): OfficialSdkModule {
  return {
    query: () => {
      throw new Error("this peer exists to be version-matched, not called");
    },
    SDK_VERSION: version,
  } as unknown as OfficialSdkModule;
}

const keychain = createFakeKeychain();

describe("R-7b-12 — the door the barrier's decorator reports", () => {
  test("the PINNED official peer opens PREFERRED, through the handle a host actually builds", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer, claude: peerAtVersion(PINNED_OFFICIAL_RUNTIME) }, keychain });
    expect(runtimeSdkInternals(sdk)?.decorator.door).toBe("preferred");
    // The barrier's own decorator IS that decorator — one store, one registry, one door (F2).
    expect((runtimeSdkInternals(sdk)?.barrier as { decorator?: unknown } | undefined)?.decorator).toBe(runtimeSdkInternals(sdk)?.decorator);
  });

  test("a Winter-only host gets FALLBACK — the always-available door", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    expect(runtimeSdkInternals(sdk)?.decorator.door).toBe("fallback");
  });

  test("an explicit report from a host still wins — the pin's is a default, not a ceiling", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({
      peers: { winter: peer, claude: peerAtVersion(PINNED_OFFICIAL_RUNTIME) },
      keychain,
      // A host that measured its OWN pin on its OWN platform and found a failure says so, and the
      // decorator follows the host rather than this repository's record.
      handoff: { decorationReport: { door: "fallback", probedAt: new Date(0).toISOString(), results: [{ probe: "no-wash-back", passed: false, evidence: "this deployment measured a re-sending mirror" }] } },
    });
    expect(runtimeSdkInternals(sdk)?.decorator.door).toBe("fallback");
  });

  test("the record is keyed by version, and an unrecorded one has no answer at all", () => {
    expect(materializedResumeReportForPin(PINNED_OFFICIAL_RUNTIME)?.door).toBe("preferred");
    expect(materializedResumeReportForPin("0.3.999")).toBeUndefined();
    expect(materializedResumeReportForPin(undefined)).toBeUndefined();
    // Exactly one pin is recorded: a bump is a reviewed event, never an inherited verdict.
    expect(Object.keys(MATERIALIZED_RESUME_PROBE_REPORTS)).toEqual([PINNED_OFFICIAL_RUNTIME]);
    // And the recorded verdict names all four of WS-17 §8's probes, each with its own evidence.
    const results = MATERIALIZED_RESUME_PROBE_REPORTS[PINNED_OFFICIAL_RUNTIME]?.results ?? [];
    expect(results.map((entry) => entry.probe).sort()).toEqual(["crash-pairs", "neighbor-file-survival", "no-wash-back", "sidecar-round-trip"]);
    for (const entry of results) expect({ probe: entry.probe, hasEvidence: entry.evidence.length > 40 }).toEqual({ probe: entry.probe, hasEvidence: true });
  });
});
