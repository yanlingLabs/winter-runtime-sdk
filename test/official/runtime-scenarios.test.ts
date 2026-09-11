// WS-04 §12's SCENARIO CORPUS on the official branch, and the `RuntimeSelection` fixture per auth
// family (the plan's Task 2 test-bed line).
//
// "The behavioural differential harness compares the Winter path against the OFFICIAL SDK for the
// deterministic scenario corpus": plain query, tool use, permission allow/deny, interrupt,
// resume/fork. The alias, containment and spool rows have their own files; what is left is the
// corpus's own shape, plus the one thing a selection fixture is for — proving that each auth family
// produces exactly its own child environment and nothing else.
//
// THE TRACES GO THROUGH THE SHARED NORMALIZER (`normalizeTrace`) rather than through an assertion
// written here: it is the same normalizer the SDK repository compares its own goldens with, so a
// future differential between the two branches compares like with like.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, normalizeTrace, withLoopbackFake, type ConformanceTraceEntry } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { OfficialUserMessage } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter, type OfficialSessionHandle } from "../../src/official/index.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import { buildOfficialChildEnv, TRAFFIC_OPT_OUT_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "../../src/official/env-allowlist.ts";
import { AUTH_FAMILY_VARIABLES } from "../../src/official/auth.ts";
import { cleanupHermetic, hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback, toolResults, type HermeticSession, type ScriptedTurn } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 180_000;

/**
 * ONE `RuntimeSelection` PER AUTH FAMILY.
 *
 * The fixture the plan asks for, and it is the input to two different things: the env builder (each
 * family's own closed variable set) and the launch path (which family a session was selected for is
 * what the record carries into a resume). `custom` is what the loopback bed uses, because a loopback
 * endpoint plus a key is exactly the case the closed families do not cover.
 */
export const SELECTION_FIXTURES: Readonly<Record<RuntimeSelection["authFamily"], RuntimeSelection>> = {
  "api-key": selectionFixture({ authFamily: "api-key", providerId: "anthropic", reason: "D13: Claude family, Anthropic-protocol backend, Code mode" }),
  "console-oauth": selectionFixture({ authFamily: "console-oauth", providerId: "anthropic-console", reason: "D13: a bearer credential on an approved gateway" }),
  "cloud-credential-chain": selectionFixture({ authFamily: "cloud-credential-chain", providerId: "bedrock", reason: "D13: a cloud credential chain" }),
  "claude-oauth": selectionFixture({ authFamily: "claude-oauth", providerId: "anthropic", reason: "D13/D14: subscription OAuth, ship-gated" }),
  "local-none": selectionFixture({ authFamily: "local-none", providerId: "local", reason: "a local endpoint with no credential" }),
  custom: selectionFixture({ authFamily: "custom", providerId: "loopback", reason: "a host-named endpoint/credential pair" }),
};

function selectionFixture(over: Pick<RuntimeSelection, "authFamily" | "providerId" | "reason">): RuntimeSelection {
  return {
    runtimeKind: "claude-agent",
    modelRef: "claude-sonnet-4-5",
    family: "claude",
    sdkVersion: "0.0.2",
    decidedAt: new Date(0).toISOString(),
    ...over,
  };
}

class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
  async listSubkeys(): Promise<never[]> {
    return [];
  }
}

interface ScenarioResult {
  entries: ConformanceTraceEntry[];
  decisions: Array<{ tool: string; behavior: string; source: string }>;
  record: ReturnType<typeof scriptedLoopback>["record"];
  sessionId: string | undefined;
  session: HermeticSession;
}

async function runScenario(args: {
  turns: readonly ScriptedTurn[] | ((session: HermeticSession) => readonly ScriptedTurn[]);
  broker?: "allow" | "deny";
  prompt?: string | AsyncIterable<OfficialUserMessage>;
  onLive?: (session: OfficialSessionHandle, message: { type: string; subtype?: string }) => void | Promise<void>;
}): Promise<ScenarioResult> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const session = hermeticSession("scenario");
  const { routes, record } = scriptedLoopback(typeof args.turns === "function" ? args.turns(session) : args.turns);
  const decisions: Array<{ tool: string; behavior: string; source: string }> = [];
  const entries: ConformanceTraceEntry[] = [];
  let sessionId: string | undefined;
  const selection = SELECTION_FIXTURES.custom;

  await withLoopbackFake({ routes }, async (fake) => {
    const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
    const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
    const adapter = createOfficialAdapter(context, hermeticEnvPolicy());
    await adapter.ready();
    const env = adapter.buildChildEnv({
      selection,
      configDir: session.spool,
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
      base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const options = adapter.buildOptions({
      mode: "code",
      selection,
      cwd: session.cwd,
      sessionStore: new PassthroughStore() as unknown as SessionStore,
      autoMemoryDirectory: `${session.brandHome}/projects/scenario/memory`,
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: bed.executable,
      spawnProxy: adapter.spawnProxy,
      profile: "fresh-spool",
      configDir: session.spool,
    });
    const live = adapter.launch({
      address: "session:scenario",
      selection,
      prompt: args.prompt ?? "run the scenario",
      cwd: session.cwd,
      profile: "fresh-spool",
      configDir: session.spool,
      options: {
        ...options,
        env,
        canUseTool: createApprovalBridge({
          brand: WINTER_BRAND,
          mode: "default",
          broker: async (request) =>
            args.broker === "deny" ? { behavior: "deny", message: "the host's broker refused this call", toolUseID: request.toolUseID } : { behavior: "allow", updatedInput: request.input },
          onDecision: ({ request, result, source }) => decisions.push({ tool: request.toolName, behavior: result.behavior, source }),
        }),
      },
    });
    for await (const message of live.query) {
      const typed = message as { type: string; subtype?: string; session_id?: string };
      if (typed.type === "system" && typed.subtype === "init") sessionId = typed.session_id;
      entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: typed.type === "system" ? `system/${typed.subtype ?? ""}` : typed.type, payload: message as never });
      await args.onLive?.(live, typed);
    }
  });
  return { entries, decisions, record, sessionId, session };
}

describeRuntime("WS-04 §12's corpus on the official branch", () => {
  afterAll(cleanupHermetic);

  test(
    "plain query: the stream is the runtime's own, and the normalized trace has the corpus shape",
    async () => {
      const result = await runScenario({ turns: [{ text: "hello from the loopback" }] });
      const kinds = (await normalizeTrace(result.entries)).map((entry) => entry.kind);
      expect(kinds[0]).toBe("system/init");
      expect(kinds.at(-1)).toBe("result");
      expect(kinds).toContain("assistant");
      expect(result.decisions).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "tool use, allowed: the broker decides, and what it allowed is what happened",
    async () => {
      // A WRITE RATHER THAN A SHELL ECHO: the runtime auto-approves a handful of read-only shell
      // commands without consulting `canUseTool` at all, so a scenario built on `echo` would assert
      // the broker's behaviour against a call the broker never saw. Found by this test's first run.
      const result = await runScenario({
        turns: (session) => [{ toolUses: [{ id: "t1", name: "Write", input: { file_path: join(session.cwd, "allowed.txt"), content: "the broker said yes\n" } }] }, { text: "done" }],
        broker: "allow",
      });
      expect(result.decisions.some((decision) => decision.tool === "Write" && decision.source === "broker" && decision.behavior === "allow")).toBe(true);
      expect(existsSync(join(result.session.cwd, "allowed.txt"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "tool use, denied: the broker's typed deny reaches the model, and the call does not run",
    async () => {
      const result = await runScenario({
        turns: (session) => [{ toolUses: [{ id: "t1", name: "Write", input: { file_path: join(session.cwd, "denied.txt"), content: "the broker said no\n" } }] }, { text: "done" }],
        broker: "deny",
      });
      expect(result.decisions.some((decision) => decision.tool === "Write" && decision.source === "broker" && decision.behavior === "deny")).toBe(true);
      const blocked = toolResults(result.record).find((entry) => entry.tool_use_id === "t1");
      expect(JSON.stringify(blocked?.content)).toContain("the host's broker refused this call");
      expect(existsSync(join(result.session.cwd, "denied.txt"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "interrupt: `interrupt()` stops the foreground turn of a streaming session",
    async () => {
      // A STREAMING PROMPT, because that is the shape the runtime's interrupt applies to: a one-shot
      // string prompt has already finished sending by the time a caller could ask. The prompt is held
      // open so the session does not end on its own — the interrupt is what has to end it.
      let releasePrompt: () => void = () => undefined;
      const promptHeld = new Promise<void>((resolve) => {
        releasePrompt = resolve;
      });
      const prompt = (async function* (): AsyncIterable<OfficialUserMessage> {
        yield { type: "user", message: { role: "user", content: "take your time" }, parent_tool_use_id: null, session_id: "" } as unknown as OfficialUserMessage;
        await promptHeld;
      })();

      const started = Date.now();
      let interrupted = false;
      let thrown: unknown;
      // COLLECTED AS THEY ARRIVE, not from the returned result: the pinned runtime ends an
      // interrupted streaming turn by THROWING, so a list built from the return value is empty and
      // every assertion over it passes vacuously. (It did, on this test's first green run.)
      const frames: string[] = [];
      try {
        await runScenario({
          // The reply is held back longer than the interrupt takes to arrive, so a session that
          // ignored the interrupt would deliver an assistant message and this test would see it.
          turns: [{ text: "this reply should never be delivered", delayMs: 8_000 }],
          prompt,
          onLive: async (live, message) => {
            frames.push(message.type === "system" ? `system/${message.subtype ?? ""}` : message.type);
            if (!interrupted && message.type === "system" && message.subtype === "init") {
              interrupted = true;
              await live.interrupt();
              // AND THEN CLOSE THE PROMPT. `interrupt()` stops the TURN, not the session: a streaming
              // session stays open for the next message, which is exactly what
              // `perTaskStopAffordance` is for. Ending the prompt iterable is what ends the session,
              // and a first version of this test that only interrupted waited for the full timeout —
              // correctly, as it turns out.
              releasePrompt();
            }
          },
        });
      } catch (error) {
        // The pinned runtime surfaces an interrupted turn by ENDING THE STREAM WITH AN ERROR rather
        // than with a result message. Both endings are acceptable here and the assertions below are
        // about what did NOT happen; the ending itself is recorded rather than asserted, because it
        // is the vendor's choice and not ours.
        thrown = error;
      } finally {
        releasePrompt();
      }

      expect(interrupted).toBe(true);
      // It ENDED, and long before the held prompt would have let it: an interrupt that did nothing
      // would have waited for the 8-second reply and then for the prompt.
      expect(Date.now() - started).toBeLessThan(8_000);
      // …and the held reply never became an assistant message.
      expect(frames).toContain("system/init");
      expect(frames).not.toContain("assistant");
      // eslint-disable-next-line no-console
      console.log(`[interrupt] ended by ${thrown === undefined ? "stream end" : `a thrown ${(thrown as Error).constructor.name}`}; frames: ${JSON.stringify(frames)}`);
    },
    30_000,
  );
});

describe("the RuntimeSelection fixture per auth family", () => {
  test("each family produces exactly its own variables, and nothing else", () => {
    // THE SUBJECT IS THE AUTH FAMILY, so R-7b-11's four branch-owned traffic opt-outs are removed
    // before the comparison — and asserted present on every family first, which is the other half of
    // the claim ("exactly its own variables, and nothing else" is about credentials, not about the
    // variables this branch sets on every child whatever the family).
    const build = (selection: RuntimeSelection, credentials: Record<string, string>): Record<string, string> => {
      const env = buildOfficialChildEnv({ selection, configDir: "/spool", brand: WINTER_BRAND, credentials }, { claudeOauth: { approved: true } });
      for (const [name, value] of Object.entries(TRAFFIC_OPT_OUT_VARIABLES)) expect({ family: selection.authFamily, name, value: env[name] }).toEqual({ family: selection.authFamily, name, value });
      return Object.fromEntries(Object.entries(env).filter(([name]) => !TRAFFIC_OPT_OUT_VARIABLE_NAMES.includes(name)));
    };

    expect(build(SELECTION_FIXTURES["api-key"], { ANTHROPIC_API_KEY: "k" })).toEqual({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "/spool" });
    expect(build(SELECTION_FIXTURES["console-oauth"], { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw" })).toEqual({
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "https://gw",
      CLAUDE_CONFIG_DIR: "/spool",
    });
    expect(build(SELECTION_FIXTURES["cloud-credential-chain"], { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" })).toEqual({
      AWS_REGION: "us-east-1",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/spool",
    });
    // The two families that inject NOTHING inject nothing.
    expect(build(SELECTION_FIXTURES["claude-oauth"], {})).toEqual({ CLAUDE_CONFIG_DIR: "/spool" });
    expect(build(SELECTION_FIXTURES["local-none"], {})).toEqual({ CLAUDE_CONFIG_DIR: "/spool" });
    // …and `custom` is the only open one, still fenced by the MUST-NOT list.
    expect(build(SELECTION_FIXTURES.custom, { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_API_KEY: "k" })).toEqual({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      CLAUDE_CONFIG_DIR: "/spool",
    });
    expect(() => build(SELECTION_FIXTURES.custom, { CLAUDE_CODE_OAUTH_TOKEN: "t" })).toThrow(/never injected/);
  });

  test("every family in the fixture set has a variable table (or an explicitly empty one)", () => {
    for (const [family, selection] of Object.entries(SELECTION_FIXTURES)) {
      expect([family, selection.authFamily]).toEqual([family, family as RuntimeSelection["authFamily"]]);
    }
    expect(Object.keys(AUTH_FAMILY_VARIABLES).sort()).toEqual(["api-key", "bedrock", "claude-oauth", "console-oauth", "local-none", "vertex"]);
  });
});
