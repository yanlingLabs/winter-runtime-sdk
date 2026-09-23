// WS-14 §2: THE OPTIONS TEMPLATE — the exact object this branch configures the vendor runtime with.
//
// §2 is "a contract, not implementation code": the normative rules live in §3–§10 and this module is
// where they become one object. Every field below is either something a spec section names or
// something a spec section forbids, and the forbidden ones are enforced by `assertOptionsInvariants`
// rather than by absence, because absence is not checkable in a host's own options object.
//
// THE ONE MEASUREMENT THAT CHANGED THE SHAPE OF THIS FILE. `plansDirectory`, `autoMemoryEnabled` and
// `autoMemoryDirectory` — three fields §2 lists in the template — ARE NOT ON THE PINNED RUNTIME'S
// `Options` AT ALL. They are settings fields (the spine measured this and left it as a carry: "which
// door actually delivers them to a session is unverified, and an unknown key on `Options` is the kind
// of thing a runtime ignores in silence"). Written as top-level options they would be accepted by the
// index signature, ignored by the runtime, and plan mode would fall back to the vendor's own
// user-level plans directory — which is exactly the thing WS-17 row 14 must prove impossible.
//
// So they are delivered through `Options.settings`, which §2's own template already carries for
// project settings and which the pinned declaration types as `string | Settings` ("a path to a
// settings JSON file OR a settings object... loaded into the FLAG SETTINGS layer, the highest
// priority among user-controlled settings"). MEASURED: a session given `settings: { model: … }` and
// no top-level model sent that model on its first request, so the flag layer is live and is the door.
// `test/official/runtime-options.test.ts` re-measures it rather than trusting this comment.
//
// GOLDEN CAPTURES PER MODE (§15) are `test/official/fixtures/options-<mode>.golden.json`: the built
// object with functions and instances replaced by markers, so a diff shows a field that moved, an
// invariant that was dropped, or a name that stopped being brand-derived.
import { isAbsolute, join } from "node:path";
import { mcpToolName, type BrandProfile, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import type { OfficialOptions } from "../seams/official-sdk-shapes.ts";
import type { OfficialRunHomeBinding, OptionsTemplateInput } from "../seams/official-adapter.ts";
import { protectedPathRules } from "../run-home/types.ts";
import { officialToolAliases } from "./aliases.ts";
import { createApprovalBridge, createContainmentHooks, isOurApprovalBridge, isOurContainmentHook, type OfficialPermissionMode } from "./callbacks.ts";
import type { OfficialApprovalBridge } from "./callbacks.ts";
import { containmentPaths, officialDisallowedTools, type ContainmentPolicy } from "./containment.ts";
import { officialBranchLabel } from "./branding.ts";
import { OfficialConfigurationError } from "./errors.ts";

/**
 * WS-21 §3.6: the resume placeholder's last segment. On a store-backed resume the door sets
 * `Options.env.CLAUDE_CONFIG_DIR` to `<run folder>/<this>`: a path inside a folder named by a random
 * UUID (so unpredictable), never created, under the daemon's write-fenced cache — so the wrapper's
 * staging step finds nothing there to copy (F11).
 */
export const RUN_HOME_ABSENT_SEGMENT = ".absent";

/** The vendor's own preset name — a Claude-mirroring literal, fixed (WS-01 §5 / D16). */
export const PINNED_SYSTEM_PROMPT_PRESET = "claude_code";

/**
 * §2's pinned auto-memory load cap, "kept in the compatibility profile".
 *
 * DATA, NOT AN OPTION: the pinned runtime exposes no knob for it, so the cap is something the HOST
 * applies when it writes the shared memory file. It lives here because this is where a reader looks
 * for the memory contract, and because a number that exists only in a spec sentence is a number that
 * gets rounded.
 */
export const AUTO_MEMORY_LOAD_CAP = { lines: 200, bytes: 25 * 1024 } as const;

/**
 * §16 OPEN QUESTION 1, FIXED HERE, PER MODE, WITH THE REASON.
 *
 * "`excludeDynamicSections` default: report §124 shows `true` in the safe template; dynamic sections
 * carry env/context blocks the host may want. The per-mode default is left to the mode-host policy
 * and MUST BE FIXED BEFORE GOLDEN CAPTURES FREEZE."
 *
 * FIXED AT `true` FOR EVERY MODE. The argument is §4's, not a preference: "whether project context is
 * appended to the system prompt or injected as a Winter-owned context message is a single host-wide
 * choice, and BOTH BRANCHES MUST USE THE SAME CHOSEN SEMANTICS SO THEY AGREE WITH EACH OTHER". The
 * vendor's dynamic sections are assembled by the vendor runtime from its own view of the environment
 * and its own project-context conventions; the other branch cannot reproduce them, so leaving them on
 * makes the two branches disagree in the one place a handoff makes visible — mid-session, to a user
 * who just switched runtimes. The deterministic append (§4's ordered build) is what carries the
 * context instead, identically on both.
 *
 * A HOST CAN STILL OVERRIDE, per mode, and the golden captures show which value each mode was built
 * with — so a change is a diff rather than a discovery.
 */
export const DEFAULT_EXCLUDE_DYNAMIC_SECTIONS: Readonly<Record<OptionsTemplateInput["mode"], boolean>> = { code: true, dispatch: true, chat: true };

/** Host policy for the template — everything §2 leaves to the mode host (WS-15) or to the session. */
export interface OptionsTemplatePolicy {
  /** §4's deterministically-built instructions, appended to the pinned preset. */
  systemPromptAppend?: string;
  /** §16 q1. Absent → `DEFAULT_EXCLUDE_DYNAMIC_SECTIONS` for the mode. */
  excludeDynamicSections?: boolean;
  /**
   * §5: default `"batched"`; sessions that ADVERTISE CROSS-RUNTIME HANDOFF must use `"eager"` — it
   * narrows the mirror-lag window. Derived from `advertisesHandoff` rather than set directly, so the
   * rule is expressed once and cannot be half-applied.
   */
  advertisesHandoff?: boolean;
  /** Additional flag-layer settings the host has already checked against the runtime's schema (§2). */
  settings?: Readonly<Record<string, unknown>>;
  /** §11's server entry, already materialized. */
  mcpServers?: Readonly<Record<string, unknown>>;
  /**
   * The daemon's subagent definitions, handed to BOTH runtime legs from one owner (Winter leg:
   * `Options.agents` on the pinned SDK; this leg: the identical pinned `Options.agents?:
   * Record<string, AgentDefinition>` on the official runtime — no new capability, only the same one
   * reaching the second leg). Typed as loosely as `mcpServers`/`settings` (`Readonly<Record<string,
   * unknown>>`, the strictest of this policy's own untyped-passthrough fields) rather than against
   * the Winter SDK's own `AgentDefinition`, so accepting it never forces this package's peer floor
   * upward — the value crosses unchanged, this branch never reads a field of one. Absent stays
   * absent (see `buildOfficialOptions`): an empty object here would tell the runtime "zero subagents
   * are defined" instead of "the host declared none", which is a different, narrower agent surface
   * than a session that never mentioned `agents` at all.
   */
  agents?: Readonly<Record<string, unknown>>;
  // WS-21: NO `plugins` FIELD. Through 0.0.11 a host named the plugin directories this branch loaded
  // here; since WS-21 the plugins a session loads are the run home's `enabledPlugins`, installed under
  // the shared plugin root the router points `CLAUDE_CODE_PLUGIN_CACHE_DIR` at — one mechanism for both
  // runtimes, gated by mode in the run home's settings (spec §5.3). `Options.plugins` is refused outright
  // (`assertOptionsInvariants`): a session-scoped plugin directory is a second door nobody reviews.
  /** §10's bridge. Absent -> a fail-closed one is installed, because the invariants require one. */
  canUseTool?: OfficialApprovalBridge;
  /** The session's permission mode, for the fail-closed bridge the template installs. */
  permissionMode?: OfficialPermissionMode;
  /** §10's hook bridge (WS-08 owns its contract). */
  hooks?: unknown;
  /** §3's built child environment. Built by `buildChildEnv`, because only it has the credentials. */
  env?: Readonly<Record<string, string>>;
  /** The creation transaction's pre-allocated backend id (WS-16). */
  sessionId?: string;
  /** Resume/fork (§5.1): a fork registers as a NEW record and inherits no handoff certification. */
  resume?: string;
  forkSession?: boolean;
  containment?: ContainmentPolicy;
  /**
   * §5.1: the ONLY documented `extraArgs` route. Anything else is refused. ABSOLUTE (0.0.11): the
   * runtime resolves a relative path against the session's working directory — the project.
   */
  appendSystemPromptFile?: string;
  /** Extra tool names this deployment denies, merged with the containment floor's own list. */
  additionalDisallowedTools?: readonly string[];
}

/** Puts the containment matchers FIRST, then whatever the host installed for the same events. */
export function mergeHooks(ours: Record<string, unknown[]>, hostHooks: unknown): Record<string, unknown[]> {
  const host = (hostHooks ?? {}) as Record<string, unknown[]>;
  const merged: Record<string, unknown[]> = { ...host };
  for (const [event, matchers] of Object.entries(ours)) merged[event] = [...matchers, ...(host[event] ?? [])];
  return merged;
}

/**
 * The settings the flag layer must carry for this branch to behave (see this module's header).
 *
 * The flag layer is the highest user-controlled layer, so these PIN: the auto-memory directory (F19b —
 * a repository's `autoMemoryDirectory` is read per-source, whatever the setting sources are, and the
 * flag layer is what beats it), whether auto-memory is on (WS-21: from the run home's effective
 * settings, never hard-coded; the pre-WS-21 profile keeps `true`), the plans directory, and — for a run
 * home — the protected-path `permissions.ask` rules (spec §7.2), which the runtime checks before its
 * bypass step. The host's own flag settings are MERGED under them, `permissions` included: a host's
 * `permissions.deny` survives, and the protected `ask` rules are appended to the host's own.
 */
export function brandedFlagSettings(args: {
  brand: Pick<BrandProfile, "projectDirName">;
  autoMemoryDirectory: string;
  autoMemoryEnabled: boolean;
  protectedAsk?: readonly string[];
  /** V19: the user's own skill visibility, pinned above a repository's per-source read. */
  skillOverrides?: Readonly<Record<string, unknown>>;
  extra?: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const extra = args.extra ?? {};
  const hostPermissions = extra["permissions"];
  const permissions: Record<string, unknown> | undefined =
    args.protectedAsk === undefined || args.protectedAsk.length === 0
      ? undefined
      : {
          ...(hostPermissions !== null && typeof hostPermissions === "object" && !Array.isArray(hostPermissions) ? (hostPermissions as Record<string, unknown>) : {}),
          ask: [...(Array.isArray((hostPermissions as { ask?: unknown } | undefined)?.ask) ? ((hostPermissions as { ask: unknown[] }).ask as unknown[]) : []), ...args.protectedAsk],
        };
  return {
    ...extra,
    ...(permissions === undefined ? {} : { permissions }),
    ...(args.skillOverrides === undefined ? {} : { skillOverrides: { ...args.skillOverrides } }),
    // §2: "else plan mode falls back to the vendor's own user-level plans directory".
    plansDirectory: containmentPaths(args.brand).plans,
    autoMemoryEnabled: args.autoMemoryEnabled,
    autoMemoryDirectory: args.autoMemoryDirectory,
  };
}

/**
 * Builds §2's template.
 *
 * Nothing here reads ambient state: every value is either an argument, a brand derivation, or a
 * constant this file declares. That is what makes the golden captures meaningful — two runs of the
 * same input produce the same object, on any machine.
 */
export function buildOfficialOptions(input: OptionsTemplateInput, policy: OptionsTemplatePolicy = {}): OfficialOptions {
  const branchLabel = officialBranchLabel(input.brand);
  const excludeDynamicSections = policy.excludeDynamicSections ?? DEFAULT_EXCLUDE_DYNAMIC_SECTIONS[input.mode];

  const options: OfficialOptions = {
    cwd: input.cwd,

    // WS-21 §3.5: with a run home, the USER source only — which is the run folder the router built, the
    // one place the trusted project's tiers reach this child (merged by the router, ruling Q1). Without
    // one, the pre-WS-21 profile: no discovery at all. `project`/`local` are never offered. Discovery
    // ONLY either way — §8's containment handles the built-ins that carry vendor-named paths.
    settingSources: input.runHome === undefined ? [] : ["user"],

    // The flag layer: the fields §2 names that are not on `Options` at all, the run home's pins, plus
    // whatever the host has already verified against the runtime's own settings schema.
    settings: brandedFlagSettings({
      brand: input.brand,
      autoMemoryDirectory: input.runHome?.memoryDir ?? input.autoMemoryDirectory,
      autoMemoryEnabled: input.runHome?.autoMemoryEnabled ?? true,
      ...(input.runHome === undefined ? {} : { protectedAsk: protectedPathRules(input.runHome.sdkHome, input.runHome.trustedProjectRoot, input.brand) }),
      ...(input.runHome?.skillOverrides === undefined ? {} : { skillOverrides: input.runHome.skillOverrides }),
      ...(policy.settings === undefined ? {} : { extra: policy.settings }),
    }),

    // 0.0.11: NO PLUGIN OF THE ROUTER'S OWN — this template used to name the session's own project
    // directory here, and the runtime ran that directory's hooks with no trust decision anywhere.
    // WS-21: no `plugins` key at all; plugins come from the run home's `enabledPlugins`.

    systemPrompt: {
      type: "preset",
      preset: PINNED_SYSTEM_PROMPT_PRESET,
      ...(policy.systemPromptAppend === undefined ? {} : { append: policy.systemPromptAppend }),
      excludeDynamicSections,
    },

    // WS-21 §3.4.5: with a run home, the runtime also loads the servers of the run folder's MCP config
    // (the user's, the local scope and the trusted project's, filtered by the router). Without one, the
    // host is the sole owner of every server (WS-14 §11).
    strictMcpConfig: input.runHome === undefined,
    ...(policy.mcpServers === undefined ? {} : { mcpServers: { ...policy.mcpServers } }),
    // The SAME subagent set the Winter leg is handed via `Options.agents`, forwarded verbatim (own
    // key, same shallow-copy discipline as `mcpServers` above) — never read here, never merged with
    // anything this branch owns.
    ...(policy.agents === undefined ? {} : { agents: { ...policy.agents } }),

    // WS-05 §6 / §5: ONE store instance, shared with the other branch. WS-18 W18-14 (P10b): the
    // caller (the door, `door.ts`) is the one that wraps it with `claude-ready-store.ts`'s
    // `claudeReadyStore(...)` before it ever reaches here — this template does not know or care
    // whether `input.sessionStore` is the raw shared store or that wrapper; both satisfy `SessionStore`
    // structurally, and `load()` is the only member the wrapper's caller can tell apart.
    sessionStore: input.sessionStore as unknown as SessionStore,
    sessionStoreFlush: policy.advertisesHandoff === true ? "eager" : "batched",

    toolAliases: officialToolAliases(input.brand),
    disallowedTools: [...officialDisallowedTools(policy.containment ?? {}, input.brand), ...(policy.additionalDisallowedTools ?? [])],

    includePartialMessages: true,
    includeHookEvents: true,
    perTaskStopAffordance: true,

    // §8's floor is installed as a PreToolUse hook ALWAYS, merged ahead of the host's own matchers —
    // see `createContainmentHooks` for the measurement that made this mandatory (the permission
    // callback is not consulted for every tool on this runtime).
    hooks: mergeHooks(createContainmentHooks({ brand: input.brand, ...(policy.containment === undefined ? {} : { containment: policy.containment }) }), policy.hooks),
    // §10's bridge is INSTALLED, not merely accepted (review r2, NEW-1): the invariants below refuse an
    // options object without it, so the template must produce one. A host that supplies its own broker
    // gets it wrapped; a host that supplies none gets a fail-closed one that says so.
    canUseTool:
      policy.canUseTool ??
      createApprovalBridge({
        brand: input.brand,
        mode: policy.permissionMode ?? "default",
        ...(policy.containment === undefined ? {} : { containment: policy.containment }),
        broker: async (request) => ({
          behavior: "deny",
          message: `no approval broker is configured for this session, so ${request.toolName} cannot be approved; this branch owns permissions (settingSources is empty) and a host must bridge its broker into canUseTool (WS-14 §10)`,
          toolUseID: request.toolUseID,
        }),
      }),
    ...(policy.env === undefined ? {} : { env: { ...policy.env } }),
    ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
    ...(policy.resume === undefined ? {} : { resume: policy.resume }),
    ...(policy.forkSession === undefined ? {} : { forkSession: policy.forkSession }),
    // WS-18 W18-17 door 1 (P10b): request Claude's own SUMMARIZED thinking display on every official
    // launch, without touching the thinking TYPE or budget the leg already derives — `extraArgs` is
    // the ONLY documented route (§5.1), and `--thinking-display` is present in the pinned 2.1.250
    // binary though hidden from `--help` (measured). Merged with `appendSystemPromptFile`'s own
    // `extraArgs` entry rather than replacing it — a host using both gets both.
    extraArgs: { "thinking-display": "summarized", ...(policy.appendSystemPromptFile === undefined ? {} : { "append-system-prompt-file": policy.appendSystemPromptFile }) },

    // §5.1: the VENDORED runtime, never the user's installed binary.
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    // §6 (D12): every generation of a handoff-capable session goes through the proxy.
    spawnClaudeCodeProcess: input.spawnProxy,
  };

  assertOptionsInvariants(options, branchLabel, { projectDirName: input.brand.projectDirName, ...(input.runHome === undefined ? {} : { runHome: input.runHome }) });
  return options;
}

/**
 * THE ONE PERMISSION-MODE RULE, for the launch path and for every live setter (0.0.10).
 *
 * `bypassPermissions` IS REFUSED, and the runtime says why itself. Measured (review r3, NEW-13): in
 * that mode a session with the template's own fail-closed bridge ran `Write` and `Bash` anyway, and the
 * runtime emitted `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` — "canUseTool will not be invoked: permissionMode
 * 'bypassPermissions' auto-approves every tool call … To gate every tool call, use a PreToolUse hook
 * instead." This branch owns permissions (its `settingSources` is empty), so a mode that shadows the
 * owner is not a mode it can offer. Containment is unaffected either way — the floor is a hook and it
 * holds in that mode — but the bridge's claim to decide would be false.
 *
 * WHY IT IS A FUNCTION RATHER THAN A LINE INSIDE `assertOptionsInvariants`: `Query.setPermissionMode`
 * gives a host a SECOND way to reach a mode, one that never passes through the options template at
 * all. Two copies of this refusal would be two rules one edit apart, and the failure mode is silent —
 * a live switch into a mode the launch path refuses, on a session whose bridge then decides nothing.
 * The refusal is the same class, the same `option` field and the same sentence at both doors.
 *
 * THE VOCABULARY IS NOT RE-CHECKED HERE, deliberately: `OfficialPermissionMode` is what makes a mode
 * outside the seam's five unspellable, and adding a runtime vocabulary check on this door alone would
 * make the live rule STRICTER than the launch rule — which is the asymmetry this function exists to
 * remove.
 */
export function assertPermissionModeAllowed(mode: unknown, branchLabel: string): void {
  if (mode !== "bypassPermissions") return;
  throw new OfficialConfigurationError({
    option: "permissionMode",
    reason:
      "`bypassPermissions` auto-approves every tool call and shadows `canUseTool` (the runtime warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), so the broker this branch bridges to would never be asked — this branch owns permissions and cannot offer a mode that removes its own owner (WS-14 §10)",
    branchLabel,
  });
}

/**
 * §5.1's withheld options and §2's required ones, as refusals.
 *
 * WHY A VALIDATOR AND NOT JUST A CAREFUL BUILDER: `launch()` accepts an options object the CALLER
 * built (the seam's `OfficialLaunchPlan.options`), so the builder's care protects only the callers who
 * used it. These are the invariants that must hold for anything this adapter launches.
 */
export interface OptionsInvariantContext {
  /** The brand's project directory name (kept for callers; no rule reads it since `plugins` is refused whole). */
  projectDirName?: string;
  /** The session's working directory as the LAUNCH names it, for options that carry no `cwd` of their own. */
  cwd?: string;
  /**
   * WS-21: the run home this launch runs on. Its presence is the ONLY thing that makes
   * `settingSources: ["user"]` and `strictMcpConfig: false` legal, and it names the one config dir the
   * child may be given (the run folder, or the unpredictable placeholder inside it on a resume).
   */
  runHome?: Pick<OfficialRunHomeBinding, "dir">;
}

export function assertOptionsInvariants(options: OfficialOptions, branchLabel: string, context: OptionsInvariantContext = {}): void {
  const refuse = (option: string, reason: string): never => {
    throw new OfficialConfigurationError({ option, reason, branchLabel });
  };
  if ("enableFileCheckpointing" in options && options.enableFileCheckpointing !== undefined) {
    refuse(
      "enableFileCheckpointing",
      "it is incompatible with a store-backed session (the combination throws in the pinned runtime), and checkpoint/rewind is reported UNAVAILABLE on this branch rather than shipped as a silently broken undo (WS-14 §5.1)",
    );
  }
  if (options.persistSession === false && options.sessionStore !== undefined) {
    refuse("persistSession", "a non-persistent session bypasses the shared store and can therefore never advertise handoff; the two options are incompatible (WS-14 §5.1)");
  }
  if (options.sessionStore === undefined) {
    refuse("sessionStore", "this branch always runs with the shared compatibility store — the canonical transcript is what makes a session hand-off-able at all (WS-14 §5)");
  }
  const executable = options.pathToClaudeCodeExecutable;
  if (typeof executable !== "string" || executable.length === 0) {
    refuse("pathToClaudeCodeExecutable", "the vendored runtime must be named explicitly; leaving it unset resolves whatever copy the ambient install happens to provide (WS-14 §5.1)");
  } else if (!executable.includes("/")) {
    refuse("pathToClaudeCodeExecutable", `${executable} is a bare command name, which resolves through PATH to the user's own installed binary — this branch is isolated from it (WS-14 §5.1)`);
  }
  // WS-21 §3.5: ONE RULE FOR THE SETTING SOURCES, keyed on the run home. Without one: no source at all
  // (WS-14 §2). With one: exactly the user source, which is the run folder — never `project`/`local`,
  // which would have the runtime read the repository's own vendor-named files (ruling Q1).
  const sources = options.settingSources;
  if (context.runHome === undefined) {
    if (sources !== undefined && sources.length > 0) {
      refuse("settingSources", "this branch reads no vendor-named settings source without a run home — `user` is legal only on a router-built run folder (WS-14 §2, WS-21 §3.5)");
    }
    if (options.strictMcpConfig !== true) {
      refuse("strictMcpConfig", "without a run home the host is the sole owner of every MCP server and tool effect on this branch (WS-14 §11)");
    }
  } else {
    if (sources === undefined || sources.length !== 1 || sources[0] !== "user") {
      refuse("settingSources", `a run-home launch reads the user source and nothing else (got ${JSON.stringify(sources)}); \`project\` and \`local\` would read the repository's own files, which the router merged itself (WS-21 §3.5, ruling Q1)`);
    }
    if (options.strictMcpConfig !== false) {
      refuse("strictMcpConfig", "a run-home launch loads the run folder's MCP config (WS-21 §3.4.5); the router pins `strictMcpConfig: false`");
    }
    const configDir = (options.env as Record<string, string | undefined> | undefined)?.["CLAUDE_CONFIG_DIR"];
    if (configDir !== undefined && configDir !== context.runHome.dir && configDir !== join(context.runHome.dir, RUN_HOME_ABSENT_SEGMENT)) {
      refuse("env.CLAUDE_CONFIG_DIR", `a run-home launch's config dir is its run folder (or, on a resume, the placeholder inside it); ${configDir} is neither (WS-21 §3.1, §3.6)`);
    }
  }
  // REVIEW r2, NEW-1 — §8's FLOOR IS AN INVARIANT OF EVERY LAUNCH, not a courtesy of this builder.
  //
  // The measurement: `launch()` spread the CALLER's options and overrode only the spawn hook, so an
  // options object built by hand (or built here and then edited) reached the runtime with no floor —
  // and a model-emitted `EnterWorktree` created `<cwd>/.claude/worktrees/feature` through the
  // adapter's own door. `canUseTool` is not consulted for that writer at all, so the hook is its ONLY
  // floor; an invariant that did not check for it was checking the wrong things.
  //
  // IDENTITY, NOT THE MARK (review r4, NEW-18). The marks make the floor and the bridge VISIBLE on an
  // object we did not build; they are exported `Symbol.for` keys, so they are stampable, and a hook
  // stamped with the floor's mark was measured standing in for the floor on the launch path. What is
  // demanded here is a hook `createContainmentHooks` built and a bridge `createApprovalBridge` built —
  // `WeakSet` membership, which nothing outside `callbacks.ts` can confer.
  const hooks = (options["hooks"] ?? {}) as Record<string, Array<{ hooks?: unknown[] }>>;
  const hasFloor = (hooks["PreToolUse"] ?? []).some((matcher) => (matcher.hooks ?? []).some((hook) => isOurContainmentHook(hook)));
  if (!hasFloor) {
    refuse(
      "hooks.PreToolUse",
      "§8's containment floor is missing, or is not this branch's (a hook merely stamped with the exported mark is not the floor): the permission callback is not consulted for every tool on this runtime (the worktree writers never reach it), so the PreToolUse hook is the only point every call passes through — a session without it can create vendor-named paths (WS-14 §8/§10)",
    );
  }
  if (!isOurApprovalBridge(options["canUseTool"])) {
    refuse(
      "canUseTool",
      "the approval bridge is missing or is not this branch's: §10's decisions must go through the bridge that applies the containment floor first and returns a typed PermissionResult (never `null`)",
    );
  }

  // WS-21 — `Options.plugins` IS REFUSED WHOLE, on every launch (hand-built options included). The
  // plugins a session loads are its run home's `enabledPlugins`, read by the runtime from the shared
  // plugin root (spec §5.3); a session-scoped plugin directory is code no trust decision named. Through
  // 0.0.11 the entries were validated one by one; there is no longer a legal entry to validate.
  if (options["plugins"] !== undefined) {
    refuse("plugins", "the plugins a session loads come only from its run home's `enabledPlugins` under the shared plugin root (WS-21 §5.3); a session-scoped plugin directory is refused");
  }

  // REVIEW r3, NEW-13 — `bypassPermissions` IS REFUSED. ONE RULE, TWO DOORS since 0.0.10: the launch
  // path asserts it here and the LIVE setters (`OfficialSessionHandle.setPermissionMode`, and the door
  // handle's own member) call the same function, so a mid-session switch can never reach a mode a
  // launch would have refused. See `assertPermissionModeAllowed` for the measurement.
  assertPermissionModeAllowed(options["permissionMode"], branchLabel);

  const extraArgs = options["extraArgs"];
  if (extraArgs !== undefined) {
    const keys = Object.keys(extraArgs as Record<string, unknown>);
    // `thinking-display` is W18-17 door 1 (P10b): the router's own request for summarized thinking,
    // present on every official launch — `append-system-prompt-file` stays the other documented route.
    const stray = keys.filter((key) => key !== "append-system-prompt-file" && key !== "thinking-display");
    if (stray.length > 0) {
      refuse("extraArgs", `${stray.join(", ")} is outside the pinned contract; only the documented append-system-prompt-file and thinking-display routes are available (WS-14 §5.1, WS-18 §6)`);
    }
    // 0.0.11 (review): the runtime resolves a RELATIVE append file against the child's working
    // directory — the project — so a relative value is a project-controlled prompt file.
    const appendFile = (extraArgs as Record<string, unknown>)["append-system-prompt-file"];
    if (keys.includes("append-system-prompt-file") && (typeof appendFile !== "string" || !isAbsolute(appendFile) || appendFile.includes("\u0000"))) {
      refuse("extraArgs", "append-system-prompt-file must be an absolute path; the runtime resolves a relative one against the session's working directory, so it would name a file the project controls (WS-14 §5.1)");
    }
  }
}

/**
 * A golden-capturable view of a built options object (§15's "options-template golden captures").
 *
 * FUNCTIONS AND INSTANCES BECOME MARKERS, because their identity is not stable across runs and their
 * bodies are not what the capture is about. What the capture pins is the SHAPE: which fields are set,
 * to which literal values, with which brand-derived names — and, for the three things that are
 * objects with behaviour, that they are present and which one they are.
 */
export function captureOptions(options: OfficialOptions): Record<string, unknown> {
  // REVIEW r1, m2 — `env` VALUES ARE MASKED HERE, not by the caller. The committed goldens were clean
  // only because the test happened to pass the literal `"<redacted>"` as the credential; a host that
  // used this exported helper on real options would have written a live credential into a fixture,
  // which is the thing §12 forbids in the same sentence as "never written to disk". Names survive
  // (the golden is about WHICH variables the child gets), values do not.
  const captured: OfficialOptions =
    options.env === undefined ? options : { ...options, env: Object.fromEntries(Object.keys(options.env).map((name) => [name, "<redacted>"])) };
  const marker = (value: unknown): unknown => {
    if (typeof value === "function") return "<function>";
    if (value !== null && typeof value === "object") {
      const constructorName = (value as { constructor?: { name?: string } }).constructor?.name;
      if (constructorName !== undefined && constructorName !== "Object" && constructorName !== "Array") return `<instance ${constructorName}>`;
      if (Array.isArray(value)) return value.map(marker);
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, marker(entry)]),
      );
    }
    return value;
  };
  return marker(captured) as Record<string, unknown>;
}

/** The canonical name an aliased built-in resolves to — re-exported so a capture reader has one import. */
export { mcpToolName };
