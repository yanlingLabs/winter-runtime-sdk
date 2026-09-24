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
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RunHomeBuildContext } from "./build.ts";
import { claudeFrontmatterSplit } from "./claude-frontmatter.ts";
import { joinFrontmatter, keyRange, listOf, removeKey, splitFrontmatter } from "./frontmatter.ts";
import { isWithin, projectRulesOf, projectWalk } from "./items.ts";

const PRIVATE_FILE = 0o600;
/** claude's own import depth cap. */
export const MAX_IMPORT_DEPTH = 5;
/** Inserted after the `@` of every leftover import token. */
const ZERO_WIDTH_SPACE = "\u200b";

/**
 * An import token: `@` at the start of a line or after whitespace, then a path with `\ ` as an escaped
 * space. `me@example.com` is not one (the `@` follows a letter).
 */
const IMPORT_TOKEN = /(^|\s)@((?:[^\s\\]|\\ )+)/g;

export interface ExpandImportsInput {
  content: string;
  filePath: string;
  tier: "user" | "project" | "local";
  /** The trusted project root — the boundary a project or local file's imports may not leave. */
  projectRoot: string | null;
  maxDepth?: number;
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

/** Applies `fn` to every non-code segment of `content`, preserving fenced blocks and code spans. */
function mapOutsideCode(content: string, fn: (text: string) => string): string {
  const lines = content.split("\n");
  let fence: string | undefined;
  return lines
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      return outsideCodeSpans(line)
        .map((segment, i, all) => {
          const next = all[i + 1];
          const tail = next === undefined ? "" : line.slice(segment.start + segment.text.length, next.start);
          return fn(segment.text) + tail;
        })
        .join("");
    })
    .join("\n");
}

/**
 * Expands `@path` imports with claude's tier rule (F17) — the same algorithm the Winter SDK's own
 * loader uses (the plan's L1a.4): relative to the containing file, `~/` is `$HOME`, code spans and
 * fenced blocks are skipped, depth is capped at 5, a user file follows anywhere, a project or local
 * file only inside `projectRoot`. An unresolved token (missing file, a directory, a cycle, the cap)
 * stays as literal text; a dropped one stays too, and is reported.
 */
export function expandImports(input: ExpandImportsInput): ExpandImportsResult {
  const dropped: string[] = [];
  const maxDepth = input.maxDepth ?? MAX_IMPORT_DEPTH;
  const realRoot = input.projectRoot === null ? undefined : realOrSelf(input.projectRoot);
  const expand = (content: string, fromFile: string, depth: number, seen: ReadonlySet<string>): string =>
    mapOutsideCode(content, (text) =>
      text.replace(IMPORT_TOKEN, (whole, lead: string, raw: string) => {
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
        try {
          body = readFileSync(real, "utf8");
        } catch {
          return whole;
        }
        return lead + expand(body, target, depth + 1, new Set([...seen, real]));
      }),
    );
  const self = realOrUndefined(input.filePath);
  return { content: expand(input.content, input.filePath, 0, new Set(self === undefined ? [] : [self])), dropped };
}

/**
 * Every `@` the pinned runtime's lexer could read as the start of an import: one NOT preceded by an ASCII
 * letter or digit, and followed by a character an import path can BEGIN with — claude's own first-character
 * shape (`cYt`; the SDK's `isValidImportPath` is the same): `./`, `~/`, `/`, or one of [A-Za-z0-9._-]. Any
 * other next character (a quote, `@`, `[`, `(`, `#`, whitespace, an inserted zero-width space) can never
 * begin an import, so `"$@"`, `@@ -1 +1 @@` and `${a[@]}` are left as written (R.3 touch).
 */
const NEUTRALISABLE_AT = /(?<![A-Za-z0-9])@(?=[A-Za-z0-9._~\/-])/g;

/**
 * Neutralises every `@` that could begin an import, ANYWHERE in the text: `@x` becomes `@<ZWSP>x`, which
 * no import grammar accepts (the path would start with the zero-width space) and a reader does not see.
 * Only an `@` followed by a possible first character of an import path is touched (see `NEUTRALISABLE_AT`).
 *
 * CODE-BLIND, ON PURPOSE (R.3, C1 ii). claude 2.1.250 lexes a memory file with marked (`gfm: false`) and
 * skips only true `code`/`codespan` tokens, then matches `(?:^|\s)@…` against each TEXT TOKEN's own text.
 * Any per-line guess at "this is code" that disagrees with that lexer leaves a token raw that claude then
 * follows (MEASURED, marked 18.0.6 + claude's `cYt`): a backtick fence whose info string holds a backtick
 * (not a fence), a tab-led fence (an indented line), mismatched backtick runs (not a code span). And a text
 * token can START with `@` after an inline token closes — `>@x`, `**x**@x`, `a<b>@x`, `<!-- c -->@x`,
 * `\*@x` — where the source has no whitespace before the `@` at all. So the test is not the import regex
 * but the character before the `@`: a token boundary never falls between an ASCII letter/digit and an `@`
 * (marked's text tokens end only before markup or after a non-local-part character), which is why an
 * e-mail address (`me@example.com`) is left as written. A fuzz of claude's extractor over generated
 * markdown strings found 837 per 100k importing after a whitespace-only neutraliser and none after this one
 * (1.1M strings with the first rule; the narrowed next-character rule re-fuzzed, lane-L2 report "R.3 touch").
 * Inside a real code block the inserted character is invisible too.
 */
export function escapeImportTokens(content: string): string {
  return content.replace(NEUTRALISABLE_AT, `@${ZERO_WIDTH_SPACE}`);
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
 * Builds `<run>/<instructions file>` and the `CLAUDE.md` link, then rewrites the project rules whose
 * `paths:` need it. Every mode gets the user file; a trusted project's files reach every mode (spec
 * §3.2 — mode-blind, as today).
 */
export async function buildInstructions(context: RunHomeBuildContext): Promise<void> {
  const { input, brand, sdkHome, dir, report } = context;
  const sources: Array<{ path: string; tier: "user" | "project" | "local" }> = [{ path: join(sdkHome, brand.instructionsFile), tier: "user" }];
  if (input.trustedProjectRoot !== null) {
    for (const walkDir of [...projectWalk(input.cwd, input.trustedProjectRoot, context.userHome)].reverse()) {
      sources.push({ path: join(walkDir, brand.instructionsFile), tier: "project" });
      sources.push({ path: join(walkDir, brand.projectDirName, brand.instructionsFile), tier: "project" });
      sources.push({ path: join(walkDir, localVariantOf(brand.instructionsFile)), tier: "local" });
    }
  }
  const blocks: string[] = [];
  for (const source of sources) {
    // A project file is read by its REAL path, and only when that stays inside the root — the same
    // boundary the items obey (an instructions file that is a link out of the repository is not the project's).
    if (source.tier !== "user") {
      const real = realOrUndefined(source.path);
      if (real === undefined) continue;
      if (!isWithin(real, realOrSelf(input.trustedProjectRoot as string))) {
        report.skippedLinks.push({ path: source.path, reason: "outside-root" });
        continue;
      }
    }
    const text = await textOf(source.path);
    if (text === undefined) continue;
    const expanded = expandImports({ content: text, filePath: source.path, tier: source.tier, projectRoot: input.trustedProjectRoot });
    report.droppedImports.push(...expanded.dropped);
    const body = escapeImportTokens(expanded.content);
    blocks.push(`# ${source.path}\n\n${body.endsWith("\n") ? body : `${body}\n`}`);
  }
  await writeFile(join(dir, brand.instructionsFile), blocks.join("\n"), { mode: PRIVATE_FILE, flag: "wx" });
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
  for (const link of projectRulesOf(context)) {
    const destination = join(dir, "rules", link.name);
    const text = await textOf(link.real);
    if (text === undefined) {
      await rm(destination, { force: true });
      report.skippedLinks.push({ path: link.path, reason: "missing" });
      continue;
    }
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
