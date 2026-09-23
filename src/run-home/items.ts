// WS-21 §3.3, §3.4.1-2: THE ITEMS — skills, commands, output styles, rules and agents, each settled
// ONCE, at build time, by the official runtime's own clash rules (spec F8, measured on the pinned
// runtime), so both runtimes see one already-decided set rather than each applying its own rules to
// the raw tiers.
//
//   skills     user, then self (`sdk/skills/self/*`), then project, nearest project dir first — the
//              first name wins; identity is the DIRECTORY name.
//   commands   user, then project, nearest first — and any skill beats any command of the same name.
//   styles     project beats user, and the FARTHEST project dir wins.
//   agents     project beats user; COPIED, never linked, with `permissionMode` removed and a
//              `memory: project|local` scope rewritten to `memory: user` (F19c — a project-scoped agent
//              memory would write into the repository's vendor dir).
//   rules      no clash: every file is linked; a project file gets a path-derived unique name.
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
import { homedir } from "node:os";
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

/** Spec §3.4.2: cwd → trusted root, nearest first, never `$HOME` or above it. */
export function projectWalk(cwd: string, trustedProjectRoot: string | null, userHome: string): string[] {
  if (trustedProjectRoot === null) return [];
  const root = resolve(trustedProjectRoot);
  const start = resolve(cwd);
  if (!isWithin(start, root)) return [];
  const home = resolve(userHome);
  const walk: string[] = [];
  let current = start;
  for (;;) {
    if (current === home) break;
    walk.push(current);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return walk;
}

/** `path` is `root` or inside it — lexical, on already-resolved paths. */
export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

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
  const walk = projectWalk(input.cwd, input.trustedProjectRoot, homedir());
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

  // ---- output styles: user, then project from NEAREST to FARTHEST, last wins ---------------------
  if (code && !input.dispatchChild) {
    const ordered: Candidate[] = [...(await candidatesIn(scope, join(sdkHome, "output-styles"), "user", "markdown"))];
    for (const walkDir of walk) ordered.push(...(await candidatesIn(scope, projectKindDir(walkDir, "output-styles"), "project", "markdown", { from: walkDir })));
    await linkAll(join(dir, "output-styles"), lastWins(ordered), (candidate) => `${candidate.name}.md`);
  }

  // ---- rules --------------------------------------------------------------------------------------
  await buildRules(context, scope, walk, code);

  // ---- agents: copies, project beats user ---------------------------------------------------------
  await buildAgents(context, scope, walk);
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
    const text = await readFile(target, "utf8");
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
 * (`claude-frontmatter.ts` — the pin's split, BOM strip, YAML parse and fallback, step for step).
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
