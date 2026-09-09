// WS-14 §3: THE CHILD ENVIRONMENT, BUILT FROM AN ALLOWLIST — a REPLACEMENT, never an inheritance.
//
// "TypeScript `Options.env` REPLACES the child environment. The host MUST build it from an allowlist;
// NOTHING INHERITS. Winter itself never reads `CLAUDE_*` variables — these exist only on this child."
//
// SO THIS MODULE NEVER READS `process.env`. Not once, not for a default, not for a fallback. The
// minimal OS set comes from a source the CALLER passes in (`minimalOsEnvironmentFrom(process.env)` at
// the host's own call site), which keeps the "nothing inherits" rule structural rather than
// aspirational: there is no ambient read in this package to forget to remove.
//
// THE MUST-NOT LIST IS ENFORCED TWICE, ON PURPOSE. An allowlist already excludes everything it does
// not name, so `assertNoForbiddenChildVariables` looks redundant — and it is, right up until a host
// passes `base` with something extra in it, or a "deliberate, documented addition" (§3's own escape
// hatch) is added carelessly. The builder produces; the validator refuses. The second one is also
// what a drift-gate test can point at without reconstructing a launch.
//
// WS-17's DRIFT GATE INPUT is `officialEnvAllowlistSnapshot()`: NAMES ONLY, never values. "The
// per-mode env allowlist (§3) and auth-family variable capture (§12) are themselves pinned fixtures:
// any change to either is a reviewed compatibility event under the WS-17 drift gate, never a silent
// update." A snapshot carrying values would put a credential in a fixture, which §12 forbids in the
// same breath.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import type { EnvInput, RemoteConfigPolicy } from "../seams/official-adapter.ts";
import type { RuntimeSelection } from "../selection/runtime-selection.ts";
import { ALL_AUTH_VARIABLES, AUTH_FAMILY_VARIABLES, NEVER_INJECTED_AUTH_VARIABLES, allowedAuthVariables, isAuthShapedVariable, validateAuthEnvironment, type ClaudeOauthGate } from "./auth.ts";
import { officialBranchLabel } from "./branding.ts";
import { NON_CREDENTIAL_ENV_REGISTRY } from "./env-registry.ts";
import { VENDOR_HOME_SEGMENT_RE } from "./containment.ts";
import { OfficialConfigurationError } from "./errors.ts";

/**
 * §3's "smallest set proven required".
 *
 * `LC_*` is a FAMILY rather than a name (the locale variables are `LC_ALL`, `LC_CTYPE`, … and a host
 * legitimately has several), so it is matched by prefix; everything else is exact.
 */
export const MINIMAL_OS_VARIABLES: readonly string[] = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG"];
export const MINIMAL_OS_VARIABLE_PREFIXES: readonly string[] = ["LC_"];

/** The vendor-named variables this branch sets itself (§1/§3). Claude-mirroring literals (WS-01 §5). */
export const OFFICIAL_RUNTIME_VARIABLES = {
  configDir: "CLAUDE_CONFIG_DIR",
  projectDirName: "CLAUDE_CODE_PROJECT_DIR_NAME",
  tmpdir: "CLAUDE_CODE_TMPDIR",
} as const;

/**
 * Proxy and telemetry variables §3 excludes "unless explicitly configured".
 *
 * They are refused by NAME rather than merely omitted because the failure they cause is invisible:
 * a proxy variable that reached this child routes the runtime's traffic somewhere the host did not
 * choose and no assertion in a session would ever notice.
 */
export const PROXY_AND_TELEMETRY_VARIABLES: readonly string[] = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "DISABLE_TELEMETRY",
  "DISABLE_ERROR_REPORTING",
];
export const PROXY_AND_TELEMETRY_PREFIXES: readonly string[] = ["OTEL_"];

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

// The vendor-home matcher is IMPORTED, not re-spelled (review r2, NEW-4). It lived in three places,
// C1 folded only one of them, and the two survivors were case-exact — so `/Users/dev/.Claude/ca.pem`
// passed this value check and a `PATH` entry under `~/.Claude/plugins/.../bin` survived the sanitizer
// on the very filesystem where those are the same directory.

/**
 * Variables whose value is a LIST of paths, sanitized entry by entry rather than refused whole.
 *
 * FOUND BY THE RULE ITSELF, on its first real-runtime run: a developer's `PATH` contained
 * `~/.claude/plugins/cache/…/bin` entries, and the "no value points into the vendor home" rule
 * refused the whole variable. Both halves of that outcome are wrong to keep — the child MUST NOT be
 * handed executables from the user's real vendor home (that is the leak the rule is about), and a
 * child with no `PATH` cannot run a shell command at all (so §8's containment proof would pass for
 * the wrong reason). Dropping the offending ENTRIES is the answer that keeps both properties.
 *
 * POSIX separator only: this branch's hosts are macOS and Linux (WS-14's own launch profiles are
 * `~/…` paths), and a Windows host would need its own entry here rather than a guessed split.
 */
const PATH_LIST_VARIABLES: readonly string[] = ["PATH"];

/** Drops the entries of a path-list value that reach into the vendor's user-level home. */
export function sanitizePathListValue(value: string): string {
  return value
    .split(":")
    .filter((entry) => entry.length > 0 && !VENDOR_HOME_SEGMENT_RE.test(entry))
    .join(":");
}

/**
 * What `buildChildEnv` needs beyond the spine's `EnvInput`.
 *
 * TWO FIELDS THE SEAM DOES NOT NAME, and both are per-SESSION rather than per-adapter, so neither
 * could be answered from the adapter's own configuration:
 *
 *   `projectKey`      §3's `CLAUDE_CODE_PROJECT_DIR_NAME` — "Winter's stable transcript key,
 *                     decoupling the spool's project dir from the legacy encoded-cwd default".
 *                     MEASURED: with it set, both the spool and the canonical store wrote to
 *                     `projects/<key>/`; without it, the spool used the encoded absolute cwd.
 *   `sharedTempRoot`  §3's `CLAUDE_CODE_TMPDIR` — the shared per-user temp root the host derives from
 *                     `brand.tempRootName`. Passed IN rather than derived here so a test can hand it
 *                     a `mkdtemp` and so this module spells no product path.
 *
 * Declared as an EXTENSION of the pinned seam input rather than as a change to it: a lane may not
 * edit `src/seams/**`, and structural typing means a host that has these values simply passes the
 * wider object. The Lane A report carries the two-field diff as the NEEDS_CONTEXT if the spine wants
 * them named on `EnvInput` itself.
 */
export interface OfficialEnvInput extends EnvInput {
  projectKey?: string;
  sharedTempRoot?: string;
}

/** Host policy for the env builder — §3's "deliberate, documented addition" escape hatch, fenced. */
export interface OfficialEnvPolicy {
  /**
   * Extra variables this deployment deliberately configures (a gateway's proxy, an operator's
   * telemetry). Named here, they pass the validator; unnamed, they are refused.
   */
  configuredExtras?: Readonly<Record<string, string>>;
  /** Additional env prefixes the HOST owns (its daemon's own product prefix). The brand's is always refused. */
  hostEnvPrefixes?: readonly string[];
  /**
   * Auth-SHAPED variables this deployment has reviewed and needs anyway (review r2, NEW-2).
   *
   * The extras door is closed to credential-bearing shapes by default, because the pinned runtime
   * reads far more of them than any table lists and one of them re-points the whole session. A host
   * with a real need — a cloud tuning variable its family table does not carry — names it here, which
   * is §12's own "reviewed compatibility event" rather than a silent addition.
   */
  reviewedCredentialShapedExtras?: readonly string[];
  /**
   * Execution/indirection variables this deployment has reviewed and needs anyway (item 22, NEW-A).
   *
   * The sibling of `reviewedCredentialShapedExtras`, for the other blind spot: names that change how
   * the child EXECUTES code or authenticates (`BASH_ENV`, `NODE_OPTIONS`, `GIT_ASKPASS`, `LD_*`, …).
   * They are refused by name even when the pinned registry declares them, because "the artifact reads
   * it" is exactly why it is dangerous. One name at a time; never a prefix, never a wildcard.
   */
  reviewedExecutionExtras?: readonly string[];
  /**
   * R-7b-11: `"deny"` (the default) sets `TRAFFIC_OPT_OUT_VARIABLES` on the child; `"allow"` omits
   * them, letting the runtime fetch its own remote feature configuration.
   *
   * ABSENT MEANS DENY, EVERYWHERE — including for a host that never heard of this field, which is the
   * point: the shipped default must be the one that makes the pin mean one artifact.
   */
  remoteConfig?: RemoteConfigPolicy;
  /** D14's ship gate, threaded to the auth validator. Default: closed. */
  claudeOauth?: ClaudeOauthGate;
}

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
  // plugins are code the runtime loads
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
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

/** The positive allowlist, folded once (review r3, NEW-10 — matching is case-insensitive). */
const NON_CREDENTIAL_ENV_REGISTRY_FOLDED: ReadonlySet<string> = new Set(NON_CREDENTIAL_ENV_REGISTRY.map((name) => name.toUpperCase()));

/** Picks the minimal OS set out of a caller-supplied source. The host passes `process.env`; we never do. */
export function minimalOsEnvironmentFrom(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const wanted = MINIMAL_OS_VARIABLES.includes(name) || MINIMAL_OS_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
    if (wanted) out[name] = value;
  }
  return out;
}

/**
 * Builds the child environment: §3's table, in one pass, from an allowlist.
 *
 * ORDER IS ALPHABETICAL IN THE RESULT because this object is a golden-capture input and a stable
 * fixture must not depend on which branch of the builder ran first.
 */
export function buildOfficialChildEnv(input: OfficialEnvInput, policy: OfficialEnvPolicy = {}): Record<string, string> {
  const branchLabel = officialBranchLabel(input.brand);
  if (input.configDir.length === 0) {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: "a child with no config dir writes its transcript wherever the SDK parent's own environment points, which on a developer machine is the real vendor home (WS-14 §1/§3)",
      branchLabel,
    });
  }

  validateAuthEnvironment({ selection: input.selection, credentials: input.credentials, gate: policy.claudeOauth ?? { approved: false }, branchLabel });

  const env: Record<string, string> = {
    [OFFICIAL_RUNTIME_VARIABLES.configDir]: input.configDir,
  };
  if (input.projectKey !== undefined && input.projectKey.length > 0) {
    // R-7b-13: a key the pinned artifact would reject must never reach the child, because the runtime
    // silently substitutes its own and the record then describes a transcript that is somewhere else.
    if (!new RegExp(PINNED_PROJECT_DIR_NAME_PATTERN).test(input.projectKey)) {
      throw new OfficialConfigurationError({
        option: `env.${OFFICIAL_RUNTIME_VARIABLES.projectDirName}`,
        reason: `${JSON.stringify(input.projectKey)} (${input.projectKey.length} characters) does not match the pinned runtime's own rule ${PINNED_PROJECT_DIR_NAME_PATTERN}, and a key it rejects does not fail — it falls back to the runtime's own cwd-derived name, leaving the directory row, this environment and the auto-memory directory all naming a transcript that is somewhere else (WS-14 §1/§3, R-7b-13)`,
        branchLabel,
      });
    }
    env[OFFICIAL_RUNTIME_VARIABLES.projectDirName] = input.projectKey;
  }
  if (input.sharedTempRoot !== undefined && input.sharedTempRoot.length > 0) env[OFFICIAL_RUNTIME_VARIABLES.tmpdir] = input.sharedTempRoot;
  // R-7b-11: the pin's tool surface is the pin's, unless this deployment says otherwise IN WRITING.
  if ((policy.remoteConfig ?? "deny") === "deny") for (const [name, value] of Object.entries(TRAFFIC_OPT_OUT_VARIABLES)) env[name] = value;
  for (const [name, value] of Object.entries(input.credentials)) env[name] = value;
  for (const [name, value] of Object.entries(input.base ?? {})) {
    const wanted = MINIMAL_OS_VARIABLES.includes(name) || MINIMAL_OS_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
    // SILENTLY DROPPED, NOT REFUSED: `base` is documented as "the minimal OS variables", and a host
    // that passes a whole `process.env` by mistake should get a correct child rather than a crash —
    // the allowlist is the mechanism, and the validator below is what catches a DELIBERATE addition
    // that was never declared.
    if (wanted) env[name] = PATH_LIST_VARIABLES.includes(name) ? sanitizePathListValue(value) : value;
  }
  for (const [name, value] of Object.entries(policy.configuredExtras ?? {})) env[name] = value;

  assertNoForbiddenChildVariables(env, { brand: input.brand, selection: input.selection, policy, branchLabel });
  return Object.fromEntries(Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * §3's MUST-NOT list, as a refusal.
 *
 * Every clause is a leak with a name:
 *   * a product-prefixed variable hands the child the DAEMON's configuration, which is how a spawned
 *     runtime ends up reading the host's own home directory;
 *   * `CLAUDE_CODE_OAUTH_TOKEN` is the credential D14 gates and §12 routes through the spool instead;
 *   * an undeclared proxy or telemetry variable silently redirects or duplicates traffic;
 *   * a VALUE pointing into the vendor's user-level home is the isolation failure this whole branch
 *     exists to prevent — and it is a value check, because the variable that carries it can be
 *     anything at all (WS-17 row 4's "zero visibility into the vendor home").
 */
export function assertNoForbiddenChildVariables(
  env: Readonly<Record<string, string>>,
  args: { brand: Pick<BrandProfile, "envPrefix" | "processLabel">; selection?: Pick<RuntimeSelection, "authFamily" | "providerId">; policy?: OfficialEnvPolicy; branchLabel?: string },
): void {
  const branchLabel = args.branchLabel ?? officialBranchLabel(args.brand);
  const declared = new Set(Object.keys(args.policy?.configuredExtras ?? {}));
  const reviewedExtras = args.policy?.reviewedCredentialShapedExtras ?? [];
  const reviewedExecution = args.policy?.reviewedExecutionExtras ?? [];
  const prefixes = [args.brand.envPrefix, ...(args.policy?.hostEnvPrefixes ?? [])];
  const runtimeVariables: readonly string[] = Object.values(OFFICIAL_RUNTIME_VARIABLES);
  const familyVariables = args.selection === undefined ? undefined : allowedAuthVariables(args.selection);
  for (const [name, value] of Object.entries(env)) {
    const refuse = (reason: string): never => {
      throw new OfficialConfigurationError({ option: `env.${name}`, reason, branchLabel });
    };
    if (prefixes.some((prefix) => prefix.length > 0 && name.startsWith(prefix))) {
      refuse("product/daemon variables never reach this child: it is a vendor runtime configured entirely by the allowlist, and Winter itself never reads the vendor's variables either (WS-14 §3, WS-01 §1 principle 4)");
    }
    if (NEVER_INJECTED_AUTH_VARIABLES.includes(name)) {
      refuse("this credential is never injected on this branch (WS-14 §12 / WS-01 §2.5); the supported subscription flow stores its state inside the spool namespace");
    }
    // REVIEW r1, M1 — THE FAMILY CHECK RUNS ON THE FINAL ENVIRONMENT, and `declared` does NOT exempt
    // it. `configuredExtras` is the documented door for a gateway proxy, and it was merged AFTER the
    // credential validator: a session selected as `api-key` could be handed `ANTHROPIC_AUTH_TOKEN`
    // through it, and the runtime's precedence puts the token ABOVE the key — so the session bills,
    // rate-limits and audits against an account the persisted selection does not name, silently.
    // That is the exact failure §12's "exactly one auth family" exists to prevent, so the check
    // belongs where every merge has already happened.
    if (familyVariables !== undefined && ALL_AUTH_VARIABLES.includes(name) && !familyVariables.includes(name)) {
      refuse(
        `it is a credential variable outside this session's ${args.selection?.authFamily} family (${familyVariables.length === 0 ? "which injects nothing" : familyVariables.join(", ")}); the runtime resolves two families by its own precedence order, not by the host's selection (WS-14 §12)`,
      );
    }
    // REVIEW r2, NEW-2 — THE EXTRAS DOOR IS FOR NON-CREDENTIAL VARIABLES ONLY. The M1 fix refused an
    // out-of-family name only when it was in the sixteen-name table; the runtime reads thirty-odd, and
    // eight vectors went straight through this door (a whole Foundry family, a bearer header, an OAuth
    // refresh token). A name that is credential-bearing BY SHAPE may ride the extras door only when it
    // is a variable this session's own family sets — and for the `custom` family, whose credential set
    // is open by design, that means never through EXTRAS (its own credentials still go through
    // `credentials`, where the family check governs them).
    // REVIEW r3, NEW-10 — THE EXTRAS DOOR IS A POSITIVE ALLOWLIST NOW, and the two rules stack: a
    // name must be BOTH not-credential-shaped AND present in the artifact's own registry as a
    // non-credential accessor. The shape rule alone was a denylist — seventeen names the registry
    // declares (an API-key file descriptor, an mTLS client identity, the LOWERCASE twin of a vertex
    // variable whose uppercase spelling the same door refused) rode through it, because `_KEY$`,
    // `_CERT`, `CERT_`, `_FILE_DESCRIPTOR` and a non-initial `OAUTH` were simply absent from the
    // shape and the regex had no `/i`.
    //
    // MATCHING IS CASE-INSENSITIVE for both rules, because the registry proves the runtime reads at
    // least one credential variable in both cases.
    // THE FAMILY MATCH IS EXACT, THE REFUSALS FOLD. A family table names the exact variables to SET;
    // a differently-cased spelling is not that variable (`anthropic_api_key` is inert on this pin —
    // the artifact never reads it), so it must not inherit the family's permission, while the checks
    // that REFUSE must see through case because the registry proves the runtime reads both cases of
    // at least one credential name.
    const foldedName = name.toUpperCase();
    const isThisFamilysVariable = (familyVariables ?? []).includes(name);
    // BEFORE THE REGISTRY RULE, because the registry is what admits these (item 22, NEW-A). The order
    // is the whole fix: `BASH_ENV` is IN the pinned artifact's own non-credential registry — the
    // runtime really does read it — so a check placed after the positive-allowlist rule would never
    // fire. A name that changes how the child executes code or authenticates is refused whoever
    // declares it, unless this deployment has reviewed that exact name.
    if (declared.has(name) && isExecutionIndirectionVariable(name) && !runtimeVariables.includes(name) && !reviewedExecution.includes(name)) {
      refuse(
        "it is refused explicitly: this name changes how the child EXECUTES code or authenticates (a shell startup file or command prefix, a loader/runtime hook, or an askpass/credential helper the child runs), " +
          "which no credential-shape rule can see and which the artifact's own registry legitimately declares — so neither of the extras door's two rules would stop it. " +
          "A deployment that has REVIEWED this exact name and needs it names it in `reviewedExecutionExtras` (WS-14 §3/§12, item 22)",
      );
    }
    if (declared.has(name) && isAuthShapedVariable(foldedName) && !runtimeVariables.includes(name) && !isThisFamilysVariable && !reviewedExtras.includes(name)) {
      refuse(
        "it is credential-bearing by shape, and the configured-extras door carries non-credential variables only: the runtime resolves credentials by its own precedence order, so one of these re-points billing, rate limits and audit at an account this session's persisted selection does not name (WS-14 §12). " +
          "A deployment that has REVIEWED a specific auth-shaped variable and needs it names it in `reviewedCredentialShapedExtras` — a reviewed compatibility event under WS-17's drift gate, never a silent addition",
      );
    }
    if (declared.has(name) && !runtimeVariables.includes(name) && !isThisFamilysVariable && !reviewedExtras.includes(name) && !NON_CREDENTIAL_ENV_REGISTRY_FOLDED.has(foldedName)) {
      refuse(
        "the configured-extras door is a positive allowlist: only names the PINNED artifact's own environment registry declares, and that an independent name rule classifies as non-credential, ride it. " +
          "An unknown name is refused because nothing has classified it — name it in `reviewedCredentialShapedExtras` if this deployment has reviewed it (WS-14 §3/§12, review r3 NEW-10)",
      );
    }
    // REVIEW r1, M1 (the same hatch, the other target): a declared extra may not SHADOW a variable
    // this branch owns. `CLAUDE_CONFIG_DIR` through `configuredExtras` moved the transcript root out
    // from under §1's record, and for a store-backed resume nothing downstream would have caught it.
    if (declared.has(name) && runtimeVariables.includes(name)) {
      refuse("a configured extra may not override a variable this branch owns: the config dir, the transcript project key and the shared temp root are §1/§3's own, and the record is written against them");
    }
    // R-7b-11 — THE OPT-OUTS ARE BRANCH-OWNED, AND THE DOOR TO CHANGE THEM IS `remoteConfig`.
    // A host that set one of these through `configuredExtras` would move the child off the surface the
    // session's directory row says it ran on, and nothing downstream would notice: the row records the
    // POLICY, not four variable values. So the extras door refuses them by name and points at the one
    // knob whose answer is recorded.
    if (declared.has(name) && TRAFFIC_OPT_OUT_VARIABLE_NAMES.includes(name)) {
      refuse(
        "this is one of the four traffic opt-outs this branch sets itself (R-7b-11), and setting it through the extras door would leave the session's recorded `remoteConfig` describing a surface the child does not have — use `OfficialEnvPolicy.remoteConfig` (\"allow\" opts back in, and the choice is recorded)",
      );
    }
    if (!declared.has(name) && !TRAFFIC_OPT_OUT_VARIABLE_NAMES.includes(name) && (PROXY_AND_TELEMETRY_VARIABLES.includes(name) || PROXY_AND_TELEMETRY_PREFIXES.some((prefix) => name.startsWith(prefix)))) {
      refuse("proxy and telemetry variables reach this child only when the deployment configures them explicitly (WS-14 §3); an inherited one redirects or duplicates traffic invisibly");
    }
    if (VENDOR_HOME_SEGMENT_RE.test(value)) {
      refuse(`its value (${value}) points into the vendor's user-level home; this branch is isolated from it by construction (WS-14 §3, WS-17 row 4)`);
    }
    // REVIEW r1, n1 — A CLOSED ALLOWLIST, not a list of refusals. §3 names `NORMA_*` literally, and a
    // router that cannot know one host's daemon prefix should not be relying on a denylist to catch
    // it: anything that is not a variable this branch OWNS, an auth variable for this session, a
    // minimal OS variable or an explicitly declared extra has no business in the child at all.
    const known =
      runtimeVariables.includes(name) ||
      TRAFFIC_OPT_OUT_VARIABLE_NAMES.includes(name) ||
      ALL_AUTH_VARIABLES.includes(name) ||
      MINIMAL_OS_VARIABLES.includes(name) ||
      MINIMAL_OS_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
      declared.has(name);
    if (!known) {
      refuse("it is not a variable this branch owns, an auth variable for this session, a minimal OS variable, or an explicitly configured addition — the child environment is an allowlist, and anything else is a leak from somewhere (WS-14 §3)");
    }
  }
}

/**
 * WS-17's drift-gate input: the allowlist as NAMES, grouped, with the pinned runtime version they
 * were captured against. Never a value — see this module's header.
 */
export interface EnvAllowlistSnapshot {
  pinnedRuntime: string;
  runtimeVariables: readonly string[];
  minimalOsVariables: readonly string[];
  minimalOsVariablePrefixes: readonly string[];
  authFamilies: Readonly<Record<string, readonly string[]>>;
  neverInjected: readonly string[];
  refusedProxyTelemetry: readonly string[];
  refusedProxyTelemetryPrefixes: readonly string[];
  /** R-7b-11: the names this branch SETS by default. A change here is a reviewed compatibility event too. */
  trafficOptOuts: readonly string[];
  /** R-7b-13: the shape the pin accepts for the transcript project key — a rejected one is substituted. */
  projectDirNamePattern: string;
}

/** The pinned artifact every name above was captured from (WS-02 §6.1: an upgrade is reviewed). */
export const PINNED_OFFICIAL_RUNTIME = "0.3.250";

/**
 * R-7b-13: the shape the PINNED ARTIFACT accepts for `CLAUDE_CODE_PROJECT_DIR_NAME`.
 *
 * A PINNED LITERAL, read off 0.3.250 itself, because the consequence of getting it wrong is silent:
 * the runtime validates the variable against this pattern and, when it does not match, FALLS BACK TO
 * ITS OWN cwd-derived key. Measured — a 70-character key left the transcript under the vendor's own
 * realpath-derived name while the directory row, the child environment and the auto-memory directory
 * all named the host's key. That is "the record and the transcript disagree", which is the class WS-14
 * §1 exists to prevent, and no assertion downstream would ever notice it.
 *
 * So a key this pattern rejects is REFUSED here rather than passed through and quietly ignored. The
 * drift gate re-checks the literal on every pin bump.
 */
export const PINNED_PROJECT_DIR_NAME_PATTERN = "^[A-Za-z0-9_-]{1,64}$";

export function officialEnvAllowlistSnapshot(): EnvAllowlistSnapshot {
  return {
    pinnedRuntime: PINNED_OFFICIAL_RUNTIME,
    runtimeVariables: Object.values(OFFICIAL_RUNTIME_VARIABLES),
    minimalOsVariables: MINIMAL_OS_VARIABLES,
    minimalOsVariablePrefixes: MINIMAL_OS_VARIABLE_PREFIXES,
    authFamilies: Object.fromEntries(Object.entries(AUTH_FAMILY_VARIABLES).map(([family, names]) => [family, [...names]])),
    neverInjected: NEVER_INJECTED_AUTH_VARIABLES,
    refusedProxyTelemetry: PROXY_AND_TELEMETRY_VARIABLES,
    refusedProxyTelemetryPrefixes: PROXY_AND_TELEMETRY_PREFIXES,
    trafficOptOuts: TRAFFIC_OPT_OUT_VARIABLE_NAMES,
    projectDirNamePattern: PINNED_PROJECT_DIR_NAME_PATTERN,
  };
}

/** Every name the snapshot mentions, flattened — what a scan of the pinned artifact is run against. */
export function officialEnvAllowlistNames(): readonly string[] {
  return [...Object.values(OFFICIAL_RUNTIME_VARIABLES), ...ALL_AUTH_VARIABLES, ...NEVER_INJECTED_AUTH_VARIABLES].filter((n, i, all) => all.indexOf(n) === i);
}

/** Re-exported so a caller building a plan has one import site for the family tables. */
export { AUTH_FAMILY_VARIABLES, allowedAuthVariables };
