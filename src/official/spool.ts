// WS-14 §1: THE TWO LAUNCH PROFILES, AND THE ROOT THAT IS AUTHORITATIVE.
//
// `CLAUDE_CONFIG_DIR` has TWO values by launch profile, and "conflating them breaks crash recovery":
//
//   fresh / spool-resident   `<brand home>/runtimes/official-agent-spool`   set by OUR env allowlist
//   store-backed resume      `<tmpdir>/claude-resume-<uuid>`                set by the SDK WRAPPER,
//                                                                          after it materializes the
//                                                                          transcript, BEFORE the
//                                                                          spawn hook runs
//
// AND THE RULE THAT MAKES THIS MODULE NECESSARY: "The host MUST treat the value observed in
// `SpawnOptions.env.CLAUDE_CONFIG_DIR` as authoritative for the generation, NOT the value it
// configured." We configure one thing and the wrapper may hand the child another; the observed value
// is the only address of the transcript a crash left behind, and the default spawner exposes no
// post-cleanup lookup for it (§6 rule 2). Everything here is about that asymmetry: build the
// configured value, classify what came back, and refuse the combinations that mean something went
// wrong.
//
// MEASURED AGAINST THE PINNED RUNTIME (0.3.250, this repository's own probe, recorded in the Lane A
// report): a session with `sessionStore` set and `resume: <uuid>` spawned with
// `CLAUDE_CONFIG_DIR=<os tmpdir>/claude-resume-<uuid>` while the SAME session's first generation
// spawned with the spool value we configured. Both halves of the table are observed behaviour, not
// inference.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import type { OfficialLaunchProfile } from "../seams/official-adapter.ts";
import { OfficialConfigurationError } from "./errors.ts";
import { officialBranchLabel } from "./branding.ts";
// One definition of "the vendor's user-level home" for the whole package (review r2, NEW-4).
import { VENDOR_HOME_SEGMENT_RE } from "./containment.ts";
// One definition of the vendor's staging-root vocabulary for the whole package (review r4, N13):
// this lane RECOGNISES a staging root, Lane C STAGES one, and both used to spell it themselves with
// mirrored argument orders. See `src/vendor-paths.ts`'s header.
import { isResumeStagingRoot } from "../vendor-paths.ts";

/**
 * The spool's path segments under the brand home.
 *
 * BRAND-NEUTRAL BY CONSTRUCTION: the product-owned part of the spool path is the HOME DIRECTORY
 * itself, which the caller passes in already resolved from `brand.homeDirName` (review r1, n4: the
 * previous sentence spelled one product's home in prose, and the brand gate's own header says a raw
 * occurrence includes comments even where its regex cannot see one).
 * These two segments name a ROLE ("the runtimes we host", "the spool the official agent lives in"),
 * so a reuser inherits them unchanged and the brand gate has nothing to match.
 */
export const SPOOL_SEGMENTS = ["runtimes", "official-agent-spool"] as const;

/** WS-16's `activeLocalWriteRoot` kinds — one per launch profile. */
export type LocalWriteRootKind = "official-spool" | "sdk-resume-staging";

/**
 * The durable record §6 rule 2 demands: WHICH root this generation actually got, and of which kind.
 *
 * The pair travels together because neither half is derivable from the other at the point it matters:
 * a reconciler holding only a path cannot tell a spool from a staging root it must not delete, and a
 * reconciler holding only a kind has nothing to open.
 */
export interface ObservedLocalWriteRoot {
  configDir: string;
  kind: LocalWriteRootKind;
  profile: OfficialLaunchProfile;
}

/** `<home>/runtimes/official-agent-spool` — profile 1's configured value (§1, §3). */
export function officialSpoolRoot(home: string): string {
  if (home.length === 0) throw new TypeError("officialSpoolRoot: the resolved brand home must not be empty");
  return [home, ...SPOOL_SEGMENTS].join("/");
}

/**
 * Classifies an OBSERVED `CLAUDE_CONFIG_DIR`.
 *
 * The classification is by SHAPE, not by which profile we asked for, because the whole point of §1's
 * authority rule is that the two can disagree: a session configured `fresh-spool` that resumes out of
 * the store is handed a staging root by the wrapper, and the record has to say `sdk-resume-staging`
 * or the reconciler will look in the wrong place after a crash.
 */
export function classifyLocalWriteRoot(configDir: string): ObservedLocalWriteRoot {
  return isResumeStagingRoot(configDir)
    ? { configDir, kind: "sdk-resume-staging", profile: "store-backed-resume" }
    : { configDir, kind: "official-spool", profile: "fresh-spool" };
}

/**
 * §6 rule 2's "VALIDATE and durably record": the checks that run before the record is written.
 *
 * Two refusals, and each is a real failure mode rather than defensive noise:
 *
 *   * AN ABSENT VALUE means the child is about to write its transcript somewhere we did not choose
 *     and cannot name — under the SDK parent's own `CLAUDE_CONFIG_DIR`, or `~/.claude` when there is
 *     none. That is the exact leak §3 forbids ("any variable pointing into `~/.claude`" must not
 *     appear) and it is unrecoverable after the fact, so it fails the spawn.
 *   * A `fresh-spool` GENERATION THAT DID NOT GET THE SPOOL is either a wrapper we do not understand
 *     or an env allowlist that was overwritten downstream. Both mean the recorded root and the real
 *     one have diverged, which is the corruption §1 says breaks crash recovery.
 *
 * A `store-backed-resume` generation is deliberately NOT required to match anything: the staging root
 * is the wrapper's own uuid and we could not have predicted it. It only has to LOOK like one.
 */
export function validateObservedConfigDir(args: {
  observed: string | undefined;
  configured: string;
  profile: OfficialLaunchProfile;
  brand: Pick<BrandProfile, "processLabel">;
}): ObservedLocalWriteRoot {
  const branchLabel = officialBranchLabel(args.brand);
  if (args.observed === undefined || args.observed.length === 0) {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: "the spawn was about to start with no config dir, so this generation's transcript root would be unknown and unrecoverable (WS-14 §1/§6)",
      branchLabel,
    });
  }
  // REVIEW r1, m1 — ON BOTH PROFILES. The vendor's user-level home arriving at the one place §1 calls
  // authoritative is the isolation failure this branch exists to prevent, and the old code checked it
  // on neither profile: a `store-backed-resume` generation observed at `~/.claude` was ACCEPTED and
  // recorded as kind `official-spool`, which is §1's exact conflation ("conflating them breaks crash
  // recovery"). The regex is the same one the env allowlist refuses values with.
  if (VENDOR_HOME_SEGMENT_RE.test(args.observed)) {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: `the child was handed ${args.observed}, which is inside the vendor's user-level home; this branch never writes there (WS-14 §1/§3, WS-17 row 4)`,
      branchLabel,
    });
  }
  const observed = classifyLocalWriteRoot(args.observed);
  // REVIEW r1, m1 — THE PROFILE-2 CHECK THIS FUNCTION'S OWN DOC ALREADY CLAIMED. Both refusals used to
  // be gated on `fresh-spool`, so a store-backed resume accepted ANY path at all. With `sessionStore`
  // set — which this branch always requires — a resume is materialized into the wrapper's own staging
  // root, so anything else means the generation is writing somewhere the record will not describe.
  if (args.profile === "store-backed-resume" && observed.kind !== "sdk-resume-staging") {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: `a store-backed resume was handed ${args.observed}, which is not a materialization staging root; the wrapper stages the transcript before the spawn hook runs, so any other value means this generation's transcript root is not the one the record would name`,
      branchLabel,
    });
  }
  if (args.profile === "fresh-spool" && observed.kind !== "official-spool") {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: `a fresh/spool-resident generation was handed a resume staging root (${args.observed}); the configured spool was ${args.configured}`,
      branchLabel,
    });
  }
  if (args.profile === "fresh-spool" && args.observed !== args.configured) {
    throw new OfficialConfigurationError({
      option: "env.CLAUDE_CONFIG_DIR",
      reason: `the child was handed ${args.observed} while this generation was configured for ${args.configured}; the observed value is authoritative, so a mismatch here means the record and the transcript would disagree`,
      branchLabel,
    });
  }
  return observed;
}

/**
 * WS-14 §3's `CLAUDE_CODE_TMPDIR` and what the engine does with it — reported HONESTLY (WS-17 row 15).
 *
 * "Engine appends its literal `claude-<uid>`" — so a host that reports only the configured value is
 * telling a user the wrong directory. Both are returned, plus the reason the second one cannot be
 * moved, so a capability matrix can print the truth without re-deriving it.
 */
export interface VendorTempRootReport {
  /** What we set: the shared per-user temp root, derived by the host from `brand.tempRootName`. */
  configured: string;
  /** Where the engine actually writes: the configured root plus its own fixed segment. */
  engineComputed: string;
  /** The vendor literal in that path. */
  vendorSegment: string;
  note: string;
}

export function vendorTempRootReport(args: { sharedTempRoot: string; uid: number | string }): VendorTempRootReport {
  const vendorSegment = `claude-${String(args.uid)}`;
  return {
    configured: args.sharedTempRoot,
    engineComputed: `${args.sharedTempRoot.replace(/\/+$/, "")}/${vendorSegment}`,
    vendorSegment,
    note: "the engine appends this segment itself; symlink tricks are rejected by the runtime and are forbidden, so the nested vendor-named directory is disclosed rather than hidden (WS-14 §3/§14)",
  };
}
