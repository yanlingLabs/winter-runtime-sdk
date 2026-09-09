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
// because its fakes use `Bun.serve`. This module is imported by tests, never by `src/index.ts`, and
// `src/testing/**` is excluded from the published build for exactly that reason.
import { anthropicFake, openaiResponsesFake, requestsTo, withFake } from "@yanlinglabs/winter-provider-conformance/fakes";
import type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions } from "@yanlinglabs/winter-provider-conformance/fakes";

export type { FakeRoute, FakeServer, RecordedRequest, StartFakeOptions };
export { anthropicFake, openaiResponsesFake, requestsTo };

/**
 * Runs `fn` against a loopback fake and ALWAYS closes it.
 *
 * A rename of `withFake` rather than a wrapper: adding a layer would add a place for a leaked server
 * to hide. The name is the documentation — a lane reading `withLoopbackFake` at a call site knows
 * both that it binds loopback and that closing is not its problem.
 */
export const withLoopbackFake: <T>(opts: StartFakeOptions, fn: (fake: FakeServer) => Promise<T>) => Promise<T> = withFake;

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
 * network" line is false. All four names are in the pinned artifact's own non-credential registry, so
 * they ride Lane A's `configuredExtras` door as declared extras rather than as an exception to it.
 */
export const HERMETIC_TRAFFIC_OPT_OUTS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
};

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
    ...(input.allowRemoteConfig === true ? {} : HERMETIC_TRAFFIC_OPT_OUTS),
  };
}
