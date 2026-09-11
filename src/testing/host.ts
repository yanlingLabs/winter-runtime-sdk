// THE PUBLISHED `./testing` SUBPATH (0.0.3, P8c-13) — `package.json` `exports["./testing"]` points its
// `bun`/`types`/`default` conditions at this file (`./index.ts` stays the FULL internal harness,
// reached by every test in this repository through a relative import; it is not published).
//
// WHY A SEPARATE FILE FROM `./index.ts`. `./index.ts` re-exports `./conformance.ts` and `./fakes.ts`,
// and BOTH of those name an optional peer (`@yanlinglabs/winter-conformance`,
// `@yanlinglabs/winter-provider-conformance`) in a top-level `import type`. A dynamic `import()`
// inside a function body (what `./fakes.ts`'s four peer-typed functions do) fixes the RUNTIME failure
// for a consumer who never calls them — but NOT the TYPE failure: TypeScript binds a `.d.ts` file's
// own top-level type-only imports as part of loading the file AT ALL, so a consumer merely importing
// an UNRELATED name from a barrel that (transitively) re-exports something out of `fakes.d.ts` or
// `conformance.d.ts` still hits `TS2307: Cannot find module '…'` pointing into THEIR header line, not
// into anything the consumer actually touched. Measured directly against a packed tarball with only
// the required peer installed.
//
// So this file imports ONLY from the two testing modules that name no peer at all
// (`./hermetic.ts`, `./capture-env.ts`) plus the peer-free half of `./peers.ts` — a host that installs
// neither `@yanlinglabs/winter-conformance` nor `@yanlinglabs/winter-provider-conformance` still gets
// a clean `tsc` AND a clean runtime import of `@yanlinglabs/winter-runtime-sdk/testing`.
export { createFakeKeychain, withHermeticHomes, withTempDir } from "./hermetic.ts";
export type { FakeKeychain } from "./hermetic.ts";
export { createFakeClaudePeer, createFakeWinterPeer } from "./peers.ts";
export type { FakeClaudePeerOptions, FakeWinterPeer, FakeWinterPeerOptions, RecordedQueryCall } from "./peers.ts";
export { HERMETIC_TRAFFIC_OPT_OUTS, officialCaptureEnv } from "./capture-env.ts";

// NOT HERE, deliberately (see the header above): `./conformance.ts`'s golden-trace tooling and
// `./fakes.ts`'s loopback-fake builders (`anthropicFake`, `openaiResponsesFake`, `requestsTo`,
// `withLoopbackFake`) — both reach an optional peer this subpath must not force on a consumer. A host
// that wants them adds the peer itself and imports `./index.ts` by relative path the way this
// repository's own tests do (it is not a published subpath), or — if a future cut needs them
// published — they get their OWN `exports` entry so importing THIS one never resolves their peer's
// types.
