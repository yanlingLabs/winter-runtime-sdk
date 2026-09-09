// WS-14 §10: CALLBACK BRIDGING — the approval broker, reached from the official branch.
//
// FOUR RULES, and the first one is the reason this module exists at all:
//
//   * "The normal broker ALWAYS returns a typed `PermissionResult`. The TypeScript `null` return is a
//     transport escape hatch valid only after the matching control response was already sent out of
//     band echoing `requestId`; an accidental `null` FAILS CLOSED and can block the tool indefinitely
//     (permission waits have no park timeout). It is reserved for the low-level transport-compatible
//     API and MUST NOT be used by this bridge."
//   * The bridge carries `requestId`, `toolUseID`, `agentID`, suggested rule updates and transformed
//     input END TO END.
//   * First response wins; a decision resumed after a restart REVALIDATES session, tool call,
//     mode/policy version, normalized paths and runtime ownership before executing.
//   * "`dontAsk` NEVER invokes the callback; `PreToolUse` hooks are the enforcement point for
//     must-see-every-call logic."
//
// THE TYPE IS THE FIRST RULE'S ENFORCEMENT. `OfficialApprovalBridge` returns
// `Promise<PermissionResult>` — not `| null` — so the escape hatch is not merely discouraged, it is
// unspellable at this seam. Both SDKs' own `CanUseTool` accept a wider return type, so the narrower
// function is assignable to either.
//
// THE CONTAINMENT FLOOR RUNS FIRST, BEFORE THE BROKER. §8's forbidden targets are not a user
// decision: a broker that could approve a `.claude/` write would make row 14 a matter of policy
// configuration rather than of construction. `dontAsk` therefore does not mean "allow everything" —
// it means "do not ask", and the floor still denies.
import type { BrandProfile, PermissionResult, PermissionUpdate } from "@yanlinglabs/winter-agent-sdk";

import { containmentDecisionFor, resolveSavedApprovalDisposition, type ContainmentPolicy } from "./containment.ts";
import { officialBranchLabel } from "./branding.ts";

/** The permission modes a host session can be in. Mirrors the pinned runtime's own vocabulary. */
export type OfficialPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";

/** Everything the pinned `CanUseTool` hands a callback, carried through to the broker unchanged. */
export interface ApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
  signal: AbortSignal;
  requestId: string;
  toolUseID: string;
  agentID?: string;
  suggestions?: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  displayName?: string;
  description?: string;
  matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
}

/** The host's broker (WS-15 §7 / Phase 8). It answers with a typed result — never `null`, ever. */
export type ApprovalBroker = (request: ApprovalRequest) => Promise<PermissionResult>;

/** The bridge itself: assignable to either SDK's `canUseTool`, and strictly narrower than both. */
export type OfficialApprovalBridge = (toolName: string, input: Record<string, unknown>, options: Omit<ApprovalRequest, "toolName" | "input">) => Promise<PermissionResult>;

export interface ApprovalBridgeOptions {
  broker: ApprovalBroker;
  brand: Pick<BrandProfile, "projectDirName" | "processLabel">;
  /** The session's mode. `dontAsk` never reaches the broker (§10). */
  mode: OfficialPermissionMode;
  /** §8's dispositions. The floor reads them; `projectDirName` is filled from `brand` if absent. */
  containment?: ContainmentPolicy;
  /** Called with every decision, so a host can log or count without wrapping the broker. */
  onDecision?: (decision: { request: ApprovalRequest; result: PermissionResult; source: DecisionSource }) => void;
}

/** Where a decision came from — what a row-14 tally is built out of. */
export type DecisionSource = "containment-floor" | "broker" | "dont-ask" | "broker-approval-stripped";

/**
 * The destinations a DURABLE approval would be written to (§8's saved-`WebFetch` row).
 *
 * `session` and `cliArg` are not durable — they live and die with this generation — so they are the
 * two a stripped result keeps.
 */
const DURABLE_APPROVAL_DESTINATIONS: readonly string[] = ["userSettings", "projectSettings", "localSettings"];

/**
 * Builds `Options.canUseTool` for the official branch.
 *
 * ORDER: containment floor → mode → broker. Every arm returns a typed result, and the function's own
 * return type is what guarantees it.
 */
export function createApprovalBridge(options: ApprovalBridgeOptions): OfficialApprovalBridge {
  const containmentPolicy: ContainmentPolicy = { projectDirName: options.brand.projectDirName, ...options.containment };
  // Refuses `redirect` outright — see `resolveSavedApprovalDisposition` (review r3, NEW-11).
  const savedApprovals = resolveSavedApprovalDisposition(containmentPolicy, officialBranchLabel(options.brand));
  const bridge: OfficialApprovalBridge = async (toolName, input, rest) => {
    const request: ApprovalRequest = { toolName, input, ...rest };

    // 1. THE FLOOR. Not a user decision, and not skippable by mode.
    const containment = containmentDecisionFor(toolName, input, containmentPolicy);
    if (!containment.allow) {
      const result: PermissionResult = { behavior: "deny", message: containment.reason, toolUseID: request.toolUseID };
      options.onDecision?.({ request, result, source: "containment-floor" });
      return result;
    }

    // 2. `dontAsk` NEVER INVOKES THE CALLBACK (§10). The broker is not consulted, not awaited, and
    //    not given the chance to prompt; `PreToolUse` hooks are where must-see-every-call logic goes.
    if (options.mode === "dontAsk") {
      const result: PermissionResult = { behavior: "allow", updatedInput: input, toolUseID: request.toolUseID };
      options.onDecision?.({ request, result, source: "dont-ask" });
      return result;
    }

    // 3. THE BROKER. Its answer is carried back — including `updatedInput` (the transformed input §10
    //    requires end to end) and `updatedPermissions` (the suggestions, echoed as the host's own rule
    //    updates) — with ONE exception, below.
    const result = await options.broker(request);

    // 4. §8's SAVED-APPROVAL ROW, enforced where the write is actually requested (review r1, M2).
    //    A durable `updatedPermissions` entry is exactly how a saved approval reaches the vendor's own
    //    settings file, and it is the only §8 writer with no tool call of its own — so it has to be
    //    contained here or nowhere. Under the `disable` disposition the durable entries are STRIPPED
    //    and the session-scoped ones survive: the approval still applies for this generation, and
    //    WS-07 keeps its open question (WS-14 §16 q2).
    if (savedApprovals === "disable" && result.behavior === "allow" && result.updatedPermissions !== undefined) {
      const kept = result.updatedPermissions.filter((update) => !DURABLE_APPROVAL_DESTINATIONS.includes(update.destination));
      if (kept.length !== result.updatedPermissions.length) {
        const stripped: PermissionResult = { ...result, updatedPermissions: kept };
        options.onDecision?.({ request, result: stripped, source: "broker-approval-stripped" });
        return stripped;
      }
    }
    options.onDecision?.({ request, result, source: "broker" });
    return result;
  };
  (bridge as unknown as Record<symbol, unknown>)[APPROVAL_BRIDGE_MARK] = true;
  OUR_BRIDGES.add(bridge as unknown as object);
  return bridge;
}

// --------------------------------------------------------------------------------------------------
// §8's enforcement point: the PreToolUse hook.
// --------------------------------------------------------------------------------------------------
//
// MEASURED, AND IT IS WHY THIS EXISTS (review r1, M2, and a finding beyond it). In a real git
// repository, a model-emitted `EnterWorktree` CREATED `.claude/worktrees/feature` — and `canUseTool`
// WAS NEVER CALLED FOR IT.
//
// THE EXACT SET, NARROWED BY MEASUREMENT (review r2, NEW-7). With the hook removed, the callback saw
// NOTHING for `EnterWorktree`, `ExitWorktree`, `Task`/`Agent` with `isolation: "worktree"`, `Skill` or
// `CronList` — but it DID see `Workflow`. So the true statement is narrower than "the callback is not
// consulted for the redirect writers": it is not consulted for the WORKTREE/AGENT family, and it is
// consulted for `Workflow`. Either way the conclusion stands — a floor that lives only in the
// callback cannot make row 14 true — and the hook covers both kinds.
//
// §10 says exactly where must-see-every-call logic goes: "`dontAsk` never invokes the callback;
// PreToolUse hooks are the enforcement point for must-see-every-call logic." So the containment floor
// is installed as a PreToolUse hook as well as in the bridge — the same decision function, at the one
// point every call passes through.

/**
 * THE MARKS THAT MAKE THE FLOOR CHECKABLE (review r2, NEW-1).
 *
 * `assertOptionsInvariants` has to be able to answer "does this options object carry the floor?" for
 * an object it did not build — that is the whole point of a function whose doc says it validates what
 * `launch()` is HANDED. A structural guess ("some PreToolUse matcher exists") would pass for any hook
 * at all, so the floor's own callback and the approval bridge each carry a symbol the check looks for.
 * `Symbol.for` rather than a module-local symbol: two copies of this package in one process (a host
 * vendoring the router beside an app that also vendors it) must still recognise each other's floor.
 */
export const CONTAINMENT_FLOOR_MARK = Symbol.for("winter-runtime-sdk.official.containment-floor");
export const APPROVAL_BRIDGE_MARK = Symbol.for("winter-runtime-sdk.official.approval-bridge");

/** True when this function is one of ours — the floor's hook or the approval bridge. */
export function carriesMark(value: unknown, mark: symbol): boolean {
  return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[mark] === true;
}

/**
 * THE IDENTITY CHECK (review r3, NEW-11) — for the one decision where a forgery has consequences.
 *
 * The marks make the floor CHECKABLE for an options object we did not build, which is what the
 * invariant needs; they are also `Symbol.for` keys on an exported symbol, so any caller can stamp
 * one. For the hook that costs nothing (the adapter merges the genuine floor anyway), but a stamped
 * `canUseTool` was measured being taken VERBATIM — skipping the saved-approval strip and letting the
 * vendor's settings file be written. So the adapter asks a different question of the bridge: not "is
 * it marked" but "did WE make it", which a `WeakSet` answers and nobody can counterfeit.
 */
const OUR_BRIDGES = new WeakSet<object>();

export function isOurApprovalBridge(value: unknown): value is OfficialApprovalBridge {
  return typeof value === "function" && OUR_BRIDGES.has(value as unknown as object);
}

/** The subset of the hook contract this needs, declared structurally (the peer is never imported). */
export interface PreToolUseHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export type OfficialHookOutput = {
  hookSpecificOutput?: { hookEventName: "PreToolUse"; permissionDecision?: "allow" | "deny" | "ask" | "defer"; permissionDecisionReason?: string };
  decision?: "block";
  stopReason?: string;
};

export interface ContainmentHooksOptions {
  brand: Pick<BrandProfile, "projectDirName">;
  containment?: ContainmentPolicy;
  onDecision?: (decision: { tool: string; target: string; reason: string }) => void;
}

/**
 * The `hooks` value §8's containment needs: one `PreToolUse` matcher applying the same floor.
 *
 * A DENY HERE IS THE STRONGEST ONE THE RUNTIME OFFERS: `permissionDecision: "deny"` stops the call
 * before it runs and returns the reason to the model, and unlike the callback it is invoked for every
 * tool — including the ones that skip `canUseTool` entirely.
 */
export function createContainmentHooks(options: ContainmentHooksOptions): Record<string, Array<{ hooks: Array<(input: unknown) => Promise<OfficialHookOutput>> }>> {
  const policy: ContainmentPolicy = { projectDirName: options.brand.projectDirName, ...options.containment };
  const guard = async (raw: unknown): Promise<OfficialHookOutput> => {
    const input = (raw ?? {}) as PreToolUseHookInput;
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    if (toolName === "") return {};
    const decision = containmentDecisionFor(toolName, toolInput, policy);
    if (decision.allow) return {};
    options.onDecision?.({ tool: toolName, target: decision.target, reason: decision.reason });
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } };
  };
  (guard as unknown as Record<symbol, unknown>)[CONTAINMENT_FLOOR_MARK] = true;
  return { PreToolUse: [{ hooks: [guard] }] };
}

/** A decision that was made before a restart, replayed against the session it was made for. */
export interface ResumedDecision {
  requestId: string;
  toolUseID: string;
  sessionId: string;
  /** The mode/policy version the decision was made under. */
  policyVersion: string;
  /** Paths the decision covered, already normalized by the host. */
  normalizedPaths: readonly string[];
  /** Which runtime owned the session when the decision was made (WS-05 §12's writer lease). */
  runtimeOwner: string;
}

/** The live facts a resumed decision is revalidated against. */
export type DecisionContext = Omit<ResumedDecision, "requestId">;

/**
 * §10's revalidation, as a predicate.
 *
 * "A decision resumed after restart revalidates SESSION, TOOL CALL, MODE/POLICY VERSION, NORMALIZED
 * PATHS, and RUNTIME OWNERSHIP before executing." All five, and the list is why this is a function
 * rather than an `===`: four-out-of-five is an approval for a call the user never saw.
 */
export function revalidateResumedDecision(decision: ResumedDecision, live: DecisionContext): { valid: true } | { valid: false; reason: string } {
  if (decision.sessionId !== live.sessionId) return { valid: false, reason: "the decision belongs to a different session" };
  if (decision.toolUseID !== live.toolUseID) return { valid: false, reason: "the decision was made for a different tool call" };
  if (decision.policyVersion !== live.policyVersion) return { valid: false, reason: "the permission policy changed after the decision was made" };
  if (decision.runtimeOwner !== live.runtimeOwner) return { valid: false, reason: "the session changed runtime owner after the decision was made" };
  const before = [...decision.normalizedPaths].sort();
  const after = [...live.normalizedPaths].sort();
  if (before.length !== after.length || before.some((path, index) => path !== after[index])) return { valid: false, reason: "the paths the decision covered are not the paths this call touches" };
  return { valid: true };
}

/**
 * "FIRST RESPONSE WINS" — a one-shot latch per `requestId`.
 *
 * A broker that answers twice (a user click plus a restored decision, say) must not produce two
 * control responses: the second is dropped, and the latch says so rather than silently discarding.
 */
export function createFirstResponseWins(): { claim(requestId: string): boolean; claimed(): readonly string[] } {
  const seen = new Set<string>();
  return {
    claim(requestId) {
      if (seen.has(requestId)) return false;
      seen.add(requestId);
      return true;
    },
    claimed: () => [...seen],
  };
}
