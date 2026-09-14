// WS-05 §12 + WS-13 §8.2 (R-7b-3): THE HANDOFF BARRIER SEAM. Lane C implements it in `src/store/**`.
//
// "Exactly one runtime owns a compatibility session at a time" (WS-05 §12). The barrier is the eight
// steps that move that ownership, and R-7b-3 splits it: the ROUTER owns the mechanics and the
// Claude-leg injection; the HOST owns switch UX and confirmations (Phase 8, D19c). So this seam is
// `plan()` — which produces something a host can render and confirm — and `execute()`, which either
// completes the transfer or refuses in a way the host can show.
//
// THE FALLBACK IS NEVER LABELLED A PERFECT RESUME. WS-05 §12's last line: "Any unprovable step →
// keep the source owner, offer a visibly lossy fork; never label the fallback perfect resume." That
// is why `HandoffOutcome` has three arms and why the lossy one carries the STEP that could not be
// proven — a host that shows "something went wrong" instead of "step 4: the canonical tail does not
// match the recorded local-write root" is hiding the only fact the user can act on.
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";
import type { SwitchReview } from "@yanlinglabs/winter-provider-runtime";

import type { RuntimeKind, RuntimeSelection, SelectionRefusal } from "../selection/runtime-selection.ts";
import type { SelectionReview } from "../selection/select-runtime.ts";

/**
 * WHAT THE DESTINATION BRANCH WOULD ACTUALLY RUN — Lane D's door, consulted at plan time.
 *
 * WHY THE PLAN CARRIES THIS AT ALL. The barrier moves a session between two runtimes that do not
 * serve the same providers, and until this field existed the plan simply carried the SOURCE's
 * persisted provider fields with the destination's `runtimeKind` stamped over them. That is a plan a
 * host can confirm and a destination must then refuse — a `gemini` row handed to the official
 * runtime, or a Claude OAuth credential handed to Winter, which D28 says never routes there. The
 * refusal arrived at the destination's `confirmInit`, after the lease, the drain and the staging.
 *
 * `refused` IS A TYPED REFUSAL, NEVER A SUBSTITUTION. The barrier does not invent a provider the
 * destination can serve — "deciding a session serves a different provider is the selector's
 * business" (WS-00 §2's D13) — so the plan says why, `plan.steps[7]` carries the same sentence as
 * `knownUnprovable`, and `execute()` offers the visibly lossy fork WS-05 §12 asks for instead of
 * moving ownership.
 *
 * `unreviewed` IS THE HONEST DEFAULT when the host supplies no catalog to review against: nothing was
 * checked, the persisted record travels as it always did, and the plan says so rather than implying a
 * check that did not happen.
 */
export type HandoffSelection =
  | { kind: "servable"; selection: RuntimeSelection; review: SelectionReview }
  | { kind: "refused"; refusal: SelectionRefusal; detail: string }
  | { kind: "unreviewed"; selection: RuntimeSelection; detail: string };

/** WS-05 §12's eight steps, by number, so an outcome can name exactly where it stopped. */
export type HandoffStepNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface HandoffStep {
  step: HandoffStepNumber;
  /** The step's own name, e.g. "acquire the handoff lease" / "compare the canonical tail". */
  name: string;
  /**
   * Whether this step is known to be unprovable BEFORE execution starts — a plan a host can be shown
   * honestly ("this will be a fork, here is why") rather than one that looks clean and then refuses.
   */
  knownUnprovable?: string;
}

export interface HandoffPlan {
  session: SessionKey;
  from: RuntimeKind;
  to: RuntimeKind;
  /** The eight steps, in order. */
  steps: HandoffStep[];
  /** WS-13 §8.2's two doors: decorations in the materialized copy, or one labelled handoff entry. */
  decorationDoor: "preferred" | "fallback";
  /** WS-05 §12 step 7 / §9.1: destination Winter ADOPTS the temp root; destination Claude gets a CLONE-COPY. */
  tempContinuity: "adopt" | "clone-copy";
  /** What the DESTINATION would run this session on, or the typed refusal that says it cannot. */
  selection: HandoffSelection;
  /**
   * WS-18 W18-1/W18-4 (P10b): the FRESH selection a caller decided for a family-crossing model
   * change, carried verbatim from `plan()`'s `requested` option.
   *
   * Present only when the caller supplied one. Its whole shape travels to `confirmInit` unmerged with
   * anything from the session's persisted selection — no source provider, credential ref or auth
   * family reaches the destination's credential plan (W18-1, I-3). Absent means D13 applies: the
   * persisted selection is what `plan.selection.selection` stamps the destination's runtime onto.
   */
  requested?: RuntimeSelection;
  /**
   * WS-18 W18-20 (P10b): the pre-flight loss review for the row `selection` carries — present exactly
   * when `selection.kind !== "refused"` (a refused plan has nothing to review). Embeds the SAME
   * classification `reviewSwitch` would return for this session and this row, so a host does not have
   * to call both doors to get one answer.
   */
  review?: SwitchReview;
}

export type HandoffOutcome =
  | { kind: "resumed"; selection: RuntimeSelection }
  | { kind: "lossy-fork-offered"; reason: string; step: HandoffStepNumber }
  | {
      kind: "blocked";
      /**
       * `"revert-pending"` (fix wave 2, MAJOR M1): a winter destination's write-ahead commit landed but
       * its `confirmInit` never did, and the takeover that reverts the durable record back to the
       * source could not get the writer lease within the retry bound — most likely a dying destination
       * child still holding it. This is NEVER reported as `resumed`: the move did not happen. The
       * revert is retried automatically on a durable, router-owned note; a later `plan()` or any load
       * completes it once the lease frees up, converging ownership back onto the source.
       */
      reason: "repair-required" | "mirror-error" | "lease-held" | "revert-pending";
    };

/** WS-05 §12's mechanics. Lane C implements; the spine pins the signature. */
export interface HandoffBarrier {
  /**
   * `opts.requested` (WS-18 W18-4, P10b): reviews a FRESH selection the caller already decided for a
   * family-crossing model change, instead of the persisted one. Absent — the pre-10b shape — reviews
   * the session's persisted selection, stamped with `to` (D13's rule, unchanged for this case).
   */
  plan(session: SessionKey, to: RuntimeKind, opts?: { requested?: RuntimeSelection }): Promise<HandoffPlan>;
  execute(plan: HandoffPlan): Promise<HandoffOutcome>;
  /**
   * WS-18 W18-20 (P10b): the ONE pre-flight review for every family-crossing model change — same-leg
   * changes (gpt -> deepseek on Winter) as well as cross-runtime ones. Reads the session's persisted
   * selection and the canonical transcript/sidecar through the shared store; never rewrites anything.
   */
  reviewSwitch(session: SessionKey, requested: RuntimeSelection): Promise<SwitchReview>;
}
