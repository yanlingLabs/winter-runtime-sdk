// WS-14 §2/§5.1/§15: the Options template, its per-mode golden captures, and the refusals.
//
// The goldens are the deliverable §15 names ("options-template golden captures, per mode"). They are
// committed JSON, compared field for field, so that a field which moved, an invariant which was
// dropped, or a name which stopped being brand-derived shows up as a diff in a review rather than as
// behaviour in a session.
//
// THE GOLDEN IS BUILT WITH A NON-DEFAULT BRAND ON PURPOSE. A capture taken with the product's own
// profile cannot tell a brand-derived name from a hard-coded one — every value would read correctly
// either way. Building with `acme` makes every derivation visible, and a second assertion below
// re-builds with the default profile and checks the three names that must then be the product's.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, resolveBrand, type BrandProfile, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import type { OptionsTemplateInput } from "../../src/seams/official-adapter.ts";
import type { OfficialSpawnClaudeCodeProcess } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { OfficialConfigurationError } from "../../src/official/errors.ts";
import { AUTO_MEMORY_LOAD_CAP, DEFAULT_EXCLUDE_DYNAMIC_SECTIONS, assertOptionsInvariants, buildOfficialOptions, captureOptions, type OptionsTemplatePolicy } from "../../src/official/options-template.ts";

const acme: BrandProfile = (() => {
  const resolved = resolveBrand({
    productName: "Acme",
    packageName: "acme-agent-sdk",
    homeDirName: ".acme",
    projectDirName: ".acme",
    instructionsFile: "ACME.md",
    envPrefix: "ACME_",
    keychainService: "com.acme.core",
    mcpServerName: "acme",
    presetName: "acme_code",
    processLabel: "acme",
    codexOriginator: "acme",
    tempRootName: "acme",
    pluginManifestDir: ".acme-plugin",
    contactUrl: "https://example.com/acme",
  });
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.brand;
})();

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "the D13 table's Claude-family + Anthropic-protocol + Code row",
  decidedAt: new Date(0).toISOString(),
};

/** A stand-in store: the template only ever passes it through, and the capture marks it as an instance. */
class FakeCompatibilityStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
}

const spawnProxy: OfficialSpawnClaudeCodeProcess = () => {
  throw new Error("not spawned in this test");
};

const input = (mode: OptionsTemplateInput["mode"], brand: BrandProfile = acme): OptionsTemplateInput => ({
  mode,
  selection,
  cwd: "/work/repo",
  sessionStore: new FakeCompatibilityStore() as unknown as SessionStore,
  autoMemoryDirectory: "/home/.acme/projects/project-key-9/memory",
  brand,
  pathToClaudeCodeExecutable: "/vendored/runtimes/claude",
  spawnProxy,
  profile: "fresh-spool",
  configDir: "/home/.acme/runtimes/official-agent-spool",
});

describe("WS-14 §2 — the Options template", () => {
  test.each(["code", "dispatch", "chat"] as const)("the %s golden capture", (mode) => {
    const options = buildOfficialOptions(input(mode), {
      systemPromptAppend: "<deterministically built instructions>",
      advertisesHandoff: mode === "code",
      mcpServers: { acme: { type: "sdk", name: "acme" } },
      // A REALISTIC credential on purpose (review r1, m2): the goldens used to be clean only because
      // this line passed the literal `"<redacted>"`. `captureOptions` masks the values now, so the
      // fixture proves the masking rather than the test's own good manners.
      env: { CLAUDE_CONFIG_DIR: "/home/.acme/runtimes/official-agent-spool", ANTHROPIC_API_KEY: "sk-ant-a-real-looking-secret", PATH: "/usr/bin" },
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    const captured = captureOptions(options);
    const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `options-${mode}.golden.json`), "utf8")) as unknown;
    expect(captured).toEqual(golden as Record<string, unknown>);
    // The variable NAMES are what the golden is about; not one value survives the capture.
    expect(Object.keys((captured as { env: Record<string, string> }).env)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "PATH"]);
    expect(JSON.stringify(captured)).not.toContain("sk-ant-a-real-looking-secret");
  });

  test("every Winter-owned name in the template is BRAND-derived", () => {
    const options = buildOfficialOptions(input("code"));
    expect(options.toolAliases).toEqual({
      SendMessage: "mcp__acme__send_message",
      ListAgents: "mcp__acme__list_agents",
      ReadNotifications: "mcp__acme__read_notifications",
      advisor: "mcp__acme__advisor",
    });
    expect((options.settings as { plansDirectory: string }).plansDirectory).toBe(".acme/plans");

    const winter = buildOfficialOptions(input("code", WINTER_BRAND));
    expect(winter.toolAliases?.["SendMessage"]).toBe("mcp__winter__send_message");
    expect((winter.settings as { plansDirectory: string }).plansDirectory).toBe(".winter/plans");
  });

  test("the vendor's preset stays the vendor's literal (WS-01 §5 / D16), with the append and the §16 default", () => {
    const options = buildOfficialOptions(input("code"), { systemPromptAppend: "X" });
    expect(options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "X", excludeDynamicSections: true });
    // §16 q1 is fixed at `true` for every mode, and a host can still override per launch.
    expect(DEFAULT_EXCLUDE_DYNAMIC_SECTIONS).toEqual({ code: true, dispatch: true, chat: true });
    expect((buildOfficialOptions(input("chat"), { excludeDynamicSections: false }).systemPrompt as { excludeDynamicSections: boolean }).excludeDynamicSections).toBe(false);
  });

  test("the three settings-layer fields go through `settings`, not through Options (the measured door)", () => {
    const options = buildOfficialOptions(input("code"), { settings: { permissions: { allow: [] } } });
    expect(options.settings).toEqual({
      permissions: { allow: [] },
      plansDirectory: ".acme/plans",
      autoMemoryEnabled: true,
      autoMemoryDirectory: "/home/.acme/projects/project-key-9/memory",
    });
    // …and they are NOT set as top-level options, where the runtime would ignore them in silence.
    expect(options["plansDirectory"]).toBeUndefined();
    expect(options["autoMemoryEnabled"]).toBeUndefined();
    expect(options["autoMemoryDirectory"]).toBeUndefined();
    expect(AUTO_MEMORY_LOAD_CAP).toEqual({ lines: 200, bytes: 25 * 1024 });
  });

  test("§5: the flush policy is derived from whether the session advertises handoff", () => {
    expect(buildOfficialOptions(input("code")).sessionStoreFlush).toBe("batched");
    expect(buildOfficialOptions(input("code"), { advertisesHandoff: true }).sessionStoreFlush).toBe("eager");
  });

  test("§8's floor is installed as a PreToolUse hook ALWAYS, ahead of the host's own (review r1, M2)", () => {
    const bare = buildOfficialOptions(input("code"));
    expect(Object.keys(bare.hooks as Record<string, unknown>)).toEqual(["PreToolUse"]);
    expect((bare.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(1);
    // The host's own matchers survive, and ours run first.
    const hostHook = { matcher: "Write", hooks: [async () => ({})] };
    const merged = buildOfficialOptions(input("code"), { hooks: { PreToolUse: [hostHook], PostToolUse: [hostHook] } });
    const preToolUse = (merged.hooks as { PreToolUse: unknown[]; PostToolUse: unknown[] }).PreToolUse;
    expect(preToolUse).toHaveLength(2);
    expect(preToolUse[1]).toBe(hostHook);
    expect((merged.hooks as { PostToolUse: unknown[] }).PostToolUse).toEqual([hostHook]);
  });

  test("the always-on fields are always on", () => {
    const options = buildOfficialOptions(input("dispatch"));
    expect([options.strictMcpConfig, options.includePartialMessages, options.includeHookEvents, options.perTaskStopAffordance]).toEqual([true, true, true, true]);
    expect(options.settingSources).toEqual([]);
    expect(options.spawnClaudeCodeProcess).toBe(spawnProxy);
    expect(options.pathToClaudeCodeExecutable).toBe("/vendored/runtimes/claude");
    expect(options.enableFileCheckpointing).toBeUndefined();
  });

  test("a policy carrying `agents` reaches the built options unchanged -- names, order, every field", () => {
    const researcher = { description: "Researches a narrow question and reports back", prompt: "You are a research subagent.", tools: ["Read", "Grep", "WebFetch"] };
    const reviewer = { description: "Reviews a diff for correctness", prompt: "You are a review subagent.", model: "inherit" };
    // An object literal's own-key enumeration order is insertion order (both are string keys here) --
    // asserted below, because a host handing the SAME set to both legs needs the SECOND leg to see the
    // set in the order it declared it, not whatever order a rebuild happened to produce.
    const agents = { researcher, reviewer };
    const options = buildOfficialOptions(input("code"), { agents });
    expect(options["agents"]).toEqual(agents);
    expect(Object.keys(options["agents"] as Record<string, unknown>)).toEqual(["researcher", "reviewer"]);
    // Only the OUTER map is copied (the same shallow-copy discipline `mcpServers` uses above); each
    // definition crosses BY REFERENCE, so no field of one is silently re-shaped on the way through.
    expect((options["agents"] as Record<string, unknown>)["researcher"]).toBe(researcher);
    expect((options["agents"] as Record<string, unknown>)["reviewer"]).toBe(reviewer);
  });

  test("absent `agents` means absent -- no empty object is emitted", () => {
    const options = buildOfficialOptions(input("code"));
    expect("agents" in options).toBe(false);
  });
});

// 0.0.11 — THE ROUTER NAMES NO PLUGIN OF ITS OWN.
//
// Up to 0.0.10 the template hard-coded `plugins: [{ type: "local", path: "<cwd>/<projectDirName>" }]`
// with no trust decision anywhere. The pinned runtime loads a local plugin's `hooks/hooks.json` (and
// its skills, agents, commands, …) by default, so a cloned repository's own project directory ran its
// shell hooks the moment a Code session opened on it — measured against the pinned 0.3.250 in
// `runtime-plugins.test.ts`. Which plugins a session gets is a TRUST decision, and only the host has
// the information to make one; the router forwards what the host names and nothing else.
describe("0.0.11 — plugins are the host's decision, never the router's", () => {
  test.each(["code", "dispatch", "chat"] as const)("the %s template carries NO `plugins` key when the host names none", (mode) => {
    expect("plugins" in buildOfficialOptions(input(mode))).toBe(false);
    expect("plugins" in buildOfficialOptions(input(mode, WINTER_BRAND))).toBe(false);
  });

  test("a policy carrying `plugins` reaches the built options unchanged -- order and every field", () => {
    const first = { type: "local" as const, path: "/home/.acme/runtimes/plugin-views/battery/", skipMcpDiscovery: true as const };
    const second = { type: "local" as const, path: "/home/.acme/runtimes/plugin-views/notes", skipMcpDiscovery: true as const };
    const plugins = [first, second];
    const options = buildOfficialOptions(input("code"), { plugins });
    expect(options.plugins).toEqual(plugins);
    // COPIED, so a host mutating its own array after the invariants ran cannot change what launches.
    expect(options.plugins).not.toBe(plugins);
    expect(options.plugins?.[0]).not.toBe(first);
  });

  test("`skipMcpDiscovery: true` is required at the TYPE level too (enforced by `bun run typecheck`)", () => {
    // @ts-expect-error — an entry without `skipMcpDiscovery: true` is not an `OptionsTemplatePolicy` plugin.
    const missing: OptionsTemplatePolicy["plugins"] = [{ type: "local", path: "/home/views/x" }];
    // @ts-expect-error — `false` is not `true`.
    const disabled: OptionsTemplatePolicy["plugins"] = [{ type: "local", path: "/home/views/x", skipMcpDiscovery: false }];
    const fine: OptionsTemplatePolicy["plugins"] = [{ type: "local", path: "/home/views/x", skipMcpDiscovery: true }];
    expect([missing, disabled, fine].map((plugins) => plugins?.length)).toEqual([1, 1, 1]);
  });

  test("an empty `plugins` array is forwarded as empty (the host said \"none\"), distinct from absent", () => {
    expect(buildOfficialOptions(input("code"), { plugins: [] }).plugins).toEqual([]);
  });

  const refusedPlugins = (plugins: unknown): string => {
    try {
      buildOfficialOptions(input("code"), { plugins: plugins as never });
    } catch (error) {
      expect(error).toBeInstanceOf(OfficialConfigurationError);
      return `${(error as OfficialConfigurationError).option}: ${(error as Error).message}`;
    }
    return "accepted";
  };

  test("a relative or empty path is refused -- a relative plugin root resolves against the child's cwd, i.e. the project", () => {
    expect(refusedPlugins([{ type: "local", path: ".acme", skipMcpDiscovery: true }])).toMatch(/^plugins: .*absolute/);
    expect(refusedPlugins([{ type: "local", path: "views/battery", skipMcpDiscovery: true }])).toMatch(/^plugins: .*absolute/);
    expect(refusedPlugins([{ type: "local", path: "", skipMcpDiscovery: true }])).toMatch(/^plugins: .*absolute/);
  });

  test("a `..` segment is refused, however it is spelled", () => {
    expect(refusedPlugins([{ type: "local", path: "/home/.acme/runtimes/plugin-views/../../../work/repo/.acme", skipMcpDiscovery: true }])).toMatch(/^plugins: .*`\.\.`/);
    expect(refusedPlugins([{ type: "local", path: "/home/..", skipMcpDiscovery: true }])).toMatch(/^plugins: .*`\.\.`/);
    // A NAME that merely contains two dots is not a traversal.
    expect(refusedPlugins([{ type: "local", path: "/home/.acme/views/v1..2", skipMcpDiscovery: true }])).toBe("accepted");
  });

  test("a NUL byte in the path is refused", () => {
    expect(refusedPlugins([{ type: "local", path: "/home/views/a\u0000b", skipMcpDiscovery: true }])).toMatch(/^plugins: .*NUL/);
  });

  test("only the pinned runtime's `local` type is accepted", () => {
    expect(refusedPlugins([{ type: "git", path: "/home/views/x", skipMcpDiscovery: true }])).toMatch(/^plugins: .*`local`/);
    expect(refusedPlugins([{ path: "/home/views/x", skipMcpDiscovery: true }])).toMatch(/^plugins: .*`local`/);
  });

  test("§11: an entry that would let the plugin bring its own MCP servers is refused", () => {
    expect(refusedPlugins([{ type: "local", path: "/home/views/x" }])).toMatch(/^plugins: .*skipMcpDiscovery/);
    expect(refusedPlugins([{ type: "local", path: "/home/views/x", skipMcpDiscovery: false }])).toMatch(/^plugins: .*skipMcpDiscovery/);
  });

  test("a non-array, or a non-object entry, is refused", () => {
    expect(refusedPlugins({ type: "local", path: "/home/views/x", skipMcpDiscovery: true })).toMatch(/^plugins: .*array/);
    expect(refusedPlugins(["/home/views/x"])).toMatch(/^plugins: /);
    expect(refusedPlugins([null])).toMatch(/^plugins: /);
  });

  // FIX ROUND (review): the 0.0.10 bug path, spelled so that the lexical rules above let it through.
  // The session's own working directory, its project directory and the vendor's project directory are
  // refused however they are spelled; anything else under the working directory is NOT (a session in
  // `$HOME` legitimately names `~/<projectDirName>/cache/…`).
  const caseInsensitiveFs = process.platform === "darwin" || process.platform === "win32";
  test.each([
    ["the project directory", "/work/repo/.acme"],
    ["a trailing slash", "/work/repo/.acme/"],
    ["a `/./` segment", "/work/repo/./.acme"],
    ["a doubled separator", "/work//repo/.acme"],
    ["a doubled leading separator", "//work/repo/.acme"],
    ["a trailing `/.`", "/work/repo/.acme/."],
    ["the working directory itself", "/work/repo"],
    ["the working directory with a trailing slash", "/work/repo/"],
    ["the working directory spelled `/.`", "/work/repo/."],
    ["the vendor's project directory", "/work/repo/.claude"],
    ["the vendor's project directory, slash-terminated", "/work/repo/.claude//"],
  ])("%s is refused as a plugin root (%s)", (_label, path) => {
    expect(refusedPlugins([{ type: "local", path, skipMcpDiscovery: true }])).toMatch(/^plugins: .*working directory|^plugins: .*project directory/);
  });

  test.each([
    ["/work/repo/.ACME"],
    ["/WORK/repo/.acme"],
    ["/work/repo/.Claude"],
    ["/Work/Repo"],
  ])("a case variant (%s) is refused where the filesystem folds case, accepted where it does not", (path) => {
    const outcome = refusedPlugins([{ type: "local", path, skipMcpDiscovery: true }]);
    if (caseInsensitiveFs) expect(outcome).toMatch(/^plugins: /);
    else expect(outcome).toBe("accepted");
  });

  test("a directory merely UNDER the working directory is the host's call, not refused", () => {
    expect(refusedPlugins([{ type: "local", path: "/work/repo/.acme/views/battery", skipMcpDiscovery: true }])).toBe("accepted");
    expect(refusedPlugins([{ type: "local", path: "/work/repo/tools/plugin", skipMcpDiscovery: true }])).toBe("accepted");
    // A `$HOME` session: the product's own cache under the home directory is a legitimate host view.
    const home = { ...input("code"), cwd: "/home" };
    expect(buildOfficialOptions(home, { plugins: [{ type: "local", path: "/home/.acme/cache/skill-plugins", skipMcpDiscovery: true }] }).plugins).toHaveLength(1);
    expect(() => buildOfficialOptions(home, { plugins: [{ type: "local", path: "/home/.acme", skipMcpDiscovery: true }] })).toThrow(OfficialConfigurationError);
    expect(() => buildOfficialOptions(home, { plugins: [{ type: "local", path: "/home/", skipMcpDiscovery: true }] })).toThrow(OfficialConfigurationError);
  });

  test("`assertOptionsInvariants` refuses the project directory by the context's name, and the vendor's and the cwd without it", () => {
    const built = buildOfficialOptions(input("code"));
    const withPlugin = (path: string) => ({ ...built, plugins: [{ type: "local" as const, path, skipMcpDiscovery: true as const }] });
    expect(() => assertOptionsInvariants(withPlugin("/work/repo/.acme/"), "acme-claude-agent", { projectDirName: ".acme" })).toThrow(/project directory/);
    expect(() => assertOptionsInvariants(withPlugin("/work/repo/.claude"), "acme-claude-agent")).toThrow(/project directory/);
    expect(() => assertOptionsInvariants(withPlugin("/work/repo"), "acme-claude-agent")).toThrow(/working directory/);
    // `options.cwd` absent (a hand-built launch): the context's cwd is what the check uses…
    const { cwd: _dropped, ...cwdless } = withPlugin("/elsewhere/.acme");
    expect(() => assertOptionsInvariants(cwdless, "acme-claude-agent", { projectDirName: ".acme", cwd: "/elsewhere" })).toThrow(/project directory/);
    // …and with no working directory known at all, a plugin cannot be checked, so it is refused.
    expect(() => assertOptionsInvariants(cwdless, "acme-claude-agent", { projectDirName: ".acme" })).toThrow(/working directory/);
  });

  test("the same rule holds at `assertOptionsInvariants`, for options a caller built by hand", () => {
    const built = buildOfficialOptions(input("code"));
    expect(() => assertOptionsInvariants({ ...built, plugins: [{ type: "local", path: "/work/repo/.acme/../.acme", skipMcpDiscovery: true }] }, "acme-claude-agent")).toThrow(OfficialConfigurationError);
    expect(() => assertOptionsInvariants({ ...built, plugins: [{ type: "local", path: ".acme", skipMcpDiscovery: true }] }, "acme-claude-agent")).toThrow(/absolute/);
    expect(() => assertOptionsInvariants({ ...built, plugins: [{ type: "local", path: "/home/views/x", skipMcpDiscovery: true }] }, "acme-claude-agent")).not.toThrow();
  });
});

describe("WS-14 §5.1 — the withheld options, as refusals", () => {
  const base = () => buildOfficialOptions(input("code"));
  const branchLabel = "acme-claude-agent";

  test("`enableFileCheckpointing` is never set, and is refused if a caller sets it", () => {
    expect(() => assertOptionsInvariants({ ...base(), enableFileCheckpointing: true }, branchLabel)).toThrow(/incompatible with a store-backed session/);
    expect(() => assertOptionsInvariants({ ...base(), enableFileCheckpointing: false }, branchLabel)).toThrow(OfficialConfigurationError);
  });

  test("`persistSession: false` with a store is refused; without a store, the store itself is required", () => {
    expect(() => assertOptionsInvariants({ ...base(), persistSession: false }, branchLabel)).toThrow(/never advertise handoff/);
    const { sessionStore: _dropped, ...storeless } = base();
    expect(() => assertOptionsInvariants(storeless, branchLabel)).toThrow(/always runs with the shared compatibility store/);
  });

  test("the executable must be an explicit path — a bare command name resolves to the USER's binary", () => {
    expect(() => assertOptionsInvariants({ ...base(), pathToClaudeCodeExecutable: "claude" }, branchLabel)).toThrow(/bare command name/);
    expect(() => assertOptionsInvariants({ ...base(), pathToClaudeCodeExecutable: "" }, branchLabel)).toThrow(/named explicitly/);
  });

  test("`appendSystemPromptFile` must be ABSOLUTE — the runtime resolves a relative one against the project", () => {
    for (const path of ["ACME.md", "./.acme/ACME.md", ".acme/ACME.md", ""]) {
      expect([path, (() => { try { buildOfficialOptions(input("code"), { appendSystemPromptFile: path }); return "accepted"; } catch (error) { return (error as OfficialConfigurationError).option; } })()]).toEqual([path, "extraArgs"]);
    }
    expect(() => assertOptionsInvariants({ ...base(), extraArgs: { "append-system-prompt-file": "rel/ACME.md" } }, branchLabel)).toThrow(/absolute/);
    expect(() => assertOptionsInvariants({ ...base(), extraArgs: { "append-system-prompt-file": 7 } }, branchLabel)).toThrow(/absolute/);
    expect(() => buildOfficialOptions(input("code"), { appendSystemPromptFile: "/home/.acme/prompts/ACME.md" })).not.toThrow();
  });

  test("`extraArgs` carries only the documented append-system-prompt-file route", () => {
    expect(() => assertOptionsInvariants({ ...base(), extraArgs: { "dangerously-skip-permissions": "1" } }, branchLabel)).toThrow(/outside the pinned contract/);
    expect(() => assertOptionsInvariants(buildOfficialOptions(input("code"), { appendSystemPromptFile: "/w/.acme/ACME.md" }), branchLabel)).not.toThrow();
  });

  test("review r3, NEW-13: `bypassPermissions` is refused — it shadows the bridge the branch owns", () => {
    expect(() => assertOptionsInvariants({ ...base(), permissionMode: "bypassPermissions" }, branchLabel)).toThrow(/shadows `canUseTool`|auto-approves every tool call/);
    for (const mode of ["default", "plan", "acceptEdits", "dontAsk"]) {
      expect([mode, (() => { try { assertOptionsInvariants({ ...base(), permissionMode: mode }, branchLabel); return "ok"; } catch { return "refused"; } })()]).toEqual([mode, "ok"]);
    }
  });

  test("discovery stays off and the host stays the sole MCP owner", () => {
    expect(() => assertOptionsInvariants({ ...base(), settingSources: ["project"] }, branchLabel)).toThrow(/no vendor-named settings source/);
    expect(() => assertOptionsInvariants({ ...base(), strictMcpConfig: false }, branchLabel)).toThrow(/sole owner/);
  });
});
