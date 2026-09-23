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

import type { OfficialPermissionMode } from "../seams/official-sdk-shapes.ts";
import { FORBIDDEN_TARGETS, containmentDecisionFor, containmentPaths, resolveSavedApprovalDisposition, type ContainmentPolicy } from "./containment.ts";
import { sessionOnlyPermissionUpdates } from "../run-home/permission-updates.ts";
import { officialBranchLabel } from "./branding.ts";

// THE MODE UNION MOVED TO THE SEAM (0.0.10) and is RE-EXPORTED here, so that every import site and
// `src/index.ts`'s published name are unchanged. It had to move: the seam's `OfficialQuery` now names
// it (`setPermissionMode`), and a lane-owned copy of a type the seam depends on is the duplicate
// `test/spine/barrel-exports.test.ts` exists to forbid. Its own doc comment carries the reasoning for
// why the union is five members where the pin's is six.
export type { OfficialPermissionMode } from "../seams/official-sdk-shapes.ts";

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
  /**
   * The session's mode. `dontAsk` never reaches the broker (§10).
   *
   * A FUNCTION IS ACCEPTED, AND IT IS WHAT A LIVE SESSION MUST PASS (0.0.10). The mode used to be
   * captured here once, at spawn — and `Query.setPermissionMode` makes that a bug rather than a
   * simplification: a session spawned `dontAsk` and switched live to `default` starts receiving
   * `canUseTool` requests from the child, and a bridge still holding `dontAsk` would auto-allow every
   * one of them without the broker ever seeing a call. Read per decision, exactly as the host's own
   * policy getter is (`@yanlinglabs/winter-core`'s `approval-bridge.ts`). A bare literal is still
   * accepted, for a bridge whose session cannot change mode (`buildOfficialOptions`'s own fail-closed
   * default) and for every existing caller.
   */
  mode: OfficialPermissionMode | (() => OfficialPermissionMode);
  /** §8's dispositions. The floor reads them; `projectDirName` is filled from `brand` if absent. */
  containment?: ContainmentPolicy;
  /** Called with every decision, so a host can log or count without wrapping the broker. */
  onDecision?: (decision: { request: ApprovalRequest; result: PermissionResult; source: DecisionSource }) => void;
}

/**
 * Where a decision came from — what a row-14 tally is built out of. `broker-destination-rewritten`
 * (WS-21 §4.3) is the broker's own answer with every durable update destination rewritten to
 * `session`; `broker-approval-stripped` is no longer emitted (it was the pre-WS-21 strip) and stays in
 * the union only so a host's exhaustive switch still compiles.
 */
export type DecisionSource = "containment-floor" | "broker" | "dont-ask" | "broker-approval-stripped" | "broker-destination-rewritten";

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
    //    READ NOW, not at construction: a live `setPermissionMode` moved it (see `mode`'s own doc).
    if ((typeof options.mode === "function" ? options.mode() : options.mode) === "dontAsk") {
      const result: PermissionResult = { behavior: "allow", updatedInput: input, toolUseID: request.toolUseID };
      options.onDecision?.({ request, result, source: "dont-ask" });
      return result;
    }

    // 3. THE BROKER. Its answer is carried back — including `updatedInput` (the transformed input §10
    //    requires end to end) and `updatedPermissions` (the suggestions, echoed as the host's own rule
    //    updates) — with ONE exception, below.
    const result = await options.broker(request);

    // 4. §8's SAVED-APPROVAL ROW, enforced where the write is actually requested (review r1, M2) —
    //    and, since WS-21, for EVERY durable update (§4.3, F21). A durable `updatedPermissions` entry
    //    is how an approval reaches a settings file the runtime writes itself (`localSettings` is the
    //    repository's own), and it is the one writer with no tool call of its own — so it is contained
    //    here or nowhere. Every destination other than `session` is REWRITTEN to `session`: the approval
    //    still applies for this generation, and the durable copy is the host's to write (the daemon
    //    writes `sdk/settings.json` or the local tier itself). The pre-WS-21 bridge stripped them.
    if (savedApprovals === "disable") {
      const scoped = sessionOnlyPermissionUpdates(result);
      if (scoped !== result) {
        options.onDecision?.({ request, result: scoped, source: "broker-destination-rewritten" });
        return scoped;
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
 * THE MARKS THAT MAKE THE FLOOR VISIBLE (review r2, NEW-1) — visible, and no longer PROOF.
 *
 * `assertOptionsInvariants` has to be able to answer "does this options object carry the floor?" for
 * an object it did not build — that is the whole point of a function whose doc says it validates what
 * `launch()` is HANDED. A structural guess ("some PreToolUse matcher exists") would pass for any hook
 * at all, so the floor's own callback and the approval bridge each carry a symbol — `Symbol.for`, so a
 * host reading an options object can recognise the two by name whichever copy of this package stamped
 * them.
 *
 * WHAT A MARK IS NOW (review r3 NEW-11, review r4 NEW-18): a LABEL. It is an exported `Symbol.for` key,
 * so any caller can stamp it, and both marks have been measured being stamped to some effect. The
 * answer to "is this the floor / the bridge" is the identity check further down, never the mark.
 */
export const CONTAINMENT_FLOOR_MARK = Symbol.for("winter-runtime-sdk.official.containment-floor");
export const APPROVAL_BRIDGE_MARK = Symbol.for("winter-runtime-sdk.official.approval-bridge");

/** True when this function carries the mark — a label a host can read, NOT proof that this package made it. */
export function carriesMark(value: unknown, mark: symbol): boolean {
  return typeof value === "function" && (value as unknown as Record<symbol, unknown>)[mark] === true;
}

/**
 * THE IDENTITY CHECKS (review r3 NEW-11, review r4 NEW-18) — the question a mark cannot answer.
 *
 * Both marks are `Symbol.for` keys on exported symbols, so any caller can stamp one, and each has been
 * measured being stamped to some effect. r3: a stamped `canUseTool` was taken VERBATIM, skipping the
 * saved-approval strip and letting the vendor's settings file be written. r4: the fix for that
 * recognised the bridge by identity but left the hook on the mark — and the r3 tidy-up that skipped the
 * floor's merge "when the options already carry the mark" turned the token that PROVED the floor was
 * installed into the token that REMOVED it. A no-op host hook stamped with it replaced §8's floor;
 * `EnterWorktree` and `Task(isolation:"worktree")` created `<cwd>/.claude` (swept post-hoc) and left a
 * dangling `.git/worktrees/…` entry the sweep cannot see. So both are recognised the same way now: not
 * "is it marked" but "did WE make it", which a `WeakSet` answers and nobody can counterfeit.
 *
 * SCOPE OF THE IDENTITY, stated: it is per copy of this module. A second copy of the package in one
 * process cannot vouch for the first's floor — and does not need to, because `launch()` merges its own
 * copy's floor on every launch before the invariants run. The one route that notices is a host
 * validating copy A's options with copy B's `assertOptionsInvariants` directly, and there the refusal
 * is the safe direction.
 */
const OUR_BRIDGES = new WeakSet<object>();
const OUR_FLOORS = new WeakSet<object>();

export function isOurApprovalBridge(value: unknown): value is OfficialApprovalBridge {
  return typeof value === "function" && OUR_BRIDGES.has(value as unknown as object);
}

/** True only for a hook `createContainmentHooks` built. A hook merely stamped with the mark is NOT the floor. */
export function isOurContainmentHook(value: unknown): boolean {
  return typeof value === "function" && OUR_FLOORS.has(value as unknown as object);
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
  OUR_FLOORS.add(guard as unknown as object);
  // REVIEW I-2 — EVERY ROUTE TO A WORKTREE, not only the tool calls the PreToolUse guard sees. A workflow
  // script's `agent(prompt, { isolation: "worktree" })` is started by the workflow runtime, not by an
  // `Agent` tool call, and MEASURED under a run home in a git repository it created
  // `<repo>/<vendor dir>/worktrees/` (and a branch in the repository's `.git`). With a `WorktreeCreate`
  // hook configured the runtime asks the hook INSTEAD of running `git worktree add` itself (its own
  // messages: "Cannot create a worktree: not in a git repository and no WorktreeCreate hooks are
  // configured"; "WorktreeCreate hook failed: …"), so while worktrees are denied the hook refuses —
  // one decision for the tool, the agent option and the workflow agent alike.
  if ((policy.worktrees ?? "deny") === "deny") {
    const paths = containmentPaths({ projectDirName: policy.projectDirName ?? "" });
    const refuseWorktree = async (raw: unknown): Promise<OfficialHookOutput> => {
      const name = String(((raw ?? {}) as { name?: unknown }).name ?? "");
      const reason = `worktree creation is refused on this branch: the vendor's own writer creates its worktree directory; worktrees belong under ${paths.worktrees || "the product's project directory"} and the host's replacement owns them (WS-14 §8)`;
      options.onDecision?.({ tool: "WorktreeCreate", target: `${FORBIDDEN_TARGETS.projectDir}/worktrees/${name}`, reason });
      throw new Error(reason);
    };
    return { PreToolUse: [{ hooks: [guard] }], WorktreeCreate: [{ hooks: [refuseWorktree] }] };
  }
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
