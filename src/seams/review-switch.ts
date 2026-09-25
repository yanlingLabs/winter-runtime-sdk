// WS-18 W18-20 (P10b): THE SWITCH-REVIEW SEAM — the one pre-flight review for every family-crossing
// model change. `store/review-switch.ts` implements it.
//
// WS-23: this replaced `seams/handoff.ts`. That seam was WS-05 §12's handoff barrier — `plan()` and
// `execute()` moved ownership of a session between the Winter runtime and the official `claude`
// runtime, and `reviewSwitch` rode beside them. With the official runtime retired nothing moves
// ownership any more; the review is what a host still calls, so it is the whole seam now. Hosts reach
// it where they always did: `runtimeSdkInternals(sdk).barrier.reviewSwitch`.
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";
import type { SwitchReview } from "@yanlinglabs/winter-provider-runtime";

import type { RuntimeSelection } from "../selection/runtime-selection.ts";

export interface SwitchReviewer {
  /**
   * Reviews a switch of `session` to the FRESH `requested` selection a host already decided for the
   * change. Reads the canonical transcript and sidecar through the shared store; never rewrites
   * anything.
   *
   * fix wave 2, CRITICAL C1: the switch's SOURCE is the live tip's own identity, not the directory
   * row's recorded selection — a same-runtime model change never updates that row. The tip's sidecar
   * `kind:"origin"` record wins when Winter wrote one; otherwise the tip's own `message.model` (a
   * claude-written turn) is read directly. The recorded selection is the fallback ONLY when the lineage
   * has no assistant entry at all (a session with no reply yet).
   */
  reviewSwitch(session: SessionKey, requested: RuntimeSelection): Promise<SwitchReview>;
}
