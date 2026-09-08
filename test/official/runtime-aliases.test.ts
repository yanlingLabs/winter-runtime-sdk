// WS-17 ROWS 1, 2 AND 3, against the REAL pinned runtime.
//
// Row 1 — "Real model-emitted `SendMessage` through the TS alias reaches the canonical handler with
//          native args and returns the visible result."
// Row 2 — "`ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behaviour
//          without Tool Search."
// Row 3 — "`disallowedTools` + permission floor cover harness-internal/direct paths aliases miss."
//
// These are the rows a unit test CANNOT prove: every one of them is a statement about what the vendor
// runtime does with our configuration. So the runtime is the real 0.3.250 binary, the model is a
// loopback fake on `127.0.0.1` scripted to emit exactly the blocks each row is about, and the handler
// is a recording fake standing in for the messaging handlers (which are the router's other lane).
import { afterAll, describe, expect, test } from "bun:test";
import { WINTER_BRAND, mcpToolName, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { acceptNativeSendMessageArgs, aliasDenyNames, officialToolAliases } from "../../src/official/aliases.ts";
import { officialDisallowedTools } from "../../src/official/containment.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import { officialMcpServers, winterMcpServerDescriptor, type WinterMcpHandler } from "../../src/official/mcp-descriptors.ts";
import { advertisedToolNames, cleanupHermetic, hermeticSession, officialRuntimeBed, scriptedLoopback, toolResults, type ScriptedTurn } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 120_000;

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  // The loopback is an endpoint + key pair, which is exactly what the `custom` family is for; the
  // closed families are exercised in `env-allowlist.test.ts`, where no endpoint override is involved.
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the real-runtime bed",
  decidedAt: new Date(0).toISOString(),
};

class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
  async listSubkeys(): Promise<never[]> {
    return [];
  }
}

interface RunResult {
  messages: Array<{ type: string; subtype?: string }>;
  calls: Array<{ tool: string; args: unknown }>;
  record: ReturnType<typeof scriptedLoopback>["record"];
  configDir: string;
}

/**
 * One real session: the adapter builds the options, the real runtime runs them against the loopback.
 *
 * The handlers are recording fakes — the real `send_message`/`list_agents` implementations are Lane
 * B's, and what these rows are about is whether the call ARRIVES, with which arguments, and what the
 * model sees come back.
 */
async function runSession(args: {
  turns: readonly ScriptedTurn[];
  disallowedTools?: readonly string[];
  handlers?: { sendMessage?: WinterMcpHandler; listAgents?: WinterMcpHandler };
}): Promise<RunResult> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const session = hermeticSession("aliases");
  const { routes, record } = scriptedLoopback(args.turns);
  const calls: Array<{ tool: string; args: unknown }> = [];
  const messages: Array<{ type: string; subtype?: string }> = [];

  return withLoopbackFake({ routes }, async (fake) => {
    const directoryStore = createInMemoryRuntimeDirectoryStore();
    const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };
    const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
    const adapter = createOfficialAdapter(context);
    await adapter.ready();

    const descriptor = winterMcpServerDescriptor({
      brand: WINTER_BRAND,
      branchLabel: "winter-claude-agent",
      messaging: {
        sendMessage:
          args.handlers?.sendMessage ??
          (async (raw) => {
            calls.push({ tool: "send_message", args: raw });
            const accepted = acceptNativeSendMessageArgs(raw);
            return accepted.ok
              ? { content: [{ type: "text" as const, text: `delivered to ${accepted.args.to}` }] }
              : { content: [{ type: "text" as const, text: `refused: ${accepted.reason}` }], isError: true };
          }),
        listAgents:
          args.handlers?.listAgents ??
          (async (raw) => {
            calls.push({ tool: "list_agents", args: raw });
            return { content: [{ type: "text" as const, text: JSON.stringify({ listing: "one live peer: reviewer" }) }] };
          }),
      },
    });

    const templateInput = {
      mode: "code" as const,
      selection,
      cwd: session.cwd,
      sessionStore: new PassthroughStore() as unknown as SessionStore,
      autoMemoryDirectory: `${session.brandHome}/projects/aliases/memory`,
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: bed.executable,
      spawnProxy: adapter.spawnProxy,
      profile: "fresh-spool" as const,
      configDir: session.spool,
    };
    const env = adapter.buildChildEnv({
      selection,
      configDir: session.spool,
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
      base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const options = adapter.buildOptions(templateInput);
    const live = adapter.launch({
      selection,
      prompt: "do the thing",
      cwd: session.cwd,
      profile: "fresh-spool",
      configDir: session.spool,
      options: {
        ...options,
        env,
        mcpServers: officialMcpServers({ descriptor, module: bed.mcpModule, toInputShape: bed.toInputShape, branchLabel: "winter-claude-agent" }),
        canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
        ...(args.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools as string[], ...args.disallowedTools] }),
      },
    });

    for await (const message of live.query) messages.push(message as { type: string; subtype?: string });
    return { messages, calls, record, configDir: live.configDir };
  });
}

describeRuntime("WS-17 rows 1-3 — aliasing, against the real pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "row 1: a model-emitted `SendMessage` reaches the canonical handler with NATIVE args, and its result is what the model sees",
    async () => {
      const result = await runSession({
        turns: [{ toolUses: [{ id: "toolu_row1", name: "SendMessage", input: { to: "reviewer", message: "ping", summary: "a ping" } }] }, { text: "sent" }],
      });

      // The handler was reached — through the ALIAS, from the built-in name the model emitted.
      expect(result.calls).toEqual([{ tool: "send_message", args: { to: "reviewer", message: "ping", summary: "a ping" } }]);
      // …with the NATIVE argument schema intact (WS-10 §10.1's own fields, unrenamed, unwrapped).
      expect(acceptNativeSendMessageArgs(result.calls[0]?.args).ok).toBe(true);
      // …and the VISIBLE result came back as this tool call's result.
      const results = toolResults(result.record);
      expect(results.some((entry) => entry.tool_use_id === "toolu_row1" && JSON.stringify(entry.content).includes("delivered to reviewer"))).toBe(true);
      expect(results.some((entry) => entry.is_error === true)).toBe(false);
      // The whole session ran on loopback and nowhere else.
      expect(new Set(result.record.paths)).toEqual(new Set(["/api/hello", "/v1/messages"]));
      expect(result.messages.at(-1)?.type).toBe("result");
      expect(result.messages.at(-1)?.subtype).toBe("success");
    },
    TIMEOUT,
  );

  test(
    "row 2: `ListAgents` aliases the same way, and the advertised set records what 0.3.250 actually does",
    async () => {
      const result = await runSession({ turns: [{ toolUses: [{ id: "toolu_row2", name: "ListAgents", input: {} }] }, { text: "listed" }] });
      expect(result.calls).toEqual([{ tool: "list_agents", args: {} }]);
      expect(toolResults(result.record).some((entry) => JSON.stringify(entry.content).includes("one live peer"))).toBe(true);

      // THE MEASUREMENT ROW 2 ASKS FOR. Both aliases are configured, so the model emits the built-in
      // name; what the runtime ADVERTISES alongside it is the vendor's decision, and this is it.
      const advertised = advertisedToolNames(result.record);
      const canonical = [mcpToolName(WINTER_BRAND, "send_message"), mcpToolName(WINTER_BRAND, "list_agents")];
      expect(advertised).toContain("SendMessage");
      expect(advertised).toContain("ListAgents");
      // RECORDED, NOT WISHED FOR: on this runtime the canonical twins are advertised TOO. The pinned
      // SDK surface exposes no Tool Search control at all (no such option in the declarations, no such
      // string in the artifact), so "behaviour without Tool Search" is the only behaviour available —
      // and in it, §7's "the model normally sees one SendMessage" is an INTENT the vendor does not
      // implement for us. The deny floor is what does not depend on it.
      expect(canonical.every((name) => advertised.includes(name))).toBe(true);

      // D29 (Lane D owns the probe; this is the observation the capture happens to carry): whether the
      // advertised set contains an `advisor` at all, under a plain API-key-shaped session.
      // eslint-disable-next-line no-console
      console.log(`[D29 observation] advisor advertised in a plain SDK session: ${String(advertised.some((name) => name.toLowerCase().includes("advisor")))}`);
    },
    TIMEOUT,
  );

  test(
    "row 3: the paths the alias does not cover — the canonical name direct, and where a deny rule must be spelled",
    async () => {
      // (a) THE DIRECT PATH. A model that emits the CANONICAL name reaches the same handler object,
      //     so the receiver-side floor that handler applies covers the alias-free route too.
      const direct = await runSession({
        turns: [{ toolUses: [{ id: "toolu_row3a", name: mcpToolName(WINTER_BRAND, "send_message"), input: { to: "reviewer", message: "direct" } }] }, { text: "ok" }],
      });
      expect(direct.calls).toEqual([{ tool: "send_message", args: { to: "reviewer", message: "direct" } }]);

      // (b) THE MEASUREMENT THIS ROW EXISTS FOR, and it is a finding rather than a confirmation:
      //     denying the BUILT-IN name does NOT stop the aliased call on this runtime. The deny check
      //     runs after alias resolution, so the rule a host would obviously write is a rule that does
      //     nothing — silently, on this branch only.
      const deniedBuiltinOnly = await runSession({
        turns: [{ toolUses: [{ id: "toolu_row3b", name: "SendMessage", input: { to: "reviewer", message: "not blocked" } }] }, { text: "ok" }],
        disallowedTools: ["SendMessage"],
      });
      expect(deniedBuiltinOnly.calls).toEqual([{ tool: "send_message", args: { to: "reviewer", message: "not blocked" } }]);

      // (c) …and denying the RESOLVED canonical name does stop it. `aliasDenyNames` is the helper
      //     that keeps a caller from having to know this, and `officialDisallowedTools` expands every
      //     denied built-in through it.
      const deniedResolved = await runSession({
        turns: [{ toolUses: [{ id: "toolu_row3c", name: "SendMessage", input: { to: "reviewer", message: "blocked" } }] }, { text: "ok" }],
        disallowedTools: [...aliasDenyNames("SendMessage", WINTER_BRAND)],
      });
      expect(deniedResolved.calls).toEqual([]);
      const blocked = toolResults(deniedResolved.record).find((entry) => entry.tool_use_id === "toolu_row3c");
      expect(blocked).toBeDefined();
      expect(JSON.stringify(blocked?.content).toLowerCase()).toMatch(/denied|not allowed|permission|disabled|blocked/);

      // (d) THE FLOOR THAT DOES NOT DEPEND ON A NAME AT ALL: the permission bridge's containment
      //     decision is applied to whatever the model emitted, so a vendor-named write is refused on
      //     the harness-internal path as well as the model-emitted one.
      expect(officialDisallowedTools({ deniedAliasedBuiltins: ["SendMessage"] }, WINTER_BRAND)).toEqual(["CronCreate", "SendMessage", mcpToolName(WINTER_BRAND, "send_message")]);
    },
    TIMEOUT,
  );

  test(
    "the alias map the runtime was given is the brand's own, and the vendor literals are untouched",
    async () => {
      const aliases = officialToolAliases(WINTER_BRAND);
      expect(Object.keys(aliases)).toEqual(["SendMessage", "ListAgents"]);
      expect(Object.values(aliases)).toEqual([mcpToolName(WINTER_BRAND, "send_message"), mcpToolName(WINTER_BRAND, "list_agents")]);
    },
    TIMEOUT,
  );
});
