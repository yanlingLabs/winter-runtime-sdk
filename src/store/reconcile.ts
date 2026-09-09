// TRANSCRIPT-ONLY RECONCILIATION (WS-14 §5/§6, WS-05 §12 step 4) — the safe half of `mirror_error`.
//
// WS-14 §5 leaves exactly one door open after a mirror failure and nails the other one shut:
//
//   * SHUT — "Blind `importSessionToStore()` after partial mirror failure is forbidden." The import
//     transports a whole local transcript into the canonical store. After a PARTIAL mirror some of
//     those entries are already there, so a blind import duplicates them; and it says nothing about
//     ORDER, so it can interleave around the ones that never landed.
//   * OPEN — compare the canonical tail against the recorded local-write root and append ONLY the
//     suffix the canonical is missing (WS-05 §12 step 4: "reconcile while state still exists").
//
// The difference between the two is the whole of this module: a prefix comparison, and a suffix
// append. Anything that is not a clean prefix is NOT reconciled here — it is reported as `diverged`,
// which is what `repair-required` means, and the barrier refuses the handoff rather than guessing.
//
// "TOUCHES TRANSCRIPT/SUBAGENT FILES ONLY" (WS-14 §6 rule 4). This module reads exactly
// `<root>/projects/<projectKey>/<sessionId>.jsonl` and its `subagents/*.jsonl` siblings, and writes
// only through the shared store's `append()`. It never reads, writes, deletes or imports
// `<sessionId>.provider-state.jsonl` — the neighbour file WS-17 §8's probe (a) requires to survive
// "load, append, fresh-process resume, forced compaction, and store import/export round-trips"
// byte-untouched — nor `.lock`, `.summary.json`, `.meta.json`, or anything outside `projects/`.
//
// NOTHING HERE IS LOGGED. A `ReconcileReport` carries paths and counts; entry content, opaque
// provider state included, is read into memory, appended, and never printed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../errors.ts";
import type { SharedSessionStore } from "./wiring.ts";

/** The directory level the official runtime writes its transcripts under, inside a config dir. */
const PROJECTS_DIR = "projects";
const SUBAGENTS_DIR = "subagents";
const JSONL = ".jsonl";

/** One transcript found under a local-write root, with the store key it mirrors to. */
export interface LocalTranscript {
  path: string;
  key: SessionKey;
}

/**
 * Every transcript under a recorded local-write root.
 *
 * NOT A GLOB AND NOT A RECURSIVE WALK: exactly two shapes are transcripts (the session's own file and
 * its `subagents/` children), and everything else in that tree — the vendor's settings, its caches,
 * its lock files — is out of scope by construction rather than by a filter someone has to maintain.
 * A missing root is an empty list, not an error: a session that never spawned has nothing to mirror.
 */
export function scanLocalWriteRoot(root: string): LocalTranscript[] {
  const projects = join(root, PROJECTS_DIR);
  const found: LocalTranscript[] = [];
  for (const projectKey of readDirNames(projects, "dir")) {
    const projectDir = join(projects, projectKey);
    for (const name of readDirNames(projectDir, "file")) {
      // `isTranscriptPath`, not `endsWith(".jsonl")`. The provider-state SIDECAR ends in `.jsonl`
      // too — `<sessionId>.provider-state.jsonl` — and a scan that took it would hand it to
      // reconciliation as a session called `<sessionId>.provider-state`, i.e. it would IMPORT the one
      // file WS-17 §8's first probe requires to be left byte-untouched. (Found by the test below,
      // which plants one.)
      if (!isTranscriptPath(join(projectDir, name))) continue;
      const sessionId = name.slice(0, -JSONL.length);
      found.push({ path: join(projectDir, name), key: { projectKey, sessionId } });
    }
    // `<sessionId>/subagents/agent-*.jsonl` — WS-05 §6's subkey shape, and the only nested level
    // this scan recognises.
    for (const sessionId of readDirNames(projectDir, "dir")) {
      const subagents = join(projectDir, sessionId, SUBAGENTS_DIR);
      for (const name of readDirNames(subagents, "file")) {
        if (!isTranscriptPath(join(subagents, name))) continue; // a child has its own sidecar too
        found.push({
          path: join(subagents, name),
          key: { projectKey, sessionId, subpath: `${SUBAGENTS_DIR}/${name.slice(0, -JSONL.length)}` },
        });
      }
    }
  }
  return found;
}

function readDirNames(dir: string, kind: "dir" | "file"): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (kind === "dir" ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR") return [];
    throw error;
  }
}

// --- the comparison --------------------------------------------------------------------------------

/** WS-05 §12 step 4's four possible answers. */
export type TailComparison =
  | { kind: "match"; lines: number }
  | { kind: "canonical-behind"; lines: number; missing: SessionStoreEntry[] }
  /** The canonical file disagrees with the local root at a line both of them have. */
  | { kind: "diverged"; atLine: number; reason: string }
  /** The canonical file has entries the local root does not — they are not the same history. */
  | { kind: "canonical-ahead"; extra: number };

/**
 * Complete lines only.
 *
 * A local transcript is being read while (or just after) its writer had it open, so a torn final line
 * is ordinary rather than exceptional — the concrete store's own `parseWithTailRepair` exists for the
 * same reason. An incomplete tail is simply not part of the comparison: it is not yet a record.
 */
function completeLines(path: string): string[] {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return [];
    throw error;
  }
  if (raw.length === 0) return [];
  const text = raw.toString("utf8");
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // a torn tail is not a record
  else lines.pop(); // the empty string after the final newline
  return lines.filter((line) => line.length > 0);
}

/**
 * Drops the lines that exist only in a materialized resume copy (WS-13 §8.2's PREFERRED door).
 *
 * A DECORATION IS NOT A MISSING MIRROR WRITE. It was never sent to the store and must never be sent:
 * dropping it here is what stops the comparison from calling the canonical file "behind" and appending
 * it — the wash-back the probe is about. The store's own `append()` re-parents anything that pointed at
 * one (see `stripDecorations`), so the surviving suffix still links into the canonical chain.
 */
function withoutDecorations(lines: string[], isDecoration?: (uuid: string) => boolean): string[] {
  if (isDecoration === undefined) return lines;
  return lines.filter((line) => {
    const entry = parseLine(line);
    const uuid = entry === null ? undefined : entry["uuid"];
    return !(typeof uuid === "string" && isDecoration(uuid));
  });
}

function parseLine(line: string): SessionStoreEntry | null {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as SessionStoreEntry) : null;
  } catch {
    return null;
  }
}

/**
 * Are two lines the same record?
 *
 * BY `uuid` WHEN BOTH CARRY ONE, because the uuid IS the dialect's identity (WS-05 §5.2) and the two
 * files are written by two different serializers over the same object — the canonical side goes
 * through `JSON.parse` and `JSON.stringify`, so a numeric literal spelled `1e3` locally comes back as
 * `1000`. Comparing bytes would call that a divergence; comparing uuids calls it what it is. Lines
 * with no uuid (a foreign or unknown entry type) fall back to exact bytes, which is the only honest
 * comparison left for them.
 */
function sameRecord(canonicalLine: string, localLine: string): boolean {
  if (canonicalLine === localLine) return true;
  const a = parseLine(canonicalLine);
  const b = parseLine(localLine);
  if (a === null || b === null) return false;
  return typeof a["uuid"] === "string" && a["uuid"] === b["uuid"];
}

/**
 * WS-05 §12 step 4: "compare canonical tail vs the recorded local-write root".
 *
 * The canonical file MUST be a prefix of the local one. It is a mirror: the local write happens first
 * (WS-14 §5), so the canonical side can only ever be equal or behind. Anything else is a statement
 * that the two files are not the same history, and this function says so rather than repairing it.
 */
export function compareTranscriptTail(args: { localPath: string; canonicalLines: readonly string[]; isDecoration?: (uuid: string) => boolean }): TailComparison {
  const local = withoutDecorations(completeLines(args.localPath), args.isDecoration);
  const canonical = args.canonicalLines;
  if (canonical.length > local.length) return { kind: "canonical-ahead", extra: canonical.length - local.length };
  for (let i = 0; i < canonical.length; i++) {
    if (!sameRecord(canonical[i]!, local[i]!)) {
      return { kind: "diverged", atLine: i + 1, reason: `line ${i + 1} of the canonical transcript is not the record the local-write root has at that position` };
    }
  }
  if (canonical.length === local.length) return { kind: "match", lines: canonical.length };
  const missing: SessionStoreEntry[] = [];
  for (let i = canonical.length; i < local.length; i++) {
    const entry = parseLine(local[i]!);
    if (entry === null) return { kind: "diverged", atLine: i + 1, reason: `line ${i + 1} of the local-write root is not a JSON object, so it cannot be mirrored` };
    missing.push(entry);
  }
  return { kind: "canonical-behind", lines: canonical.length, missing };
}

// --- reconciliation --------------------------------------------------------------------------------

export interface TranscriptReconcileOutcome {
  key: SessionKey;
  localPath: string;
  comparison: TailComparison;
  appended: number;
}

export interface ReconcileReport {
  root: string;
  /** `reconciled` — every transcript now matches. `diverged` — at least one cannot be, safely. */
  status: "reconciled" | "nothing-to-do" | "diverged";
  transcripts: TranscriptReconcileOutcome[];
  appended: number;
  /** The sessions whose health was cleared, i.e. those that were behind and are now level. */
  cleared: SessionKey[];
}

/** A reconciliation that cannot proceed because the canonical store's own state forbids it. */
export class TranscriptReconcileError extends RuntimeSdkError {
  readonly root: string;
  constructor(root: string, reason: string) {
    super(`winter-runtime-sdk: reconciliation against ${root} could not complete — ${reason}`);
    this.root = root;
  }
}

export interface TranscriptReconcilerInput {
  shared: SharedSessionStore;
  /** Restricts reconciliation to one session; omitted = every transcript under the root. */
  only?: { projectKey: string; sessionId: string };
}

/**
 * Reconciles the canonical store against one local-write root.
 *
 * THE ORDER IS DELIBERATE: settle first (so the comparison is not racing the mirror's own pending
 * batch), then compare, then append only the suffix, then settle again and re-read to confirm. A
 * reconciliation that reported success without re-reading would be reporting its own intention.
 */
export async function reconcileLocalWriteRoot(root: string, input: TranscriptReconcilerInput): Promise<ReconcileReport> {
  const { shared } = input;
  const transcripts = scanLocalWriteRoot(root).filter(
    (found) => input.only === undefined || (found.key.projectKey === input.only.projectKey && found.key.sessionId === input.only.sessionId),
  );
  const outcomes: TranscriptReconcileOutcome[] = [];
  const cleared: SessionKey[] = [];
  let appended = 0;
  let diverged = false;

  for (const transcript of transcripts) {
    await shared.settle(transcript.key);
    const isDecoration = (uuid: string): boolean => shared.decorations.has(transcript.key, uuid);
    const comparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: await canonicalLines(shared, transcript.key), isDecoration });
    if (comparison.kind === "canonical-behind" && comparison.missing.length > 0) {
      await shared.store.append(transcript.key, comparison.missing);
      await shared.settle(transcript.key);
      const after = compareTranscriptTail({ localPath: transcript.path, canonicalLines: await canonicalLines(shared, transcript.key), isDecoration });
      if (after.kind !== "match") {
        diverged = true;
        outcomes.push({ key: transcript.key, localPath: transcript.path, comparison: after, appended: 0 });
        continue;
      }
      appended += comparison.missing.length;
      outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: comparison.missing.length });
      continue;
    }
    if (comparison.kind === "diverged" || comparison.kind === "canonical-ahead") diverged = true;
    outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: 0 });
  }

  if (!diverged) {
    // The flag exists to block a handoff until the canonical store is reconciled (WS-14 §5). It is
    // cleared per SESSION, and only when every one of that session's transcripts — its own and its
    // subagents' — came back level.
    for (const key of uniqueSessions(transcripts.map((t) => t.key))) {
      shared.markReconciled(key, `reconciled against ${root}`);
      cleared.push(key);
    }
  }

  return {
    root,
    status: diverged ? "diverged" : appended === 0 ? "nothing-to-do" : "reconciled",
    transcripts: outcomes,
    appended,
    cleared,
  };
}

/**
 * The canonical transcript's lines, as the store would write them.
 *
 * READ THROUGH `load()`, never off the disk: `load()` is what re-synthesizes the `agent_metadata`
 * envelope and applies the store's own tail repair, and reading the file directly would compare
 * against bytes the store does not consider its content. The re-serialization is the same
 * `JSON.stringify` the store's `append()` uses, so the two sides are compared in one spelling.
 */
async function canonicalLines(shared: SharedSessionStore, key: SessionKey): Promise<string[]> {
  const entries = await shared.store.load(key);
  if (entries === null) return [];
  // `agent_metadata` never appears in the jsonl (the store partitions it into `.meta.json` and
  // `load()` appends it back) — so it is not part of the transcript being compared.
  return entries.filter((entry) => entry["type"] !== "agent_metadata").map((entry) => JSON.stringify(entry));
}

function uniqueSessions(keys: SessionKey[]): SessionKey[] {
  const seen = new Map<string, SessionKey>();
  for (const key of keys) seen.set(`${key.projectKey}/${key.sessionId}`, { projectKey: key.projectKey, sessionId: key.sessionId });
  return [...seen.values()];
}

// --- the collaborator Lane A's spawn proxy takes -----------------------------------------------------

/**
 * The shape of WS-14 §6 rule 3's reconcile hook, as `src/official/spawn-proxy.ts` declares it.
 *
 * DECLARED STRUCTURALLY HERE rather than imported, for the same reason the seams declare the official
 * module structurally: this lane must not depend on that lane's module graph to be buildable. The two
 * declarations are mutually assignable, and `test/store/reconcile.test.ts` pins that by assigning this
 * function INTO the proxy's own option type once both lanes are in one tree.
 */
export type TranscriptReconcileHook = (input: {
  observation: { root: { configDir: string } };
  exit: { code: number | null; signal: string | null };
}) => Promise<void>;

export interface TranscriptReconciler {
  /** Reconcile one recorded local-write root. */
  reconcile(root: string, only?: { projectKey: string; sessionId: string }): Promise<ReconcileReport>;
  /** The collaborator handed to `createSupervisedSpawnProxy({ reconcile })`. */
  hook: TranscriptReconcileHook;
  /** Every report this reconciler produced, newest last — the supervised-run evidence. */
  readonly reports: readonly ReconcileReport[];
}

/**
 * Builds the reconciler and its proxy hook.
 *
 * THE HOOK NEVER THROWS. WS-14 §6 rule 3 delays the synthetic `exit` until reconciliation completes;
 * a hook that threw would either strand the process or (as Lane A's proxy actually does) be caught and
 * the exit forwarded anyway — and in both readings the FAILURE would be the thing that disappears. So
 * a failed reconciliation is recorded as a `diverged` report, which leaves the session's
 * `repair-required` flag standing and the handoff blocked. That is the outcome §5 asks for.
 */
export function createTranscriptReconciler(input: TranscriptReconcilerInput): TranscriptReconciler {
  const reports: ReconcileReport[] = [];
  const reconcile = async (root: string, only?: { projectKey: string; sessionId: string }): Promise<ReconcileReport> => {
    const report = await reconcileLocalWriteRoot(root, { shared: input.shared, ...(only === undefined ? (input.only === undefined ? {} : { only: input.only }) : { only }) });
    reports.push(report);
    return report;
  };
  return {
    reconcile,
    hook: async ({ observation }) => {
      try {
        await reconcile(observation.root.configDir);
      } catch (error) {
        reports.push({
          root: observation.root.configDir,
          status: "diverged",
          transcripts: [],
          appended: 0,
          cleared: [],
        });
        void error; // the cause is the store's own typed error; the report is what the barrier reads
      }
    },
    get reports() {
      return reports;
    },
  };
}

// --- the blind-import ban, as a call site -------------------------------------------------------------

/**
 * WS-14 §5's forbidden door, guarded.
 *
 * A HOST STILL HAS `importSessionToStore()` — it is the official SDK's own function, and the router
 * cannot take it away. What the router CAN do is give the host one call site that refuses to run it
 * while the mirror is unhealthy, so the ban is a mechanism rather than a sentence in a document.
 */
export async function guardedImportSessionToStore<T>(args: { shared: SharedSessionStore; key: SessionKey; importer: () => Promise<T> }): Promise<T> {
  args.shared.assertImportAllowed(args.key);
  return args.importer();
}

/**
 * The canonical transcript's own path under a Winter home.
 *
 * THE SAME SHAPE AS A LOCAL-WRITE ROOT'S, and that is not a coincidence: WS-05 §6's key mapping is the
 * vendor's own `<configDir>/projects/<projectKey>/<sessionId>.jsonl` layout, which is what makes the
 * canonical file and the local file comparable line for line in the first place.
 */
export function canonicalTranscriptPath(winterHome: string, key: SessionKey): string {
  return localTranscriptPath(winterHome, key);
}

/** The transcript file a local-write root holds for one session key, whether or not it exists. */
export function localTranscriptPath(root: string, key: SessionKey): string {
  const base = join(root, PROJECTS_DIR, key.projectKey);
  if (key.subpath === undefined) return join(base, `${key.sessionId}${JSONL}`);
  return join(base, key.sessionId, `${key.subpath}${JSONL}`);
}

/** True when `path` is a transcript this module would touch — the "transcript-only" rule, as a predicate. */
export function isTranscriptPath(path: string): boolean {
  if (!path.endsWith(JSONL)) return false;
  const name = basename(path);
  // `<id>.provider-state.jsonl` ends in `.jsonl` too, and is the one neighbour file that must never
  // be read, rewritten or imported (WS-17 §8 probe (a)).
  return !name.includes(".provider-state.");
}

/** Whether a path exists and is a regular file — used by the probes' byte-for-byte assertions. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
