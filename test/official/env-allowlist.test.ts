// WS-14 §3/§12 + WS-17's drift gate: the child environment is an ALLOWLIST-BUILT REPLACEMENT, and
// the allowlist itself is a pinned fixture.
//
// Three kinds of assertion live here, and they answer three different questions:
//
//   1. WHAT GETS BUILT — the table in §3, produced from an `EnvInput` and nothing else.
//   2. WHAT IS REFUSED — every clause of §3's MUST-NOT list, each with its own case, because a
//      refusal that only fires for one of four reasons is three unprotected holes.
//   3. WHAT THE PINNED RUNTIME ACTUALLY CALLS THESE THINGS — §12: "Exact variable names are captured
//      per pinned version into the env-allowlist fixture, never assumed stable across upgrades." The
//      scan below reads the INSTALLED artifact (never a committed copy: WS-02 §2) and fails if a
//      name we inject has disappeared from it.
//
// The committed snapshot is the drift gate's input: a change to it is a reviewed compatibility event,
// which is why the fixture is a file in the diff rather than an inline object in this test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import { OfficialConfigurationError } from "../../src/official/errors.ts";
import {
  buildOfficialChildEnv,
  assertNoForbiddenChildVariables,
  minimalOsEnvironmentFrom,
  officialEnvAllowlistNames,
  officialEnvAllowlistSnapshot,
  type OfficialEnvInput,
} from "../../src/official/env-allowlist.ts";
import { fetchAuthCredentials, validateAuthEnvironment, authVariableSetKey, allowedAuthVariables } from "../../src/official/auth.ts";
import { createFakeKeychain } from "../../src/testing/index.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";

const selection = (over: Partial<RuntimeSelection> = {}): RuntimeSelection => ({
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "fixture",
  decidedAt: new Date(0).toISOString(),
  ...over,
});

const input = (over: Partial<OfficialEnvInput> = {}): OfficialEnvInput => ({
  selection: selection(),
  configDir: "/home/.acme/runtimes/official-agent-spool",
  brand: WINTER_BRAND,
  credentials: { ANTHROPIC_API_KEY: "sk-fixture" },
  ...over,
});

describe("WS-14 §3 — the child environment", () => {
  test("builds §3's table and nothing else; the OS set is filtered, not copied", () => {
    const env = buildOfficialChildEnv(
      input({
        projectKey: "project-key-9",
        sharedTempRoot: "/private/tmp/acme-501",
        base: { PATH: "/usr/bin", HOME: "/home/u", USER: "u", SHELL: "/bin/zsh", TERM: "xterm", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", EDITOR: "vim", SSH_AUTH_SOCK: "/tmp/agent" },
      }),
    );
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "sk-fixture",
      CLAUDE_CODE_PROJECT_DIR_NAME: "project-key-9",
      CLAUDE_CODE_TMPDIR: "/private/tmp/acme-501",
      CLAUDE_CONFIG_DIR: "/home/.acme/runtimes/official-agent-spool",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: "/usr/bin",
      SHELL: "/bin/zsh",
      TERM: "xterm",
      USER: "u",
    });
    // Keys come out sorted: this object is a golden-capture input.
    expect(Object.keys(env)).toEqual([...Object.keys(env)].sort());
  });

  test("the two per-session vendor variables are omitted when the host has no value for them", () => {
    const env = buildOfficialChildEnv(input());
    expect(Object.keys(env)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]);
  });

  test("nothing inherits: the OS set comes from a source the CALLER passes", () => {
    const picked = minimalOsEnvironmentFrom({ PATH: "/bin", LC_CTYPE: "C", AWS_SECRET_ACCESS_KEY: "leak", NOPE: undefined });
    expect(picked).toEqual({ PATH: "/bin", LC_CTYPE: "C" });
  });

  test("a config dir is required — an unknown transcript root is the failure §1 is about", () => {
    expect(() => buildOfficialChildEnv(input({ configDir: "" }))).toThrow(OfficialConfigurationError);
  });

  describe("§3's MUST-NOT list, one case per clause", () => {
    const brand = WINTER_BRAND;
    test("product/daemon variables (the brand's prefix, and the host's own)", () => {
      expect(() => assertNoForbiddenChildVariables({ [`${brand.envPrefix}HOME`]: "/x" }, { brand })).toThrow(/product\/daemon variables/);
      expect(() => assertNoForbiddenChildVariables({ NORMA_HOME: "/x" }, { brand, policy: { hostEnvPrefixes: ["NORMA_"] } })).toThrow(/product\/daemon variables/);
      // …and a host prefix it did NOT declare is refused anyway, by the CLOSED allowlist (review r1,
      // n1): §3 names `NORMA_*` literally, and a router that cannot know one host's daemon prefix
      // must not depend on a denylist to catch it.
      expect(() => assertNoForbiddenChildVariables({ NORMA_HOME: "/x" }, { brand })).toThrow(/not a variable this branch owns/);
    });
    test("the subscription OAuth token, always", () => {
      expect(() => assertNoForbiddenChildVariables({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, { brand })).toThrow(/never injected/);
    });
    test("undeclared proxy and telemetry variables, declared ones passing", () => {
      expect(() => assertNoForbiddenChildVariables({ HTTPS_PROXY: "http://p" }, { brand })).toThrow(/proxy and telemetry/);
      expect(() => assertNoForbiddenChildVariables({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c" }, { brand })).toThrow(/proxy and telemetry/);
      expect(() => assertNoForbiddenChildVariables({ HTTPS_PROXY: "http://p" }, { brand, policy: { configuredExtras: { HTTPS_PROXY: "http://p" } } })).not.toThrow();
    });
    test("ANY variable whose VALUE points into the vendor's user-level home", () => {
      expect(() => assertNoForbiddenChildVariables({ CLAUDE_CONFIG_DIR: "/Users/u/.claude" }, { brand })).toThrow(/vendor's user-level home/);
      expect(() => assertNoForbiddenChildVariables({ HOME: "/Users/u/.claude/plans" }, { brand })).toThrow(/vendor's user-level home/);
      // the spool and the vendor's own staging root are NOT under it
      expect(() => assertNoForbiddenChildVariables({ CLAUDE_CONFIG_DIR: "/Users/u/.winter/runtimes/official-agent-spool" }, { brand })).not.toThrow();
      expect(() => assertNoForbiddenChildVariables({ CLAUDE_CONFIG_DIR: "/tmp/claude-resume-abc" }, { brand })).not.toThrow();
    });
  });
});

describe("WS-14 §12 — exactly one auth family, fetched at spawn", () => {
  const branchLabel = "winter-claude-agent";

  test("the family's variable set is closed, and a stray name is refused by name", () => {
    expect(allowedAuthVariables(selection())).toEqual(["ANTHROPIC_API_KEY"]);
    expect(() => buildOfficialChildEnv(input({ credentials: { ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t" } }))).toThrow(/does not belong to the api-key family/);
  });

  test("the cloud chain splits by the PERSISTED providerId, never by an environment scan", () => {
    expect(authVariableSetKey(selection({ authFamily: "cloud-credential-chain", providerId: "bedrock" }))).toBe("bedrock");
    expect(authVariableSetKey(selection({ authFamily: "cloud-credential-chain", providerId: "google-vertex" }))).toBe("vertex");
    const env = buildOfficialChildEnv(
      input({
        selection: selection({ authFamily: "cloud-credential-chain", providerId: "bedrock" }),
        credentials: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "tok" },
      }),
    );
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(() =>
      buildOfficialChildEnv(input({ selection: selection({ authFamily: "cloud-credential-chain", providerId: "bedrock" }), credentials: { ANTHROPIC_VERTEX_PROJECT_ID: "p" } })),
    ).toThrow(/does not belong to/);
  });

  test("the gateway caveat: a base URL without its bearer token is refused (§12)", () => {
    const gateway = selection({ authFamily: "console-oauth", providerId: "anthropic-console" });
    expect(() => buildOfficialChildEnv(input({ selection: gateway, credentials: { ANTHROPIC_BASE_URL: "https://gw.example" } }))).toThrow(/leaves a stored subscription credential active/);
    expect(() => buildOfficialChildEnv(input({ selection: gateway, credentials: { ANTHROPIC_BASE_URL: "https://gw.example", ANTHROPIC_AUTH_TOKEN: "t" } }))).not.toThrow();
  });

  test("review r1, M1: `configuredExtras` cannot smuggle a SECOND family, or shadow a variable we own", () => {
    // The reviewer's plant 3, verbatim: an `api-key` session whose extras carry the bearer pair. The
    // runtime's precedence puts the token above the key, so this silently re-points the whole session.
    expect(() =>
      buildOfficialChildEnv(input({ credentials: { ANTHROPIC_API_KEY: "k" } }), { configuredExtras: { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw" } }),
    ).toThrow(/outside this session's api-key family/);
    // Plant 4: the same door pointed at the transcript root.
    expect(() => buildOfficialChildEnv(input(), { configuredExtras: { CLAUDE_CONFIG_DIR: "/Users/dev/elsewhere" } })).toThrow(/may not override a variable this branch owns/);
    expect(() => buildOfficialChildEnv(input(), { configuredExtras: { CLAUDE_CODE_TMPDIR: "/tmp/elsewhere" } })).toThrow(/may not override a variable this branch owns/);
    // A declared extra that is neither a credential nor ours is still the documented door.
    expect(buildOfficialChildEnv(input(), { configuredExtras: { HTTPS_PROXY: "http://corp" } })["HTTPS_PROXY"]).toBe("http://corp");
    // …and the `custom` family is the one whose credential set is open by design.
    expect(() =>
      buildOfficialChildEnv(input({ selection: selection({ authFamily: "custom" }), credentials: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } })),
    ).not.toThrow();
  });

  test("Claude OAuth is ship-gated (D14) and injects NO variable even when approved", () => {
    const oauth = selection({ authFamily: "claude-oauth" });
    expect(() => buildOfficialChildEnv(input({ selection: oauth, credentials: {} }))).toThrow(/ship-gated/);
    expect(() => buildOfficialChildEnv(input({ selection: oauth, credentials: {} }), { claudeOauth: { approved: true } })).not.toThrow();
    expect(() => buildOfficialChildEnv(input({ selection: oauth, credentials: { ANTHROPIC_API_KEY: "k" } }), { claudeOauth: { approved: true } })).toThrow(/injects NO credential variable/);
    // and the token itself is refused whatever the gate says
    expect(() => validateAuthEnvironment({ selection: oauth, credentials: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, gate: { approved: true }, branchLabel })).toThrow(/never injected/);
  });

  test("credentials are read from the KEYCHAIN SEAM at spawn, and a missing one is typed", async () => {
    const keychain = createFakeKeychain([{ ref: { kind: "keychain", service: "com.acme.core", account: "anthropic" }, material: "sk-live" }]);
    const fetched = await fetchAuthCredentials({
      plan: [{ variable: "ANTHROPIC_API_KEY", ref: { kind: "keychain", service: "com.acme.core", account: "anthropic" } }],
      keychain,
      branchLabel,
    });
    expect(fetched).toEqual({ ANTHROPIC_API_KEY: "sk-live" });
    expect(keychain.reads).toHaveLength(1);
    await expect(
      fetchAuthCredentials({ plan: [{ variable: "ANTHROPIC_API_KEY", ref: { kind: "keychain", service: "com.acme.core", account: "missing" } }], keychain, branchLabel }),
    ).rejects.toThrow(OfficialConfigurationError);
  });
});

describe("WS-17's drift gate — the allowlist snapshot", () => {
  const snapshotPath = join(import.meta.dir, "fixtures", "env-allowlist.snapshot.json");

  test("matches the committed fixture (a change here is a reviewed compatibility event)", () => {
    const committed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
    expect(officialEnvAllowlistSnapshot()).toEqual(committed as ReturnType<typeof officialEnvAllowlistSnapshot>);
  });

  test("carries NAMES only — a fixture that held a value would put a credential in the repository", () => {
    const serialized = JSON.stringify(officialEnvAllowlistSnapshot());
    expect(serialized).not.toContain("sk-");
    for (const name of officialEnvAllowlistNames()) expect(serialized).toContain(name);
  });

  test("every injected name still exists in the PINNED runtime artifact (§12's capture rule)", () => {
    // Read the INSTALLED artifact — never a committed copy of it (WS-02 §2).
    const officialPkg = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const artifact = readFileSync(join(dirname(officialPkg), "sdk.mjs"), "utf8");
    const missing = officialEnvAllowlistNames().filter((name) => !artifact.includes(name));
    expect(missing).toEqual([]);
    // Non-vacuity: a name we invented is NOT in there, so the scan discriminates.
    expect(artifact.includes("ANTHROPIC_NOT_A_REAL_VARIABLE")).toBe(false);
  });
});
