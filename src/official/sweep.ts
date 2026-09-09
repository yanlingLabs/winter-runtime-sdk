// THE POST-HOC COVER FOR §8 (review r2, NEW-3): a PostToolUse sweep that undoes what the pre-hoc scan
// could not see.
//
// WHY IT EXISTS, measured rather than imagined. With the floor installed and the broker approving, a
// model-emitted `Bash mkdir -p .cla\ude && echo x > .cla\ude/leak.txt` CREATED `<cwd>/.claude/` with a
// file in it — `existsSync(cwd + "/.claude")`, row 14's own predicate, TRUE. Fixing that spelling is a
// regex change (and it is made, in `containment.ts`); the CLASS is not a regex problem at all. A shell
// command can build the vendor's name out of a substitution, a variable set in an earlier call, or a
// `printf`, and no scanner reads a shell.
//
// So the row's guarantee is delivered in two layers, and the second one is a fact about the filesystem
// rather than about a string:
//
//   PRE-HOC   the floor refuses a call whose ARGUMENTS name a forbidden target (path fields, command
//             text, the §8 writers with no path argument at all). Cheap, and it stops the call before
//             it runs — but it is a scanner, and a scanner can be spelled around.
//   POST-HOC  this sweep snapshots the forbidden names under the session's own roots BEFORE a
//             filesystem-touching call and again AFTER it, removes exactly what that call created,
//             records a typed breach, and BLOCKS the tool result so the model is told rather than
//             quietly succeeding.
//
// "EXACTLY WHAT THAT CALL CREATED" is the property that makes deletion safe: the sweep never removes a
// path that was already there when the call started, so a pre-existing directory (a repository that
// legitimately contains one, a user's own file) is reported and left alone rather than destroyed by a
// tool that was only ever meant to contain new writes.
//
// THE SWEEP IS BOUNDED. It walks a small, fixed set of roots to a fixed depth, skipping the two
// directories that make a walk expensive (`.git`, `node_modules`). A containment mechanism that made
// every `Bash` call O(repository) would be turned off by the first host that noticed.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { FORBIDDEN_TARGETS, targetsForbiddenPath } from "./containment.ts";
import { OfficialContainmentBreachError } from "./errors.ts";

/** Tools whose effect is a filesystem write, and therefore worth a snapshot pair. */
export const SWEPT_TOOLS: readonly string[] = ["Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit", "FileWrite", "FileEdit"];

/** How deep the walk goes below a root, and what it never descends into. */
const MAX_DEPTH = 6;
const SKIPPED_DIRECTORIES: readonly string[] = [".git", "node_modules"];

/** One breach: what appeared, from which call, and whether the sweep managed to remove it. */
export interface ContainmentBreach {
  toolName: string;
  toolUseId: string;
  /** The paths this call created that carry a forbidden name. */
  created: readonly string[];
  /** The subset the sweep removed. Anything else is named in `retained`. */
  removed: readonly string[];
  retained: readonly string[];
  at: string;
}

/** Every forbidden-named path under `root`, folded-compared, bounded. */
export function forbiddenArtifactsUnder(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH || !existsSync(root)) return [];
  const found: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return found; // an unreadable directory is not a finding; it is a directory we cannot see into
  }
  for (const entry of entries) {
    const full = join(root, entry);
    if (targetsForbiddenPath(full).forbidden) {
      found.push(full);
      continue; // no need to descend: the whole subtree is inside a forbidden target
    }
    if (SKIPPED_DIRECTORIES.includes(entry)) continue;
    let isDirectory = false;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) found.push(...forbiddenArtifactsUnder(full, depth + 1));
  }
  return found;
}

export interface ContainmentSweepOptions {
  /** The session's working directory. */
  cwd: string;
  /** The session's home, so `~/.claude/plans` is covered as well as the project (WS-17 row 14). */
  home?: string;
  /** Where a breach is reported. The adapter forwards it to the host and keeps it on the session. */
  onBreach?: (breach: ContainmentBreach, error: OfficialContainmentBreachError) => void;
  now?: () => Date;
}

export interface ContainmentSweep {
  /** The hook matchers to merge into `Options.hooks` — one PreToolUse, one PostToolUse. */
  hooks: Record<string, Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>>;
  /** Every breach this session has seen, in order. */
  readonly breaches: readonly ContainmentBreach[];
}

interface SweepHookInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
}

/** Builds the sweep's two hooks. One sweep per SESSION: the snapshots are keyed by tool-use id. */
export function createContainmentSweep(options: ContainmentSweepOptions): ContainmentSweep {
  const now = options.now ?? (() => new Date());
  const roots = [options.cwd, ...(options.home === undefined ? [] : [options.home])];
  const before = new Map<string, Set<string>>();
  const breaches: ContainmentBreach[] = [];

  const snapshot = (): Set<string> => new Set(roots.flatMap((root) => forbiddenArtifactsUnder(root)));

  const pre = async (raw: unknown): Promise<Record<string, never>> => {
    const input = (raw ?? {}) as SweepHookInput;
    const toolName = input.tool_name ?? "";
    const toolUseId = input.tool_use_id ?? "";
    if (!SWEPT_TOOLS.includes(toolName) || toolUseId === "") return {};
    before.set(toolUseId, snapshot());
    return {};
  };

  const post = async (raw: unknown): Promise<Record<string, unknown>> => {
    const input = (raw ?? {}) as SweepHookInput;
    const toolName = input.tool_name ?? "";
    const toolUseId = input.tool_use_id ?? "";
    if (!SWEPT_TOOLS.includes(toolName) || toolUseId === "") return {};
    const baseline = before.get(toolUseId) ?? new Set<string>();
    before.delete(toolUseId);
    const created = [...snapshot()].filter((path) => !baseline.has(path));
    if (created.length === 0) return {};

    const removed: string[] = [];
    const retained: string[] = [];
    for (const path of created) {
      try {
        rmSync(path, { recursive: true, force: true });
        removed.push(path);
      } catch {
        // A path we cannot remove is REPORTED, not swallowed: the breach record is what a host acts
        // on, and a silent failure here would be the worst of both worlds.
        retained.push(path);
      }
    }
    const breach: ContainmentBreach = { toolName, toolUseId, created, removed, retained, at: now().toISOString() };
    breaches.push(breach);
    const error = new OfficialContainmentBreachError({ toolName, created, removed, retained, branchLabel: "" });
    options.onBreach?.(breach, error);

    const reason =
      `${toolName} created ${created.length === 1 ? "a path" : "paths"} whose name is the vendor's own (${created.join(", ")}). ` +
      `On this branch that name belongs to the vendor runtime and is never written by a session: the ${removed.length === created.length ? "artifact was" : "artifacts were"} removed and the call is refused (WS-14 §8). ` +
      `Spell the target under the product's own project directory instead.`;
    return {
      decision: "block",
      reason,
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: reason },
    };
  };

  return {
    hooks: { PreToolUse: [{ hooks: [pre] }], PostToolUse: [{ hooks: [post] }] },
    get breaches() {
      return breaches;
    },
  };
}

/** The three names the sweep looks for, restated for a caller that wants to report them. */
export const SWEPT_TARGETS = FORBIDDEN_TARGETS;
