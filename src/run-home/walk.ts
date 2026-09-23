// WS-21 §3.4.2: THE PROJECT WALK — shared by the item merge and the protected-path rules, so the set of
// directories whose items are LOADED and the set whose items are PROTECTED can never differ.
import { realpathSync } from "node:fs";
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
