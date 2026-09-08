// WS-17 ROW 14, against the REAL pinned runtime.
//
// "Native and aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and
// arbitrary file/shell paths CANNOT create project `CLAUDE.md`, `.claude/`, or `~/.claude/plans`
// under the strict policy — covering both ordinary and harness-internal paths."
//
// THE BROKER IN THIS TEST APPROVES EVERYTHING. That is the point: if the proof depended on a broker
// saying no, it would prove the test's own configuration rather than the branch's containment. What
// stands between the model and every vendor-named path here is the floor (§8) plus the settings that
// redirect the writers (§2's `plansDirectory`, the deny list), and nothing else.
//
// AND THE ASSERTION IS ABOUT A DIRECTORY THAT EXISTS. The bed plants a decoy vendor home under the
// throwaway `HOME` with a file in it, so "the vendor home is untouched" is a comparison rather than a
// statement about a path that could never have existed.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { createApprovalBridge, type ApprovalBroker, type OfficialPermissionMode } from "../../src/official/callbacks.ts";
import { cleanupHermetic, decoyUntouched, hermeticSession, officialRuntimeBed, scriptedLoopback, toolResults, treeOf, type HermeticSession, type ScriptedTurn } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 180_000;

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the containment bed",
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

async function runContainment(args: {
  session: HermeticSession;
  turns: readonly ScriptedTurn[];
  mode?: OfficialPermissionMode;
  /** The host broker. Default: approve everything — see this file's header. */
  broker?: ApprovalBroker;
}): Promise<{
  decisions: Array<{ tool: string; behavior: string; source: string }>;
  results: ReturnType<typeof toolResults>;
  /** The session's own `system/init`, for the surfaces §8 contains by NOT exposing them. */
  init: { tools?: string[]; slash_commands?: string[] } | undefined;
}> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const { routes, record } = scriptedLoopback(args.turns);
  const decisions: Array<{ tool: string; behavior: string; source: string }> = [];
  let init: { tools?: string[]; slash_commands?: string[] } | undefined;

  await withLoopbackFake({ routes }, async (fake) => {
    const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
    const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
    const adapter = createOfficialAdapter(context);
    await adapter.ready();

    const templateInput = {
      mode: "code" as const,
      selection,
      cwd: args.session.cwd,
      sessionStore: new PassthroughStore() as unknown as SessionStore,
      autoMemoryDirectory: `${args.session.brandHome}/projects/containment/memory`,
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: bed.executable,
      spawnProxy: adapter.spawnProxy,
      profile: "fresh-spool" as const,
      configDir: args.session.spool,
    };
    const env = adapter.buildChildEnv({
      selection,
      configDir: args.session.spool,
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
      base: { HOME: args.session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const options = adapter.buildOptions(templateInput);
    const live = adapter.launch({
      address: "claude:session:containment",
      selection,
      prompt: "do the thing",
      cwd: args.session.cwd,
      profile: "fresh-spool",
      configDir: args.session.spool,
      options: {
        ...options,
        env,
        ...(args.mode === undefined ? {} : { permissionMode: args.mode }),
        // A BROKER THAT SAYS YES TO EVERYTHING — see this file's header.
        canUseTool: createApprovalBridge({
          brand: WINTER_BRAND,
          mode: args.mode ?? "default",
          broker: args.broker ?? (async (request) => ({ behavior: "allow", updatedInput: request.input })),
          onDecision: ({ request, result, source }) => decisions.push({ tool: request.toolName, behavior: result.behavior, source }),
        }),
      },
    });
    for await (const message of live.query) {
      const typed = message as { type: string; subtype?: string; tools?: string[]; slash_commands?: string[] };
      if (typed.type === "system" && typed.subtype === "init") init = { ...(typed.tools === undefined ? {} : { tools: typed.tools }), ...(typed.slash_commands === undefined ? {} : { slash_commands: typed.slash_commands }) };
    }
  });
  return { decisions, results: toolResults(record), init };
}

/**
 * Every vendor-named target row 14 names, checked against a session's own directories.
 *
 * CASE-FOLDED (review r1, C1). `readdirSync` returns the ON-DISK spelling, so a case-exact detector
 * could not see `.Claude/` or `claude.md` even when the model had just created them — the first
 * version of this file could not see its own hole.
 */
function vendorNamedArtifacts(session: HermeticSession): string[] {
  const found: string[] = [];
  for (const path of treeOf(session.cwd)) {
    const folded = path.normalize("NFC").toLowerCase();
    if (folded.endsWith("/claude.md") || folded.includes("/.claude/") || folded.endsWith("/.claude")) found.push(path);
  }
  if (existsSync(join(session.home, ".claude", "plans"))) found.push(join(session.home, ".claude", "plans"));
  for (const entry of readdirSync(session.decoyVendorHome)) if (entry !== "decoy.json") found.push(join(session.decoyVendorHome, entry));
  return found;
}

describeRuntime("WS-17 row 14 — nothing can create a vendor-named path, against the real pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "arbitrary file and shell paths: an approving broker does not lift the floor",
    async () => {
      const session = hermeticSession("containment-files");
      const { decisions, results } = await runContainment({
        session,
        turns: [
          { toolUses: [{ id: "t1", name: "Write", input: { file_path: join(session.cwd, "CLAUDE.md"), content: "# hijacked\n" } }] },
          { toolUses: [{ id: "t2", name: "Write", input: { file_path: join(session.cwd, ".claude", "settings.json"), content: "{}" } }] },
          { toolUses: [{ id: "t3", name: "Bash", input: { command: `mkdir -p ${join(session.home, ".claude", "plans")} && echo x > ${join(session.home, ".claude", "plans", "p.md")}` } }] },
          { toolUses: [{ id: "t4", name: "Bash", input: { command: `echo "# hijacked" > ${join(session.cwd, "CLAUDE.md")}` } }] },
          // REVIEW r1, C1's OWN PLANTS — every one of these created a real file before the fix, on a
          // case-insensitive volume, through this same approving broker.
          { toolUses: [{ id: "c1", name: "Write", input: { file_path: join(session.cwd, "claude.md"), content: "# folded\n" } }] },
          { toolUses: [{ id: "c2", name: "Write", input: { file_path: join(session.cwd, ".Claude", "settings.json"), content: "{}" } }] },
          { toolUses: [{ id: "c3", name: "Bash", input: { command: "D=.claude; mkdir -p $PWD/$D && echo x > $PWD/$D/leak.txt" } }] },
          // …and the Unicode-normalized spellings of the same two names.
          { toolUses: [{ id: "c4", name: "Write", input: { file_path: join(session.cwd, "CLAUDE.md").normalize("NFD"), content: "# nfd\n" } }] },
          { toolUses: [{ id: "c5", name: "Write", input: { file_path: join(session.cwd, ".claude", "nfd.json").normalize("NFD"), content: "{}" } }] },
          { text: "done" },
        ],
      });

      // EVERY ONE OF THEM WAS REFUSED BY THE FLOOR, and the model was handed OUR OWN sentence — which
      // is what distinguishes containment from a tool that happened to fail. The refusal arrives from
      // the PreToolUse hook rather than the permission callback (the hook runs first, and is the only
      // point every tool passes through), so the count is taken on the tool_results.
      const denied = results.filter((entry) => JSON.stringify(entry.content).toLowerCase().includes("may not create or modify"));
      expect(denied.length).toBeGreaterThanOrEqual(9);
      // The broker said YES to everything and it changed nothing: no Write or Bash was ever allowed.
      expect(decisions.some((decision) => decision.source === "broker" && decision.behavior === "allow" && ["Write", "Bash"].includes(decision.tool))).toBe(false);
      expect(decisions.every((decision) => decision.behavior === "deny" || !["Write", "Bash"].includes(decision.tool))).toBe(true);
      // The case-folded and normalized names are absent BY THEIR OWN SPELLING as well as by the
      // detector — `readdirSync` would have shown them.
      expect(readdirSync(session.cwd).sort()).toEqual([]);
      // And nothing exists.
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "the native writers: every §8 row is EXERCISED, and the tally says which containment stopped it",
    async () => {
      // A REAL GIT REPOSITORY and a REAL WORKFLOW NAME (review r1, M2). Without a repository the
      // worktree writers refuse outright ("Cannot create a worktree: not in a git repository") and
      // without a name the runtime knows, `Workflow` fails resolution — either way the test would be
      // measuring the runtime's own unrelated failure. MEASURED with both in place and the floor
      // removed: `EnterWorktree` CREATED `<cwd>/.claude/worktrees/feature`. That is what these
      // assertions are the negative of.
      const session = hermeticSession("containment-writers", { git: true });
      const { decisions, results, init } = await runContainment({
        session,
        // The broker APPROVES, and additionally asks for a DURABLE rule update — which is how a saved
        // WebFetch approval reaches the vendor's own settings file, and the one §8 writer with no
        // tool call of its own.
        broker: async (request) => ({
          behavior: "allow",
          updatedInput: request.input,
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "localSettings" },
            { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "session" },
          ],
        }),
        turns: [
          { toolUses: [{ id: "cron", name: "CronCreate", input: { durable: true, schedule: "0 * * * *", prompt: "x" } }] },
          { toolUses: [{ id: "worktree", name: "EnterWorktree", input: { name: "feature" } }] },
          { toolUses: [{ id: "workflow", name: "Workflow", input: { name: "deep-research" } }] },
          { toolUses: [{ id: "agent", name: "Task", input: { description: "isolated", prompt: "go", isolation: "worktree", subagent_type: "general-purpose" } }] },
          { toolUses: [{ id: "webfetch", name: "WebFetch", input: { url: "https://example.com/", prompt: "read it" } }] },
          { toolUses: [{ id: "plan", name: "ExitPlanMode", input: { plan: "# the plan" } }] },
          { text: "done" },
        ],
      });

      /** Which containment stopped each writer — the tally the review asked for. */
      const tally: Record<string, string> = {};
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();

      // 1. DURABLE CRON — stopped by the DENY LIST, ahead of every callback: `disallowedTools`
      //    short-circuits before `canUseTool` AND before the hook, which is the two layers genuinely
      //    being two.
      expect(decisions.some((decision) => decision.tool === "CronCreate")).toBe(false);
      expect(resultFor("cron")).toMatch(/no such tool|disabled|not allowed|denied/);
      tally["CronCreate(durable)"] = "deny-list";

      // 2/3/4. THE REDIRECT WRITERS — stopped by the PRE-TOOL-USE HOOK, and the proof is that the
      //        model was handed OUR OWN sentence rather than one of the runtime's. None of them
      //        reaches `canUseTool` at all on this runtime, which is why the hook exists.
      for (const [label, id, fragment] of [
        ["EnterWorktree", "worktree", "worktrees belong under .winter/worktrees"],
        ["Workflow", "workflow", "workflows resolve under .winter/workflows"],
        ["Task(isolation:worktree)", "agent", "isolated agent worktree"],
      ] as const) {
        expect([label, resultFor(id).includes(fragment.toLowerCase())]).toEqual([label, true]);
        tally[label] = "pre-tool-use-hook";
      }
      // …and the vendor's worktree directory, which the same call created before this fix, is absent.
      expect(existsSync(join(session.cwd, ".claude", "worktrees"))).toBe(false);

      // 5. THE SAVED APPROVAL — the durable rule update is STRIPPED at the bridge and the
      //    session-scoped one survives, which is §16 q2's `disable` disposition doing its work.
      const webfetch = decisions.find((decision) => decision.tool === "WebFetch");
      expect([webfetch?.source, webfetch?.behavior]).toEqual(["broker-approval-stripped", "allow"]);
      tally["WebFetch(saved approval)"] = "approval-stripped";

      // 6. PLAN MODE — `plansDirectory` is set through the settings layer and the vendor's own
      //    user-level plans directory is never created. MEASURED AND NAMED: this runtime's SDK path
      //    writes no plan file at all, so this leg is an absence with a recorded reason rather than a
      //    redirect anything can point at.
      expect(existsSync(join(session.home, ".claude", "plans"))).toBe(false);
      tally["ExitPlanMode"] = "plansDirectory(setting); this runtime's SDK path writes no plan file";

      // 7. `/init` — a slash command is user-facing surface, not a tool the model can call: the
      //    containment is that no init-like TOOL is advertised to the model at all.
      expect((init?.tools ?? []).some((tool) => /^init$/i.test(tool))).toBe(false);
      expect((init?.tools ?? []).length).toBeGreaterThan(5);
      tally["/init"] = "host-ui (not a model-callable tool)";

      // Every §8 row has an entry, and nothing vendor-named exists.
      expect(Object.keys(tally).sort()).toEqual(["/init", "CronCreate(durable)", "EnterWorktree", "ExitPlanMode", "Task(isolation:worktree)", "WebFetch(saved approval)", "Workflow"]);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[row 14 containment tally] ${JSON.stringify(tally)}`);
    },
    TIMEOUT,
  );

  test(
    "the whole session's writes stay inside the spool, the cwd and the product home",
    async () => {
      const session = hermeticSession("containment-writes");
      await runContainment({
        session,
        turns: [{ toolUses: [{ id: "t1", name: "Write", input: { file_path: join(session.cwd, "notes.md"), content: "ordinary work\n" } }] }, { text: "done" }],
      });
      // The ordinary write went through (the floor is not a blanket denial), …
      expect(existsSync(join(session.cwd, "notes.md"))).toBe(true);
      // … and the vendor home is still exactly what the bed planted.
      expect(decoyUntouched(session)).toBe(true);
      expect(vendorNamedArtifacts(session)).toEqual([]);
    },
    TIMEOUT,
  );
});
