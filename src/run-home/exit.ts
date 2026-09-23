// WS-21 §3.8: THE EXIT RECONCILE AND THE RECOVERY DOOR — the only two places a run home's working copy
// is compared with the canonical store, both through the ROUTER'S OWN live store and the one function
// every reconcile uses (`reconcileLocalWriteRoot`).
//
// EXIT (the official leg). The proxy's `reconcile` hook runs inside its exit gate, before the SDK can
// observe the exit — so before the wrapper deletes a resume's staging dir, and before a host could
// dispose a run folder. It reconciles the CONFIG-DIR ROOT (the run folder for a fresh generation, the
// staging root for a resume), never `<root>/projects` (the function scans `<root>/projects/…` itself):
//
//   clean, or appended through the store   → `safe`
//   no working copy found, but this generation mirrored frames → UNKNOWN, never clean → quarantined
//   diverged (or the reconcile itself failed)                 → quarantined
//
// A quarantined root's `projects/` is COPIED to `<home>/cache/quarantine/<ts>-<label>/projects` before
// the exit is revealed: the evidence outlives the staging dir the wrapper is about to delete.
//
// RECOVERY (after a crash). The in-memory decorations and the mirror's pending state died with the
// process, so the prefix proof is rebuilt: the claude-ready copy the root was staged from is
// RECOMPUTED (`toClaudeReady` over the canonical file plus its provider-state sidecar) and the working
// copy is compared against it. A root whose canonical file cannot be proven a prefix is quarantined —
// the documented outcome, never a guess.
import { cpSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady, type ContinuityEndpoint, type MessageOrigin } from "@yanlinglabs/winter-provider-runtime";

import { RunHomeError } from "./errors.ts";
import type { RunHomeOutcome } from "./types.ts";
import { compareTranscriptTail, reconcileLocalWriteRoot, scanLocalWriteRoot } from "../store/reconcile.ts";
import { HANDOFF_ENTRY_LABEL, readProviderStateSidecar } from "../store/materialized-resume.ts";
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

export interface RunHomeExitReconcilerInput {
  /** The router's OWN live store (`barrier.shared`) — the one holding `settle()` and the decorations. */
  shared: SharedSessionStore;
  runId: string;
  /** The daemon's home: quarantined copies go under `<home>/cache/quarantine/`. */
  home: string;
  /** How many transcript entries this generation mirrored into the store so far. */
  mirrored: () => number;
  record: (runId: string, outcome: RunHomeOutcome) => void;
  now?: () => Date;
}

/** The proxy's `reconcile` hook for one run-home generation. Never throws: a failure is quarantine. */
export function runHomeExitReconciler(input: RunHomeExitReconcilerInput): (args: { observation: { root: { configDir: string } }; exit: { code: number | null; signal: string | null } }) => Promise<void> {
  const now = input.now ?? (() => new Date());
  return async ({ observation }) => {
    const root = observation.root.configDir;
    const quarantine = (): void => {
      try {
        quarantineRoot(root, input.home, input.runId, now());
      } finally {
        // QUARANTINED EVEN IF THE COPY FAILED: the outcome that matters is "not safe to dispose".
        input.record(input.runId, "quarantined");
      }
    };
    try {
      const report = await reconcileLocalWriteRoot(root, { shared: input.shared });
      if (report.status === "diverged") return quarantine();
      if (report.transcripts.length === 0 && input.mirrored() > 0) return quarantine();
      input.record(input.runId, "safe");
    } catch {
      quarantine();
    }
  };
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
 * The claude-ready copy's lines, recomputed; `undefined` when the fold cannot be shown to be the
 * record-for-record image of the canonical file (a different count or uuid sequence), in which case no
 * prefix can be proved.
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

/** The barrier's staged handoff note (`materialized-resume.ts`'s `buildHandoffEntry`), recognised by its label. */
function isHandoffNote(entry: SessionStoreEntry): boolean {
  if (entry["type"] !== "user") return false;
  const content = (entry["message"] as { content?: unknown } | undefined)?.content;
  return typeof content === "string" && content.startsWith(`[${HANDOFF_ENTRY_LABEL}`);
}

/** Spec §3.8's recovery door. */
export async function reconcileRootForRecovery(root: string, input: RecoveryInput): Promise<"clean" | "appended" | "quarantined"> {
  const now = input.now ?? (() => new Date());
  const quarantined = (): "quarantined" => {
    quarantineRoot(root, input.home, basename(root), now());
    return "quarantined";
  };
  try {
    for (const transcript of scanLocalWriteRoot(root)) {
      await input.shared.settle(transcript.key);
      const canonical = ((await input.shared.store.load(transcript.key)) ?? []).filter((entry) => entry["type"] !== "agent_metadata");
      const sidecar = transcript.key.subpath === undefined ? await readProviderStateSidecar(input.storeHome, transcript.key) : [];
      const expected = recomputedClaudeReadyLines(canonical, sidecar, input.resolveEndpoint);
      if (expected === undefined) return quarantined();
      const comparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: expected, isDecoration: (uuid) => input.shared.decorations.has(transcript.key, uuid) });
      if (comparison.kind === "diverged" || comparison.kind === "canonical-ahead") return quarantined();
      // A HANDOFF NOTE IN THE TAIL IS NOT THE SESSION'S OWN LINE. The barrier's step 8 stages its note as
      // a separate trailing entry of the copy, registered as a copy-only decoration — and that registry
      // died with the process. Appending it now would wash a decoration into the byte-pure canonical
      // file, so a tail that carries one cannot be proved the session's and is quarantined instead.
      if (comparison.kind === "canonical-behind" && comparison.missing.some(isHandoffNote)) return quarantined();
    }
    const report = await reconcileLocalWriteRoot(root, { shared: input.shared });
    if (report.status === "diverged") return quarantined();
    return report.appended > 0 ? "appended" : "clean";
  } catch (error) {
    if (error instanceof RunHomeError) throw error;
    return quarantined();
  }
}
