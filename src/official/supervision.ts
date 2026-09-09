// WS-14 §9: PROCESS SUPERVISION, INTERRUPT, AND STOP.
//
// "The daemon parents every Claude child; PID **plus process start identity** (never bare PID),
// continuous stderr drain, per-session resource quotas, typed crash classes DISTINCT FROM
// agent-result failures."
//
// THE PAIR IS THE IDENTITY. An operating system recycles pids, and the window in which it does is
// exactly the window a supervisor is trying to reason about — a daemon that restarted, found pid
// 4711 alive and concluded "my child is still running" has adopted a stranger. `startedAt` is the
// second half, and `revalidateProcessIdentity` refuses the recycled case explicitly (the spine's
// directory-store test asserts the same property from the store's side).
//
// THE FOUR GESTURES ARE FOUR OPERATIONS, and conflating any two of them is a user-visible bug: §9's
// table maps stop-the-turn onto `interrupt()` (which, WITH `perTaskStopAffordance`, preserves
// background agents and workflows), stop-one-task onto the task-stop API, end-the-session onto a
// graceful close plus supervised teardown, and kill onto the proxy's kill AFTER the reconciliation
// barrier — "last resort; never skips the transcript-only barrier".
import type { OfficialBranchError, OfficialCrashClass } from "./errors.ts";
import { OfficialInterruptedError } from "./errors.ts";
import type { ProcessIdentity } from "./spawn-proxy.ts";

/**
 * §9's per-session quotas.
 *
 * ANTHROPIC'S OWN PLANNING FIGURES, carried as initial defaults and labelled as what they are: "these
 * are capacity-planning numbers, NOT guarantees; Winter's enforced per-session quotas need product
 * tuning before release" (§16 open question 3). They ship as data so a host can read and override
 * them; nothing in this package enforces them, because enforcement is the daemon's (Phase 8).
 */
export const DEFAULT_SESSION_QUOTAS = {
  memoryBytes: 1024 * 1024 * 1024,
  diskBytes: 5 * 1024 * 1024 * 1024,
  cpus: 1,
  provenance: "Anthropic's published capacity-planning figures, adopted as initial defaults; not guarantees and not yet product-tuned (WS-14 §9/§16)",
} as const;

/**
 * Does a live process still belong to the identity we recorded?
 *
 * BOTH HALVES MUST MATCH. A pid alone revalidates a recycled stranger; a start time alone matches
 * nothing at all. Anything absent is "not revalidated" rather than "assume yes" — an unrevalidated
 * handle is marked unavailable by the directory's own recovery (WS-15 §6.4 step 2), which is a
 * recoverable state, while a wrongly-revalidated one silently steers a stranger's process.
 */
export function revalidateProcessIdentity(recorded: ProcessIdentity | undefined, observed: ProcessIdentity | undefined): boolean {
  if (recorded === undefined || observed === undefined) return false;
  return recorded.pid === observed.pid && recorded.startedAt === observed.startedAt;
}

/** §9's host gestures. */
export type CancellationGesture = "stop-turn" | "stop-background-task" | "end-session" | "kill-process";

/** What a gesture maps onto, as data — so a host renders §9's table rather than re-deriving it. */
export interface CancellationMapping {
  gesture: CancellationGesture;
  operation: string;
  effect: string;
  /** True when this gesture must not run before the §6 reconciliation barrier has completed. */
  afterReconciliationBarrier: boolean;
}

export const CANCELLATION_MAPPINGS: readonly CancellationMapping[] = [
  {
    gesture: "stop-turn",
    operation: "query.interrupt()",
    effect: "the foreground turn stops; background agents and workflows continue (this is what perTaskStopAffordance buys — without it, interruption also stops background work)",
    afterReconciliationBarrier: false,
  },
  {
    gesture: "stop-background-task",
    operation: "the task-stop API, with the task id",
    effect: "that task only; a `stopped` status notification follows through the message stream, because cancellation is part of the event model rather than a method return",
    afterReconciliationBarrier: false,
  },
  {
    gesture: "end-session",
    operation: "graceful query close, then supervised teardown",
    effect: "the turn is drained per the handoff-adjacent close rules and the generation is released",
    afterReconciliationBarrier: false,
  },
  {
    gesture: "kill-process",
    operation: "the supervised proxy's kill",
    effect: "last resort, the unexpected-exit path — it never skips the transcript-only barrier, so the recorded root is reconciled before the exit is forwarded",
    afterReconciliationBarrier: true,
  },
] as const;

export function cancellationMappingFor(gesture: CancellationGesture): CancellationMapping {
  const found = CANCELLATION_MAPPINGS.find((mapping) => mapping.gesture === gesture);
  /* c8 ignore next */
  if (found === undefined) throw new TypeError(`unknown cancellation gesture: ${String(gesture)}`);
  return found;
}

/** The typed error a gesture produces when it ends a generation (§13's interrupt/cancellation class). */
export function interruptionFor(gesture: CancellationGesture, branchLabel: string): OfficialInterruptedError {
  const mapped = {
    "stop-turn": "interrupt-turn",
    "stop-background-task": "stop-task",
    "end-session": "end-session",
    "kill-process": "kill-process",
  } as const;
  return new OfficialInterruptedError({ gesture: mapped[gesture], branchLabel });
}

/**
 * §9's distinction, as a predicate: is this a PROCESS failure or a TURN failure?
 *
 * The projector branches on it, and the two must never collapse: a turn that ended `is_error: true`
 * leaves a healthy child that can take the next message, while a crash class means there is nothing
 * left to send to.
 */
export function crashClassOf(error: unknown): OfficialCrashClass | undefined {
  return (error as OfficialBranchError | undefined)?.crashClass;
}

export function isProcessCrash(error: unknown): boolean {
  return crashClassOf(error) !== undefined;
}
