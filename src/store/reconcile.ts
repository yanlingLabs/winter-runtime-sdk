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
/** A workflow run's journal, under `subagents/<rel>/` (claude's `journal` key: `subagents/<rel>/journal`). */
const RUN_JOURNAL_STEM = "journal";
/** The session's own journals, directly under `<sessionId>/` (claude's `sessionJournal` names). */
const SESSION_JOURNAL_STEMS: readonly string[] = ["world"];

/** One transcript found under a local-write root, with the store key it mirrors to. */
export interface LocalTranscript {
  path: string;
  key: SessionKey;
}

/**
 * Every transcript under a recorded local-write root.
 *
 * NOT A GLOB: exactly these shapes are reconciled, each under the store key claude's own import gives it
 * (`importSessionToStore`; the resume materialization writes every subkey back to the same path), and
 * everything else in that tree — the vendor's settings, its caches, its lock files — is out of scope by
 * construction rather than by a filter someone has to maintain:
 *   * `<key>/<uuid>.jsonl` — the session's own transcript;
 *   * `<key>/<sid>/subagents/<any depth>/agent-<id>.jsonl` — a subagent's (nested for a workflow's agents);
 *   * `<key>/<sid>/subagents/<rel>/journal.jsonl`, `<rel>` non-empty — a workflow run's journal (review
 *     N-1; claude's `journal` key, subpath `subagents/<rel>/journal`);
 *   * `<key>/<sid>/world.jsonl` — the session's own journal (claude's `sessionJournal` key, name `world`).
 * The two journals are plain appends of uuid-less lines, so they are compared byte for byte (`sameRecord`).
 * A missing root is an empty list, not an error: a session that never spawned has nothing to mirror.
 */
export function scanLocalWriteRoot(root: string): LocalTranscript[] {
  const projects = join(root, PROJECTS_DIR);
  const found: LocalTranscript[] = [];
  for (const projectKey of readDirNames(projects, "dir")) {
    const projectDir = join(projects, projectKey);
    for (const name of readDirNames(projectDir, "file")) {
      // `isTranscriptPath`, not `endsWith(".jsonl")`. Every neighbour in this directory ends in
      // `.jsonl` too — the provider-state sidecar most dangerously — and a scan that took one would
      // hand it to reconciliation as a SESSION named after the file, i.e. it would IMPORT the one file
      // WS-17 §8's first probe requires to be left byte-untouched. The predicate is an allowlist over
      // the store's own naming rule; see its own header.
      if (!isTranscriptPath(join(projectDir, name), "session")) continue;
      const sessionId = name.slice(0, -JSONL.length);
      found.push({ path: join(projectDir, name), key: { projectKey, sessionId } });
    }
    // `<sessionId>/subagents/**/agent-*.jsonl` — WS-05 §6's subkey shape, and (review I-1) claude's
    // NESTED one: a workflow's agents write `subagents/workflows/<run>/agent-*.jsonl`, which claude
    // mirrors as the subkey `subagents/workflows/<run>/agent-<id>`. Beside them (review N-1), the run's
    // own `journal.jsonl`. Reconciled through the store like any transcript — never copied as a file.
    // Directories only, at ANY depth (review N-1's minor: a depth limit silently dropped a deeper
    // transcript): `readDirNames` never follows a link, so the walk is bounded by the real tree.
    for (const sessionId of readDirNames(projectDir, "dir")) {
      const sessionDir = join(projectDir, sessionId);
      for (const name of readDirNames(sessionDir, "file")) {
        if (!isSessionJournalName(name)) continue;
        found.push({ path: join(sessionDir, name), key: { projectKey, sessionId, subpath: name.slice(0, -JSONL.length) } });
      }
      const walk = (dir: string, subpath: string): void => {
        for (const name of readDirNames(dir, "file")) {
          // A child has its own sidecar too: the stem is matched positively, never by extension.
          const isRunJournal = subpath !== SUBAGENTS_DIR && name === `${RUN_JOURNAL_STEM}${JSONL}`;
          if (!isRunJournal && !isTranscriptPath(join(dir, name), "subagent")) continue;
          found.push({ path: join(dir, name), key: { projectKey, sessionId, subpath: `${subpath}/${name.slice(0, -JSONL.length)}` } });
        }
        for (const child of readDirNames(dir, "dir")) walk(join(dir, child), `${subpath}/${child}`);
      };
      walk(join(sessionDir, SUBAGENTS_DIR), SUBAGENTS_DIR);
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

/**
 * I6: is the local copy a record-for-record PREFIX of the canonical lines? The one question
 * `canonical-ahead` leaves open (`compareTranscriptTail` answers it before comparing a single line):
 * a local copy that is a prefix holds nothing the canonical file lacks — the canonical history simply
 * moved on after it (a resume through staging, a continuation on the other leg) — while one that is
 * not holds a line no append can place.
 */
export function localIsCanonicalPrefix(args: { localPath: string; canonicalLines: readonly string[]; isDecoration?: (uuid: string) => boolean }): boolean {
  const local = withoutDecorations(completeLines(args.localPath), args.isDecoration);
  if (local.length > args.canonicalLines.length) return false;
  for (let i = 0; i < local.length; i++) if (!sameRecord(args.canonicalLines[i]!, local[i]!)) return false;
  return true;
}

// --- reconciliation --------------------------------------------------------------------------------

export interface TranscriptReconcileOutcome {
  key: SessionKey;
  localPath: string;
  comparison: TailComparison;
  appended: number;
  /** Set when a `judge` decided this transcript's fate instead of the comparison (I6). */
  verdict?: "level" | "excluded";
  /** Why a judged transcript was excluded. */
  reason?: string;
  /** Set when a tail WAS appended and the re-read still disagreed: how many entries the append carried. */
  attempted?: number;
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

/**
 * I6: a per-transcript verdict, asked BEFORE anything is appended. `reconcile` — the ordinary path
 * (append a behind tail; a match is level); `level` — nothing to append and nothing lost (a proven
 * canonical-ahead prefix); `{ exclude }` — unprovable: never appended, never level, the session's flag
 * stays. A judge that throws excludes that transcript.
 */
export type TranscriptJudge = (transcript: LocalTranscript, comparison: TailComparison) => Promise<"reconcile" | "level" | { exclude: string }>;

export interface TranscriptReconcilerInput {
  shared: SharedSessionStore;
  /** Restricts reconciliation to one session; omitted = every transcript under the root. */
  only?: { projectKey: string; sessionId: string };
  /** Recovery's per-transcript proof (WS-21 §3.8, I6). Absent = every transcript takes the ordinary path. */
  judge?: TranscriptJudge;
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
  // WHEN A SESSION IS NAMED, IT IS ADDRESSED — never looked for (review r2, N4). The barrier's step 4
  // compares the canonical tail against `<root>/projects/<key>/<id>.jsonl` BY PATH, and this repair used
  // to reach the same file through `scanLocalWriteRoot`, whose allowlist can legitimately skip a name
  // the comparison read. Two predicates for "is this the transcript" on the two halves of one step is
  // how a handoff completed while silently dropping the tail the source had written.
  const transcripts =
    input.only === undefined
      ? scanLocalWriteRoot(root)
      : (() => {
          const key: SessionKey = { projectKey: input.only.projectKey, sessionId: input.only.sessionId };
          const direct = localTranscriptPath(root, key);
          const named: LocalTranscript[] = isFile(direct) ? [{ path: direct, key }] : [];
          // Its subagents still come from the scan — they are addressed by a subkey this caller did not name.
          const children = scanLocalWriteRoot(root).filter((found) => found.key.subpath !== undefined && found.key.projectKey === key.projectKey && found.key.sessionId === key.sessionId);
          return [...named, ...children];
        })();
  const outcomes: TranscriptReconcileOutcome[] = [];
  const cleared: SessionKey[] = [];
  let appended = 0;
  let diverged = false;
  /** The sessions (by `sessionKeyString`) with at least one transcript that did not come back level. */
  const unlevel = new Set<string>();

  for (const transcript of transcripts) {
    await shared.settle(transcript.key);
    const isDecoration = (uuid: string): boolean => shared.decorations.has(transcript.key, uuid);
    const comparison = compareTranscriptTail({ localPath: transcript.path, canonicalLines: await canonicalLines(shared, transcript.key), isDecoration });
    if (input.judge !== undefined) {
      let verdict: Awaited<ReturnType<TranscriptJudge>>;
      try {
        verdict = await input.judge(transcript, comparison);
      } catch (error) {
        verdict = { exclude: `the proof itself failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (verdict === "level") {
        outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: 0, verdict: "level" });
        continue;
      }
      if (verdict !== "reconcile") {
        diverged = true;
        unlevel.add(sessionKeyString(transcript.key));
        outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: 0, verdict: "excluded", reason: verdict.exclude });
        continue;
      }
    }
    if (comparison.kind === "canonical-behind" && comparison.missing.length > 0) {
      await shared.store.append(transcript.key, comparison.missing);
      await shared.settle(transcript.key);
      const after = compareTranscriptTail({ localPath: transcript.path, canonicalLines: await canonicalLines(shared, transcript.key), isDecoration });
      if (after.kind !== "match") {
        diverged = true;
        unlevel.add(sessionKeyString(transcript.key));
        outcomes.push({ key: transcript.key, localPath: transcript.path, comparison: after, appended: 0, attempted: comparison.missing.length });
        continue;
      }
      appended += comparison.missing.length;
      outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: comparison.missing.length });
      continue;
    }
    if (comparison.kind === "diverged" || comparison.kind === "canonical-ahead") {
      diverged = true;
      unlevel.add(sessionKeyString(transcript.key));
    }
    outcomes.push({ key: transcript.key, localPath: transcript.path, comparison, appended: 0 });
  }

  // The flag exists to block a handoff until the canonical store is reconciled (WS-14 §5). It is
  // cleared per SESSION, and only when every one of that session's transcripts — its own and its
  // subagents' — came back level (I6: another session's divergence in the same root no longer holds a
  // level session's flag).
  for (const key of uniqueSessions(transcripts.map((t) => t.key))) {
    if (unlevel.has(sessionKeyString(key))) continue;
    shared.markReconciled(key, `reconciled against ${root}`);
    cleared.push(key);
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

/** A SESSION's identity (a subagent transcript belongs to its session). */
const sessionKeyString = (key: SessionKey): string => `${key.projectKey}/${key.sessionId}`;

function uniqueSessions(keys: SessionKey[]): SessionKey[] {
  const seen = new Map<string, SessionKey>();
  for (const key of keys) seen.set(sessionKeyString(key), { projectKey: key.projectKey, sessionId: key.sessionId });
  return [...seen.values()];
}

// --- the collaborator Lane A's spawn proxy takes -----------------------------------------------------

/**
 * The shape of WS-14 §6 rule 3's reconcile hook, as `src/official/spawn-proxy.ts` declares it.
 *
 * DECLARED STRUCTURALLY HERE rather than imported, for the same reason the seams declare the official
 * module structurally: this lane must not depend on that lane's module graph to be buildable.
 *
 * ASSIGNABLE IN ONE DIRECTION, AND THAT IS THE DIRECTION PRODUCTION USES (review r4, N14 — the
 * previous sentence claimed "mutually assignable", which is measurably false). This hook accepts LESS
 * than `SpawnObservation` carries, so Lane C's `createTranscriptReconciler().hook` drops straight into
 * `createSupervisedSpawnProxy({ reconcile })`; the reverse fails, because a `TranscriptReconcile` is
 * handed the whole observation (`processIdentity`, `command`, `args`) and this type does not promise
 * to supply it. Nothing needs the reverse. `test/store/reconcile.test.ts` now actually pins the
 * forward direction — the comment promised a test that did not exist, which is how a structural
 * declaration drifts from the thing it mirrors without anything noticing.
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

/**
 * The two file names a transcript can have (WS-05 §4/§6).
 *
 * AN ALLOWLIST, and the second version of this function (review r1, F6). The first was a DENYLIST
 * keyed to one literal — `!name.includes(".provider-state.")` — which excluded the sidecar the lane
 * had just been burned by and nothing else. Every other `*.jsonl` neighbour under a local-write root
 * was still scanned and would have been IMPORTED as a session: a planted `sess-1.reasoning.jsonl`
 * holding `encrypted_content` became a canonical session named `sess-1.reasoning`, which is opaque
 * state written into a model-readable transcript by the module whose header promises the opposite.
 *
 * A transcript's stem is therefore matched POSITIVELY: the session's own file is named by its backend
 * session UUID, and a subagent's by its `agent-<id>` subkey. Anything else in that directory — a
 * sidecar, a vendor cache, a file invented next year — is not a transcript, and the difference is
 * decided by the store's own naming rule rather than by a list of things to avoid.
 */
const BACKEND_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// NO DOT in the stem: `agent-a1.provider-state` would otherwise match, and the child's own sidecar is
// exactly the file this predicate exists to keep out (review r1, F6 — caught by its own test).
const SUBAGENT_STEM_RE = /^agent-[A-Za-z0-9_-]+$/;

function isSessionJournalName(name: string): boolean {
  return name.endsWith(JSONL) && SESSION_JOURNAL_STEMS.includes(name.slice(0, -JSONL.length));
}

/**
 * Is this key one of claude's JOURNALS (a workflow run's `subagents/<rel>/journal`, or the session's own
 * `world`) rather than a transcript? A journal is written verbatim — never through the claude-ready fold
 * — so it is proved against the canonical lines themselves, byte for byte.
 */
export function isJournalKey(key: SessionKey): boolean {
  if (key.subpath === undefined) return false;
  if (SESSION_JOURNAL_STEMS.includes(key.subpath)) return true;
  const segments = key.subpath.split("/");
  return segments.length >= 3 && segments[0] === SUBAGENTS_DIR && segments[segments.length - 1] === RUN_JOURNAL_STEM;
}

export function isTranscriptPath(path: string, kind: "session" | "subagent" = "session"): boolean {
  if (!path.endsWith(JSONL)) return false;
  const stem = basename(path).slice(0, -JSONL.length);
  return kind === "subagent" ? SUBAGENT_STEM_RE.test(stem) : BACKEND_UUID_RE.test(stem);
}

/** Whether a path exists and is a regular file — used by the probes' byte-for-byte assertions. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
