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
import { aliasDenyNames, officialToolAliases } from "../../src/official/aliases.ts";
import type { MessagingToolPort } from "@yanlinglabs/winter-agent-sdk/tools";
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
  /** Extra tools on the standing server — §11's capability slot. */
  capabilities?: readonly WinterMcpToolDescriptor[];
  /**
   * REPLACES the brand's own alias map, never merges with it (interim review I-2).
   *
   * A merge cannot express the one condition the advisor control needs — an alias map with `advisor`
   * REMOVED — and a control that silently kept the alias it was supposed to be without would have
   * "measured" the alias by running it twice.
   */
  toolAliases?: Readonly<Record<string, string>>;
  /** The advisor's reviewer for this session; absent = none resolvable (WS-06 §4's ordinary error). */
  reviewer?: { provider: { generate: () => Promise<{ kind: string; text?: string }> }; model: string };
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

    // THE PORT IS WHAT THE ROUTER SUPPLIES (ruling P-3) and the handlers are the SDK's (R-8-1), so what
    // these rows measure is the whole production path: the model's block → the pin's alias table → the
    // canonical MCP tool → the SDK's handler → the port. A recording port is the only double.
    const port: MessagingToolPort = {
      sendDetailed: async (request) => {
        calls.push({ tool: "send_message", args: request });
        return { outcome: { status: "delivered", messageId: "m-1" } } as unknown as Awaited<ReturnType<MessagingToolPort["sendDetailed"]>>;
      },
      listReachable: async (scope) => {
        calls.push({ tool: "list_agents", args: scope });
        return [];
      },
      readNotifications: (sessionId) => {
        calls.push({ tool: "read_notifications", args: { sessionId } });
        return { notifications: [], remaining: 0 };
      },
    };
    const descriptor = winterMcpServerDescriptor({
      brand: WINTER_BRAND,
      port,
      caller: { sessionId: "aliases" },
      advisor: {
        transcriptSource: { getEntries: () => [{ role: "user" as const, text: "the session so far" }] },
        ...(args.reviewer === undefined ? {} : { resolveReviewer: () => args.reviewer as never }),
      },
      ...(args.capabilities === undefined ? {} : { capabilities: args.capabilities }),
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
        // REPLACED, NOT MERGED (I-2): `{}` and "the brand's own, minus one key" are both expressible.
        ...(args.toolAliases === undefined ? {} : { toolAliases: args.toolAliases }),
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

      // The PORT was reached — through the ALIAS, from the built-in name the model emitted, and through
      // the SDK's own handler (which is where the acceptor now lives: R-8-1).
      expect(result.calls.map((call) => call.tool)).toEqual(["send_message"]);
      const request = result.calls[0]?.args as { from: { winterSessionId?: string }; to: string; body: string; summary?: string };
      // …with WS-10 §10.1's own fields intact, unrenamed and unwrapped, one layer further in than the
      // model wrote them: `to` is still `to`, the message is the body, the summary survives.
      expect({ to: request.to, body: request.body, summary: request.summary }).toEqual({ to: "reviewer", body: "ping", summary: "a ping" });
      // …and the SENDER is the caller bound at registration, never anything the model wrote.
      expect(request.from.winterSessionId).toBe("aliases");
      // …and the VISIBLE result came back as this tool call's result: the bare delivery outcome (P-4).
      const results = toolResults(result.record);
      expect(results.some((entry) => entry.tool_use_id === "toolu_row1" && JSON.stringify(entry.content).includes("delivered"))).toBe(true);
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
      expect(result.calls.map((call) => call.tool)).toEqual(["list_agents"]);
      // The SDK's handler renders the port's rows; an empty registry is a SENTENCE, not an empty string.
      expect(toolResults(result.record).some((entry) => JSON.stringify(entry.content).includes("listing"))).toBe(true);

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
      expect(direct.calls.map((call) => call.tool)).toEqual(["send_message"]);
      expect((direct.calls[0]?.args as { body: string }).body).toBe("direct");

      // (b) THE MEASUREMENT THIS ROW EXISTS FOR, and it is a finding rather than a confirmation:
      //     denying the BUILT-IN name does NOT stop the aliased call on this runtime. The deny check
      //     runs after alias resolution, so the rule a host would obviously write is a rule that does
      //     nothing — silently, on this branch only.
      const deniedBuiltinOnly = await runSession({
        turns: [{ toolUses: [{ id: "toolu_row3b", name: "SendMessage", input: { to: "reviewer", message: "not blocked" } }] }, { text: "ok" }],
        disallowedTools: ["SendMessage"],
      });
      expect(deniedBuiltinOnly.calls.map((call) => call.tool)).toEqual(["send_message"]);

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
      expect(Object.keys(aliases)).toEqual(["SendMessage", "ListAgents", "ReadNotifications", "advisor"]);
      expect(Object.values(aliases)).toEqual([
        mcpToolName(WINTER_BRAND, "send_message"),
        mcpToolName(WINTER_BRAND, "list_agents"),
        mcpToolName(WINTER_BRAND, "read_notifications"),
        mcpToolName(WINTER_BRAND, "advisor"),
      ]);
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
    "the vendor's `extra` reaches the SDK's handler, and its tool-call id arrives at the port as §12's key",
    async () => {
      const result = await runSession({
        turns: [{ toolUses: [{ id: "toolu_extra_probe", name: "SendMessage", input: { to: "reviewer", message: "ping" } }] }, { text: "done" }],
      });
      expect(result.messages.some((message) => message.type === "result")).toBe(true);
      // THE KEY IS REAL, and it is the model's OWN id. The router forwards `extra` into the SDK
      // handler, the SDK reads the vendor's namespaced `_meta` key, and what arrives at the port is
      // `originToolCallId` — so this branch has WS-10 §12's (session, tool-call) pair rather than
      // depending on the rapid-repeat guard. Measured here against the artifact, not inferred.
      const request = result.calls[0]?.args as { originToolCallId?: string };
      expect(request.originToolCallId).toBe("toolu_extra_probe");
    },
    TIMEOUT,
  );

  // ==================================================================================================
  // R-8-1(3) — THE STANDING ADVISOR IS REACHABLE UNDER CLAUDE'S OWN BARE NAME (was R4's measurement).
  //
  // WHAT THIS USED TO BE. R4 asked whether 0.3.250's `toolAliases` honours a key that is NOT one of its
  // own local built-ins: `SendMessage` and `ListAgents` redirect a lookup that would otherwise hit a
  // built-in, while `advisor` on the pin is an API-SIDE server tool the traffic opt-outs remove
  // entirely (`docs/probes/d29-advisor.md`). The answer decided whether `ALIASED_BUILTINS` could be
  // widened at all, so the test RECORDED rather than asserted, and `docs/probes/advisor-alias.md` is
  // the dated record — kept, because it is the evidence the widening rests on.
  //
  // WHAT IT IS NOW. The gate passed and the widening landed, so the same four sessions assert the
  // CONTRACT they measured (interim review I-2): with the brand's own alias map a bare `advisor` block
  // reaches the standing server's advisor and comes back with the reviewer's answer; with the advisor
  // key REMOVED from the map it is "No such tool available"; `aliasDenyNames("advisor", brand)` — which
  // now type-checks, because the widening is what it was gating — removes both spellings.
  //
  // THE CONTROL IS WHY THE ALIAS MAP IS REPLACED, NOT MERGED. A merged map cannot express "without
  // this key", so a control built by merging would silently carry the alias it exists to be without.
  // ==================================================================================================
  const ADVISOR_PROBE_DOC = resolve(import.meta.dir, "..", "..", "docs", "probes", "advisor-alias.md");
  const CANONICAL_ADVISOR = mcpToolName(WINTER_BRAND, "advisor");
  const REVIEWER = { provider: { generate: async () => ({ kind: "text", text: "ship it" }) }, model: "fake-reviewer" };
  /** The brand's own map with the advisor key taken out — the one condition a merge cannot express. */
  const ALIASES_WITHOUT_ADVISOR = Object.fromEntries(Object.entries(officialToolAliases(WINTER_BRAND)).filter(([key]) => key !== "advisor"));

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

  /**
   * A tool call the deny rule stopped — by the SHAPE the runtime produced, not by a regex on wording.
   *
   * The captured refusal is `is_error: true` with a body naming the RESOLVED canonical tool
   * ("Permission to use `mcp__winter__advisor` has been denied"), which is also the evidence for the
   * rule row 3 measured: the deny check runs AFTER alias resolution, so both spellings are stopped by
   * the canonical half of `aliasDenyNames`. (An UNKNOWN tool is a different shape entirely — the
   * vendor's `<tool_use_error>No such tool available</tool_use_error>` — which is what (b) asserts.)
   */
  function blocked(result: RunResult, id: string): boolean {
    const row = toolResults(result.record).find((entry) => entry.tool_use_id === id);
    return row?.is_error === true && JSON.stringify(row.content).includes(CANONICAL_ADVISOR);
  }

  test(
    "a bare `advisor` reaches the standing advisor through the alias; without the alias it does not; a deny removes both",
    async () => {
      // (a) THE CONTRACT. The brand's own alias map, the standing server's own advisor, a reviewer.
      const bare = await runSession({
        reviewer: REVIEWER,
        turns: [{ toolUses: [{ id: "toolu_advisor_bare", name: "advisor", input: {} }] }, { text: "advised" }],
      });
      const init = bare.messages.find((message) => message.type === "system" && message.subtype === "init") as { tools?: unknown[] } | undefined;
      const initTools = (init?.tools ?? []).map(String);
      const bareResult = toolResults(bare.record).find((entry) => entry.tool_use_id === "toolu_advisor_bare");

      // The canonical name is advertised; the bare one is not (it is an ALIAS, not a tool).
      expect(initTools).toContain(CANONICAL_ADVISOR);
      expect(initTools).not.toContain("advisor");
      // …and the bare block reached the standing advisor, which answered with the reviewer's words.
      expect(bareResult?.is_error).toBeUndefined();
      const payload = JSON.parse(String((bareResult?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "{}")) as { advice?: string; model?: string };
      expect(payload).toEqual({ advice: "ship it", model: "fake-reviewer" });
      expect(bare.messages.at(-1)?.type).toBe("result");

      // (b) THE CONTROL: the same block, the same standing advisor, the alias key REMOVED.
      const unaliased = await runSession({
        reviewer: REVIEWER,
        toolAliases: ALIASES_WITHOUT_ADVISOR,
        turns: [{ toolUses: [{ id: "toolu_advisor_control", name: "advisor", input: {} }] }, { text: "advised" }],
      });
      const control = toolResults(unaliased.record).find((entry) => entry.tool_use_id === "toolu_advisor_control");
      expect(control?.is_error).toBe(true);
      expect(JSON.stringify(control?.content)).toContain("No such tool available");

      // (c) THE DENY, through the helper the widening made type-check.
      const denyNames = aliasDenyNames("advisor", WINTER_BRAND);
      expect(denyNames).toEqual(["advisor", CANONICAL_ADVISOR]);
      const deniedBare = await runSession({
        reviewer: REVIEWER,
        disallowedTools: denyNames,
        turns: [{ toolUses: [{ id: "toolu_advisor_denied_bare", name: "advisor", input: {} }] }, { text: "ok" }],
      });
      const deniedCanonical = await runSession({
        reviewer: REVIEWER,
        disallowedTools: denyNames,
        turns: [{ toolUses: [{ id: "toolu_advisor_denied_canonical", name: CANONICAL_ADVISOR, input: {} }] }, { text: "ok" }],
      });
      expect(blocked(deniedBare, "toolu_advisor_denied_bare")).toBe(true);
      expect(blocked(deniedCanonical, "toolu_advisor_denied_canonical")).toBe(true);

      // THE RUN WAS THE HERMETIC ONE — the document's claims are about a child that asked no CDN what
      // tools it should have.
      for (const [name, value] of Object.entries(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, value: bare.env[name] }).toEqual({ name, value });
      expect(new Set(bare.record.paths)).toEqual(new Set(["/api/hello", "/v1/messages"]));

      // …AND THE RECORD STILL AGREES WITH THE ARTIFACT. `docs/probes/advisor-alias.md` is the dated
      // measurement the widening rests on; if the pin's behaviour ever moves, this fails here rather
      // than leaving a confident file that is no longer true.
      const recorded = recordedFacts();
      const observed = {
        "init-tools-advertise-canonical-advisor": initTools.includes(CANONICAL_ADVISOR) ? "yes" : "no",
        "init-tools-advertise-bare-advisor": initTools.includes("advisor") ? "yes" : "no",
        "bare-advisor-reaches-the-mcp-handler": bareResult !== undefined && bareResult.is_error !== true ? "yes" : "no",
        "bare-advisor-reaches-the-mcp-handler-without-the-alias": control?.is_error === true ? "no" : "yes",
        "deny-blocks-the-bare-call": blocked(deniedBare, "toolu_advisor_denied_bare") ? "yes" : "no",
        "deny-blocks-the-canonical-call": blocked(deniedCanonical, "toolu_advisor_denied_canonical") ? "yes" : "no",
      };
      expect(Object.fromEntries(Object.keys(observed).map((key) => [key, recorded[key]]))).toEqual(observed);
      expect(recorded["pin"]).toBe("@anthropic-ai/claude-agent-sdk 0.3.250");
      expect(recorded["measured-on"]).toBe("2026-09-11");
    },
    TIMEOUT * 3,
  );
});
