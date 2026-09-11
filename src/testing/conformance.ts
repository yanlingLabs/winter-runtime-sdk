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
//
// LAZY, since 0.0.3 (P8c-13), for the same reason as `./fakes.ts`: `@yanlinglabs/winter-conformance`
// is an OPTIONAL peer of the published `./testing` subpath, so this module's OWN evaluation must not
// require it to be installed — a consumer who only reaches for `./fakes.ts` or `./hermetic.ts`'s
// exports still imports THIS file, transitively, through `src/testing/index.ts`'s barrel re-export.
import type { ConformanceTraceEntry } from "@yanlinglabs/winter-conformance";

export type { ConformanceTraceEntry };

type ConformanceEntry = typeof import("@yanlinglabs/winter-conformance");

let conformanceModule: Promise<ConformanceEntry> | undefined;

function loadConformanceModule(): Promise<ConformanceEntry> {
  conformanceModule ??= import("@yanlinglabs/winter-conformance");
  return conformanceModule;
}

/** The committed golden traces this package can compare against, by name. */
export async function listGoldenTraces(): Promise<string[]> {
  return (await loadConformanceModule()).listGoldens();
}

/** One committed golden, parsed. */
export async function loadGoldenTrace(name: string): Promise<ConformanceTraceEntry[]> {
  return (await loadConformanceModule()).loadGolden(name);
}

/** Where a golden lives on disk — for a diff a human reads, never for writing. */
export async function goldenTracePath(name: string): Promise<string> {
  return (await loadConformanceModule()).goldenPath(name);
}

/**
 * The normalizer both sides of a differential must pass through.
 *
 * Exported by name (rather than letting each lane import it from the package) so that "the router
 * normalizes traces the same way the SDK repository does" is one import site, and a future
 * divergence is a diff here rather than in six test files.
 */
export async function normalizeTrace(entries: ConformanceTraceEntry[]): Promise<ConformanceTraceEntry[]> {
  return (await loadConformanceModule()).normalizeTrace(entries);
}

export async function compareTraces(a: ConformanceTraceEntry[], b: ConformanceTraceEntry[]): Promise<string[]> {
  return (await loadConformanceModule()).compareTraces(a, b);
}

/** GATED, NEVER CALLED FROM `bun test` — see this module's header. */
export async function runOfficialCapture(): Promise<void> {
  return (await loadConformanceModule()).runCapture();
}
