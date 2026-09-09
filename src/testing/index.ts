// The test harness, as one import site: `import { … } from "../../src/testing/index.ts"`.
//
// NOT A PUBLISHED SUBPATH, deliberately. Everything here reaches a DEV dependency
// (`@yanlinglabs/winter-conformance`, `@yanlinglabs/winter-provider-conformance`) that a consumer of
// this package never installs, and `src/testing/**` is excluded from the compiled emit for the same
// reason. `src/index.ts`'s own header says so; the installed-tarball smoke walks every declared
// `exports` entry, so a subpath here would fail it on the first publish.
export { compareTraces, goldenTracePath, listGoldenTraces, loadGoldenTrace, normalizeTrace, runOfficialCapture } from "./conformance.ts";
export type { ConformanceTraceEntry } from "./conformance.ts";
export { anthropicFake, HERMETIC_TRAFFIC_OPT_OUTS, officialCaptureEnv, openaiResponsesFake, requestsTo, withLoopbackFake } from "./fakes.ts";
export type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions } from "./fakes.ts";
export { createFakeKeychain, withHermeticHomes, withTempDir } from "./hermetic.ts";
export type { FakeKeychain } from "./hermetic.ts";
export { createFakeClaudePeer, createFakeWinterPeer } from "./peers.ts";
export type { FakeClaudePeerOptions, FakeWinterPeer, FakeWinterPeerOptions, RecordedQueryCall } from "./peers.ts";
