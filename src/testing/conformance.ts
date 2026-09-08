// `@yanlinglabs/winter-conformance`, wired into `bun test`.
//
// WS-02's Phase 6 amendment: the SDK repository "publishes `@yanlinglabs/winter-conformance` for the
// router's hermetic tests and OWNS NONE OF THE ROUTER'S OWN GATES". So this module is a thin,
// deliberate surface — four things a lane actually needs, named for what they are here — rather than
// a re-export of everything that package happens to carry.
//
// THE CAPTURE IS EXPOSED BUT NEVER CALLED BY A TEST. `runOfficialCapture` installs the pinned
// official SDK into a throwaway npm prefix (`Bun.spawn`) and drives it against loopback fakes: it
// needs network egress and ~200MB, and WS-02 §6 requires that fetch to be EPHEMERAL and
// checksum-verified. Lanes A and D drive it deliberately (the D29 advisor probe, R-7b-8; the
// official-branch captures, R-7b-6) behind their own opt-in gate. Nothing in `bun test` may call it,
// and `test/spine/testing-conformance.test.ts` asserts only that it is a function.
import { compareTraces, goldenPath, listGoldens, loadGolden, normalizeTrace, runCapture } from "@yanlinglabs/winter-conformance";
import type { ConformanceTraceEntry } from "@yanlinglabs/winter-conformance";

export type { ConformanceTraceEntry };

/** The committed golden traces this package can compare against, by name. */
export function listGoldenTraces(): string[] {
  return listGoldens();
}

/** One committed golden, parsed. */
export function loadGoldenTrace(name: string): ConformanceTraceEntry[] {
  return loadGolden(name);
}

/** Where a golden lives on disk — for a diff a human reads, never for writing. */
export function goldenTracePath(name: string): string {
  return goldenPath(name);
}

/**
 * The normalizer both sides of a differential must pass through.
 *
 * Exported by name (rather than letting each lane import it from the package) so that "the router
 * normalizes traces the same way the SDK repository does" is one import site, and a future
 * divergence is a diff here rather than in six test files.
 */
export { normalizeTrace, compareTraces };

/** GATED, NEVER CALLED FROM `bun test` — see this module's header. */
export const runOfficialCapture: () => Promise<void> = runCapture;
