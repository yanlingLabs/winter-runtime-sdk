// WS-14 §13: THE OFFICIAL BRANCH'S ERROR TAXONOMY, as typed classes.
//
// "The adapter maps failures onto distinct classes rather than one generic error, because consumers
// branch on error class and result subtype ... each reaches the projector as its own typed shape,
// NEVER a collapsed `Error`." Fourteen named failures live in that sentence, and every one of them
// gets a class here.
//
// TWO PROPERTIES EACH CLASS CARRIES, and both are load-bearing:
//
//   1. `code` — a stable, string-comparable discriminator. `instanceof` is the ordinary way to
//      branch, but a projector that has to survive two copies of this package (a host vendoring the
//      router beside an app that also vendors it) cannot rely on prototype identity. The Winter SDK's
//      own `InvalidBrandError` uses exactly this convention and says why.
//   2. `winterClass` — the NAME of the WS-03 §11 class this failure maps onto. The mapping is the
//      point of the taxonomy: the Winter branch already throws `CLIConnectionError`/`ProcessError`/
//      `ProtocolDecodeError`/`ResultError`/`AbortError`/`SessionNotFoundError`, and a host that
//      routes both branches into one projector needs to know which of ITS classes an official-branch
//      failure is the counterpart of. A string rather than the class object because this package
//      never imports the peer's classes as values — the injected instance is authoritative, and
//      `test/official/errors.test.ts` asserts every name here is a real export of it.
//
// PROCESS-LIFECYCLE CLASSES CARRY `crashClass` TOO (§9): "typed crash classes (executable-not-found,
// connection failure, malformed protocol, nonzero exit, killed) DISTINCT FROM agent-result failures".
// That distinction is the whole reason `OfficialAgentResultError` exists beside them: a turn that
// ended with `is_error: true` is not a crash, and a projector that collapsed the two would report a
// dead process to a user whose session is alive.
import { RuntimeSdkError } from "../errors.ts";

/** The WS-03 §11 classes an official-branch failure maps onto, by exported name. */
export type WinterErrorClassName =
  | "WinterSDKError"
  | "CLIConnectionError"
  | "ProcessError"
  | "ResultError"
  | "ProtocolDecodeError"
  | "AbortError"
  | "SessionNotFoundError";

/**
 * WS-14 §9's crash classes — the failures that describe the CHILD PROCESS rather than the turn.
 *
 * `killed` is the fifth member §9 names and the one that is not itself an error condition: a
 * supervised teardown kills the child on purpose, and the class exists so the projector can tell
 * "we ended it" from "it died".
 */
export type OfficialCrashClass = "executable-not-found" | "connection-failure" | "malformed-protocol" | "nonzero-exit" | "killed" | "stdout-unterminated";

/** Every code in this taxonomy, in WS-14 §13's own order. Exported so a test can assert completeness. */
export const OFFICIAL_ERROR_CODES = [
  "official_configuration_invalid",
  "official_executable_not_found",
  "official_connection_failure",
  "official_malformed_protocol",
  "official_nonzero_exit",
  "official_killed",
  "official_agent_result_failure",
  "official_api_failure",
  "official_tool_failure",
  "official_permission_denied",
  "official_mcp_failure",
  "official_session_store_failure",
  "official_session_not_found",
  "official_invalid_resume",
  "official_interrupted",
  /**
   * A SIXTH crash class, beyond §9's five (review r1, M4).
   *
   * §9 enumerates its classes by example ("executable-not-found, connection failure, malformed
   * protocol, nonzero exit, killed"), and this is the one the supervised proxy can produce that none
   * of them names: the child EXITED but its stdout pipe never closed, so the gate that waits for both
   * would wait forever — reconciliation never running, `whenSettled()` never resolving, and the
   * generation silently alive from the host's point of view.
   */
  "official_stdout_unterminated",
  /**
   * §8's POST-HOC breach (review r2, NEW-3): a call created a vendor-named path that the pre-hoc scan
   * could not see, and the sweep removed it.
   *
   * A class of its own rather than a permission denial, because it is neither: the call was permitted
   * and then produced an effect this branch forbids. A host needs to be able to count these — a
   * session that trips one has found a spelling the scanner does not know.
   */
  "official_containment_breach",
] as const;

export type OfficialErrorCode = (typeof OFFICIAL_ERROR_CODES)[number];

/**
 * The base class of the official branch's taxonomy.
 *
 * Extends the router's own `RuntimeSdkError` so a host can catch this package's whole family with one
 * `instanceof`, exactly as `src/errors.ts` promises.
 */
export abstract class OfficialBranchError extends RuntimeSdkError {
  abstract readonly code: OfficialErrorCode;
  abstract readonly winterClass: WinterErrorClassName;
  /** Present only on the process-lifecycle classes (§9). */
  readonly crashClass?: OfficialCrashClass;
  /** WS-14 §14: the internal diagnostics label of this branch, so a log line names the branch. */
  readonly branch: string;

  constructor(message: string, branchLabel: string, options?: { cause?: unknown }) {
    super(message, options);
    this.branch = branchLabel;
  }
}

/** §13.1 — an `Options` combination this branch refuses to build (§5.1's withheld options live here). */
export class OfficialConfigurationError extends OfficialBranchError {
  readonly code = "official_configuration_invalid";
  readonly winterClass = "WinterSDKError";
  /** WHICH option was wrong, so a host can point at a field rather than parse prose. */
  readonly option: string;
  constructor(args: { option: string; reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: ${args.option} — ${args.reason}`, args.branchLabel);
    this.option = args.option;
  }
}

/** §13.2 / §9 — the vendored runtime is not where the host said it was. */
export class OfficialExecutableNotFoundError extends OfficialBranchError {
  readonly code = "official_executable_not_found";
  readonly winterClass = "CLIConnectionError";
  override readonly crashClass = "executable-not-found" as const;
  readonly path: string;
  constructor(args: { path: string; branchLabel: string; cause?: unknown }) {
    super(`${args.branchLabel}: the vendored runtime was not found at ${args.path}`, args.branchLabel, args.cause === undefined ? undefined : { cause: args.cause });
    this.path = args.path;
  }
}

/** §13.3 / §9 — the child started but the stdio channel never came up. */
export class OfficialConnectionError extends OfficialBranchError {
  readonly code = "official_connection_failure";
  readonly winterClass = "CLIConnectionError";
  override readonly crashClass = "connection-failure" as const;
  constructor(args: { reason: string; branchLabel: string; cause?: unknown }) {
    super(`${args.branchLabel}: the runtime connection failed — ${args.reason}`, args.branchLabel, args.cause === undefined ? undefined : { cause: args.cause });
  }
}

/** §13.4 / §9 — a frame arrived that is not the pinned protocol. */
export class OfficialProtocolError extends OfficialBranchError {
  readonly code = "official_malformed_protocol";
  readonly winterClass = "ProtocolDecodeError";
  override readonly crashClass = "malformed-protocol" as const;
  constructor(args: { reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: malformed runtime protocol — ${args.reason}`, args.branchLabel);
  }
}

/**
 * §13.5 / §9 — the child exited nonzero.
 *
 * `stderrTail` is here because §6 rule 6 requires stderr to be DRAINED CONTINUOUSLY: the drain has to
 * put what it saw somewhere, and the exit error is the only place a consumer will look. Bounded by
 * the proxy (a runaway child must not turn an error message into a memory leak).
 */
export class OfficialNonzeroExitError extends OfficialBranchError {
  readonly code = "official_nonzero_exit";
  readonly winterClass = "ProcessError";
  override readonly crashClass = "nonzero-exit" as const;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;
  constructor(args: { exitCode: number | null; signal: string | null; stderrTail: string; branchLabel: string }) {
    super(`${args.branchLabel}: the runtime exited with code ${String(args.exitCode)}${args.signal === null ? "" : ` (signal ${args.signal})`}`, args.branchLabel);
    this.exitCode = args.exitCode;
    this.signal = args.signal;
    this.stderrTail = args.stderrTail;
  }
}

/** §9's fifth crash class — a supervised kill. Distinct from a nonzero exit: this one WE caused. */
export class OfficialKilledError extends OfficialBranchError {
  readonly code = "official_killed";
  readonly winterClass = "ProcessError";
  override readonly crashClass = "killed" as const;
  readonly signal: string;
  constructor(args: { signal: string; reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: the runtime was killed with ${args.signal} — ${args.reason}`, args.branchLabel);
    this.signal = args.signal;
  }
}

/** §8's post-hoc breach — see `OFFICIAL_ERROR_CODES`. Never a crash class: the process is healthy. */
export class OfficialContainmentBreachError extends OfficialBranchError {
  readonly code = "official_containment_breach";
  readonly winterClass = "WinterSDKError";
  readonly tool: string;
  readonly created: readonly string[];
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  constructor(args: { toolName: string; created: readonly string[]; removed: readonly string[]; retained: readonly string[]; branchLabel: string }) {
    super(
      `${args.branchLabel}: ${args.toolName} created ${args.created.length} vendor-named path(s) that the pre-hoc scan did not see; ${args.removed.length} removed, ${args.retained.length} retained (WS-14 §8)`,
      args.branchLabel,
    );
    this.tool = args.toolName;
    this.created = [...args.created];
    this.removed = [...args.removed];
    this.retained = [...args.retained];
  }
}

/** M4's sixth crash class: the child exited and its stdout never closed. See `OFFICIAL_ERROR_CODES`. */
export class OfficialStdoutUnterminatedError extends OfficialBranchError {
  readonly code = "official_stdout_unterminated";
  readonly winterClass = "ProcessError";
  override readonly crashClass = "stdout-unterminated" as const;
  readonly graceMs: number;
  constructor(args: { graceMs: number; branchLabel: string }) {
    super(`${args.branchLabel}: the runtime exited but its stdout did not close within ${args.graceMs}ms; the exit was forwarded on the grace timer`, args.branchLabel);
    this.graceMs = args.graceMs;
  }
}

/**
 * §13.6 — the TURN failed, and the process is fine.
 *
 * The class §9 exists to keep separate from the five above it. `subtype` is the result message's own
 * subtype, which is what a consumer branches on ("consumers branch on error class AND result
 * subtype").
 */
export class OfficialAgentResultError extends OfficialBranchError {
  readonly code = "official_agent_result_failure";
  readonly winterClass = "ResultError";
  readonly subtype: string;
  constructor(args: { subtype: string; detail?: string; branchLabel: string }) {
    super(`${args.branchLabel}: the agent turn failed (${args.subtype})${args.detail === undefined ? "" : ` — ${args.detail}`}`, args.branchLabel);
    this.subtype = args.subtype;
  }
}

/** §13.7 — the provider request failed. Never the same class as a crashed child. */
export class OfficialApiError extends OfficialBranchError {
  readonly code = "official_api_failure";
  readonly winterClass = "ResultError";
  readonly status?: number;
  constructor(args: { reason: string; status?: number; branchLabel: string }) {
    super(`${args.branchLabel}: the provider request failed${args.status === undefined ? "" : ` (HTTP ${args.status})`} — ${args.reason}`, args.branchLabel);
    if (args.status !== undefined) this.status = args.status;
  }
}

/** §13.8 — one tool call failed; the turn continues. */
export class OfficialToolError extends OfficialBranchError {
  readonly code = "official_tool_failure";
  readonly winterClass = "WinterSDKError";
  readonly tool: string;
  constructor(args: { tool: string; reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: the tool ${args.tool} failed — ${args.reason}`, args.branchLabel);
    this.tool = args.tool;
  }
}

/** §13.9 — a permission decision denied the call. A normal outcome, and still its own class. */
export class OfficialPermissionDeniedError extends OfficialBranchError {
  readonly code = "official_permission_denied";
  readonly winterClass = "WinterSDKError";
  readonly tool: string;
  constructor(args: { tool: string; reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: ${args.tool} was denied — ${args.reason}`, args.branchLabel);
    this.tool = args.tool;
  }
}

/** §13.10 — an MCP server failed to start, connect, or answer. */
export class OfficialMcpError extends OfficialBranchError {
  readonly code = "official_mcp_failure";
  readonly winterClass = "WinterSDKError";
  readonly server: string;
  constructor(args: { server: string; reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: the MCP server ${args.server} failed — ${args.reason}`, args.branchLabel);
    this.server = args.server;
  }
}

/**
 * §13.11 / §5 — `mirror_error`: the canonical store did not receive everything.
 *
 * NON-FATAL TO THE TURN, and the class says so in a field rather than in prose: "MUST NOT
 * retroactively fail the model turn". What it DOES do is set `transcriptHealth: repair-required` and
 * block handoff until reconciliation — `recordedLocalWriteRoot` is the root that reconciliation runs
 * against (§1), which is why it travels with the error.
 */
export class OfficialSessionStoreError extends OfficialBranchError {
  readonly code = "official_session_store_failure";
  readonly winterClass = "WinterSDKError";
  readonly fatalToTurn = false;
  readonly transcriptHealth = "repair-required" as const;
  readonly recordedLocalWriteRoot?: string;
  constructor(args: { reason: string; recordedLocalWriteRoot?: string; branchLabel: string }) {
    super(`${args.branchLabel}: the session store mirror failed — ${args.reason}`, args.branchLabel);
    if (args.recordedLocalWriteRoot !== undefined) this.recordedLocalWriteRoot = args.recordedLocalWriteRoot;
  }
}

/** §13.12 — the backend session id is not resolvable (WS-05 §7's rules decide "not found"). */
export class OfficialSessionNotFoundError extends OfficialBranchError {
  readonly code = "official_session_not_found";
  readonly winterClass = "SessionNotFoundError";
  readonly reason: "not_found" | "ambiguous";
  constructor(args: { sessionId: string; reason: "not_found" | "ambiguous"; branchLabel: string }) {
    super(`${args.branchLabel}: session ${args.sessionId} is ${args.reason === "ambiguous" ? "ambiguous across projects" : "not found"}`, args.branchLabel);
    this.reason = args.reason;
  }
}

/** §13.13 — a resume or fork request this branch refuses to make (§5.1's fork rules). */
export class OfficialInvalidResumeError extends OfficialBranchError {
  readonly code = "official_invalid_resume";
  readonly winterClass = "WinterSDKError";
  constructor(args: { reason: string; branchLabel: string }) {
    super(`${args.branchLabel}: invalid resume/fork — ${args.reason}`, args.branchLabel);
  }
}

/** §13.14 / §9 — an interrupt or a cancellation. `AbortError` is its Winter counterpart. */
export class OfficialInterruptedError extends OfficialBranchError {
  readonly code = "official_interrupted";
  readonly winterClass = "AbortError";
  /** WS-14 §9's four gestures — which one produced this. */
  readonly gesture: "interrupt-turn" | "stop-task" | "end-session" | "kill-process";
  constructor(args: { gesture: OfficialInterruptedError["gesture"]; branchLabel: string }) {
    super(`${args.branchLabel}: the generation was interrupted (${args.gesture})`, args.branchLabel);
    this.gesture = args.gesture;
  }
}

/** Narrows anything to this branch's taxonomy — the one `instanceof` a projector needs. */
export function isOfficialBranchError(value: unknown): value is OfficialBranchError {
  return value instanceof OfficialBranchError;
}
