// THE ENVIRONMENT NAMES A RUN HOME REFUSES TO LET A SETTINGS FILE SET (WS-21 §3.4), and the sets the
// README tells a host to READ rather than trust a description of.
//
// WS-23: these tables used to live in the official leg's modules (`official/auth.ts`,
// `official/env-allowlist.ts`), which built the `claude` child's environment from them. That leg is
// gone; the run home is still in claude's formats and the Winter runtime still reads a settings
// file's `env` block, so the same names still decide what `run-home/settings.ts` drops from one. They
// moved here VERBATIM — same names, same values, same measurements behind them — so nothing a run
// home refused before is admitted now. The "this branch" wording in the comments below is the retired
// branch's; the refusals themselves are the run home's.

/**
 * The credential-shaped variables ONE auth family may set, per §12's table.
 *
 * `cloud-credential-chain` is deliberately split by provider: Bedrock and Vertex are two different
 * variable sets and a session is on one of them, never both. The split key is `providerId`, which is
 * the persisted selection's own field — never an ambient scan of the environment (WS-14's Phase 6
 * amendment: "a pinned alias resolves to the `anthropic` provider ONLY when a credential ref for it
 * is configured, and never by ambient environment scan").
 */
export const AUTH_FAMILY_VARIABLES = {
  "api-key": ["ANTHROPIC_API_KEY"],
  /**
   * A bearer credential (Console OAuth, or an approved gateway).
   *
   * THE FULL PAIR, ALWAYS — §12's gateway caveat: "an explicit gateway credential replaces
   * subscription login, but `ANTHROPIC_BASE_URL` alone can leave a stored OAuth credential active;
   * gateway configs MUST set the full credential pair." So the endpoint is part of this family's set
   * rather than a separate knob, and the validator below refuses a base URL with no token.
   */
  "console-oauth": ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  bedrock: ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
  vertex: ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_VERTEX_BASE_URL"],
  /**
   * router 0.0.4, C1: the Anthropic Console CLI's own PROFILE. Both names are NON-SECRET (a profile
   * name and a directory path, not material) and NEITHER is a bearer credential — the profile store the
   * CLI already manages at `ANTHROPIC_CONFIG_DIR` owns the token, so this family injects nothing that
   * could re-point billing by itself. `officialCredentialPlan` (`door.ts`) treats it exactly like
   * `claude-oauth`/`local-none`: an EMPTY plan, even when `provider.authRef` resolves to material, so a
   * host that also has an API key configured never leaks it in here by accident. `ANTHROPIC_API_KEY`
   * and `ANTHROPIC_AUTH_TOKEN` are refused for this family by the same family-membership check every
   * other row already gets (§12's "exactly one auth family").
   */
  "console-profile": ["ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR"],
  /**
   * §12's last row: NONE. "Claude OAuth (D14-gated) — stored subscription credentials live inside the
   * spool namespace; no env credential injected." The empty set is the rule, not an oversight.
   */
  "claude-oauth": [],
  /** A runtime with no credential at all (a local endpoint). Nothing to inject. */
  "local-none": [],
} as const satisfies Record<string, readonly string[]>;

/** `AUTH_FAMILY_VARIABLES`' keys. */
export type AuthVariableSetKey = keyof typeof AUTH_FAMILY_VARIABLES;

/** Every credential-shaped name any family may set — the env allowlist's auth section. */
export const ALL_AUTH_VARIABLES: readonly string[] = Object.values(AUTH_FAMILY_VARIABLES).flat().filter((name, index, all) => all.indexOf(name) === index);

/**
 * NEVER INJECTED, on any branch, in any family (§3, §5.1, §12; WS-01 §2.5).
 *
 * The subscription OAuth token is the one credential the runtime can pick up from the environment
 * that Winter must never place there: D14 gates the OAuth branch entirely, and the supported flow
 * puts its stored credentials INSIDE THE SPOOL rather than in a variable.
 */
export const NEVER_INJECTED_AUTH_VARIABLES: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN"];

/**
 * The vendor-named variables this branch sets itself (§1/§3). Claude-mirroring literals (WS-01 §5).
 *
 * BRANCH-OWNED, which is the property that matters: a name here is refused from `configuredExtras`
 * ("a configured extra may not override a variable this branch owns") and is known to the closed
 * allowlist whether or not a given launch sets it. The last three are WS-21's (spec §3.1) and are set
 * only for a run-home launch: the shared plugin root, the host-managed provider switch (F20) and the
 * cron switch (F19a). `CLAUDE_CODE_PLUGIN_CACHE_DIR` moved here from the execution-indirection list —
 * it is still refused from every other source, now as a variable the router sets itself.
 */
export const OFFICIAL_RUNTIME_VARIABLES = {
  configDir: "CLAUDE_CONFIG_DIR",
  projectDirName: "CLAUDE_CODE_PROJECT_DIR_NAME",
  tmpdir: "CLAUDE_CODE_TMPDIR",
  pluginCacheDir: "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  providerManagedByHost: "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  disableCron: "CLAUDE_CODE_DISABLE_CRON",
} as const;

/**
 * R-7b-11: THE FOUR TRAFFIC OPT-OUTS THIS BRANCH SETS ON EVERY CHILD, BY DEFAULT.
 *
 * These are not a privacy setting; they are what makes "the pinned artifact" mean one thing. Measured
 * on 0.3.250 — same binary, same options, same loopback endpoint — the runtime advertises 25 tools
 * with these unset and 21 with them set; `DesignSync`, `Monitor`, `PushNotification` and
 * `advisor_20260301:advisor` are present only when its feature-flag CDN answers. A tool surface that
 * changes with a remote flag under one version defeats WS-02 §6.1's "a new official version is a
 * reviewed compatibility event": the surface moves with nothing reviewed and nothing versioned.
 *
 * WS-14 §3's own words permit this — proxy and telemetry variables reach the child "unless explicitly
 * configured", and the router configuring them explicitly is that clause, not an exception to it. Two
 * of the four names (`DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING`) are in
 * `PROXY_AND_TELEMETRY_VARIABLES`, i.e. names this module refuses to let a child INHERIT — which is a
 * different question from whether this branch SETS them, and the validator below now separates the
 * two rather than conflating them.
 *
 * THEY ARE BRANCH-OWNED, like the config dir: a host may not pass them through `configuredExtras`
 * (the record would then disagree with the environment), it opts back in with
 * `OfficialEnvPolicy.remoteConfig: "allow"`, and that choice is recorded on the session's directory
 * row. A test-only escape hatch is not needed any more — the hermetic beds get this for free.
 */
export const TRAFFIC_OPT_OUT_VARIABLES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
};

/** The four names above, for the validator and the drift-gate snapshot. */
export const TRAFFIC_OPT_OUT_VARIABLE_NAMES: readonly string[] = Object.keys(TRAFFIC_OPT_OUT_VARIABLES);

/**
 * NAMES THAT CHANGE HOW THE CHILD EXECUTES CODE OR AUTHENTICATES — refused by NAME, always (item 22,
 * fix-wave re-review NEW-A).
 *
 * WHY A LITERAL SET AND NOT A RULE. The extras door already has two rules and BOTH are blind here.
 * The credential rule is a SHAPE rule (`_KEY`, `TOKEN`, `OAUTH`, …) and none of these names looks
 * like a credential; the positive-allowlist rule admits any name the pinned artifact's own registry
 * declares, and all five of the headline names below ARE declared there — the artifact reads them, so
 * the registry is right to list them, and that is precisely why "the registry declares it" cannot be
 * the whole test. Measured on the head before this set existed: `BASH_ENV`,
 * `CLAUDE_CODE_SHELL_PREFIX`, `NODE_OPTIONS`, `GIT_ASKPASS` and `CLAUDE_CODE_GIT_BASH_PATH` were all
 * ADMITTED through `configuredExtras`, while the README told hosts they were refused.
 *
 * WHAT THESE NAMES DO, which is the reason they are one class:
 *
 *   * `BASH_ENV` / `ENV` / `CLAUDE_CODE_SHELL_PREFIX` — a file the shell SOURCES on every
 *     non-interactive start, or a prefix wrapped around every command. Arbitrary code before any
 *     command the containment floor ever sees.
 *   * `NODE_OPTIONS` / `LD_PRELOAD` / `LD_*` / `DYLD_*` — loader and runtime hooks. `--require` runs
 *     a module inside the child before its own entry point.
 *   * `GIT_ASKPASS` / `SSH_ASKPASS` / `SUDO_ASKPASS` / `GIT_SSH*` / `GIT_CREDENTIAL_HELPER` — programs
 *     the child EXECUTES to obtain credentials. Not credential-shaped; credential-producing.
 *
 * THE SET IS THE ARTIFACT'S OWN, NOT OURS (round 3, NEW-H). The first version named five measured
 * headline variables and the README described the CLASS — which was wider than the set: nineteen more
 * registry names of exactly that class rode the door, and two were then measured doing what the class
 * describes. `CLAUDE_CODE_SHELL` made the runtime run a planted program as the Bash tool's shell (114
 * invocations in one session, the marker visible in the tool result the model was shown), and
 * `CLAUDE_ENV_FILE` was sourced into every Bash call — `BASH_ENV` by another door, which made the
 * `BASH_ENV` refusal decorative. So the list below is the PINNED ARTIFACT'S OWN scrub list (the
 * environment it strips before running its policy helper — the vendor's definition of this class, and
 * therefore the pin's rather than our taste) plus the runtime-specific doors that are not on it. The
 * drift gate in `test/official/env-allowlist.test.ts` fails when a pin bump adds a registry name of
 * this shape that nothing classifies.
 *
 * The exposure was bounded (the `base` door drops these silently, so only a host naming one itself
 * could pass it), which is why this is a scheduled hardening rather than an incident — but "the
 * README claims a refusal the code does not make" is the one state that must not ship.
 *
 * IT IS STILL A DOOR, NOT A WALL. A deployment that has REVIEWED a specific name and needs it says so
 * in `reviewedExecutionExtras`, one name at a time — the same shape as the credential hatch, and a
 * reviewed compatibility event rather than a silent addition.
 */
export const EXECUTION_INDIRECTION_ENV_NAMES: readonly string[] = [
  // ---- THE ARTIFACT'S OWN SCRUB LIST (the vendor's definition of this class, so it is the PIN's) ----
  // shells and shell startup
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "IFS",
  "CDPATH",
  "FPATH",
  "ZDOTDIR",
  "COMSPEC",
  "PATH",
  "PSMODULEPATH",
  "PROMPT_COMMAND",
  // interpreters and loaders (the prefix list below covers PYTHON*/PERL5*/RUBY*/LUA_*/DOTNET_* etc.)
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "PERLLIB",
  "GEM_PATH",
  "GEM_HOME",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "IBM_JAVA_OPTIONS",
  "OPENJ9_JAVA_OPTIONS",
  "CLASSPATH",
  "BUN_OPTIONS",
  "BUN_INSPECT",
  "MONO_PATH",
  "R_PROFILE_USER",
  "DEVPATH",
  "GCONV_PATH",
  "PHPRC",
  "PHP_INI_SCAN_DIR",
  // libraries and modules a loader consults
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
  "KRB5_CONFIG",
  "GTK_PATH",
  "QT_PLUGIN_PATH",
  "GIO_MODULE_DIR",
  "SASL_PATH",
  "XDG_CONFIG_HOME",
  // askpass / credential helpers: programs the child RUNS to obtain a credential
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "SUDO_ASKPASS",
  "VSCODE_GIT_ASKPASS_MAIN",
  "PAGER",
  "EDITOR",
  "VISUAL",

  // ---- THE PINNED RUNTIME'S OWN DOORS (measured on 0.3.250; not on the vendor's scrub list) --------
  // MEASURED: with `CLAUDE_CODE_SHELL` planted through this door the runtime ran the planted program
  // as the Bash tool's shell — 114 invocations in one session, and the marker appeared in the tool
  // result the model was shown.
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_SHELL_PREFIX",
  "CLAUDE_CODE_GIT_BASH_PATH",
  // MEASURED: `CLAUDE_ENV_FILE` is read and sourced into the Bash tool's environment on every call —
  // `BASH_ENV` by another door, which is why refusing one while admitting the other refused nothing.
  "CLAUDE_ENV_FILE",
  // settings files carry `hooks`, `apiKeyHelper` and `env`: a settings path is a code path
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
  "CLAUDE_CODE_MOCK_REMOTE_SETTINGS",
  // plugins are code the runtime loads (the plugin CACHE dir is a branch-owned variable since WS-21:
  // see `OFFICIAL_RUNTIME_VARIABLES`)
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  // package-manager and toolchain configuration files (a config file names scripts and registries)
  "BUN_CONFIG_FILE",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "PIP_CONFIG_FILE",
  "CLOUDSDK_CONFIG",
  "DOCKER_CONFIG",
  // binaries and browser paths the runtime executes
  "VITALS_EMITTER_BIN",
  "CLAUDE_SSH_LOCAL_BINARY",
  "SDK_NATIVE_BIN",
  "BUN_CHROME_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
];

/**
 * The PREFIXES, which no closed list can enumerate — the artifact's own scrub prefixes plus `DYLD_`.
 *
 * `GIT_` IS A WHOLE PREFIX, and that is the vendor's call rather than ours: the artifact scrubs it
 * entirely before running its policy helper, because `GIT_CONFIG_GLOBAL`/`_SYSTEM`/`_COUNT` name files
 * git reads for a `credential.helper`, `GIT_SSH_COMMAND`/`GIT_EXTERNAL_DIFF`/`GIT_PAGER` name programs
 * git RUNS, and `GIT_ASKPASS` supplies credentials. A host that needs one names it in
 * `reviewedExecutionExtras`.
 */
export const EXECUTION_INDIRECTION_ENV_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "BASH_FUNC_",
  "__BASH_FUNC",
  "PYTHON",
  "PERL5",
  "RUBY",
  "LUA_",
  "DOTNET_",
  "COMPLUS_",
  "COR_",
  "CORECLR_",
  "APPDOMAIN_MANAGER_",
  "GIT_",
];

const EXECUTION_INDIRECTION_FOLDED: ReadonlySet<string> = new Set(EXECUTION_INDIRECTION_ENV_NAMES.map((name) => name.toUpperCase()));

/** True for a name that changes how the child executes code or authenticates. Case-insensitive. */
export function isExecutionIndirectionVariable(name: string): boolean {
  const folded = name.toUpperCase();
  return EXECUTION_INDIRECTION_FOLDED.has(folded) || EXECUTION_INDIRECTION_ENV_PREFIXES.some((prefix) => folded.startsWith(prefix));
}
