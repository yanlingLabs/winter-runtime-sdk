// WS-14 §7/§8/§10: the alias map and the two things that are NOT the alias — the deny floor and the
// permission bridge.
//
// The real-runtime halves of these rows (a model-emitted `SendMessage` arriving at the canonical
// handler with native args; nothing creating a vendor-named path across a whole session) live in
// `runtime-aliases.test.ts` and `runtime-containment.test.ts`. What is proven HERE is the part a live
// session cannot show: that the argument acceptor is exact in both directions, that the floor is a
// path rule rather than a tool-name rule, and that `dontAsk` never reaches the broker.
import { describe, expect, test } from "bun:test";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";

import {
  ALIASED_BUILTINS,
  CANONICAL_DUPLICATE_EXPOSURE,
  NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  NATIVE_SEND_MESSAGE_SCHEMA,
  acceptNativeListAgentsArgs,
  acceptNativeSendMessageArgs,
  aliasTargetFor,
  officialToolAliases,
} from "../../src/official/aliases.ts";
import { containmentDecisionFor, containmentDispositions, containmentPaths, officialDisallowedTools, resolveSavedApprovalDisposition, targetsForbiddenPath } from "../../src/official/containment.ts";
import { APPROVAL_BRIDGE_MARK, carriesMark, createApprovalBridge, createFirstResponseWins, isOurApprovalBridge, revalidateResumedDecision, type ApprovalRequest } from "../../src/official/callbacks.ts";

const brand = WINTER_BRAND;

describe("WS-14 §7 — the alias map", () => {
  test("both built-ins point at the BRAND's own canonical tools", () => {
    expect(officialToolAliases(brand)).toEqual({
      SendMessage: mcpToolName(brand, "send_message"),
      ListAgents: mcpToolName(brand, "list_agents"),
    });
    expect(officialToolAliases({ mcpServerName: "acme" })).toEqual({
      SendMessage: "mcp__acme__send_message",
      ListAgents: "mcp__acme__list_agents",
    });
    expect(aliasTargetFor("SendMessage", { mcpServerName: "acme" })).toBe("mcp__acme__send_message");
    expect(ALIASED_BUILTINS.map((entry) => entry.builtin)).toEqual(["SendMessage", "ListAgents"]);
  });

  test("the canonical duplicates are DEFERRED rather than hidden — they stay addressable by name", () => {
    expect(CANONICAL_DUPLICATE_EXPOSURE).toBe("deferred");
  });

  describe("the native argument schemas are accepted EXACTLY", () => {
    test("SendMessage: every WS-10 §10.1 constraint, and no extra field", () => {
      expect(acceptNativeSendMessageArgs({ to: "reviewer", message: "ping" })).toEqual({ ok: true, args: { to: "reviewer", message: "ping" } });
      expect(acceptNativeSendMessageArgs({ to: "r", message: "m", summary: "s", notify_when_idle: true })).toEqual({
        ok: true,
        args: { to: "r", message: "m", summary: "s", notify_when_idle: true },
      });
      // "no more" is as load-bearing as "no less": an extra field would be a second schema.
      expect(acceptNativeSendMessageArgs({ to: "r", message: "m", priority: "high" })).toEqual({ ok: false, reason: "unknown argument(s): priority" });
      expect(acceptNativeSendMessageArgs({ message: "m" }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs({ to: "r" }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs({ to: "*", message: "m" })).toEqual({ ok: false, reason: "broadcast is not addressable: `to` must name one recipient" });
      expect(acceptNativeSendMessageArgs({ to: "a\nb", message: "m" }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs({ to: "x".repeat(301), message: "m" }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs({ to: "r", message: "m", summary: "s".repeat(201) }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs({ to: "r", message: "m", notify_when_idle: "yes" }).ok).toBe(false);
      expect(acceptNativeSendMessageArgs("nope").ok).toBe(false);
      // An empty message is legal — WS-10 §10.1: `""` is the pure idle subscription.
      expect(acceptNativeSendMessageArgs({ to: "r", message: "", notify_when_idle: true }).ok).toBe(true);
    });

    test("ListAgents: two reserved optional fields, nothing else, and its output shape is pinned", () => {
      expect(acceptNativeListAgentsArgs({})).toEqual({ ok: true, args: {} });
      expect(acceptNativeListAgentsArgs(undefined)).toEqual({ ok: true, args: {} });
      expect(acceptNativeListAgentsArgs({ channel: "c", q: "q" })).toEqual({ ok: true, args: { channel: "c", q: "q" } });
      expect(acceptNativeListAgentsArgs({ limit: 5 }).ok).toBe(false);
      expect(acceptNativeListAgentsArgs({ q: "x".repeat(257) }).ok).toBe(false);
      expect(NATIVE_LIST_AGENTS_OUTPUT_SCHEMA.required).toEqual(["listing"]);
    });

    test("the mirrored schema keeps WS-10 §10.1's own constraints where a reader will look for them", () => {
      expect(NATIVE_SEND_MESSAGE_SCHEMA.required).toEqual(["to", "message"]);
      expect(NATIVE_SEND_MESSAGE_SCHEMA.properties.to.maxLength).toBe(300);
      expect(NATIVE_SEND_MESSAGE_SCHEMA.properties.summary.maxLength).toBe(200);
    });
  });
});

describe("WS-14 §8 — builtin-path containment", () => {
  test("the dispositions redirect into the BRAND's own project directory", () => {
    expect(containmentPaths({ projectDirName: ".acme" })).toEqual({
      worktrees: ".acme/worktrees",
      workflows: ".acme/workflows",
      plans: ".acme/plans",
      localSettings: ".acme/settings.local.json",
    });
    const rows = containmentDispositions(brand);
    expect(rows.map((row) => row.disposition)).toEqual(["redirect", "disable", "redirect", "disable", "owned-by-product", "deny"]);
    // review r1, M2: what the row SAYS and what this package DOES are two fields, because they were
    // two different things — three rows said "redirect" while nothing redirected.
    expect(rows.map((row) => row.enforcement)).toEqual(["floor-deny", "deny-list", "floor-deny", "approval-stripped", "host-ui", "floor-deny"]);
    expect(containmentDispositions(brand, { worktrees: "host-replacement", workflows: "host-replacement" }).map((row) => row.enforcement)).toEqual([
      "host-implementation",
      "deny-list",
      "host-implementation",
      "approval-stripped",
      "host-ui",
      "floor-deny",
    ]);
    // §16 q2 is FIXED as `disable`, and `redirect` is REFUSED rather than silently downgraded (review
    // r3, NEW-11): measured, it makes the RUNTIME write its own project settings file, which §8 denies
    // "either way". The disposition table still renders the row a host asked about; the resolver is
    // what a session goes through.
    expect(containmentDispositions(brand, { savedWebFetchApprovals: "redirect" })[3]).toMatchObject({ disposition: "redirect", target: ".winter/settings.local.json" });
    expect(() => resolveSavedApprovalDisposition({ savedWebFetchApprovals: "redirect" }, "winter-claude-agent")).toThrow(/cannot be honoured on this branch/);
    expect(resolveSavedApprovalDisposition({}, "winter-claude-agent")).toBe("disable");
    expect(() => createApprovalBridge({ brand, mode: "default", containment: { savedWebFetchApprovals: "redirect" }, broker: async () => ({ behavior: "allow" }) })).toThrow(/cannot be honoured/);
    expect(officialDisallowedTools()).toEqual(["CronCreate"]);
  });

  test("the forbidden-target predicate matches SEGMENTS, never substrings", () => {
    expect(targetsForbiddenPath("/w/CLAUDE.md")).toEqual({ forbidden: true, target: "CLAUDE.md" });
    expect(targetsForbiddenPath("/w/.claude/settings.json")).toEqual({ forbidden: true, target: ".claude" });
    expect(targetsForbiddenPath("/Users/u/.claude/plans/p.md")).toEqual({ forbidden: true, target: ".claude/plans" });
    for (const near of ["/w/MY_CLAUDE.mdx", "/w/CLAUDE.md.bak", "/w/.claude-backup/x", "/w/claude/x"]) {
      expect([near, targetsForbiddenPath(near).forbidden]).toEqual([near, false]);
    }
  });

  test("…and every comparison is CASE-FOLDED and Unicode-normalized (review r1, C1)", () => {
    // Every one of these was ALLOWED before the fix, and the first two were measured creating real
    // files through the real runtime on a case-insensitive volume — with `existsSync("CLAUDE.md")`
    // and `existsSync(".claude")`, row 14's own predicates, both true afterwards.
    for (const folded of [
      "/w/claude.md",
      "/w/Claude.MD",
      "/w/notes/claude.md",
      "/w/.Claude/settings.json",
      "/w/.CLAUDE/settings.json",
      "/Users/u/.Claude/plans/p.md",
      // review r2, NEW-6: the NFD plants were VACUOUS — `"CLAUDE.md".normalize("NFD") === "CLAUDE.md"`,
      // because both names are pure ASCII. The constructible case is a COMPATIBILITY form, which NFC
      // does not fold and NFKC does; the fold uses NFKC for that reason.
      "/w/ＣＬＡＵＤＥ.md",
      "/w/.ｃｌａｕｄｅ/settings.json",
    ]) {
      expect([folded, targetsForbiddenPath(folded).forbidden]).toEqual([folded, true]);
    }
    // The near misses stay near misses in every casing.
    for (const near of ["/w/my_claude.mdx", "/w/claude.md.bak", "/w/.Claude-backup/x", "/w/Claude/x"]) {
      expect([near, targetsForbiddenPath(near).forbidden]).toEqual([near, false]);
    }
  });

  test("the floor is a PATH rule, so it covers tools no disposition anticipated", () => {
    expect(containmentDecisionFor("Write", { file_path: "/w/CLAUDE.md", content: "x" }).allow).toBe(false);
    expect(containmentDecisionFor("NotebookEdit", { notebook_path: "/w/.claude/x.ipynb" }).allow).toBe(false);
    expect(containmentDecisionFor("SomeToolInventedTomorrow", { path: "/w/.claude/anything" }).allow).toBe(false);
    expect(containmentDecisionFor("Bash", { command: "mkdir -p ~/.claude/plans" }).allow).toBe(false);
    expect(containmentDecisionFor("Bash", { command: "echo hi > CLAUDE.md" }).allow).toBe(false);
    expect(containmentDecisionFor("CronCreate", { durable: true, schedule: "* * * * *" }).allow).toBe(false);
    // review r1, m4: a camelCase path field, and a truthy-but-not-`true` durable flag.
    expect(containmentDecisionFor("Write", { filePath: "/w/CLAUDE.md" }).allow).toBe(false);
    expect(containmentDecisionFor("Write", { file: "/w/.claude/x" }).allow).toBe(false);
    expect(containmentDecisionFor("CronCreate", { durable: "true" }).allow).toBe(false);
    expect(containmentDecisionFor("CronCreate", { durable: 1 }).allow).toBe(false);
    // review r1, C1/m5: the shell-variable form that was measured writing a real file, and the case
    // variants — all in the COMMAND scan rather than the path fields.
    expect(containmentDecisionFor("Bash", { command: "D=.claude; mkdir -p $PWD/$D && echo x > $PWD/$D/leak.txt" }).allow).toBe(false);
    expect(containmentDecisionFor("Bash", { command: "F=CLAUDE.md; printf x > $F" }).allow).toBe(false);
    expect(containmentDecisionFor("Bash", { command: "mkdir .Claude" }).allow).toBe(false);
    expect(containmentDecisionFor("Bash", { command: "touch claude.md" }).allow).toBe(false);
    // …and the §8 writers with no path argument at all (review r1, M2).
    expect(containmentDecisionFor("EnterWorktree", { name: "feature" }).allow).toBe(false);
    expect(containmentDecisionFor("Task", { isolation: "worktree", prompt: "x" }).allow).toBe(false);
    expect(containmentDecisionFor("Workflow", { name: "release" }).allow).toBe(false);
    // A host that HAS installed the schema-compatible replacements says so, and the floor steps back.
    expect(containmentDecisionFor("EnterWorktree", { name: "f" }, { worktrees: "host-replacement" }).allow).toBe(true);
    expect(containmentDecisionFor("Workflow", { name: "r" }, { workflows: "host-replacement" }).allow).toBe(true);
    // …and it does not deny the ordinary work of the session
    expect(containmentDecisionFor("Write", { file_path: "/w/.winter/plans/p.md", content: "x" }).allow).toBe(true);
    expect(containmentDecisionFor("Bash", { command: "ls -la" }).allow).toBe(true);
    expect(containmentDecisionFor("Bash", { command: "git status && echo claudette" }).allow).toBe(true);
    expect(containmentDecisionFor("CronCreate", { durable: false }).allow).toBe(true);
    expect(containmentDecisionFor("Task", { prompt: "an ordinary subagent" }).allow).toBe(true);
  });
});

describe("WS-14 §10 — callback bridging", () => {
  const options = (over: Partial<Omit<ApprovalRequest, "toolName" | "input">> = {}): Omit<ApprovalRequest, "toolName" | "input"> => ({
    signal: new AbortController().signal,
    requestId: "req-1",
    toolUseID: "toolu-1",
    ...over,
  });

  test("the broker's typed result is carried back verbatim, and `null` is unspellable at this seam", async () => {
    const seen: ApprovalRequest[] = [];
    const bridge = createApprovalBridge({
      brand,
      mode: "default",
      broker: async (request) => {
        seen.push(request);
        return { behavior: "allow", updatedInput: { ...request.input, redacted: true }, updatedPermissions: [], toolUseID: request.toolUseID };
      },
    });
    const result = await bridge("Read", { file_path: "/w/x.ts" }, options({ agentID: "agent-9", suggestions: [], decisionReason: "ask rule" }));
    expect(result).toEqual({ behavior: "allow", updatedInput: { file_path: "/w/x.ts", redacted: true }, updatedPermissions: [], toolUseID: "toolu-1" });
    // §10: requestId, toolUseID, agentID and the suggestions all reach the broker.
    expect(seen[0]).toMatchObject({ requestId: "req-1", toolUseID: "toolu-1", agentID: "agent-9", toolName: "Read", decisionReason: "ask rule" });
  });

  test("`dontAsk` NEVER invokes the callback", async () => {
    let called = 0;
    const bridge = createApprovalBridge({
      brand,
      mode: "dontAsk",
      broker: async () => {
        called += 1;
        return { behavior: "deny", message: "should never run" };
      },
    });
    const result = await bridge("Read", { file_path: "/w/x.ts" }, options());
    expect(called).toBe(0);
    expect(result).toEqual({ behavior: "allow", updatedInput: { file_path: "/w/x.ts" }, toolUseID: "toolu-1" });
  });

  test("the containment floor runs BEFORE the broker — and `dontAsk` does not lift it", async () => {
    let called = 0;
    const sources: string[] = [];
    const make = (mode: "default" | "dontAsk" | "bypassPermissions") =>
      createApprovalBridge({
        brand,
        mode,
        onDecision: ({ source }) => sources.push(source),
        broker: async () => {
          called += 1;
          return { behavior: "allow" };
        },
      });
    for (const mode of ["default", "dontAsk", "bypassPermissions"] as const) {
      const result = await make(mode)("Write", { file_path: "/w/.claude/settings.json" }, options());
      expect([mode, result.behavior]).toEqual([mode, "deny"]);
    }
    expect(called).toBe(0);
    expect(sources).toEqual(["containment-floor", "containment-floor", "containment-floor"]);
  });

  test("review r3, NEW-11: a COUNTERFEIT-marked bridge is wrapped, not trusted", async () => {
    // The mark is an exported `Symbol.for` key, so anyone can stamp it — and a stamped always-allow
    // callback was measured being taken verbatim, skipping the saved-approval strip. Identity is the
    // question the adapter asks now.
    const counterfeit = (async () => ({ behavior: "allow" as const })) as unknown as Record<symbol, unknown>;
    counterfeit[APPROVAL_BRIDGE_MARK] = true;
    expect(carriesMark(counterfeit, APPROVAL_BRIDGE_MARK)).toBe(true);
    expect(isOurApprovalBridge(counterfeit)).toBe(false);
    const genuine = createApprovalBridge({ brand, mode: "default", broker: async () => ({ behavior: "allow" }) });
    expect(isOurApprovalBridge(genuine)).toBe(true);
  });

  test("a resumed decision revalidates all FIVE facts, and first response wins", () => {
    const decision = {
      requestId: "req-1",
      toolUseID: "toolu-1",
      sessionId: "s1",
      policyVersion: "v3",
      normalizedPaths: ["/w/a.ts", "/w/b.ts"],
      runtimeOwner: "claude-agent",
    };
    const live = { ...decision } as const;
    expect(revalidateResumedDecision(decision, live)).toEqual({ valid: true });
    // order-insensitive on paths, and identity-sensitive on everything else
    expect(revalidateResumedDecision(decision, { ...live, normalizedPaths: ["/w/b.ts", "/w/a.ts"] })).toEqual({ valid: true });
    expect(revalidateResumedDecision(decision, { ...live, sessionId: "s2" }).valid).toBe(false);
    expect(revalidateResumedDecision(decision, { ...live, toolUseID: "toolu-2" }).valid).toBe(false);
    expect(revalidateResumedDecision(decision, { ...live, policyVersion: "v4" }).valid).toBe(false);
    expect(revalidateResumedDecision(decision, { ...live, runtimeOwner: "winter-agent" }).valid).toBe(false);
    expect(revalidateResumedDecision(decision, { ...live, normalizedPaths: ["/w/a.ts"] }).valid).toBe(false);

    const latch = createFirstResponseWins();
    expect(latch.claim("req-1")).toBe(true);
    expect(latch.claim("req-1")).toBe(false);
    expect(latch.claim("req-2")).toBe(true);
    expect(latch.claimed()).toEqual(["req-1", "req-2"]);
  });
});
