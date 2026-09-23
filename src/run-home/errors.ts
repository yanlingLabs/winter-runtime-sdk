// WS-21: the run home's typed refusals.
//
// ONE CLASS, A CODE PER REFUSAL. The daemon forwards `code` as the JSON-RPC error's `data.code`, the
// way it forwards every other typed router refusal, so a code is a compatibility promise: it is never
// reworded, and a new refusal gets a new code rather than a new sentence under an old one.
import { RuntimeSdkError } from "../errors.ts";

export type RunHomeErrorCode =
  /** A generation arrived without `runtime.runHome` on a router created with `requireRunHome: true`. */
  | "run_home_required"
  /** The object passed as a run home was not built by `buildRunHome`, or has been disposed (spec §3.5). */
  | "run_home_foreign"
  /** The run home was built for the other leg (a Winter-leg `projects` link on the official leg writes the store directly). */
  | "run_home_leg_mismatch"
  /** The run home was built for a different working directory than the generation runs in. */
  | "run_home_cwd_mismatch"
  /** The run home was built under a different brand than the router's. */
  | "run_home_brand_mismatch"
  /** The run home's shared home is not the one the router's store lives in. */
  | "run_home_store_mismatch"
  /** `cache` or `cache/runs` is a link, or the run folder could not be created privately (spec §3.4.6). */
  | "run_home_link_refused"
  /** The resume staging dir held more than `projects/` when the proxy came to link the run home in (spec §3.6). */
  | "run_home_staging_not_bare"
  /** A setting source other than `user`, or `user` on a config dir that is not a router-built run folder (spec §3.5). */
  | "setting_sources_refused"
  /** A caller-supplied value for a variable only the router sets. */
  | "router_owned_variable"
  /**
   * An option the run home decides, supplied by the caller beside one (fix round 1, M1): `plugins`,
   * `skills`, `agents`, `outputStyle` or `brand`. They come from the run folder (items, effective
   * settings) or from the router itself (the brand), and a caller's copy would bypass its rewrites.
   */
  | "run_home_option_refused"
  /** The router's cold-resume path needed a run home and the host registered no `runHomeFor`. */
  | "run_home_for_missing"
  /** `/loop` is not a Winter surface (spec §7.3 (d)): the prompt is refused, never dropped. */
  | "loop_refused";

export class RunHomeError extends RuntimeSdkError {
  readonly code: RunHomeErrorCode;
  constructor(code: RunHomeErrorCode, reason: string, options?: { cause?: unknown }) {
    super(`winter-runtime-sdk: ${code} — ${reason}`, options);
    this.code = code;
  }
}
