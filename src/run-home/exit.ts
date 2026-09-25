// WS-21 §3.8: THE RECOVERY DOOR (and, until WS-23, the exit reconcile) — the only places a run home's
// working copy is compared with the canonical store, both through the ROUTER'S OWN live store and the one function
// every reconcile uses (`reconcileLocalWriteRoot`).
//
// EXIT (the official leg) — RETIRED (WS-23). The official leg's spawn proxy ran an exit reconcile of
// its run folder's private working copy (`runHomeExitReconciler`, removed with that leg). The Winter
// leg's `projects/` is a link to the canonical store, so it has no working copy to reconcile at exit;
// what remains here is the recovery door, which an upgrading home still needs for the official working
// copies and staging roots it left behind.
//
// RECOVERY (after a crash, or Migration C over a pre-WS-21 spool). The in-memory decorations and the
// mirror's pending state died with the process, so the prefix proof is rebuilt PER TRANSCRIPT: the
// claude-ready copy the root was staged from is RECOMPUTED (`toClaudeReady` over the canonical file plus
// its provider-state sidecar) and the working copy is compared against it. Each transcript gets its own
// outcome (I6) — one unprovable transcript never quarantines the rest of the root:
//
//   match                                          → clean
//   canonical behind, the tail provably appendable → appended
//   canonical ahead, the working copy a PREFIX     → canonical-ahead (nothing to append, nothing lost:
//                                                    the history moved on — a resume through staging,
//                                                    a continuation on the other leg)
//   anything unprovable                            → quarantined (that transcript's file is copied out)
import { cpSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady, type ContinuityEndpoint, type MessageOrigin } from "@yanlinglabs/winter-provider-runtime";

import { carryBackSessionArtifacts, repairTranscriptMetadata, type ArtifactCarryReport, type MetadataRepairReport } from "./artifacts.ts";
import { RunHomeError } from "./errors.ts";
import type { RunHomeOutcome } from "./types.ts";
import { compareTranscriptTail, isJournalKey, localIsCanonicalPrefix, reconcileLocalWriteRoot, scanLocalWriteRoot, type TranscriptJudge, type TranscriptReconcileOutcome } from "../store/reconcile.ts";
import { HANDOFF_ENTRY_LABEL, readProviderStateSidecar } from "../store/provider-state.ts";
import type { SharedSessionStore } from "../store/wiring.ts";

const PRIVATE_DIR = 0o700;

/** A filesystem-safe timestamp: `2026-09-23T10-11-12-345Z`. */
const stamp = (now: Date): string => now.toISOString().replace(/[:.]/g, "-");

/**
 * Copies `<root>/projects` to `<home>/cache/quarantine/<ts>-<label>/projects`. Returns the quarantine
 * dir. Refuses (typed) when `cache` or `cache/quarantine` is a link — the evidence is never written
 * through one — and copies links as links (`cpSync` without `dereference`).
 */
export function quarantineRoot(root: string, home: string, label: string, now: Date = new Date()): string {
  const cache = join(home, "cache");
  const quarantine = join(cache, "quarantine");
  for (const path of [cache, quarantine]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new RunHomeError("run_home_link_refused", `${path} is a symbolic link; a quarantined working copy is never written through one`);
    if (!existsSync(path)) mkdirSync(path, { mode: PRIVATE_DIR });
  }
  const destination = join(quarantine, `${stamp(now)}-${label}`);
  mkdirSync(destination, { mode: PRIVATE_DIR });
  const projects = join(root, "projects");
  if (existsSync(projects)) cpSync(projects, join(destination, "projects"), { recursive: true, dereference: false });
  return destination;
}

/** One transcript's recovery outcome (I6). */
export interface RecoveryTranscriptOutcome {
  projectKey: string;
  sessionId: string;
  /** `subagents/agent-<id>` for a subagent transcript; absent for the session's own. */
  subpath?: string;
  outcome: "clean" | "appended" | "canonical-ahead" | "quarantined";
  /** Entries appended to the canonical file (0 unless `appended`). */
  appended: number;
  /** Why a transcript was quarantined. */
  reason?: string;
  /**
   * On a session's OWN transcript: its session dir's other files (tool results, workflow scripts and
   * run records, subagent metadata), carried into `<sdk>/projects/<key>/<sid>/` — `copied`, already
   * `identical`, or `quarantined` (paths relative to `projects/`; a differing destination is never
   * overwritten).
   */
  artifacts?: { copied: number; identical: number; quarantined: string[] };
}

/** `reconcileRootForRecovery`'s answer: the root outcome, and every transcript's own (I6). */
export interface RecoveryReport {
  /** `quarantined` if any transcript was; else `appended` if any tail was appended; else `clean`. */
  outcome: "clean" | "appended" | "quarantined";
  transcripts: RecoveryTranscriptOutcome[];
  /** The quarantine dir holding the quarantined transcripts' and artifacts' copies, when any were. */
  quarantine?: string;
  /**
   * Every carried artifact, totalled — including per-project files beside the session dirs and a
   * session dir with no transcript in this root, which no transcript entry can carry. `skipped` are
   * links (never followed) and special files.
   */
  artifacts?: {
    copied: number;
    identical: number;
    quarantined: string[];
    skipped: string[];
    /** Subagent/journal `.meta.json` files appended to the store as `agent_metadata` (it had none). */
    metadataRepaired?: number;
  };
}

/**
 * Copies the named transcripts (paths under `root`) to `<home>/cache/quarantine/<ts>-<label>/`, keeping
 * their path relative to the root. The same link refusals as `quarantineRoot`.
 */
export function quarantineTranscripts(root: string, home: string, label: string, paths: readonly string[], now: Date = new Date()): string {
  const cache = join(home, "cache");
  const quarantine = join(cache, "quarantine");
  for (const path of [cache, quarantine]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new RunHomeError("run_home_link_refused", `${path} is a symbolic link; a quarantined working copy is never written through one`);
    if (!existsSync(path)) mkdirSync(path, { mode: PRIVATE_DIR });
  }
  const destination = join(quarantine, `${stamp(now)}-${label}`);
  mkdirSync(destination, { mode: PRIVATE_DIR });
  for (const path of paths) {
    const target = join(destination, relative(root, path));
    mkdirSync(dirname(target), { recursive: true, mode: PRIVATE_DIR });
    cpSync(path, target, { dereference: false });
  }
  return destination;
}

/**
 * One reconciled transcript's recovery outcome. A quarantine REASON names what actually happened: "not
 * level after appending N entries" only when an append was made and the re-read disagreed; otherwise the
 * comparison's own reason (minors round, item 4).
 */
export function recoveryOutcomeOf(transcript: TranscriptReconcileOutcome): RecoveryTranscriptOutcome {
  const { key } = transcript;
  const of = (rest: Omit<RecoveryTranscriptOutcome, "projectKey" | "sessionId" | "subpath">): RecoveryTranscriptOutcome => ({
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
    ...rest,
  });
  if (transcript.verdict === "excluded") return of({ outcome: "quarantined", appended: 0, reason: transcript.reason ?? "unprovable" });
  if (transcript.verdict === "level") return of({ outcome: "canonical-ahead", appended: 0 });
  if (transcript.appended > 0) return of({ outcome: "appended", appended: transcript.appended });
  if (transcript.comparison.kind === "match") return of({ outcome: "clean", appended: 0 });
  if (transcript.attempted !== undefined && transcript.attempted > 0) {
    return of({ outcome: "quarantined", appended: 0, reason: `the canonical file is not level with the working copy after appending ${transcript.attempted} entr${transcript.attempted === 1 ? "y" : "ies"} (${transcript.comparison.kind})` });
  }
  const reason = transcript.comparison.kind === "diverged" ? transcript.comparison.reason : `the working copy and the canonical file disagree (${transcript.comparison.kind})`;
  return of({ outcome: "quarantined", appended: 0, reason });
}

/** What `reconcileRootForRecovery` needs from the handle. */
export interface RecoveryInput {
  shared: SharedSessionStore;
  /** The daemon's home (quarantine) and the store's root (the sidecar). */
  home: string;
  storeHome: string;
  resolveEndpoint: (origin: MessageOrigin) => ContinuityEndpoint;
  now?: () => Date;
}

/**
 * The claude-ready copy's lines, recomputed; `undefined` when there is no fold to prove against — the
 * claude target cannot be resolved, or the fold is not the record-for-record image of the canonical
 * file (a different count or uuid sequence) — in which case no prefix can be proved THROUGH the fold.
 */
function recomputedClaudeReadyLines(canonical: SessionStoreEntry[], sidecar: Parameters<typeof toClaudeReady>[1], resolveEndpoint: RecoveryInput["resolveEndpoint"]): string[] | undefined {
  // THE TARGET IS NOT KNOWABLE after a crash, and it does not need to be: it only decides which
  // decorations the fold adds INSIDE foreign assistant entries, and the prefix proof below compares
  // records by uuid (`compareTranscriptTail`), which the fold preserves record-for-record. A claude
  // target is the one this root was staged for; do not "fix" it into a lookup.
  let target: ContinuityEndpoint;
  try {
    target = resolveEndpoint({ providerId: "anthropic", modelKey: "claude", family: "claude" } as MessageOrigin);
  } catch {
    return undefined;
  }
  const { entries } = toClaudeReady(canonical, sidecar, { target, resolveEndpoint });
  if (entries.length !== canonical.length) return undefined;
  for (let i = 0; i < entries.length; i += 1) if (entries[i]!["uuid"] !== canonical[i]!["uuid"]) return undefined;
  return entries.map((entry) => JSON.stringify(entry));
}

/** The retired barrier's staged handoff note (WS-23), recognised by its label in an upgrading home's copy. */
function isHandoffNote(entry: SessionStoreEntry): boolean {
  if (entry["type"] !== "user") return false;
  const content = (entry["message"] as { content?: unknown } | undefined)?.content;
  return typeof content === "string" && content.startsWith(`[${HANDOFF_ENTRY_LABEL}`);
}

/**
 * Spec §3.8's recovery door, PER TRANSCRIPT (I6). The proof is the judge `reconcileLocalWriteRoot`
 * asks before it appends anything; the append, the re-read and the per-session repair flag are that
 * one function's, as everywhere else. A session's flag is cleared only when every one of its
 * transcripts came back level; the quarantined transcripts' files are copied out and nothing of
 * theirs is ever appended.
 */
export async function reconcileRootForRecovery(root: string, input: RecoveryInput): Promise<RecoveryReport> {
  const now = input.now ?? (() => new Date());
  const judge: TranscriptJudge = async (transcript) => {
    const canonical = ((await input.shared.store.load(transcript.key)) ?? []).filter((entry) => entry["type"] !== "agent_metadata");
    const isLocalDecoration = (uuid: string): boolean => input.shared.decorations.has(transcript.key, uuid);
    // A WORKING COPY THAT IS A RECORD-FOR-RECORD PREFIX OF THE CANONICAL FILE HOLDS NOTHING TO APPEND AND
    // NOTHING TO LOSE — whatever the claude-ready fold of the canonical file looks like, or whether one
    // can be computed at all. Proved against the canonical records themselves first: the fold is
    // record-for-record today (measured — decorations ride inside an entry's content, legacy compaction
    // keeps count and uuids), but proving through it needs the endpoint resolver and the sidecar, and a
    // prefix needs neither. Only a copy that EXTENDS or DEPARTS from the canonical records is judged
    // against the fold below.
    const raw = canonical.map((entry) => JSON.stringify(entry));
    if (localIsCanonicalPrefix({ localPath: transcript.path, canonicalLines: raw, isDecoration: isLocalDecoration })) {
      const rawComparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: raw, isDecoration: isLocalDecoration });
      return rawComparison.kind === "canonical-ahead" ? "level" : "reconcile";
    }
    // A JOURNAL (review N-1) is written verbatim, never through the claude-ready fold, so it is proved
    // against the canonical lines themselves: a behind tail is appended, anything else is excluded.
    if (isJournalKey(transcript.key)) {
      const comparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: raw, isDecoration: isLocalDecoration });
      if (comparison.kind === "diverged") return { exclude: comparison.reason };
      if (comparison.kind === "canonical-ahead") return { exclude: "the canonical journal moved on past a line only the working copy has, so that line cannot be appended provably" };
      return "reconcile";
    }
    const sidecar = transcript.key.subpath === undefined ? await readProviderStateSidecar(input.storeHome, transcript.key) : [];
    const expected = recomputedClaudeReadyLines(canonical, sidecar, input.resolveEndpoint);
    if (expected === undefined) return { exclude: "the claude-ready copy cannot be recomputed record-for-record from the canonical file, so no prefix can be proved" };
    const isDecoration = (uuid: string): boolean => input.shared.decorations.has(transcript.key, uuid);
    const comparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: expected, isDecoration });
    if (comparison.kind === "diverged") return { exclude: comparison.reason };
    if (comparison.kind === "canonical-ahead") {
      // NOTHING TO APPEND ONLY WHEN NOTHING IS LOST: the working copy must be a prefix of the canonical
      // history. A copy with a line the canonical history moved past cannot be appended provably.
      return localIsCanonicalPrefix({ localPath: transcript.path, canonicalLines: expected, isDecoration })
        ? "level"
        : { exclude: "the canonical file moved on past a line only the working copy has, so that line cannot be appended provably" };
    }
    // A HANDOFF NOTE IN THE TAIL IS NOT THE SESSION'S OWN LINE. The barrier's step 8 stages its note as
    // a separate trailing entry of the copy, registered as a copy-only decoration — and that registry
    // died with the process. Appending it now would wash a decoration into the byte-pure canonical
    // file, so a tail that carries one cannot be proved the session's and is quarantined instead.
    if (comparison.kind === "canonical-behind" && comparison.missing.some(isHandoffNote)) return { exclude: "the tail carries the barrier's staged handoff note, which is never washed back into the canonical file" };
    return "reconcile";
  };

  let transcripts: RecoveryTranscriptOutcome[];
  const toQuarantine: string[] = [];
  const outcomeOf = (key: SessionKey, rest: Omit<RecoveryTranscriptOutcome, "projectKey" | "sessionId" | "subpath">): RecoveryTranscriptOutcome => ({
    projectKey: key.projectKey,
    sessionId: key.sessionId,
    ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
    ...rest,
  });
  try {
    const report = await reconcileLocalWriteRoot(root, { shared: input.shared, judge });
    transcripts = report.transcripts.map((transcript) => {
      const outcome = recoveryOutcomeOf(transcript);
      if (outcome.outcome === "quarantined") toQuarantine.push(transcript.localPath);
      return outcome;
    });
  } catch (error) {
    if (error instanceof RunHomeError) throw error;
    // THE RECONCILE ITSELF FAILED: nothing about any transcript is proven, so every one is quarantined.
    const reason = `the reconcile could not complete: ${error instanceof Error ? error.message : String(error)}`;
    transcripts = scanLocalWriteRoot(root).map((transcript) => {
      toQuarantine.push(transcript.path);
      return outcomeOf(transcript.key, { outcome: "quarantined", appended: 0, reason });
    });
  }

  // THE SESSIONS' OTHER FILES, carried after the transcripts (see `artifacts.ts`): reported on each
  // session's own transcript entry, and totalled on the report.
  const carried = carryBackSessionArtifacts(root, input.storeHome);
  for (const conflict of carried.conflicts) toQuarantine.push(conflict.source);
  attachArtifacts(transcripts, carried);
  // Metadata only for a transcript that came back level: a quarantined one's is as unprovable as it is.
  const level = new Set(transcripts.filter((transcript) => transcript.outcome !== "quarantined").map((transcript) => `${transcript.projectKey}/${transcript.sessionId}/${transcript.subpath ?? ""}`));
  const metadata = await repairTranscriptMetadata(root, input.shared, (key) => level.has(`${key.projectKey}/${key.sessionId}/${key.subpath ?? ""}`));
  const skipped = [...carried.skipped, ...metadata.skipped];

  let quarantine: string | undefined;
  if (toQuarantine.length > 0) quarantine = quarantineTranscripts(root, input.home, basename(root), toQuarantine, now());
  const anyQuarantined = transcripts.some((transcript) => transcript.outcome === "quarantined") || carried.conflicts.length > 0;
  const outcome = anyQuarantined ? "quarantined" : transcripts.some((transcript) => transcript.outcome === "appended") ? "appended" : "clean";
  const touched = carried.copied.length + carried.identical.length + carried.conflicts.length + skipped.length + metadata.repaired.length;
  return {
    outcome,
    transcripts,
    ...(quarantine === undefined ? {} : { quarantine }),
    ...(touched === 0
      ? {}
      : {
          artifacts: {
            copied: carried.copied.length,
            identical: carried.identical.length,
            quarantined: carried.conflicts.map((conflict) => conflict.path),
            skipped: skipped.map((entry) => entry.path),
            ...(metadata.repaired.length === 0 ? {} : { metadataRepaired: metadata.repaired.length }),
          },
        }),
  };
}

/** Puts each session's carried artifacts on that session's own transcript entry (not a subagent's). */
function attachArtifacts(transcripts: RecoveryTranscriptOutcome[], carried: ArtifactCarryReport): void {
  for (const transcript of transcripts) {
    if (transcript.subpath !== undefined) continue;
    const mine = (entry: { projectKey: string; sessionId?: string }): boolean => entry.projectKey === transcript.projectKey && entry.sessionId === transcript.sessionId;
    const copied = carried.copied.filter(mine).length;
    const identical = carried.identical.filter(mine).length;
    const quarantined = carried.conflicts.filter(mine).map((conflict) => conflict.path);
    if (copied + identical + quarantined.length > 0) transcript.artifacts = { copied, identical, quarantined };
  }
}
