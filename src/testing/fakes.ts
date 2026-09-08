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
 * The minimal environment that points an official-SDK session at a loopback fake (R-7b-6).
 *
 * A REPLACEMENT, never a spread of `process.env` — WS-14 §3's own rule for the child environment, and
 * the same reason the SDK repository's capture harness sets exactly these four: `HOME` must be a
 * throwaway too, because `os.homedir()` falls back to the OS user database and would otherwise reach
 * the real `~/.claude` regardless of `CLAUDE_CONFIG_DIR`.
 */
export function officialCaptureEnv(input: { baseUrl: string; apiKey?: string; claudeConfigDir: string; home: string }): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_API_KEY: input.apiKey ?? "sk-ant-fake-hermetic-key",
    CLAUDE_CONFIG_DIR: input.claudeConfigDir,
    HOME: input.home,
  };
}
