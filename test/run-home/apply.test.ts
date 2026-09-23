// WS-21 §3.1, §3.4.4, §3.5, §3.7: applying a run home on both legs.
//
// Winter leg: the router lays the run home's env, `settingSources: ["user"]` and the memory pin over
// the caller's options, synchronously, and refuses a run home that is foreign, disposed, for the other
// leg, another cwd, another brand or another store. Official leg: the template's run-home profile, the
// env builder's three variables, the invariants and the spawn proxy's setting-source check.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WINTER_BRAND, WinterCompatibilitySessionStore, resolveBrand, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { buildRunHome, createRuntimeSdk, protectedPathRules, RunHomeError, type RunHome, type RuntimeSdkPeers } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { assertOptionsInvariants, buildOfficialOptions } from "../../src/official/options-template.ts";
import { buildOfficialChildEnv } from "../../src/official/env-allowlist.ts";
import { createSupervisedSpawnProxy } from "../../src/official/spawn-proxy.ts";
import { officialRunHomeBinding } from "../../src/door.ts";
import type { OptionsTemplateInput } from "../../src/seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialSdkModule } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { OfficialConfigurationError } from "../../src/official/errors.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";
import { declaredClasses, sessionAddress, sessionEntry } from "../messaging/support.ts";

afterAll(cleanupRunHomeBeds);

const keychain = createFakeKeychain([{ ref: { kind: "keychain", account: "loopback", service: "com.example.apply" }, material: "sk-apply" }]);

/** A Winter peer with the concrete store, whose home resolution throws: this bed always names its home. */
function storePeer(): { peer: RuntimeSdkPeers["winter"]; calls: ReturnType<typeof createFakeWinterPeer>["calls"] } {
  const { peer, calls } = createFakeWinterPeer();
  return {
    peer: {
      ...peer,
      WinterCompatibilitySessionStore,
      resolveWinterHome: () => {
        throw new Error("a hermetic test must never resolve the real Winter home");
      },
    } as unknown as RuntimeSdkPeers["winter"],
    calls,
  };
}

function winterRouter(bed: RunHomeBed, extra: { requireRunHome?: boolean } = {}) {
  const { peer, calls } = storePeer();
  const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: extra.requireRunHome ?? true, handoff: { winterHome: bed.home } });
  return { sdk, calls };
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RunHomeError) return error.code;
    throw error;
  }
  return "accepted";
};

describe("the Winter leg", () => {
  test("the run home's env, the user source and the memory pin reach the peer; the caller's own env survives beneath them", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    sdk.query({ prompt: "hi", options: { cwd: bed.cwd, model: "m", env: { KEEP: "yes" }, settingSources: [], runtime: { runHome } } });
    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!.options as Record<string, unknown>;
    expect("runtime" in forwarded).toBe(false);
    expect(forwarded["model"]).toBe("m");
    expect(forwarded["settingSources"]).toEqual(["user"]);
    expect(forwarded["env"]).toEqual({
      KEEP: "yes",
      WINTER_HOME: runHome.dir,
      WINTER_STORE_HOME: bed.sdk,
      WINTER_PLUGIN_CACHE_DIR: join(bed.sdk, "plugins"),
      WINTER_PROVIDER_MANAGED_BY_HOST: "1",
      WINTER_DISABLE_CRON: "1",
    });
    expect(forwarded["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: true });
    expect(sdk.runHomeOutcome(runHome.runId)).toBe("safe");
  });

  test("chat and dispatch: native auto-memory is off (the daemon keeps its `_assistant` injection)", async () => {
    for (const mode of ["chat", "dispatch"] as const) {
      const bed = runHomeBed();
      const runHome = await buildRunHome(inputFor(bed, { mode }));
      const { sdk, calls } = winterRouter(bed);
      sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      expect((calls[0]!.options as Record<string, unknown>)["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: false });
    }
  });

  test("a code run home's `autoMemoryEnabled: false` in sdk/settings.json reaches the pin", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
    expect((calls[0]!.options as Record<string, unknown>)["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: false });
  });

  test("the refusals: project/local sources, the other leg, another cwd, a foreign or disposed run home, another store, another brand", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, settingSources: ["project"], runtime: { runHome } } }))).toBe("setting_sources_refused");
    // A variable only the router sets, from the caller — refused, never silently overwritten (any case).
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, env: { WINTER_HOME: "/caller/home" }, runtime: { runHome } } }))).toBe("router_owned_variable");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, env: { winter_store_home: "/x" }, runtime: { runHome } } }))).toBe("router_owned_variable");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, settingSources: ["user", "local"], runtime: { runHome } } }))).toBe("setting_sources_refused");

    const official = await buildRunHome(inputFor(bed, { leg: "official" }));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: official } } }))).toBe("run_home_leg_mismatch");

    mkdirSync(join(bed.root, "other"), { recursive: true });
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: join(bed.root, "other"), runtime: { runHome } } }))).toBe("run_home_cwd_mismatch");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { runtime: { runHome } } }))).toBe("run_home_cwd_mismatch");

    const forged = { ...runHome } as RunHome;
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: forged } } }))).toBe("run_home_foreign");
    const disposed = await buildRunHome(inputFor(bed));
    await disposed.dispose();
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: disposed } } }))).toBe("run_home_foreign");

    const elsewhere = runHomeBed();
    const otherHome = await buildRunHome(inputFor(elsewhere, { cwd: bed.cwd }));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: otherHome } } }))).toBe("run_home_store_mismatch");

    const acme = resolveBrand({ homeDirName: ".acme", projectDirName: ".acme", instructionsFile: "ACME.md", envPrefix: "ACME_", mcpServerName: "acme" });
    if (!acme.ok) throw new Error(acme.reason);
    const branded = await buildRunHome(inputFor(bed, { brand: acme.brand }));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: branded } } }))).toBe("run_home_brand_mismatch");

    expect(calls).toHaveLength(0);
  });

  test("a router created without `requireRunHome` cannot apply one: its store is on the pre-WS-21 layout", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed, { requireRunHome: false });
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } }))).toBe("run_home_store_mismatch");
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The official leg, piece by piece.
// ------------------------------------------------------------------------------------------------

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the apply bed",
  decidedAt: new Date(0).toISOString(),
};

class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
}

const templateInput = (runHome: RunHome | undefined, over: Partial<OptionsTemplateInput> = {}): OptionsTemplateInput => ({
  mode: "code",
  selection,
  cwd: runHome?.input.cwd ?? "/work/repo",
  sessionStore: new PassthroughStore() as unknown as SessionStore,
  autoMemoryDirectory: "/home/.winter/projects/k/memory",
  brand: WINTER_BRAND,
  pathToClaudeCodeExecutable: "/vendored/claude",
  spawnProxy: () => {
    throw new Error("not spawned");
  },
  profile: "fresh-spool",
  configDir: runHome?.dir ?? "/home/.winter/runtimes/official-agent-spool",
  ...(runHome === undefined ? {} : { runHome: officialRunHomeBinding(runHome) }),
  ...over,
});

describe("the official template on a run home", () => {
  test("the user source, strict MCP off, and the flag layer's pins — merged OVER the host's own flag settings", async () => {
    const bed = runHomeBed();
    const root = join(bed.root, "repo");
    mkdirSync(root, { recursive: true });
    const runHome = await buildRunHome(inputFor(bed, { leg: "official", cwd: root, trustedProjectRoot: root, gitRoot: root }));
    const options = buildOfficialOptions(templateInput(runHome), { settings: { permissions: { deny: ["Read(./secrets)"], ask: ["Bash(git push:*)"] }, autoMemoryDirectory: "/host/tries/to/move/it" } });
    expect(options.settingSources).toEqual(["user"]);
    expect(options.strictMcpConfig).toBe(false);
    expect(options.settings).toEqual({
      permissions: { deny: ["Read(./secrets)"], ask: ["Bash(git push:*)", ...protectedPathRules(bed.sdk, root)] },
      plansDirectory: ".winter/plans",
      autoMemoryEnabled: true,
      autoMemoryDirectory: runHome.input.memoryDir,
    });
  });

  test("autoMemoryEnabled comes from the effective settings, not a constant", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official", mode: "chat" }));
    expect((buildOfficialOptions(templateInput(runHome)).settings as Record<string, unknown>)["autoMemoryEnabled"]).toBe(false);
  });

  test("without a run home the pre-WS-21 profile is unchanged", () => {
    const options = buildOfficialOptions(templateInput(undefined));
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect((options.settings as Record<string, unknown>)["autoMemoryEnabled"]).toBe(true);
    expect((options.settings as Record<string, unknown>)["permissions"]).toBeUndefined();
  });

  test("the invariants tie `[\"user\"]` and strict-MCP-off to the run home, and pin the config dir", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const good = buildOfficialOptions(templateInput(runHome));
    const legacy = buildOfficialOptions(templateInput(undefined));
    const refused = (options: OfficialOptions, context: Parameters<typeof assertOptionsInvariants>[2]): string => {
      try {
        assertOptionsInvariants(options, "winter-claude-agent", context);
        return "ok";
      } catch (error) {
        expect(error).toBeInstanceOf(OfficialConfigurationError);
        return (error as OfficialConfigurationError).option;
      }
    };
    const binding = { runHome: { dir: runHome.dir } };
    expect(refused(good, binding)).toBe("ok");
    expect(refused({ ...good, env: { CLAUDE_CONFIG_DIR: runHome.dir } }, binding)).toBe("ok");
    expect(refused({ ...good, env: { CLAUDE_CONFIG_DIR: join(runHome.dir, ".absent") } }, binding)).toBe("ok");
    expect(refused({ ...good, env: { CLAUDE_CONFIG_DIR: bed.sdk } }, binding)).toBe("env.CLAUDE_CONFIG_DIR");
    expect(refused(good, {})).toBe("settingSources");
    expect(refused({ ...legacy, settingSources: ["user"] }, {})).toBe("settingSources");
    expect(refused({ ...good, settingSources: [] }, binding)).toBe("settingSources");
    expect(refused({ ...good, settingSources: ["user", "project"] }, binding)).toBe("settingSources");
    expect(refused({ ...good, strictMcpConfig: true }, binding)).toBe("strictMcpConfig");
    expect(refused({ ...legacy, strictMcpConfig: false }, {})).toBe("strictMcpConfig");
  });
});

describe("the official child env on a run home", () => {
  const envInput = (configDir: string, runHome?: { sdkHome: string }) => ({
    selection,
    configDir,
    brand: WINTER_BRAND,
    credentials: { ANTHROPIC_API_KEY: "sk-x" },
    base: { HOME: "/home/u", PATH: "/usr/bin" },
    ...(runHome === undefined ? {} : { runHome }),
  });

  test("the config dir is the run folder, and the builder sets the plugin root and the two host switches", () => {
    const env = buildOfficialChildEnv(envInput("/h/cache/runs/r", { sdkHome: "/h/sdk" }));
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/h/cache/runs/r");
    expect(env["CLAUDE_CODE_PLUGIN_CACHE_DIR"]).toBe("/h/sdk/plugins");
    expect(env["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]).toBe("1");
    expect(env["CLAUDE_CODE_DISABLE_CRON"]).toBe("1");
  });

  test("none of the four is set without a run home", () => {
    const env = buildOfficialChildEnv(envInput("/h/runtimes/official-agent-spool"));
    for (const name of ["CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_DISABLE_CRON"]) expect(env[name]).toBeUndefined();
  });

  test("`configuredExtras` can set none of the router-set variables, with or without a run home", () => {
    for (const name of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_DISABLE_CRON"]) {
      for (const runHome of [undefined, { sdkHome: "/h/sdk" }]) {
        expect(() => buildOfficialChildEnv(envInput("/h/cache/runs/r", runHome), { configuredExtras: { [name]: "/elsewhere" } })).toThrow(OfficialConfigurationError);
      }
    }
  });
});

describe("the spawn proxy's setting-source check (spec §3.5)", () => {
  const fakeChild = () => {
    const stdout = new PassThrough();
    return {
      pid: 4242,
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
      on: () => undefined,
    };
  };
  const spawnWith = (args: string[], configDir: string, runHome?: { dir: string }) => {
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: configDir,
      ...(runHome === undefined ? {} : { runHome }),
      sink: { record: () => undefined },
      spawnChild: () => fakeChild() as never,
    });
    try {
      proxy.spawn({ command: "/vendored/claude", args, cwd: "/work", env: { CLAUDE_CONFIG_DIR: configDir }, signal: new AbortController().signal });
      return proxy.observation?.root.kind ?? "spawned";
    } catch (error) {
      if (error instanceof RunHomeError) return error.code;
      if (error instanceof OfficialConfigurationError) return `config:${error.option}`;
      throw error;
    }
  };

  test("the user source on the run folder spawns, recorded as a `run-folder` root", () => {
    expect(spawnWith(["--setting-sources=user"], "/h/cache/runs/r", { dir: "/h/cache/runs/r" })).toBe("run-folder");
  });

  test("project/local are refused; `user` without a run home is refused; a run home with no source is refused", () => {
    expect(spawnWith(["--setting-sources=user,project"], "/h/cache/runs/r", { dir: "/h/cache/runs/r" })).toBe("setting_sources_refused");
    expect(spawnWith(["--setting-sources", "local"], "/h/cache/runs/r", { dir: "/h/cache/runs/r" })).toBe("setting_sources_refused");
    expect(spawnWith(["--setting-sources=user"], "/h/runtimes/official-agent-spool")).toBe("setting_sources_refused");
    expect(spawnWith(["--setting-sources="], "/h/cache/runs/r", { dir: "/h/cache/runs/r" })).toBe("setting_sources_refused");
    expect(spawnWith([], "/h/cache/runs/r", { dir: "/h/cache/runs/r" })).toBe("setting_sources_refused");
  });

  test("a fresh run-home spawn handed any other config dir is refused before a child exists", () => {
    expect(spawnWith(["--setting-sources=user"], "/h/cache/runs/other", { dir: "/h/cache/runs/r" })).toBe("config:env.CLAUDE_CONFIG_DIR");
  });

  test("the pre-WS-21 profile is unchanged: no source, the spool", () => {
    expect(spawnWith(["--setting-sources="], "/h/runtimes/official-agent-spool")).toBe("official-spool");
  });
});

// ------------------------------------------------------------------------------------------------
// The official leg THROUGH THE DOOR, against a fake runtime that records what it was launched with.
// ------------------------------------------------------------------------------------------------

function fakeOfficial(): { module: OfficialSdkModule & { version: string }; launched: OfficialOptions[] } {
  const launched: OfficialOptions[] = [];
  const module = {
    version: "0.3.250",
    query(params: { prompt: unknown; options?: OfficialOptions }): OfficialQuery {
      launched.push(params.options as OfficialOptions);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "00000000-0000-4000-8000-000000000001" };
          yield { type: "result", subtype: "success" };
        },
        interrupt: async () => undefined,
        setPermissionMode: async () => undefined,
      } as unknown as OfficialQuery;
    },
  };
  return { module, launched };
}

describe("the official leg through the door", () => {
  test("a fresh generation runs in its run folder with the run-home profile", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const { peer } = storePeer();
    const { module, launched } = fakeOfficial();
    const ref = { kind: "keychain", account: "loopback", service: "com.example.apply" } as const;
    const sdk = createRuntimeSdk({ peers: { winter: peer, claude: module }, keychain, vendoredOfficialRuntime: "/vendored/claude", requireRunHome: true, handoff: { winterHome: bed.home } });
    const query = sdk.query({
      prompt: "hi",
      options: {
        cwd: bed.cwd,
        canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input }),
        runtime: {
          runHome,
          selection,
          official: { sessionId: "s-apply", credentials: [{ variable: "ANTHROPIC_API_KEY", ref }], connectionEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, base: { HOME: bed.root, PATH: "/usr/bin" } },
        },
      },
    });
    for await (const _message of query as AsyncIterable<unknown>) void _message;
    expect(launched).toHaveLength(1);
    const options = launched[0]!;
    expect(options.env?.["CLAUDE_CONFIG_DIR"]).toBe(runHome.dir);
    expect(options.env?.["CLAUDE_CODE_PLUGIN_CACHE_DIR"]).toBe(join(bed.sdk, "plugins"));
    expect(options.env?.["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]).toBe("1");
    expect(options.env?.["CLAUDE_CODE_DISABLE_CRON"]).toBe("1");
    expect(options.settingSources).toEqual(["user"]);
    expect(options.strictMcpConfig).toBe(false);
    expect((options.settings as Record<string, unknown>)["autoMemoryDirectory"]).toBe(runHome.input.memoryDir);
    expect("plugins" in options).toBe(false);
  });

  test("a spool named beside a run home is refused (the run folder replaces it)", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const { peer } = storePeer();
    const { module, launched } = fakeOfficial();
    const sdk = createRuntimeSdk({ peers: { winter: peer, claude: module }, keychain, vendoredOfficialRuntime: "/vendored/claude", requireRunHome: true, handoff: { winterHome: bed.home } });
    const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome, selection, official: { sessionId: "s-spool", spool: join(bed.home, "spool"), base: { HOME: bed.root } } } } });
    await expect((async () => {
      for await (const _message of query as AsyncIterable<unknown>) void _message;
    })()).rejects.toThrow(/replaces the spool/);
    expect(launched).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The router's OWN Winter query: the messaging cold resume (spec §3.1 — `runHomeFor`).
// ------------------------------------------------------------------------------------------------

describe("the cold resume runs on a run home too", () => {
  const world = (bed: RunHomeBed, runHomeFor?: Parameters<typeof createRuntimeSdk>[0]["runHomeFor"]) => {
    const { peer, calls } = storePeer();
    const declared = declaredClasses();
    const sdk = createRuntimeSdk({
      peers: { winter: peer },
      keychain,
      requireRunHome: true,
      handoff: { winterHome: bed.home },
      ...(runHomeFor === undefined ? {} : { runHomeFor }),
      messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass }, official: { permissionClass: declared.official.permissionClass } } },
    });
    return { sdk, calls };
  };

  test("with no `runHomeFor`, an exited Winter session is non-retryably unavailable and nothing is opened", async () => {
    const bed = runHomeBed();
    const { sdk, calls } = world(bed);
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: bed.cwd });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("unavailable");
    expect((outcome as { retryable?: boolean }).retryable).toBe(false);
    expect(JSON.stringify(outcome)).toContain("run_home_for_missing");
    expect(calls).toHaveLength(0);
  });

  test("with `runHomeFor`, the resume is opened on the host-built folder, applied as `query()` applies it, then disposed and recorded safe", async () => {
    const bed = runHomeBed();
    const built: RunHome[] = [];
    const asked: unknown[] = [];
    const { sdk, calls } = world(bed, async (ctx) => {
      asked.push(ctx);
      const runHome = await buildRunHome(inputFor(bed, { cwd: ctx.cwd, leg: ctx.leg, mode: ctx.mode }));
      built.push(runHome);
      return runHome;
    });
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: bed.cwd });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(asked).toEqual([{ sessionId: "gone", leg: "winter", cwd: bed.cwd, mode: "code" }]);
    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!.options as Record<string, unknown>;
    expect(forwarded["resume"]).toBe("backend-9");
    expect(forwarded["settingSources"]).toEqual(["user"]);
    expect((forwarded["env"] as Record<string, string>)["WINTER_HOME"]).toBe(built[0]!.dir);
    expect(existsSync(built[0]!.dir)).toBe(false);
    expect(sdk.runHomeOutcome(built[0]!.runId)).toBe("safe");
  });
});
