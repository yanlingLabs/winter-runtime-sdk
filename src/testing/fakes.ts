// `@yanlinglabs/winter-provider-conformance/fakes`, wired into `bun test`.
//
// EVERY FAKE BINDS `127.0.0.1:0` AND CLOSES IN A `finally`. That is this phase's hermeticity rule and
// the fakes' own design (`startFake` binds port 0 on the loopback host; `withFake` closes with an
// explicit deadline whatever the body did). `withLoopbackFake` below is re-exported under a name that
// says so, because the one thing a lane must never do is call `startFake` and remember to close it.
//
// R-7b-6: the official SDK is driven in tests through `ANTHROPIC_BASE_URL` pointed at one of these
// fakes — never a real endpoint. `officialCaptureEnv` builds the minimal environment that does it,
// so the env allowlist a test uses is one object rather than a habit.
//
// BUN ONLY, and openly: `@yanlinglabs/winter-provider-conformance` declares `engines.bun` alone
// because its fakes use `Bun.serve`. Calling one of the four functions below under Node (or under Bun
// without the package installed) fails at the CALL, with that package's own error — no different from
// before.
//
// LAZY, since 0.0.3 (P8c-13), AT THE VALUE LEVEL: a top-level `import … from
// "@yanlinglabs/winter-provider-conformance/fakes"` would make importing THIS FILE at runtime throw
// `ERR_MODULE_NOT_FOUND` the moment anything evaluates it, whether or not the caller ever reaches for
// one of the four functions below. `loadFakesModule` moves that resolution to the moment one of them
// is CALLED (a dynamic `import()`, cached so every caller in one process shares the same module),
// which is also why `anthropicFake`/`openaiResponsesFake` — the vendor's own NAMESPACE re-exports, not
// functions — became async accessors here rather than staying live bindings: a live binding to an
// unresolved module cannot exist, only a promise of one.
//
// STILL NOT SAFE AT THE TYPE LEVEL, and that is WHY THIS FILE IS NOT IN THE PUBLISHED `./testing`
// SUBPATH'S GRAPH (`./host.ts` never imports it; `package.json`'s `./testing` entry points at
// `./host.ts`, not `./index.ts`). Measured directly: a consumer with the OPTIONAL peer absent still
// failed `tsc --noEmit` on THIS file's own `import type` line even when importing an unrelated name
// from the barrel — a `.d.ts` binds its own top-level type-only imports as part of being loaded at
// all, not lazily per export. `./capture-env.ts` carries the two exports below (`HERMETIC_TRAFFIC_OPT_OUTS`,
// `officialCaptureEnv`) that name no peer, so `./host.ts` can import THAT file directly; this file
// stays reachable only from `./index.ts`, the INTERNAL, unpublished barrel `bun test` uses by relative
// path.
import type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions } from "@yanlinglabs/winter-provider-conformance/fakes";

export type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions };

type FakesEntry = typeof import("@yanlinglabs/winter-provider-conformance/fakes");

let fakesModule: Promise<FakesEntry> | undefined;

function loadFakesModule(): Promise<FakesEntry> {
  fakesModule ??= import("@yanlinglabs/winter-provider-conformance/fakes");
  return fakesModule;
}

/**
 * Runs `fn` against a loopback fake and ALWAYS closes it.
 *
 * A rename of `withFake` rather than a wrapper: adding a layer would add a place for a leaked server
 * to hide. The name is the documentation — a lane reading `withLoopbackFake` at a call site knows
 * both that it binds loopback and that closing is not its problem.
 */
export async function withLoopbackFake<T>(opts: StartFakeOptions, fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const { withFake } = await loadFakesModule();
  return withFake(opts, fn);
}

/** The Anthropic Messages family's fake builders (`anthropicFakeRoutes`, `anthropicTurnResponse`, …). */
export async function anthropicFake(): Promise<FakesEntry["anthropicFake"]> {
  return (await loadFakesModule()).anthropicFake;
}

/** The OpenAI Responses family's fake builders (`responsesStream`, `responsesFrames`, …). */
export async function openaiResponsesFake(): Promise<FakesEntry["openaiResponsesFake"]> {
  return (await loadFakesModule()).openaiResponsesFake;
}

/** The requests whose path matches, for an assertion that does not want to count a health probe. */
export async function requestsTo(fake: FakeServer, path: string): Promise<RecordedRequest[]> {
  return (await loadFakesModule()).requestsTo(fake, path);
}

// `HERMETIC_TRAFFIC_OPT_OUTS`/`officialCaptureEnv` MOVED to `./capture-env.ts` (0.0.3, P8c-13): they
// name no optional peer, so they belong in the file `./host.ts` (the published `./testing` subpath)
// can import directly. Re-exported here, unchanged, for the tests that still reach them off this
// file or off the full internal barrel (`./index.ts`).
export { HERMETIC_TRAFFIC_OPT_OUTS, officialCaptureEnv } from "./capture-env.ts";
