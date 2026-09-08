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
import { mcpToolName, type BrandProfile, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import type { OfficialOptions } from "../seams/official-sdk-shapes.ts";
import type { OptionsTemplateInput } from "../seams/official-adapter.ts";
import { officialToolAliases } from "./aliases.ts";
import type { OfficialApprovalBridge } from "./callbacks.ts";
import { containmentPaths, officialDisallowedTools, type ContainmentPolicy } from "./containment.ts";
import { officialBranchLabel } from "./branding.ts";
import { OfficialConfigurationError } from "./errors.ts";

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
  /** §10's bridge. */
  canUseTool?: OfficialApprovalBridge;
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
  /** §5.1: the ONLY documented `extraArgs` route. Anything else is refused. */
  appendSystemPromptFile?: string;
  /** Extra tool names this deployment denies, merged with the containment floor's own list. */
  additionalDisallowedTools?: readonly string[];
}

/** The settings the flag layer must carry for this branch to behave (see this module's header). */
export function brandedFlagSettings(args: { brand: Pick<BrandProfile, "projectDirName">; autoMemoryDirectory: string; extra?: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  return {
    ...(args.extra ?? {}),
    // §2: "else plan mode falls back to the vendor's own user-level plans directory".
    plansDirectory: containmentPaths(args.brand).plans,
    // §2's supersession note: shared memory is the target — enabled, with the ONE shared directory.
    autoMemoryEnabled: true,
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

    // §2: no user/project/local discovery of vendor-named sources. Discovery ONLY — §8's containment
    // is what handles the built-ins that carry vendor-named paths in their own semantics.
    settingSources: [],

    // The flag layer: the three fields §2 names that are not on `Options` at all, plus whatever the
    // host has already verified against the runtime's own settings schema.
    settings: brandedFlagSettings({ brand: input.brand, autoMemoryDirectory: input.autoMemoryDirectory, ...(policy.settings === undefined ? {} : { extra: policy.settings }) }),

    // §2: the product's project directory as a manifestless local plugin root, so its skills qualify
    // under the project directory's own basename. `skipMcpDiscovery` because §11 makes the host the
    // sole owner of every server and tool effect on this branch.
    plugins: [{ type: "local", path: `${input.cwd}/${input.brand.projectDirName}`, skipMcpDiscovery: true }],

    systemPrompt: {
      type: "preset",
      preset: PINNED_SYSTEM_PROMPT_PRESET,
      ...(policy.systemPromptAppend === undefined ? {} : { append: policy.systemPromptAppend }),
      excludeDynamicSections,
    },

    strictMcpConfig: true,
    ...(policy.mcpServers === undefined ? {} : { mcpServers: { ...policy.mcpServers } }),

    // WS-05 §6 / §5: ONE store instance, shared with the other branch.
    sessionStore: input.sessionStore as unknown as SessionStore,
    sessionStoreFlush: policy.advertisesHandoff === true ? "eager" : "batched",

    toolAliases: officialToolAliases(input.brand),
    disallowedTools: [...officialDisallowedTools(policy.containment ?? {}, input.brand), ...(policy.additionalDisallowedTools ?? [])],

    includePartialMessages: true,
    includeHookEvents: true,
    perTaskStopAffordance: true,

    ...(policy.canUseTool === undefined ? {} : { canUseTool: policy.canUseTool }),
    ...(policy.hooks === undefined ? {} : { hooks: policy.hooks }),
    ...(policy.env === undefined ? {} : { env: { ...policy.env } }),
    ...(policy.sessionId === undefined ? {} : { sessionId: policy.sessionId }),
    ...(policy.resume === undefined ? {} : { resume: policy.resume }),
    ...(policy.forkSession === undefined ? {} : { forkSession: policy.forkSession }),
    ...(policy.appendSystemPromptFile === undefined ? {} : { extraArgs: { "append-system-prompt-file": policy.appendSystemPromptFile } }),

    // §5.1: the VENDORED runtime, never the user's installed binary.
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    // §6 (D12): every generation of a handoff-capable session goes through the proxy.
    spawnClaudeCodeProcess: input.spawnProxy,
  };

  assertOptionsInvariants(options, branchLabel);
  return options;
}

/**
 * §5.1's withheld options and §2's required ones, as refusals.
 *
 * WHY A VALIDATOR AND NOT JUST A CAREFUL BUILDER: `launch()` accepts an options object the CALLER
 * built (the seam's `OfficialLaunchPlan.options`), so the builder's care protects only the callers who
 * used it. These are the invariants that must hold for anything this adapter launches.
 */
export function assertOptionsInvariants(options: OfficialOptions, branchLabel: string): void {
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
  if (options.settingSources !== undefined && options.settingSources.length > 0) {
    refuse("settingSources", "this branch reads no vendor-named settings source at any tier (WS-14 §2)");
  }
  if (options.strictMcpConfig !== true) {
    refuse("strictMcpConfig", "the host is the sole owner of every MCP server and tool effect on this branch (WS-14 §11)");
  }
  const extraArgs = options["extraArgs"];
  if (extraArgs !== undefined) {
    const keys = Object.keys(extraArgs as Record<string, unknown>);
    const stray = keys.filter((key) => key !== "append-system-prompt-file");
    if (stray.length > 0) {
      refuse("extraArgs", `${stray.join(", ")} is outside the pinned contract; only the documented append-system-prompt-file route is available (WS-14 §5.1)`);
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
  return marker(options) as Record<string, unknown>;
}

/** The canonical name an aliased built-in resolves to — re-exported so a capture reader has one import. */
export { mcpToolName };
