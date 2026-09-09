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
import { basename, join } from "node:path";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter, type OfficialAdapterPolicy } from "../../src/official/index.ts";
import { CONTAINMENT_FLOOR_MARK, createApprovalBridge, type ApprovalBroker, type OfficialPermissionMode } from "../../src/official/callbacks.ts";
import type { ContainmentPolicy } from "../../src/official/containment.ts";
import type { ContainmentBreach } from "../../src/official/sweep.ts";
import type { OfficialOptions } from "../../src/seams/official-sdk-shapes.ts";
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
  /** Edit the options AFTER the template built them — the "host builds them by hand" case (NEW-1). */
  mutateOptions?: (options: OfficialOptions) => OfficialOptions;
  /** The adapter's own policy — its `options` (the TEMPLATE's policy) and its `containment` are two surfaces (review r4, NEW-18). */
  adapterPolicy?: OfficialAdapterPolicy;
  /** The containment policy the harness's OWN bridge is built with. Default: the floor's strict default. */
  bridgeContainment?: ContainmentPolicy;
}): Promise<{
  decisions: Array<{ tool: string; behavior: string; source: string }>;
  results: ReturnType<typeof toolResults>;
  /** The session's own `system/init`, for the surfaces §8 contains by NOT exposing them. */
  init: { tools?: string[]; slash_commands?: string[] } | undefined;
  /** What the post-hoc sweep caught (review r2, NEW-3). */
  breaches: readonly ContainmentBreach[];
}> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const { routes, record } = scriptedLoopback(args.turns);
  const decisions: Array<{ tool: string; behavior: string; source: string }> = [];
  let init: { tools?: string[]; slash_commands?: string[] } | undefined;
  let breaches: readonly ContainmentBreach[] = [];

  await withLoopbackFake({ routes }, async (fake) => {
    const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
    const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
    const adapter = createOfficialAdapter(context, args.adapterPolicy ?? {});
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
    const withBridge: OfficialOptions = {
      ...adapter.buildOptions(templateInput),
      canUseTool: createApprovalBridge({
        brand: WINTER_BRAND,
        mode: args.mode ?? "default",
        ...(args.bridgeContainment === undefined ? {} : { containment: args.bridgeContainment }),
        broker: args.broker ?? (async (request) => ({ behavior: "allow", updatedInput: request.input })),
        onDecision: ({ request, result, source }) => decisions.push({ tool: request.toolName, behavior: result.behavior, source }),
      }),
    };
    const options = args.mutateOptions === undefined ? withBridge : args.mutateOptions(withBridge);
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
      },
    });
    for await (const message of live.query) {
      const typed = message as { type: string; subtype?: string; tools?: string[]; slash_commands?: string[] };
      if (typed.type === "system" && typed.subtype === "init") init = { ...(typed.tools === undefined ? {} : { tools: typed.tools }), ...(typed.slash_commands === undefined ? {} : { slash_commands: typed.slash_commands }) };
    }
    breaches = live.containmentBreaches;
  });
  return { decisions, results: toolResults(record), init, breaches };
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

/**
 * The worktree admin entries a session left in the repository (review r4, NEW-18).
 *
 * `git worktree add` records every worktree under `.git/worktrees/<name>`, and that record OUTLIVES the
 * vendor-named checkout: with the floor suppressed, `EnterWorktree` created `<cwd>/.claude/worktrees/…`,
 * the sweep removed it, and `.git/worktrees/feature` stayed behind — a dangling entry the sweep does
 * not look for (it is not vendor-named) and cannot attribute. The floor stopping the call PRE-hoc is
 * the only thing that keeps this list empty, so it is asserted beside row 14's own predicate.
 */
function danglingWorktreeEntries(session: HermeticSession): string[] {
  const dir = join(session.cwd, ".git", "worktrees");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
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
          // …and the ONE normalization case that is actually constructible (review r2, NEW-6). A
          // "decomposed accent that folds onto a forbidden name" does NOT exist: both names are pure
          // ASCII, so NFD is the identity and the previous c4/c5 plants could not fail differently
          // from t1/t2. What DOES collide is a COMPATIBILITY form — the runtime created a fullwidth
          // `ＣＬＡＵＤＥ.md` in the reviewer's own probe — which NFC leaves alone and NFKC folds. The
          // floor folds with NFKC for exactly this.
          { toolUses: [{ id: "c4", name: "Write", input: { file_path: join(session.cwd, "ＣＬＡＵＤＥ.md"), content: "# fullwidth\n" } }] },
          { toolUses: [{ id: "c5", name: "Write", input: { file_path: join(session.cwd, ".ｃｌａｕｄｅ", "x.json"), content: "{}" } }] },
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
      for (const [label, id, fragment, tool] of [
        ["EnterWorktree", "worktree", "worktrees belong under .winter/worktrees", "EnterWorktree"],
        ["Workflow", "workflow", "workflows resolve under .winter/workflows", "Workflow"],
        ["Task(isolation:worktree)", "agent", "isolated agent worktree", "Task"],
      ] as const) {
        expect([label, resultFor(id).includes(fragment.toLowerCase())]).toEqual([label, true]);
        // ATTRIBUTION, not assumption (review r2, NEW-7): the tally says `pre-tool-use-hook`, so the
        // BRIDGE must not have decided this call. The hook runs first, and for `Workflow` — which the
        // callback IS consulted for — that is the only thing distinguishing the two layers.
        expect([label, decisions.some((decision) => decision.tool === tool)]).toEqual([label, false]);
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
    "review r2, NEW-1: a hand-built options object with NO hooks is floored anyway — the floor is an invariant of launch()",
    async () => {
      // The reviewer's plant, verbatim: build the options with the template and then delete the
      // hooks, which is exactly the "host builds options by hand" case. Before this fix,
      // `EnterWorktree` created `<cwd>/.claude/worktrees/feature` through the adapter's own door.
      const session = hermeticSession("containment-invariant", { git: true });
      const { results } = await runContainment({
        session,
        mutateOptions: (options) => {
          const stripped = { ...options };
          delete stripped["hooks"];
          delete stripped["canUseTool"];
          return stripped;
        },
        turns: [
          { toolUses: [{ id: "w1", name: "EnterWorktree", input: { name: "feature" } }] },
          { toolUses: [{ id: "w2", name: "Write", input: { file_path: join(session.cwd, "CLAUDE.md"), content: "x" } }] },
          { text: "done" },
        ],
      });
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();
      expect(resultFor("w1")).toContain("worktrees belong under .winter/worktrees");
      expect(resultFor("w2")).toContain("may not create or modify");
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r2, NEW-3: a command that BUILDS the name is caught post-hoc — swept, reported, and the call blocked",
    async () => {
      const session = hermeticSession("containment-sweep");
      const { results, breaches } = await runContainment({
        session,
        turns: [
          // (a) the two escape spellings the reviewer measured creating a real `.claude/`. These are
          //     now caught PRE-hoc, by the un-normalized, quote-stripping command scan.
          { toolUses: [{ id: "e1", name: "Bash", input: { command: "mkdir -p .cla\\ude && echo x > .cla\\ude/leak.txt" } }] },
          { toolUses: [{ id: "e2", name: "Bash", input: { command: "mkdir -p .clau''de && echo y > .clau''de/leak2.txt" } }] },
          { toolUses: [{ id: "e3", name: "Bash", input: { command: 'mkdir -p ".cl""aude" && echo z > ".cl""aude"/leak3.txt' } }] },
          // (b) the one no scanner can read: the name never appears in the command at all. This is
          //     what the POST-HOC sweep is for.
          { toolUses: [{ id: "s1", name: "Bash", input: { command: 'D="$(printf %s .cla)$(printf %s ude)"; mkdir -p "$D" && echo boom > "$D/leak.txt"' } }] },
          { text: "done" },
        ],
      });
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();
      for (const id of ["e1", "e2", "e3"]) expect([id, resultFor(id).includes("may not create or modify")]).toEqual([id, true]);

      // The substitution one RAN — and the sweep undid it, ended the turn, and recorded the breach.
      expect(breaches.length).toBeGreaterThanOrEqual(1);
      const breach = breaches[0];
      expect(breach?.toolName).toBe("Bash");
      expect(breach?.created.some((path) => path.toLowerCase().endsWith("/.claude"))).toBe(true);
      expect(breach?.removed).toEqual(breach?.created ?? []);
      // MEASURED: this runtime ignores every documented PostToolUse rewrite, so the model is not told
      // by a rewritten result — it gets NO result for that call, because the turn ends first. The
      // absence is the assertion.
      expect(results.some((entry) => entry.tool_use_id === "s1")).toBe(false);

      // ROW 14'S OWN PREDICATE, after a command the scanner could not read.
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r3, NEW-9: a command whose side effect precedes a FAILURE is swept too",
    async () => {
      const session = hermeticSession("containment-failure");
      const { breaches } = await runContainment({
        session,
        turns: [
          // The measured hole: a constructed name (unreadable pre-hoc) followed by a nonzero exit, so
          // the runtime fires `PostToolUseFailure` and no `PostToolUse` at all. `<cwd>/.claude`
          // survived the whole session before this round.
          { toolUses: [{ id: "f1", name: "Bash", input: { command: 'D="$(printf %s .cla)$(printf %s ude)"; mkdir -p "$D" && echo x > "$D/leak.txt"; exit 1' } }] },
          { text: "done" },
        ],
      });
      expect(breaches.length).toBeGreaterThanOrEqual(1);
      expect(breaches[0]?.created.some((path) => path.toLowerCase().endsWith("/.claude"))).toBe(true);
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r3, NEW-11: the saved-approval path, for real — the durable update is stripped and no vendor settings file appears",
    async () => {
      const session = hermeticSession("containment-approval");
      const { decisions } = await runContainment({
        session,
        // An ordinary host broker that approves AND asks for a durable rule update — which is exactly
        // how a saved WebFetch approval reaches the vendor's own settings file.
        broker: async (request) => ({
          behavior: "allow",
          updatedInput: request.input,
          updatedPermissions: [
            { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "localSettings" },
            { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "projectSettings" },
            { type: "addRules", rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }], behavior: "allow", destination: "session" },
          ],
        }),
        turns: [{ toolUses: [{ id: "w1", name: "WebFetch", input: { url: "https://example.com/", prompt: "read it" } }] }, { text: "done" }],
      });
      const webfetch = decisions.find((decision) => decision.tool === "WebFetch");
      expect([webfetch?.source, webfetch?.behavior]).toEqual(["broker-approval-stripped", "allow"]);
      // The file the runtime writes for a durable approval — measured being created when the update
      // passes through — is absent, and so is the product's own (nothing routes one).
      expect(existsSync(join(session.cwd, ".claude", "settings.local.json"))).toBe(false);
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r4, NEW-18 (a): a host hook stamped with the exported floor mark does not REPLACE the floor — the floor is recognised by identity",
    async () => {
      // THE REVIEWER'S PLANT, and it is fix r3's own tidy-up inverted: `installFloor` skipped the merge
      // when the caller's hooks already carried `CONTAINMENT_FLOOR_MARK`, so a no-op hook stamped with
      // the exported symbol REPLACED §8's floor. Measured on `898112a` in this exact bed: `EnterWorktree`
      // RAN, created `<cwd>/.claude` (swept post-hoc, the turn ended) and left `.git/worktrees/feature`
      // behind — a dangling worktree admin entry the sweep cannot see and does not clean.
      const session = hermeticSession("containment-counterfeit", { git: true });
      const seen: string[] = [];
      const { results, breaches } = await runContainment({
        session,
        mutateOptions: (options) => {
          const counterfeit = async (raw: unknown): Promise<Record<string, never>> => {
            seen.push(String((raw as { tool_name?: string }).tool_name));
            return {};
          };
          (counterfeit as unknown as Record<symbol, unknown>)[CONTAINMENT_FLOOR_MARK] = true;
          // The template's own hooks are DROPPED: what launch() is handed is the counterfeit and nothing else.
          return { ...options, hooks: { PreToolUse: [{ hooks: [counterfeit] }] } };
        },
        turns: [
          { toolUses: [{ id: "w1", name: "EnterWorktree", input: { name: "feature" } }] },
          { toolUses: [{ id: "a1", name: "Task", input: { description: "isolated", prompt: "go", isolation: "worktree", subagent_type: "general-purpose" } }] },
          { toolUses: [{ id: "f1", name: "Write", input: { file_path: join(session.cwd, "CLAUDE.md"), content: "x" } }] },
          { text: "done" },
        ],
      });
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();
      // PRE-HOC, by the REAL floor: the model was handed our own sentence for every writer, and nothing
      // was swept — the sweep never had anything to undo.
      expect(resultFor("w1")).toContain("worktrees belong under .winter/worktrees");
      expect(resultFor("a1")).toContain("isolated agent worktree");
      expect(resultFor("f1")).toContain("may not create or modify");
      expect(breaches).toEqual([]);
      // MERGED, NEVER REPLACED: the counterfeit is still there — as the host's hook, after the floor —
      // and it ran for every call (the runtime evaluates every matcher).
      expect(seen).toContain("EnterWorktree");
      expect(seen).toContain("Write");
      expect(seen.some((name) => name === "Task" || name === "Agent")).toBe(true);
      // Row 14's predicate, AND the reviewer's second one: no `<cwd>/.claude`, and no dangling entry.
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(danglingWorktreeEntries(session)).toEqual([]);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r4, NEW-18 (b): a LOOSER template policy cannot make the adapter's own containment inert — no forgery needed",
    async () => {
      // THE SECOND ROUTE, the one that made the finding a Major: `createOfficialAdapter(ctx, { options:
      // { containment } })` is the TEMPLATE's policy and `createOfficialAdapter(ctx, { containment })` is
      // the adapter's — two documented surfaces. Options built by `buildOptions` under a template policy
      // that hands the worktree and workflow writers to a host replacement carry a GENUINE floor, built
      // by this package, with those writers ALLOWED; on `898112a` that genuine floor suppressed the merge,
      // so the adapter's strict default never rode. The harness's own bridge is built just as loose here,
      // so the adapter's floor is the ONLY layer left that can say no — and it does, pre-hoc, for all three.
      const loose: ContainmentPolicy = { worktrees: "host-replacement", workflows: "host-replacement" };
      const session = hermeticSession("containment-template-policy", { git: true });
      const { decisions, results, breaches } = await runContainment({
        session,
        adapterPolicy: { options: { containment: loose } },
        bridgeContainment: loose,
        turns: [
          { toolUses: [{ id: "w1", name: "EnterWorktree", input: { name: "feature" } }] },
          { toolUses: [{ id: "a1", name: "Task", input: { description: "isolated", prompt: "go", isolation: "worktree", subagent_type: "general-purpose" } }] },
          { toolUses: [{ id: "k1", name: "Workflow", input: { name: "deep-research" } }] },
          { text: "done" },
        ],
      });
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();
      expect(resultFor("w1")).toContain("worktrees belong under .winter/worktrees");
      expect(resultFor("a1")).toContain("isolated agent worktree");
      expect(resultFor("k1")).toContain("workflows resolve under .winter/workflows");
      // ATTRIBUTION (review r2, NEW-7): `Workflow` IS consulted with the callback on this runtime, and the
      // loose bridge would have allowed it — the absence of any bridge decision is what says the HOOK
      // denied it first.
      expect(decisions.some((decision) => decision.tool === "Workflow")).toBe(false);
      expect(breaches).toEqual([]);
      expect(existsSync(join(session.cwd, ".claude"))).toBe(false);
      expect(danglingWorktreeEntries(session)).toEqual([]);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "review r4, NEW-18 (c): merge never replace — the host's own hook still runs after the floor, and its `allow` cannot lift a floor deny",
    async () => {
      // r2's NEW-1 property measured END TO END rather than on the merged array: a host PreToolUse hook
      // that ALLOWS everything is kept (it ran for both calls, in order) and ordered after the floor (its
      // `allow` did not lift the floor's deny — the runtime evaluates every matcher, and any deny wins).
      const session = hermeticSession("containment-host-hook");
      const seen: string[] = [];
      const { results } = await runContainment({
        session,
        mutateOptions: (options) => {
          const host = async (raw: unknown): Promise<unknown> => {
            const input = raw as { tool_name?: string; tool_input?: { file_path?: string } };
            seen.push(`${input.tool_name}:${basename(input.tool_input?.file_path ?? "")}`);
            return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "the host says yes" } };
          };
          const hooks = (options.hooks ?? {}) as Record<string, unknown[]>;
          return { ...options, hooks: { ...hooks, PreToolUse: [...(hooks["PreToolUse"] ?? []), { hooks: [host] }] } };
        },
        turns: [
          { toolUses: [{ id: "d1", name: "Write", input: { file_path: join(session.cwd, "CLAUDE.md"), content: "# hijacked\n" } }] },
          { toolUses: [{ id: "a1", name: "Write", input: { file_path: join(session.cwd, "notes.md"), content: "ordinary work\n" } }] },
          { text: "done" },
        ],
      });
      const resultFor = (id: string): string => JSON.stringify(results.find((entry) => entry.tool_use_id === id)?.content ?? "").toLowerCase();
      expect(resultFor("d1")).toContain("may not create or modify");
      expect(resultFor("a1")).toContain("created successfully");
      expect(seen).toEqual(["Write:CLAUDE.md", "Write:notes.md"]);
      expect(existsSync(join(session.cwd, "CLAUDE.md"))).toBe(false);
      expect(existsSync(join(session.cwd, "notes.md"))).toBe(true);
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
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
