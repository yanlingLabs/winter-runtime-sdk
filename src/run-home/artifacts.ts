// WS-21: A SESSION'S NON-TRANSCRIPT FILES CARRIED BACK FROM A WORKING COPY INTO THE SHARED STORE.
//
// On the official leg the run folder's `projects/` is PRIVATE (a working copy the mirror and the exit
// reconcile reconcile against the canonical store), and claude writes more there than its transcript.
// MEASURED on the pinned runtime (claude 2.1.250), under `projects/<key>/<sid>/`:
//   * `tool-results/<id>.txt`            — a large tool output, referenced from the transcript;
//   * `workflows/scripts/<name>-<run>.js` — a launched workflow's saved script;
//   * `workflows/<run>.json`             — the workflow's run record;
//   * `subagents/agent-<id>.meta.json`   — a subagent's metadata (its `.jsonl` is a transcript);
//   * and, for a workflow that spawns agents, `subagents/workflows/<run>/…`.
// Nothing claude needs later lives beside the session dirs today (the auto-memory dir is pinned to the
// shared store), but a per-project file there is carried the same way.
//
// THE MIRROR CARRIES TRANSCRIPTS ONLY (the SDK's `SessionStore` has no artifact surface), so without this
// every one of those files died with the run folder. The rules, in order:
//   * a TRANSCRIPT is never touched here — `<key>/*.jsonl` and `<sid>/subagents/agent-*.jsonl` are the
//     reconcile's (and a stray `.jsonl` at the key level is a transcript or a sidecar, never an artifact);
//   * a LINK in the working copy is never followed and never copied — it is reported and skipped;
//   * the destination is `<store>/projects/<same relative path>`, confined there: a destination whose
//     path passes through a link, or whose place is taken by something that is not a file, is a conflict;
//   * a missing destination is COPIED; a byte-identical one is left; a DIFFERENT one is never
//     overwritten — the working copy's file is reported as a conflict for the caller to quarantine.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

const PRIVATE_DIR = 0o700;
const PROJECTS_DIR = "projects";
const SUBAGENT_TRANSCRIPT_RE = /^agent-[^/]+\.jsonl$/;

export interface CarriedArtifact {
  /** The file's path relative to the working copy's `projects/` (`<key>/<sid>/tool-results/x.txt`). */
  path: string;
  /** The absolute path in the working copy. */
  source: string;
  projectKey: string;
  /** The session dir the file belongs to; absent for a per-project file beside the session dirs. */
  sessionId?: string;
}

export interface ArtifactCarryReport {
  copied: CarriedArtifact[];
  identical: CarriedArtifact[];
  /** Never overwritten: the destination differs, or cannot be written without passing a link. */
  conflicts: Array<CarriedArtifact & { reason: string }>;
  /** Never followed: a link (or a special file) in the working copy. */
  skipped: Array<CarriedArtifact & { reason: string }>;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Is `relativePath` (under a key dir) a transcript the reconcile owns? */
function isTranscript(segments: readonly string[]): boolean {
  // `<key>/<anything>.jsonl` — a session transcript (or a sidecar, which is never the working copy's).
  if (segments.length === 2) return segments[1]!.endsWith(".jsonl");
  // `<key>/<sid>/subagents/agent-<id>.jsonl` — a subagent transcript.
  return segments.length === 4 && segments[2] === "subagents" && SUBAGENT_TRANSCRIPT_RE.test(segments[3]!);
}

/**
 * Every existing directory from `<store>/projects` down to `dir` must be a REAL directory — a link
 * anywhere on the way would put the write somewhere else. Returns the first offender, or `undefined`.
 */
function linkOnTheWay(storeProjects: string, dir: string): string | undefined {
  const rel = relative(storeProjects, dir);
  let current = storeProjects;
  const root = lstatOrUndefined(current);
  if (root !== undefined && !root.isDirectory()) return current;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    current = join(current, segment);
    const stat = lstatOrUndefined(current);
    if (stat === undefined) return undefined; // the rest is created by us, as real directories
    if (!stat.isDirectory()) return current;
  }
  return undefined;
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/**
 * Carries every non-transcript file under `<root>/projects/` into `<storeHome>/projects/` (same relative
 * path). Never throws for a single file's trouble — each is reported; a failure to list the root reads
 * as nothing to carry.
 */
export function carryBackSessionArtifacts(root: string, storeHome: string): ArtifactCarryReport {
  const report: ArtifactCarryReport = { copied: [], identical: [], conflicts: [], skipped: [] };
  const sourceProjects = join(root, PROJECTS_DIR);
  const rootStat = lstatOrUndefined(sourceProjects);
  // A `projects` that is itself a link is the Winter leg's shape (a link to the canonical store): there
  // is no working copy to carry, and following it would copy the store onto itself.
  if (rootStat === undefined || !rootStat.isDirectory()) return report;
  const storeProjects = join(storeHome, PROJECTS_DIR);

  const visit = (dir: string, segments: string[]): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const source = join(dir, name);
      const path = [...segments, name];
      const stat = lstatOrUndefined(source);
      if (stat === undefined) continue;
      const artifact: CarriedArtifact = {
        path: path.join("/"),
        source,
        projectKey: path[0]!,
        ...(path.length >= 3 ? { sessionId: path[1]! } : {}),
      };
      if (stat.isSymbolicLink()) {
        report.skipped.push({ ...artifact, reason: "a link in the working copy is never followed" });
        continue;
      }
      if (stat.isDirectory()) {
        visit(source, path);
        continue;
      }
      if (!stat.isFile()) {
        report.skipped.push({ ...artifact, reason: "not a regular file" });
        continue;
      }
      if (path.length < 2 || isTranscript(path)) continue;
      const destination = join(storeProjects, ...path);
      const offender = linkOnTheWay(storeProjects, dirname(destination));
      if (offender !== undefined) {
        report.conflicts.push({ ...artifact, reason: `the destination path passes through ${offender}, which is not a real directory; nothing is written through it` });
        continue;
      }
      const existing = lstatOrUndefined(destination);
      if (existing !== undefined) {
        if (!existing.isFile()) {
          report.conflicts.push({ ...artifact, reason: `${destination} exists and is not a regular file` });
        } else if (sameBytes(source, destination)) {
          report.identical.push(artifact);
        } else {
          report.conflicts.push({ ...artifact, reason: `${destination} exists with different content; it is never overwritten` });
        }
        continue;
      }
      try {
        mkdirSync(dirname(destination), { recursive: true, mode: PRIVATE_DIR });
        // EXCL: a file that appeared between the check and the copy is never overwritten.
        copyFileSync(source, destination, constants.COPYFILE_EXCL);
        report.copied.push(artifact);
      } catch (error) {
        report.conflicts.push({ ...artifact, reason: `the copy failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  };
  if (existsSync(sourceProjects)) visit(sourceProjects, []);
  return report;
}
