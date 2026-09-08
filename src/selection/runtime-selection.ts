// D13/D28: THE PERSISTED RUNTIME CHOICE (WS-15 §1's shape, WS-13 §9's table, WS-13c §6's router leg).
//
// SPINE-PINNED TYPES, LANE D'S BEHAVIOUR. Everything in this file except the two function bodies is
// final: `RuntimeSelection` is the record persisted at session creation and read on every resume,
// `SelectionInput` is what the D13 table is evaluated against, and both are consumed by name in the
// seams (`RuntimeDirectoryEntry.selection`, `OfficialLaunchPlan.selection`, `HandoffOutcome`). Lane D
// (`p7b/lane-d`) fills in `selectRuntime`/`selectChildRuntime` and owns the rest of `src/selection/`.
//
// LANE D LANDED (2026-09-08): this file stays the ONE TYPE HOME — every shape the selector produces
// or consumes is declared here — and the two bodies moved to the modules the ownership map names,
// `./select-runtime.ts` (D13/D28, the persisted choice) and `./child-runtime.ts` (R-7b-1). They are
// re-exported from the bottom of this file under their pinned names, so `src/index.ts` and `src/sdk.ts`
// (both spine-owned) keep importing exactly what they already import. Nothing about the import graph
// moved; only the bodies did.
//
// THREE ADDITIVE FIELDS AND ONE WIDER UNION, each forced by a rule the bodies have to implement and
// each documented at its own declaration: `CredentialPresence.authByProvider` (the D13 branch is taken
// on the AUTH FAMILY and the backend's wire dialect, and a `CredentialRef["kind"]` can express
// neither), `SelectionInput.versions`/`SelectionInput.now` (`RuntimeSelection` carries `sdkVersion`
// and `decidedAt`, and a pure function cannot invent either), `ChildSelectionInput`'s `model`/
// `provider` (the plan's own child shape is `{ slot?; model?; provider? }`), and
// `SelectionRefusal.reason`'s fourth member `mode-forbids-runtime` (WS-15 §2: "Claude OAuth is
// Code-only even after D14 approval… never silent fallbacks").
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

import { RuntimeSdkError } from "../errors.ts";

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

/** The auth families a `RuntimeSelection` can record, as a name (the union is pinned inline above). */
export type SelectionAuthFamily = RuntimeSelection["authFamily"];

/**
 * What the host knows about one provider BEYOND "a credential ref exists" — the two facts the D13
 * branch is actually taken on.
 *
 * WHY THIS EXISTS. `CredentialPresence.byProvider` carries a `CredentialRef["kind"]`, which says
 * WHERE a credential is stored (`keychain` | `env` | `file` | `inline` | `aws-default-chain` |
 * `none`). D13 branches on something else entirely: WS-13 §9's own words are "routing decisions use
 * the persisted runtime profile/AUTH SOURCE — never a raw model-ID substring", and R-7b-1 spells the
 * official branch's served set as "API key, cloud credential chain, or an approved Claude OAuth". A
 * storage location cannot express any of those three, and it certainly cannot express the difference
 * between an Anthropic API key and a Claude OAuth credential, which is the difference between D13's
 * row 2 and its row 1. So the host — which has the provider descriptor — declares them.
 *
 * `protocols` is WS-13 §5's wire-dialect list (`ProviderProtocol` in the catalog: `anthropic-messages`,
 * `openai-chat-completions`, `bedrock-converse`, …), copied verbatim from the provider descriptor.
 * The selector reads exactly one bit out of it: does this backend speak the Anthropic dialect —
 * which is WS-13 §9's "Anthropic-protocol backend" test, and the thing that separates a Claude model
 * served by its vendor from the same Claude model resold through an OpenAI-shaped gateway.
 *
 * KEPT A BARE `string[]`, deliberately: the dialect vocabulary belongs to the catalog package, and
 * this package must not grow a dependency on it to spell one comparison.
 */
export interface ProviderAuthView {
  /** The auth family this provider's CONFIGURED credential belongs to (WS-14 §12's own table). */
  authFamily: SelectionAuthFamily;
  /** The wire dialects the provider speaks, verbatim from its catalog descriptor. */
  protocols?: readonly string[];
}

/**
 * Which providers have a credential REF configured — never any credential material.
 *
 * WS-13c §4's filter step ("filter by configured credential ref") and WS-14 Execution amendments'
 * "a pinned alias resolves to the `anthropic` provider ONLY when a credential ref for it is
 * configured, and never by ambient environment scan" are both decided from this map. The value is the
 * ref's KIND (the SDK's own `CredentialRef["kind"]`), because the auth family follows from it and
 * nothing else here needs more.
 *
 * LANE D AMENDMENT — `byProvider` REMAINS THE FILTER, `authByProvider` REFINES IT. Presence of a
 * provider's key in `byProvider` is what admits its rows (unchanged, and it is the only admission
 * test: an absent key means "no configured credential ref", never "probe the environment"). What the
 * kind cannot do is name the auth FAMILY, so `authByProvider` carries it where the host knows it. A
 * provider with no entry there falls back to `authFamilyFromRefKind` in `./select-runtime.ts`, whose
 * one rule is that an OAuth family is NEVER inferred — `claude-oauth` and `console-oauth` are
 * reachable only by declaration, so the D14 ship gate can never be tripped by a guess.
 */
export interface CredentialPresence {
  readonly byProvider: Readonly<Record<string, CredentialRef["kind"]>>;
  /** Per-provider auth family + wire dialects, where the host knows them. See `ProviderAuthView`. */
  readonly authByProvider?: Readonly<Record<string, ProviderAuthView>>;
}

/**
 * The version identities stamped into a selection (WS-02 §3: "the runtime engine and wrapper carry
 * separate version identities — `sdkVersion` vs `engineVersion`").
 *
 * A PURE FUNCTION CANNOT READ THEM. `RuntimeSelection.sdkVersion` is required and its value depends
 * on which runtime the table picked, so the caller supplies both candidates and the selector stamps
 * the one it chose. Absent → `UNKNOWN_VERSION`, which is an honest record rather than a plausible
 * lie; `selectionVersionsFrom(sdk.versions)` in `./select-runtime.ts` builds this from the
 * constructor's own matrix report, which is where a host already has the answer.
 */
export interface SelectionVersions {
  /** The Winter SDK's own version — stamped when the table picks `winter-agent`. */
  winterSdkVersion?: string;
  /** The official SDK's version — stamped when the table picks `claude-agent`. */
  claudeSdkVersion?: string;
  /** The runtime ENGINE's version, when the host knows it (WS-02 §3's second identity). */
  engineVersion?: string;
}

/** The D13 decision's inputs. See this file's header for why no raw model id decides the branch. */
export interface SelectionInput {
  mode: "code" | "dispatch" | "chat";
  requested: { slot?: string; model?: string; provider?: string };
  families: ModelFamilyListing;
  credentials: CredentialPresence;
  hasClaudePeer: boolean;
  /**
   * D14's ship gate. `false` IS THE SHIPPED DEFAULT (`D14_CLAUDE_OAUTH_APPROVED_DEFAULT` in
   * `./select-runtime.ts`): WS-14 §12 — "built but publicly ship-gated pending written Anthropic
   * approval… until approval exists, the shippable branch uses API-key/cloud/gateway auth only".
   * Required rather than optional on purpose — a host must say it, and saying nothing is not consent.
   */
  claudeOauthApproved: boolean;
  persisted?: RuntimeSelection;
  /** Stamped into the produced record. Absent → `UNKNOWN_VERSION`. */
  versions?: SelectionVersions;
  /** The ISO-8601 instant to record as `decidedAt`. Absent → now. Present makes a decision reproducible. */
  now?: string;
}

/**
 * A typed refusal — never a substitution and never a different family (WS-13c §4's own words).
 *
 * `slot-unservable`: no candidate survived slot resolution (no configured credential ref, or the
 * slot names a family this catalog cannot serve). `claude-oauth-not-approved`: the D14 ship gate is
 * closed and the only route to this selection was Claude OAuth. `runtime-unavailable`: the runtime
 * the rule selected is not present (e.g. a `claude` slot that must run official, with no official
 * peer injected). `mode-forbids-runtime`: the mode×runtime matrix has no cell for this pair —
 * WS-15 §2's "Claude OAuth is Code-only even after D14 approval. Unsupported combinations are
 * explicit capabilities in the matrix, never silent fallbacks."
 *
 * THE FOURTH MEMBER IS LANE D'S ADDITION and it is the one that keeps a rule from becoming a
 * fallback: without it, Claude OAuth in Dispatch or Chat has exactly two expressible answers, and
 * both are wrong — route to the official runtime (violating D4's "Dispatch and Chat → Winter-only,
 * in-daemon") or route to Winter (violating D28's "Claude oAuth never routes to winter").
 */
export interface SelectionRefusal {
  refused: true;
  reason: "slot-unservable" | "claude-oauth-not-approved" | "runtime-unavailable" | "mode-forbids-runtime";
  /** One sentence naming what was missing, for the host to surface verbatim. */
  detail: string;
}

/**
 * Narrows the union without a `"refused" in x` incantation at every call site.
 *
 * GENERIC IN THE NON-REFUSAL HALF, because every door in `src/selection/` returns "the answer OR the
 * same refusal": `RuntimeSelection | SelectionRefusal` from the two selectors, `ChildRuntimePairing |
 * SelectionRefusal` from the pairing door. One guard for all of them is the point — a second guard
 * per return type is a second place for the discriminant to be spelled, and the discriminant is the
 * whole contract.
 */
export function isSelectionRefusal<T extends object>(value: T | SelectionRefusal): value is SelectionRefusal {
  return (value as { refused?: unknown }).refused === true;
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

/**
 * A child's own request, resolved independently of the parent's runtime (R-7b-1).
 *
 * ONE OBJECT WHERE THE PLAN WRITES TWO ARGUMENTS. The plan's Task 5 line is
 * `selectChildRuntime(parent, child: { slot?; model?; provider? }, input)`; the spine pinned the
 * two-argument form the barrel and the seams already import. They describe the same information, so
 * this shape carries both halves: the `slot`/`model`/`provider` the spawn requested, and the context
 * the D13 table needs. `slot` is optional here for the same reason it is optional in
 * `SelectionInput.requested` — a spawn may name a model or a provider instead, and a child that names
 * nothing takes its session's active slot set, exactly like a top-level session.
 *
 * WHAT IS DELIBERATELY ABSENT: anything from the parent. `selectChildRuntime` reads its `parent`
 * argument for ONE purpose only — reporting whether the resulting pair is cross-runtime (Lane B's
 * routing bit) — and never as an input to the decision. That is R-7b-1's whole content, and making
 * the parent structurally absent from this type is what makes it true rather than merely intended.
 */
export interface ChildSelectionInput {
  /** The child's slot name (WS-13c §4 resolves it to a canonical model id). */
  slot?: string;
  /** A canonical model id or a catalog row key, when the spawn names a model instead of a slot. */
  model?: string;
  /** A pinned provider id (WS-13c §4's "a pinned `provider`"). */
  provider?: string;
  mode: "code" | "dispatch" | "chat";
  families: ModelFamilyListing;
  credentials: CredentialPresence;
  hasClaudePeer: boolean;
  claudeOauthApproved: boolean;
  /** Stamped into the child's own record. */
  versions?: SelectionVersions;
  /** The ISO-8601 instant to record as the child's `decidedAt`. */
  now?: string;
}

// --- the bodies (Lane D), re-exported here under their pinned names -------------------------------
//
// `src/index.ts` and `src/sdk.ts` import `selectRuntime`/`selectChildRuntime` FROM THIS MODULE, and
// both are spine-owned. Re-exporting keeps that true while the implementations live in the two files
// the ownership map names. Everything else Lane D exports is reachable from the same two modules —
// see the NEEDS_CONTEXT in the Task 5 report for the one-line `src/index.ts` diff that puts the new
// names on the package barrel.
export { selectRuntime } from "./select-runtime.ts";
export { selectChildRuntime } from "./child-runtime.ts";
