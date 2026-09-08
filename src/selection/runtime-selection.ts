// D13/D28: THE PERSISTED RUNTIME CHOICE (WS-15 §1's shape, WS-13 §9's table, WS-13c §6's router leg).
//
// SPINE-PINNED TYPES, LANE D'S BEHAVIOUR. Everything in this file except the two function bodies is
// final: `RuntimeSelection` is the record persisted at session creation and read on every resume,
// `SelectionInput` is what the D13 table is evaluated against, and both are consumed by name in the
// seams (`RuntimeDirectoryEntry.selection`, `OfficialLaunchPlan.selection`, `HandoffOutcome`). Lane D
// (`p7b/lane-d`) fills in `selectRuntime`/`selectChildRuntime` and owns the rest of `src/selection/`.
//
// THE RULES THE BODIES MUST IMPLEMENT, so the signature is not the only thing that is pinned:
//   * WS-13 §9 / D13 — Claude OAuth → the official SDK, always (ship-gated by D14: `claudeOauthApproved`);
//     a Claude-family model on an Anthropic-protocol backend in Code mode → the official SDK; Claude
//     via non-Anthropic endpoints, and ALL Dispatch/Chat → the Winter runtime.
//   * "Routing decisions use the persisted runtime profile/auth source — NEVER a raw model-ID
//     substring" (WS-13 §9). `SelectionInput` carries no raw model string for the decision precisely
//     so that rule is structural: `requested.model` exists to RESOLVE a slot (WS-13c §4), and the
//     branch is taken on `family` + `authFamily` + `mode`.
//   * `persisted` WINS. A family/runtime change mid-session is the certified handoff (WS-05 §12) or a
//     visible fork — "never a silent rewrite" (WS-00 §2 D13). A selector that returns something other
//     than `input.persisted`'s runtime when `persisted` is set is a bug, not a re-decision.
//   * R-7b-1, the child rule — a child runs on the runtime ITS OWN slot's family selects at spawn
//     time, independent of the parent's runtime; the child's selection is persisted with the child
//     record and resume/SendMessage follow the CHILD's record (WS-13c §8), never the parent's current
//     runtime.
import type { CredentialRef, ModelFamilyListing } from "@yanlinglabs/winter-agent-sdk";

import { NotImplementedYet, RuntimeSdkError } from "../errors.ts";

/**
 * The two runtimes, spelled exactly as the Winter runtime's own messaging layer spells them
 * (`packages/runtime/src/messaging/adapter.ts`, which Task 0 moves to
 * `@yanlinglabs/winter-agent-sdk/messaging`).
 *
 * ONE DECLARATION, and this is it while Task 0 is in flight: when the messaging subpath lands, this
 * line becomes a re-export of the SDK's own `RuntimeKind` (see `src/seams/messaging-contract.ts`,
 * which carries the same note for the messaging shapes). The two unions are character-identical, so
 * the swap is type-identical and no lane's code moves.
 */
export type RuntimeKind = "winter-agent" | "claude-agent";

/**
 * WS-15 §1's persisted-choice contract, populated by the D13 selector at session creation.
 *
 * `sdkVersion` vs `engineVersion` are WS-02 §3's two separate identities: the wrapper's and the
 * runtime engine's. `reason` is a human-readable sentence naming the rule that fired — it is what a
 * host renders when a user asks "why is this session on that runtime", and what a support log needs
 * when a persisted selection looks surprising a month later. `decidedAt` is ISO-8601.
 */
export interface RuntimeSelection {
  runtimeKind: RuntimeKind;
  providerId: string;
  modelRef: string;
  family: string;
  authFamily: "api-key" | "cloud-credential-chain" | "claude-oauth" | "console-oauth" | "local-none" | "custom";
  sdkVersion: string;
  engineVersion?: string;
  reason: string;
  decidedAt: string;
}

/**
 * Which providers have a credential REF configured — never any credential material.
 *
 * WS-13c §4's filter step ("filter by configured credential ref") and WS-14 Execution amendments'
 * "a pinned alias resolves to the `anthropic` provider ONLY when a credential ref for it is
 * configured, and never by ambient environment scan" are both decided from this map. The value is the
 * ref's KIND (the SDK's own `CredentialRef["kind"]`), because the auth family follows from it and
 * nothing else here needs more.
 */
export interface CredentialPresence {
  readonly byProvider: Readonly<Record<string, CredentialRef["kind"]>>;
}

/** The D13 decision's inputs. See this file's header for why no raw model id decides the branch. */
export interface SelectionInput {
  mode: "code" | "dispatch" | "chat";
  requested: { slot?: string; model?: string; provider?: string };
  families: ModelFamilyListing;
  credentials: CredentialPresence;
  hasClaudePeer: boolean;
  claudeOauthApproved: boolean;
  persisted?: RuntimeSelection;
}

/**
 * A typed refusal — never a substitution and never a different family (WS-13c §4's own words).
 *
 * `slot-unservable`: no candidate survived slot resolution (no configured credential ref, or the
 * slot names a family this catalog cannot serve). `claude-oauth-not-approved`: the D14 ship gate is
 * closed and the only route to this selection was Claude OAuth. `runtime-unavailable`: the runtime
 * the rule selected is not present (e.g. a `claude` slot that must run official, with no official
 * peer injected).
 */
export interface SelectionRefusal {
  refused: true;
  reason: "slot-unservable" | "claude-oauth-not-approved" | "runtime-unavailable";
  /** One sentence naming what was missing, for the host to surface verbatim. */
  detail: string;
}

/** Narrows the union without a `"refused" in x` incantation at every call site. */
export function isSelectionRefusal(value: RuntimeSelection | SelectionRefusal): value is SelectionRefusal {
  return (value as SelectionRefusal).refused === true;
}

/**
 * The refusal, thrown — how `RuntimeSdk.selectRuntime` reports one.
 *
 * THE PLAN PINS TWO SIGNATURES THAT DISAGREE, and this class is the reconciliation. The pure module
 * function above returns `RuntimeSelection | SelectionRefusal` (a refusal is data — the D13 table has
 * an answer for every input, and a caller doing capability discovery wants it as a value). The
 * `RuntimeSdk.selectRuntime` METHOD is pinned as returning `RuntimeSelection` alone, so on that door
 * a refusal has to leave some other way: it is thrown, carrying the refusal verbatim. A host that
 * wants the value calls the exported function; a host that wants the method catches this.
 */
export class SelectionRefusedError extends RuntimeSdkError {
  readonly refusal: SelectionRefusal;
  constructor(refusal: SelectionRefusal) {
    super(`winter-runtime-sdk: runtime selection refused (${refusal.reason}) — ${refusal.detail}`);
    this.refusal = refusal;
  }
}

/** A child's own slot, resolved independently of the parent's runtime (R-7b-1). */
export interface ChildSelectionInput {
  /** The child's slot name (WS-13c §4 resolves it to a canonical model id). */
  slot: string;
  mode: "code" | "dispatch" | "chat";
  families: ModelFamilyListing;
  credentials: CredentialPresence;
  hasClaudePeer: boolean;
  claudeOauthApproved: boolean;
}

/** D13/D28, pure. Lane D implements. */
export function selectRuntime(input: SelectionInput): RuntimeSelection | SelectionRefusal {
  void input;
  throw new NotImplementedYet("lane-d", "selectRuntime (D13/D28)");
}

/** R-7b-1: the child's runtime, decided by the CHILD's slot, never inherited from the parent. Lane D implements. */
export function selectChildRuntime(parent: RuntimeSelection, childSlot: ChildSelectionInput): RuntimeSelection | SelectionRefusal {
  void parent;
  void childSlot;
  throw new NotImplementedYet("lane-d", "selectChildRuntime (R-7b-1, the child-runtime rule)");
}
