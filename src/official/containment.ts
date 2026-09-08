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

import { aliasDenyNames, type AliasedBuiltin } from "./aliases.ts";

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
  /** What §8 SAYS should happen to this writer. */
  disposition: "redirect" | "disable" | "owned-by-product" | "deny";
  target?: string;
  /**
   * What THIS PACKAGE actually does about it (review r1, M2).
   *
   * The distinction is the finding: a row can say `redirect` while the router — which implements no
   * tools — has nothing to redirect to, and a reader of the table alone would believe the writer was
   * handled. `floor-deny` means the permission floor refuses the call; `deny-list` means the name is
   * in `disallowedTools`; `approval-stripped` means the durable permission update is dropped at the
   * bridge; `host-implementation` means the host installed the replacement and owns it from there.
   */
  enforcement: "floor-deny" | "deny-list" | "approval-stripped" | "host-implementation" | "host-ui";
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
  /**
   * The two §8 rows whose disposition is REDIRECT, and the honest fact about who can perform one.
   *
   * REVIEW r1, M2 — MEASURED. `EnterWorktree`, `Agent`/`Task` with `isolation: "worktree"` and named
   * `Workflow` resolution were all reaching the floor and being ALLOWED: the router implements no
   * tools, so it has nothing to redirect them TO, and the disposition table said "redirect" while the
   * code did nothing. In a non-git working directory they then failed for an unrelated reason and the
   * proof read as containment.
   *
   * So the router's own enforcement is a DENY until the host installs the schema-compatible
   * replacement §8 describes — `"host-replacement"` is the host saying it has, and only then does the
   * vendor's own writer become the host's problem rather than a vendor-named write.
   */
  worktrees?: "deny" | "host-replacement";
  workflows?: "deny" | "host-replacement";
  /** The product's project directory, so a refusal can NAME where the replacement lives. */
  projectDirName?: string;
  /**
   * Aliased built-ins this deployment denies.
   *
   * Each expands to BOTH names, because the pinned runtime checks the deny list AFTER alias
   * resolution — see `aliasDenyNames` for the measurement. A host that listed only the built-in would
   * have a rule that does nothing.
   */
  deniedAliasedBuiltins?: readonly AliasedBuiltin[];
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
      enforcement: (policy.worktrees ?? "deny") === "deny" ? "floor-deny" : "host-implementation",
      note: "the router implements no tools, so until the host installs the schema-compatible replacement the vendor's own writer is denied at the floor",
    },
    {
      writer: "CronCreate with durable: true",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/scheduled_tasks.json`,
      disposition: "disable",
      enforcement: "deny-list",
      note: "the name is in `disallowedTools`, so the runtime refuses it before the callback; the floor also refuses a truthy `durable` for a host that re-enables the tool",
    },
    {
      writer: "named Workflow resolution",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/workflows/`,
      disposition: "redirect",
      target: paths.workflows,
      enforcement: (policy.workflows ?? "deny") === "deny" ? "floor-deny" : "host-implementation",
      note: "named resolution reads the vendor's own directory; denied at the floor until the host's replacement resolves under the product's own",
    },
    {
      writer: "saved WebFetch approval",
      claudeNamedTarget: `${FORBIDDEN_TARGETS.projectDir}/settings.local.json`,
      disposition: savedApprovals,
      ...(savedApprovals === "redirect" ? { target: paths.localSettings } : {}),
      enforcement: savedApprovals === "disable" ? "approval-stripped" : "host-implementation",
      note:
        savedApprovals === "disable"
          ? "saving is disabled on this branch: the approval still applies for the session, and WS-07 keeps its open question (WS-14 §16 q2)"
          : "durable approvals are routed into the product's own project settings file (WS-07's shared-store answer, chosen explicitly by the host)",
    },
    {
      writer: "/init and config commands",
      claudeNamedTarget: `project ${FORBIDDEN_TARGETS.instructionsFile}, ${FORBIDDEN_TARGETS.projectDir}/`,
      disposition: "owned-by-product",
      enforcement: "host-ui",
      note: "a slash command is user-facing surface, not a tool the model can call: the product owns init/config and its UI never presents the vendor's own /init as the product's",
    },
    {
      writer: "arbitrary Write/Edit/Bash",
      claudeNamedTarget: `any ${FORBIDDEN_TARGETS.instructionsFile}, ${FORBIDDEN_TARGETS.projectDir}/, ~/${FORBIDDEN_TARGETS.userPlansDir}`,
      disposition: "deny",
      enforcement: "floor-deny",
      note: "the permission floor denies residual writes by PATH, case-folded and Unicode-normalized; plansDirectory already redirects plan mode",
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
export function officialDisallowedTools(policy: ContainmentPolicy = {}, brand?: Pick<BrandProfile, "mcpServerName">): readonly string[] {
  const denied = ["CronCreate"];
  // WebFetch itself stays available whatever the saved-approval disposition is: only the DURABLE
  // approval write is refused, and that refusal is the floor's business — a name-level deny here
  // would remove the tool entirely rather than remove its ability to persist an approval.
  if (policy.deniedAliasedBuiltins !== undefined && brand !== undefined) {
    for (const builtin of policy.deniedAliasedBuiltins) denied.push(...aliasDenyNames(builtin, brand));
  }
  return denied;
}

/** A decision from the containment floor. `deny` carries the sentence the model is shown. */
export type ContainmentDecision = { allow: true } | { allow: false; reason: string; target: string };

const norm = (path: string): string => path.replace(/\\/g, "/").replace(/\/+/g, "/");

/**
 * The comparison every name check in this module uses: Unicode-normalized, then case-folded.
 *
 * REVIEW r1, C1 — AND THE REASON IS A MEASUREMENT, NOT A STYLE PREFERENCE. The first version compared
 * `.claude` and `CLAUDE.md` case-EXACTLY. macOS APFS is case-INSENSITIVE by default, so a real
 * model-emitted `Write` to `claude.md` and to `.Claude/settings.json` went through an approving
 * broker, created files, and made `existsSync("<cwd>/CLAUDE.md")` and `existsSync("<cwd>/.claude")` —
 * row 14's own predicates — both TRUE. The row was falsifiable in three tool calls on the platform
 * WS-14's own paths say is a first-class host.
 *
 * FOLDED ALWAYS, NOT ONLY ON A CASE-INSENSITIVE FILESYSTEM. A case-folded match is forbidden
 * everywhere: on a case-sensitive volume `claude.md` is a different file, but it is still a file
 * whose name is the vendor's instructions file in the only sense a human or a later `mv` cares about,
 * and a floor whose behaviour depended on the volume would be a floor nobody could reason about.
 *
 * NFC FIRST, because macOS stores decomposed forms: a name that arrives NFD and a name that arrives
 * NFC are the same file, and comparing the raw strings would let one of the two spellings through.
 * For these ASCII names the normalization is a no-op today; it is here so a future brand-derived or
 * user-supplied name cannot reintroduce the hole.
 */
const fold = (value: string): string => value.normalize("NFC").toLowerCase();

const FORBIDDEN_PROJECT_DIR = fold(FORBIDDEN_TARGETS.projectDir);
const FORBIDDEN_INSTRUCTIONS_FILE = fold(FORBIDDEN_TARGETS.instructionsFile);

/**
 * Does this path create or write one of the three forbidden targets?
 *
 * SEGMENT MATCHING, never substring: `.claude` must not match `.claude-backup`, and `CLAUDE.md` must
 * not match `MY_CLAUDE.mdx`. The user-level plans directory is matched anywhere (it is an absolute
 * path under the vendor home, which §3 already keeps out of the environment — this is the belt).
 * Every comparison goes through `fold` — see its own note for the measurement that made that
 * mandatory.
 */
export function targetsForbiddenPath(rawPath: string): { forbidden: boolean; target: string } {
  const segments = norm(rawPath)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(fold);
  const index = segments.indexOf(FORBIDDEN_PROJECT_DIR);
  if (index >= 0) {
    return { forbidden: true, target: segments[index + 1] === "plans" ? FORBIDDEN_TARGETS.userPlansDir : FORBIDDEN_TARGETS.projectDir };
  }
  if (segments[segments.length - 1] === FORBIDDEN_INSTRUCTIONS_FILE) return { forbidden: true, target: FORBIDDEN_TARGETS.instructionsFile };
  return { forbidden: false, target: "" };
}

/**
 * Argument fields that carry a path on the pinned runtime's own file tools.
 *
 * BOTH SPELLINGS OF EACH (review r1, m4): the pinned runtime uses `file_path`, but a tool added
 * tomorrow — or a host-provided one — may use `filePath`, and a floor that is a closed list of names
 * should at least not be a closed list of NAMING CONVENTIONS.
 */
const PATH_FIELDS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "directory",
  "dir",
  "target_file",
  "targetFile",
  "file",
  "plan_file_path",
  "planFilePath",
] as const;

/**
 * The command scan's two patterns (review r1, C1 + m5).
 *
 * CASE-INSENSITIVE, and bounded by a character class rather than by the small set of delimiters the
 * first version listed. `D=.claude; mkdir -p $PWD/$D` was measured going through — `.claude` was
 * followed by `;`, which the old trailing set did not contain, and the command then wrote a real file
 * into a real `.claude` directory through the real runtime.
 *
 * WHAT THIS STILL CANNOT SEE, stated plainly rather than implied: a command that never spells the
 * name (`D=$(echo .cl)aude`), or one that builds it from a variable defined in an earlier call. A
 * shell parser that is 95% right is a worse answer than an honest scan plus a host-side `PostToolUse`
 * sweep, which is where WS-08 puts must-see-every-call logic.
 */
const COMMAND_PROJECT_DIR_RE = /(?:^|[^A-Za-z0-9_.-])\.claude(?![A-Za-z0-9_-])/i;
const COMMAND_INSTRUCTIONS_FILE_RE = /(?:^|[^A-Za-z0-9_-])claude\.md(?![A-Za-z0-9_.-])/i;

/**
 * The floor, applied to one tool call.
 *
 * `Bash` (and its siblings) are handled by scanning the COMMAND STRING for a forbidden target rather
 * than by parsing a shell: a shell parser that is 95% right is a hole, while a scan that is
 * occasionally over-strict merely denies a command whose text names a vendor-owned path — which on
 * this branch is the correct answer anyway.
 */
/** `true`, `"true"`, `1`, `"1"`, `"yes"` — every spelling a JSON-shaped tool argument can carry. */
function isTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/** The §8 writers whose vendor-named target has no path argument to scan. */
const WORKTREE_TOOLS = ["EnterWorktree", "ExitWorktree", "WorktreeCreate"] as const;
const AGENT_TOOLS = ["Task", "Agent"] as const;
const WORKFLOW_TOOLS = ["Workflow"] as const;

export function containmentDecisionFor(toolName: string, input: Record<string, unknown>, policy: ContainmentPolicy = {}): ContainmentDecision {
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
    const path = norm(value).normalize("NFC");
    if (COMMAND_PROJECT_DIR_RE.test(path)) return deny(FORBIDDEN_TARGETS.projectDir, value);
    if (COMMAND_INSTRUCTIONS_FILE_RE.test(path)) return deny(FORBIDDEN_TARGETS.instructionsFile, value);
  }
  // THE §8 ROWS WITH NO PATH ARGUMENT (review r1, M2). Each names the redirect target in its own
  // refusal, so the model — and a host reading the tool_result — learns where the replacement lives
  // rather than only that something was refused.
  const paths = containmentPaths({ projectDirName: policy.projectDirName ?? "" });
  if ((policy.worktrees ?? "deny") === "deny") {
    if ((WORKTREE_TOOLS as readonly string[]).includes(toolName)) {
      return {
        allow: false,
        target: `${FORBIDDEN_TARGETS.projectDir}/worktrees/`,
        reason: `${toolName} writes the vendor's own worktree directory; on this branch worktrees belong under ${paths.worktrees || "the product's project directory"} and the host's schema-compatible replacement owns them (WS-14 §8)`,
      };
    }
    if ((AGENT_TOOLS as readonly string[]).includes(toolName) && String(input["isolation"] ?? "") === "worktree") {
      return {
        allow: false,
        target: `${FORBIDDEN_TARGETS.projectDir}/worktrees/`,
        reason: `an isolated agent worktree writes the vendor's own worktree directory; on this branch it belongs under ${paths.worktrees || "the product's project directory"} (WS-14 §8)`,
      };
    }
  }
  if ((policy.workflows ?? "deny") === "deny" && (WORKFLOW_TOOLS as readonly string[]).includes(toolName)) {
    return {
      allow: false,
      target: `${FORBIDDEN_TARGETS.projectDir}/workflows/`,
      reason: `named workflow resolution reads the vendor's own workflows directory; on this branch workflows resolve under ${paths.workflows || "the product's project directory"} (WS-14 §8, D8)`,
    };
  }
  // A durable Cron is a vendor-named write with no path argument at all — the disposition table's
  // "disable" is enforced here, where the call actually arrives.
  // TRUTHY, not strict `true` (review r1, m4): a host that re-enables the tool — which the deny list's
  // own comment anticipates — must not be able to smuggle a durable task past the floor by sending
  // `"true"`.
  if (toolName === "CronCreate" && isTruthy(input["durable"])) {
    return {
      allow: false,
      target: `${FORBIDDEN_TARGETS.projectDir}/scheduled_tasks.json`,
      reason: "durable scheduled tasks are unavailable on this branch: the vendor's durable variant persists into its own project directory (WS-14 §8)",
    };
  }
  return { allow: true };
}
