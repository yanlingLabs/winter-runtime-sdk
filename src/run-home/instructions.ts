// WS-21 §3.4.3: THE GENERATED INSTRUCTIONS FILE — one file both runtimes read.
//
// ORDER. The shared home's instructions file first; then, for a trusted project, from the root DOWN
// to the cwd: `<d>/<file>`, `<d>/<project dir>/<file>`, `<d>/<file stem>.local.md`. Each file's content
// is preceded by a `# <absolute path>` line, so the model can tell whose words it is reading. No size
// cap — claude does not truncate. The run folder gets `<file>` and a `CLAUDE.md` link to it (the
// official runtime reads only its own name, spec §2.3).
//
// IMPORTS ARE EXPANDED HERE, under each file's own tier rule (F17). A user-tier file follows an
// import anywhere; a project or local file follows one only inside the project root and DROPS the
// rest (reported). Why expand at all: in the run folder every file is USER-tier, so a project file's
// `@~/.aws/credentials` left as a token would be followed by the runtime under the user rule. And why
// NEUTRALISE the leftovers: an import token is resolved relative to the file that holds it, and that
// file is now `<run>/<file>` — so an unresolved `@settings.json` would import the run folder's own
// effective settings. Every leftover `@` that could begin an import gets a zero-width space after it,
// which no import grammar accepts and a reader does not see — code blocks included, because the pinned
// runtime's lexer and a line scanner disagree about what is code (R.3, C1 ii; see `escapeImportTokens`).
//
// PROJECT RULES' `paths:` ARE RE-EXPRESSED FROM THE CWD. A project rule's globs resolve from the parent
// of its dot-dir; in the run folder it is a user-tier rule, whose globs resolve from the cwd. A glob
// that reaches under the cwd is rewritten relative to it; one that can only match OUTSIDE the cwd's
// subtree cannot be written at the user tier at all (a path starting `..` never matches, F17), so a
// rule left with none is loaded unconditionally and reported.
//
// PROJECT RULES' IMPORTS GET THE SAME TREATMENT AS THE INSTRUCTIONS FILE (R.3, C1 i). A project rule in
// `<run>/rules` is a USER-tier rule, whose imports both runtimes follow anywhere — so its body is
// expanded under the PROJECT rule here, the rest dropped and reported, every leftover `@` neutralised.
// EVERY project rule is COPIED, so the build is a snapshot (R.3 touch): a link would let a later edit
// in the repository reach the run home unsettled.
import { readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RunHomeBuildContext } from "./build.ts";
import { runHomeBrandOf, sdkHomeOf, type RunHomeInput, type RunHomeReport } from "./types.ts";
import { claudeFrontmatterSplit } from "./claude-frontmatter.ts";
import { joinFrontmatter, keyRange, listOf, removeKey, splitFrontmatter } from "./frontmatter.ts";
import { isWithin, projectRulesOf, projectWalk } from "./items.ts";
import { readAdmittedFile } from "./walk.ts";
import { isHomeOrAbove } from "./walk.ts";
import { RunHomeError } from "./errors.ts";
import { InstructionBudgetFailure, InstructionReadBudget, instructionLimits, type InstructionSnapshotLimits, type InstructionReadChunk } from "./instruction-budget.ts";
export type { InstructionSnapshotLimits, InstructionReadChunk } from "./instruction-budget.ts";

const PRIVATE_FILE = 0o600;
/** claude's own import depth cap. */
export const MAX_IMPORT_DEPTH = 5;
/** Inserted after the `@` of every leftover import token. */
const ZERO_WIDTH_SPACE = "\u200b";

/** Guidance inputs only; executable run-home configuration is deliberately absent. */
export type InstructionSnapshotInput = Pick<RunHomeInput, "home" | "cwd" | "brand" | "trustedProjectRoot" | "plainInstructions">;

export interface InstructionSnapshot {
  /** Current rendered UTF-8 guidance, with unresolved imports neutralized. */
  text: string;
  /** SHA-256 of text, not authorization or a globally atomic filesystem revision. */
  digest: string;
  /** Local read provenance, including imports; redact paths before remote projection. */
  files: NonNullable<RunHomeReport["instructionFiles"]>;
  skippedLinks: RunHomeReport["skippedLinks"];
  droppedImports: string[];
}

/** The structured API can omit the ordinary personal tier BEFORE any content read. */
export type StructuredInstructionSnapshotInput = InstructionSnapshotInput & { tiers?: "all" | "admitted-only"; limits?: InstructionSnapshotLimits };
export interface InstructionSnapshotBlock {
  requestedPath: string;
  admittedPath: string;
  /** Expanded, import-neutralized body including the legacy trailing-newline rule. */
  text: string;
  /** SHA-256 of decoded UTF-8 text, not the original file bytes. */
  textSha256: string;
  tier: "user" | "workspace" | "project" | "local";
}
export interface InstructionSnapshotProvenance extends InstructionSnapshotBlock {
  /** Decoded source text before expansion, neutralization or trailing-newline rendering. */
  text: string;
  /** Top-level = 0, direct import = 1; at most MAX_IMPORT_DEPTH. */
  depth: number;
  /** Requested containing identity, which governs lexical relative import resolution. */
  importerPath?: string;
  /** Actual admitted containing identity, carried separately without changing resolution. */
  importerAdmittedPath?: string;
}
export interface StructuredInstructionSnapshot extends Pick<InstructionSnapshot, "text" | "digest"> {
  readonly tiers: "all" | "admitted-only";
  readonly files: readonly Readonly<InstructionSnapshot["files"][number]>[];
  readonly skippedLinks: readonly Readonly<InstructionSnapshot["skippedLinks"][number]>[];
  readonly droppedImports: readonly string[];
  readonly blocks: readonly Readonly<InstructionSnapshotBlock>[];
  readonly provenance: readonly Readonly<InstructionSnapshotProvenance>[];
}
interface SnapshotRecorder {
  blocks: InstructionSnapshotBlock[];
  provenance: InstructionSnapshotProvenance[];
}
interface ImportReadRecord {
  requestedPath: string; admittedPath: string; text: string;
  importerPath: string; importerAdmittedPath: string; depth: number;
}
interface ImportRecorder {
  beforeRead?: (path: string) => void;
  onImport?: (record: ImportReadRecord) => void;
  rootAdmittedPath?: string;
  budget?: InstructionReadBudget;
}

/** Test-only read-race/home-boundary knobs; no file-access authorization hook. */
export interface InstructionSnapshotInternals {
  userHome?: string;
  beforeRepositoryRead?: (real: string) => void;
  /** Test-only observation before a top-level/import content read; never authorization. */
  beforeInstructionRead?: (path: string) => void;
  /** Test-only byte counts; no descriptor or filesystem authority is exposed. */
  onInstructionReadChunk?: (chunk: Readonly<InstructionReadChunk>) => void;
}

/**
 * An import token: `@` at the start of a line or after whitespace, then a path with `\ ` as an escaped
 * space. `me@example.com` is not one (the `@` follows a letter).
 */
const IMPORT_TOKEN = /(^|\s)@((?:[^\s\\]|\\ )+)/g;

export interface ExpandImportsInput {
  content: string;
  filePath: string;
  tier: "user" | "workspace" | "project" | "local";
  /** The trusted project root — the boundary a project or local file's imports may not leave. */
  projectRoot: string | null;
  maxDepth?: number;
  /** Local provenance for the bytes actually expanded. Not a file-access authorization hook. */
  onRead?: (path: string, text: string) => void;
}

export interface ExpandImportsResult {
  content: string;
  /** Absolute paths a project/local file named outside the project root, in encounter order. */
  dropped: string[];
}

/** A token's path, or `undefined` when it does not look like one (claude's own shape test). */
function importPathOf(raw: string, fromFile: string): string | undefined {
  let path = raw.replace(/\\ /g, " ");
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  if (path.length === 0 || path.startsWith("@")) return undefined;
  if (!(path.startsWith("./") || path.startsWith("~/") || path.startsWith("/") || /^[A-Za-z0-9._-]/.test(path))) return undefined;
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(dirname(fromFile), path);
}

/** The segments of a line that are NOT inside an inline code span, with their offsets. */
function outsideCodeSpans(line: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let index = 0;
  let segmentStart = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    let run = 0;
    while (line[index + run] === "`") run += 1;
    const fence = "`".repeat(run);
    const close = line.indexOf(fence, index + run);
    if (close < 0) {
      index += run;
      continue;
    }
    out.push({ start: segmentStart, text: line.slice(segmentStart, index) });
    index = close + run;
    segmentStart = index;
  }
  out.push({ start: segmentStart, text: line.slice(segmentStart) });
  return out;
}

function joinText(parts: readonly string[], separator: string, budget?: InstructionReadBudget): string {
  return budget === undefined ? parts.join(separator) : budget.join(parts, separator);
}
function textParts(separator: string, budget?: InstructionReadBudget) {
  const parts: string[] = []; let size = 0;
  return {
    append(piece: string) {
      size += Buffer.byteLength(piece, "utf8") + (parts.length === 0 ? 0 : Buffer.byteLength(separator, "utf8"));
      if (budget !== undefined && size > budget.limits.maxExpandedBytes) throw new InstructionBudgetFailure();
      parts.push(piece);
    },
    result: () => joinText(parts, separator, budget),
  };
}
function replaceText(content: string, pattern: RegExp, replace: (match: RegExpMatchArray) => string, budget?: InstructionReadBudget): string {
  const output = textParts("", budget); let cursor = 0;
  for (const match of content.matchAll(pattern)) {
    output.append(content.slice(cursor, match.index)); output.append(replace(match)); cursor = match.index! + match[0].length;
  }
  output.append(content.slice(cursor)); return output.result();
}
/** Applies `fn` outside code; each segment/line is budgeted before retaining or joining it. */
function mapOutsideCode(content: string, fn: (text: string) => string, budget?: InstructionReadBudget): string {
  const output = textParts("\n", budget);
  let fence: string | undefined;
  for (const line of content.split("\n")) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence !== undefined) {
      if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      output.append(line); continue;
    }
    if (marker !== undefined) { fence = marker; output.append(line); continue; }
    const segments = outsideCodeSpans(line), rendered = textParts("", budget);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!, next = segments[i + 1];
      const tail = next === undefined ? "" : line.slice(segment.start + segment.text.length, next.start);
      rendered.append(fn(segment.text)); rendered.append(tail);
    }
    output.append(rendered.result());
  }
  return output.result();
}

/**
 * Expands `@path` imports with claude's tier rule (F17) — the same algorithm the Winter SDK's own
 * loader uses (the plan's L1a.4): relative to the containing file, `~/` is `$HOME`, code spans and
 * fenced blocks are skipped, depth is capped at 5, a user file follows anywhere, a project or local
 * file only inside `projectRoot`. An unresolved token (missing file, a directory, a cycle, the cap)
 * stays as literal text; a dropped one stays too, and is reported.
 */
export function expandImports(input: ExpandImportsInput): ExpandImportsResult {
  return expandImportsRecorded(input);
}

/** Private recording observes the same successful reads without changing the public onRead seam. */
function expandImportsRecorded(input: ExpandImportsInput, recorder?: ImportRecorder): ExpandImportsResult {
  const dropped: string[] = [];
  const maxDepth = input.maxDepth ?? MAX_IMPORT_DEPTH;
  const realRoot = input.projectRoot === null ? undefined : realOrSelf(input.projectRoot);
  const expand = (content: string, fromFile: string, fromAdmitted: string, depth: number, seen: ReadonlySet<string>): string =>
    mapOutsideCode(content, (text) =>
      replaceText(text, IMPORT_TOKEN, (match) => {
        const [whole, lead, raw] = match as unknown as [string, string, string];
        const target = importPathOf(raw, fromFile);
        if (target === undefined) return whole;
        if (depth >= maxDepth) return whole;
        const real = realOrUndefined(target);
        if (real === undefined || !isRegularFile(real) || seen.has(real)) return whole;
        if (input.tier !== "user" && (realRoot === undefined || !isWithin(real, realRoot))) {
          dropped.push(target);
          return whole;
        }
        let body: string;
        recorder?.beforeRead?.(real);
        if (input.tier !== "user") {
          // WS-24: a repository import is read under the same re-check as the file that holds it.
          const read = readAdmittedFile(real, realRoot as string, recorder?.budget);
          if ("refused" in read) {
            if (read.refused === "outside-root") dropped.push(target);
            return whole;
          }
          body = read.text;
        } else {
          try {
            body = recorder?.budget === undefined ? readFileSync(real, "utf8") : boundedUserText(real, recorder.budget);
          } catch (error) {
            if (error instanceof InstructionBudgetFailure) throw error;
            return whole;
          }
        }
        input.onRead?.(real, body);
        recorder?.onImport?.({ requestedPath: target, admittedPath: real, text: body, importerPath: fromFile, importerAdmittedPath: fromAdmitted, depth: depth + 1 });
        return joinText([lead, expand(body, target, real, depth + 1, new Set([...seen, real]))], "", recorder?.budget);
      }, recorder?.budget),
      recorder?.budget,
    );
  const self = realOrUndefined(input.filePath);
  return { content: expand(input.content, input.filePath, recorder?.rootAdmittedPath ?? self ?? input.filePath, 0, new Set(self === undefined ? [] : [self])), dropped };
}

/**
 * Every `@` the pinned runtime's lexer could read as the start of an import: one NOT preceded by an ASCII
 * letter or digit, and followed by a character an import path can BEGIN with — the import paths claude
 * accepts start (as the SDK's `isValidImportPath` does) with `./`, `~/`, `/`, or one of [A-Za-z0-9._-]. Any
 * other next character (a quote, `@`, `[`, `(`, `#`, whitespace, an inserted zero-width space) can never
 * begin an import, so `"$@"`, `@@ -1 +1 @@` and `${a[@]}` are left as written (R.3 touch).
 */
const NEUTRALISABLE_AT = /(?<![A-Za-z0-9])@(?=[A-Za-z0-9._~\/-])/g;

/**
 * Neutralises every `@` that could begin an import, ANYWHERE in the text: `@x` becomes `@<ZWSP>x`, which
 * no import grammar accepts (the path would start with the zero-width space) and a reader does not see.
 * Only an `@` followed by a possible first character of an import path is touched (see `NEUTRALISABLE_AT`).
 *
 * CODE-BLIND, ON PURPOSE (R.3, C1 ii). claude skips imports only inside what a markdown lexer (marked,
 * `gfm: false`) calls a code block or a code span, and reads an import at an `@` that starts a run of
 * TEXT or follows whitespace in it. Any per-line guess at "this is code" that disagrees with that lexer
 * leaves a token raw that claude then follows (MEASURED with marked 18.0.6): a backtick fence whose info
 * string holds a backtick (not a fence), a tab-led fence (an indented line), mismatched backtick runs (not a code span). And a text
 * token can START with `@` after an inline token closes — `>@x`, `**x**@x`, `a<b>@x`, `<!-- c -->@x`,
 * `\*@x` — where the source has no whitespace before the `@` at all. So the test is not the import regex
 * but the character before the `@`: a token boundary never falls between an ASCII letter/digit and an `@`
 * (marked's text tokens end only before markup or after a non-local-part character), which is why an
 * e-mail address (`me@example.com`) is left as written. A fuzz of an import extractor built to that
 * description, over generated markdown strings, found 837 per 100k importing after a whitespace-only neutraliser and none after this one
 * (1.1M strings with the first rule; the narrowed next-character rule re-fuzzed, lane-L2 report "R.3 touch").
 * Inside a real code block the inserted character is invisible too.
 */
export function escapeImportTokens(content: string): string {
  return escapeImportTokensBounded(content);
}
function escapeImportTokensBounded(content: string, budget?: InstructionReadBudget): string {
  return replaceText(content, NEUTRALISABLE_AT, () => `@${ZERO_WIDTH_SPACE}`, budget);
}
function boundedUserText(path: string, budget: InstructionReadBudget): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) throw new Error("instruction file unavailable"); return budget.read(fd); }
  finally { closeSync(fd); }
}

function realOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function realOrSelf(path: string): string {
  return realOrUndefined(path) ?? resolve(path);
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realDirectory(path: string): string | undefined {
  const real = realOrUndefined(path);
  try { return real !== undefined && statSync(real).isDirectory() ? real : undefined; }
  catch { return undefined; }
}

/** A regular file's text, or `undefined` when there is none (missing, a directory, unreadable). */
async function textOf(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The instructions file's local variant: `<stem>.md` → `<stem>.local.md`. */
function localVariantOf(instructionsFile: string): string {
  return instructionsFile.endsWith(".md") ? `${instructionsFile.slice(0, -3)}.local.md` : `${instructionsFile}.local`;
}

/**
 * Loads current guidance only. No run home, cache or store is created; settings,
 * MCP configuration, items and hooks are not discovered. Every call re-reads the
 * same files/imports the run-home builder consumes, with the same ordering and
 * admitted-file checks. Filesystem/host revision and guest admission remain the
 * caller's separate responsibilities.
 */
export async function loadInstructionSnapshot(input: InstructionSnapshotInput, internals: InstructionSnapshotInternals = {}): Promise<InstructionSnapshot> {
  return readInstructionSnapshot(input, internals, "all");
}

/** One current guidance walk, with structured data recorded during those same reads/expansions.
 * No reader/RPC authority, personal scope admission, memory or run-home creation is added. */
export async function loadStructuredInstructionSnapshot(input: StructuredInstructionSnapshotInput, internals: InstructionSnapshotInternals = {}): Promise<Readonly<StructuredInstructionSnapshot>> {
  const tiers = input.tiers ?? "all";
  if (tiers !== "all" && tiers !== "admitted-only") throw new TypeError("invalid instruction snapshot tiers");
  const recorder: SnapshotRecorder = { blocks: [], provenance: [] };
  const budget = input.limits === undefined ? undefined : new InstructionReadBudget(instructionLimits(input.limits), internals.onInstructionReadChunk);
  let snapshot: InstructionSnapshot;
  try { snapshot = await readInstructionSnapshot(input, internals, tiers, recorder, budget); }
  catch (error) { if (error instanceof InstructionBudgetFailure) throw new RunHomeError("run_home_instruction_over_bound", "structured instruction snapshot exceeded its configured limits"); throw error; }
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  return freeze({ ...snapshot, tiers, blocks: recorder.blocks, provenance: recorder.provenance });
}

async function readInstructionSnapshot(input: InstructionSnapshotInput, internals: InstructionSnapshotInternals, tiers: "all" | "admitted-only", recorder?: SnapshotRecorder, budget?: InstructionReadBudget): Promise<InstructionSnapshot> {
  for (const value of [input.home, input.cwd]) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new TypeError("instruction snapshot home/cwd must be absolute paths");
  }
  if (input.trustedProjectRoot !== null && (typeof input.trustedProjectRoot !== "string" || !isAbsolute(input.trustedProjectRoot) || input.trustedProjectRoot.includes("\0"))) throw new TypeError("instruction snapshot trustedProjectRoot must be an absolute path or null");
  const brand = runHomeBrandOf(input), sdkHome = sdkHomeOf(input.home), userHome = internals.userHome ?? homedir();
  const files: InstructionSnapshot["files"] = [], skippedLinks: InstructionSnapshot["skippedLinks"] = [], droppedImports: string[] = [];
  const plain = input.plainInstructions;
  const sourceRoot = plain === undefined ? input.trustedProjectRoot : plain?.projectRoot;
  let walkRoot = sourceRoot, walkCwd = input.cwd;
  const instructionRefusal = () => new RunHomeError("run_home_instruction_refused", "the host-admitted plain instruction scope or required shared file is unavailable");
  if (plain !== undefined) {
    if (!plain || (sourceRoot !== null && (typeof sourceRoot !== "string" || !isAbsolute(sourceRoot) || sourceRoot.includes("\0")))) throw instructionRefusal();
    if (sourceRoot !== null) {
      const realRoot = realDirectory(sourceRoot!), realCwd = realDirectory(input.cwd);
      if (!realRoot || !realCwd || isHomeOrAbove(realRoot, userHome) || !isWithin(realCwd, realRoot)) throw instructionRefusal();
      walkRoot = realRoot; walkCwd = realCwd;
    }
  }
  const sources: Array<{ path: string; tier: "user" | "workspace" | "project" | "local"; root: string | null; required?: boolean }> = tiers === "all" ? [{ path: join(sdkHome, brand.instructionsFile), tier: "user", root: null }] : [];
  if (plain?.workspace !== undefined) {
    const shared = plain.workspace;
    if (!shared || typeof shared.path !== "string" || typeof shared.root !== "string" || !isAbsolute(shared.path) || !isAbsolute(shared.root) || shared.path.includes("\0") || shared.root.includes("\0") || !isWithin(resolve(shared.path), resolve(shared.root))) throw instructionRefusal();
    const realRoot = realDirectory(shared.root);
    if (!realRoot || isHomeOrAbove(realRoot, userHome)) throw instructionRefusal();
    sources.push({ path: shared.path, tier: "workspace", root: realRoot, required: true });
  }
  if (walkRoot !== null) {
    for (const walkDir of [...projectWalk(walkCwd, walkRoot!, userHome)].reverse()) {
      sources.push({ path: join(walkDir, brand.instructionsFile), tier: "project", root: walkRoot! });
      sources.push({ path: join(walkDir, brand.projectDirName, brand.instructionsFile), tier: "project", root: walkRoot! });
      sources.push({ path: join(walkDir, localVariantOf(brand.instructionsFile)), tier: "local", root: walkRoot! });
    }
  }
  const blocks: string[] = [];
  for (const source of sources) {
    // A project file is read by its REAL path, and only when that stays inside the root — the same
    // boundary the items obey (an instructions file that is a link out of the repository is not the project's).
    // WS-24: and the READ is of that admitted real path, re-checked at the read (`readAdmittedFile`).
    let text: string | undefined, admittedPath = source.path;
    if (source.tier !== "user") {
      const real = realOrUndefined(source.path);
      if (real === undefined) { if (source.required) throw instructionRefusal(); continue; }
      const realRoot = realOrSelf(source.root as string);
      if (!isWithin(real, realRoot)) {
        skippedLinks.push({ path: source.path, reason: "outside-root" });
        if (source.required) throw instructionRefusal();
        continue;
      }
      internals.beforeRepositoryRead?.(real);
      internals.beforeInstructionRead?.(real);
      const read = readAdmittedFile(real, realRoot, budget);
      if ("refused" in read) {
        if (read.refused === "outside-root") skippedLinks.push({ path: source.path, reason: "outside-root" });
        if (source.required) throw instructionRefusal();
        continue;
      }
      text = read.text;
      admittedPath = real;
    } else {
      internals.beforeInstructionRead?.(source.path);
      if (budget === undefined) text = await textOf(source.path);
      else { try { text = boundedUserText(source.path, budget); } catch (error) { if (error instanceof InstructionBudgetFailure) throw error; text = undefined; } }
      admittedPath = realOrUndefined(source.path) ?? source.path;
    }
    if (text === undefined) continue;
    const record = (path: string, bytes: string, imported: boolean) => files.push({ path, ...(!imported && path !== source.path ? { requestedPath: source.path } : {}), tier: source.tier, sha256: createHash("sha256").update(bytes, "utf8").digest("hex"), imported });
    record(admittedPath, text, false);
    recorder?.provenance.push({ requestedPath: source.path, admittedPath, text, textSha256: createHash("sha256").update(text, "utf8").digest("hex"), tier: source.tier, depth: 0 });
    const expanded = expandImportsRecorded({ content: text, filePath: source.path, tier: source.tier, projectRoot: source.root, onRead: (path, bytes) => record(path, bytes, true) }, {
      rootAdmittedPath: admittedPath,
      ...(budget !== undefined ? { budget } : {}),
      ...(internals.beforeInstructionRead !== undefined ? { beforeRead: internals.beforeInstructionRead } : {}),
      ...(recorder !== undefined ? { onImport: (read: ImportReadRecord) => recorder.provenance.push({ ...read, textSha256: createHash("sha256").update(read.text, "utf8").digest("hex"), tier: source.tier }) } : {}),
    });
    droppedImports.push(...expanded.dropped);
    const body = escapeImportTokensBounded(expanded.content, budget);
    const renderedBody = body.endsWith("\n") ? body : joinText([body, "\n"], "", budget);
    recorder?.blocks.push({ requestedPath: source.path, admittedPath, text: renderedBody, textSha256: createHash("sha256").update(renderedBody, "utf8").digest("hex"), tier: source.tier });
    const rendered = joinText(["# ", source.path, "\n\n", renderedBody], "", budget);
    budget?.addRendered(rendered, blocks.length === 0 ? "" : "\n"); blocks.push(rendered);
  }
  const text = joinText(blocks, "\n", budget);
  return { text, digest: createHash("sha256").update(text, "utf8").digest("hex"), files, skippedLinks, droppedImports };
}

/** Materialization and rule rewriting belong only to run-home construction. */
export async function buildInstructions(context: RunHomeBuildContext): Promise<void> {
  const { input, brand, dir, report } = context;
  const snapshot = await loadInstructionSnapshot(input, { userHome: context.userHome, ...context.internals });
  (report.instructionFiles ??= []).push(...snapshot.files);
  report.skippedLinks.push(...snapshot.skippedLinks);
  report.droppedImports.push(...snapshot.droppedImports);
  await writeFile(join(dir, brand.instructionsFile), snapshot.text, { mode: PRIVATE_FILE, flag: "wx" });
  // RELATIVE, so the link means the same thing wherever the folder is seen from — including through a
  // resume staging root that links to this file (spec §3.6).
  await symlink(`./${brand.instructionsFile}`, join(dir, "CLAUDE.md"));
  await rewriteProjectRules(context);
}

/** One segment of a glob against one literal path segment. */
function segmentMatches(pattern: string, segment: string): boolean {
  if (!/[*?[{]/.test(pattern)) return pattern === segment;
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close < 0) source += "\\[";
      else {
        source += `[${pattern.slice(i + 1, close).replace(/^!/, "^")}]`;
        i = close;
      }
    } else if (ch === "{") {
      const close = pattern.indexOf("}", i + 1);
      if (close < 0) source += "\\{";
      else {
        source += `(?:${pattern
          .slice(i + 1, close)
          .split(",")
          .map((alt) => alt.replace(/[.+^${}()|\\]/g, "\\$&"))
          .join("|")})`;
        i = close;
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(segment);
}

/**
 * Re-expresses one glob, written relative to `anchor`, relative to the cwd `anchor/<rel>`. Returns the
 * rewritten glob, or `undefined` when it can only match outside the cwd's subtree.
 */
export function rebaseGlob(glob: string, relSegments: readonly string[]): string | undefined {
  const segments = glob.replace(/^\.\//, "").split("/").filter((segment) => segment.length > 0);
  let i = 0;
  for (; i < relSegments.length; i += 1) {
    const pattern = segments[i];
    if (pattern === undefined) return undefined; // the glob names an ANCESTOR of the cwd, never a file under it
    if (pattern === "**") return segments.slice(i).join("/"); // any depth: it reaches under the cwd as written
    if (!segmentMatches(pattern, relSegments[i]!)) return undefined;
  }
  const rest = segments.slice(i);
  return rest.length === 0 ? "**" : rest.join("/");
}

/**
 * The project rules `buildItems` linked, settled for the USER tier they are read at in the run folder.
 * EVERY one is replaced by a COPY (0600) — the build is a SNAPSHOT (R.3 touch): a link would let a later
 * edit in the repository (an approved Write adding `@~/…`, say) reach the run home unsettled, read at the
 * user tier. A rule that can no longer be read is removed and reported (`skippedLinks`, `missing`).
 *
 * THE COPY READS EXACTLY WHAT DISCOVERY ADMITTED (WS-24): the rule's real path, re-checked at the read
 * (`readAdmittedFile` — no link followed, still in the root, still the same file). A rule whose path no
 * longer names that in-root file is removed and reported (`skippedLinks`, `outside-root`).
 *
 *   1. `paths:` re-expressed from the cwd (a rule anchored AT the cwd reads the same at the user tier).
 *   2. IMPORTS (R.3, C1 i). At the user tier both runtimes follow a rule's `@imports` ANYWHERE (claude's
 *      `includeExternal` for the user tier; the Winter SDK expands a rule under its own tier), so a
 *      trusted repository's rule could pull any file on the machine into every mode's context — and a
 *      relative token would resolve against `<run>/rules`. So the rule gets the instructions treatment:
 *      its BODY is expanded under the PROJECT rule (relative to the rule's own path, inside the root
 *      only; the rest dropped and reported in `droppedImports`), then every leftover `@` is neutralised.
 *      The body is the pinned runtime's own split (`claudeFrontmatterSplit`) — what both runtimes scan —
 *      and the frontmatter block before it is left as written.
 */
async function rewriteProjectRules(context: RunHomeBuildContext): Promise<void> {
  const { input, dir, report } = context;
  const cwd = resolve(input.cwd);
  const realRoot = input.trustedProjectRoot === null ? undefined : realOrSelf(input.trustedProjectRoot);
  for (const link of projectRulesOf(context)) {
    const destination = join(dir, "rules", link.name);
    context.internals.beforeRepositoryRead?.(link.real);
    const read = realRoot === undefined ? ({ refused: "outside-root" } as const) : readAdmittedFile(link.real, realRoot);
    if ("refused" in read) {
      await rm(destination, { force: true });
      report.skippedLinks.push({ path: link.path, reason: read.refused });
      continue;
    }
    const text = read.text;
    let next = text;
    const rel = relative(link.anchor, cwd);
    const doc = rel === "" ? undefined : splitFrontmatter(text);
    const globs = doc === undefined ? undefined : listOf(doc.lines, "paths");
    if (doc !== undefined && globs !== undefined) {
      const relSegments = rel.split(sep);
      const rebased = globs.map((glob) => rebaseGlob(glob, relSegments)).filter((glob): glob is string => glob !== undefined);
      if (rebased.length === 0) {
        removeKey(doc.lines, "paths");
        report.unconditionalRules.push(link.path);
      } else {
        const range = keyRange(doc.lines, "paths") as [number, number];
        doc.lines.splice(range[0], range[1] - range[0], "paths:", ...rebased.map((glob) => `  - ${JSON.stringify(glob)}`));
      }
      next = joinFrontmatter(doc);
    }
    if (next.includes("@")) {
      const { head, body } = claudeFrontmatterSplit(next);
      const expanded = expandImports({ content: body, filePath: link.path, tier: "project", projectRoot: input.trustedProjectRoot });
      report.droppedImports.push(...expanded.dropped);
      next = `${head}${escapeImportTokens(expanded.content)}`;
    }
    await rm(destination, { force: true });
    await writeFile(destination, next, { mode: PRIVATE_FILE, flag: "wx" });
  }
}
