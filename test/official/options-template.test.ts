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
import { AUTO_MEMORY_LOAD_CAP, DEFAULT_EXCLUDE_DYNAMIC_SECTIONS, assertOptionsInvariants, buildOfficialOptions, captureOptions } from "../../src/official/options-template.ts";

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
    expect(options.toolAliases).toEqual({ SendMessage: "mcp__acme__send_message", ListAgents: "mcp__acme__list_agents" });
    expect(options.plugins).toEqual([{ type: "local", path: "/work/repo/.acme", skipMcpDiscovery: true }]);
    expect((options.settings as { plansDirectory: string }).plansDirectory).toBe(".acme/plans");

    const winter = buildOfficialOptions(input("code", WINTER_BRAND));
    expect(winter.toolAliases?.["SendMessage"]).toBe("mcp__winter__send_message");
    expect((winter.plugins as Array<{ path: string }>)[0]?.path).toBe("/work/repo/.winter");
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
