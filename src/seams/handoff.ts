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

import type { RuntimeKind, RuntimeSelection } from "../selection/runtime-selection.ts";

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
}

export type HandoffOutcome =
  | { kind: "resumed"; selection: RuntimeSelection }
  | { kind: "lossy-fork-offered"; reason: string; step: HandoffStepNumber }
  | { kind: "blocked"; reason: "repair-required" | "mirror-error" | "lease-held" };

/** WS-05 §12's mechanics. Lane C implements; the spine pins the signature. */
export interface HandoffBarrier {
  plan(session: SessionKey, to: RuntimeKind): Promise<HandoffPlan>;
  execute(plan: HandoffPlan): Promise<HandoffOutcome>;
}
