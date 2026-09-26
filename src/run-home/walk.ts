// WS-21 §3.4.2: THE PROJECT WALK — the directories whose items the run home LOADS (items, rules,
// instructions). The protected-path rules no longer derive from it: they cover the trusted project's
// item dirs at ANY depth under the root (C1), a superset of every walk this root can produce.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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


/**
 * FIX ROUND 1, M2: `path` is `$HOME` or one of its ancestors — by spelling or by real path. A project
 * tier rooted there would read `$HOME/<project dir>/…`, which is the DAEMON's own home (its
 * `settings.json` still holds Winter-grammar keys kept for downgrade), never a project's. The walk stops
 * at `$HOME` for the items; the settings and MCP tiers stop there too.
 */
export function isHomeOrAbove(path: string, userHome: string): boolean {
  if (isWithin(resolve(userHome), resolve(path))) return true;
  try {
    return isWithin(realpathSync(userHome), realpathSync(path));
  } catch {
    return false;
  }
}

/**
 * WS-24: a REPOSITORY file's text, read only while it is still exactly the file its in-root check
 * admitted — so what reaches the run folder is what discovery approved, whatever happened to the path
 * in between.
 *
 * `real` is the file's real path (from `realpath`, already checked to lie inside `realRoot`). The read:
 *
 *   1. opens `real` with `O_NOFOLLOW` (a link in its last component is refused) and `O_NONBLOCK` (a
 *      special file opens without waiting on it, then fails the regular-file check);
 *   2. checks the OPEN file is a regular file (`fstat`);
 *   3. re-resolves `real` and requires the same real path, still inside `realRoot` — `O_NOFOLLOW` covers
 *      only the last component, so a directory above it is re-checked here;
 *   4. requires the file now at `real` to be the one that was opened (device and inode), so a path that
 *      changed and changed back between steps 1 and 3 is refused too;
 *
 * and only then reads from the open descriptor. A refusal is `outside-root` (the path no longer names the
 * admitted in-root file — a link where a file was counts as that) or `missing` (gone, not a regular
 * file, unreadable).
 */
export function readAdmittedFile(real: string, realRoot: string): { text: string } | { refused: "outside-root" | "missing" } {
  let fd: number;
  try {
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return { refused: (error as { code?: unknown }).code === "ELOOP" ? "outside-root" : "missing" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { refused: "missing" };
    let now: string;
    try {
      now = realpathSync(real);
    } catch {
      return { refused: "missing" };
    }
    if (now !== real || !isWithin(now, realRoot)) return { refused: "outside-root" };
    const named = statSync(now);
    if (named.dev !== opened.dev || named.ino !== opened.ino) return { refused: "outside-root" };
    return { text: readFileSync(fd, "utf8") };
  } catch {
    return { refused: "missing" };
  } finally {
    closeSync(fd);
  }
}
