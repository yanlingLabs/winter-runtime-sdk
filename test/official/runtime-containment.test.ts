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
import { createApprovalBridge, type OfficialPermissionMode } from "../../src/official/callbacks.ts";
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

async function runContainment(args: { session: HermeticSession; turns: readonly ScriptedTurn[]; mode?: OfficialPermissionMode }): Promise<{
  decisions: Array<{ tool: string; behavior: string; source: string }>;
  results: ReturnType<typeof toolResults>;
}> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const { routes, record } = scriptedLoopback(args.turns);
  const decisions: Array<{ tool: string; behavior: string; source: string }> = [];

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
          broker: async (request) => ({ behavior: "allow", updatedInput: request.input }),
          onDecision: ({ request, result, source }) => decisions.push({ tool: request.toolName, behavior: result.behavior, source }),
        }),
      },
    });
    for await (const _message of live.query) {
      /* drained: the assertions are about the filesystem and the decisions, not the stream */
    }
  });
  return { decisions, results: toolResults(record) };
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

      // Every one of them was refused by the FLOOR (not by the broker, which said yes).
      const floored = decisions.filter((decision) => decision.source === "containment-floor");
      expect(floored.length).toBeGreaterThanOrEqual(9);
      expect(floored.every((decision) => decision.behavior === "deny")).toBe(true);
      expect(decisions.some((decision) => decision.source === "broker" && decision.behavior === "allow" && ["Write", "Bash"].includes(decision.tool))).toBe(false);
      // The model was told, in each tool_result, that the call was denied.
      expect(results.filter((entry) => JSON.stringify(entry.content).toLowerCase().includes("may not create or modify")).length).toBeGreaterThanOrEqual(9);
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
    "the native writers: durable Cron, worktrees, workflows and plan mode",
    async () => {
      const session = hermeticSession("containment-writers");
      const { decisions, results } = await runContainment({
        session,
        mode: "plan",
        turns: [
          { toolUses: [{ id: "t1", name: "CronCreate", input: { durable: true, schedule: "0 * * * *", prompt: "x" } }] },
          { toolUses: [{ id: "t2", name: "EnterWorktree", input: { name: "feature" } }] },
          { toolUses: [{ id: "t3", name: "Workflow", input: { name: "release" } }] },
          { toolUses: [{ id: "t4", name: "Task", input: { description: "isolated", prompt: "go", isolation: "worktree" } }] },
          { toolUses: [{ id: "t5", name: "ExitPlanMode", input: { plan: "# the plan" } }] },
          { text: "done" },
        ],
      });
      // Whatever each of them did, none of them produced a vendor-named path.
      expect(vendorNamedArtifacts(session)).toEqual([]);
      expect(decoyUntouched(session)).toBe(true);
      // THE DURABLE CRON IS REFUSED BEFORE THE CALLBACK, and that is worth recording rather than
      // asserting around: `disallowedTools` short-circuits ahead of `canUseTool`, so the floor never
      // sees the call at all. The name deny and the floor are therefore genuinely two layers — the
      // first one is what fires here, and the second is what would fire for a writer no list names.
      expect(decisions.some((decision) => decision.tool === "CronCreate")).toBe(false);
      const cron = results.find((entry) => entry.tool_use_id === "t1");
      expect(cron).toBeDefined();
      expect(JSON.stringify(cron?.content).toLowerCase()).toMatch(/denied|not allowed|permission|disabled|blocked/);
      // `plansDirectory` is what keeps plan mode out of the vendor's user-level plans directory: it
      // resolves under the product's project directory, and the vendor's own is never created.
      expect(existsSync(join(session.home, ".claude", "plans"))).toBe(false);
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
