// WS-21 §3.3, §3.4.1-2: THE ITEMS — skills, commands, output styles, rules and agents, each settled
// ONCE, at build time, by the official runtime's own clash rules (spec F8, measured on the pinned
// runtime), so both runtimes see one already-decided set rather than each applying its own rules to
// the raw tiers.
//
//   skills     user, then self (`sdk/skills/self/*`), then project, nearest project dir first — the
//              first name wins; identity is the DIRECTORY name.
//   commands   user, then project, nearest first — and any skill beats any command of the same name.
//   styles     the USER's style and a built-in beat a project style of the same name, case-folded (WS-24 —
//              a repository never redefines the style; claude lets the project win); among project dirs
//              the FARTHEST wins; a project style is a COPY with `keep-coding-instructions: true` (WS-24).
//   agents     project beats user; COPIED, never linked, with `permissionMode` removed and a
//              `memory: project|local` scope rewritten to `memory: user` (F19c — a project-scoped agent
//              memory would write into the repository's vendor dir).
//   rules      no clash: every file is linked; a project file gets a path-derived unique name, and the
//              instructions step then replaces every project link with a settled COPY (its `paths:` and
//              imports settled there — R.3 C1 i; a snapshot, never a link — R.3 touch). User rules stay links.
//
// THE PROJECT WALK (§3.4.2) runs from the cwd up to the trusted root, stopping at `$HOME` (the user's
// home is never a project directory — its dot-dir is the daemon's). No trusted root, no walk.
//
// LINK RULES (§3.4.6). A user-tier item whose real path leaves `sdk/` is linked as-is and reported
// (`externalUserLinks`) — the user put it there. A project-tier item whose real path leaves the
// project root is SKIPPED and reported (`outside-root`), however it got there: a link item, a linked
// kind directory, or a project dot-dir that is itself a link. A project item inside the root is linked
// by its REAL path, so re-pointing a link in the repository after the build changes nothing.
import { lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RunHomeBuildContext } from "./build.ts";
import { parseClaudeFrontmatter, serializeClaudeFrontmatter } from "./claude-frontmatter.ts";

type Tier = "user" | "self" | "project";

/** One candidate item: where it came from, what it is called, and what the run folder points at. */
interface Candidate {
  name: string;
  /** The path as found in its tier directory. Reports name this. */
  path: string;
  /** What the run folder links to (or copies from). */
  target: string;
  tier: Tier;
  /** For project items: the walk directory it came from. */
  from?: string;
}

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

// The walk and the containment test live in `walk.ts` (shared with the instructions and settings builders).
export { isWithin, projectWalk } from "./walk.ts";
import { isWithin, projectWalk, readAdmittedFile } from "./walk.ts";

/** Real path, or `undefined` when the path (or a link on it) leads nowhere. */
async function realOrMissing(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ENOTDIR" || (error as { code?: unknown }).code === "ELOOP") return undefined;
    throw error;
  }
}

async function entriesOf(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/** What an item must be: a skill is a directory, everything else a markdown file. */
type Shape = "dir" | "markdown";

interface ResolveScope {
  context: RunHomeBuildContext;
  /** Real path of `sdk/` — the user tier's boundary. */
  realSdk: string;
  /** Real path of the trusted root — the project tier's boundary. */
  realRoot: string | undefined;
}

/**
 * Resolves one candidate path under its tier's link rule. Returns the link target, or `undefined`
 * (reported) when the item is skipped. Never follows a link to BUILD anything — `realpath` is read
 * only to decide, and a project item is then linked by that real path.
 */
async function resolveCandidate(scope: ResolveScope, tier: Tier, path: string, shape: Shape): Promise<string | undefined> {
  const { report } = scope.context;
  const real = await realOrMissing(path);
  if (real === undefined) {
    report.skippedLinks.push({ path, reason: "missing" });
    return undefined;
  }
  let target = path;
  if (tier === "project") {
    if (scope.realRoot === undefined || !isWithin(real, scope.realRoot)) {
      report.skippedLinks.push({ path, reason: "outside-root" });
      return undefined;
    }
    target = real;
  } else if (!isWithin(real, scope.realSdk)) {
    report.externalUserLinks.push(path);
  }
  const info = await stat(real);
  if (shape === "dir" ? !info.isDirectory() : !(info.isFile() && extname(path) === ".md")) return undefined;
  return target;
}

/** Top-level candidates of one tier directory. */
async function candidatesIn(scope: ResolveScope, dir: string, tier: Tier, shape: Shape, options: { skip?: readonly string[]; from?: string } = {}): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const entry of await entriesOf(dir)) {
    if (options.skip?.includes(entry)) continue;
    if (shape === "markdown" && extname(entry) !== ".md") continue;
    const path = join(dir, entry);
    const target = await resolveCandidate(scope, tier, path, shape);
    if (target === undefined) continue;
    const name = shape === "dir" ? entry : basename(entry, ".md");
    out.push({ name, path, target, tier, ...(options.from === undefined ? {} : { from: options.from }) });
  }
  return out;
}

/** Every markdown file under `dir`, recursively, as paths relative to it. Linked directories are not descended. */
async function markdownTree(dir: string, prefix = "", depth = 0): Promise<string[]> {
  if (depth > 16) return [];
  const out: string[] = [];
  for (const entry of await entriesOf(dir)) {
    const rel = prefix.length === 0 ? entry : join(prefix, entry);
    const full = join(dir, entry);
    let isRealDir = false;
    try {
      const info = await lstat(full);
      isRealDir = info.isDirectory() && !info.isSymbolicLink();
    } catch {
      continue;
    }
    if (isRealDir) out.push(...(await markdownTree(full, rel, depth + 1)));
    else if (extname(entry) === ".md") out.push(rel);
  }
  return out;
}

/** First name wins, in the order given. */
function firstWins(ordered: readonly Candidate[]): Map<string, Candidate> {
  const winners = new Map<string, Candidate>();
  for (const candidate of ordered) if (!winners.has(candidate.name)) winners.set(candidate.name, candidate);
  return winners;
}

/** Last name wins, in the order given. */
function lastWins(ordered: readonly Candidate[]): Map<string, Candidate> {
  const winners = new Map<string, Candidate>();
  for (const candidate of ordered) winners.set(candidate.name, candidate);
  return winners;
}

async function linkAll(dir: string, winners: Map<string, Candidate>, fileName: (candidate: Candidate) => string): Promise<void> {
  await mkdir(dir, { mode: PRIVATE_DIR });
  for (const candidate of [...winners.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) await symlink(candidate.target, join(dir, fileName(candidate)));
}

/**
 * The run folder's item directories (spec §3.3), gated per mode (spec §3.2).
 *
 *   skills/, commands/   code only
 *   output-styles/       code only, and never for a dispatch child
 *   rules/               the user's in code only; the trusted project's in every mode
 *   agents/              every mode
 */
export async function buildItems(context: RunHomeBuildContext): Promise<void> {
  const { input, sdkHome, dir, brand } = context;
  const code = input.mode === "code";
  const walk = projectWalk(input.cwd, input.trustedProjectRoot, context.userHome);
  const scope: ResolveScope = {
    context,
    realSdk: (await realOrMissing(sdkHome)) ?? sdkHome,
    realRoot: input.trustedProjectRoot === null ? undefined : await realOrMissing(input.trustedProjectRoot),
  };
  const projectKindDir = (walkDir: string, kind: string): string => join(walkDir, brand.projectDirName, kind);

  // ---- skills (and the names that beat every command) -------------------------------------------
  const skillNames = new Set<string>();
  if (code) {
    const ordered: Candidate[] = [
      ...(await candidatesIn(scope, join(sdkHome, "skills"), "user", "dir", { skip: ["self"] })),
      ...(await candidatesIn(scope, join(sdkHome, "skills", "self"), "self", "dir")),
    ];
    for (const walkDir of walk) ordered.push(...(await candidatesIn(scope, projectKindDir(walkDir, "skills"), "project", "dir", { from: walkDir })));
    const winners = firstWins(ordered);
    for (const name of winners.keys()) skillNames.add(name);
    await linkAll(join(dir, "skills"), winners, (candidate) => candidate.name);
  }

  // ---- commands ----------------------------------------------------------------------------------
  if (code) {
    const ordered: Candidate[] = [...(await candidatesIn(scope, join(sdkHome, "commands"), "user", "markdown"))];
    for (const walkDir of walk) ordered.push(...(await candidatesIn(scope, projectKindDir(walkDir, "commands"), "project", "markdown", { from: walkDir })));
    const winners = firstWins(ordered);
    for (const name of [...winners.keys()]) if (skillNames.has(name)) winners.delete(name);
    await linkAll(join(dir, "commands"), winners, (candidate) => `${candidate.name}.md`);
  }

  // ---- output styles: user, then project from NEAREST to FARTHEST (see `buildOutputStyles`) -------
  if (code && !input.dispatchChild) {
    const ordered: Candidate[] = [...(await candidatesIn(scope, join(sdkHome, "output-styles"), "user", "markdown"))];
    for (const walkDir of walk) ordered.push(...(await candidatesIn(scope, projectKindDir(walkDir, "output-styles"), "project", "markdown", { from: walkDir })));
    await buildOutputStyles(context, scope, ordered);
  }

  // ---- rules --------------------------------------------------------------------------------------
  await buildRules(context, scope, walk, code);

  // ---- agents: copies, project beats user ---------------------------------------------------------
  await buildAgents(context, scope, walk);
}

/**
 * The Winter runtime's built-in style names (agent SDK `packages/runtime/src/context/output-styles.ts`,
 * the built-in table). The runtime resolves a name from the run folder's `output-styles/<name>.md` BEFORE
 * its built-ins, so a file of one of these names there would redefine the built-in.
 */
export const WINTER_BUILTIN_OUTPUT_STYLE_NAMES: readonly string[] = ["default", "proactive", "explanatory", "learning"];

/**
 * WS-24: the output styles. A user style is linked (the user's own tier). A PROJECT style is a settled
 * COPY (0600), read as admitted (`readAdmittedFile`) and rewritten by `rewriteProjectOutputStyle`: in the
 * run folder every style is read at the USER tier, where a style may drop the base prompt's coding
 * instructions — which the Winter runtime refuses a project-tier style (it may add, never replace). The
 * copy is also a snapshot, like the project rules.
 *
 * A REPOSITORY NEVER PICKS, NOR REDEFINES, THE OUTPUT STYLE (WS-24 re-review). On a name collision the
 * user's own style and a built-in win, and the project style is skipped and reported (`droppedRules`,
 * `output style: <path>`). DIVERGENCE, deliberate: claude lets a project style beat the user's of the same
 * name. Names are compared case-insensitively, because the runtime opens `<name>.md` on a volume that may
 * fold case. Among project styles the FARTHEST project dir still wins (claude's own order), and a later
 * project style whose name folds to one already written is skipped the same way.
 *
 * A project style that cannot be read as admitted is skipped (`skippedLinks`); one whose frontmatter
 * cannot be rewritten provably is skipped and reported (`droppedRules`, `output style: <path>`).
 */
async function buildOutputStyles(context: RunHomeBuildContext, scope: ResolveScope, ordered: readonly Candidate[]): Promise<void> {
  const stylesDir = join(context.dir, "output-styles");
  await mkdir(stylesDir, { mode: PRIVATE_DIR });
  const drop = (candidate: Candidate, reason: string): void => {
    context.report.droppedRules.push({ rule: `output style: ${candidate.path}`, tier: "project", reason });
  };
  const byName = (a: Candidate, b: Candidate): number => (a.name < b.name ? -1 : 1);
  const taken = new Set(WINTER_BUILTIN_OUTPUT_STYLE_NAMES.map((name) => name.toLowerCase()));
  const userNames = new Set<string>();
  for (const candidate of [...lastWins(ordered.filter((c) => c.tier !== "project")).values()].sort(byName)) {
    if (userNames.has(candidate.name.toLowerCase())) continue; // one user dir; a case-folded twin cannot be written beside it
    userNames.add(candidate.name.toLowerCase());
    await symlink(candidate.target, join(stylesDir, `${candidate.name}.md`));
  }
  for (const name of userNames) taken.add(name);
  for (const candidate of [...lastWins(ordered.filter((c) => c.tier === "project")).values()].sort(byName)) {
    const folded = candidate.name.toLowerCase();
    if (taken.has(folded)) {
      drop(candidate, userNames.has(folded) ? "a repository never redefines the output style: the user's own style of this name wins" : "a repository never redefines the output style: this name is a built-in style's, or another project style's");
      continue;
    }
    context.internals.beforeRepositoryRead?.(candidate.target);
    const read = scope.realRoot === undefined ? ({ refused: "outside-root" } as const) : readAdmittedFile(candidate.target, scope.realRoot);
    if ("refused" in read) {
      context.report.skippedLinks.push({ path: candidate.path, reason: read.refused });
      continue;
    }
    const rewritten = rewriteProjectOutputStyle(read.text);
    if (!rewritten.ok) {
      drop(candidate, `a project output style is copied with \`keep-coding-instructions: true\`, and this one's frontmatter could not be rewritten provably (${rewritten.reason})`);
      continue;
    }
    taken.add(folded);
    await writeFile(join(stylesDir, `${candidate.name}.md`), rewritten.text, { mode: PRIVATE_FILE, flag: "wx" });
  }
}

/**
 * A PROJECT output style for the run folder, from the runtime's own parse of it: `keep-coding-instructions`
 * forced to `true` (a style with no frontmatter gets one holding just that — ABSENT means drop on the Winter
 * runtime), everything else as parsed. The same proved re-serialisation the agents use.
 */
export function rewriteProjectOutputStyle(text: string): { ok: true; text: string } | { ok: false; reason: "unparseable" | "no-yaml-parser" } {
  const parsed = parseClaudeFrontmatter(text);
  if (parsed === undefined) return { ok: false, reason: "no-yaml-parser" };
  if (parsed.matched && parsed.error !== undefined) return { ok: false, reason: "unparseable" };
  const serialized = serializeClaudeFrontmatter({ ...parsed.frontmatter, "keep-coding-instructions": true }, parsed.body);
  return serialized === undefined ? { ok: false, reason: "unparseable" } : { ok: true, text: serialized };
}

/** The project rules' linked names, so the instructions step can find the ones it must rewrite. */
export interface ProjectRuleLink {
  /** The file name in `<run>/rules/`. */
  name: string;
  /** The rule's path as found under the project's dot-dir (what a report names). */
  path: string;
  /** The rule's own real path. */
  real: string;
  /** The walk directory whose dot-dir holds it — the anchor its `paths:` resolve from (F17). */
  anchor: string;
}

const projectRuleLinks = new WeakMap<RunHomeBuildContext, ProjectRuleLink[]>();

/** The project rules `buildItems` linked for this build, in link order. */
export function projectRulesOf(context: RunHomeBuildContext): readonly ProjectRuleLink[] {
  return projectRuleLinks.get(context) ?? [];
}

async function buildRules(context: RunHomeBuildContext, scope: ResolveScope, walk: readonly string[], code: boolean): Promise<void> {
  const { sdkHome, dir, brand, input } = context;
  const rulesDir = join(dir, "rules");
  const links: ProjectRuleLink[] = [];
  let made = false;
  const ensure = async (): Promise<void> => {
    if (made) return;
    await mkdir(rulesDir, { mode: PRIVATE_DIR });
    made = true;
  };
  if (code) {
    const userRules = join(sdkHome, "rules");
    for (const rel of await markdownTree(userRules)) {
      const path = join(userRules, rel);
      const target = await resolveCandidate(scope, "user", path, "markdown");
      if (target === undefined) continue;
      await ensure();
      const destination = join(rulesDir, rel);
      await mkdir(dirname(destination), { recursive: true, mode: PRIVATE_DIR });
      await symlink(target, destination);
    }
  }
  if (input.trustedProjectRoot === null) {
    projectRuleLinks.set(context, links);
    return;
  }
  const root = resolve(input.trustedProjectRoot);
  // Farthest first, so a reader of the folder sees the root's rules before a nested directory's.
  for (const walkDir of [...walk].reverse()) {
    const projectRules = join(walkDir, brand.projectDirName, "rules");
    for (const rel of await markdownTree(projectRules)) {
      const path = join(projectRules, rel);
      const target = await resolveCandidate(scope, "project", path, "markdown");
      if (target === undefined) continue;
      await ensure();
      const base = `project--${relative(root, path).split(sep).join("--")}`;
      let name = base;
      for (let n = 2; await exists(join(rulesDir, name)); n += 1) name = `${base.slice(0, -3)}--${n}.md`;
      await symlink(target, join(rulesDir, name));
      links.push({ name, path, real: target, anchor: walkDir });
    }
  }
  projectRuleLinks.set(context, links);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** A file-system-safe agent file name from its identity. */
const agentFileName = (identity: string): string => `${identity.replace(/[^A-Za-z0-9._-]/g, "-")}.md`;

/** One agent candidate, already rewritten (or refused) from the runtime's own parse of it. */
interface AgentCandidate extends Candidate {
  /** The rewritten definition, or the reason it is skipped. */
  rewritten: { ok: true; text: string } | { ok: false; reason: "unparseable" | "no-yaml-parser" };
}

async function agentCandidates(scope: ResolveScope, dir: string, tier: Tier, from?: string): Promise<AgentCandidate[]> {
  const out: AgentCandidate[] = [];
  for (const rel of await markdownTree(dir)) {
    const path = join(dir, rel);
    const target = await resolveCandidate(scope, tier, path, "markdown");
    if (target === undefined) continue;
    let text: string;
    if (tier === "project") {
      // WS-24: a project definition is read as admitted — no link followed, still the in-root file.
      scope.context.internals.beforeRepositoryRead?.(target);
      const read = scope.realRoot === undefined ? ({ refused: "outside-root" } as const) : readAdmittedFile(target, scope.realRoot);
      if ("refused" in read) {
        scope.context.report.skippedLinks.push({ path, reason: read.refused });
        continue;
      }
      text = read.text;
    } else {
      text = await readFile(target, "utf8");
    }
    const parsed = parseClaudeFrontmatter(text);
    // IDENTITY FROM THE SAME PARSE THE RUNTIME USES: `name` when set (stringified, as the pin does),
    // else the file stem.
    const declared = parsed === undefined || parsed.frontmatter["name"] == null ? "" : String(parsed.frontmatter["name"]);
    const name = declared.length > 0 ? declared : basename(rel, ".md");
    out.push({ name, path, target, tier, rewritten: rewriteAgentDefinition(text), ...(from === undefined ? {} : { from }) });
  }
  return out;
}

/**
 * F19c: an agent's definition, rewritten for the run folder FROM THE RUNTIME'S OWN PARSE of it
 * (`claude-frontmatter.ts` — the runtime's frontmatter split, BOM strip, YAML parse and retry).
 *
 * `permissionMode` is removed (the daemon has always stripped it — an agent must not pick its own
 * approval policy), and a `memory` scope other than `user` is rewritten: `project`/`local` become
 * `user` (they would write `<projectRoot>/.claude/agent-memory[-local]/`, i.e. into the repository;
 * `user` writes the config dir's `agent-memory/`, the persistent set linked into `sdk/agent-memory`),
 * and any other value — which the runtime ignores — is dropped.
 *
 * A file WITH a frontmatter block is always re-serialised from the parsed object (so both runtimes read
 * one unambiguous block, whatever spelling the author used), and the result is proved to read back as
 * that object by the runtime's split, the strict split and the runtime's parse. A block the runtime
 * cannot parse, a result that does not prove out, or a process with no `Bun.YAML` is SKIPPED (reported):
 * a definition whose reading cannot be promised is not handed to either runtime. A file with no
 * frontmatter block is copied as-is — the runtime reads no keys from it.
 */
export function rewriteAgentDefinition(text: string): { ok: true; text: string } | { ok: false; reason: "unparseable" | "no-yaml-parser" } {
  const parsed = parseClaudeFrontmatter(text);
  if (parsed === undefined) return { ok: false, reason: "no-yaml-parser" };
  if (!parsed.matched) return { ok: true, text };
  if (parsed.error !== undefined) return { ok: false, reason: "unparseable" };
  const cleaned: Record<string, unknown> = { ...parsed.frontmatter };
  delete cleaned["permissionMode"];
  const memory = cleaned["memory"];
  if (memory === "project" || memory === "local") cleaned["memory"] = "user";
  else if (memory !== undefined && memory !== "user") delete cleaned["memory"];
  const serialized = serializeClaudeFrontmatter(cleaned, parsed.body);
  return serialized === undefined ? { ok: false, reason: "unparseable" } : { ok: true, text: serialized };
}

async function buildAgents(context: RunHomeBuildContext, scope: ResolveScope, walk: readonly string[]): Promise<void> {
  const { sdkHome, dir, brand } = context;
  const ordered: AgentCandidate[] = [...(await agentCandidates(scope, join(sdkHome, "agents"), "user"))];
  // Project beats user; among project dirs the NEAREST is listed last so it wins (claude's own
  // precedence gives no rule between two project dirs — a nested dir's definition is the more specific).
  for (const walkDir of [...walk].reverse()) ordered.push(...(await agentCandidates(scope, join(walkDir, brand.projectDirName, "agents"), "project", walkDir)));
  // A definition that cannot be rewritten is skipped BEFORE the clash is settled, so it can neither win
  // nor shadow a lower tier's valid definition of the same name.
  const usable: AgentCandidate[] = [];
  for (const candidate of ordered) {
    if (candidate.rewritten.ok) usable.push(candidate);
    else context.report.skippedAgents.push({ path: candidate.path, reason: candidate.rewritten.reason });
  }
  const winners = lastWins(usable) as Map<string, AgentCandidate>;
  const agentsDir = join(dir, "agents");
  await mkdir(agentsDir, { mode: PRIVATE_DIR });
  for (const candidate of [...winners.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!candidate.rewritten.ok) continue;
    const destination = join(agentsDir, agentFileName(candidate.name));
    await writeFile(destination, candidate.rewritten.text, { mode: PRIVATE_FILE, flag: "wx" });
  }
}
