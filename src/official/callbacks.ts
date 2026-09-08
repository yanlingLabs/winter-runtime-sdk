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

import { containmentDecisionFor } from "./containment.ts";

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
  brand: Pick<BrandProfile, "projectDirName">;
  /** The session's mode. `dontAsk` never reaches the broker (§10). */
  mode: OfficialPermissionMode;
  /** Called with every decision, so a host can log or count without wrapping the broker. */
  onDecision?: (decision: { request: ApprovalRequest; result: PermissionResult; source: "containment-floor" | "broker" | "dont-ask" }) => void;
}

/**
 * Builds `Options.canUseTool` for the official branch.
 *
 * ORDER: containment floor → mode → broker. Every arm returns a typed result, and the function's own
 * return type is what guarantees it.
 */
export function createApprovalBridge(options: ApprovalBridgeOptions): OfficialApprovalBridge {
  return async (toolName, input, rest) => {
    const request: ApprovalRequest = { toolName, input, ...rest };

    // 1. THE FLOOR. Not a user decision, and not skippable by mode.
    const containment = containmentDecisionFor(toolName, input);
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

    // 3. THE BROKER. Its answer is carried back verbatim — including `updatedInput` (the transformed
    //    input §10 requires end to end) and `updatedPermissions` (the suggestions, echoed as the
    //    host's own rule updates).
    const result = await options.broker(request);
    options.onDecision?.({ request, result, source: "broker" });
    return result;
  };
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
