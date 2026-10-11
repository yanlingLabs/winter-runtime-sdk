import { describe, expect, test } from "bun:test";
import { query, PROTOCOL_VERSION } from "@yanlinglabs/winter-agent-sdk";
import { createGuestRuntimeSpawn, GUEST_REQUIRED_RUNTIME_CAPABILITIES, type GuestLaunch, type GuestRuntimeEvent, type GuestRuntimeConnection, type GuestRuntimeProcessChannel, type GuestRuntimeOpenRequest } from "../../src/guest/process.ts";
import { createGuestQueryTransport } from "../../src/guest/query.ts";

class Events implements AsyncIterable<GuestRuntimeEvent> {
  launchAttemptId = "not-opened";
  private entries: GuestRuntimeEvent[] = [];
  private ended = false;
  private wake: (() => void) | undefined;
  push(event: Omit<Extract<GuestRuntimeEvent, {type: "stdout" | "stderr"}>, "launchAttemptId"> | Omit<Extract<GuestRuntimeEvent, {type: "exit"}>, "launchAttemptId">) { this.entries.push({ ...event, launchAttemptId: this.launchAttemptId }); this.wake?.(); this.wake = undefined; }
  end() { this.ended = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncIterator<GuestRuntimeEvent> {
    while (true) {
      const item = this.entries.shift(); if (item) { yield item; continue; }
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
const launch = (): GuestLaunch => ({
  identity: { protocolVersion: 1, workspaceId: "workspace", sessionId: "session", incarnationId: "boot1", leaseEpoch: 2, configRevision: 3, grantRevision: 4, policyRevision: 5 },
  executable: "/opt/winter/bin/winter", cwd: "/workspace/source", runHome: "/run/winter/conversations/session", storeHome: "/var/lib/winter/sdk", environment: { PATH: "/usr/bin:/bin", HOME: "/run/winter/home" },
});
function fake(input = launch()) {
  const events = new Events(); const writes: string[] = []; const signals: string[] = []; const requests: GuestRuntimeOpenRequest[] = [];
  const cleanups: Array<{identity: GuestLaunch["identity"]; launchAttemptId: string}> = [];
  const connection: GuestRuntimeConnection = {
    identity: { ...input.identity }, launchAttemptId: "not-opened", protocolVersion: 1, capabilities: [...GUEST_REQUIRED_RUNTIME_CAPABILITIES], events,
    async writeStdin(chunk) { writes.push(chunk); }, async closeStdin() { writes.push("EOF"); }, async signal(value) { signals.push(value); },
  };
  const acceptAttempt = (request: GuestRuntimeOpenRequest) => { requests.push(request); connection.launchAttemptId = request.launchAttemptId; events.launchAttemptId = request.launchAttemptId; };
  const channel: GuestRuntimeProcessChannel = {
    async prepareRuntime() { return { identity: input.identity, protocolVersion: 1, capabilities: [...GUEST_REQUIRED_RUNTIME_CAPABILITIES] }; },
    async openRuntime(request) { acceptAttempt(request); return connection; },
    async cleanupRuntimeAttempt(owner) { cleanups.push(owner); },
  };
  const sdk = (extra: Record<string, unknown> = {}) => ({ command: "/host/never-execute", cwd: input.cwd, env: { OPENAI_API_KEY: "synthetic-never-forward", WINTER_HOST_PID: "123" }, hostPidEnv: "WINTER_HOST_PID", args: ["--run", "--config-json", JSON.stringify({ sessionId: input.identity.sessionId, cwd: input.cwd, model: "winter-test/echo", ...extra })] });
  return { input, events, writes, signals, requests, connection, channel, sdk, cleanups, acceptAttempt };
}
async function collect(values: AsyncIterable<string>) { let output = ""; for await (const item of values) output += item; return output; }
async function tick() { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }

describe("guest process transport", () => {
  test("streams SDK bytes verbatim, orders queued stdin/EOF and never forwards host process/env", async () => {
    const f = fake(); const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
    proc.stdin.write("first\n"); proc.stdin.write("second\n"); proc.stdin.end();
    const out = collect(proc.stdout); const err = collect(proc.stderr!);
    await tick();
    f.events.push({ type: "stdout", identity: f.input.identity, chunk: "partial-" });
    f.events.push({ type: "stderr", identity: f.input.identity, chunk: "diagnostic" });
    f.events.push({ type: "stdout", identity: f.input.identity, chunk: "雪\n" });
    f.events.push({ type: "exit", identity: f.input.identity, code: 0, signal: null });
    expect(await out).toBe("partial-雪\n"); expect(await err).toBe("diagnostic");
    expect(await proc.exited).toEqual({ code: 0, signal: null }); expect(proc.pid).toBeNull();
    expect(f.writes).toEqual(["first\n", "second\n", "EOF"]);
    expect(f.requests[0]?.executable).toBe("/opt/winter/bin/winter"); expect(f.requests[0]?.environment).toEqual(f.input.environment);
    const config = JSON.parse(f.requests[0]!.args[2]!);
    expect(config.executionPosture).toBe("confined-guest"); expect(config.winterHome).toBe(f.input.runHome); expect(config.storeHome).toBe(f.input.storeHome);
  });
  test("missing capability is refused before process opening or stdin transmission", async () => {
    const f = fake(); f.channel.prepareRuntime = async () => ({ identity: f.input.identity, protocolVersion: 1, capabilities: ["runtime-stdio-v1"] });
    const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
    proc.stdin.write("must-not-execute");
    await expect(collect(proc.stdout)).rejects.toMatchObject({ code: "unsupported_capability" });
    expect(f.requests).toEqual([]); expect(f.writes).toEqual([]); expect((await proc.exited).code).toBeNull();
  });
  test("all authority epochs are fenced on delayed stream events", async () => {
    for (const key of ["incarnationId", "leaseEpoch", "configRevision", "grantRevision", "policyRevision"] as const) {
      const f = fake(); const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
      const stream = collect(proc.stdout); await tick();
      const identity = { ...f.input.identity }; if (key === "incarnationId") identity[key] = "old"; else identity[key]--;
      f.events.push({ type: "stdout", identity, chunk: "stale" });
      await expect(stream).rejects.toMatchObject({ code: "binding_mismatch", effectsUncertain: true });
      expect(f.signals).toContain("SIGKILL");
    }
  });
  test("EOF without exit is uncertain and never retried", async () => {
    const f = fake(); const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
    const out = collect(proc.stdout); await tick(); f.events.end();
    await expect(out).rejects.toMatchObject({ code: "transport_lost", effectsUncertain: true });
    expect(await proc.exited).toEqual({ code: null, signal: null }); expect(f.requests).toHaveLength(1);
  });
  test("queued input/output bounds fail closed and cancellation uses guest signal handles", async () => {
    const f = fake(); const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel, maxBufferedBytes: 4 })(f.sdk());
    const out = collect(proc.stdout); await tick(); proc.kill("SIGTERM");
    expect(f.signals).toEqual(["SIGTERM"]);
    f.events.push({ type: "stdout", identity: f.input.identity, chunk: "oversized" });
    await expect(out).rejects.toMatchObject({ code: "buffer_limit" });
    expect(f.signals).toContain("SIGKILL");
    const g = fake(); const buffered = createGuestRuntimeSpawn({ launch: g.input, channel: g.channel, maxBufferedBytes: 4 })(g.sdk());
    expect(() => buffered.stdin.write("oversized")).toThrow("backlog");
    await expect(collect(buffered.stdout)).rejects.toMatchObject({ code: "buffer_limit" });
    expect(g.requests).toEqual([]);
  });
  test("startup timeout closes the expected launch attempt without trusting a late returned handle", async () => {
    const f = fake(); let resolve!: (value: GuestRuntimeConnection) => void;
    f.channel.openRuntime = request => { f.acceptAttempt(request); return new Promise((answer) => { resolve = answer; }); };
    const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel, startupTimeoutMs: 10 })(f.sdk());
    await expect(collect(proc.stdout)).rejects.toMatchObject({ code: "startup_timeout" });
    resolve(f.connection); await tick(); expect(f.signals).toEqual([]); expect(f.cleanups).toEqual([{ identity: f.input.identity, launchAttemptId: f.requests[0]!.launchAttemptId }]); expect(f.writes).toEqual([]);
  });
  test("kill or SDK abort during preparation aborts promptly and never opens a runtime", async () => {
    for (const method of ["kill", "abort"] as const) {
      const f=fake();let prepared!:()=>void;let prepareSignal!:AbortSignal;
      f.channel.prepareRuntime=(_launch,signal)=>{prepareSignal=signal;return new Promise(resolve=>{prepared=()=>resolve({identity:f.input.identity,protocolVersion:1,capabilities:[...GUEST_REQUIRED_RUNTIME_CAPABILITIES]})})};
      const controller=new AbortController();const proc=createGuestRuntimeSpawn({launch:f.input,channel:f.channel})( {...f.sdk(),signal:controller.signal});
      proc.stdin.write("queued-before-cancel");await tick();
      if(method==="kill")proc.kill("SIGTERM");else controller.abort();
      expect(prepareSignal.aborted).toBe(true);expect(await proc.exited).toEqual({code:null,signal:"SIGTERM"});expect(await collect(proc.stdout)).toBe("");
      expect(()=>proc.stdin.write("after-cancel")).toThrow();prepared();await tick();expect(f.requests).toEqual([]);expect(f.writes).toEqual([]);
    }
  });
  test("cancellation during opening is uncertain, resolves promptly, and cleans late handles",async()=>{
    const f=fake();let opened!:(connection:GuestRuntimeConnection)=>void;let openingSignal!:AbortSignal;
    f.channel.openRuntime=(request,signal)=>{f.acceptAttempt(request);openingSignal=signal;return new Promise(resolve=>{opened=resolve})};
    const proc=createGuestRuntimeSpawn({launch:f.input,channel:f.channel})(f.sdk());proc.stdin.write("queued");await tick();proc.kill("SIGKILL");
    expect(openingSignal.aborted).toBe(true);await expect(collect(proc.stdout)).rejects.toMatchObject({effectsUncertain:true,code:"transport_lost"});expect(await proc.exited).toEqual({code:null,signal:null});
    opened(f.connection);await tick();expect(f.signals).toEqual([]);expect(f.cleanups).toHaveLength(1);expect(f.writes).toEqual([]);
  });
  test("hung signal acknowledgment cannot hide exit or deliver queued/new stdin after stop",async()=>{
    const f=fake();f.connection.signal=async signal=>{f.signals.push(signal);await new Promise(()=>{})};
    const proc=createGuestRuntimeSpawn({launch:f.input,channel:f.channel})(f.sdk());await tick();
    proc.stdin.write("queued-but-not-dispatched");proc.kill("SIGTERM");expect(()=>proc.stdin.write("new-after-stop")).toThrow();
    f.events.push({type:"exit",identity:f.input.identity,code:null,signal:"SIGTERM"});expect(await proc.exited).toEqual({code:null,signal:"SIGTERM"});expect(f.writes).toEqual([]);expect(f.signals).toEqual(["SIGTERM"]);
  });
  test("synchronous cancellation before startup does not even prepare",async()=>{
    const f=fake();let preparations=0;f.channel.prepareRuntime=async()=>{preparations++;return{identity:f.input.identity,protocolVersion:1,capabilities:[...GUEST_REQUIRED_RUNTIME_CAPABILITIES]}};
    const proc=createGuestRuntimeSpawn({launch:f.input,channel:f.channel})(f.sdk());proc.kill("SIGTERM");await proc.exited;await tick();expect(preparations).toBe(0);expect(f.requests).toEqual([]);
  });
  test("foreign and stale launch acknowledgments never receive signals or stdin, even after cancellation", async () => {
    for (const late of [false, true]) for (const forged of ["session", "incarnation", "attempt"] as const) {
      const f = fake(); let answer!: (connection: GuestRuntimeConnection) => void;
      f.channel.openRuntime = request => { f.acceptAttempt(request); return new Promise(resolve => { answer = resolve; }); };
      const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
      proc.stdin.write("queued"); const output = collect(proc.stdout); await tick();
      if (late) { proc.kill("SIGTERM"); await expect(output).rejects.toMatchObject({ effectsUncertain: true }); }
      if (forged === "attempt") f.connection.launchAttemptId = "foreign-attempt";
      else f.connection.identity = { ...f.connection.identity, ...(forged === "session" ? { sessionId: "foreign" } : { incarnationId: "old" }) };
      answer(f.connection);
      if (!late) await expect(output).rejects.toMatchObject({ code: "binding_mismatch", effectsUncertain: true });
      await tick();
      expect(f.signals).toEqual([]); expect(f.writes).toEqual([]);
      expect(f.cleanups).toEqual([{ identity: f.input.identity, launchAttemptId: f.requests[0]!.launchAttemptId }]);
    }
  });
  test("empty frames are no-ops and tiny chunks cannot bypass metadata queue bounds", async () => {
    const f = fake(); const proc = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel })(f.sdk());
    for (let i = 0; i < 10_000; i++) proc.stdin.write("");
    await tick(); expect(f.writes).toEqual([]);
    for (let i = 0; i < 10_000; i++) f.events.push({ type: "stdout", identity: f.input.identity, chunk: "" });
    f.events.push({ type: "exit", identity: f.input.identity, code: 0, signal: null });
    expect(await collect(proc.stdout)).toBe(""); await proc.exited;
    const g = fake(); g.channel.prepareRuntime = async () => new Promise(() => {});
    const held = createGuestRuntimeSpawn({ launch: g.input, channel: g.channel })(g.sdk());
    for (let i = 0; i < 1024; i++) held.stdin.write("x");
    expect(() => held.stdin.write("x")).toThrow("operation bound");
    await expect(collect(held.stdout)).rejects.toMatchObject({ code: "buffer_limit" });
    const h = fake(); const flooded = createGuestRuntimeSpawn({ launch: h.input, channel: h.channel })(h.sdk()); await tick();
    for (let i = 0; i < 4097; i++) h.events.push({ type: "stdout", identity: h.input.identity, chunk: "x" });
    await flooded.exited;
    await expect(collect(flooded.stdout)).rejects.toMatchObject({ code: "buffer_limit" });
  });
  test("legacy credentials, foreign resume, arbitrary argv and unadmitted environment never open", () => {
    const f = fake(); const spawn = createGuestRuntimeSpawn({ launch: f.input, channel: f.channel });
    expect(() => spawn(f.sdk({ hostCredentials: true }))).toThrow("credential");
    expect(() => spawn(f.sdk({ hostMessaging: true }))).toThrow("delegation");
    expect(() => spawn(f.sdk({ resume: "foreign" }))).toThrow("resume");
    expect(() => spawn({ ...f.sdk(), args: ["-c", "touch host"] })).toThrow("admitted SDK launch");
    expect(() => createGuestRuntimeSpawn({ launch: { ...f.input, environment: { OPENAI_API_KEY: "synthetic" } }, channel: f.channel })).toThrow("unadmitted variable");
    expect(f.requests).toEqual([]);
  });
  test("separate guest query door carries a real SDK NDJSON round and preserves resume arguments on a new connection", async () => {
    for (const resume of [undefined, "session"]) {
      const f = fake();
      f.connection.writeStdin = async (chunk) => {
        f.writes.push(chunk);
        if (chunk.includes('"type":"user"')) {
          const data = JSON.stringify({ type: "data", message: { type: "result", subtype: "success", is_error: false, result: "guest result" } }) + "\n";
          f.events.push({ type: "stdout", identity: f.input.identity, chunk: data });
          f.events.push({ type: "exit", identity: f.input.identity, code: 0, signal: null });
        }
      };
      f.channel.openRuntime = async (request) => {
        f.acceptAttempt(request);
        const init = JSON.stringify({ type: "init", protocolVersion: PROTOCOL_VERSION, sessionId: "session", cwd: f.input.cwd, model: "winter-test/echo", permissionMode: "default", tools: [] }) + "\n";
        f.events.push({ type: "stdout", identity: f.input.identity, chunk: init.slice(0, 20) });
        f.events.push({ type: "stdout", identity: f.input.identity, chunk: init.slice(20) });
        return f.connection;
      };
      const door = createGuestQueryTransport({ peer: { query }, launch: f.input, channel: f.channel });
      const messages = [];
      for await (const message of door.query({ prompt: "hello", options: { model: "winter-test/echo", ...(resume ? { resume } : {}) } })) messages.push(message);
      expect(messages.some((message) => message.type === "result")).toBe(true);
      expect(JSON.parse(f.requests[0]!.args[2]!).resume).toBe(resume);
    }
  });
});
