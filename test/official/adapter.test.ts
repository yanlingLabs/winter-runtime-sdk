// WS-14 §1–§13 composed: the adapter, and the two things only composition can get wrong — which
// supervisor a generation is bound to, and what `OfficialSession.configDir` reports before the lazily
// spawned child exists.
//
// The official module here is a FAKE (a `query` that records what it was handed). The real one is
// driven in `runtime-*.test.ts`; what this file proves is the wiring around it.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { OfficialLaunchPlan, OptionsTemplateInput } from "../../src/seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialSdkModule, OfficialSpawnOptions, OfficialSpawnedProcess } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createRuntimeSdk, runtimeSdkInternals } from "../../src/index.ts";
import { createOfficialAdapter, officialHandoffEligibility, TRAFFIC_OPT_OUT_VARIABLES, type OfficialSessionHandle } from "../../src/official/index.ts";
import { OfficialConfigurationError, OfficialInvalidResumeError, OfficialMcpError } from "../../src/official/errors.ts";
import { assertOptionsInvariants, buildOfficialOptions } from "../../src/official/options-template.ts";
import { CONTAINMENT_FLOOR_MARK, carriesMark, isOurContainmentHook } from "../../src/official/callbacks.ts";
import { OFFICIAL_MATERIALIZATION_DROPS, assertNoAdvisor, canonicalToolNames, officialMcpServers, winterMcpServerDescriptor, type WinterMcpToolDescriptor } from "../../src/official/mcp-descriptors.ts";
import type { SpawnedChildProcess } from "../../src/official/spawn-proxy.ts";
import { UnaddressableEntryError } from "../../src/errors.ts";
import type { RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";

const SPOOL = "/home/.winter/runtimes/official-agent-spool";

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "fixture",
  decidedAt: new Date(0).toISOString(),
};

class FakeStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
}

function fakeChild(): SpawnedChildProcess {
  return {
    pid: 909,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
    on: () => undefined,
  };
}

/** A fake official module: it records the params and answers with an inert query handle. */
function fakeClaudeModule(): { module: OfficialSdkModule; calls: Array<{ prompt: unknown; options?: OfficialOptions }> } {
  const calls: Array<{ prompt: unknown; options?: OfficialOptions }> = [];
  const module: OfficialSdkModule = {
    query(params) {
      calls.push(params);
      const query: OfficialQuery = {
        async *[Symbol.asyncIterator]() {
          /* no messages: this fake never runs a turn */
        },
        interrupt: async () => "interrupted",
      };
      return query;
    },
  };
  return { module, calls };
}

function context(claude?: OfficialSdkModule): SeamContextWithDirectory {
  const directoryStore = createInMemoryRuntimeDirectoryStore();
  const base = {
    peers: { winter: createFakeWinterPeer().peer, ...(claude === undefined ? {} : { claude }) },
    keychain: createFakeKeychain(),
    brand: WINTER_BRAND,
    directoryStore,
  };
  return { ...base, directory: stubRuntimeDirectory(base) };
}

const templateInput = (spawnProxy: OptionsTemplateInput["spawnProxy"]): OptionsTemplateInput => ({
  mode: "code",
  selection,
  cwd: "/work/repo",
  sessionStore: new FakeStore() as unknown as SessionStore,
  autoMemoryDirectory: "/home/.winter/projects/k/memory",
  brand: WINTER_BRAND,
  pathToClaudeCodeExecutable: "/vendored/claude",
  spawnProxy,
  profile: "fresh-spool",
  configDir: SPOOL,
});

const plan = (options: OfficialOptions): OfficialLaunchPlan => ({
  address: "session:test",
  selection,
  prompt: "hi",
  options,
  profile: "fresh-spool",
  configDir: SPOOL,
  cwd: "/work/repo",
});

/** A minimal directory row a bare dispatch can be attributed to by its config dir. */
const dispatchableEntry = (configDir: string, address = "session:dispatched"): RuntimeDirectoryEntry => ({
  address,
  parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: address.slice("session:".length) },
  runtimeKind: "claude-agent",
  objectKind: "session",
  transport: "claude-handle",
  status: "running",
  mode: "code",
  generation: 1,
  selection,
  configDir,
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: new Date(0).toISOString(),
});

const launchPlan = (options: OfficialOptions, address: string, configDir: string): OfficialLaunchPlan => ({ ...plan(options), address, configDir });

/**
 * A refused record DESTROYS the returned stream (the proxy ends a generation whose transcript root
 * nothing could find), so a test that provokes one needs the `error` listener a real consumer has.
 * `OfficialSpawnedProcess.stdout` is `unknown` on the structural seam — deliberately, since the router
 * never imports the vendor's stream types — so the listener is attached through a local shape.
 */
const swallowStreamErrors = (spawned: OfficialSpawnedProcess): OfficialSpawnedProcess => {
  (spawned.stdout as { on(event: "error", listener: (error: Error) => void): void }).on("error", () => undefined);
  return spawned;
};

/** The template options a launch needs, built through the adapter under test. */
const officialOptionsFor = (adapter: { buildOptions(input: OptionsTemplateInput): OfficialOptions; spawnProxy: OptionsTemplateInput["spawnProxy"] }): OfficialOptions =>
  adapter.buildOptions(templateInput(adapter.spawnProxy));

const spawnOptions = (configDir = SPOOL): OfficialSpawnOptions => ({
  command: "/vendored/claude",
  args: [],
  cwd: "/work/repo",
  env: { CLAUDE_CONFIG_DIR: configDir },
  signal: new AbortController().signal,
});

describe("the official adapter", () => {
  test("a launch binds THIS generation's supervisor into the options the runtime is given", async () => {
    const { module, calls } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    const session = adapter.launch(plan(options));

    // The hook the runtime got is NOT the adapter's dispatcher: it is this generation's own.
    const handed = calls[0]?.options?.spawnClaudeCodeProcess;
    expect(handed).not.toBe(adapter.spawnProxy);
    expect(typeof handed).toBe("function");
    // …and the caller's own options object was not mutated.
    expect(options.spawnClaudeCodeProcess).toBe(adapter.spawnProxy);

    // Before the (lazy) spawn, `configDir` is the configured value; after it, the observed one.
    expect(session.configDir).toBe(SPOOL);
    handed?.(spawnOptions());
    await session.whenObserved();
    expect(session.configDir).toBe(SPOOL);
    expect(session.supervisor.observation?.processIdentity.pid).toBe(909);
    expect(session.profile).toBe("fresh-spool");
    expect(session.selection).toBe(selection);
    expect(await session.interrupt()).toBe("interrupted");
  });

  test("a store-backed resume reports the WRAPPER's staging root, not the configured spool", async () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const options = adapter.buildOptions({ ...templateInput(adapter.spawnProxy), profile: "store-backed-resume" });
    const session = adapter.resume({ ...plan(options), profile: "store-backed-resume", resume: "5cf40897-8a07-4f04-8415-90d89c420ce7" });
    const handed = options.spawnClaudeCodeProcess;
    expect(handed).toBeDefined();
    // the runtime is what spawns; drive this generation's own hook the way the runtime would
    const supervisor = session.supervisor;
    supervisor.spawn(spawnOptions("/tmp/claude-resume-9f2"));
    expect(await session.whenObserved()).toBe("/tmp/claude-resume-9f2");
    expect(session.configDir).toBe("/tmp/claude-resume-9f2");
  });

  test("a missing official peer is a typed refusal, never a silent fallback", () => {
    const adapter = createOfficialAdapter(context(), { spawnChild: () => fakeChild() });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.launch(plan(options))).toThrow(OfficialConfigurationError);
    expect(() => adapter.launch(plan(options))).toThrow(/no official SDK module was injected/);
  });

  test("the launch validates the options it was HANDED, not only the ones it built", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const good = adapter.buildOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.launch(plan({ ...good, enableFileCheckpointing: true }))).toThrow(/incompatible with a store-backed session/);
    expect(() => adapter.launch(plan({ ...good, pathToClaudeCodeExecutable: "claude" }))).toThrow(/bare command name/);
  });

  test("resume and launch disagree loudly rather than quietly", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.resume({ ...plan(options), resume: "" })).toThrow(OfficialInvalidResumeError);
    expect(() => adapter.launch(plan({ ...options, resume: "abc" }))).toThrow(/use resume\(\)/);
  });

  test("the dispatcher classifies a spawn it was not launched into, and stays self-consistent", async () => {
    const { module } = fakeClaudeModule();
    const ctx = context(module);
    // THE DISPATCHER RECORDS TOO (fix-wave concern 3), so a root it can attribute needs a row to
    // attribute it TO — here, one this adapter itself launched under the same config dir.
    await ctx.directoryStore.upsert(dispatchableEntry("/tmp/claude-resume-abc"));
    const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
      lastDispatchedSupervisor?: { observation?: { root: { kind: string } }; whenRecorded(): Promise<void> };
    };
    adapter.spawnProxy(spawnOptions("/tmp/claude-resume-abc"));
    expect(adapter.lastDispatchedSupervisor?.observation?.root.kind).toBe("sdk-resume-staging");
    expect(() => adapter.spawnProxy({ ...spawnOptions(), env: {} })).toThrow(OfficialConfigurationError);
  });

  // ==================================================================================================
  // FIX-WAVE CONCERN 3 — THE DOCUMENTED DISPATCHER PATH RECORDS, OR SAYS WHY IT CANNOT.
  //
  // `buildOptions({ spawnProxy: adapter.spawnProxy })` + the vendor's own `query()` is the shape §2's
  // template invites, and its sink used to be `policy.sink ?? a no-op` — so the host that followed the
  // documentation got NO §6 rule 2 record at all, silently, while the default read as "the record is
  // on". A record that is absent is only discovered during a handoff, by which time the staging root
  // is findable only by scanning temp directories by recency, which this branch refuses to do.
  // ==================================================================================================
  describe("the dispatcher path's record sink", () => {
    test("a root that maps to exactly one directory row is recorded under that row", async () => {
      const { module } = fakeClaudeModule();
      const ctx = context(module);
      await ctx.directoryStore.upsert(dispatchableEntry("/tmp/claude-resume-solo"));
      const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
        lastDispatchedSupervisor?: { whenRecorded(): Promise<void> };
      };
      adapter.spawnProxy(spawnOptions("/tmp/claude-resume-solo"));
      await adapter.lastDispatchedSupervisor?.whenRecorded();
      const row = (await ctx.directoryStore.load()).find((entry) => entry.address === "session:dispatched");
      expect(row?.configDir).toBe("/tmp/claude-resume-solo");
      expect(row?.processIdentity?.pid).toBe(909);
    });

    test("a root that belongs to a LAUNCH is recorded under that launch's address, with no row to find it by", async () => {
      const { module } = fakeClaudeModule();
      const ctx = context(module);
      const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
        lastDispatchedSupervisor?: { whenRecorded(): Promise<void> };
      };
      // The launch teaches the adapter the pair; the store still holds nothing.
      adapter.launch(launchPlan(officialOptionsFor(adapter), "session:launched", "/tmp/claude-resume-known"));
      adapter.spawnProxy(spawnOptions("/tmp/claude-resume-known"));
      await adapter.lastDispatchedSupervisor?.whenRecorded();
      const row = (await ctx.directoryStore.load()).find((entry) => entry.address === "session:launched");
      expect(row?.configDir).toBe("/tmp/claude-resume-known");
    });

    test("an unattributable root is a TYPED REFUSAL, never a silent no-op", async () => {
      const { module } = fakeClaudeModule();
      const ctx = context(module);
      const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
        lastDispatchedSupervisor?: { whenRecorded(): Promise<void> };
      };
      // A REFUSED RECORD DESTROYS THE STREAM (the proxy ends the generation rather than running one
      // whose transcript root nothing can find), so the stream needs the listener a real consumer has.
      swallowStreamErrors(adapter.spawnProxy(spawnOptions("/tmp/claude-resume-orphan")));
      const failure: unknown = await adapter.lastDispatchedSupervisor?.whenRecorded().then((): unknown => undefined, (error: unknown): unknown => error);
      expect(failure).toBeInstanceOf(OfficialConfigurationError);
      expect((failure as Error).message).toContain("belongs to no session");
    });

    test("two rows under one root refuse rather than pick by recency", async () => {
      const { module } = fakeClaudeModule();
      const ctx = context(module);
      await ctx.directoryStore.upsert(dispatchableEntry("/tmp/claude-resume-dup", "session:one"));
      await ctx.directoryStore.upsert(dispatchableEntry("/tmp/claude-resume-dup", "session:two"));
      const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
        lastDispatchedSupervisor?: { whenRecorded(): Promise<void> };
      };
      swallowStreamErrors(adapter.spawnProxy(spawnOptions("/tmp/claude-resume-dup")));
      const failure: unknown = await adapter.lastDispatchedSupervisor?.whenRecorded().then((): unknown => undefined, (error: unknown): unknown => error);
      expect((failure as Error).message).toContain("by recency");
    });

    test("a SHARED spool root is never attributed to the most recent launch (review r1, M-1)", async () => {
      const { module } = fakeClaudeModule();
      const ctx = context(module);
      const adapter = createOfficialAdapter(ctx, { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
        lastDispatchedSupervisor?: { whenRecorded(): Promise<void> };
      };
      // TWO fresh sessions under the SAME spool — which is what `fresh-spool` means: one directory per
      // home, shared by every fresh session (`spool.ts`'s own note). Before M-1 the map keyed by that
      // root answered "whichever launched last", and a bare third dispatch was recorded on session B
      // with the third session's pid — the recency guess item 6's own sentence forbids.
      adapter.launch(launchPlan(officialOptionsFor(adapter), "session:A", SPOOL));
      adapter.launch(launchPlan(officialOptionsFor(adapter), "session:B", SPOOL));
      await ctx.directoryStore.upsert({ ...dispatchableEntry(SPOOL, "session:A") });
      await ctx.directoryStore.upsert({ ...dispatchableEntry(SPOOL, "session:B") });

      swallowStreamErrors(adapter.spawnProxy(spawnOptions(SPOOL)));
      const failure: unknown = await adapter.lastDispatchedSupervisor?.whenRecorded().then((): unknown => undefined, (error: unknown): unknown => error);
      expect(failure).toBeInstanceOf(OfficialConfigurationError);
      expect((failure as Error).message).toContain("by recency");
      // Neither launch's row was touched by a spawn that was not theirs.
      for (const address of ["session:A", "session:B"]) {
        expect((await ctx.directoryStore.load()).find((entry) => entry.address === address)?.processIdentity).toBeUndefined();
      }
    });

    test("an explicit `policy.sink` still wins — the default is a default", async () => {
      const { module } = fakeClaudeModule();
      const seen: string[] = [];
      const adapter = createOfficialAdapter(context(module), {
        spawnChild: () => fakeChild(),
        sink: { record: (observation) => void seen.push(observation.root.configDir) },
      }) as ReturnType<typeof createOfficialAdapter> & { lastDispatchedSupervisor?: { whenRecorded(): Promise<void> } };
      adapter.spawnProxy(spawnOptions("/tmp/claude-resume-hosted"));
      await adapter.lastDispatchedSupervisor?.whenRecorded();
      expect(seen).toEqual(["/tmp/claude-resume-hosted"]);
    });
  });

  test("buildChildEnv goes through the same allowlist the env module owns", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module));
    const env = adapter.buildChildEnv({ selection, configDir: SPOOL, brand: WINTER_BRAND, credentials: { ANTHROPIC_API_KEY: "k" }, base: { PATH: "/usr/bin", EDITOR: "vim" } });
    // …including R-7b-11's four, which the env module now sets on every child by default.
    expect(env).toEqual({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: SPOOL, PATH: "/usr/bin", ...TRAFFIC_OPT_OUT_VARIABLES });
  });
});

describe("review r1, M3 — the wiring through the router's own door", () => {
  test("`createRuntimeSdk` hands back a REAL adapter that needs no initialization call", async () => {
    const { peer } = createFakeWinterPeer();
    const { module } = fakeClaudeModule();
    const directoryStore = createInMemoryRuntimeDirectoryStore();
    const sdk = createRuntimeSdk({ peers: { winter: peer, claude: module }, keychain: createFakeKeychain(), directoryStore });
    const official = runtimeSdkInternals(sdk)?.official;
    expect(official).toBeDefined();

    // NOT the stub: the stub throws `NotImplementedYet` from every member.
    const options = official?.buildOptions(templateInput(official.spawnProxy));
    expect(options?.strictMcpConfig).toBe(true);

    // …and §6 rule 2's record lands in the store the SPINE handed the adapter, with no explicit sink
    // and no `ready()` — the two things the owed wiring would have got wrong.
    // The seam's return type is `OfficialSession`; the supervisor rides on the handle Lane A returns.
    const session = official?.launch({ ...plan(options as OfficialOptions), address: "session:wired" }) as unknown as OfficialSessionHandle;
    // A REAL SPAWN, through the REAL default child starter and with no `ready()` call anywhere: that
    // is the half of M3 a fake `spawnChild` cannot prove. `/bin/cat` is a process that starts, has a
    // pid, and waits — which is all the record needs.
    // `cwd` must EXIST for a real spawn — a nonexistent one yields a child with no pid, which is the
    // supervisor's own refusal and not the thing under test here.
    const child = session.supervisor.spawn({ ...spawnOptions(), command: "/bin/cat", args: [], cwd: process.cwd() });
    try {
      await session.supervisor.whenRecorded();
    } finally {
      child.kill("SIGTERM");
    }
    const recorded = (await directoryStore.load()).find((entry) => entry.address === "session:wired");
    expect(recorded?.configDir).toBe(SPOOL);
    expect(recorded?.processIdentity?.pid).toBeGreaterThan(0);
    // The seeded entry is a MINIMAL one — the real directory entry, when the host records it, owns
    // every other field.
    expect([recorded?.runtimeKind, recorded?.objectKind, recorded?.mode]).toEqual(["claude-agent", "session", "code"]);
  });
});

describe("review r4, NEW-18 / NEW-19 — the floor is merged on every launch and recognised by IDENTITY", () => {
  type Hook = (input: unknown) => Promise<unknown>;
  /** Every PreToolUse hook in the options, flattened, in the order the runtime is given them. */
  const preToolUseHooks = (options: OfficialOptions | undefined): Hook[] =>
    ((options?.hooks as { PreToolUse?: Array<{ hooks: Hook[] }> } | undefined)?.PreToolUse ?? []).flatMap((matcher) => matcher.hooks);
  /** Drives every hook with one call — the reviewer's own probe shape — and reports which of them denied. */
  const deniedBy = async (hooks: Hook[], toolName: string, toolInput: Record<string, unknown>): Promise<boolean[]> =>
    (await Promise.all(hooks.map((hook) => hook({ hook_event_name: "PreToolUse", tool_name: toolName, tool_use_id: "probe", tool_input: toolInput })))).map(
      (output) => (output as { hookSpecificOutput?: { permissionDecision?: string } } | undefined)?.hookSpecificOutput?.permissionDecision === "deny",
    );

  test("a host hook stamped with the exported mark is NOT the floor: launch() merges the real one ahead of it, and the invariants refuse the counterfeit alone", async () => {
    const { module, calls } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const good = adapter.buildOptions(templateInput(adapter.spawnProxy));
    const counterfeit: Hook = async () => ({});
    (counterfeit as unknown as Record<symbol, unknown>)[CONTAINMENT_FLOOR_MARK] = true;
    expect(carriesMark(counterfeit, CONTAINMENT_FLOOR_MARK)).toBe(true);
    expect(isOurContainmentHook(counterfeit)).toBe(false);
    // The invariants demand the IDENTITY: an options object whose only marked hook is the counterfeit has no floor.
    expect(() => assertOptionsInvariants({ ...good, hooks: { PreToolUse: [{ hooks: [counterfeit] }] } }, "winter-claude-agent")).toThrow(/containment floor is missing/);
    // …and launch() does not trust the mark either: the real floor is merged AHEAD of the counterfeit, which survives as a host hook.
    adapter.launch(plan({ ...good, hooks: { PreToolUse: [{ hooks: [counterfeit] }] } }));
    const handed = preToolUseHooks(calls[0]?.options);
    expect(handed.map(isOurContainmentHook)).toEqual([true, false, false]); // ours, the sweep's pre, the counterfeit
    expect(handed[2]).toBe(counterfeit);
    expect(await deniedBy(handed, "EnterWorktree", { name: "feature" })).toEqual([true, false, false]);
  });

  test("a LOOSER template policy cannot make the adapter's own containment inert: both floors ride, and the adapter's denies", async () => {
    const { module, calls } = fakeClaudeModule();
    // The TEMPLATE's policy hands the worktree writers to a host replacement; the ADAPTER's containment is the strict default.
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild(), options: { containment: { worktrees: "host-replacement" } } });
    const built = adapter.buildOptions(templateInput(adapter.spawnProxy));
    // The template's floor is GENUINE — identity, not a forgery — and lets the writer through, as configured.
    expect(preToolUseHooks(built).map(isOurContainmentHook)).toEqual([true]);
    expect(await deniedBy(preToolUseHooks(built), "EnterWorktree", { name: "feature" })).toEqual([false]);
    // launch() merges the adapter's own floor anyway: ours first, then the sweep's, then the template's — and ours denies.
    adapter.launch(plan(built));
    const handed = preToolUseHooks(calls[0]?.options);
    expect(handed.map(isOurContainmentHook)).toEqual([true, false, true]);
    expect(await deniedBy(handed, "EnterWorktree", { name: "feature" })).toEqual([true, false, false]);
  });

  test("merge never replace: the host's own matchers survive after ours, on every event they registered", () => {
    const { module, calls } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const good = adapter.buildOptions(templateInput(adapter.spawnProxy));
    const hostMatcher = { matcher: "Write", hooks: [async () => ({})] };
    adapter.launch(plan({ ...good, hooks: { PreToolUse: [hostMatcher], PostToolUse: [hostMatcher], Stop: [hostMatcher] } }));
    const hooks = calls[0]?.options?.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    expect(isOurContainmentHook(hooks["PreToolUse"]?.[0]?.hooks[0])).toBe(true);
    expect(hooks["PreToolUse"]?.at(-1)).toBe(hostMatcher);
    expect(hooks["PostToolUse"]?.at(-1)).toBe(hostMatcher);
    expect(hooks["Stop"]).toEqual([hostMatcher]);
  });

  test("review r4, NEW-19: `redirect` is refused on EVERY route — a bridge this package made does not skip the adapter's own policy", () => {
    const { module, calls } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild(), containment: { savedWebFetchApprovals: "redirect" } });
    // Options whose bridge THIS PACKAGE made, under the default disposition — the route that used to
    // downgrade to `disable` in silence, because the adapter validated its policy only where it built the bridge.
    const options = buildOfficialOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.launch(plan(options))).toThrow(/cannot be honoured on this branch/);
    expect(calls).toHaveLength(0);
  });
});

describe("WS-14 §5 / WS-17 row 15 — the handoff refusals", () => {
  test("a healthy proxied session is eligible", () => {
    expect(officialHandoffEligibility({ launchedThroughProxy: true, recordedLocalWriteRoot: SPOOL, transcriptHealth: "ok" })).toEqual({ eligible: true });
    // a default-spawn session with a HEALTHY mirror is not blocked by this rule
    expect(officialHandoffEligibility({ launchedThroughProxy: false, transcriptHealth: "ok" }).eligible).toBe(true);
  });

  test("a DEFAULT-SPAWN session with a mirror error is refused — scanning temp dirs by recency is forbidden", () => {
    const decision = officialHandoffEligibility({ launchedThroughProxy: false, transcriptHealth: "repair-required" });
    expect(decision).toMatchObject({ eligible: false, reason: "default-spawn-mirror-error" });
    expect(decision.eligible === false && decision.detail).toMatch(/scan temp directories by recency/);
  });

  test("a proxied session with a mirror error is blocked until the store is reconciled", () => {
    expect(officialHandoffEligibility({ launchedThroughProxy: true, recordedLocalWriteRoot: "/tmp/claude-resume-1", transcriptHealth: "repair-required" })).toMatchObject({
      eligible: false,
      reason: "repair-required",
    });
    expect(officialHandoffEligibility({ launchedThroughProxy: true, transcriptHealth: "repair-required" })).toMatchObject({ eligible: false, reason: "no-recorded-root" });
  });
});

describe("WS-14 §11 — the standing MCP server on the official branch", () => {
  const handlers = {
    sendMessage: async () => ({ content: [{ type: "text" as const, text: "delivered" }] }),
    listAgents: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ listing: "" }) }] }),
  };
  const branchLabel = "winter-claude-agent";

  test("the messaging handlers are registered with the NATIVE schemas, deferred, under canonical names", () => {
    const descriptor = winterMcpServerDescriptor({ brand: { mcpServerName: "acme" }, messaging: handlers, branchLabel });
    expect(descriptor.name).toBe("acme");
    expect(descriptor.tools.map((tool) => tool.tool)).toEqual(["send_message", "list_agents"]);
    expect(descriptor.tools.map((tool) => tool.exposure)).toEqual(["deferred", "deferred"]);
    expect(descriptor.tools[0]?.inputSchema.required).toEqual(["to", "message"]);
    expect(canonicalToolNames(descriptor, { mcpServerName: "acme" })).toEqual(["mcp__acme__send_message", "mcp__acme__list_agents"]);
  });

  test("NO ADVISOR on this server (D29): registering one is a refusal, not a silent filter", () => {
    const advisor: WinterMcpToolDescriptor = {
      tool: "advisor",
      description: "x",
      inputSchema: { type: "object", properties: {} },
      exposure: "eager",
      permissionClass: "advisor",
      handler: async () => ({ content: [] }),
    };
    expect(() => assertNoAdvisor([advisor], branchLabel)).toThrow(OfficialMcpError);
    expect(() => winterMcpServerDescriptor({ brand: WINTER_BRAND, messaging: handlers, capabilities: [advisor], branchLabel })).toThrow(/API-side server tool/);
    // the capability plugins themselves are registered unchanged
    const capability: WinterMcpToolDescriptor = { ...advisor, tool: "browser_navigate" };
    expect(winterMcpServerDescriptor({ brand: WINTER_BRAND, messaging: handlers, capabilities: [capability], branchLabel }).tools).toHaveLength(3);
  });

  test("materialization goes through the INJECTED module, and its absence is a typed MCP failure", () => {
    const registered: Array<{ name: string; schema: unknown }> = [];
    const module = {
      tool: (name: string, _description: string, inputSchema: unknown) => {
        registered.push({ name, schema: inputSchema });
        return { name };
      },
      createSdkMcpServer: (options: { name: string; tools?: unknown[] }) => ({ type: "sdk", name: options.name, tools: options.tools }),
    };
    const descriptor = winterMcpServerDescriptor({ brand: WINTER_BRAND, messaging: handlers, branchLabel });
    const servers = officialMcpServers({ descriptor, module, toInputShape: (schema) => ({ shapeOf: Object.keys(schema.properties) }), branchLabel });
    expect(Object.keys(servers)).toEqual(["winter"]);
    expect(registered.map((entry) => entry.name)).toEqual(["send_message", "list_agents"]);
    expect(registered[0]?.schema).toEqual({ shapeOf: ["to", "message", "summary", "notify_when_idle"] });

    expect(() => officialMcpServers({ descriptor, module: {}, toInputShape: () => ({}), branchLabel })).toThrow(/no in-process MCP server constructor/);
    // review r1, n3: what the vendor's constructor cannot carry is named, not implied.
    expect(OFFICIAL_MATERIALIZATION_DROPS).toEqual(["outputSchema", "exposure"]);
    expect(descriptor.tools[1]?.outputSchema).toBeDefined();
  });
});

// ====================================================================================================
// NEW-13's WRITER END — the guard on the sink that produced the unaddressable row in the first place.
//
// The directory's `record()` door is pinned in `test/messaging/directory.test.ts`; this is the other
// end, and it is the one that matters most for a host: the default record sink is where a
// non-canonical address actually came from, and refusing at `launch()` means the bad row never exists
// rather than being rejected later by a door the adapter does not call.
// ====================================================================================================
describe("NEW-13 / NEW-D — a launch under a non-canonical address is refused before anything spawns", () => {
  test("`launch()` throws UnaddressableEntryError, and no child is started", () => {
    let spawned = 0;
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), {
      spawnChild: () => {
        spawned += 1;
        return fakeChild();
      },
    });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.launch({ ...plan(options), address: "claude:session:not-canonical" })).toThrow(UnaddressableEntryError);
    // BEFORE ANY SPAWN: the row a listing would advertise is never written, and no process was paid for.
    expect(spawned).toBe(0);
  });

  test("the refusal names the two canonical forms and how to build one", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    try {
      adapter.launch({ ...plan(options), address: "claude:session:not-canonical" });
      throw new Error("unreachable: the launch should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(UnaddressableEntryError);
      expect((error as Error).message).toContain("serializeRuntimeAddress");
      expect((error as Error).message).toContain("session:<id>");
    }
  });

  test("a host that supplies its OWN sink is unaffected — the guard belongs to the default sink", () => {
    // The seam lets a host own the record; the address guard is the DEFAULT sink's, because that sink
    // is the one writing into the directory this package also reads.
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild(), sink: { record: () => undefined } });
    const options = adapter.buildOptions(templateInput(adapter.spawnProxy));
    expect(() => adapter.launch({ ...plan(options), address: "claude:session:not-canonical" })).not.toThrow();
  });
});
