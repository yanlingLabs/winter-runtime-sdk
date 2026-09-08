// WS-14 §8: BUILTIN-PATH CONTAINMENT — no vendor-named writes, from any path.
//
// "`settingSources: []` controls DISCOVERY ONLY; native built-ins carry Claude-named project paths in
// their own semantics." That sentence is the whole problem: turning discovery off does not stop
// `EnterWorktree` from writing `.claude/worktrees/`, a durable `CronCreate` from writing
// `.claude/scheduled_tasks.json`, or a `Bash` call from writing anything at all.
//
// The proof obligation (WS-17 row 14) is absolute and is what this module is built backwards from:
// "native and aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and
// arbitrary file/shell paths CANNOT create project `CLAUDE.md`, `.claude/`, or `~/.claude/plans`
// under the strict policy — covering both ordinary and harness-internal paths."
//
// TWO LAYERS, because one is not enough:
//
//   1. DISPOSITIONS (the §8 table) — redirect the writer to the product's own directory, or disable
//      the durable variant with a typed capability error. This is what keeps the FEATURE working.
//   2. THE PATH FLOOR — a predicate over the resolved target of any tool call, denying the three
//      vendor-named targets outright. This is what makes the proof obligation true for the paths no
//      disposition anticipated (an arbitrary `Write`, a shell redirect, a harness-internal call).
//
// The floor is deliberately a FUNCTION OF PATHS RATHER THAN OF TOOL NAMES: `disallowedTools` is a
// name-based mechanism and §7 already says aliasing "is not a security boundary". A rule that named
// tools would be one rename away from a hole.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/** The three vendor-named targets nothing may create (WS-17 row 14). */
export const FORBIDDEN_TARGETS = {
  instructionsFile: "CLAUDE.md",
  projectDir: ".claude",
  userPlansDir: ".claude/plans",
} as const;

/** Where each native writer is redirected — the product's own project directory (§8's table). */
export interface ContainmentPaths {
  worktrees: string;
  workflows: string;
  plans: string;
  localSettings: string;
}

export function containmentPaths(brand: Pick<BrandProfile, "projectDirName">): ContainmentPaths {
  return {
    worktrees: `${brand.projectDirName}/worktrees`,
    workflows: `${brand.projectDirName}/workflows`,
    plans: `${brand.projectDirName}/plans`,
    localSettings: `${brand.projectDirName}/settings.local.json`,
  };
}

/** One row of §8's disposition table, as data a capability matrix can render. */
export interface ContainmentDisposition {
  writer: string;
  claudeNamedTarget: string;
  disposition: "redirect" | "disable" | "owned-by-product" | "deny";
  target?: string;
  note: string;
}

/**
 * §16 open question 2, FIXED HERE WITH ITS REASON RECORDED.
 *
 * "Saved `WebFetch` approvals: redirect versus disable is left open until WS-07 decides whether
 * durable approvals on this branch share the product's rules store or the project settings file;
 * either way the `.claude/` write is denied."
 *
 * The default is `disable`, and the argument is that a REDIRECT is the option that cannot be taken
 * back: a durable approval written into the product's own settings file is a rule the WINTER branch
 * will also honour, so choosing redirect here silently decides WS-07's open question in favour of
 * "shared store" for every host that never revisits the default. Disabling denies the vendor-named
 * write (which is all §8 requires), keeps the session working (approvals still apply for its
 * lifetime), and leaves WS-07 free to decide. A host that has already made that decision flips it.
 */
export type SavedApprovalDisposition = "disable" | "redirect";

export interface ContainmentPolicy {
  savedWebFetchApprovals?: SavedApprovalDisposition;
}

export function containmentDispositions(brand: Pick<BrandProfile, "projectDirName" | "productName">, policy: ContainmentPolicy = {}): readonly ContainmentDisposition[] {
  const paths = containmentPaths(brand);
  const savedApprovals = policy.savedWebFetchApprovals ?? "disable";
  return [
    {
      writer: "EnterWorktree / Agent isolation: \"worktree\"",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/worktrees/`,
      disposition: "redirect",
      target: paths.worktrees,
      note: "aliased or replaced with a schema-compatible implementation targeting the product's own project directory",
    },
    {
      writer: "CronCreate with durable: true",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/scheduled_tasks.json`,
      disposition: "disable",
      note: "the durable variant answers with a typed capability error; non-durable behaviour may remain",
    },
    {
      writer: "named Workflow resolution",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/workflows/`,
      disposition: "redirect",
      target: paths.workflows,
      note: "resolution moves to the product's own workflows directory",
    },
    {
      writer: "saved WebFetch approval",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/settings.local.json`,
      disposition: savedApprovals,
      ...(savedApprovals === "redirect" ? { target: paths.localSettings } : {}),
      note:
        savedApprovals === "disable"
          ? "saving is disabled on this branch: the approval still applies for the session, and WS-07 keeps its open question (WS-14 §16 q2)"
          : "durable approvals are routed into the product's own project settings file (WS-07's shared-store answer, chosen explicitly by the host)",
    },
    {
      writer: "/init and config commands",
      claudeNamedTarget: `project ${FORBIDDEN_TARGETS.instructionsFile}, ${FORBIDDEN_TARGETS.projectDir}/`,
      disposition: "owned-by-product",
      note: "the product owns init/config; the vendor's own /init is never exposed as the product's",
    },
    {
      writer: "arbitrary Write/Edit/Bash",
      claudeNamedTarget: `any ${FORBIDDEN_TARGETS.instructionsFile}, ${FORBIDDEN_TARGETS.projectDir}/, ~/${FORBIDDEN_TARGETS.userPlansDir}`,
      disposition: "deny",
      note: "the permission floor below denies residual writes; plansDirectory already redirects plan mode",
    },
  ];
}

/**
 * Tools whose NAME-based route is closed on this branch (§7's `disallowedTools`).
 *
 * A SHORT LIST ON PURPOSE. `disallowedTools` covers the paths aliases miss, but it is still a name
 * mechanism: the floor below is what actually holds. What is listed here are the writers whose whole
 * PURPOSE is a vendor-named path and which have no redirected equivalent on this branch.
 */
export function officialDisallowedTools(policy: ContainmentPolicy = {}): readonly string[] {
  const denied = ["CronCreate"];
  if ((policy.savedWebFetchApprovals ?? "disable") === "disable") {
    // Nothing extra: WebFetch itself stays available; only the DURABLE approval write is refused, and
    // that refusal is the floor's business (a name-level deny here would remove the tool entirely).
  }
  return denied;
}

/** A decision from the containment floor. `deny` carries the sentence the model is shown. */
export type ContainmentDecision = { allow: true } | { allow: false; reason: string; target: string };

const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/");

/**
 * Does this path create or write one of the three forbidden targets?
 *
 * SEGMENT MATCHING, never substring: `.claude` must not match `.claude-backup`, and `CLAUDE.md` must
 * not match `MY_CLAUDE.mdx`. The user-level plans directory is matched anywhere (it is an absolute
 * path under the vendor home, which §3 already keeps out of the environment — this is the belt).
 */
export function targetsForbiddenPath(rawPath: string): { forbidden: boolean; target: string } {
  const path = norm(rawPath);
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.includes(FORBIDDEN_TARGETS.projectDir)) {
    const index = segments.indexOf(FORBIDDEN_TARGETS.projectDir);
    return { forbidden: true, target: segments[index + 1] === "plans" ? FORBIDDEN_TARGETS.userPlansDir : FORBIDDEN_TARGETS.projectDir };
  }
  if (segments[segments.length - 1] === FORBIDDEN_TARGETS.instructionsFile) return { forbidden: true, target: FORBIDDEN_TARGETS.instructionsFile };
  return { forbidden: false, target: "" };
}

/** Argument fields that carry a path on the pinned runtime's own file tools. */
const PATH_FIELDS = ["file_path", "path", "notebook_path", "directory", "target_file", "plan_file_path"] as const;

/**
 * The floor, applied to one tool call.
 *
 * `Bash` (and its siblings) are handled by scanning the COMMAND STRING for a forbidden target rather
 * than by parsing a shell: a shell parser that is 95% right is a hole, while a scan that is
 * occasionally over-strict merely denies a command whose text names a vendor-owned path — which on
 * this branch is the correct answer anyway.
 */
export function containmentDecisionFor(toolName: string, input: Record<string, unknown>): ContainmentDecision {
  const deny = (target: string, what: string): ContainmentDecision => ({
    allow: false,
    target,
    reason: `${toolName} may not create or modify ${what}: this session runs on the product's own project layout, and the vendor-named path is redirected (WS-14 §8)`,
  });
  for (const field of PATH_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const hit = targetsForbiddenPath(value);
    if (hit.forbidden) return deny(hit.target, value);
  }
  for (const field of ["command", "script", "code"] as const) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const path = norm(value);
    if (/(^|[\s"'`=(/])\.claude(\/|\s|$|["'`])/.test(path)) return deny(FORBIDDEN_TARGETS.projectDir, value);
    if (/(^|[\s"'`=(/])CLAUDE\.md(\s|$|["'`])/.test(path)) return deny(FORBIDDEN_TARGETS.instructionsFile, value);
  }
  // A durable Cron is a vendor-named write with no path argument at all — the disposition table's
  // "disable" is enforced here, where the call actually arrives.
  if (toolName === "CronCreate" && input["durable"] === true) {
    return {
      allow: false,
      target: `${FORBIDDEN_TARGETS.projectDir}/scheduled_tasks.json`,
      reason: "durable scheduled tasks are unavailable on this branch: the vendor's durable variant persists into its own project directory (WS-14 §8)",
    };
  }
  return { allow: true };
}
