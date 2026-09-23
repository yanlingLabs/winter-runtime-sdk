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
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import { projectWalk } from "./walk.ts";

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

/** The item directories whose writes are protected (spec §7.2). */
export const PROTECTED_ITEM_DIRS = ["skills", "commands", "rules", "output-styles"] as const;

/**
 * Spec §7.2's protected paths, as flag-layer `permissions.ask` rules: `Edit(...)` and `Write(...)` over
 * `sdk/{skills,commands,rules,output-styles}/**`, `sdk/<instructions file>` and, for a trusted project,
 * `<d>/<project dir>/{skills,commands,rules,output-styles}/**` for EVERY directory `d` whose items the
 * run home loads (fix round 1, I2) — the project walk from the cwd up to the trusted root, stopping at
 * `$HOME` (`walk`). Without `walk`, only the root's own project dir (the pre-fix reading, kept for a
 * caller that has no cwd).
 *
 * claude checks its ask rules before its bypass step, which is what makes these fire where its own
 * sensitive-file check would swallow a hook's `ask` (F16). A test drives the real runtime to prove the
 * spelling matches, for the root's project dir and for a nested one (`test/official/protected-ask-fires.test.ts`).
 */
export function protectedPathRules(
  sdkHome: string,
  trustedProjectRoot: string | null,
  brand: Pick<RunHomeBrand, "projectDirName" | "instructionsFile"> = WINTER_BRAND,
  walk?: { cwd: string; userHome?: string },
): string[] {
  const targets: string[] = [];
  for (const kind of PROTECTED_ITEM_DIRS) targets.push(`${fsRootAnchored(join(sdkHome, kind))}/**`);
  targets.push(fsRootAnchored(join(sdkHome, brand.instructionsFile)));
  if (trustedProjectRoot !== null) {
    const projectDirs = walk === undefined ? [trustedProjectRoot] : projectWalk(walk.cwd, trustedProjectRoot, walk.userHome ?? homedir());
    for (const dir of projectDirs) {
      for (const kind of PROTECTED_ITEM_DIRS) targets.push(`${fsRootAnchored(join(dir, brand.projectDirName, kind))}/**`);
    }
  }
  return ["Edit", "Write"].flatMap((tool) => targets.map((target) => `${tool}(${target})`));
}

/** The brand a run home was built with, filled in. */
export function runHomeBrandOf(input: Pick<RunHomeInput, "brand">): RunHomeBrand {
  const brand = input.brand ?? WINTER_BRAND;
  return { homeDirName: brand.homeDirName, projectDirName: brand.projectDirName, instructionsFile: brand.instructionsFile, envPrefix: brand.envPrefix, mcpServerName: brand.mcpServerName };
}
