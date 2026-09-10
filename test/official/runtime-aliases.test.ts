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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { officialMcpServers, winterMcpServerDescriptor, type WinterMcpHandler, type WinterMcpToolDescriptor } from "../../src/official/mcp-descriptors.ts";
import { HERMETIC_TRAFFIC_OPT_OUTS, advertisedToolNames, cleanupHermetic, hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback, toolResults, type ScriptedTurn } from "./support.ts";

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
  /** The child environment the production builder produced — where the four opt-outs are observable. */
  env: Record<string, string>;
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
  /** Extra tools on the standing server — §11's capability slot, which is how the probe registers `advisor`. */
  capabilities?: readonly WinterMcpToolDescriptor[];
  /** Merged OVER the brand's own alias map, so a probe can add a key the router does not ship. */
  toolAliases?: Readonly<Record<string, string>>;
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
    const adapter = createOfficialAdapter(context, hermeticEnvPolicy());
    await adapter.ready();

    const descriptor = winterMcpServerDescriptor({
      brand: WINTER_BRAND,
      branchLabel: "winter-claude-agent",
      ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
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
      address: "session:aliases",
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
        ...(args.toolAliases === undefined ? {} : { toolAliases: { ...(options.toolAliases as Record<string, string>), ...args.toolAliases } }),
        ...(args.disallowedTools === undefined ? {} : { disallowedTools: [...options.disallowedTools as string[], ...args.disallowedTools] }),
      },
    });

    for await (const message of live.query) messages.push(message as { type: string; subtype?: string });
    return { messages, calls, record, configDir: live.configDir, env };
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

  // ==================================================================================================
  // ITEM 15 — WHAT THE VENDOR'S `extra` ACTUALLY CARRIES, MEASURED BEFORE ANYTHING DEPENDS ON IT.
  //
  // The Lane B carry asked Lane A to stop dropping the in-process server's second handler argument so
  // the official branch could derive WS-10 §12's retry key — the (session, tool-call id) pair a retry
  // must allocate the SAME message id from, without which an identical retry is caught only by the
  // rapid-repeat guard. The whole-branch review's §5 was right to make that conditional: `extra` is
  // the MCP REQUEST context (a JSON-RPC request id, `_meta`), and the model's `tool_use_id` is an
  // ANTHROPIC-API concept one layer up. Whether the pinned runtime bridges the two is not something
  // either report could know, so this test asks the runtime.
  //
  // IT ASSERTS WHAT IT OBSERVES AND PRINTS THE REST. The forwarding is worth having regardless; what
  // this pins is the honest state of the retry key on this branch, so the README clause and the SDK
  // carry say the true thing.
  // ==================================================================================================
  test(
    "the handler receives the vendor's `extra`, and its contents decide whether a §12 retry key exists",
    async () => {
      const seen: unknown[] = [];
      const result = await runSession({
        turns: [{ toolUses: [{ id: "toolu_extra_probe", name: "SendMessage", input: { to: "reviewer", message: "ping" } }] }, { text: "done" }],
        handlers: {
          sendMessage: async (raw, extra) => {
            seen.push(extra);
            void raw;
            return { content: [{ type: "text" as const, text: "ok" }] };
          },
        },
      });
      expect(result.messages.some((message) => message.type === "result")).toBe(true);
      // THE HANDLER REALLY RAN, and it really got a second argument.
      expect(seen).toHaveLength(1);
      const extra = seen[0] as Record<string, unknown> | undefined;
      const keys = extra === undefined || extra === null ? [] : Object.keys(extra).sort();
      const flat = JSON.stringify(extra, (_k, value) => (typeof value === "function" ? "[function]" : value));
      console.log(`[item 15] the vendor's \`extra\`, as the pinned runtime passes it — keys: ${JSON.stringify(keys)}\n[item 15] value: ${String(flat).slice(0, 600)}`);
      expect(extra).toBeDefined();

      // THE QUESTION THE CARRY ASKED, answered against the artifact rather than by inference: is the
      // MODEL's tool-use id reachable from here? `toolu_extra_probe` is the id the model emitted.
      const carriesToolUseId = String(flat).includes("toolu_extra_probe");
      console.log(`[item 15] the model's tool_use_id is reachable from \`extra\`: ${carriesToolUseId}`);
      // Recorded as an observation, not asserted in one direction: if a later pin starts carrying it,
      // this line changes and the README clause and the SDK carry change with it.
      expect(typeof carriesToolUseId).toBe("boolean");
    },
    TIMEOUT,
  );

  // ==================================================================================================
  // R4 — WHAT 0.3.250 DOES WITH AN ALIAS KEY THAT IS NOT ONE OF ITS OWN BUILT-INS (`advisor`).
  //
  // THE QUESTION, AND WHY IT IS A MEASUREMENT. R-8-1(3) makes Winter's own advisor BACK Claude's on
  // the official branch, so the standing server now carries an `advisor` tool (`assertNoAdvisor` is
  // retired) and the obvious next step is to widen `ALIASED_BUILTINS` with
  // `{ builtin: "advisor", tool: "advisor" }`. But `SendMessage` and `ListAgents` are names the pinned
  // runtime already knows: aliasing them redirects a lookup that would otherwise have hit a LOCAL
  // built-in. `advisor` is not one of those — `docs/probes/d29-advisor.md` measured it as an
  // API-SIDE server tool (`advisor_20260301`, no input schema, returned as a `server_tool_use` block)
  // that the four traffic opt-outs remove from the session entirely. Whether the runtime's single-hop
  // alias table accepts, ignores or refuses a key it has no built-in for is therefore unknown, and a
  // widening that the pin quietly ignores would be a door the model can never walk through.
  //
  // SO THIS RECORDS, IT DOES NOT ASSERT. The only outcome asserted is that the turn COMPLETED under
  // the four traffic opt-outs and that `docs/probes/advisor-alias.md` states what was observed — the
  // same convention as row 2 and item 15 above, and the same convention `aliases.ts:85-91` names. The
  // doc is read back rather than merely written beside the test, so a change in the runtime's
  // behaviour fails HERE instead of leaving a confident file that is quietly no longer true.
  // ==================================================================================================
  const ADVISOR_PROBE_DOC = resolve(import.meta.dir, "..", "..", "docs", "probes", "advisor-alias.md");
  const CANONICAL_ADVISOR = mcpToolName(WINTER_BRAND, "advisor");
  /**
   * Both names a deny rule must carry for `advisor`, spelled by hand ON PURPOSE.
   *
   * `aliasDenyNames("advisor", brand)` does not type-check today: its parameter is `AliasedBuiltin`,
   * which is derived from `ALIASED_BUILTINS`, which is what this measurement GATES. These are exactly
   * the two names the helper would return after the widening — `[builtin, aliasTargetFor(builtin, …)]`.
   */
  const ADVISOR_DENY_NAMES = ["advisor", CANONICAL_ADVISOR] as const;

  /** The recorded answers, parsed out of the probe document's `measured` block. */
  function recordedFacts(): Record<string, string> {
    const fence = /```measured\n([\s\S]*?)```/.exec(readFileSync(ADVISOR_PROBE_DOC, "utf8"));
    if (fence?.[1] === undefined) throw new Error(`${ADVISOR_PROBE_DOC} carries no \`\`\`measured block: the probe's answers must be recorded there`);
    const facts: Record<string, string> = {};
    for (const line of fence[1].split("\n")) {
      const match = /^([a-z][a-z0-9-]*): (.+)$/.exec(line.trim());
      if (match?.[1] !== undefined && match[2] !== undefined) facts[match[1]] = match[2];
    }
    return facts;
  }

  test(
    "R4: an `advisor` alias against the pin — what is advertised, what a bare `advisor` block resolves to, and what a deny removes",
    async () => {
      const advisorCalls: unknown[] = [];
      const advisor: WinterMcpToolDescriptor = {
        tool: "advisor",
        description: "Winter's own advisor, registered on the standing server (R-8-1(3)).",
        inputSchema: { type: "object", properties: { question: { type: "string", maxLength: 300 } }, required: ["question"] },
        exposure: "eager",
        permissionClass: "advisor",
        handler: async (raw) => {
          advisorCalls.push(raw);
          return { content: [{ type: "text" as const, text: "advice: ship it" }] };
        },
      };
      const aliased = { toolAliases: { advisor: CANONICAL_ADVISOR }, capabilities: [advisor] } as const;

      // (a) + (b): one session, the model emitting the BARE name the alias is keyed by.
      const bare = await runSession({
        ...aliased,
        turns: [{ toolUses: [{ id: "toolu_advisor_bare", name: "advisor", input: { question: "is this ready?" } }] }, { text: "advised" }],
      });
      // FACT (a) IS READ FROM THE RUNTIME'S OWN `system/init.tools`, which is what the question names;
      // the wire's advertised set is recorded beside it because the two need not agree.
      const init = bare.messages.find((message) => message.type === "system" && message.subtype === "init") as { tools?: unknown[] } | undefined;
      const initTools = (init?.tools ?? []).map(String);
      const advertised = advertisedToolNames(bare.record, 0);
      const bareResult = toolResults(bare.record).find((entry) => entry.tool_use_id === "toolu_advisor_bare");

      // THE CONTROL, without which (b) means nothing: the SAME bare block, the SAME registered
      // descriptor, and NO alias entry. If the handler is reached here too, the alias is not what
      // resolved it and widening `ALIASED_BUILTINS` would be cargo cult.
      const controlCalls: unknown[] = [];
      const unaliased = await runSession({
        capabilities: [{ ...advisor, handler: async (raw) => { controlCalls.push(raw); return { content: [{ type: "text" as const, text: "advice: ship it" }] }; } }],
        turns: [{ toolUses: [{ id: "toolu_advisor_control", name: "advisor", input: { question: "no alias?" } }] }, { text: "advised" }],
      });
      const controlResult = toolResults(unaliased.record).find((entry) => entry.tool_use_id === "toolu_advisor_control");

      // (c): the same call, and the canonical one, under the deny rule the helper would produce.
      const deniedBare = await runSession({
        ...aliased,
        disallowedTools: ADVISOR_DENY_NAMES,
        turns: [{ toolUses: [{ id: "toolu_advisor_denied_bare", name: "advisor", input: { question: "blocked?" } }] }, { text: "ok" }],
      });
      const deniedCanonical = await runSession({
        ...aliased,
        disallowedTools: ADVISOR_DENY_NAMES,
        turns: [{ toolUses: [{ id: "toolu_advisor_denied_canonical", name: CANONICAL_ADVISOR, input: { question: "blocked?" } }] }, { text: "ok" }],
      });
      const blocked = (result: RunResult, id: string): boolean => {
        const row = toolResults(result.record).find((entry) => entry.tool_use_id === id);
        return row !== undefined && /denied|not allowed|permission|disabled|blocked/.test(JSON.stringify(row.content).toLowerCase());
      };

      const observed = {
        "init-tools-advertise-canonical-advisor": initTools.includes(CANONICAL_ADVISOR) ? "yes" : "no",
        "init-tools-advertise-bare-advisor": initTools.includes("advisor") ? "yes" : "no",
        "wire-advertises-canonical-advisor": advertised.includes(CANONICAL_ADVISOR) ? "yes" : "no",
        "wire-advertises-bare-advisor": advertised.includes("advisor") ? "yes" : "no",
        "bare-advisor-reaches-the-mcp-handler": advisorCalls.length > 0 ? "yes" : "no",
        "bare-advisor-reaches-the-mcp-handler-without-the-alias": controlCalls.length > 0 ? "yes" : "no",
        "bare-advisor-tool-result-is-error": bareResult?.is_error === true ? "yes" : "no",
        "deny-blocks-the-bare-call": blocked(deniedBare, "toolu_advisor_denied_bare") ? "yes" : "no",
        "deny-blocks-the-canonical-call": blocked(deniedCanonical, "toolu_advisor_denied_canonical") ? "yes" : "no",
      };
      // eslint-disable-next-line no-console
      console.log(`[R4 advisor alias] observed: ${JSON.stringify(observed, null, 2)}`);
      // eslint-disable-next-line no-console
      console.log(`[R4 advisor alias] system/init.tools: ${JSON.stringify(initTools)}`);
      // eslint-disable-next-line no-console
      console.log(`[R4 advisor alias] wire-advertised names: ${JSON.stringify(advertised)}`);
      // eslint-disable-next-line no-console
      console.log(`[R4 advisor alias] the bare call's tool_result: ${JSON.stringify(bareResult)}`);
      // eslint-disable-next-line no-console
      console.log(`[R4 advisor alias] the UNALIASED control's tool_result: ${JSON.stringify(controlResult)}`);

      // WHAT IS ASSERTED, AND IT IS NOT THE ANSWER. The turn completed…
      expect(bare.messages.at(-1)?.type).toBe("result");
      // …the run was the hermetic one (the doc's claim about the pin is about a child that asked no CDN
      // what tools it should have)…
      for (const [name, value] of Object.entries(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, value: bare.env[name] }).toEqual({ name, value });
      expect(new Set(bare.record.paths)).toEqual(new Set(["/api/hello", "/v1/messages"]));
      // …and the document records exactly what was just observed, key for key.
      const recorded = recordedFacts();
      expect(Object.fromEntries(Object.keys(observed).map((key) => [key, recorded[key]]))).toEqual(observed);
      expect(recorded["pin"]).toBe("@anthropic-ai/claude-agent-sdk 0.3.250");
      expect(recorded["measured-on"]).toBe("2026-09-11");
    },
    TIMEOUT * 3,
  );
});
