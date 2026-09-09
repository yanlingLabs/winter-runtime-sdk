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

/**
 * Tools whose effect is a filesystem write, and therefore worth a snapshot pair.
 *
 * `WebFetch` is here for a reason that is not a file write (review r3, NEW-11): a saved WebFetch
 * approval is §8's one writer with no tool call of its own, and its durable rule update lands in the
 * vendor's own settings file. Watching the call it rides on is the only post-hoc cover it can have.
 */
export const SWEPT_TOOLS: readonly string[] = ["Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit", "FileWrite", "FileEdit", "WebFetch", "Task", "Agent", "Skill", "Workflow", "EnterWorktree", "ExitWorktree"];

/**
 * THE HOOK EVENTS A TOOL'S FILESYSTEM EFFECT CAN BE FOLLOWED BY (review r3, NEW-9).
 *
 * Enumerated from the pinned union rather than guessed: `HOOK_EVENTS` in the 0.3.250 declarations
 * carries `PostToolUse`, `PostToolUseFailure` and `PostToolBatch` as the three events that follow a
 * tool call, and the sweep registered only the first. MEASURED: a command with a side effect and a
 * nonzero exit (`mkdir …; exit 1`) fires `PostToolUseFailure` and NO `PostToolUse`, so the baseline
 * taken in `pre` was never consumed, the artifact survived the session, and `existsSync(<cwd>/.claude)`
 * — row 14's own predicate — was true with both containment layers installed.
 *
 * `PostToolBatch` carries `tool_calls[]` rather than one `tool_use_id`, so the handler reads both
 * shapes.
 */
export const POST_TOOL_EVENTS: readonly string[] = ["PostToolUse", "PostToolUseFailure", "PostToolBatch"];

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
export function forbiddenArtifactsUnder(root: string, depth = 0, maxDepth: number = MAX_DEPTH): string[] {
  if (depth > maxDepth || !existsSync(root)) return [];
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
    if (isDirectory) found.push(...forbiddenArtifactsUnder(full, depth + 1, maxDepth));
  }
  return found;
}

export interface ContainmentSweepOptions {
  /** The session's working directory. */
  cwd: string;
  /** WS-14 §14's diagnostics label, so a breach error reads like every other error in the package. */
  branchLabel?: string;
  /** How deep below each root the walk goes. Default 6; see `MAX_DEPTH`'s own note. */
  maxDepth?: number;
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
  /** `PostToolBatch`'s own shape (review r3, NEW-9). */
  tool_calls?: Array<{ tool_name?: string; tool_use_id?: string }>;
}

/** Builds the sweep's two hooks. One sweep per SESSION: the snapshots are keyed by tool-use id. */
export function createContainmentSweep(options: ContainmentSweepOptions): ContainmentSweep {
  const now = options.now ?? (() => new Date());
  const roots = [options.cwd, ...(options.home === undefined ? [] : [options.home])];
  // Two maps: one records that a call was SEEN (so it can be retired), the other its snapshot.
  const before = new Set<string>();
  const beforeSnapshots = new Map<string, Set<string>>();
  const breaches: ContainmentBreach[] = [];

  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const snapshot = (): Set<string> => new Set(roots.flatMap((root) => forbiddenArtifactsUnder(root, 0, maxDepth)));

  const pre = async (raw: unknown): Promise<Record<string, never>> => {
    const input = (raw ?? {}) as SweepHookInput;
    const toolName = input.tool_name ?? "";
    const toolUseId = input.tool_use_id ?? "";
    if (!SWEPT_TOOLS.includes(toolName) || toolUseId === "") return {};
    before.add(toolUseId);
    beforeSnapshots.set(toolUseId, snapshot());
    return {};
  };

  // `event` IS THE HOOK THIS INVOCATION CAME FROM (review r4, NEW-20). The runtime does not tell the
  // hook which event fired it, so the registration closes over the name — the alternative was the
  // constant `"PostToolUse"` on all three, which named the wrong hook in the one field a host reads.
  const post = async (raw: unknown, event: string = POST_TOOL_EVENTS[0] as string): Promise<Record<string, unknown>> => {
    const input = (raw ?? {}) as SweepHookInput;
    // A batch reports several calls at once; any of them may be the one that wrote.
    const calls = input.tool_calls ?? [{ tool_name: input.tool_name, tool_use_id: input.tool_use_id }];
    const call = calls.find((entry) => SWEPT_TOOLS.includes(entry.tool_name ?? "") && before.has(entry.tool_use_id ?? "")) ?? calls[0];
    const toolName = call?.tool_name ?? "";
    const toolUseId = call?.tool_use_id ?? "";
    // Every call this handler sees is retired from the baseline map, swept or not, so a floor-denied
    // or unswept call cannot leave an entry behind (review r3, NEW-15).
    for (const entry of calls) if (entry.tool_use_id !== undefined) before.delete(entry.tool_use_id);
    if (!SWEPT_TOOLS.includes(toolName) || toolUseId === "") return {};
    const baseline = beforeSnapshots.get(toolUseId);
    beforeSnapshots.delete(toolUseId);
    // THE FAIL-SAFE POINTS THE OTHER WAY NOW (review r3, NEW-12). With no baseline, NOTHING is
    // attributable to this call — and the previous code treated every forbidden path under `cwd` and
    // `HOME` as newly created and `rmSync`'d it recursively. In production `HOME` is the user's real
    // home, whose vendor directory holds their own credentials. No snapshot means no deletion.
    if (baseline === undefined) return {};
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
    const error = new OfficialContainmentBreachError({ toolName, created, removed, retained, branchLabel: options.branchLabel ?? "" });
    options.onBreach?.(breach, error);

    const reason =
      `${toolName} created ${created.length === 1 ? "a path" : "paths"} whose name is the vendor's own (${created.join(", ")}). ` +
      `On this branch that name belongs to the vendor runtime and is never written by a session: the ${removed.length === created.length ? "artifact was" : "artifacts were"} removed and the call is refused (WS-14 §8). ` +
      `Spell the target under the product's own project directory instead.`;
    // HOW A BREACH IS MADE VISIBLE, and it is a MEASUREMENT rather than a preference. Driven against
    // the pinned 0.3.250 with a probe hook returning each shape in turn, none of the documented
    // PostToolUse rewrites reached the model: `decision: "block"` + `reason`, `updatedToolOutput` as a
    // string, and `updatedToolOutput` as a content block ALL left the tool_result exactly as the tool
    // produced it (the hook ran in every case — it is the OUTPUT that is ignored on this pin). The one
    // shape that changed anything was `continue: false`, which ends the turn before the tool_result is
    // sent at all.
    //
    // So the sweep ends the turn, and carries the other three shapes anyway: if a later runtime honours
    // a rewrite, the model gets the sentence; on this pin it gets no result for a call whose effect was
    // undone, and the host gets the typed breach. A silent success — the call "working" while its
    // effect is deleted underneath it — is the one outcome that is not acceptable.
    // AND THE TURN-ENDING HALF IS NOT AVAILABLE ON EVERY EVENT (review r3, NEW-9): a probe returning
    // `continue: false` from `PostToolUseFailure` did NOT end the turn — the next scripted tool ran.
    // So the guarantee this sweep makes is the one it can keep everywhere: THE ARTIFACT DOES NOT
    // SURVIVE THE CALL. The turn additionally ends for a call that SUCCEEDS, which is where
    // `continue: false` is honoured.
    return {
      continue: false,
      stopReason: reason,
      systemMessage: reason,
      decision: "block",
      reason,
      // THE EVENT IS THE ONE THAT FIRED (review r4, NEW-20). The sweep is registered on three events
      // and every block used to report `PostToolUse`, so a breach caught on `PostToolUseFailure` or
      // `PostToolBatch` named the wrong hook in the one field a host reads to find it.
      //
      // …AND ONLY THE FIELDS THAT EVENT DECLARES (round 3, nit a). On this pin `updatedToolOutput`
      // exists on `PostToolUseHookSpecificOutput` alone; `PostToolUseFailureHookSpecificOutput` and
      // `PostToolBatchHookSpecificOutput` declare `additionalContext` and nothing else. Sending a key
      // the shape does not have was never measured to break anything — the sweep's own REMOVAL is the
      // guarantee, and the real-runtime test asserts the removal rather than the report — but a hook
      // output that does not match the pinned declaration is drift waiting to be discovered by a
      // runtime that starts validating.
      hookSpecificOutput:
        event === "PostToolUse" ? { hookEventName: event, updatedToolOutput: reason, additionalContext: reason } : { hookEventName: event, additionalContext: reason },
    };
  };

  return {
    hooks: { PreToolUse: [{ hooks: [pre] }], ...Object.fromEntries(POST_TOOL_EVENTS.map((event) => [event, [{ hooks: [(input: unknown) => post(input, event)] }]])) },
    get breaches() {
      return breaches;
    },
  };
}

/** The three names the sweep looks for, restated for a caller that wants to report them. */
export const SWEPT_TARGETS = FORBIDDEN_TARGETS;
