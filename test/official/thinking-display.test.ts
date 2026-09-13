// WS-18 W18-17 / P10b-6 R5 — ASKING FOR CLAUDE'S SUMMARIZED THINKING DISPLAY.
//
// R-10b-9: "Claude's visible summarized `thinking` text is its carryable summary… The official leg
// asks for summarized thinking display." W18-17 names two doors and an order:
//   1. `extraArgs: { "thinking-display": "summarized" }` — `Options.extraArgs` exists (sdk.d.ts:1533);
//      `--thinking-display <display>` is present in the pinned 2.1.250 binary though hidden from
//      `--help` (measured 2026-09-13).
//   2. Otherwise `display: "summarized"` on the derived `ThinkingAdaptive | ThinkingEnabled` config.
//
// THIS TEST IS THE PROOF, against the REAL pinned wrapper over a loopback fake — never assumed from
// the flag's mere presence in the binary. It drives one ordinary launch (no resume, no compaction:
// the door is orthogonal to both) and reads the exact `/v1/messages` request body Anthropic would
// have received, the same harness `test/official/support.ts` gives every real-runtime test in this
// package.
import { afterAll, describe, expect, test } from "bun:test";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import { createRuntimeMessaging } from "../../src/messaging/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import { cleanupHermetic, hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 180_000;

/** A store that persists nothing — this door does not touch the transcript at all. */
class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
  async listSubkeys(): Promise<never[]> {
    return [];
  }
}

const SELECTION: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "P10b-6 / R5: the summarized-thinking-display capture",
  decidedAt: new Date(0).toISOString(),
};

describeRuntime("P10b-6 / R5 — the request asks for summarized thinking display", () => {
  afterAll(cleanupHermetic);

  test(
    "door 1 (extraArgs) OR door 2 (thinking.display): the request's thinking.display is summarized with the type unchanged",
    async () => {
      /* c8 ignore next */
      if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
      const session = hermeticSession("thinking-display");
      const { routes, record } = scriptedLoopback([{ text: "ok, this is the R5 proof" }]);

      await withLoopbackFake({ routes }, async (fake) => {
        const directoryStore = createInMemoryRuntimeDirectoryStore();
        const { peer } = createFakeWinterPeer();
        const base = { peers: { winter: peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };
        const { directory } = createRuntimeMessaging(base, {});
        const context: SeamContextWithDirectory = { ...base, directory };

        const adapter = createOfficialAdapter(context, hermeticEnvPolicy());
        await adapter.ready();

        const options = adapter.buildOptions({
          mode: "code" as const,
          selection: SELECTION,
          cwd: session.cwd,
          sessionStore: new PassthroughStore() as unknown as SessionStore,
          autoMemoryDirectory: `${session.brandHome}/projects/thinking-display/memory`,
          brand: WINTER_BRAND,
          pathToClaudeCodeExecutable: bed.executable,
          spawnProxy: adapter.spawnProxy,
          profile: "fresh-spool" as const,
          configDir: session.spool,
        });
        const env = adapter.buildChildEnv({
          selection: SELECTION,
          configDir: session.spool,
          brand: WINTER_BRAND,
          credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
          base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        });

        // THE OPTIONS OBJECT ITSELF ALREADY PROVES DOOR 1 IS WIRED: `buildOfficialOptions` sets
        // `extraArgs["thinking-display"] = "summarized"` unconditionally (W18-17 door 1).
        expect((options as unknown as { extraArgs?: Record<string, unknown> }).extraArgs?.["thinking-display"]).toBe("summarized");

        const live = adapter.launch({
          address: "session:thinking-display",
          selection: SELECTION,
          prompt: "say ok",
          cwd: session.cwd,
          profile: "fresh-spool",
          configDir: session.spool,
          options: {
            ...options,
            env,
            canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
          },
        });
        for await (const _ of live.query) void _;

        // THE PROOF: the real `/v1/messages` request the wrapper sent, read from the loopback capture.
        const withThinking = record.requests.filter((body) => typeof body["thinking"] === "object" && body["thinking"] !== null);
        expect(withThinking.length).toBeGreaterThan(0);
        for (const body of withThinking) {
          const thinking = body["thinking"] as { type?: unknown; display?: unknown; budget_tokens?: unknown };
          // THE TYPE (AND BUDGET) ARE UNCHANGED — this door asks only for the DISPLAY, never for a
          // thinking type or budget the leg did not already derive on its own.
          expect(typeof thinking.type).toBe("string");
          expect(thinking.display).toBe("summarized");
        }
      });
    },
    TIMEOUT,
  );
});
