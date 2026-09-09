// CROSS-ENGINE TEMP CONTINUITY (WS-05 §9/§9.1, D18) — the barrier's step 7.
//
// D18's layout, which both engines share and neither owns:
//
//   ${realpath(<PREFIX>TMPDIR | /tmp)}/<tempRootName>-<uid>/     the SHARED per-user root
//     <tempRootName>-<uid>/<tempProjectKey>/<backendUuid>/       the Winter engine dir
//     claude-<uid>/<tempProjectKey>/<backendUuid>/               the official engine dir
//
// The vendor's `claude-<uid>` is HARD-CODED IN ITS BINARY: it appends that name beneath whatever
// `CLAUDE_CODE_TMPDIR` it is given, which is what turns the shared root into a place where the two
// engines are siblings. It is a Claude-mirroring literal (WS-01 §5 / D16): rebranding it would not
// rename anything, it would simply describe the wrong directory. Every OTHER name here is derived
// from the resolved `BrandProfile`.
//
// §9.1's asymmetry is the whole of `materializeTempContinuity`:
//
//   * Claude → Winter: Winter ADOPTS the recorded `claude-<uid>/…` dir IN PLACE. No copy, so
//     transcript-recorded absolute paths stay live for read AND write.
//   * Winter → Claude: "Claude always computes its own path and cannot be pointed elsewhere", so at
//     the barrier the recorded dir is CLONE-COPIED into that computed path and `effectiveTempDir`
//     moves. The superseded dir is RETAINED (§9.1: "read-only as part of the session's footprint …
//     until session deletion or retention removes it").
//
// THE SUPERSEDED DIR IS NOT `chmod`ed. "Retained read-only" and "until retention removes it" are the
// same sentence, and a `0500` directory cannot have its children unlinked — the mode that implements
// the first half breaks the second. It is retained as it stands and NAMED in the result, which is the
// half of "read-only" that a caller can act on.
import { constants as fsConstants, cpSync, chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { envName, isUnset, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../errors.ts";
import type { RuntimeKind } from "../selection/runtime-selection.ts";

/** The official engine's own hard-coded directory prefix beneath the shared root (WS-05 §9, WS-14 §1). */
export const VENDOR_ENGINE_DIR_PREFIX = "claude-";

/** A temp layout that could not be established, or one whose destination failed re-validation. */
export class TempContinuityError extends RuntimeSdkError {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`winter-runtime-sdk: temp continuity refused ${path} — ${reason}`);
    this.path = path;
  }
}

export interface EngineTempLayout {
  /** `realpath(<PREFIX>TMPDIR | /tmp)`. */
  base: string;
  /** The shared per-user root — the value a spawned official child gets as `CLAUDE_CODE_TMPDIR`. */
  sharedRoot: string;
  winterEngineDir: string;
  vendorEngineDir: string;
  winterSessionDir: string;
  vendorSessionDir: string;
  uid: number;
  tempProjectKey: string;
  backendUuid: string;
}

export interface EngineTempLayoutInput {
  brand: Pick<BrandProfile, "envPrefix" | "tempRootName">;
  tempProjectKey: string;
  backendUuid: string;
  /** Injectable so a hermetic test never reads the real environment. */
  env?: Record<string, string | undefined>;
  /** The REAL process uid by default. A fixed suffix would lock every other user out of a 0700 root. */
  uid?: number;
}

/**
 * D18's paths, derived rather than spelled.
 *
 * THE BASE IS REALPATH'D ONCE, up front (macOS `/tmp` → `/private/tmp`), and no level beneath it ever
 * is: resolving a deeper level would follow a symlink an attacker could have planted there, which is
 * exactly what §9's "validate without following symlinks" forbids.
 */
export function resolveEngineTempLayout(input: EngineTempLayoutInput): EngineTempLayout {
  assertSafeSegment(input.tempProjectKey, "tempProjectKey");
  assertSafeSegment(input.backendUuid, "backendUuid");
  const env = input.env ?? process.env;
  const override = env[envName(input.brand, "TMPDIR")];
  const rawBase = isUnset(override) ? "/tmp" : (override as string);
  let base: string;
  try {
    base = realpathSync(rawBase);
  } catch (error) {
    throw new TempContinuityError(rawBase, `the temp base does not resolve (${(error as Error).message})`);
  }
  const uid = input.uid ?? realUid();
  const sharedRoot = join(base, `${input.brand.tempRootName}-${uid}`);
  const winterEngineDir = join(sharedRoot, `${input.brand.tempRootName}-${uid}`);
  const vendorEngineDir = join(sharedRoot, `${VENDOR_ENGINE_DIR_PREFIX}${uid}`);
  const sessionSuffix = join(input.tempProjectKey, input.backendUuid);
  return {
    base,
    sharedRoot,
    winterEngineDir,
    vendorEngineDir,
    winterSessionDir: join(winterEngineDir, sessionSuffix),
    vendorSessionDir: join(vendorEngineDir, sessionSuffix),
    uid,
    tempProjectKey: input.tempProjectKey,
    backendUuid: input.backendUuid,
  };
}

/** WS-05 §12 step 7 / §9.1's two directions, by DESTINATION runtime. */
export function tempContinuityModeFor(to: RuntimeKind): "adopt" | "clone-copy" {
  return to === "winter-agent" ? "adopt" : "clone-copy";
}

/** The canonical session temp dir for a runtime, under one layout. */
export function sessionTempDirFor(to: RuntimeKind, layout: EngineTempLayout): string {
  return to === "winter-agent" ? layout.winterSessionDir : layout.vendorSessionDir;
}

export interface TempContinuityResult {
  mode: "adopt" | "clone-copy";
  /** `RuntimeSessionRecord.effectiveTempDir` after the handoff (WS-16 §4). */
  effectiveTempDir: string;
  /** The Winter-side dir a clone-copy superseded. Retained; named so retention can find it. */
  supersededDir?: string;
  filesCopied: number;
  /** §9.1's "Round trips" row: the recorded dir already IS the destination's computed path. */
  stabilized: boolean;
  /** §9.1's last row: the recorded dir was gone, so a fresh one was created at the canonical path. */
  recreated: boolean;
}

export interface TempContinuityInput {
  to: RuntimeKind;
  layout: EngineTempLayout;
  /**
   * `RuntimeSessionRecord.effectiveTempDir` — the dir the session is ACTUALLY using, whichever engine
   * dir it lives under. Absent for a session that has no recorded dir yet.
   */
  recordedTempDir?: string;
}

/**
 * WS-05 §12 step 7.
 *
 * EVERY BRANCH RE-VALIDATES THE DESTINATION (ownership, directory-ness, no symlink, `0700`) and
 * refuses rather than repairing — the destination of a temp materialization is a directory another
 * process could have planted, and §9's own rule is "validate the per-user root without following
 * symlinks: ownership, directory-ness, traversal, permissions; reject substitution".
 */
export function materializeTempContinuity(input: TempContinuityInput): TempContinuityResult {
  const mode = tempContinuityModeFor(input.to);
  const computed = sessionTempDirFor(input.to, input.layout);
  const recorded = input.recordedTempDir;

  if (mode === "adopt") {
    // Winter uses the RECORDED dir, not a recomputation (§9.1 rows 2 and 3) — including a
    // `claude-<uid>/…` one, which is the point of the whole row.
    if (recorded !== undefined && exists(recorded)) {
      assertContained(recorded, input.layout);
      ensureOwnedDir(recorded);
      return { mode, effectiveTempDir: recorded, filesCopied: 0, stabilized: recorded === computed, recreated: false };
    }
    ensureOwnedDir(computed);
    return { mode, effectiveTempDir: computed, filesCopied: 0, stabilized: recorded === computed, recreated: true };
  }

  // clone-copy: the destination is the path the vendor computes, and cannot be pointed elsewhere.
  if (recorded !== undefined && recorded === computed) {
    // §9.1's "Round trips": once a session has ever been Claude-owned its temp home stabilizes in the
    // vendor engine dir, and a later Claude generation RECOMPUTES ONTO IT. Copying a directory onto
    // itself would be a no-op at best and a truncation at worst.
    ensureOwnedDir(computed);
    return { mode, effectiveTempDir: computed, filesCopied: 0, stabilized: true, recreated: false };
  }
  if (recorded === undefined || !exists(recorded)) {
    ensureOwnedDir(computed);
    return { mode, effectiveTempDir: computed, filesCopied: 0, stabilized: false, recreated: true };
  }
  assertContained(recorded, input.layout);
  ensureOwnedDir(computed);
  const filesCopied = cloneCopyTree(recorded, computed);
  ensureOwnedDir(computed); // re-validated AFTER the copy: the copy created every level beneath it
  return { mode, effectiveTempDir: computed, supersededDir: recorded, filesCopied, stabilized: false, recreated: false };
}

/**
 * What this module discloses about where a session's scratch actually lives (WS-17 row 15's "vendor
 * temp roots reported honestly").
 *
 * The official adapter discloses the roots a SPAWN observes; this is the continuity half — the two
 * engine dirs, which one the session is on now, and the one a clone-copy left behind. A report that
 * named only the Winter dir would be the dishonest version: after one Claude generation the session's
 * scratch is in the vendor's directory, and a user asking "where are my files" needs that answer.
 */
export interface TempContinuityDisclosure {
  sharedRoot: string;
  winterEngineDir: string;
  vendorEngineDir: string;
  effectiveTempDir: string;
  supersededDir?: string;
  note: string;
}

export function tempContinuityDisclosure(layout: EngineTempLayout, result: TempContinuityResult): TempContinuityDisclosure {
  return {
    sharedRoot: layout.sharedRoot,
    winterEngineDir: layout.winterEngineDir,
    vendorEngineDir: layout.vendorEngineDir,
    effectiveTempDir: result.effectiveTempDir,
    ...(result.supersededDir === undefined ? {} : { supersededDir: result.supersededDir }),
    note:
      result.mode === "adopt"
        ? "adopted in place: the session keeps the directory it was using, so transcript-recorded absolute paths stay live for read and write"
        : result.stabilized
          ? "the recorded directory is already the path this engine computes, so nothing was copied"
          : result.supersededDir === undefined
            ? "no recorded directory survived, so a fresh one was created at this engine's canonical path"
            : "clone-copied into the path this engine computes; the superseded directory is retained as part of the session's footprint until deletion or retention removes it",
  };
}

// --- filesystem helpers ------------------------------------------------------------------------------

function realUid(): number {
  const getuid = (process as unknown as { getuid?: () => number }).getuid;
  if (typeof getuid !== "function") throw new TempContinuityError("<process>", "this platform has no real uid, and D18's per-user root is keyed by one");
  return getuid();
}

function assertSafeSegment(value: string, label: string): void {
  if (value === "" || value.includes("/") || value === "." || value === "..") {
    throw new TempContinuityError(value, `${label} must be a single non-traversing path segment`);
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The destination must be inside the layout's own shared root.
 *
 * A STRING-PREFIX CHECK ON SEGMENT BOUNDARIES, not a `realpath` — resolving would follow exactly the
 * symlink this refuses to trust. Every level the store creates is validated as a real directory by
 * `ensureOwnedDir`, so a planted symlink anywhere on the path fails there instead.
 */
function assertContained(path: string, layout: EngineTempLayout): void {
  const root = layout.sharedRoot.endsWith("/") ? layout.sharedRoot : `${layout.sharedRoot}/`;
  if (path !== layout.sharedRoot && !path.startsWith(root)) {
    throw new TempContinuityError(path, `it is outside this session's shared temp root (${layout.sharedRoot})`);
  }
}

/** `0700`, owned by this uid, a real directory and not a symlink — created if absent, healed if not. */
function ensureOwnedDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new TempContinuityError(path, "it is a symlink, and this level must be a directory this process owns");
  if (!stat.isDirectory()) throw new TempContinuityError(path, "it exists and is not a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new TempContinuityError(path, "it is owned by a different uid");
  chmodSync(path, 0o700);
}

/**
 * §9.1's clone-copy: APFS `copyfile` CLONE where the filesystem has it, symlinks copied AS symlinks.
 *
 * `COPYFILE_FICLONE` is a HINT — it clones on APFS and falls back to a byte copy everywhere else,
 * which is the behaviour §9.1 wants in both cases (`FICLONE_FORCE` would fail on a filesystem without
 * reflinks). `verbatimSymlinks` is what implements "symlinks copied as symlinks, never followed": the
 * default would resolve them and copy their targets, which could pull content from outside the tree.
 */
function cloneCopyTree(from: string, to: string): number {
  cpSync(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    verbatimSymlinks: true,
    mode: fsConstants.COPYFILE_FICLONE,
  });
  return revalidateTree(to);
}

/**
 * Re-applies WS-05 §9's modes at the destination and counts what arrived.
 *
 * Symlinks are counted and otherwise left alone — `chmod` on a symlink follows it, and following is
 * the thing this whole path refuses to do.
 */
function revalidateTree(root: string): number {
  let files = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        files += 1;
        continue;
      }
      if (entry.isDirectory()) {
        chmodSync(path, 0o700);
        walk(path);
        continue;
      }
      if (entry.isFile()) {
        chmodSync(path, 0o600);
        files += 1;
      }
    }
  };
  walk(root);
  return files;
}
