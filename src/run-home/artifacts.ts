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
//   * a file the STORE owns is never touched here (review I-1): every `*.jsonl` at any depth (a transcript
//     or a journal — the reconcile's, see `scanLocalWriteRoot` — or a sidecar), every `*.meta.json` (the
//     store writes `agent_metadata` there WITH its `type`; claude's local copy has none, and a copied one
//     would be read back by `load()` as an extra record), and the store's `*.summary.json`, `*.lock`,
//     `*.tail-quarantine` and `*.tmp-*` files;
//   * a `*.jsonl` the reconcile does NOT pick up (review N-1) is never copied as a file either — the store
//     owns every `.jsonl` name — and never dropped silently: it is reported under `skipped`, with why;
//   * a `*.meta.json` beside a reconciled subagent transcript or journal is `repairTranscriptMetadata`'s
//     (below: into the store, the way claude's import does); any other one is reported under `skipped`;
//   * a LINK in the working copy is never followed and never copied — it is reported and skipped;
//   * the destination is `<store>/projects/<same relative path>`, confined there: a destination whose
//     path passes through a link, or whose place is taken by something that is not a file, is a conflict;
//   * a missing destination is COPIED; a byte-identical one is left; a DIFFERENT one is never
//     overwritten — the working copy's file is reported as a conflict for the caller to quarantine.
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { scanLocalWriteRoot, type LocalTranscript } from "../store/reconcile.ts";
import type { SharedSessionStore } from "../store/wiring.ts";

const PRIVATE_DIR = 0o700;
const PROJECTS_DIR = "projects";
/** File names the canonical store owns (review I-1): never an artifact, whatever the working copy holds. */
function isStoreOwnedName(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".meta.json") || name.endsWith(".summary.json") || name.endsWith(".lock") || name.endsWith(".tail-quarantine") || name.includes(".tmp-");
}

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
  /** Never carried: a link (or a special file) in the working copy, or a `*.jsonl` the reconcile does not pick up. */
  skipped: Array<CarriedArtifact & { reason: string }>;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
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
  // THE ONE PREDICATE for "the reconcile carries this `.jsonl`" is the reconcile's own scan: a second list
  // here would drift from it, and a file both halves skip is exactly the loss N-1 found. A scan that
  // cannot complete leaves the set empty, so every `.jsonl` is reported rather than assumed carried.
  let reconciled: ReadonlySet<string>;
  let metadataBeside: ReadonlySet<string>;
  try {
    const scanned = scanLocalWriteRoot(root);
    reconciled = new Set(scanned.map((transcript) => transcript.path));
    metadataBeside = new Set(scanned.filter((transcript) => transcript.key.subpath !== undefined).map(metadataPathOf));
  } catch {
    reconciled = new Set();
    metadataBeside = new Set();
  }

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
      if (name.endsWith(".jsonl")) {
        if (!reconciled.has(source)) report.skipped.push({ ...artifact, reason: "a .jsonl the transcript reconcile does not recognise: the store owns every .jsonl name, so it is never copied as a file" });
        continue;
      }
      if (name.endsWith(META_JSON)) {
        if (!metadataBeside.has(source)) report.skipped.push({ ...artifact, reason: "metadata with no reconciled subagent transcript or journal beside it: the store owns every .meta.json name, so it is never copied as a file" });
        continue;
      }
      if (path.length < 2 || isStoreOwnedName(name)) continue;
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

const META_JSON = ".meta.json";

/** The `.meta.json` claude keeps beside a subagent transcript or a journal (`<stem>.jsonl` → `<stem>.meta.json`). */
function metadataPathOf(transcript: LocalTranscript): string {
  return `${transcript.path.slice(0, -".jsonl".length)}${META_JSON}`;
}

export interface MetadataRepairReport {
  /** Appended to the store as `{ type: "agent_metadata", …parsed }` — the store had none. */
  repaired: CarriedArtifact[];
  /** The store already held exactly this metadata. */
  identical: CarriedArtifact[];
  /** Never appended, with why (the store's own metadata is never overwritten). */
  skipped: Array<CarriedArtifact & { reason: string }>;
}

/**
 * Repairs the store's copy of a subagent transcript's or a journal's metadata from the working copy.
 *
 * CLAUDE'S IMPORT turns the `.meta.json` beside EVERY `subagents/**.jsonl` — journals included — into an
 * `{ type: "agent_metadata", …parsed }` entry on that key (`importSessionToStore`, 2.1.250), and its
 * resume materializer writes it back beside the file. The mirror carries an agent's metadata live, but a
 * journal is never mirrored, and a failed metadata batch leaves an agent without it; so after the
 * transcripts are reconciled, each one that came back level (`eligible`) has its `.meta.json` repaired
 * the same way:
 *   * the store has none → appended, then re-read to confirm;
 *   * the store holds the same → left;
 *   * the store holds a DIFFERENT one → never overwritten, reported skipped;
 *   * unreadable, not a JSON object, or carrying a `type` of its own other than `agent_metadata` (claude's
 *     spread would let it replace the entry's type and write it into the transcript) → reported skipped.
 * Only a REGULAR file is read: a link (or a special file) is the carry-back's to report, never followed.
 */
export async function repairTranscriptMetadata(
  root: string,
  shared: Pick<SharedSessionStore, "store" | "settle">,
  eligible: (key: SessionKey) => boolean = () => true,
): Promise<MetadataRepairReport> {
  const report: MetadataRepairReport = { repaired: [], identical: [], skipped: [] };
  let transcripts: LocalTranscript[];
  try {
    transcripts = scanLocalWriteRoot(root).filter((transcript) => transcript.key.subpath !== undefined);
  } catch {
    return report;
  }
  const projects = join(root, PROJECTS_DIR);
  for (const transcript of transcripts) {
    const source = metadataPathOf(transcript);
    const stat = lstatOrUndefined(source);
    if (stat === undefined || !stat.isFile()) continue;
    const artifact: CarriedArtifact = { path: relative(projects, source).split(sep).join("/"), source, projectKey: transcript.key.projectKey, sessionId: transcript.key.sessionId };
    const skip = (reason: string): void => void report.skipped.push({ ...artifact, reason });
    if (!eligible(transcript.key)) {
      skip("its transcript or journal was not reconciled, so its metadata is not provable either");
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(source, "utf8"));
    } catch (error) {
      skip(`it is not readable JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      skip("it is not a JSON object");
      continue;
    }
    const fields = parsed as Record<string, unknown>;
    if (fields["type"] !== undefined && fields["type"] !== "agent_metadata") {
      skip(`it carries a \`type\` of its own (${JSON.stringify(fields["type"])}), which would replace the metadata entry's`);
      continue;
    }
    const entry = { type: "agent_metadata", ...fields } as SessionStoreEntry;
    const stored = async (): Promise<SessionStoreEntry | undefined> => {
      await shared.settle(transcript.key);
      return ((await shared.store.load(transcript.key)) ?? []).filter((candidate) => candidate["type"] === "agent_metadata").at(-1);
    };
    try {
      const existing = await stored();
      if (existing !== undefined) {
        if (isDeepStrictEqual(existing, entry)) report.identical.push(artifact);
        else skip("the store already holds different metadata for this key; it is never overwritten");
        continue;
      }
      await shared.store.append(transcript.key, [entry]);
      const after = await stored();
      if (after !== undefined && isDeepStrictEqual(after, entry)) report.repaired.push(artifact);
      else skip("the append did not land: the store's metadata still differs after it");
    } catch (error) {
      skip(`the store could not be read or written (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return report;
}
