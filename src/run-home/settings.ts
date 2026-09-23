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
//   1. read the tiers — project and local only for a trusted project;
//   2. drop the keys the runtime refuses from that tier (`PROJECT_TIER_REFUSED_KEYS`, from the pinned
//      runtime: its trusted-source-only readers and its repo-controllable warnings);
//   3. filter `env` — the runtime's own per-tier sets, plus `CLAUDE_CONFIG_DIR` and every variable the
//      ROUTER sets (a settings `env` block would otherwise override the process environment the router
//      built), plus the router's refused execution-indirection list;
//   4. re-anchor every path that was relative to the tier's own root (`/x` rules, sandbox paths,
//      additional directories) — in the run folder they would resolve against the run folder;
//   5. merge with the runtime's rules (arrays concatenated and deduplicated; `fallbackModel` and
//      `modelPicker` replaced; `extraKnownMarketplaces` shallow; everything else deep);
//   6. strip per mode (spec §3.2);
//   7. keep only the pinned runtime's own `Settings` keys, and write the file (0600).
//
// THE PROJECT TIER ANCHORS AT THE PROJECT ROOT (WS-21 DECISION, L2.4). F17 measured "project → the
// cwd" on a runtime that reads its project file AT the cwd, so there the two are the same directory.
// Here the project file is the trusted root's, and a cwd below it would move a `Read(/secrets)` deny
// off the path its author meant. The runtime's own schema text says project paths are "relative to
// the settings file root (project root for project settings)".
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { envName } from "@yanlinglabs/winter-agent-sdk";

import { ALL_AUTH_VARIABLES, NEVER_INJECTED_AUTH_VARIABLES } from "../official/auth.ts";
import { isExecutionIndirectionVariable, OFFICIAL_RUNTIME_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "../official/env-allowlist.ts";
import type { RunHomeBuildContext } from "./build.ts";
import { fsRootAnchored, type RunHomeBrand } from "./types.ts";

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
 * before the merge promotes it to the user tier (F17, extended from the pinned binary):
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
 * `permissions.defaultMode: "auto"` is handled beside these (a value, not a key).
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
 * The pinned runtime's env filter for the project and local tiers (its own set, verbatim; matched
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

/** The pinned runtime's env filter for EVERY tier (its own set, verbatim). */
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

/** Rule names whose specifier is a PATH (the runtime's file-permission rules). */
const PATH_RULE_TOOLS: ReadonlySet<string> = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** `Tool(/x)` → `Tool(//<anchor>/x)` for a path tool; every other form is returned as written. */
export function anchorRule(rule: string, anchor: string): string {
  const match = /^([A-Za-z]+)\((.*)\)$/s.exec(rule);
  if (match === null) return rule;
  const [, tool, specifier] = match as unknown as [string, string, string];
  if (!PATH_RULE_TOOLS.has(tool)) return rule;
  if (!specifier.startsWith("/") || specifier.startsWith("//")) return rule;
  return `${tool}(${fsRootAnchored(join(anchor, specifier))})`;
}

/** A relative sandbox/additional-directory path, made absolute against the tier's root. */
function anchorPath(path: unknown, anchor: string): unknown {
  if (typeof path !== "string" || path.length === 0) return path;
  if (isAbsolute(path) || path.startsWith("~")) return path;
  return resolve(anchor, path);
}

function anchorTier(settings: Record<string, unknown>, anchor: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  const permissions = out["permissions"];
  if (isPlainObject(permissions)) {
    const next: Record<string, unknown> = { ...permissions };
    for (const list of ["allow", "ask", "deny"]) {
      const rules = next[list];
      if (Array.isArray(rules)) next[list] = rules.map((rule) => (typeof rule === "string" ? anchorRule(rule, anchor) : rule));
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
      for (const [key, value] of Object.entries(fs)) if (Array.isArray(value)) fs[key] = value.map((path) => anchorPath(path, anchor));
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

function filterTier(settings: Record<string, unknown>, tier: Tier, brand: Pick<RunHomeBrand, "envPrefix">): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings };
  if (tier !== "user") {
    for (const key of PROJECT_TIER_REFUSED_KEYS[tier]) delete out[key];
    const permissions = out["permissions"];
    if (isPlainObject(permissions) && permissions["defaultMode"] === "auto") {
      const { defaultMode: _refused, ...rest } = permissions;
      if (Object.keys(rest).length === 0) delete out["permissions"];
      else out["permissions"] = rest;
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
  const tiers: Array<{ tier: Tier; path: string; anchor: string }> = [{ tier: "user", path: join(sdkHome, "settings.json"), anchor: sdkHome }];
  if (input.trustedProjectRoot !== null) {
    tiers.push({ tier: "project", path: join(input.trustedProjectRoot, brand.projectDirName, "settings.json"), anchor: input.trustedProjectRoot });
    const gitRoot = input.gitRoot ?? input.cwd;
    tiers.push({ tier: "local", path: join(gitRoot, brand.projectDirName, "settings.local.json"), anchor: gitRoot });
  }
  let merged: Record<string, unknown> = {};
  for (const { tier, path, anchor } of tiers) {
    const raw = await readTier(path);
    if (raw === undefined) continue;
    merged = mergeSettings(merged, anchorTier(filterTier(raw, tier, brand), anchor));
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
