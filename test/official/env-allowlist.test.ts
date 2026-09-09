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
  EXECUTION_INDIRECTION_ENV_NAMES,
  isExecutionIndirectionVariable,
  assertNoForbiddenChildVariables,
  minimalOsEnvironmentFrom,
  officialEnvAllowlistNames,
  officialEnvAllowlistSnapshot,
  sanitizePathListValue,
  TRAFFIC_OPT_OUT_VARIABLES,
  TRAFFIC_OPT_OUT_VARIABLE_NAMES,
  type OfficialEnvInput,
} from "../../src/official/env-allowlist.ts";
import { fetchAuthCredentials, validateAuthEnvironment, authVariableSetKey, allowedAuthVariables } from "../../src/official/auth.ts";
import { NON_CREDENTIAL_ENV_REGISTRY, PINNED_ENV_REGISTRY_SIZE } from "../../src/official/env-registry.ts";
import { extractEnvRegistry, isCredentialByName } from "../../src/official/env-registry-rule.ts";
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
      // R-7b-11's four, set by the BUILDER on every child unless `remoteConfig: "allow"` says otherwise.
      ...TRAFFIC_OPT_OUT_VARIABLES,
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
    expect(Object.keys(env)).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", ...TRAFFIC_OPT_OUT_VARIABLE_NAMES].sort());
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
      // review r3, NEW-10: a proxy is credential-bearing by the artifact's own classification, so the
      // DECLARED form now needs the reviewed hatch as well — declaring it is no longer enough.
      expect(() => assertNoForbiddenChildVariables({ HTTPS_PROXY: "http://p" }, { brand, policy: { configuredExtras: { HTTPS_PROXY: "http://p" }, reviewedCredentialShapedExtras: ["HTTPS_PROXY"] } })).not.toThrow();
    });
    test("ANY variable whose VALUE points into the vendor's user-level home", () => {
      expect(() => assertNoForbiddenChildVariables({ CLAUDE_CONFIG_DIR: "/Users/u/.claude" }, { brand })).toThrow(/vendor's user-level home/);
      expect(() => assertNoForbiddenChildVariables({ HOME: "/Users/u/.claude/plans" }, { brand })).toThrow(/vendor's user-level home/);
      // review r2, NEW-4: the same name in ANY casing, on the filesystem where they are one directory.
      expect(() => assertNoForbiddenChildVariables({ HOME: "/Users/u/.Claude/ca.pem" }, { brand })).toThrow(/vendor's user-level home/);
      expect(() => assertNoForbiddenChildVariables({ HOME: "/Users/u/.CLAUDE" }, { brand })).toThrow(/vendor's user-level home/);
      expect(sanitizePathListValue("/usr/bin:/Users/d/.Claude/plugins/x/bin:/bin")).toBe("/usr/bin:/bin");
      expect(sanitizePathListValue("/usr/bin:/Users/d/.claude/plugins/x/bin:/bin")).toBe("/usr/bin:/bin");
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
    // A declared extra that is neither a credential nor ours is still the documented door — and after
    // review r3's NEW-10 that means a name the artifact's own registry classifies as non-credential.
    expect(buildOfficialChildEnv(input(), { configuredExtras: { NO_COLOR: "1" } })["NO_COLOR"]).toBe("1");
    // …and the `custom` family is the one whose credential set is open by design.
    expect(() =>
      buildOfficialChildEnv(input({ selection: selection({ authFamily: "custom" }), credentials: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } })),
    ).not.toThrow();
  });

  test("review r2, NEW-2: the extras door refuses every credential-SHAPED variable, whatever the tables list", () => {
    const vectors: Array<[string, Record<string, string>]> = [
      ["r1 plant 3 (the bearer pair)", { ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "https://gw" }],
      ["an Authorization header, wholesale", { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer sk-ant-oat01-SECOND-ACCOUNT" }],
      ["a whole Foundry family", { CLAUDE_CODE_USE_FOUNDRY: "1", ANTHROPIC_FOUNDRY_API_KEY: "k", ANTHROPIC_FOUNDRY_BASE_URL: "https://f" }],
      ["Mantle", { CLAUDE_CODE_USE_MANTLE: "1", ANTHROPIC_BEDROCK_MANTLE_BASE_URL: "https://m" }],
      ["the identity tier", { ANTHROPIC_IDENTITY_TOKEN: "t", ANTHROPIC_PROFILE: "p", ANTHROPIC_SCOPE: "s" }],
      ["host creds", { CLAUDE_CODE_HOST_CREDS_FILE: "/creds.json" }],
      ["an OAuth refresh pair (around D14)", { CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "t", CLAUDE_CODE_OAUTH_CLIENT_ID: "c" }],
      ["the gateway switch", { CLAUDE_CODE_USE_GATEWAY: "1" }],
      ["the sibling config dirs", { ANTHROPIC_CONFIG_DIR: "/d", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/d" }],
    ];
    for (const [label, extras] of vectors) {
      let refused = false;
      try {
        buildOfficialChildEnv(input({ credentials: { ANTHROPIC_API_KEY: "k" } }), { configuredExtras: extras });
      } catch {
        refused = true;
      }
      expect([label, refused]).toEqual([label, true]);
    }
    // The SELECTED family's own variable rides the door, and so does an ordinary non-credential one.
    expect(buildOfficialChildEnv(input({ credentials: {} }), { configuredExtras: { ANTHROPIC_API_KEY: "k" } })["ANTHROPIC_API_KEY"]).toBe("k");
    // A proxy is CREDENTIAL-BEARING by the artifact's own classification (review r3, NEW-10), so it
    // rides only through the reviewed hatch now — the door itself is a positive allowlist.
    expect(buildOfficialChildEnv(input(), { configuredExtras: { HTTPS_PROXY: "http://corp" }, reviewedCredentialShapedExtras: ["HTTPS_PROXY"] })["HTTPS_PROXY"]).toBe("http://corp");
    // …and a deployment that has REVIEWED one names it, which is §12's reviewed compatibility event.
    expect(
      buildOfficialChildEnv(input(), { configuredExtras: { ANTHROPIC_BEDROCK_REGION_PREFIX: "eu" }, reviewedCredentialShapedExtras: ["ANTHROPIC_BEDROCK_REGION_PREFIX"] })["ANTHROPIC_BEDROCK_REGION_PREFIX"],
    ).toBe("eu");
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

  test("review r3, NEW-10: the extras door is a POSITIVE allowlist — every credential-bearing registry name is refused", () => {
    // The reviewer's seventeen, plus the lowercase twin and the two r2 stragglers. Each is a name the
    // artifact's OWN registry declares an accessor for, and each rode the door when it was a denylist.
    const credentialBearing = [
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_CLIENT_CERT",
      "CLAUDE_CODE_CLIENT_KEY",
      "CLAUDE_CODE_CERT_STORE",
      "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
      "CLAUDE_CODE_CUSTOM_OAUTH_URL",
      "CLAUDE_CODE_USE_LOCAL_OAUTH",
      "CLAUDE_CODE_USE_STAGING_OAUTH",
      "CLAUDE_CODE_MCP_OAUTH_CLIENT_METADATA_URL",
      "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
      "CLAUDE_BG_SOCKET_TOKENS_PATH",
      "CLAUDE_BG_CLAIM_AUTH",
      "CLAUDE_BG_PTY_AUTH",
      "CLAUDE_BG_RV_AUTH",
      "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER",
      "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN",
      "ENVIRONMENT_SERVICE_KEY",
      "NODE_EXTRA_CA_CERTS",
      "SSL_CERT_FILE",
      // The sharpest one: its UPPERCASE twin is in the vertex family table and correctly refused on an
      // api-key session, while this spelling rode the door by case alone.
      "google_application_credentials",
      "anthropic_api_key",
      "ANTHROPIC_CUSTOM_HEADERS",
    ];
    const accepted = credentialBearing.filter((name) => {
      try {
        buildOfficialChildEnv(input({ credentials: { ANTHROPIC_API_KEY: "k" } }), { configuredExtras: { [name]: "x" } });
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);

    // An UNKNOWN name — one the registry never declares — is refused too: nothing classified it.
    expect(() => buildOfficialChildEnv(input(), { configuredExtras: { SOME_HOST_INVENTION: "x" } })).toThrow(/positive allowlist/);
    // …while a genuinely non-credential registry name rides, and so does the family's own variable.
    expect(buildOfficialChildEnv(input({ credentials: {} }), { configuredExtras: { NO_COLOR: "1" } })["NO_COLOR"]).toBe("1");
    expect(buildOfficialChildEnv(input({ credentials: {} }), { configuredExtras: { ANTHROPIC_API_KEY: "k" } })["ANTHROPIC_API_KEY"]).toBe("k");
    // …and the reviewed hatch still opens for a deployment that has looked at one.
    expect(buildOfficialChildEnv(input(), { configuredExtras: { HTTPS_PROXY: "http://corp" }, reviewedCredentialShapedExtras: ["HTTPS_PROXY"] })["HTTPS_PROXY"]).toBe("http://corp");
  });

  test("review r3, NEW-10: the drift gate re-derives the allowlist from the artifact and fails on a difference", () => {
    // THE SELECTOR IS NOT THE CLASSIFIER. The r2 test chose its universe with the same predicate it
    // asserted, so it could not fail for any regex. This one re-runs the INDEPENDENT extraction and
    // classification over the installed artifact and compares the RESULT with the committed file, so a
    // runtime upgrade that adds a credential accessor — or removes a benign one — breaks a test.
    const officialPkg = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const artifact = readFileSync(join(dirname(officialPkg), "sdk.mjs"), "utf8");
    const registry = extractEnvRegistry(artifact);
    expect(registry.length).toBe(PINNED_ENV_REGISTRY_SIZE);
    expect(registry.length).toBeGreaterThan(500); // non-vacuity: the extraction really found the registry
    const derived = registry.filter((name) => !isCredentialByName(name)).sort();
    expect(derived).toEqual([...NON_CREDENTIAL_ENV_REGISTRY]);
    // The classifier is not vacuous either: it must reject a fair share of what it is shown.
    expect(registry.length - derived.length).toBeGreaterThan(100);
    // …and it classifies the names this round was about.
    for (const name of ["CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_CLIENT_CERT", "NODE_EXTRA_CA_CERTS", "google_application_credentials"]) {
      expect([name, isCredentialByName(name)]).toEqual([name, true]);
    }
    expect(isCredentialByName("NO_COLOR")).toBe(false);
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

// ====================================================================================================
// ITEM 22 / NEW-A — THE NAMES THAT CHANGE HOW THE CHILD EXECUTES CODE OR AUTHENTICATES.
//
// The extras door had two rules and BOTH were blind to this class. The credential rule is a SHAPE rule
// and none of these names looks like a credential; the positive-allowlist rule admits any name the
// pinned artifact's own registry declares — and `BASH_ENV`, `CLAUDE_CODE_SHELL_PREFIX`,
// `NODE_OPTIONS`, `GIT_ASKPASS` and `CLAUDE_CODE_GIT_BASH_PATH` are ALL declared there, because the
// runtime really does read them. "The artifact reads it" is why the registry lists it and why it is
// dangerous, which is exactly why it cannot be the whole test.
//
// The exposure was bounded — the `base` door drops these silently, so only a host naming one itself
// could pass it — but the README told hosts the door refused what it admitted, and a false
// host-facing security claim is the one state that must not ship.
// ====================================================================================================
describe("item 22 / NEW-H — the execution/indirection class is refused BY NAME, and the set is the artifact's own", () => {
  const planted = (name: string) => ({ configuredExtras: { [name]: "/tmp/planted" } });
  const refusalFor = (name: string, policy = planted(name)): string => {
    try {
      buildOfficialChildEnv(input(), policy);
      return "ADMITTED";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  // ==================================================================================================
  // THE CLASS, AS A NAME PATTERN — the drift gate's own predicate.
  //
  // It is deliberately WIDER than the refused set and is not used by the door: its job is to select
  // the registry names a human must have CLASSIFIED, so that a pin bump adding
  // `CLAUDE_CODE_NEW_SHELL_THING` fails here until someone decides which side it is on. A name it
  // selects must either be refused (by any rule) or appear in the acknowledged list below WITH a
  // reason. That is the difference between a set that was right once and a set that stays right.
  // ==================================================================================================
  const EXECUTION_CLASS_PATTERN =
    /(^|_)(SHELL|ENV_FILE|ASKPASS|PRELOAD|OPTIONS|OPTS)$|SHELL_|_SHELL$|ENV_FILE|ASKPASS|PRELOAD|_OPTIONS$|_OPTS$|CONFIG_FILE|USERCONFIG|GLOBALCONFIG|SETTINGS_PATH|_BIN$|_BINARY$|PLUGIN_.*DIR|^GIT_|^LD_|^DYLD_|^PYTHON|^PERL5|^RUBY|^LUA_|^DOTNET_|^COMPLUS_|^COR_|^CORECLR_|^APPDOMAIN_MANAGER_|^BASH_FUNC|_PATH$|^CLASSPATH$|^IFS$|^CDPATH$|^FPATH$|^ZDOTDIR$|^COMSPEC$|^PS4$|CONFIG$|^ENV$|SETTINGS$/;

  /** Registry names the pattern selects that are NOT of this class, each with the reason it is not. */
  const ACKNOWLEDGED_NOT_EXECUTION: ReadonlyArray<{ name: string; because: string }> = [
    { name: "CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP", because: "a boolean toggle for background-shell reaping; it names no file and no program" },
    { name: "CLAUDE_CODE_POWERSHELL_RESPECT_EXECUTION_POLICY", because: "a boolean; it changes how the runtime treats an OS policy, not what it executes" },
    { name: "CLAUDE_CODE_USE_POWERSHELL_TOOL", because: "a boolean feature flag selecting a built-in tool, not a program path" },
    { name: "CLAUDE_SUBAGENT_BG_SHELL_MAX_MS", because: "a duration in milliseconds" },
    { name: "EMPTY_PATH", because: "the runtime's own sentinel for an empty search path; it is read, never executed" },
    { name: "GITHUB_ACTION_PATH", because: "a CI-provided data path the runtime reads for context; the runner sets it, and it names no interpreter" },
    { name: "GITHUB_EVENT_PATH", because: "a CI-provided JSON event file the runtime reads as data" },
  ];

  test("every registry name of this class is REFUSED, or is acknowledged with a reason", () => {
    const acknowledged = new Set(ACKNOWLEDGED_NOT_EXECUTION.map((entry) => entry.name));
    const selected = NON_CREDENTIAL_ENV_REGISTRY.filter((name) => EXECUTION_CLASS_PATTERN.test(name.toUpperCase()));
    // NOT VACUOUS: the pattern really selects a substantial slice of the registry.
    expect(selected.length).toBeGreaterThan(20);
    const unclassified = selected.filter((name) => refusalFor(name) === "ADMITTED" && !acknowledged.has(name));
    // A pin bump that adds a shell/loader/askpass/config-file name fails HERE until it is classified.
    expect(unclassified).toEqual([]);
    // …and the acknowledgements are live: every one is still in the registry and still admitted, so a
    // name that quietly became refused (or vanished) does not sit here forever as dead prose.
    for (const entry of ACKNOWLEDGED_NOT_EXECUTION) {
      expect({ name: entry.name, inRegistry: NON_CREDENTIAL_ENV_REGISTRY.includes(entry.name) }).toEqual({ name: entry.name, inRegistry: true });
      expect(entry.because.length).toBeGreaterThan(20);
    }
  });

  test("the whole `registry ∩ refused set` is planted, one name at a time, and every one is refused explicitly", () => {
    const intersection = NON_CREDENTIAL_ENV_REGISTRY.filter((name) => isExecutionIndirectionVariable(name)).sort();
    // The two the review MEASURED on the pin are in it — the plants that made this finding.
    expect(intersection).toContain("CLAUDE_CODE_SHELL");
    expect(intersection).toContain("CLAUDE_ENV_FILE");
    expect(intersection.length).toBeGreaterThan(25);
    const admitted = intersection.filter((name) => !refusalFor(name).includes("refused explicitly"));
    expect(admitted).toEqual([]);
  });

  test("the two names measured on the pin do not reach the child — the planted program must NOT run", () => {
    // MEASURED on 0.3.250 before this set was widened, through this exact door:
    //   * `CLAUDE_CODE_SHELL=<a path containing "bash">` → the runtime ran the planted program as the
    //     Bash tool's shell, 114 times in one session, and its marker appeared in the tool result the
    //     model was shown (`shell=/bin/bash` where the control shows `/bin/zsh`).
    //   * `CLAUDE_ENV_FILE=<a script>` → the script was sourced into the Bash tool's environment on
    //     every call, i.e. `BASH_ENV` through a different name — which is why refusing `BASH_ENV`
    //     while admitting this one refused nothing at all.
    // The assertion is the negative that makes those measurements impossible: the value never reaches
    // the built environment, because building it throws.
    for (const name of ["CLAUDE_CODE_SHELL", "CLAUDE_ENV_FILE"]) {
      expect(refusalFor(name)).toContain("refused explicitly");
      expect(() => buildOfficialChildEnv(input(), planted(name))).toThrow(/EXECUTES code/);
    }
  });

  test("the loader PREFIXES are refused too, because no closed list can enumerate them", () => {
    for (const name of ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_FRAMEWORK_PATH", "PYTHONSTARTUP", "PERL5OPT", "GIT_CONFIG_GLOBAL", "BASH_FUNC_x%%"]) {
      expect(refusalFor(name)).toContain("refused explicitly");
      expect(isExecutionIndirectionVariable(name)).toBe(true);
    }
  });

  test("matching is case-insensitive, because a differently-cased spelling is the same program", () => {
    expect(refusalFor("bash_env")).toContain("refused explicitly");
    expect(refusalFor("ld_preload")).toContain("refused explicitly");
    expect(refusalFor("claude_env_file")).toContain("refused explicitly");
  });

  test("the check runs BEFORE the registry rule — which is the whole fix", () => {
    // `BASH_ENV` is IN the pinned artifact's own non-credential registry, so a check placed after the
    // positive-allowlist rule would never fire. This is the assertion that pins the ORDER.
    expect(NON_CREDENTIAL_ENV_REGISTRY.map((name) => name.toUpperCase())).toContain("BASH_ENV");
    const refusal = refusalFor("BASH_ENV");
    expect(refusal).toContain("refused explicitly");
    expect(refusal).toContain("EXECUTES code");
    // …and it is not the positive-allowlist refusal wearing a different hat.
    expect(refusal).not.toContain("positive allowlist");
  });

  test("a REVIEWED name still gets through, one name at a time — it is a door, not a wall", () => {
    expect(buildOfficialChildEnv(input(), { configuredExtras: { NODE_OPTIONS: "--max-old-space-size=4096" }, reviewedExecutionExtras: ["NODE_OPTIONS"] })["NODE_OPTIONS"]).toBe("--max-old-space-size=4096");
    // Reviewing one does NOT review its neighbours.
    expect(() => buildOfficialChildEnv(input(), { configuredExtras: { NODE_OPTIONS: "-r /tmp/x", CLAUDE_ENV_FILE: "/tmp/y" }, reviewedExecutionExtras: ["NODE_OPTIONS"] })).toThrow(/refused explicitly/);
    // …and the two hatches do not leak into each other.
    expect(() => buildOfficialChildEnv(input(), { configuredExtras: { BASH_ENV: "/tmp/x" }, reviewedCredentialShapedExtras: ["BASH_ENV"] })).toThrow(/refused explicitly/);
  });

  test("an ordinary non-credential extra is unaffected", () => {
    expect(buildOfficialChildEnv(input(), { configuredExtras: { NO_COLOR: "1" } })["NO_COLOR"]).toBe("1");
  });
});

// ====================================================================================================
// R-7b-11 — THE PRODUCTION CHILD IS THE PIN'S CHILD.
//
// The four opt-outs used to be a TEST-BED habit (`configuredExtras` in `test/official/support.ts`),
// which made every hermetic proof honest and every shipped session remotely mutable under the same
// pin. They are now built-in, and the escape is one named policy value whose answer is recorded on
// the session's directory row.
// ====================================================================================================
describe("R-7b-11 — the traffic opt-outs are the production default", () => {
  test("every child gets all four, without the host asking for anything", () => {
    const env = buildOfficialChildEnv(input());
    for (const [name, value] of Object.entries(TRAFFIC_OPT_OUT_VARIABLES)) expect({ name, value: env[name] }).toEqual({ name, value });
  });

  test("`remoteConfig: \"allow\"` removes all four — and nothing else changes", () => {
    const denied = buildOfficialChildEnv(input());
    const allowed = buildOfficialChildEnv(input(), { remoteConfig: "allow" });
    for (const name of TRAFFIC_OPT_OUT_VARIABLE_NAMES) expect({ name, present: name in allowed }).toEqual({ name, present: false });
    expect(Object.keys(allowed)).toEqual(Object.keys(denied).filter((name) => !TRAFFIC_OPT_OUT_VARIABLE_NAMES.includes(name)));
  });

  test("the extras door refuses them by name and points at the knob whose answer is recorded", () => {
    for (const name of TRAFFIC_OPT_OUT_VARIABLE_NAMES) {
      expect(() => buildOfficialChildEnv(input(), { configuredExtras: { [name]: "0" } })).toThrow(/remoteConfig/);
    }
  });

  test("they are still names the PINNED artifact's own registry declares", () => {
    // Not load-bearing for the door any more (they are branch-owned, not extras) — but if a pin bump
    // dropped one, the variable would be inert and the child would silently regain the CDN's surface.
    const folded = new Set(NON_CREDENTIAL_ENV_REGISTRY.map((name) => name.toUpperCase()));
    for (const name of TRAFFIC_OPT_OUT_VARIABLE_NAMES) expect({ name, declared: folded.has(name) }).toEqual({ name, declared: true });
  });
});
