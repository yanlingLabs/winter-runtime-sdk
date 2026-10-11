/** Guest process transport only. It never builds a local RunHome or starts a host process. */
import type { SpawnClaudeCodeProcess, SpawnedRuntimeProcess, SpawnRuntimeOptions } from "@yanlinglabs/winter-agent-sdk";
import { randomUUID } from "node:crypto";

export const GUEST_PROCESS_PROTOCOL_VERSION = 1;
export const GUEST_PROCESS_CAPABILITY = "runtime-stdio-v1";
export const GUEST_REQUIRED_RUNTIME_CAPABILITIES = [GUEST_PROCESS_CAPABILITY, "confined-guest-posture-v1"] as const;

export interface GuestRuntimeIdentity {
  protocolVersion: typeof GUEST_PROCESS_PROTOCOL_VERSION;
  workspaceId: string;
  sessionId: string;
  incarnationId: string;
  leaseEpoch: number;
  configRevision: number;
  grantRevision: number;
  policyRevision: number;
}
export interface GuestLaunch {
  identity: GuestRuntimeIdentity;
  /** Absolute guest image executable, not a host PATH lookup. */
  executable: string;
  cwd: string;
  /** Built inside the protected guest; never a serialized host RunHome object. */
  runHome: string;
  storeHome: string;
  environment: Readonly<Record<string, string>>;
}
export interface GuestRuntimeOpenRequest extends GuestLaunch {
  launchAttemptId: string;
  args: readonly string[];
}
export type GuestRuntimeEvent =
  | { type: "stdout" | "stderr"; identity: GuestRuntimeIdentity; launchAttemptId: string; chunk: string }
  | { type: "exit"; identity: GuestRuntimeIdentity; launchAttemptId: string; code: number | null; signal: string | null };
export interface GuestRuntimeConnection {
  identity: GuestRuntimeIdentity;
  launchAttemptId: string;
  protocolVersion: number;
  capabilities: readonly string[];
  events: AsyncIterable<GuestRuntimeEvent>;
  writeStdin(chunk: string): Promise<void>;
  closeStdin(): Promise<void>;
  /** Signal by this connection's authenticated guest process handle, never by Mac PID. */
  signal(signal: "SIGTERM" | "SIGKILL"): Promise<void>;
}
export interface GuestRuntimeProcessChannel {
  /** Builds/validates the guest RunHome and immutable runtime manifest before any process starts. */
  prepareRuntime(launch: GuestLaunch, signal: AbortSignal): Promise<{ identity: GuestRuntimeIdentity; protocolVersion: number; capabilities: readonly string[] }>;
  /** Authenticates/revalidates identity and grants on the protected channel; no implicit retry. */
  openRuntime(request: GuestRuntimeOpenRequest, signal: AbortSignal): Promise<GuestRuntimeConnection>;
  /** Authenticated host owner closes this minted attempt, including admission for a late start.
   * Never resolve this against an unvalidated returned handle or a bare session/PID. */
  cleanupRuntimeAttempt(owner: { identity: GuestRuntimeIdentity; launchAttemptId: string }): Promise<void>;
}
export type GuestRuntimeErrorCode = "invalid_launch" | "credential_forwarding_refused" | "unsupported_launch_config" | "binding_mismatch" | "unsupported_protocol" | "unsupported_capability" | "buffer_limit" | "transport_lost" | "startup_timeout";
export class GuestRuntimeError extends Error {
  constructor(readonly code: GuestRuntimeErrorCode, message: string, readonly effectsUncertain = false) {
    super(message); this.name = "GuestRuntimeError";
  }
}
const identityKeys = ["protocolVersion", "workspaceId", "sessionId", "incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const;
function sameIdentity(actual: GuestRuntimeIdentity, expected: GuestRuntimeIdentity): boolean {
  return actual !== null && typeof actual === "object" && identityKeys.every((key) => actual[key] === expected[key]);
}
function guestPath(value: string, label: string): void {
  if (!value.startsWith("/") || value.includes("\0") || value.split("/").some((part) => part === "." || part === "..")) {
    throw new GuestRuntimeError("invalid_launch", `${label} must be an absolute admitted guest path without traversal`);
  }
}
const allowedEnvironment = new Set(["PATH", "LANG", "LC_ALL", "HOME", "TMPDIR", "WINTER_HOME", "WINTER_STORE_HOME", "WINTER_PLUGIN_CACHE_DIR"]);
const forwardedConfig = new Set(["sessionId", "cwd", "model", "permissionMode", "maxTurns", "resume", "persistSession", "brand", "allowedTools", "disallowedTools", "tools", "executionPosture"]);

class ChunkQueue implements AsyncIterable<string> {
  private chunks: string[] = [];
  private bytes = 0;
  private closed = false;
  private failure: GuestRuntimeError | undefined;
  private wake: (() => void) | undefined;
  constructor(private readonly limit: number) {}
  push(chunk: string): void {
    if (this.closed || chunk.length === 0) return;
    const bytes = Buffer.byteLength(chunk);
    if (this.bytes + bytes > this.limit || this.chunks.length >= 4096) throw new GuestRuntimeError("buffer_limit", "guest output backlog exceeded its byte or chunk bound", true);
    this.chunks.push(chunk); this.bytes += bytes; this.wake?.(); this.wake = undefined;
  }
  end(failure?: GuestRuntimeError): void {
    this.closed = true; this.failure = failure;
    if (failure) { this.chunks = []; this.bytes = 0; }
    this.wake?.(); this.wake = undefined;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      if (this.failure) throw this.failure;
      const chunk = this.chunks.shift();
      if (chunk !== undefined) { this.bytes -= Buffer.byteLength(chunk); yield chunk; continue; }
      if (this.closed) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}

/** Explicit adapter over authenticated guest process I/O. SDK framing/control callbacks stay SDK-owned. */
export function createGuestRuntimeSpawn(options: {
  launch: GuestLaunch;
  channel: GuestRuntimeProcessChannel;
  maxBufferedBytes?: number;
  startupTimeoutMs?: number;
}): SpawnClaudeCodeProcess {
  const launch: GuestLaunch = Object.freeze({ ...options.launch, identity: Object.freeze({ ...options.launch.identity }), environment: Object.freeze({ ...options.launch.environment }) });
  for (const key of ["workspaceId", "sessionId", "incarnationId"] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(launch.identity[key])) throw new GuestRuntimeError("invalid_launch", `invalid ${key}`);
  }
  for (const key of ["leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const) {
    if (!Number.isSafeInteger(launch.identity[key]) || launch.identity[key] < 0) throw new GuestRuntimeError("invalid_launch", `invalid ${key}`);
  }
  if (launch.identity.protocolVersion !== GUEST_PROCESS_PROTOCOL_VERSION) throw new GuestRuntimeError("unsupported_protocol", "unsupported guest process protocol");
  for (const key of ["executable", "cwd", "runHome", "storeHome"] as const) guestPath(launch[key], key);
  for (const [key, value] of Object.entries(launch.environment)) {
    if (!allowedEnvironment.has(key) || value.includes("\0")) throw new GuestRuntimeError("credential_forwarding_refused", "guest environment contains an unadmitted variable");
  }
  const limit = options.maxBufferedBytes ?? 4 * 1024 * 1024;
  const timeout = options.startupTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(timeout) || timeout < 1) throw new GuestRuntimeError("invalid_launch", "invalid transport bounds");

  return (sdk: SpawnRuntimeOptions): SpawnedRuntimeProcess => {
    if (sdk.cwd !== launch.cwd || sdk.args.length !== 3 || sdk.args[0] !== "--run" || sdk.args[1] !== "--config-json") throw new GuestRuntimeError("invalid_launch", "guest runtime accepts only its admitted SDK launch");
    let config: Record<string, unknown>;
    try { config = JSON.parse(sdk.args[2]!) as Record<string, unknown>; }
    catch { throw new GuestRuntimeError("invalid_launch", "invalid guest runtime configuration"); }
    if (!config || Array.isArray(config) || typeof config !== "object" || config.sessionId !== launch.identity.sessionId || config.cwd !== launch.cwd || (config.resume !== undefined && config.resume !== launch.identity.sessionId)) throw new GuestRuntimeError("binding_mismatch", "SDK session/cwd/resume does not match authenticated guest launch");
    if (config.hostCredentials || config.hostMessaging) throw new GuestRuntimeError("credential_forwarding_refused", "legacy credential/session delegation callbacks are not guest capabilities");
    for (const key of Object.keys(config)) if (!forwardedConfig.has(key)) throw new GuestRuntimeError("unsupported_launch_config", `guest launch configuration ${key} has no admitted transport contract`);
    const guestConfig = { ...config, executionPosture: "confined-guest", winterHome: launch.runHome, storeHome: launch.storeHome, settingSources: [] };
    const request: GuestRuntimeOpenRequest = Object.freeze({ ...launch, launchAttemptId: randomUUID(), identity: Object.freeze({ ...launch.identity }), environment: Object.freeze({ ...launch.environment }), args: Object.freeze(["--run", "--config-json", JSON.stringify(guestConfig)]) });
    const stdout = new ChunkQueue(limit); const stderr = new ChunkQueue(limit);
    const abort = new AbortController();
    let connection: GuestRuntimeConnection | undefined;
    let done = false; let stdinClosed = false; let pendingBytes = 0; let pendingWrites = 0;
    let requestedSignal: "SIGTERM" | "SIGKILL" | undefined;
    let startupPhase: "preparing" | "opening" | "connected" = "preparing";
    let cleanupRequested = false;
    const cleanupAttempt = (): void => {
      if (cleanupRequested || startupPhase === "preparing") return;
      cleanupRequested = true;
      void options.channel.cleanupRuntimeAttempt({ identity: request.identity, launchAttemptId: request.launchAttemptId }).catch(() => {});
    };
    let resolveExit!: (exit: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => { resolveExit = resolve; });
    let timer: ReturnType<typeof setTimeout>;
    const finish = (exit: { code: number | null; signal: string | null }, error?: GuestRuntimeError): void => {
      if (done) return;
      done = true; clearTimeout(timer); abort.abort(); sdk.signal?.removeEventListener("abort", onAbort);
      stdout.end(error); stderr.end(error); resolveExit(exit);
    };
    const fail = (error: GuestRuntimeError): void => {
      if (done) return;
      requestedSignal = "SIGKILL";
      if (connection) void connection.signal("SIGKILL").catch(() => {});
      else cleanupAttempt();
      finish({ code: null, signal: null }, error);
    };
    const signal = (value: string = "SIGTERM"): void => {
      if (done) return;
      if (value !== "SIGTERM" && value !== "SIGKILL") throw new GuestRuntimeError("invalid_launch", "unsupported guest signal");
      requestedSignal = requestedSignal === "SIGKILL" ? "SIGKILL" : value;
      stdinClosed = true;
      if (connection) void connection.signal(requestedSignal).catch(() => fail(new GuestRuntimeError("transport_lost", "guest signal delivery failed", true)));
      else if (startupPhase === "preparing") finish({ code: null, signal: requestedSignal });
      else { cleanupAttempt(); finish({ code: null, signal: null }, new GuestRuntimeError("transport_lost", "guest opening cancelled before process acknowledgment", true)); }
    };
    const onAbort = (): void => signal("SIGTERM");
    sdk.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => fail(new GuestRuntimeError("startup_timeout", "guest runtime start was not acknowledged", true)), timeout);
    const waitStartup = <T>(pending: Promise<T>): Promise<T> => new Promise((resolve,reject)=>{
      const stopped=()=>reject(new GuestRuntimeError("transport_lost", "guest startup cancelled", startupPhase === "opening"));
      abort.signal.addEventListener("abort",stopped,{once:true});
      pending.then(resolve,reject).finally(()=>abort.signal.removeEventListener("abort",stopped));
      if(abort.signal.aborted)stopped();
    });
    const ready = Promise.resolve().then(async () => {
      if (sdk.signal?.aborted) { finish({ code: null, signal: "SIGTERM" }); return undefined; }
      if (done) return undefined;
      const prepared = await waitStartup(options.channel.prepareRuntime(launch, abort.signal));
      if (done || requestedSignal) return undefined;
      if (!sameIdentity(prepared.identity, launch.identity)) throw new GuestRuntimeError("binding_mismatch", "guest preparation has stale authority");
      if (prepared.protocolVersion !== GUEST_PROCESS_PROTOCOL_VERSION) throw new GuestRuntimeError("unsupported_protocol", "guest process protocol mismatch");
      if (!GUEST_REQUIRED_RUNTIME_CAPABILITIES.every((capability) => prepared.capabilities.includes(capability))) throw new GuestRuntimeError("unsupported_capability", "guest runtime required capabilities missing");
      startupPhase = "opening";
      const pendingOpen = options.channel.openRuntime(request, abort.signal);
      // The opener may ignore cancellation or acknowledge late. Always clean that late process,
      // without waiting on a signal acknowledgment to settle the SDK cancellation.
      void pendingOpen.then(()=>{if(done)cleanupAttempt();},()=>{});
      const opened = await waitStartup(pendingOpen);
      if (done) { cleanupAttempt(); return undefined; }
      if (!sameIdentity(opened.identity, launch.identity) || opened.launchAttemptId !== request.launchAttemptId) throw new GuestRuntimeError("binding_mismatch", "guest launch acknowledgment has foreign ownership", true);
      connection = opened;
      startupPhase = "connected";
      if (opened.protocolVersion !== GUEST_PROCESS_PROTOCOL_VERSION) throw new GuestRuntimeError("unsupported_protocol", "guest process protocol mismatch", true);
      if (!GUEST_REQUIRED_RUNTIME_CAPABILITIES.every((capability) => opened.capabilities.includes(capability))) throw new GuestRuntimeError("unsupported_capability", "guest runtime required capabilities changed", true);
      clearTimeout(timer);
      if (requestedSignal) void opened.signal(requestedSignal).catch(() => fail(new GuestRuntimeError("transport_lost", "guest signal delivery failed", true)));
      void (async () => {
        try {
          for await (const event of opened.events) {
            if (done) return;
            if (!sameIdentity(event.identity, launch.identity) || event.launchAttemptId !== request.launchAttemptId) throw new GuestRuntimeError("binding_mismatch", "guest event has stale authority or launch ownership", true);
            if (event.type === "exit") {
              if ((event.code !== null && (!Number.isInteger(event.code) || event.code < 0 || event.code > 255)) || (event.signal !== null && typeof event.signal !== "string")) throw new GuestRuntimeError("transport_lost", "malformed guest exit event", true);
              finish({ code: event.code, signal: event.signal }); return;
            }
            if (event.type !== "stdout" && event.type !== "stderr") throw new GuestRuntimeError("transport_lost", "unknown guest stream event", true);
            if (typeof event.chunk !== "string") throw new GuestRuntimeError("transport_lost", "malformed guest stream event", true);
            (event.type === "stdout" ? stdout : stderr).push(event.chunk);
          }
          if (!done) fail(new GuestRuntimeError("transport_lost", "guest channel ended without confirmed process exit", true));
        } catch (error) { fail(error instanceof GuestRuntimeError ? error : new GuestRuntimeError("transport_lost", "guest stream failed", true)); }
      })();
      return opened;
    });
    void ready.catch((error: unknown) => fail(error instanceof GuestRuntimeError ? error : new GuestRuntimeError("transport_lost", "guest runtime open failed", true)));
    let writes = ready.then(() => {}, () => {});
    const enqueue = (operation: (opened: GuestRuntimeConnection) => Promise<void>, bytes: number): void => {
      if (done || requestedSignal) throw new GuestRuntimeError("transport_lost", "guest runtime is no longer accepting input", startupPhase !== "preparing");
      if (pendingBytes + bytes > limit || pendingWrites >= 1024) { const error = new GuestRuntimeError("buffer_limit", "guest input backlog exceeded its byte or operation bound", true); fail(error); throw error; }
      pendingBytes += bytes; pendingWrites++;
      writes = writes.then(async () => { const opened = await ready; if (!opened || done || requestedSignal) return; await operation(opened); }).finally(() => { pendingBytes -= bytes; pendingWrites--; });
      void writes.catch(() => fail(new GuestRuntimeError("transport_lost", "guest input delivery failed; no replay attempted", true)));
    };
    return {
      pid: null, stdout, stderr, exited, kill: signal,
      stdin: {
        write(chunk) { if (stdinClosed || done || requestedSignal) throw new GuestRuntimeError("transport_lost", "guest stdin already closed"); if (chunk.length === 0) return; enqueue((opened) => opened.writeStdin(chunk), Buffer.byteLength(chunk)); },
        end() { if (stdinClosed) return; stdinClosed = true; enqueue((opened) => opened.closeStdin(), 0); },
      },
    };
  };
}
