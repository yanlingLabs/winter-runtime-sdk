/** Guided hostClient, orchestration core. No import and no I/O: the SDK, the Winter Core glue, the pipe-backed runtime
 * process and the Root barrier channel are all injected, so the order of every authority-bearing step is testable with
 * fakes (guided-entries.test.ts). Contract ids C-H1..C-H12 are defined in scripts/guest-guided-build/README.md. */

/** The descriptor numbers, once. The runner uses these and HOST_ARGV is derived from them, so the two cannot disagree. */
export const HOST_FDS = Object.freeze({ input: 3, output: 4, error: 5, metadata: 6, lifecycle: 7, cancel: 8 });
export const HOST_ARGV = Object.freeze(["--input-fd", String(HOST_FDS.input), "--output-fd", String(HOST_FDS.output), "--error-fd", String(HOST_FDS.error), "--metadata-fd", String(HOST_FDS.metadata), "--lifecycle-fd", String(HOST_FDS.lifecycle), "--cancel-fd", String(HOST_FDS.cancel)]);
export const HOST_EXIT = Object.freeze({ passed: 0, runFailed: 1, startupRefused: 2 });
export const HOST_LIMITS = Object.freeze({ metadataBytes: 64 * 1024, promptBytes: 1024, reportLineBytes: 4096, commandBytes: 64 });
/** Root's commands, one line each on stdin. Every command gets exactly one reply line on stdout. */
export const HOST_COMMANDS = Object.freeze(["dispatch 1", "dispatch 2", "premint", "reuse", "revoke", "present-premint", "finish"] as const);
export type Command = typeof HOST_COMMANDS[number];
export const HOST_ANSWER_BYTES = 512;

export class HostStartupRefusal extends Error {
  constructor(readonly code: "argv" | "platform" | "identity" | "input" | "metadata") { super(`host client refused: ${code}`); }
}
const refuse = (code: HostStartupRefusal["code"]): never => { throw new HostStartupRefusal(code); };

export function checkHostStartup(platform: string, argv: readonly string[]): void {
  if (platform !== "linux") refuse("platform");
  if (argv.length !== HOST_ARGV.length || argv.some((value, index) => value !== HOST_ARGV[index])) refuse("argv");
}
export interface HostInputStat { isFile(): boolean; isFIFO(): boolean; uid: number; nlink: number; mode: number; size: number }
export function checkRootFile(stat: HostInputStat, maxBytes: number): void {
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o222) !== 0 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) refuse("input");
}
export function checkRootPipe(stat: HostInputStat): void { if (!stat.isFIFO() || stat.uid !== 0 || stat.nlink !== 1) refuse("input"); }

export interface HostMetadata {
  workspaceKey: string; incarnationId: string; leaseEpoch: number; prompts: readonly [string, string];
  runtimeConfig: Record<string, unknown>; readerRegistration: Record<string, unknown>; fixture: FixtureData;
}
export interface FixtureData {
  registration: any; capture: any; runtimeRow: Record<string, unknown>; workspace: any; binding: any; policy: any; sources: any[];
  grants: { folder: Record<string, any>; repository: Record<string, any> }; bootId: string;
}
const FIXTURE_KEYS = ["binding", "bootId", "capture", "grants", "policy", "registration", "runtimeRow", "sources", "workspace"];
/** The host-side query options come from Root's trusted runtime config by a closed list (the v1 host client's mapping), never by
 * spreading it: homes, the runtime executable and anything else the config carries stay out of the SDK's options. */
export function hostQueryOptions(config: Record<string, unknown>): Record<string, unknown> {
  const c = config as Record<string, any>;
  return { executionPosture: "confined-guest", sessionId: c.sessionId, model: c.model, cwd: c.cwd, persistSession: c.persistSession, permissionMode: c.permissionMode,
    tools: c.tools, allowedTools: c.allowedTools, settingSources: c.settingSources, plugins: c.plugins, skills: c.skills, mcpServers: c.mcpServers, strictMcpConfig: c.strictMcpConfig,
    permissions: c.permissions, allowDangerouslySkipPermissions: c.allowDangerouslySkipPermissions === true, env: {}, pathToClaudeCodeExecutable: "winter-confined-guest",
    includePartialMessages: true, maxBufferSize: 1024 * 1024 };
}
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const idText = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);

/** C-H3: closed top-level keys, JSON.stringify bytes only. Deep shape is judged by the SDK profile and by Winter Core,
 * which refuse; this layer only refuses what it would otherwise have to guess about. */
export function parseHostMetadata(bytes: Uint8Array): HostMetadata {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > HOST_LIMITS.metadataBytes) return refuse("metadata");
  let value: any, raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = JSON.parse(raw); } catch { return refuse("metadata"); }
  if (!isObject(value) || JSON.stringify(value) !== raw) return refuse("metadata");
  if (Object.keys(value).sort().join(",") !== "fixture,incarnationId,leaseEpoch,prompts,readerRegistration,runtimeConfig,version,workspaceKey") return refuse("metadata");
  const prompts = value.prompts;
  if (value.version !== 1 || !idText(value.workspaceKey) || !idText(value.incarnationId) || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 1
    || !Array.isArray(prompts) || prompts.length !== 2 || prompts.some((p: unknown) => typeof p !== "string" || p.length < 1 || Buffer.byteLength(p) > HOST_LIMITS.promptBytes)
    || !isObject(value.runtimeConfig) || "requiredRuntimeContext" in value.runtimeConfig || !isObject(value.readerRegistration) || Object.hasOwn(value.readerRegistration, "requiredRuntimeContext") || !isObject(value.fixture)) return refuse("metadata");
  if (Object.keys(value.fixture).sort().join(",") !== FIXTURE_KEYS.join(",") || !isObject(value.fixture.grants)
    || Object.keys(value.fixture.grants).sort().join(",") !== "folder,repository" || !Array.isArray(value.fixture.sources) || typeof value.fixture.bootId !== "string") return refuse("metadata");
  return value as HostMetadata;
}

/** C-H5: the Core planner reads its records through a repository object and one raw statement per read. This builds the
 * smallest object that answers exactly those reads from IN-MEMORY FIXTURE DATA. It is not a database and not Winter's
 * runtime state: an unknown statement or id throws, so a Core change that reads anything else fails closed. */
export function buildFixtureRecords(fixture: FixtureData) {
  const need = (ok: boolean): void => { if (!ok) throw new Error("fixture records refused"); };
  const row = fixture.runtimeRow;
  const rs = {
    transaction: <T>(fn: () => T): T => fn(),
    db: { query: (sql: string) => {
      if (/^SELECT .* FROM runtime_sessions WHERE winter_session_id = \?$/.test(sql)) return { get: (id: string) => (id === row.winter_session_id ? row : null) };
      if (sql === "SELECT source_id FROM cowork_sources WHERE workspace_id=? AND state!='detached' ORDER BY source_id LIMIT 101")
        return { all: (workspaceId: string) => { need(workspaceId === fixture.workspace.workspaceId); return fixture.sources.filter(s => s.state !== "detached").map(s => ({ source_id: s.sourceId })).sort((a, b) => (a.source_id < b.source_id ? -1 : 1)); } };
      throw new Error("fixture records refused");
    } },
  };
  const records = {
    rs,
    get: (workspaceId: string) => { need(workspaceId === fixture.workspace.workspaceId); return fixture.workspace; },
    binding: (sessionId: string) => { need(sessionId === fixture.binding.sessionId); return fixture.binding; },
    policy: (workspaceId: string) => { need(workspaceId === fixture.policy.workspaceId); return fixture.policy; },
    source: (workspaceId: string, sourceId: string) => { need(workspaceId === fixture.workspace.workspaceId); const s = fixture.sources.find(item => item.sourceId === sourceId); need(!!s); return s; },
  };
  const grants = {
    folder: (ref: string) => (Object.hasOwn(fixture.grants.folder, ref) ? fixture.grants.folder[ref] : undefined),
    repository: (authority: string, repositoryId: string) => { const key = `${authority}|${repositoryId}`; return Object.hasOwn(fixture.grants.repository, key) ? fixture.grants.repository[key] : undefined; },
  };
  return {
    records, grants, currentBootId: (workspaceId: string) => { need(workspaceId === fixture.workspace.workspaceId); return fixture.bootId; },
    registration: (trusted: string) => (trusted === fixture.registration.trustedQuerySessionId ? fixture.registration : undefined),
  };
}

/** Closed failure codes: nothing from a message, a path, a prompt or guidance text is ever reported. */
const FAILURE_CODES: Record<string, string> = {
  required_context_unavailable: "required_context_unavailable", "fixture records refused": "fixture_records", "host command": "command",
  "host config refused": "config", "host turn failed": "turn", "host revoke not observed": "revoke_not_observed",
};
export function hostFailureCode(error: unknown): string {
  return error instanceof Error && Object.hasOwn(FAILURE_CODES, error.message) ? FAILURE_CODES[error.message]! : "host_failure";
}
/** The error class a refused presentation reports: the SDK's own closed refusal, or `other`. Never a message. */
export const refusalClass = (error: unknown): "required_context_unavailable" | "other" =>
  error instanceof Error && error.message === "required_context_unavailable" ? "required_context_unavailable" : "other";
export const parseCommand = (line: string): Command | undefined => (HOST_COMMANDS as readonly string[]).includes(line) ? line as Command : undefined;

export interface SdkPort {
  claimGuidedGuestIssuer(): { advance(key: string, incarnation: string, epoch: number): void; mint(request: any): unknown; revoke(key: string): void };
  prepareGuidedQuery(callbacks: { onRuntimeContext: any; spawnClaudeCodeProcess: any }): unknown;
  consumeGuidedQueryCorrelation(claim: unknown, args: readonly string[]): { version: number; bindingId: string };
  closeGuidedQuery(preparation: unknown): void;
  query(args: { prompt: string | AsyncIterable<string>; options: Record<string, unknown> }): AsyncIterable<any> & { return?(value?: unknown): Promise<unknown> };
}
export interface HostPorts {
  sdk: SdkPort;
  readInstructions(preparation: unknown, signal: AbortSignal): Promise<string>;
  createHandler(deps: any): (request: any, options: any) => Promise<unknown>;
  assertConfig(config: any, registration: unknown): void;
  createProcess(): unknown;
  emit(line: Record<string, unknown>): void;
  /** The next command line from Root, or null at end of input. */
  nextCommand(): Promise<string | null>;
}
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(a => { resolve = a; }); return { promise, resolve }; };
const boundedText = (text: string): string => { const bytes = Buffer.from(text); return bytes.byteLength <= HOST_ANSWER_BYTES ? text : bytes.subarray(0, HOST_ANSWER_BYTES).toString("utf8").replace(/\uFFFD+$/, ""); };

/** C-H6..C-H11: the one run, driven by Root's commands. Setup order is the contract:
 * claim issuer -> advance -> handler -> prepare -> mint -> query (streaming prompt, nothing sent yet). Then the commands:
 * `dispatch 1`, `dispatch 2` (each sends its prompt and replies with the answer text), `premint` (a second preparation and
 * an unspent ticket, held), `reuse` (present the spent first ticket again), `revoke`, `present-premint` (present the held
 * ticket after the revoke) and `finish`. A presentation that is not refused is itself the finding: it is reported as such. */
export async function runGuidedHost(meta: HostMetadata, ports: HostPorts): Promise<Record<string, unknown>> {
  const { sdk } = ports;
  const issuer = sdk.claimGuidedGuestIssuer();
  issuer.advance(meta.workspaceKey, meta.incarnationId, meta.leaseEpoch);
  const fixture = buildFixtureRecords(meta.fixture);
  let contextCalls = 0, contextRefusals = 0, spawnAttempts = 0;
  /** One preparation with its own callback objects; the SAME objects go to prepare and to query (C-H6). */
  function prepared() {
    let preparation: unknown;
    const frames = { readFrame: (signal: AbortSignal) => ports.readInstructions(preparation, signal) };
    const handle = ports.createHandler({ records: fixture.records, grants: fixture.grants, currentBootId: fixture.currentBootId, registration: fixture.registration, capture: meta.fixture.capture, frames });
    const onRuntimeContext = async (request: any, options: any) => { contextCalls++; try { return await handle(request, options); } catch (error) { contextRefusals++; throw error; } };
    const spawnClaudeCodeProcess = (spawn: any) => {
      // Exactly one runtime process per run. A second spawn would wrap the same Root pipes again, so it is refused before
      // anything is consumed or created, whichever preparation asks.
      if (spawnAttempts++ > 0) throw new Error("host config refused");
      const correlation = sdk.consumeGuidedQueryCorrelation(spawn?.guidedQueryClaim, spawn?.args);
      if (!correlation || correlation.version !== 1 || !UUID_V4.test(correlation.bindingId)) throw new Error("host config refused");
      // The SDK discards every emitted config value but the binding correlation (guided-query-preparation: "all other config values
      // are discarded, never authority"; the emitted config also carries keys, such as `brand`, that the closed profile refuses). So
      // the profile asserts Root's trusted runtime config, with the SDK's own binding id for THIS spawn, against Root's registration
      // with the same id. The id is chosen by query() per run, AFTER Root wrote the registration, which is why the metadata has none.
      try {
        const binding = Object.freeze({ version: correlation.version, bindingId: correlation.bindingId });
        ports.assertConfig(Object.freeze({ ...meta.runtimeConfig, requiredRuntimeContext: binding }), Object.freeze({ ...meta.readerRegistration, requiredRuntimeContext: binding }));
      } catch { throw new Error("host config refused"); }
      // Root creates its reader service and launches the runtime only after this line, with this id. It is the only id printed.
      ports.emit({ kind: "host-spawn", version: 1, bindingId: correlation.bindingId });
      return ports.createProcess();
    };
    preparation = sdk.prepareGuidedQuery({ onRuntimeContext, spawnClaudeCodeProcess });
    const ticket = issuer.mint({ workspaceKey: meta.workspaceKey, incarnationId: meta.incarnationId, leaseEpoch: meta.leaseEpoch, preparation });
    const options = { ...hostQueryOptions(meta.runtimeConfig), guidedQueryPreparation: preparation, requireRuntimeContext: true, onRuntimeContext, spawnClaudeCodeProcess, guidedGuestTicket: ticket };
    return { preparation, options };
  }
  const first = prepared();

  // The first query: a streaming prompt that only moves when a dispatch command pushes an item.
  const queue: { text: string }[] = []; let wake = deferred<void>(), ending = false;
  async function* prompts(): AsyncGenerator<string> {
    for (;;) {
      const item = queue.shift();
      if (item) { yield item.text; continue; }
      if (ending) return;
      await wake.promise; wake = deferred<void>();
    }
  }
  const push = (text: string) => { queue.push({ text }); wake.resolve(); };
  let turn = deferred<{ ok: boolean; answer: string } | { ended: string }>(), answer = "", ended: string | undefined, resultsSeen = 0, resultsAfterRevoke = 0, revoked = false;
  const q = sdk.query({ prompt: prompts(), options: first.options });
  const pump = (async () => {
    try {
      for await (const message of q) {
        if (message?.type === "assistant") for (const block of message.message?.content ?? []) if (block?.type === "text" && typeof block.text === "string") answer += block.text;
        if (message?.type === "result") {
          resultsSeen++; if (revoked) resultsAfterRevoke++;
          const done = { ok: message.subtype === "success", answer: boundedText(answer) }; answer = ""; turn.resolve(done);
        }
      }
      ended = "completed";
    } catch (error) { ended = `${revoked ? "torn-down" : "failed"}:${hostFailureCode(error)}`; }
    ports.emit({ kind: "host-query-ended", version: 1, how: ended });
    turn.resolve({ ended });
  })();

  async function present(held: { options: Record<string, unknown> }) {
    const before = spawnAttempts; let refused = true, errorClass: "required_context_unavailable" | "other" | "none" = "none";
    try {
      const presented = sdk.query({ prompt: "presentation", options: held.options });
      try { await (presented[Symbol.asyncIterator]() as AsyncIterator<any>).next(); refused = false; }
      finally { try { await presented.return?.(undefined); } catch { /* already refused or closed */ } }
    } catch (error) { refused = true; errorClass = refusalClass(error); }
    return { refused: refused && spawnAttempts === before, errorClass: refused && spawnAttempts === before ? errorClass : "none" as const, processStarted: spawnAttempts !== before };
  }

  let nextDispatch = 1, held: ReturnType<typeof prepared> | undefined, reuseTried = false, presentTried = false;
  let reuseRefused = true, presentRefused = true, dispatchesOk = 0, refusedCommands = 0, finished = false;
  const reply = (line: Record<string, unknown>) => ports.emit({ version: 1, ...line });
  const refuseCommand = (code: "order" | "unknown") => { refusedCommands++; reply({ kind: "host-command-refused", code }); };
  for (;;) {
    const line = await ports.nextCommand();
    if (line === null) break;
    const command = parseCommand(line);
    if (!command) { refuseCommand("unknown"); continue; }
    if (command === "dispatch 1" || command === "dispatch 2") {
      const n = command === "dispatch 1" ? 1 : 2;
      if (n !== nextDispatch || revoked) { refuseCommand("order"); continue; }
      nextDispatch++;
      if (ended !== undefined) { reply({ kind: "host-dispatch", n, ok: false, answer: "", ended }); continue; }
      turn = deferred(); push(meta.prompts[n - 1]!);
      const outcome = await turn.promise;
      if ("ok" in outcome) { if (outcome.ok) dispatchesOk++; reply({ kind: "host-dispatch", n, ok: outcome.ok, answer: outcome.answer }); }
      else { reply({ kind: "host-dispatch", n, ok: false, answer: "", ended: outcome.ended }); }
    } else if (command === "premint") {
      if (held || revoked) { refuseCommand("order"); continue; }
      held = prepared(); reply({ kind: "host-premint", minted: true });
    } else if (command === "reuse") {
      if (reuseTried || revoked || nextDispatch < 2) { refuseCommand("order"); continue; }
      reuseTried = true; const result = await present(first); reuseRefused = result.refused && result.errorClass === "required_context_unavailable";
      reply({ kind: "host-presented", which: "spent", ...result });
    } else if (command === "revoke") {
      if (revoked) { refuseCommand("order"); continue; }
      issuer.revoke(meta.workspaceKey); revoked = true; reply({ kind: "host-revoked" });
    } else if (command === "present-premint") {
      if (presentTried || !held || !revoked) { refuseCommand("order"); continue; }
      presentTried = true; const result = await present(held); presentRefused = result.refused && result.errorClass === "required_context_unavailable";
      reply({ kind: "host-presented", which: "premint", ...result });
    } else {
      finished = true; break;
    }
  }
  ending = true; wake.resolve();
  try { await q.return?.(undefined); } catch { /* torn down already */ }
  await pump;
  for (const item of [first, held]) if (item) { try { sdk.closeGuidedQuery(item.preparation); } catch { /* already closed by teardown */ } }
  const result = { kind: "host-result", version: 1,
    passed: finished && dispatchesOk === 2 && revoked && reuseTried && reuseRefused && presentTried && presentRefused && resultsAfterRevoke === 0 && contextCalls >= 2 && refusedCommands === 0,
    dispatchesOk, revoked, reuseRefused: reuseTried ? reuseRefused : null, presentRefused: presentTried ? presentRefused : null,
    resultsAfterRevoke, contextCalls, contextRefusals, refusedCommands, queryEnded: ended ?? "running" };
  ports.emit(result);
  return result;
}
