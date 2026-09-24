// WS-21 CONTRACT A — THE RUN HOME, as the router builds it and the daemon consumes it.
//
// ONE SHARED RUNTIME HOME, TWO RUNTIMES. Both agent runtimes read `<home>/sdk` (claude's config-dir
// formats, Winter's names), and neither reads it DIRECTLY: before every generation the router builds a
// per-run folder, `<home>/cache/runs/<runId>`, holding exactly what this generation may see — the
// persistent set linked in, the clash-settled items, the generated instructions, the effective
// settings and the MCP config — and points the child at it (`CLAUDE_CONFIG_DIR` on the official leg,
// the brand's `HOME` variable on the Winter leg). The spec is WS-21 §3; this file is the part of it a
// host programs against.
//
// THE LIFECYCLE, IN ONE PARAGRAPH (spec §3.1, §3.8). The daemon awaits `buildRunHome` at the start of
// every incarnation and passes the result as `runtime.runHome` on whichever `query()` overload it
// calls. The router applies it synchronously and refuses (`run_home_required`) a generation that
// arrives without one when the router was created with `requireRunHome: true`. When the incarnation
// ends the router reconciles the official leg's working copy INSIDE its spawn-proxy hook, with its own
// store, and records the run home's outcome; the daemon disposes the folder only once
// `runHomeOutcome(runId)` says `safe`. A crash is recovered through `reconcileRootForRecovery(root)`.
//
// EVERY PRODUCT NAME HERE DERIVES FROM A BRAND. The instructions file, the project directory, the
// global config file and the product env variables are the brand's (`RunHomeInput.brand`, defaulting
// to the Winter SDK's own profile). Claude's names — `CLAUDE.md`, `.claude.json`, `file-history`,
// `CLAUDE_CODE_*` — are the official runtime's own and stay fixed (WS-01 §5).
import { join, isAbsolute } from "node:path";
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";


/** The session modes a run home is built for (spec §3.2's columns). */
export type RunMode = "code" | "dispatch" | "chat";

/** Which runtime the generation runs on. `projects/` differs by leg (spec §3.3). */
export type RunLeg = "winter" | "official";

/** The brand fields the builder spells names from. Absent = the Winter SDK's own profile. */
export type RunHomeBrand = Pick<BrandProfile, "homeDirName" | "projectDirName" | "instructionsFile" | "envPrefix" | "mcpServerName">;

export interface RunHomeInput {
  /** The daemon's home (`WINTER_HOME`). The shared runtime home is `sdkHomeOf(home)`. */
  home: string;
  mode: RunMode;
  /** A code-mode child of a dispatch session: its output style is skipped (spec §3.2). */
  dispatchChild: boolean;
  leg: RunLeg;
  /** The session's working directory. The router refuses to apply a run home to a different cwd. */
  cwd: string;
  /** `repoRootFor(cwd)` when the project is trusted, else `null` (no project tier at all). */
  trustedProjectRoot: string | null;
  /** The canonical git root — the local settings tier's anchor (F17). `null` outside a repository. */
  gitRoot: string | null;
  /** `mcp.disabled`: servers dropped from the generated `.winter.json`, and reported. */
  mcpDisabled: readonly string[];
  /** The daemon's capability-server names; a configured server under one is dropped and reported. */
  reservedMcpServerNames: readonly string[];
  /** The auto-memory directory for this incarnation (spec §3.7), pinned on both legs. */
  memoryDir: string;
  /**
   * WS-21 DECISION (L2): the brand the product names are spelled from. Optional, and absent means the
   * Winter SDK's own profile — a Winter daemon never passes it. It exists because the router spells
   * no product name literally (its brand gate), and the router refuses to apply a run home built for a
   * different brand than its own.
   */
  brand?: RunHomeBrand;
}

/** What the builder did not do, and why — surfaced by `winter doctor` (spec §8). */
export interface RunHomeReport {
  /** A project-tier item whose link target lies outside the project root, or a vanished target. */
  skippedLinks: { path: string; reason: "outside-root" | "missing" }[];
  /** A user-tier item linked although it points outside `sdk/` (linked as-is, spec §3.4.6). */
  externalUserLinks: string[];
  droppedMcpServers: { name: string; reason: "disabled" | "reserved-name" }[];
  /** Project rules whose `paths:` could not be expressed from the cwd, loaded unconditionally. */
  unconditionalRules: string[];
  /** `@imports` a project or local instructions file named outside the project root. */
  droppedImports: string[];
  /**
   * Agent definitions not copied (fix round 1, I1): the runtime's own parse of the frontmatter failed,
   * the rewrite could not be proved to read back as intended, or this process has no `Bun.YAML`.
   */
  skippedAgents: { path: string; reason: "unparseable" | "no-yaml-parser" }[];
  /** Re-anchored rules the builder dropped rather than widen (review minor: an ALLOW under an anchor holding `?`). */
  droppedRules: { rule: string; tier: "user" | "project" | "local"; reason: string }[];
}

export interface RunHome {
  /** A random UUID. The folder's name, and the key `runHomeOutcome` answers for. */
  runId: string;
  /** `<home>/cache/runs/<runId>` — 0700, files 0600. */
  dir: string;
  /** `sdkHomeOf(input.home)`. */
  sdkHome: string;
  input: RunHomeInput;
  /** Exactly what `<dir>/settings.json` holds. */
  effectiveSettings: Record<string, unknown>;
  report: RunHomeReport;
  /** `rm -rf <dir>`: links are removed, their targets untouched. The caller reconciles first. Idempotent. */
  dispose(): Promise<void>;
}

/** Bumped when a field a host reads changes meaning. */
export const RUN_HOME_CONTRACT_VERSION = 1;

/**
 * claude's persistent config-dir set (spec F18): pre-created in `sdk/` and symlinked into every run
 * folder, so what a runtime writes there outlives the folder. `projects/` is not in it — it differs by
 * leg — and neither is `plugins/`, which is reached through the plugin-cache variable.
 */
export const RUN_HOME_PERSISTENT_ENTRIES = ["file-history", "tasks", "teams", "agent-memory", "workflows"] as const;

/** `outcome` of a run home, by run id. `pending` = the incarnation is still running (or unknown). */
export type RunHomeOutcome = "safe" | "quarantined" | "pending";

/** The context the router's own cold-resume path hands the host when it needs a run home. */
export interface RunHomeForContext {
  /** The Winter session id of the session being resumed. */
  sessionId: string;
  leg: RunLeg;
  cwd: string;
  mode: RunMode;
}

/** Registered at router creation (`RuntimeSdkOptions.runHomeFor`). */
export type RunHomeFor = (ctx: RunHomeForContext) => Promise<RunHome>;

/** `join(home, "sdk")` — the one shared runtime home both runtimes read. */
export function sdkHomeOf(home: string): string {
  return join(home, "sdk");
}

/**
 * claude's ABSOLUTE permission-rule spelling: `/` followed by the absolute path, so `/Users/x` is
 * `//Users/x` (F17: `//x` is absolute, `/x` is relative to the rule's source, `~/x` is `$HOME`).
 *
 * The one helper every rule the router writes goes through (spec §7.2, r2 I8) — never string
 * concatenation at a call site. A relative path is refused: there is nothing to anchor it on.
 */
export function fsRootAnchored(absPath: string): string {
  if (typeof absPath !== "string" || absPath.length === 0 || !isAbsolute(absPath)) {
    throw new TypeError(`fsRootAnchored: ${JSON.stringify(absPath)} is not an absolute path, so it has no root to anchor on`);
  }
  return `/${absPath}`;
}

/**
 * A literal PATH, spelled for the content of a permission rule (`Tool(<content>)`): TWO LAYERS.
 *
 * 1. The gitignore layer: `\`, `[`, `]`, `*`, `(` and `)` are backslash-escaped, so a directory named
 *    `[wip] app` is that directory rather than a character class. `?` stays RAW.
 * 2. Claude's own rule-content escape over that (`c()` in claude 2.1.250, verbatim):
 *    `replaceAll("\\","\\\\").replaceAll("(","\\(").replaceAll(")","\\)")`. The read side finds the
 *    content between the first and the last UNESCAPED paren (an even run of backslashes before it) and
 *    unescapes it ONCE (`\(`→`(`, `\)`→`)`, `\\`→`\`) before the gitignore layer sees it; both legs parse
 *    rule strings this way (the Winter runtime since `ws21/sdk`@6170adb, L1a's port).
 *
 * THE TABLE, per character of the path: `\` → `\\\\` (four), `[` → `\\[`, `]` → `\\]`, `*` → `\\*`,
 * `(` → `\\\(`, `)` → `\\\)`, `?` → `?`; everything else as written.
 *
 * MEASURED on claude 2.1.250 and on the Winter runtime at 6170adb (a Write under a directory of each
 * name, a user-tier deny rule; the escape-table round): a literal `\` matches only as four; unescaped
 * `[w]` never matched and escaped did; `?` must stay raw (an escaped `\?` never matched); balanced raw
 * `(old)` matched but an UNBALANCED raw paren broke the rule on claude. And WHY `(`/`)` are escaped at the
 * gitignore layer too, not only by `c()`: with `c()` alone, a `\` followed by `(` becomes `\\\\\(`,
 * which unescapes to `\\(` — and both runtimes then fail to compile the rule ("Invalid regular
 * expression: missing )"; claude errors every file tool call, the Winter runtime fails the run). With
 * the paren escaped at both layers (claude's own path escaper does the same at the gitignore layer) the
 * rule compiles and matches on both. `{}`, `!`, `#` and spaces are literal as written.
 */
export function escapeRulePath(path: string): string {
  const gitignore = path.replace(/[[\]*\\()]/g, (character) => `\\${character}`);
  return gitignore.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** The item directories whose writes are protected (spec §7.2). */
export const PROTECTED_ITEM_DIRS = ["skills", "commands", "rules", "output-styles"] as const;

/**
 * Spec §7.2's protected paths, as flag-layer `permissions.ask` rules: `Edit(...)` and `Write(...)` over
 * `sdk/{skills,commands,rules,output-styles}/**`, `sdk/<instructions file>` and, for a trusted project,
 * `<root>/**\/<project dir>/{skills,commands,rules,output-styles}/**` — the project's item dirs AT ANY
 * DEPTH under the root (C1).
 *
 * WHY ANY DEPTH, not the walk: a later session whose cwd is deeper loads that deeper directory's items
 * (the walk runs from ITS cwd), so a write from the root's session into `packages/app/<project dir>/
 * skills/` must ask now — the walk-only rules (fix round 1, I2) covered only the dirs between THIS
 * session's cwd and the root. MEASURED on the pinned runtime (scripted loopback): a mid-path `**` in an
 * `//`-anchored rule matches zero or more directories — the root's own `<project dir>/` and one two
 * levels down both reach `canUseTool`, under `acceptEdits` and under `bypassPermissions` alike, and an
 * unprotected sibling does not (`test/official/protected-ask-fires.test.ts`).
 *
 * Every PATH part is spelled with `escapeRulePath` (the glob parts — `**`, `/**` — are the rule's own).
 * A root at or above `$HOME` is protected as given (more asks, never fewer).
 *
 * @param walk DEPRECATED (minors round, item 1) and IGNORED: every walk directory is under the root,
 * which the any-depth rule already covers. Kept optional only so existing callers still compile.
 */
export function protectedPathRules(
  sdkHome: string,
  trustedProjectRoot: string | null,
  brand: Pick<RunHomeBrand, "projectDirName" | "instructionsFile"> = WINTER_BRAND,
  /** @deprecated Ignored — the any-depth rule covers every walk directory. */
  walk?: { cwd: string; userHome?: string },
): string[] {
  void walk;
  const sdk = escapeRulePath(sdkHome);
  const targets: string[] = [];
  for (const kind of PROTECTED_ITEM_DIRS) targets.push(`${fsRootAnchored(join(sdk, kind))}/**`);
  targets.push(fsRootAnchored(join(sdk, brand.instructionsFile)));
  if (trustedProjectRoot !== null) {
    const root = escapeRulePath(trustedProjectRoot);
    for (const kind of PROTECTED_ITEM_DIRS) targets.push(`${fsRootAnchored(join(root, "**", brand.projectDirName, kind))}/**`);
  }
  return ["Edit", "Write"].flatMap((tool) => targets.map((target) => `${tool}(${target})`));
}

/** The brand a run home was built with, filled in. */
export function runHomeBrandOf(input: Pick<RunHomeInput, "brand">): RunHomeBrand {
  const brand = input.brand ?? WINTER_BRAND;
  return { homeDirName: brand.homeDirName, projectDirName: brand.projectDirName, instructionsFile: brand.instructionsFile, envPrefix: brand.envPrefix, mcpServerName: brand.mcpServerName };
}
