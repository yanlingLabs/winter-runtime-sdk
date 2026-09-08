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
import type { OfficialOptions, OfficialQuery, OfficialSdkModule, OfficialSpawnOptions } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter, officialHandoffEligibility } from "../../src/official/index.ts";
import { OfficialConfigurationError, OfficialInvalidResumeError, OfficialMcpError } from "../../src/official/errors.ts";
import { buildOfficialOptions } from "../../src/official/options-template.ts";
import { assertNoAdvisor, canonicalToolNames, officialMcpServers, winterMcpServerDescriptor, type WinterMcpToolDescriptor } from "../../src/official/mcp-descriptors.ts";
import type { SpawnedChildProcess } from "../../src/official/spawn-proxy.ts";

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
  selection,
  prompt: "hi",
  options,
  profile: "fresh-spool",
  configDir: SPOOL,
  cwd: "/work/repo",
});

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

  test("the dispatcher classifies a spawn it was not launched into, and stays self-consistent", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module), { spawnChild: () => fakeChild() }) as ReturnType<typeof createOfficialAdapter> & {
      lastDispatchedSupervisor?: { observation?: { root: { kind: string } } };
    };
    adapter.spawnProxy(spawnOptions("/tmp/claude-resume-abc"));
    expect(adapter.lastDispatchedSupervisor?.observation?.root.kind).toBe("sdk-resume-staging");
    expect(() => adapter.spawnProxy({ ...spawnOptions(), env: {} })).toThrow(OfficialConfigurationError);
  });

  test("buildChildEnv goes through the same allowlist the env module owns", () => {
    const { module } = fakeClaudeModule();
    const adapter = createOfficialAdapter(context(module));
    const env = adapter.buildChildEnv({ selection, configDir: SPOOL, brand: WINTER_BRAND, credentials: { ANTHROPIC_API_KEY: "k" }, base: { PATH: "/usr/bin", EDITOR: "vim" } });
    expect(env).toEqual({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: SPOOL, PATH: "/usr/bin" });
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
  });
});
