// THE VENDOR'S OWN PATH VOCABULARY — one definition, one argument order, both lanes importing it.
//
// WHY THIS MODULE EXISTS (review r4, N13). Two lanes needed the same three names and, working in
// parallel trees, each wrote its own: `src/official/spool.ts` had `resumeStagingRoot(tmpdir, uuid)`
// and `src/store/materialized-resume.ts` had `resumeStagingRoot(uuid, base = tmpdir())` — SAME NAME,
// SAME SHAPE, MIRRORED ARGUMENTS. Both were correct in their own file and both were exported from
// their lane's barrel, so a caller who imported the wrong one got a path with the uuid and the tmpdir
// swapped: a directory that exists, that no runtime will ever write to, and that nothing type-checks
// away because both parameters are `string`. That is the entire hazard, and one definition is the
// only fix that keeps working after the next lane arrives.
//
// THE ARGUMENT ORDER IS `(uuid, base)`, Lane C's. It is the one with a meaningful default — the base
// really is `os.tmpdir()` unless a test moves it — and it puts the parameter the caller always has
// first. Lane A's call sites (a test and the classifier) were changed to match.
//
// A CLAUDE-MIRRORING LITERAL, NEVER REBRANDED (WS-01 §5, D16/D19). `claude-resume-` is the official
// runtime's own staging prefix: WE DO NOT CHOOSE IT, we recognise it. The brand gate's own header
// names it as a literal no rule matches, for exactly this reason — rebranding it would be a lie about
// whose directory it is, and a rebranded spelling would simply fail to match the real one on disk.
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The vendor's fixed staging prefix (WS-05 §9, WS-14 §1: disclosed, never faked, never rebranded). */
export const RESUME_STAGING_PREFIX = "claude-resume-";

/**
 * `<base>/claude-resume-<uuid>` — the root a store-backed resume stages under.
 *
 * WS-05 §9: "Store-backed resume still stages under SDK-parent `os.tmpdir()/claude-resume-<uuid>`."
 *
 * EXPORTED FOR RECOGNITION AND FOR STAGING, NEVER FOR CONFIGURATION on the official branch: the
 * vendor's wrapper builds its own path there and we never set it ("`Options.env`/spawn hook are too
 * late" — WS-14 §2's controls table), so the only base a host can move is the SDK PARENT's process
 * `TMPDIR`. Lane C's decorator, by contrast, stages a copy at a root it owns and passes `base`.
 */
export function resumeStagingRoot(uuid: string, base: string = tmpdir()): string {
  return join(base, `${RESUME_STAGING_PREFIX}${uuid}`);
}

/**
 * True when a path is a `claude-resume-<uuid>` staging root.
 *
 * BY BASENAME, NEVER BY SUBSTRING: `<tmp>/claude-resume-9/projects/key` is a file INSIDE a staging
 * root, not the root, and a reconciler that confused the two would delete or import the wrong thing.
 * The bare prefix with no uuid is not one either.
 */
export function isResumeStagingRoot(path: string): boolean {
  const basename = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return basename.startsWith(RESUME_STAGING_PREFIX) && basename.length > RESUME_STAGING_PREFIX.length;
}
