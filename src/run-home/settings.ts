// WS-21 §3.4.4: THE EFFECTIVE SETTINGS — the one `settings.json` a run folder carries.
//
// THE PROBLEM THIS SOLVES. Both children run with `settingSources: ["user"]`, so the run folder's
// `settings.json` is read as the USER tier. The project (`<root>/<project dir>/settings.json`) and
// local (`<git root>/<project dir>/settings.local.json`) tiers are merged into it here, by the router,
// because the runtimes may not read a repository's files themselves (ruling Q1). But a key merged into
// the user tier gets the user tier's TRUST, and the official runtime deliberately trusts some keys only
// from the user (F17). So each repository tier is filtered BEFORE the merge, exactly as the runtime
// would have filtered it — otherwise a repository could promote itself.
//
// THE STEPS, in order:
//   1. read the tiers — project and local only for a trusted project; a local file git TRACKS is the
//      repository's, and is filtered as the project tier from here on (WS-24, `localTierShippedByRepository`);
//   2. drop the keys the runtime refuses from that tier (`PROJECT_TIER_REFUSED_KEYS`: the keys
//      the runtime takes only from a trusted source, and the ones it warns a repository can control), a repository's
//      escalating permission mode (`REFUSED_DEFAULT_MODES`) and the model-routing keys Winter refuses
//      (`EVERY_TIER_REFUSED_MODEL_KEYS`, `REPOSITORY_TIER_REFUSED_MODEL_KEYS`), the effort keys
//      (`REPOSITORY_TIER_REFUSED_EFFORT_KEYS`), the output style (`REPOSITORY_TIER_REFUSED_STYLE_KEYS`) and a
//      repository's unsafe `plansDirectory` (`repositoryPlansDirectoryProblem`) — every one of these reported;
//   3. filter `env` — the runtime's own per-tier sets, plus `CLAUDE_CONFIG_DIR` and every variable the
//      ROUTER sets (a settings `env` block would otherwise override the process environment the router
//      built), plus the router's refused execution-indirection list;
//   4. re-anchor every path that was relative to the tier's own root (`/x` rules, sandbox paths,
//      additional directories) — in the run folder they would resolve against the run folder;
//   5. merge with the runtime's rules (arrays concatenated and deduplicated; `fallbackModel` and
//      `modelPicker` replaced — neither reaches the merge from a tier any more; `extraKnownMarketplaces`
//      shallow; everything else deep);
//   6. strip per mode (spec §3.2);
//   7. keep only the pinned runtime's own `Settings` keys, and write the file (0600).
//
// THE PROJECT TIER ANCHORS AT THE PROJECT ROOT (WS-21 DECISION, L2.4). F17 measured "project → the
// cwd" on a runtime that reads its project file AT the cwd, so there the two are the same directory.
// Here the project file is the trusted root's, and a cwd below it would move a `Read(/secrets)` deny
// off the path its author meant. The runtime's own schema text says project paths are "relative to
// the settings file root (project root for project settings)".
import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { envName } from "@yanlinglabs/winter-agent-sdk";

import { ALL_AUTH_VARIABLES, isExecutionIndirectionVariable, NEVER_INJECTED_AUTH_VARIABLES, OFFICIAL_RUNTIME_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "./env-refusals.ts";
import type { RunHomeBuildContext } from "./build.ts";
import { escapeRulePath, fsRootAnchored, type RunHomeBrand } from "./types.ts";
import { isHomeOrAbove, isWithin, projectWalk, readAdmittedFile } from "./walk.ts";

const PRIVATE_FILE = 0o600;

/**
 * The top-level keys of the pinned runtime's `Settings` interface (`sdk.d.ts`, 0.3.250), verbatim.
 * Anything else is not the official runtime's to read and is not written. A drift test re-derives
 * this list from the installed declaration file (`test/run-home/settings.test.ts`).
 */
export const CLAUDE_SETTINGS_KEYS: readonly string[] = [
  "$schema", "apiKeyHelper", "proxyAuthHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh",
  "processWrapper", "policyHelper", "fileSuggestion", "respectGitignore", "cleanupPeriodDays",
  "desktopSessionCleanupPeriodDays", "syncClaudeAiSkills", "syncClaudeAiPlugins", "skillListingMaxDescChars",
  "skillListingBudgetFraction", "wslInheritsWindowsSettings", "env", "attribution", "includeCoAuthoredBy",
  "includeGitInstructions", "permissions", "model", "fallbackModel", "availableModels",
  "enforceAvailableModels", "modelOverrides", "modelPicker", "modelPricing", "enableAllProjectMcpServers",
  "enabledMcpjsonServers", "disabledMcpjsonServers", "disableClaudeAiConnectors", "skillOverrides",
  "disableBundledSkills", "allowedMcpServers", "deniedMcpServers", "hooks", "worktree", "disableAllHooks",
  "disableAgentView", "disableRemoteControl", "disableWorkflows", "disableArtifact", "enableArtifact",
  "enableWorkflows", "workflowSizeGuideline", "workflowKeywordTriggerEnabled", "disableSkillShellExecution",
  "defaultShell", "respondToBashCommands", "allowManagedHooksOnly", "allowedHttpHookUrls",
  "httpHookAllowedEnvVars", "allowManagedPermissionRulesOnly", "allowManagedMcpServersOnly",
  "allowAllClaudeAiMcps", "strictPluginOnlyCustomization", "statusLine", "prUrlTemplate",
  "footerLinksRegexes", "subagentStatusLine", "enabledPlugins", "extraKnownMarketplaces",
  "additionalMarketplaces", "strictKnownMarketplaces", "allowedMarketplaces", "blockedMarketplaces",
  "disableCommandPluginSources", "disableSideloadFlags", "pluginSuggestionMarketplaces", "forceLoginMethod",
  "forceLoginGatewayUrl", "parentSettingsBehavior", "managedSourcesBehavior", "forceLoginOrgUUID",
  "forceRemoteSettingsRefresh", "otelHeadersHelper", "outputStyle", "viewMode", "language",
  "skipWebFetchPreflight", "sandbox", "feedbackSurveyRate", "feedbackDrafts", "spinnerTipsEnabled",
  "spinnerVerbs", "spinnerTipsOverride", "syntaxHighlightingDisabled", "spellcheck",
  "terminalTitleFromRename", "promptCacheTtl", "subagentPromptCacheTtl", "alwaysThinkingEnabled",
  "effortLevel", "modelSettings", "ultracode", "autoCompactWindow", "advisorModel", "fastMode",
  "fastModePerSessionOptIn", "promptSuggestionEnabled", "emojiCompletionEnabled",
  "showClearContextOnPlanAccept", "askUserQuestionTimeout", "dialogExpiry", "agent", "companyAnnouncements",
  "pluginConfigs", "remote", "autoUpdatesChannel", "minimumVersion", "requiredMinimumVersion",
  "requiredMaximumVersion", "plansDirectory", "tui", "voice", "channelsEnabled", "allowedChannelPlugins",
  "prefersReducedMotion", "autoMemoryEnabled", "autoMemoryDirectory", "autoDreamEnabled",
  "showThinkingSummaries", "skipDangerousModePermissionPrompt", "disableAutoMode", "sshConfigs", "claudeMd",
  "claudeMdExcludes", "pluginTrustMessage", "theme", "editorMode", "keybindingFlavor", "vimInsertModeRemaps",
  "verbose", "preferredNotifChannel", "autoCompactEnabled", "precomputeCompactionEnabled",
  "switchModelsOnFlag", "autoContinueAtUsageLimit", "autoScrollEnabled", "wheelScrollAccelerationEnabled",
  "fileCheckpointingEnabled", "showTurnDuration", "showMessageTimestamps", "terminalProgressBarEnabled",
  "todoFeatureEnabled", "teammateMode", "remoteControlAtStartup", "isolatePeerMachines", "daemonColdStart",
  "crossSessionInbound", "autoUploadSessions", "inputNeededNotifEnabled", "agentPushNotifEnabled",
  "disableDeepLinkRegistration", "voiceEnabled", "defaultView",
];

const CLAUDE_SETTINGS_KEY_SET: ReadonlySet<string> = new Set(CLAUDE_SETTINGS_KEYS);

/**
 * Keys the pinned runtime will not take from a repository tier, so the router drops them from that tier
 * before the merge promotes it to the user tier (F17, extended with the keys below):
 *
 *   * F17's list — `skipDangerousModePermissionPrompt` (project), `processWrapper`, the credential
 *     helpers (`apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`,
 *     `proxyAuthHelper`, `otelHeadersHelper`), `footerLinksRegexes`, `spellcheck`;
 *   * the runtime's trusted-source-only readers (policy, flag, user): `askUserQuestionTimeout`,
 *     `autoContinueAtUsageLimit`, `desktopSessionCleanupPeriodDays`, `dialogExpiry`, `feedbackDrafts`,
 *     `modelProposedGoals`, `vimInsertModeRemaps`, `modelPicker`, `pluginConfigs`;
 *   * keys the runtime warns are repo-controllable: `autoMode` ("only user/flag/managed settings may
 *     set classifier rules"), `crossSessionInbound` (a repository may only tighten it), `remote`
 *     (a `ccpool_` environment only from a trusted source), `enableArtifact`/`enableWorkflows` (an
 *     enable key is honoured from a trusted layer only), `spinnerTipsOverride`, and
 *     `syncClaudeAiSkills`/`syncClaudeAiPlugins`/`skipWorkflowUsageWarning` (not read from the project);
 *   * `claudeMd` — honoured from managed settings only.
 *
 * `permissions.defaultMode` is handled beside these (a value, not a key): `REFUSED_DEFAULT_MODES`.
 */
export const PROJECT_TIER_REFUSED_KEYS: { readonly project: readonly string[]; readonly local: readonly string[] } = (() => {
  const both = [
    "processWrapper",
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "gcpAuthRefresh",
    "proxyAuthHelper",
    "otelHeadersHelper",
    "footerLinksRegexes",
    "spellcheck",
    "askUserQuestionTimeout",
    "autoContinueAtUsageLimit",
    "desktopSessionCleanupPeriodDays",
    "dialogExpiry",
    "feedbackDrafts",
    "modelProposedGoals",
    "vimInsertModeRemaps",
    "modelPicker",
    "pluginConfigs",
    "autoMode",
    "crossSessionInbound",
    "remote",
    "enableArtifact",
    "enableWorkflows",
    "spinnerTipsOverride",
    "claudeMd",
  ];
  const projectOnly = ["skipDangerousModePermissionPrompt", "skipWorkflowUsageWarning", "syncClaudeAiSkills", "syncClaudeAiPlugins"];
  return { project: [...both, ...projectOnly], local: both };
})();

/**
 * MODEL ROUTING (R.3, M3 — ruled Important): Winter never switches to another leg, provider or model
 * silently, and a repository never chooses models. Dropped and REPORTED (`droppedRules`, the key's name).
 *
 *   * `fallbackModel` — from EVERY tier, the user's included: claude honours it from settings on
 *     overload, which is exactly a silent switch to another model.
 *   * `modelOverrides` — from EVERY tier too (Touch 4 add-on). The runtime's schema: "Override mapping from
 *     Anthropic model ID … to provider-specific model ID"; measured by the daemon reviewer on the real
 *     child, a USER-tier remap of haiku to opus made claude report haiku at `system/init` while sending
 *     `claude-opus-5` on the wire — a switch no startup model check can see. It became reachable in WS-21
 *     through `settingSources: ["user"]`.
 *   * `model`, `availableModels`, `advisorModel`, `enforceAvailableModels` — from the project and local
 *     tiers. The user tier keeps them: the host's `Options.model` — forwarded to the official child as
 *     `--model` (Touch 4, F1) — outranks any settings `model`, and the rest are the user's own choices.
 *     `enforceAvailableModels` (R.3 touch) is a switch too: the runtime's schema text says that with it
 *     "Default resolves to the first allowed availableModels entry".
 */
export const EVERY_TIER_REFUSED_MODEL_KEYS: readonly string[] = ["fallbackModel", "modelOverrides"];
export const REPOSITORY_TIER_REFUSED_MODEL_KEYS: readonly string[] = ["model", "availableModels", "advisorModel", "enforceAvailableModels"];

/**
 * EFFORT AND THINKING (WS-24): a repository never sets how hard the session's model works either. Dropped
 * from the project and local tiers and REPORTED, the same way as the model keys; the user tier keeps them.
 *
 *   * `effortLevel` — the session's reasoning effort;
 *   * `modelSettings` — per-model settings, a per-model `effortLevel` among them;
 *   * `ultracode` — the maximum-effort coding switch;
 *   * `alwaysThinkingEnabled` — extended thinking on every turn.
 *
 * DIVERGENCE, deliberate: claude honours these from a project's settings. Winter's session effort is the
 * daemon's (the host's `Options.effort`, per session and per message), and each of these keys changes what
 * a turn costs, so a repository's copy is refused rather than promoted to the user tier by the merge. The
 * Winter runtime reads none of them from a settings file today (agent SDK 0.0.27/0.0.28); every one is a
 * `Settings` key, though, so without this the run folder would carry a repository's value to any runtime
 * that starts reading it.
 */
export const REPOSITORY_TIER_REFUSED_EFFORT_KEYS: readonly string[] = ["effortLevel", "modelSettings", "ultracode", "alwaysThinkingEnabled"];

/**
 * THE OUTPUT STYLE (WS-24): a repository never picks it — not from the project tier, not from the local
 * one. A style replaces part of the system prompt, and the Winter runtime lets a PROJECT-tier style add to
 * the prompt but never replace it; merged into the user tier, a repository's `outputStyle` naming its own
 * style would skip that rule. Dropped and REPORTED. (A project style the USER selects is still loaded — as
 * a copy with `keep-coding-instructions: true`, see `items.ts`.)
 */
export const REPOSITORY_TIER_REFUSED_STYLE_KEYS: readonly string[] = ["outputStyle"];

/** Why each every-tier key is dropped (the report's `reason`). */
const EVERY_TIER_MODEL_KEY_REASONS: Readonly<Record<string, string>> = {
  fallbackModel: "Winter never switches model silently: claude falls back to this model on overload, a silent switch away from the session's own model",
  modelOverrides: "Winter never switches model silently: claude maps the session's model to another id on the wire while reporting the original at init, which no startup model check can see",
};

/**
 * `permissions.defaultMode` values a repository tier may not set (R.3, I1), dropped and REPORTED.
 *
 *   * project — every ESCALATING mode: `bypassPermissions`, `auto`, `acceptEdits`. That is claude's own
 *     trust-tier filter (`filterEscalatingDefaultMode`, `sdk.d.ts`: those three modes, applied to the
 *     project tier only). Once the router has merged a tier into the user tier that filter never fires,
 *     and the router sets no `Options.permissionMode` on the official child, so a repository's
 *     `"acceptEdits"` would have the child approve every in-cwd write without asking.
 *   * local — `auto` only, as before (claude takes `auto` from user, flag or managed settings only); the
 *     project-tier filter does not name the local tier. EXCEPT a local file git TRACKS (WS-24): that one
 *     arrived with the repository, so it is filtered as the project tier — every escalating mode, and every
 *     key `PROJECT_TIER_REFUSED_KEYS.project` names (see `localTierShippedByRepository`).
 *
 * DIVERGENCE, deliberate: claude drops the EFFECTIVE mode when the highest tier that sets one is the
 * project, so a user's own mode under a project's escalating one becomes no mode at all (`default`).
 * Filtering per tier keeps the user's value instead. The result is therefore always the user's own
 * tier's mode (or none): the repository never sets or changes it. That is not always the narrower of the
 * two — a user's own `acceptEdits` under a project's `bypassPermissions` stays `acceptEdits`, where
 * claude would fall to `default` — but it is exactly what the user chose.
 */
export const REFUSED_DEFAULT_MODES: { readonly project: ReadonlySet<string>; readonly local: ReadonlySet<string> } = {
  project: new Set(["bypassPermissions", "auto", "acceptEdits"]),
  local: new Set(["auto"]),
};

/**
 * The variable names the official runtime refuses from a project or local tier's `env` block (matched
 * case-insensitively, as it matches them).
 */
export const CLAUDE_PROJECT_TIER_ENV_DENY: readonly string[] = [
  "CLAUDE_CODE_PROCESS_WRAPPER",
  "CLAUDE_CODE_SYNC_SKILLS",
  "CLAUDE_CODE_SYNC_PLUGINS",
  "CLAUDE_CODE_SKILL_PROPOSALS",
  "CLAUDE_CODE_PLUGIN_CACHE_DIR",
  "CLAUDE_CODE_PLUGIN_SEED_DIR",
  "CLAUDE_CODE_PLUGIN_ATTRIBUTION",
  "CLAUDE_CODE_FEDERATION_CACHE_DIR",
  "ANTHROPIC_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "HOME",
  "APPDATA",
  "USERPROFILE",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_HARBOR_KITE",
  "CLAUDE_CODE_HARBOR_KITE_CLOUD",
  "CLAUDE_CODE_HARBOR_KITE_PACING_OFF",
  "CLAUDE_CODE_SILENT_TURN_REMINDER",
  "CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS",
  "CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT",
  "CLAUDE_CODE_ARTIFACT_ROOM",
  "USER_TYPE",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_TOASTY_THIMBLE",
  "CLAUDE_CODE_DIR_SYNC_DISABLE_ANCHORING",
  "CLAUDE_CODE_LEGACY_BUNDLE",
  "CLAUDE_CODE_DIR_SYNC_ENGINE",
  "CLAUDE_CODE_DIR_SYNC_FFWD",
  "CLAUDE_CODE_DIR_SYNC_STREAM",
];

/** The variable names the official runtime refuses from EVERY tier's `env` block. */
export const CLAUDE_EVERY_TIER_ENV_DENY: readonly string[] = [
  "ANTHROPIC_UNIX_SOCKET",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_TUI_TRIAL",
  "CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR",
  "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SESSION_KIND",
  "CLAUDE_CODE_PROJECT_DIR_NAME",
];

/** The official-leg variables the ROUTER sets for a run home (spec §3.1). */
export const ROUTER_SET_OFFICIAL_VARIABLES: readonly string[] = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "CLAUDE_CODE_DISABLE_CRON"];

/** The Winter-leg twins the router sets, spelled from the brand (spec §3.1, §6.3 items 11/13). */
export function routerSetWinterVariables(brand: Pick<RunHomeBrand, "envPrefix">): string[] {
  return ["HOME", "STORE_HOME", "PLUGIN_CACHE_DIR", "PROVIDER_MANAGED_BY_HOST", "DISABLE_CRON"].map((suffix) => envName(brand, suffix));
}

/**
 * Every variable a settings `env` block may never set, on any tier: the runtime's every-tier set, the
 * variables the router sets itself on either leg (config dir, plugin root, host-managed provider, cron,
 * the Winter twins, the transcript key and temp root, the traffic opt-outs, the credentials), and the
 * router's refused execution-indirection list.
 */
export function everyTierEnvRefused(name: string, brand: Pick<RunHomeBrand, "envPrefix">): boolean {
  const folded = name.toUpperCase();
  const refused = new Set(
    [
      ...CLAUDE_EVERY_TIER_ENV_DENY,
      ...ROUTER_SET_OFFICIAL_VARIABLES,
      ...routerSetWinterVariables(brand),
      ...Object.values(OFFICIAL_RUNTIME_VARIABLES),
      ...TRAFFIC_OPT_OUT_VARIABLE_NAMES,
      ...ALL_AUTH_VARIABLES,
      ...NEVER_INJECTED_AUTH_VARIABLES,
    ].map((variable) => variable.toUpperCase()),
  );
  return refused.has(folded) || isExecutionIndirectionVariable(name);
}

type Tier = "user" | "project" | "local";

/** How long the tracked-file probe may take before it counts as unanswered (and so as tracked). */
const GIT_PROBE_TIMEOUT_MS = 10_000;

/** The local tier's file name inside the project dot-dir. */
const LOCAL_SETTINGS_FILE = "settings.local.json";

/** The process environment without a single `GIT_*` variable, so nothing but the repository shapes git's answer. */
function gitProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.toUpperCase().startsWith("GIT_")) env[name] = value;
  return env;
}

function lstatKind(path: string): "link" | "missing" | "other" {
  try {
    return lstatSync(path).isSymbolicLink() ? "link" : "other";
  } catch {
    return "missing";
  }
}

/**
 * WS-24: did the REPOSITORY ship `<root>/<dirName>/settings.local.json`? A LOCAL settings file is the
 * user's own only while nothing says otherwise; a shipped one is filtered exactly as the project tier
 * (`buildEffectiveSettings`). `root` is the git root (or the cwd git is asked from, see there).
 *
 * SHIPPED when any of these holds — each is checked, and every one fails closed:
 *
 *   1. the dot-dir or the file is a symbolic link, or the file's real path is not exactly
 *      `<real root>/<dirName>/settings.local.json` (another spelling on a case-insensitive volume, a
 *      linked directory) — what the name resolves to is then not the plain local file;
 *   2. git lists an index entry, matched case-insensitively, AT the file, or AT the dot-dir itself (only a
 *      link or a submodule can be one — either way the directory is the repository's). "In the index" is
 *      committed, or staged and not yet committed;
 *   3. git cannot answer: no git executable, a non-zero exit (not a repository, a repository git refuses to
 *      read for its owner, a broken index), a timeout.
 *
 * The probe reads the index and nothing else: `ls-files -s` with `:(literal,icase)` pathspecs,
 * `core.fsmonitor` off so no configured monitor command runs, and every `GIT_*` variable removed from its
 * environment.
 *
 * WHAT THIS CANNOT PROVE: a repository delivered together with its `.git` controls its own index, so
 * "untracked" is git's word about that index, never proof of where the file came from. It closes the
 * ordinary case — a local file committed to the repository — not every delivery.
 */
export async function localTierShippedByRepository(root: string, dirName: string, git = "git"): Promise<boolean> {
  const dotDir = join(root, dirName);
  const file = join(dotDir, LOCAL_SETTINGS_FILE);
  if (lstatKind(dotDir) !== "other" || lstatKind(file) !== "other") return true;
  try {
    if (realpathSync(file) !== join(realpathSync(root), dirName, LOCAL_SETTINGS_FILE)) return true;
  } catch {
    return true;
  }
  const wantFile = `${dirName}/${LOCAL_SETTINGS_FILE}`.toLowerCase();
  const wantDir = dirName.toLowerCase();
  return new Promise((resolveShipped) => {
    try {
      execFile(
        git,
        ["-C", root, "-c", "core.fsmonitor=false", "ls-files", "-z", "-s", "--", `:(literal,icase)${dirName}`, `:(literal,icase)${dirName}/${LOCAL_SETTINGS_FILE}`],
        { timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: gitProbeEnv() },
        (error, stdout) => {
          if (error !== null) return resolveShipped(true);
          // Each entry: `<mode> <object> <stage>\t<path>`, NUL-terminated.
          for (const entry of String(stdout).split("\0")) {
            const tab = entry.indexOf("\t");
            if (tab < 0) continue;
            const path = entry.slice(tab + 1).toLowerCase();
            if (path === wantFile || path === wantDir) return resolveShipped(true);
          }
          resolveShipped(false);
        },
      );
    } catch {
      resolveShipped(true);
    }
  });
}

/**
 * WS-24 (I-2): a `.git` entry (a directory, or a worktree's file) at the cwd, on the walk up to the trusted
 * root, or ABOVE the trusted root up to `$HOME` (inclusive) or the file-system root — never above either.
 * The host's `gitRoot` is null both for "no repository" and for "git could not answer"; a `.git` entry here
 * tells the two apart, so the second is probed (and fails closed). Walking above the trusted root covers a
 * trusted root that is a SUBDIRECTORY of a repository, whose `.git` sits higher up.
 */
function gitEntryNear(cwd: string, trustedProjectRoot: string, userHome: string): boolean {
  const dirs = new Set([resolve(cwd), ...projectWalk(cwd, trustedProjectRoot, userHome)]);
  const home = resolve(userHome);
  for (let current = resolve(trustedProjectRoot); ; ) {
    dirs.add(current);
    const parent = dirname(current);
    if (current === home || parent === current) break;
    current = parent;
  }
  for (const dir of dirs) if (lstatKind(join(dir, ".git")) !== "missing") return true;
  return false;
}

/**
 * RULING P5-L's project-tier `plansDirectory` check, ported from the agent SDK
 * (`packages/sdk/src/settings/resolve.ts`, `validateProjectPlansDirectory`): the value reaches the system
 * prompt, so a repository's must be a short, relative path with no control characters and no `..`. Merged
 * into the user tier it would skip that check (the user tier may set any path), so the router applies it.
 */
const MAX_PLANS_DIRECTORY_LENGTH = 200;

export function repositoryPlansDirectoryProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return `"plansDirectory" must be a string, got ${typeof value}`;
  if (value.length === 0) return `"plansDirectory" must not be empty`;
  if (value.length > MAX_PLANS_DIRECTORY_LENGTH) return `"plansDirectory" exceeds ${MAX_PLANS_DIRECTORY_LENGTH} characters`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return `"plansDirectory" contains control characters, which cannot appear in a path`;
  if (value.startsWith("/") || value.startsWith("~")) return `"plansDirectory" from a repository tier must be RELATIVE to the project root`;
  if (value.split("/").includes("..")) return `"plansDirectory" from a repository tier must not traverse upward`;
  return undefined;
}

/** Rule names whose specifier is a PATH (the runtime's file-permission rules). */
const PATH_RULE_TOOLS: ReadonlySet<string> = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * `Tool(/x)` → `Tool(//<anchor>/x)` for a path tool; every other form is returned as written.
 *
 * THE ANCHOR IS ESCAPED (`escapeRulePath`) ON BOTH LEGS. The router writes the anchor part, so it must
 * spell it in the rule grammar, and both runtimes now read claude's gitignore-style grammar: claude
 * always has (a root named `[wip] app` is a character class unless escaped — MEASURED, a re-anchored
 * project `ask` rule under such a root never fired), and the Winter runtime since `ws21/sdk`@57e7fef
 * (SV-6 — measured the same way on the Winter leg: unescaped, its re-anchored ask and deny rules under a
 * `[wip] app` root never matched). Since the escape-table round the spelling is two layers — claude's
 * rule-content escape over the gitignore escape (see `escapeRulePath`) — because both legs unescape a
 * rule's content once before matching (the Winter runtime since `ws21/sdk`@6170adb). The author's own
 * part of the pattern is already in that grammar and is passed through as written.
 */
export function anchorRule(rule: string, anchor: string): string {
  const match = /^([A-Za-z]+)\((.*)\)$/s.exec(rule);
  if (match === null) return rule;
  const [, tool, specifier] = match as unknown as [string, string, string];
  if (!PATH_RULE_TOOLS.has(tool)) return rule;
  if (!specifier.startsWith("/") || specifier.startsWith("//")) return rule;
  return `${tool}(${fsRootAnchored(join(escapeRulePath(anchor), specifier))})`;
}

/** A relative sandbox/additional-directory path, made absolute against the tier's root. */
function anchorPath(path: unknown, anchor: string): unknown {
  if (typeof path !== "string" || path.length === 0) return path;
  if (isAbsolute(path) || path.startsWith("~")) return path;
  return resolve(anchor, path);
}

/**
 * A path spelled for CLAUDE'S SANDBOX grammar (review N-1 minor), which is not the rule grammar — the
 * grammar BOTH runtimes read a `sandbox.filesystem` entry in (the Winter runtime since `ws21/sdk` round
 * 11, which routes every deny entry through claude's glob-shape check).
 *
 * MEASURED on the pinned runtime (claude 2.1.250, macOS): a `sandbox.filesystem` entry holding any of
 * `* ? [ ]` is a GLOB — the runtime renders it as a seatbelt `(regex …)` instead of `(subpath …)` — and
 * its glob-to-regex step escapes a backslash into a LITERAL backslash, so `escapeRulePath`'s spelling
 * would make the entry name a path that does not exist (a deny that covers nothing). The one escape that
 * grammar honours is a character class: `[` → `[[]` (a lone `]` is already literal). Under a root named
 * `[wip] app`, a re-anchored `denyWrite` spelled raw did NOT stop a sandboxed write (the class matched
 * `w app`, not the literal root); spelled `[[]wip] app/…` it did. `*` and `?` have no spelling there
 * (the regex step rewrites every one of them), so they stay raw: a deny is then wider — stricter — and an
 * allow is dropped by the caller.
 *
 * ON AN ALLOW ENTRY (`allowWrite`, `allowRead`) — for a host calling this directly: the result is still a
 * glob, and claude renders a glob allow as an EXACT-path match (its trailing `/**` is stripped first), so
 * a path holding `[` covers that path itself and NOT what is under it (measured: a write inside it was
 * refused, raw or escaped); and a `*` or `?` left in the path WIDENS the allow to sibling paths. The router
 * drops such allows itself (`droppedRules`); a host must decide the same for its own.
 */
export function escapeSandboxGlobPath(path: string): string {
  return path.replace(/\[/g, "[[]");
}

const SANDBOX_UNESCAPABLE = /[*?]/;

/**
 * One `sandbox.filesystem` entry, re-anchored. The ANCHOR's part of the result — the deepest ancestor of
 * the anchor the resolved path still lies under (a `../x` lands above it) — is spelled with
 * `escapeSandboxGlobPath`, ON BOTH LEGS; the author's own part (`out/**`, `[ab]`) keeps its glob meaning.
 *
 * WHY BOTH LEGS (R.3, C-1). Both runtimes read these entries in claude's sandbox glob grammar: claude
 * always has, and the Winter runtime routes every deny entry through claude's own glob-shape check since
 * `ws21/sdk` round 11 (`splitDenyPathsByGlobShape`). A literal anchor holding `[` is then a
 * character class on either leg, and a project or home named `[wip] app` defeats the deny.
 *
 * `undefined` = dropped: an ALLOW entry whose anchor part holds an unescapable `*`/`?` (it would widen to
 * sibling paths), on either leg.
 */
function anchorSandboxPath(path: unknown, anchor: string, allowShaped: boolean): unknown {
  if (typeof path !== "string" || path.length === 0) return path;
  if (isAbsolute(path) || path.startsWith("~")) return path;
  const absolute = resolve(anchor, path);
  let base = anchor;
  while (absolute !== base && !absolute.startsWith(base.endsWith(sep) ? base : `${base}${sep}`) && dirname(base) !== base) base = dirname(base);
  if (allowShaped && SANDBOX_UNESCAPABLE.test(base)) return undefined;
  return `${escapeSandboxGlobPath(base)}${absolute.slice(base.length)}`;
}

function anchorTier(settings: Record<string, unknown>, anchor: string, dropped: (rule: string, reason: string) => void = () => undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  const permissions = out["permissions"];
  if (isPlainObject(permissions)) {
    const next: Record<string, unknown> = { ...permissions };
    for (const list of ["allow", "ask", "deny"]) {
      const rules = next[list];
      if (!Array.isArray(rules)) continue;
      next[list] = rules.flatMap((rule) => {
        if (typeof rule !== "string") return [rule];
        const anchored = anchorRule(rule, anchor);
        // REVIEW MINOR: `?` stays RAW in an anchor (an escaped `\?` never matches — measured), and a raw
        // `?` matches any one character, so an anchor holding one would WIDEN an allow rule to sibling
        // directories. An ask or deny that widens is stricter, never looser; an allow is dropped.
        if (list === "allow" && anchored !== rule && anchor.includes("?")) {
          dropped(rule, `its re-anchored form would carry the anchor's \`?\` (${anchor}), a one-character wildcard that stays raw, and so allow sibling directories too`);
          return [];
        }
        return [anchored];
      });
    }
    if (Array.isArray(next["additionalDirectories"])) next["additionalDirectories"] = (next["additionalDirectories"] as unknown[]).map((path) => anchorPath(path, anchor));
    out["permissions"] = next;
  }
  const sandbox = out["sandbox"];
  if (isPlainObject(sandbox)) {
    const next: Record<string, unknown> = { ...sandbox };
    const filesystem = next["filesystem"];
    if (isPlainObject(filesystem)) {
      const fs: Record<string, unknown> = { ...filesystem };
      for (const [key, value] of Object.entries(fs)) {
        if (!Array.isArray(value)) continue;
        // `denyWrite`/`denyRead` narrow; every other list (allowWrite, allowRead, a key added later) widens.
        const allowShaped = !key.startsWith("deny");
        fs[key] = value.flatMap((path) => {
          const anchored = anchorSandboxPath(path, anchor, allowShaped);
          if (anchored !== undefined) return [anchored];
          dropped(`sandbox.filesystem.${key}: ${String(path)}`, `its re-anchored form would carry the anchor's \`*\`/\`?\` (${anchor}), which claude's sandbox glob grammar cannot escape, and so allow sibling paths too`);
          return [];
        });
      }
      next["filesystem"] = fs;
    }
    const credentials = next["credentials"];
    if (isPlainObject(credentials) && Array.isArray(credentials["files"])) {
      next["credentials"] = { ...credentials, files: (credentials["files"] as unknown[]).map((entry) => (isPlainObject(entry) ? { ...entry, path: anchorPath(entry["path"], anchor) } : entry)) };
    }
    out["sandbox"] = next;
  }
  return out;
}

/**
 * One tier, filtered (steps 2-3). `repositoryShipped` marks a LOCAL tier git tracks (WS-24): it is refused
 * what the project tier is refused, and is still reported and env-filtered as `local`.
 */
function filterTier(settings: Record<string, unknown>, tier: Tier, brand: Pick<RunHomeBrand, "envPrefix">, dropped: (rule: string, reason: string) => void = () => undefined, repositoryShipped = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  const refusals: "project" | "local" = tier === "project" || repositoryShipped ? "project" : "local";
  for (const key of EVERY_TIER_REFUSED_MODEL_KEYS) {
    if (!Object.hasOwn(out, key)) continue;
    delete out[key];
    dropped(key, EVERY_TIER_MODEL_KEY_REASONS[key] ?? "Winter never switches model silently");
  }
  if (tier !== "user") {
    for (const key of PROJECT_TIER_REFUSED_KEYS[refusals]) delete out[key];
    for (const key of REPOSITORY_TIER_REFUSED_MODEL_KEYS) {
      if (!Object.hasOwn(out, key)) continue;
      delete out[key];
      dropped(key, "a repository never chooses models: the session's model is the daemon's, and model routing comes from the user's own settings only");
    }
    for (const key of REPOSITORY_TIER_REFUSED_EFFORT_KEYS) {
      if (!Object.hasOwn(out, key)) continue;
      delete out[key];
      dropped(key, "a repository never sets the session's effort or thinking: the session's effort is the daemon's, and these come from the user's own settings only");
    }
    for (const key of REPOSITORY_TIER_REFUSED_STYLE_KEYS) {
      if (!Object.hasOwn(out, key)) continue;
      delete out[key];
      dropped(key, "a repository never picks the session's output style: it comes from the user's own settings only");
    }
    if (refusals === "project" && Object.hasOwn(out, "plansDirectory")) {
      const problem = repositoryPlansDirectoryProblem(out["plansDirectory"]);
      if (problem !== undefined) {
        delete out["plansDirectory"];
        dropped("plansDirectory", problem);
      }
    }
    const permissions = out["permissions"];
    const mode = isPlainObject(permissions) ? permissions["defaultMode"] : undefined;
    if (isPlainObject(permissions) && typeof mode === "string" && REFUSED_DEFAULT_MODES[refusals].has(mode)) {
      const { defaultMode: _refused, ...rest } = permissions;
      if (Object.keys(rest).length === 0) delete out["permissions"];
      else out["permissions"] = rest;
      dropped(
        `permissions.defaultMode: ${mode}`,
        tier === "project"
          ? "a repository never sets the session's permission mode: claude drops an escalating mode (bypassPermissions, auto, acceptEdits) from the project tier, and merged into the user tier it would reach the child unfiltered"
          : repositoryShipped
            ? "a repository never sets the session's permission mode: this local settings file was shipped by the repository (tracked by git, reached through a link, or git could not say otherwise), so it is filtered as the project tier"
            : "the `auto` permission mode is taken from the user's own settings only (claude refuses it from a repository tier)",
      );
    }
  }
  const env = out["env"];
  if (env !== undefined) {
    if (!isPlainObject(env)) delete out["env"];
    else {
      const projectDeny = new Set(CLAUDE_PROJECT_TIER_ENV_DENY);
      const kept: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(env)) {
        if (everyTierEnvRefused(name, brand)) continue;
        if (tier !== "user" && projectDeny.has(name.toUpperCase())) continue;
        kept[name] = value;
      }
      if (Object.keys(kept).length === 0) delete out["env"];
      else out["env"] = kept;
    }
  }
  return out;
}

const REPLACED_KEYS: ReadonlySet<string> = new Set(["fallbackModel", "modelPicker"]);

function dedupe(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const value of values) {
    const key = typeof value === "string" ? `s:${value}` : `j:${JSON.stringify(value)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** F17's merge: `higher` over `lower`. */
export function mergeSettings(lower: Record<string, unknown>, higher: Record<string, unknown>, path: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    const existing = out[key];
    if (path.length === 0 && REPLACED_KEYS.has(key)) out[key] = value;
    else if (path.length === 0 && key === "extraKnownMarketplaces" && isPlainObject(existing) && isPlainObject(value)) out[key] = { ...existing, ...value };
    else if (Array.isArray(existing) && Array.isArray(value)) out[key] = dedupe([...existing, ...value]);
    else if (isPlainObject(existing) && isPlainObject(value)) out[key] = mergeSettings(existing, value, [...path, key]);
    else out[key] = value;
  }
  return out;
}

async function readTier(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  return parseTier(text);
}

/**
 * WS-24: the PROJECT tier's file, read only as the in-root file it is (`readAdmittedFile`): its real path
 * must lie inside the trusted root; one that leaves it is skipped and reported (`skippedLinks`).
 */
function readProjectTier(context: RunHomeBuildContext, path: string, root: string): Record<string, unknown> | undefined {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(path);
    realRoot = realpathSync(root);
  } catch {
    return undefined;
  }
  if (!isWithin(real, realRoot)) {
    context.report.skippedLinks.push({ path, reason: "outside-root" });
    return undefined;
  }
  const read = readAdmittedFile(real, realRoot);
  if ("refused" in read) {
    if (read.refused === "outside-root") context.report.skippedLinks.push({ path, reason: "outside-root" });
    return undefined;
  }
  return parseTier(read.text);
}

function parseTier(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Builds `<run>/settings.json` and returns exactly what it holds. */
export async function buildEffectiveSettings(context: RunHomeBuildContext): Promise<Record<string, unknown>> {
  const { input, brand, sdkHome, dir } = context;
  const tiers: Array<{ tier: Tier; path: string; anchor: string; probeRoot?: string }> = [{ tier: "user", path: join(sdkHome, "settings.json"), anchor: sdkHome }];
  // FIX ROUND 1, M2: a root (or a local anchor) at `$HOME` or above it is not a project — its dot-dir is
  // the daemon's own home — so neither repository tier is read from it.
  if (input.trustedProjectRoot !== null && !isHomeOrAbove(input.trustedProjectRoot, context.userHome)) {
    tiers.push({ tier: "project", path: join(input.trustedProjectRoot, brand.projectDirName, "settings.json"), anchor: input.trustedProjectRoot });
    const gitRoot = input.gitRoot ?? input.cwd;
    // WS-24: whether the repository shipped the local file is asked of git at the host's `gitRoot`. With
    // no `gitRoot` it is still asked — from the cwd, failing closed — when a `.git` entry sits at the
    // trusted root, the cwd or between them: the host's null then may mean "git could not answer", not
    // "no repository". With no `.git` entry anywhere there, nothing tracks the cwd's local file and it
    // keeps the local tier's filter.
    const probeRoot = input.gitRoot ?? (gitEntryNear(input.cwd, input.trustedProjectRoot, context.userHome) ? input.cwd : undefined);
    if (!isHomeOrAbove(gitRoot, context.userHome)) tiers.push({ tier: "local", path: join(gitRoot, brand.projectDirName, LOCAL_SETTINGS_FILE), anchor: gitRoot, ...(probeRoot === undefined ? {} : { probeRoot }) });
  }
  let merged: Record<string, unknown> = {};
  for (const { tier, path, anchor, probeRoot } of tiers) {
    const raw = tier === "project" ? readProjectTier(context, path, anchor) : await readTier(path);
    if (raw === undefined) continue;
    const dropped = (rule: string, reason: string): void => {
      context.report.droppedRules.push({ rule, tier, reason });
    };
    // Probed only once the file has parsed, so a build without one spawns nothing.
    const repositoryShipped = tier === "local" && probeRoot !== undefined && (await localTierShippedByRepository(probeRoot, brand.projectDirName, context.internals.git));
    merged = mergeSettings(merged, anchorTier(filterTier(raw, tier, brand, dropped, repositoryShipped), anchor, dropped));
  }
  const settings = stripForMode(merged, input.mode, input.dispatchChild);
  const effective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) if (CLAUDE_SETTINGS_KEY_SET.has(key)) effective[key] = value;
  await writeFile(join(dir, "settings.json"), `${JSON.stringify(effective, null, 2)}\n`, { mode: PRIVATE_FILE, flag: "wx" });
  return effective;
}

/**
 * Spec §3.2's per-mode stripping. Outside code mode the permission grants, hooks, env, plugins and
 * output style are removed and native auto-memory is OFF (chat and dispatch keep the daemon's own
 * `_assistant` injection, spec §3.7 r3). A dispatch child loses its output style.
 */
export function stripForMode(settings: Record<string, unknown>, mode: RunHomeBuildContext["input"]["mode"], dispatchChild: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  if (mode !== "code") {
    for (const key of ["hooks", "env", "enabledPlugins", "outputStyle"]) delete out[key];
    const permissions = out["permissions"];
    if (isPlainObject(permissions)) {
      const { allow: _allow, ask: _ask, ...rest } = permissions;
      if (Object.keys(rest).length === 0) delete out["permissions"];
      else out["permissions"] = rest;
    }
    out["autoMemoryEnabled"] = false;
  } else if (dispatchChild) {
    delete out["outputStyle"];
  }
  return out;
}
