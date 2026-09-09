// R-7b-12: WHICH MATERIALIZED-RESUME DOOR IS OPEN, PER PIN, BY MEASUREMENT.
//
// WS-13 §8.2's amendment, verbatim: "the four WS-17 §8 probes (neighbor-file survival, no-wash-back,
// sidecar round-trip as the dialect defines ordering, crash pairs) pass against the pinned official
// 0.3.250 on darwin-arm64 and linux-x64 (hermetic beds; the earlier 'the runtime re-anchors' reading
// was a probe artefact and is withdrawn). The decorator's door is therefore `preferred` for the
// CURRENT pin when the pin's probe report says all four passed, and `fallback` otherwise; a pin bump
// re-runs the probes in CI and the choice is recorded on every handoff outcome. FALLBACK remains the
// always-available door."
//
// SO THIS FILE IS A MEASUREMENT, NOT A PREFERENCE, and three properties keep it one:
//
//   1. IT IS KEYED BY VERSION. A pin bump does not inherit this answer — an unknown version gets no
//      report and therefore `fallback`, which is the safe door and the one that always works.
//   2. IT IS RE-DERIVED IN CI. `test/joint/materialized-resume-probes.test.ts` runs the four probes
//      against the real artifact on both platforms and asserts that what they measure MATCHES what is
//      recorded here. A pin whose behaviour changed fails the suite rather than quietly opening a door
//      onto a store step 5 would refuse.
//   3. IT IS RECORDED PER HANDOFF. `HandoffPlan.decorationDoor` already carries the door a plan was
//      made under, so every outcome says which of the two mechanisms produced it.
//
// WHY THE PROBES CANNOT SIMPLY RUN AT CONSTRUCTION. Each one spawns the pinned runtime and drives a
// full resume — tens of seconds, a child process, a temp home. `createRuntimeSdk()` is called in a
// host's startup path; a door that cost a process tree to open would be a door nobody opens. The
// measurement therefore happens in CI, and its verdict travels as data.
import { PINNED_OFFICIAL_RUNTIME } from "../official/env-allowlist.ts";
import type { MaterializedResumeProbeReport } from "../seams/materialized-resume.ts";

/**
 * The recorded verdict per pinned official-runtime version.
 *
 * The evidence sentences are the probes' own, trimmed to what a reader of a handoff outcome needs;
 * `docs/probes/materialized-resume.md` carries the full run, both platforms, and the two withdrawn
 * earlier readings.
 */
export const MATERIALIZED_RESUME_PROBE_REPORTS: Readonly<Record<string, MaterializedResumeProbeReport>> = {
  [PINNED_OFFICIAL_RUNTIME]: {
    door: "preferred",
    probedAt: "2026-09-09T00:00:00.000Z",
    results: [
      {
        probe: "neighbor-file-survival",
        passed: true,
        evidence: "the `<sessionId>.provider-state.jsonl` sidecar beside the transcript is byte-identical through load, append, a fresh-process resume on the pinned runtime, and a store round trip",
      },
      {
        probe: "no-wash-back",
        passed: true,
        evidence: "a decorated materialized copy resumed on the pinned runtime left the canonical prefix byte-identical and added no duplicate uuids (measured: duplicate uuids = 0), in both round-trip orders",
      },
      {
        probe: "sidecar-round-trip",
        passed: true,
        evidence: "Claude→Winter→Claude and Winter→Claude→Winter with a populated sidecar left every Claude leg byte-unaffected and the dialect's ordering intact",
      },
      {
        probe: "crash-pairs",
        passed: true,
        evidence: "a record without its entry was classified collectable with the transcript untouched; an entry without its record degraded rather than corrupting, and the chain still validated",
      },
    ],
  },
};

/**
 * The report for a pin, or `undefined` — which is what keeps a bump honest.
 *
 * `undefined` means `fallback`: the decorator opens PREFERRED only when it is GIVEN a passing report,
 * so an unrecorded version, a host with no official peer at all, and a peer whose version could not be
 * read all land on the same always-available door.
 */
export function materializedResumeReportForPin(version: string | undefined): MaterializedResumeProbeReport | undefined {
  if (version === undefined) return undefined;
  return MATERIALIZED_RESUME_PROBE_REPORTS[version];
}
