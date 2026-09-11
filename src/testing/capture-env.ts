// The official-capture environment — split out of `./fakes.ts` at 0.0.3 (P8c-13) for ONE reason: this
// file names NO optional peer, anywhere, so it is safe to sit in the published `./testing` subpath's
// barrel (`./host.ts`) without dragging `@yanlinglabs/winter-provider-conformance`'s TYPES into a
// consumer's type-checker.
//
// WHY A SEPARATE FILE RATHER THAN A LAZY IMPORT LIKE `./fakes.ts`'S OWN FOUR FUNCTIONS: laziness
// (a dynamic `import()` inside a function body) fixes the RUNTIME failure — a consumer who never
// calls `anthropicFake()` never pays for the module — but it does NOT fix the TYPE failure. TypeScript
// binds a `.d.ts` file's own top-level `import type` as part of loading it AT ALL, regardless of which
// export a downstream consumer actually reaches for: `export type { FakeRoute, … } from "./fakes.ts"`
// forces `fakes.d.ts` open, and `fakes.d.ts` still opens with
// `import type { FakeRoute, … } from "@yanlinglabs/winter-provider-conformance/fakes"` (a value-level
// `import()` cannot describe a TYPE, so the type-only import stays static). Measured directly: a probe
// project with ONLY the required peer installed, importing nothing but `officialCaptureEnv` from the
// published subpath, still failed `tsc --noEmit` with `TS2307: Cannot find module
// '@yanlinglabs/winter-provider-conformance/fakes'` pointing INTO `fakes.d.ts`'s own header line — the
// module graph, not the specific import, is what a `.d.ts` reference walks. So `HERMETIC_TRAFFIC_OPT_OUTS`
// and `officialCaptureEnv` live here, in a file `./host.ts` can safely import from directly, and
// `./fakes.ts` re-exports them (unchanged internal shape) for the tests that still reach them off the
// full internal barrel (`./index.ts`).
import { TRAFFIC_OPT_OUT_VARIABLES } from "../official/env-allowlist.ts";

/**
 * THE FOUR TRAFFIC OPT-OUTS THAT MAKE A CHILD RUNTIME ACTUALLY HERMETIC (whole-branch review, F-1).
 *
 * HERMETICITY IS A PROPERTY OF THE CHILD ENVIRONMENT, NOT OF THE FAKE. The loopback fake captures the
 * MODEL endpoint and nothing else; the pinned artifact also fetches REMOTE FEATURE CONFIGURATION
 * (`cdn.growthbook.io`), telemetry, error reports and update checks, none of which pass through
 * `ANTHROPIC_BASE_URL`. Measured on this pin, same binary, same options, same fake: with these four
 * unset the request carries 25 tools; with them set, 21 — `DesignSync`, `Monitor`,
 * `PushNotification` and `advisor_20260301:advisor` appear ONLY when the remote flag fetch succeeds.
 *
 * SO A TEST WITHOUT THESE IS NOT MEASURING THE PIN. It is measuring the pin plus whatever a CDN said
 * this minute, which is (a) a different answer on a different day, (b) a suite that goes red when the
 * fetch times out — the "flake seen twice in ~20 runs" — and (c) a `docs/probes/` record whose "no
 * network" line is false.
 *
 * THE SAME OBJECT THE PRODUCTION ENV BUILDER SETS (R-7b-11). It used to be a test-only copy handed to
 * `configuredExtras`, and a copy is exactly how a test bed and a shipped session end up measuring two
 * different artifacts: this re-export is what makes "the beds run what a host runs" checkable by
 * identity rather than by reading two lists.
 */
export { TRAFFIC_OPT_OUT_VARIABLES as HERMETIC_TRAFFIC_OPT_OUTS } from "../official/env-allowlist.ts";

/**
 * The minimal environment that points an official-SDK session at a loopback fake (R-7b-6).
 *
 * A REPLACEMENT, never a spread of `process.env` — WS-14 §3's own rule for the child environment, and
 * the same reason the SDK repository's capture harness sets `HOME`: a throwaway is required because
 * `os.homedir()` falls back to the OS user database and would otherwise reach the real `~/.claude`
 * regardless of `CLAUDE_CONFIG_DIR`.
 *
 * PLUS THE FOUR OPT-OUTS ABOVE, unconditionally, because "hermetic" has to mean the whole child and
 * not just its model endpoint (F-1). `allowRemoteConfig` is the ONE deliberate escape hatch: the D29
 * probe's non-hermetic leg uses it to observe what remote configuration adds, and it is spelled at
 * the call site so a reader can see which legs are which.
 */
export function officialCaptureEnv(input: { baseUrl: string; apiKey?: string; claudeConfigDir: string; home: string; allowRemoteConfig?: boolean }): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_API_KEY: input.apiKey ?? "sk-ant-fake-hermetic-key",
    CLAUDE_CONFIG_DIR: input.claudeConfigDir,
    HOME: input.home,
    ...(input.allowRemoteConfig === true ? {} : TRAFFIC_OPT_OUT_VARIABLES),
  };
}
