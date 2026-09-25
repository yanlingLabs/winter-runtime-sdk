// WS-21 §3: THE RUN-HOME BUILDER — one private folder per generation, built before it starts.
//
// WHAT IT IS FOR. Both runtimes are pointed at a config dir and read it with their own discovery
// rules (claude's `CLAUDE_CONFIG_DIR`, the Winter child's brand `HOME` variable). Pointing either one
// at `<home>/sdk` itself would let it read everything there under ITS rules, write per-session state
// into the shared home, and see project items the daemon's trust decision never admitted. So the
// router builds, per generation, the folder the child should see, and points it there: claude's
// persistent set linked in (so what the runtime writes there is kept), each item settled once by
// claude's own clash rules, one generated instructions file, one effective settings file and one MCP
// config — and nothing else (spec §3.3).
//
// THE BUILD NEVER FOLLOWS A LINK (spec §3.4.6). Every existence check is an `lstat`; `cache` and
// `cache/runs` are refused outright when they are links (the folder would be created through one);
// a user-tier item that is itself a link is linked as-is and reported, and a project-tier one that
// leaves the project root is skipped and reported. The folder is 0700 and its files 0600.
//
// DISPOSAL IS `rm -rf`, which removes the links and never their targets (spec F3, measured under Bun
// and Node): the persistent set lives on in `sdk/`. The DAEMON disposes, and only once the router
// reports the run home `safe` (spec §3.8).
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RunHomeError } from "./errors.ts";
import { buildInstructions } from "./instructions.ts";
import { buildItems } from "./items.ts";
import { buildMcpConfig } from "./mcp.ts";
import { buildEffectiveSettings } from "./settings.ts";
import { RUN_HOME_PERSISTENT_ENTRIES, runHomeBrandOf, sdkHomeOf, type RunHome, type RunHomeBrand, type RunHomeInput, type RunHomeReport } from "./types.ts";

/** What every build step is handed. */
export interface RunHomeBuildContext {
  input: RunHomeInput;
  brand: RunHomeBrand;
  sdkHome: string;
  /** The run folder being built. */
  dir: string;
  report: RunHomeReport;
  /** `$HOME` — where every project walk and project tier stops (`os.homedir()` unless a test injects one). */
  userHome: string;
}

/** Test-only construction knobs; not part of Contract A. */
export interface RunHomeBuildInternals {
  userHome?: string;
}

const PRIVATE_DIR = 0o700;

/**
 * EVERY RUN HOME THIS MODULE BUILT, by identity (spec §3.5: "a router-built run folder").
 *
 * The router applies a run home by pointing a child at `runHome.dir`, so an object a host assembled
 * by hand — or one whose `dir` names the user's real home — must not pass for one. A `WeakSet` is
 * membership nothing outside this module can confer, the same rule the approval bridge's identity
 * check follows. A disposed run home leaves the set: its folder is gone.
 */
const BUILT_RUN_HOMES = new WeakSet<RunHome>();

/** True for a run home `buildRunHome` built and that has not been disposed. */
export function isRouterBuiltRunHome(value: unknown): value is RunHome {
  return typeof value === "object" && value !== null && BUILT_RUN_HOMES.has(value as RunHome);
}

/** Builds `<home>/cache/runs/<uuid>` for one generation (spec §3). */
export async function buildRunHome(input: RunHomeInput, internals: RunHomeBuildInternals = {}): Promise<RunHome> {
  assertInput(input);
  const brand = runHomeBrandOf(input);
  const sdkHome = sdkHomeOf(input.home);
  const runs = await ensureRunsRoot(input.home);
  const runId = randomUUID();
  const dir = join(runs, runId);
  // NON-RECURSIVE, on purpose: a folder that already exists under a fresh UUID is not ours.
  await mkdir(dir, { mode: PRIVATE_DIR });
  await chmod(dir, PRIVATE_DIR); // the umask may have narrowed `mode`; never widened, but be exact
  const report: RunHomeReport = { skippedLinks: [], externalUserLinks: [], droppedMcpServers: [], unconditionalRules: [], droppedImports: [], skippedAgents: [], droppedRules: [] };
  const context: RunHomeBuildContext = { input, brand, sdkHome, dir, report, userHome: internals.userHome ?? homedir() };
  let effectiveSettings: Record<string, unknown>;
  try {
    await buildCore(context);
    await buildItems(context);
    await buildInstructions(context);
    effectiveSettings = await buildEffectiveSettings(context);
    await buildMcpConfig(context);
  } catch (error) {
    // A HALF-BUILT FOLDER IS NEVER HANDED OUT — and never left behind for a sweep to wonder about.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const runHome: RunHome = {
    runId,
    dir,
    sdkHome,
    input,
    effectiveSettings,
    report,
    dispose: async () => {
      BUILT_RUN_HOMES.delete(runHome);
      await rm(dir, { recursive: true, force: true });
    },
  };
  BUILT_RUN_HOMES.add(runHome);
  return runHome;
}

function assertInput(input: RunHomeInput): void {
  const absolute: Array<[string, unknown]> = [
    ["home", input.home],
    ["cwd", input.cwd],
    ["memoryDir", input.memoryDir],
  ];
  for (const [field, value] of absolute) {
    if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
      throw new TypeError(`buildRunHome: \`${field}\` must be an absolute path (got ${JSON.stringify(value)})`);
    }
  }
  for (const [field, value] of [
    ["trustedProjectRoot", input.trustedProjectRoot],
    ["gitRoot", input.gitRoot],
  ] as Array<[string, string | null]>) {
    if (value !== null && (typeof value !== "string" || !isAbsolute(value))) throw new TypeError(`buildRunHome: \`${field}\` must be an absolute path or null (got ${JSON.stringify(value)})`);
  }
  if (!["code", "dispatch", "chat"].includes(input.mode)) throw new TypeError(`buildRunHome: unknown mode ${JSON.stringify(input.mode)}`);
  if ((input.leg as string) === "official") throw new TypeError("buildRunHome: the official leg is retired (WS-23) — every generation runs on the Winter leg");
  if (input.leg !== "winter") throw new TypeError(`buildRunHome: unknown leg ${JSON.stringify(input.leg)}`);
}

/**
 * `<home>/cache/runs`, created if missing and REFUSED if either segment is a link (spec §3.4.6).
 *
 * A link here would put every run folder — the effective settings, the MCP config with its server
 * commands — wherever the link points, which is a place nobody reviewed.
 */
async function ensureRunsRoot(home: string): Promise<string> {
  const cache = join(home, "cache");
  const runs = join(cache, "runs");
  for (const path of [cache, runs]) {
    const kind = await kindOf(path);
    if (kind === "link") throw new RunHomeError("run_home_link_refused", `${path} is a symbolic link; run folders are only ever created in a real directory under the home (WS-21 §3.4.6)`);
    if (kind === "other") throw new RunHomeError("run_home_link_refused", `${path} exists and is not a directory`);
    if (kind === "missing") {
      try {
        await mkdir(path, { mode: PRIVATE_DIR });
      } catch (error) {
        // A concurrent build created it first: re-check it is what we would have made.
        if ((error as { code?: unknown }).code !== "EEXIST" || (await kindOf(path)) !== "dir") throw error;
      }
    }
  }
  return runs;
}

/** What `lstat` says a path is — a link is a link, never what it points to. */
export async function kindOf(path: string): Promise<"missing" | "dir" | "file" | "link" | "other"> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return "link";
    if (stat.isDirectory()) return "dir";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return "missing";
    throw error;
  }
}

/** Creates `path` as a private directory when nothing is there; leaves whatever IS there alone. */
async function ensureSdkEntry(path: string): Promise<void> {
  if ((await kindOf(path)) !== "missing") return;
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR });
}

/**
 * Spec §3.3's first two rows and its `backups/` rule.
 *
 *   * the persistent set: pre-created in `sdk/` when missing, then symlinked in (absolute targets);
 *   * `projects/`: a link to `sdk/projects` — the Winter child writes the canonical store directly.
 *     (WS-23: the official leg's empty working-copy directory went with that leg.)
 *   * `backups/`: never created. claude keeps `.claude.json` copies there, which are per-session.
 *
 * Nothing else in `sdk/` is linked: `plugins` is reached through the plugin-cache variable, and every
 * other named entry is BUILT by its own step.
 */
async function buildCore(context: RunHomeBuildContext): Promise<void> {
  const { sdkHome, dir, input } = context;
  await mkdir(sdkHome, { recursive: true, mode: PRIVATE_DIR });
  for (const entry of RUN_HOME_PERSISTENT_ENTRIES) {
    const target = join(sdkHome, entry);
    await ensureSdkEntry(target);
    await symlink(target, join(dir, entry));
  }
  const target = join(sdkHome, "projects");
  await ensureSdkEntry(target);
  await symlink(target, join(dir, "projects"));
}
