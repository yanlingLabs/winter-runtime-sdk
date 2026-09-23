// WS-21 §3.4.4: the effective settings — three tiers merged by claude's rules (F17), each tier
// filtered first, every relative path re-anchored, then stripped per mode and cut to claude's schema.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { buildRunHome, fsRootAnchored } from "../../src/index.ts";
import { CLAUDE_SETTINGS_KEYS, PROJECT_TIER_REFUSED_KEYS } from "../../src/run-home/settings.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

function repo(bed: RunHomeBed): { root: string } {
  const root = join(bed.root, "repo");
  mkdirSync(root, { recursive: true });
  return { root };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function effective(bed: RunHomeBed, root: string | null, overrides: Parameters<typeof inputFor>[1] = {}): Promise<Record<string, unknown>> {
  const runHome = await buildRunHome(inputFor(bed, { cwd: root ?? bed.cwd, trustedProjectRoot: root, gitRoot: root, ...overrides }));
  const onDisk = JSON.parse(readFileSync(join(runHome.dir, "settings.json"), "utf8")) as Record<string, unknown>;
  expect(onDisk).toEqual(runHome.effectiveSettings);
  expect(statSync(join(runHome.dir, "settings.json")).mode & 0o777).toBe(0o600);
  return runHome.effectiveSettings;
}

describe("the tiers and claude's merge (F17)", () => {
  test("user < project < local; arrays concatenated and deduplicated; objects deep-merged", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(bed.sdk, "settings.json"), json({ model: "user-model", permissions: { allow: ["Bash(ls:*)", "Bash(pwd)"] }, env: { A: "user", B: "user" } }));
    put(join(root, ".winter", "settings.json"), json({ model: "project-model", permissions: { allow: ["Bash(pwd)", "Bash(git status)"] }, env: { B: "project" } }));
    put(join(root, ".winter", "settings.local.json"), json({ permissions: { allow: ["Bash(make)"] }, env: { C: "local" } }));
    const settings = await effective(bed, root);
    expect(settings["model"]).toBe("project-model");
    expect((settings["permissions"] as { allow: string[] }).allow).toEqual(["Bash(ls:*)", "Bash(pwd)", "Bash(git status)", "Bash(make)"]);
    expect(settings["env"]).toEqual({ A: "user", B: "project", C: "local" });
  });

  test("`fallbackModel` and `modelPicker` are replaced, never concatenated", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(bed.sdk, "settings.json"), json({ fallbackModel: ["a", "b"] }));
    put(join(root, ".winter", "settings.json"), json({ fallbackModel: ["c"] }));
    expect((await effective(bed, root))["fallbackModel"]).toEqual(["c"]);
  });

  test("an untrusted project contributes nothing (neither project nor local)", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(bed.sdk, "settings.json"), json({ model: "user-model" }));
    put(join(root, ".winter", "settings.json"), json({ model: "project-model", permissions: { allow: ["Bash(rm:*)"] } }));
    put(join(root, ".winter", "settings.local.json"), json({ env: { X: "local" } }));
    const runHome = await buildRunHome(inputFor(bed, { cwd: root, trustedProjectRoot: null, gitRoot: root }));
    expect(runHome.effectiveSettings).toEqual({ model: "user-model" });
  });

  test("a malformed tier is skipped, not fatal", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(bed.sdk, "settings.json"), json({ model: "user-model" }));
    put(join(root, ".winter", "settings.json"), "{ not json");
    expect((await effective(bed, root))["model"]).toBe("user-model");
  });
});

describe("the walk's `$HOME` stop (fix round 1, M2): a root at `$HOME` or above is not a project", () => {
  // A daemon home laid out as it is for real: `$HOME/.winter`, its sdk home inside it. A project tier
  // rooted at `$HOME` would read `$HOME/.winter/settings.json` — the DAEMON's own settings, which still
  // hold Winter-grammar keys kept for downgrade — and `$HOME/.winter/settings.local.json`.
  function homeBed(): { bed: RunHomeBed; userHome: string } {
    const bed = runHomeBed("hs");
    const userHome = join(bed.root, "u");
    const daemonHome = join(userHome, ".winter");
    mkdirSync(join(userHome, "p"), { recursive: true });
    const moved: RunHomeBed = { ...bed, home: daemonHome, sdk: join(daemonHome, "sdk"), cwd: join(userHome, "p") };
    put(join(moved.sdk, "settings.json"), json({ model: "user-model" }));
    put(join(daemonHome, "settings.json"), json({ model: "daemon-model", provider: { model: "codex-oauth/x" }, permissions: { allow: ["Bash(rm:*)"] } }));
    put(join(daemonHome, "settings.local.json"), json({ env: { FROM_DAEMON_HOME: "1" }, permissions: { allow: ["Bash(curl:*)"] } }));
    return { bed: moved, userHome };
  }

  test("root = `$HOME`: the project and local tiers contribute nothing", async () => {
    const { bed, userHome } = homeBed();
    const runHome = await buildRunHome(inputFor(bed, { trustedProjectRoot: userHome, gitRoot: userHome }), { userHome });
    expect(runHome.effectiveSettings).toEqual({ model: "user-model" });
  });

  test("root ABOVE `$HOME` (and a local anchor at `$HOME`): still nothing", async () => {
    const { bed, userHome } = homeBed();
    put(join(bed.root, ".winter", "settings.json"), json({ model: "above-model" }));
    const runHome = await buildRunHome(inputFor(bed, { trustedProjectRoot: bed.root, gitRoot: userHome }), { userHome });
    expect(runHome.effectiveSettings).toEqual({ model: "user-model" });
  });

  test("root = `$HOME` spelled through a link: still nothing (the stop compares real paths too)", async () => {
    const { bed, userHome } = homeBed();
    const link = join(bed.root, "home-link");
    symlinkSync(userHome, link);
    const runHome = await buildRunHome(inputFor(bed, { trustedProjectRoot: link, gitRoot: link }), { userHome });
    expect(runHome.effectiveSettings).toEqual({ model: "user-model" });
  });

  test("a project BELOW `$HOME` still contributes both tiers; a local anchor at `$HOME` alone contributes nothing", async () => {
    const { bed, userHome } = homeBed();
    const root = join(userHome, "p");
    put(join(root, ".winter", "settings.json"), json({ model: "project-model" }));
    put(join(root, ".winter", "settings.local.json"), json({ env: { LOCAL: "1" } }));
    const below = await buildRunHome(inputFor(bed, { cwd: root, trustedProjectRoot: root, gitRoot: root }), { userHome });
    expect(below.effectiveSettings).toEqual({ model: "project-model", env: { LOCAL: "1" } });
    const homeGit = await buildRunHome(inputFor(bed, { cwd: root, trustedProjectRoot: root, gitRoot: userHome }), { userHome });
    expect(homeGit.effectiveSettings).toEqual({ model: "project-model" });
  });
});

describe("per-tier refusals (F17) — a repository cannot promote a key claude only trusts from the user", () => {
  test("a project `skipDangerousModePermissionPrompt` is dropped; a user one is kept; a local one is kept (claude reads local)", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(root, ".winter", "settings.json"), json({ skipDangerousModePermissionPrompt: true }));
    expect((await effective(bed, root))["skipDangerousModePermissionPrompt"]).toBeUndefined();
    const bed2 = runHomeBed();
    put(join(bed2.sdk, "settings.json"), json({ skipDangerousModePermissionPrompt: true }));
    expect((await effective(bed2, null))["skipDangerousModePermissionPrompt"]).toBe(true);
    const bed3 = runHomeBed();
    const r3 = repo(bed3);
    put(join(r3.root, ".winter", "settings.local.json"), json({ skipDangerousModePermissionPrompt: true }));
    expect((await effective(bed3, r3.root))["skipDangerousModePermissionPrompt"]).toBe(true);
  });

  test("processWrapper, credential helpers, footer links, spellcheck and `autoMode` never come from a repository tier", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    const hostile = { processWrapper: "/tmp/wrap", apiKeyHelper: "/tmp/key", awsAuthRefresh: "x", proxyAuthHelper: "x", otelHeadersHelper: "x", footerLinksRegexes: ["x"], spellcheck: true, autoMode: { allow: ["x"] } };
    put(join(root, ".winter", "settings.json"), json(hostile));
    put(join(root, ".winter", "settings.local.json"), json(hostile));
    const settings = await effective(bed, root);
    for (const key of Object.keys(hostile)) expect([key, settings[key]]).toEqual([key, undefined]);
    for (const key of Object.keys(hostile)) expect(PROJECT_TIER_REFUSED_KEYS.project).toContain(key);
  });

  test('`permissions.defaultMode: "auto"` is refused from a repository tier; another mode is kept', async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(root, ".winter", "settings.json"), json({ permissions: { defaultMode: "auto" } }));
    expect((await effective(bed, root))["permissions"]).toBeUndefined();
    const bed2 = runHomeBed();
    const r2 = repo(bed2);
    put(join(r2.root, ".winter", "settings.json"), json({ permissions: { defaultMode: "acceptEdits" } }));
    expect((await effective(bed2, r2.root))["permissions"]).toEqual({ defaultMode: "acceptEdits" });
  });
});

describe("env (claude's per-tier filters, plus every variable the router sets)", () => {
  test("a project `env.HOME` is dropped (claude's project/local filter); a user one is not claude's to drop", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(root, ".winter", "settings.json"), json({ env: { HOME: "/evil", XDG_CONFIG_HOME: "/evil", OK_VAR: "1" } }));
    expect((await effective(bed, root))["env"]).toEqual({ OK_VAR: "1" });
  });

  test("`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_CRON` and every router-set variable are dropped even from the user tier (case-insensitively)", async () => {
    const bed = runHomeBed();
    put(
      join(bed.sdk, "settings.json"),
      json({
        env: {
          CLAUDE_CONFIG_DIR: "/x",
          claude_code_disable_cron: "0",
          CLAUDE_CODE_PLUGIN_CACHE_DIR: "/x",
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "0",
          CLAUDE_CODE_PROJECT_DIR_NAME: "x",
          WINTER_HOME: "/x",
          WINTER_STORE_HOME: "/x",
          WINTER_PLUGIN_CACHE_DIR: "/x",
          WINTER_PROVIDER_MANAGED_BY_HOST: "0",
          WINTER_DISABLE_CRON: "0",
          ANTHROPIC_API_KEY: "sk-planted",
          BASH_ENV: "/x",
          NODE_OPTIONS: "--require /x",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "0",
          KEEP_ME: "yes",
        },
      }),
    );
    expect((await effective(bed, null))["env"]).toEqual({ KEEP_ME: "yes" });
  });
});

describe("path anchoring (F17: `/x` is relative to the tier's own root; `//x` absolute; `~/x` $HOME)", () => {
  test("user → the sdk home, project → the project root, local → the git root; other rule forms untouched", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(bed.sdk, "settings.json"), json({ permissions: { deny: ["Read(/user-secrets)", "Read(//abs/x)", "Read(~/x)", "Read(./rel)", "Bash(/usr/bin/touch:*)"] } }));
    put(join(root, ".winter", "settings.json"), json({ permissions: { deny: ["Read(/secrets)", "Edit(/src/**)"] } }));
    put(join(root, ".winter", "settings.local.json"), json({ permissions: { ask: ["Write(/local-only)"] } }));
    const settings = (await effective(bed, root))["permissions"] as { deny: string[]; ask: string[] };
    expect(settings.deny).toEqual([
      `Read(${fsRootAnchored(join(bed.sdk, "user-secrets"))})`,
      "Read(//abs/x)",
      "Read(~/x)",
      "Read(./rel)",
      "Bash(/usr/bin/touch:*)",
      `Read(${fsRootAnchored(join(root, "secrets"))})`,
      `Edit(${fsRootAnchored(join(root, "src/**"))})`,
    ]);
    expect(settings.ask).toEqual([`Write(${fsRootAnchored(join(root, "local-only"))})`]);
  });

  test("the project tier anchors at the project root even when the cwd is below it (a deny keeps its author's meaning)", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    const cwd = join(root, "pkg");
    mkdirSync(cwd, { recursive: true });
    put(join(root, ".winter", "settings.json"), json({ permissions: { deny: ["Read(/secrets)"] } }));
    const runHome = await buildRunHome(inputFor(bed, { cwd, trustedProjectRoot: root, gitRoot: root }));
    expect((runHome.effectiveSettings["permissions"] as { deny: string[] }).deny).toEqual([`Read(${fsRootAnchored(join(root, "secrets"))})`]);
  });

  test("relative sandbox and additional-directory paths are made absolute against the tier's root", async () => {
    const bed = runHomeBed();
    const { root } = repo(bed);
    put(join(root, ".winter", "settings.json"), json({ permissions: { additionalDirectories: ["../shared", "/abs"] }, sandbox: { filesystem: { allowWrite: ["build", "~/cache", "/tmp/x"] } } }));
    const settings = await effective(bed, root);
    expect((settings["permissions"] as { additionalDirectories: string[] }).additionalDirectories).toEqual([join(bed.root, "shared"), "/abs"]);
    expect((settings["sandbox"] as { filesystem: { allowWrite: string[] } }).filesystem.allowWrite).toEqual([join(root, "build"), "~/cache", "/tmp/x"]);
  });
});

describe("per-mode stripping (spec §3.2) and the schema cut", () => {
  const everything = { permissions: { allow: ["Bash(ls)"], ask: ["Bash(rm:*)"], deny: ["Read(./x)"] }, hooks: { Stop: [] }, env: { A: "1" }, enabledPlugins: { "p@m": true }, outputStyle: "terse", model: "m" };

  test("chat and dispatch lose allow/ask/hooks/env/enabledPlugins/outputStyle and get autoMemoryEnabled: false", async () => {
    for (const mode of ["chat", "dispatch"] as const) {
      const bed = runHomeBed();
      put(join(bed.sdk, "settings.json"), json({ ...everything, autoMemoryEnabled: true }));
      const settings = await effective(bed, null, { mode });
      expect(settings).toEqual({ permissions: { deny: ["Read(./x)"] }, model: "m", autoMemoryEnabled: false });
    }
  });

  test("code keeps everything; a dispatch child loses only outputStyle", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "settings.json"), json(everything));
    expect(await effective(bed, null)).toEqual(everything);
    const child = await effective(bed, null, { dispatchChild: true });
    const { outputStyle: _dropped, ...rest } = everything;
    expect(child).toEqual(rest);
  });

  test("only claude-schema keys are written: `lsp`, `mcpServers` and Winter-only keys never appear", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "settings.json"), json({ lsp: { x: 1 }, mcpServers: { a: {} }, modelSlots: [], providers: {}, advisor: { model: "x" }, model: "m" }));
    expect(await effective(bed, null)).toEqual({ model: "m" });
  });
});

describe("the claude schema list is the pinned runtime's own (drift gate)", () => {
  test("CLAUDE_SETTINGS_KEYS equals the top-level keys of the installed sdk.d.ts `Settings` interface", () => {
    const require = createRequire(import.meta.url);
    const declaration = readFileSync(join(require.resolve("@anthropic-ai/claude-agent-sdk/package.json"), "..", "sdk.d.ts"), "utf8");
    const start = declaration.indexOf("export declare interface Settings {");
    expect(start).toBeGreaterThan(0);
    const keys: string[] = [];
    let depth = 0;
    for (const line of declaration.slice(start).split("\n")) {
      if (depth === 1) {
        const key = /^ {4}([A-Za-z$_][A-Za-z0-9_$]*)\??:/.exec(line)?.[1];
        if (key !== undefined) keys.push(key);
      }
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (depth === 0 && keys.length > 0) break;
    }
    expect([...CLAUDE_SETTINGS_KEYS].sort()).toEqual(keys.sort());
  });
});
