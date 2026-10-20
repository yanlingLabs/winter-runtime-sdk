/** Test-level spec of the two guided entries. Each test names the contract id (README "Entry contracts") it pins, so the
 * hosted fixture can quote ids instead of prose. Nothing here starts a process, a socket or a guest. */
import { expect, test } from "bun:test";
import { createGuidedFixturePort, encodeFrame, REFUSAL_SITES, SELECTION, sha256 } from "../guest-guided-provider/stub.ts";
import * as P from "./entries/provider-worker-core.ts";
import * as H from "./entries/host-client-core.ts";

// ---------------------------------------------------------------- providerWorker
const scope = { homeId: "home", workspaceId: "workspace", sessionId: "logical", backendSessionId: "backend", taskId: "task", incarnationId: "incarnation", bootId: "boot", leaseEpoch: 1, grantRevision: 2, accountRevision: 3, modelRevision: 4 };
const script = () => ({ version: 1, scope: { ...scope }, selection: SELECTION, steps: [
  { system: ["FACT:workspace"], user: ["SHARED:old"], absentSystem: [], absentUser: ["SHARED:new"], response: "guided-one" },
  { system: ["FACT:workspace"], user: ["SHARED:new"], absentSystem: [], absentUser: ["SHARED:old"], response: "guided-two" }] });
const turn = (second = false) => ({ model: SELECTION.providerModelId, system: "FACT:workspace", messages: [{ role: "user", isMeta: true, content: [{ type: "text", text: second ? "SHARED:new" : "SHARED:old" }] }, { role: "user", content: "question" }] });
const req = (operation: string, sequence: number, ordinal = 1, id = "invocation-one") => ({ version: 1, operation, invocationId: id, invocationOrdinal: ordinal, scope, sequence, ...(operation === "begin" ? { turn: turn(ordinal === 2) } : {}) });
const text = (value: unknown) => JSON.stringify(value);
function worker() {
  const bytes = Buffer.from(JSON.stringify(script())), port = createGuidedFixturePort(bytes, sha256(bytes)), lines: string[] = [];
  const spy = { exchange: (frame: Uint8Array) => { atExchange.push(lines.length); return port.exchange(frame); }, receipt: () => port.receipt(), close: () => port.close() };
  const atExchange: number[] = [];
  return { counter: P.createProviderCounter(spy, line => lines.push(line)), lines, atExchange, parsed: () => lines.map(line => JSON.parse(line)) };
}
const stat = (over: Partial<P.InputStat> = {}): P.InputStat => ({ isFile: () => true, uid: 0, nlink: 1, mode: 0o100444, size: 100, ...over });

test("C-P1/C-H1 the argv constants are the contract's literal numbers, and the runners take their descriptor numbers from the same constants", () => {
  expect([...P.PROVIDER_ARGV]).toEqual(["--listener-fd", "3", "--admission-fd", "4", "--owner-library-fd", "5", "--metadata-fd", "6"]);
  expect({ ...P.PROVIDER_FDS }).toEqual({ listener: 3, admission: 4, library: 5, metadata: 6 });
  expect([...H.HOST_ARGV]).toEqual(["--input-fd", "3", "--output-fd", "4", "--error-fd", "5", "--metadata-fd", "6", "--lifecycle-fd", "7", "--cancel-fd", "8"]);
  expect({ ...H.HOST_FDS }).toEqual({ input: 3, output: 4, error: 5, metadata: 6, lifecycle: 7, cancel: 8 });
  const pairs = (argv: readonly string[]) => Object.fromEntries(argv.reduce<string[][]>((all, value, index) => (index % 2 === 0 ? [...all, [value.slice(2, -3), argv[index + 1]!]] : all), []));
  expect(pairs(P.PROVIDER_ARGV)).toEqual({ listener: "3", admission: "4", "owner-library": "5", metadata: "6" });
  expect(pairs(H.HOST_ARGV)).toEqual({ input: "3", output: "4", error: "5", metadata: "6", lifecycle: "7", cancel: "8" });
});
test("C-P1 only the fixed linux argv starts the provider worker", () => {
  expect(() => P.checkStartup("linux", [...P.PROVIDER_ARGV])).not.toThrow();
  for (const bad of [[], [...P.PROVIDER_ARGV, "--x"], P.PROVIDER_ARGV.slice(0, 7), [...P.PROVIDER_ARGV].reverse(), P.PROVIDER_ARGV.map(v => (v === "3" ? "9" : v))]) expect(() => P.checkStartup("linux", bad)).toThrow("provider worker refused: argv");
  expect(() => P.checkStartup("darwin", [...P.PROVIDER_ARGV])).toThrow("provider worker refused: platform");
});
test("C-P2 the library and metadata descriptors must be Root-owned immutable single-link regular files", () => {
  expect(() => P.checkImmutableInput(stat(), 1000)).not.toThrow();
  for (const over of [{ isFile: () => false }, { uid: 1000 }, { nlink: 2 }, { mode: 0o100644 }, { mode: 0o100222 }, { size: 0 }, { size: 1001 }, { size: Number.NaN }]) expect(() => P.checkImmutableInput(stat(over), 1000)).toThrow("provider worker refused: input");
});
const meta = (over: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ version: 1, runtimeUid: 40002, scriptSha256: "a".repeat(64), script: { k: 1 }, ...over }));
test("C-P3 metadata is closed, canonical JSON; the script hash is Root's and is verified by the fixture port", () => {
  const parsed = P.parseMetadata(meta());
  expect(parsed.runtimeUid).toBe(40002);
  expect(Buffer.from(parsed.scriptBytes).toString()).toBe('{"k":1}');
  const bad = [meta({ extra: 1 }), meta({ version: 2 }), meta({ runtimeUid: 999 }), meta({ runtimeUid: 1.5 }), meta({ scriptSha256: "A".repeat(64) }), meta({ scriptSha256: "a".repeat(63) }),
    meta({ script: [] }), meta({ script: null }), Buffer.from(JSON.stringify({ version: 1, runtimeUid: 40002, scriptSha256: "a".repeat(64) })), Buffer.from(' {"version":1}'),
    Buffer.from([0xff, 0xfe]), Buffer.alloc(P.PROVIDER_LIMITS.metadataBytes + 1, 0x20), Buffer.from("[]"), Buffer.alloc(0)];
  for (const value of bad) expect(() => P.parseMetadata(value)).toThrow("provider worker refused: metadata");
  expect(() => P.parseMetadata(Buffer.from(JSON.stringify({ version: 1, runtimeUid: 40002, scriptSha256: "a".repeat(64), script: {} }, null, 1)))).toThrow("provider worker refused: metadata");
});
test("C-P6 the native line and the fixture frame differ by the length prefix only", () => {
  const body = text(req("begin", 0)), frame = P.toPortFrame(body)!;
  expect(Buffer.from(frame).subarray(4).toString()).toBe(body);
  expect(new DataView(frame.buffer).getUint32(0)).toBe(Buffer.byteLength(body));
  const reply = P.toNativeReply(encodeFrame({ kind: "accepted" }))!;
  expect(Buffer.from(reply).toString()).toBe('{"kind":"accepted"}\0');
  expect(P.toPortFrame("")).toBeUndefined();
  expect(P.toPortFrame("a\0b")).toBeUndefined();
  expect(P.toPortFrame("x".repeat(P.PROVIDER_LIMITS.requestBytes + 1))).toBeUndefined();
  const lying = Buffer.from(encodeFrame({ a: 1 })); lying.writeUInt32BE(99);
  expect(P.toNativeReply(lying)).toBeUndefined();
  expect(P.toNativeReply(new Uint8Array(3))).toBeUndefined();
});
test("C-P4/C-P5/C-P8 every arrival is counted and reported before it is decoded or answered, and replies carry no request text", async () => {
  const w = worker();
  w.counter.ready();
  const out = await w.counter.arrive(text(req("begin", 0)));
  expect(Buffer.from(out!).toString()).toBe('{"version":1,"invocationId":"invocation-one","sequence":0,"kind":"accepted"}\0');
  // The provider-request line (index 1, after provider-ready) was on the wire before the fixture port saw the frame.
  expect(w.atExchange).toEqual([2]);
  const kinds = w.parsed().map(line => line.kind);
  expect(kinds).toEqual(["provider-ready", "provider-request", "provider-outcome"]);
  for (const line of w.lines) { expect(line.endsWith("\n")).toBe(true); expect(line).not.toMatch(/SHARED|FACT|invocation|question/); expect(Buffer.byteLength(line)).toBeLessThanOrEqual(P.PROVIDER_LIMITS.reportLineBytes); }
});
test("C-P7 a refusal answers nothing, closes the fixture, keeps the worker alive and later arrivals are still counted", async () => {
  const w = worker();
  expect(await w.counter.arrive(text(req("begin", 0)))).toBeDefined();
  expect(await w.counter.arrive("{ not json")).toBeUndefined();
  expect(await w.counter.arrive(text(req("next", 1)))).toBeUndefined(); // valid frame, but the fixture closed after the refusal
  expect(await w.counter.arrive(null)).toBeUndefined();
  expect(await w.counter.arrive("a\0b")).toBeUndefined();
  const summary = w.counter.summary("signal") as any;
  expect(summary).toMatchObject({ requests: 5, unreadable: 1, unframed: 1, refused: 3, answered: 1, receivedFrames: 3, acceptedBegins: 1, portClosed: true, countersAgree: true, reason: "signal" });
});
test("C-P9 a full two-dispatch run reports six requests, two completions and per-turn digests only", async () => {
  const w = worker();
  for (const ordinal of [1, 2]) {
    const id = `invocation-${ordinal}`;
    for (const [operation, sequence] of [["begin", 0], ["next", 1], ["next", 2]] as const) expect(await w.counter.arrive(text(req(operation, sequence, ordinal, id)))).toBeDefined();
  }
  const summary = w.counter.summary("owner-gone") as any;
  expect(summary).toMatchObject({ requests: 6, receivedFrames: 6, receivedBegins: 2, acceptedBegins: 2, completed: 2, refused: 0, countersAgree: true });
  expect(summary.turnSha256).toHaveLength(2);
  expect(JSON.stringify(summary)).not.toMatch(/SHARED|guided-one/);
});
test("C-P9 the request counter is monotonic and a revoked run adds nothing: no arrival, no line", async () => {
  const w = worker();
  await w.counter.arrive(text(req("begin", 0)));
  const before = w.lines.length, n = w.counter.arrivals();
  expect(w.counter.arrivals()).toBe(n); expect(w.lines.length).toBe(before);
  await w.counter.arrive("x");
  expect(w.counter.arrivals()).toBe(n + 1);
  expect(w.parsed().filter(line => line.kind === "provider-request").map(line => line.n)).toEqual([1, 2]);
});
test("C-P6 a reply body containing NUL is never handed to the native writer", () => {
  const body = new TextEncoder().encode('{"a":"\0"}'), frame = new Uint8Array(body.length + 4);
  new DataView(frame.buffer).setUint32(0, body.length); frame.set(body, 4);
  expect(P.toNativeReply(frame)).toBeUndefined();
});
test("C-P9 countersAgree is false when the fixture saw fewer frames than arrived, and a summary over the line bound is not written", async () => {
  const receipt = { scriptSha256: "a".repeat(64), receivedFrames: 0, receivedBegins: 0, acceptedBegins: 0, completed: 0, closed: false, turns: [] as { sha256: string }[] };
  const lines: string[] = [];
  const counter = P.createProviderCounter({ exchange: async () => new Uint8Array(0), receipt: () => receipt, close() {} }, line => lines.push(line));
  await counter.arrive("{}");
  expect((counter.summary("signal") as any).countersAgree).toBe(false);
  expect((counter.receipt("x") as any).countersAgree).toBe(false);
  receipt.turns = Array.from({ length: 200 }, () => ({ sha256: "b".repeat(64) }));
  expect(() => counter.summary("signal")).toThrow("provider report line bound");
});
test("C-P11 the outcome list is capped at 64 while the counters keep counting", async () => {
  const w = worker();
  for (let i = 0; i < 70; i++) await w.counter.arrive(null);
  const receipt = w.counter.receipt("cap") as any;
  expect(receipt).toMatchObject({ requests: 70, unreadable: 70, countersAgree: true });
  expect(receipt.outcomes).toHaveLength(P.PROVIDER_CONTROL.maxOutcomes); expect(P.PROVIDER_CONTROL.maxOutcomes).toBe(64);
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(P.PROVIDER_LIMITS.reportLineBytes);
});
test("C-P11 Root reads the counters on request: a read-only snapshot per `receipt <tag>` line, refused otherwise", async () => {
  const w = worker();
  w.counter.controlLine("receipt start");
  await w.counter.arrive(text(req("begin", 0))); await w.counter.arrive(text(req("next", 1))); await w.counter.arrive(text(req("next", 2)));
  w.counter.controlLine("receipt after-dispatch-1");
  const before = w.counter.arrivals();
  w.counter.controlLine("receipt again"); expect(w.counter.arrivals()).toBe(before); // a receipt counts no arrival
  const receipts = w.parsed().filter(line => line.kind === "provider-receipt");
  expect(receipts.map(line => line.tag)).toEqual(["start", "after-dispatch-1", "again"]);
  expect(receipts[0]).toMatchObject({ requests: 0, receivedFrames: 0, receivedBegins: 0, acceptedBegins: 0, completed: 0, outcomes: [], countersAgree: true });
  expect(receipts[1]).toMatchObject({ requests: 3, receivedFrames: 3, receivedBegins: 1, acceptedBegins: 1, completed: 1, outcomes: ["accepted", "accepted", "accepted"], countersAgree: true });
  expect(receipts[2]).toEqual(receipts[1] && { ...receipts[1], tag: "again" });
  for (const bad of ["", "receipt", "receipt ", "receipt UPPER", "receipt a b", "RECEIPT x", "receipt x\r", "receipt " + "a".repeat(33), "x".repeat(65)]) w.counter.controlLine(bad);
  expect(w.parsed().filter(line => line.kind === "provider-control-refused")).toHaveLength(9);
  expect(w.parsed().filter(line => line.kind === "provider-receipt")).toHaveLength(3);
  expect((w.counter.summary("signal") as any).controlRefused).toBe(9);
});
test("C-P11 a refused-but-counted third begin shows in the receipt: begins 3, accepted 2, and the outcome list says refused", async () => {
  const w = worker();
  for (const ordinal of [1, 2]) for (const [operation, sequence] of [["begin", 0], ["next", 1], ["next", 2]] as const) await w.counter.arrive(text(req(operation, sequence, ordinal, `i-${ordinal}`)));
  w.counter.controlLine("receipt two-done");
  expect(await w.counter.arrive(text(req("begin", 0, 3, "i-3")))).toBeUndefined();
  w.counter.controlLine("receipt third");
  const [two, third] = w.parsed().filter(line => line.kind === "provider-receipt");
  expect(two).toMatchObject({ receivedBegins: 2, acceptedBegins: 2, completed: 2, receivedFrames: 6 });
  expect(third).toMatchObject({ receivedBegins: 3, acceptedBegins: 2, completed: 2, receivedFrames: 7, refused: 1, countersAgree: true });
  expect(third.outcomes.at(-1)).toBe("refused");
});
// A failed arrival is named by WHERE it stopped, from a closed list, and never by what it carried.
const siteOfArrival = async (nativeText: string | null, prior: string[] = []) => {
  const w = worker();
  for (const line of prior) await w.counter.arrive(line);
  const before = (w.counter.receipt("b") as any).refusalSites.length;
  await w.counter.arrive(nativeText);
  const sites = (w.counter.receipt("a") as any).refusalSites as { n: number; site: string }[];
  expect(sites).toHaveLength(before + 1);
  return sites.at(-1)!.site;
};
const beginWith = (change: (turn: any) => void, over: Record<string, unknown> = {}) => { const t: any = turn(); change(t); return text({ ...req("begin", 0), ...over, turn: t }); };
test("C-P11 every refusal site is named once, from the closed vocabulary", async () => {
  expect([...P.REFUSAL_SITES]).toEqual([...REFUSAL_SITES]);
  expect(await siteOfArrival(null)).toBe("read_null");
  expect(await siteOfArrival("a\0b")).toBe("frame_empty_or_nul");
  expect(await siteOfArrival("")).toBe("frame_empty_or_nul");
  expect(await siteOfArrival("{ not json")).toBe("decode");
  expect(await siteOfArrival(text({ ...req("begin", 0), extra: 1 }))).toBe("keys");
  expect(await siteOfArrival(text({ ...req("begin", 0), scope: { ...scope, bootId: "other" } }))).toBe("scope");
  expect(await siteOfArrival(text(req("begin", 1)))).toBe("sequence");
  expect(await siteOfArrival(text(req("next", 1)))).toBe("sequence");
  expect(await siteOfArrival(beginWith(t => { t.model = "gpt-other"; }))).toBe("model");
  expect(await siteOfArrival(beginWith(t => { t.system = "nothing"; }))).toBe("system_marker");
  expect(await siteOfArrival(beginWith(t => { t.messages[0].content = [{ type: "text", text: "nothing" }]; }))).toBe("user_marker");
  expect(await siteOfArrival(beginWith(t => { t.messages[0].content = [{ type: "text", text: "SHARED:old\nSHARED:new" }]; }))).toBe("absent_marker");
  expect(await siteOfArrival(beginWith(t => { delete t.messages[0].isMeta; }))).toBe("not_meta");
  expect(await siteOfArrival(text(req("begin", 0)), ["{ not json"])).toBe("closed");
});
test("C-P11 the port's reply that the worker cannot frame is named reply_frame, and an unknown thrown value is named decode", async () => {
  const lines: string[] = [];
  const bad = { exchange: async () => new Uint8Array([0, 0, 0, 9, 1]), receipt: () => ({ scriptSha256: "a", receivedFrames: 0, receivedBegins: 0, acceptedBegins: 0, completed: 0, closed: false, turns: [] }), close() {} };
  const counter = P.createProviderCounter(bad as any, line => lines.push(line));
  expect(await counter.arrive(text(req("begin", 0)))).toBeUndefined();
  expect((counter.receipt("x") as any).refusalSites).toEqual([{ n: 1, site: "reply_frame" }]);
  expect(P.siteOf(new Error("boom"))).toBe("decode");
  expect(P.siteOf({ site: "not-a-site" })).toBe("decode");
  expect(P.siteOf({ site: "scope" })).toBe("scope");
  expect(P.siteOf(null)).toBe("decode");
});
test("C-P11 the site list is capped at 16 entries, keeps the first ones, rides the receipt and the summary, and stays inside the report line bound", async () => {
  expect(P.PROVIDER_CONTROL.maxRefusalSites).toBe(16);
  const w = worker();
  await w.counter.arrive(null);
  for (let i = 0; i < 80; i++) await w.counter.arrive("a\0b");
  const receipt = w.counter.receipt("cap") as any, summary = w.counter.summary("signal") as any;
  expect(receipt.refusalSites).toHaveLength(16);
  expect(receipt.refusalSites[0]).toEqual({ n: 1, site: "read_null" });
  expect(receipt.refusalSites[15]).toEqual({ n: 16, site: "frame_empty_or_nul" });
  expect(summary.refusalSites).toEqual(receipt.refusalSites);
  for (const line of w.lines) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(P.PROVIDER_LIMITS.reportLineBytes);
});
test("C-P11 the sites name no request text: a secret-looking marker in a refused request appears in no report line", async () => {
  const w = worker();
  await w.counter.arrive(beginWith(t => { t.system = "TOPSECRET-sentinel"; t.messages[0].content = [{ type: "text", text: "TOPSECRET-sentinel" }]; }));
  w.counter.receipt("leak"); w.counter.summary("signal");
  expect(w.lines.join("")).not.toContain("TOPSECRET");
  expect((w.counter.receipt("z") as any).refusalSites).toEqual([{ n: 1, site: "system_marker" }]);
});
test("C-P10 exit codes are fixed", () => { expect(P.PROVIDER_EXIT).toEqual({ stopped: 0, startupRefused: 2, nativeFailure: 3 }); });

// ---------------------------------------------------------------- hostClient
const fixture = () => ({
  registration: { trustedQuerySessionId: "query-1" }, capture: { workspaceId: "ws" }, bootId: "11111111-1111-1111-1111-111111111111",
  runtimeRow: { winter_session_id: "s1" }, workspace: { workspaceId: "ws" }, binding: { sessionId: "s1" }, policy: { workspaceId: "ws" },
  sources: [{ sourceId: "b", state: "ready" }, { sourceId: "a", state: "ready" }, { sourceId: "gone", state: "detached" }],
  grants: { folder: { ref1: { revoked: false } }, repository: { "auth|repo": { readable: true } } },
});
const RUNTIME_CONFIG = { executionPosture: "confined-guest", sessionId: "backend1", model: "m", cwd: "/workspace/folders/src", winterHome: "/run/winter/conversations/sess", storeHome: "/workspace/.winter/conversations/sess",
  persistSession: true, settingSources: [], tools: ["Read"], allowedTools: [], skills: [], plugins: [], strictMcpConfig: true, mcpServers: {}, permissionMode: "default", permissions: { disableBypassPermissionsMode: true }, allowDangerouslySkipPermissions: false };
const hostMeta = (over: Record<string, unknown> = {}) => ({ version: 1, workspaceKey: "ws", incarnationId: "inc-1", leaseEpoch: 1, prompts: ["p1", "p2"], runtimeConfig: RUNTIME_CONFIG, readerRegistration: { r: 1 }, fixture: fixture(), ...over });
const metaBytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test("C-H1 only the fixed linux argv starts the host client", () => {
  expect(() => H.checkHostStartup("linux", [...H.HOST_ARGV])).not.toThrow();
  for (const bad of [[], [...H.HOST_ARGV, "x"], H.HOST_ARGV.slice(2), H.HOST_ARGV.map(v => (v === "8" ? "9" : v))]) expect(() => H.checkHostStartup("linux", bad)).toThrow("host client refused: argv");
  expect(() => H.checkHostStartup("darwin", [...H.HOST_ARGV])).toThrow("host client refused: platform");
});
test("C-H2 the metadata file must be Root-owned and immutable; the five pipes Root-owned FIFOs", () => {
  const file = (over = {}): H.HostInputStat => ({ isFile: () => true, isFIFO: () => false, uid: 0, nlink: 1, mode: 0o100444, size: 10, ...over });
  expect(() => H.checkRootFile(file(), 100)).not.toThrow();
  for (const over of [{ uid: 5 }, { nlink: 2 }, { mode: 0o100644 }, { size: 101 }, { isFile: () => false }]) expect(() => H.checkRootFile(file(over), 100)).toThrow("host client refused: input");
  const pipe = (over = {}) => file({ isFile: () => false, isFIFO: () => true, ...over });
  expect(() => H.checkRootPipe(pipe())).not.toThrow();
  for (const over of [{ isFIFO: () => false }, { uid: 5 }, { nlink: 2 }]) expect(() => H.checkRootPipe(pipe(over))).toThrow("host client refused: input");
});
test("C-H3 metadata is closed canonical JSON with exactly two prompts and no requiredRuntimeContext", () => {
  expect(H.parseHostMetadata(metaBytes(hostMeta())).workspaceKey).toBe("ws");
  const bad = [hostMeta({ extra: 1 }), hostMeta({ version: 2 }), hostMeta({ workspaceKey: "" }), hostMeta({ leaseEpoch: 0 }), hostMeta({ prompts: ["a"] }), hostMeta({ prompts: ["a", ""] }),
    hostMeta({ prompts: ["a", "b", "c"] }), hostMeta({ prompts: ["a", "x".repeat(1025)] }), hostMeta({ runtimeConfig: { requiredRuntimeContext: {} } }), hostMeta({ runtimeConfig: [] }), hostMeta({ readerRegistration: null }), hostMeta({ readerRegistration: { r: 1, requiredRuntimeContext: { version: 1, bindingId: OTHER_BIND } } }), hostMeta({ readerRegistration: { r: 1, requiredRuntimeContext: null } }),
    hostMeta({ fixture: { ...fixture(), extra: 1 } }), hostMeta({ fixture: { ...fixture(), grants: { folder: {} } } }), hostMeta({ fixture: { ...fixture(), bootId: 1 } })];
  for (const value of bad) expect(() => H.parseHostMetadata(metaBytes(value))).toThrow("host client refused: metadata");
  expect(() => H.parseHostMetadata(Buffer.from(JSON.stringify(hostMeta(), null, 1)))).toThrow("host client refused: metadata");
  expect(() => H.parseHostMetadata(Buffer.from([0xff]))).toThrow("host client refused: metadata");
});
test("C-H5 the fixture records answer exactly the reads Core makes and refuse any other statement or id", () => {
  const built = H.buildFixtureRecords(fixture() as any);
  const { rs } = built.records;
  expect(rs.transaction(() => 7)).toBe(7);
  const sessionSql = "SELECT winter_session_id, runtime_kind FROM runtime_sessions WHERE winter_session_id = ?";
  expect((rs.db.query(sessionSql) as any).get("s1")).toEqual({ winter_session_id: "s1" });
  expect((rs.db.query(sessionSql) as any).get("other")).toBeNull();
  const sourceSql = "SELECT source_id FROM cowork_sources WHERE workspace_id=? AND state!='detached' ORDER BY source_id LIMIT 101";
  expect((rs.db.query(sourceSql) as any).all("ws")).toEqual([{ source_id: "a" }, { source_id: "b" }]);
  expect(() => (rs.db.query(sourceSql) as any).all("other")).toThrow("fixture records refused");
  expect(() => rs.db.query("DELETE FROM runtime_sessions")).toThrow("fixture records refused");
  expect(() => built.records.get("other")).toThrow("fixture records refused");
  expect(() => built.records.binding("x")).toThrow("fixture records refused");
  expect(() => built.records.source("ws", "nope")).toThrow("fixture records refused");
  expect(built.grants.folder("ref1")).toEqual({ revoked: false });
  expect(built.grants.folder("__proto__")).toBeUndefined();
  expect(built.grants.repository("auth", "repo")).toEqual({ readable: true });
  expect(built.registration("query-1")).toBeDefined(); expect(built.registration("query-2")).toBeUndefined();
  expect(built.currentBootId("ws")).toBe("11111111-1111-1111-1111-111111111111");
  expect(() => built.currentBootId("other")).toThrow("fixture records refused");
});

const BIND = "3f2b8c1e-9a47-4d5e-8b21-7c6d5e4f3a29", OTHER_BIND = "11111111-2222-4333-8444-555555555555";
// What the real SDK emits (keys the closed profile refuses, such as `brand`), plus its binding id: the host must never assert this.
const emittedConfig = JSON.stringify({ brand: { name: "x" }, cwd: "/elsewhere", executionPosture: "confined-guest", model: "emitted", permissionMode: "default", sessionId: "emitted", requiredRuntimeContext: { version: 1, bindingId: BIND } });
interface Trace { calls: string[]; lines: any[]; handlerArgs?: any; options?: any; consumed?: any; assertedConfig?: any }
const HAPPY = ["dispatch 1", "dispatch 2", "premint", "reuse", "revoke", "present-premint", "finish"];
function fakes(commands: (string | null)[] = HAPPY, over: { failConfig?: boolean; reuseAccepted?: boolean; longAnswer?: boolean; failResult?: boolean; spawnBeforeRefuse?: boolean; otherError?: boolean; lateResult?: boolean; noContext?: boolean; correlation?: { version: number; bindingId: string }; garbageEmitted?: boolean; emitSpawnThrows?: boolean } = {}) {
  const trace: Trace = { calls: [], lines: [] };
  let resolveLate!: () => void; const late = { promise: new Promise<void>(r => { resolveLate = r; }), resolve: () => resolveLate() };
  let revoked = false, streamDead = false, minted = 0; const spent = new Set<unknown>(), dead = new Set<unknown>(), live = new Set<unknown>(), preparations = new Map<unknown, any>();
  const issuer = {
    advance: (...a: unknown[]) => { trace.calls.push("advance"); trace.consumed = a; },
    mint: (request: any) => { if (revoked) throw new Error("required_context_unavailable"); trace.calls.push("mint"); const ticket = { id: ++minted, preparation: request.preparation }; live.add(ticket); return ticket; },
    revoke: (key: string) => { trace.calls.push(`revoke:${key}`); revoked = true; streamDead = true; late.resolve(); for (const t of live) if (!spent.has(t)) dead.add(t); },
  };
  const sdk: any = {
    claimGuidedGuestIssuer: () => { trace.calls.push("claim"); return issuer; },
    prepareGuidedQuery: (callbacks: any) => { trace.calls.push("prepare"); const prepared = { callbacks }; preparations.set(prepared, callbacks); return prepared; },
    consumeGuidedQueryCorrelation: (claim: any, args: any) => { trace.calls.push("consume"); trace.consumed = { claim, args }; return over.correlation ?? { version: 1, bindingId: BIND }; },
    closeGuidedQuery: () => { trace.calls.push("close"); },
    query: ({ prompt, options }: any) => {
      trace.calls.push("query"); trace.options ??= options;
      return (async function* () {
        const ticket = options.guidedGuestTicket, refusal = new Error(over.otherError ? "something else" : "required_context_unavailable");
        const spawn = () => options.spawnClaudeCodeProcess({ guidedQueryClaim: "claim-token", args: ["--run", "--config-json", over.garbageEmitted ? "not json {" : emittedConfig] });
        if ((spent.has(ticket) && !over.reuseAccepted) || dead.has(ticket)) { if (over.spawnBeforeRefuse) spawn(); throw refusal; }
        spent.add(ticket); spawn();
        let index = 0;
        const iterator = (typeof prompt === "string" ? (async function* () { yield prompt; })() : prompt)[Symbol.asyncIterator]();
        for (;;) {
          const step: any = await Promise.race([iterator.next(), over.lateResult ? late.promise.then(() => "late") : new Promise(() => {})]);
          if (step === "late") { yield { type: "result", subtype: "success" }; break; }
          if (step.done) return;
          if (streamDead) throw new Error("torn down");
          if (index < 2 && !over.noContext) await options.onRuntimeContext({ bindingId: "b" }, { signal: new AbortController().signal });
          yield { type: "assistant", message: { content: [{ type: "text", text: over.longAnswer ? "x".repeat(2000) : `a:${step.value}` }] } };
          yield { type: "result", subtype: over.failResult ? "error_during_execution" : "success" }; index++;
        }
      })();
    },
  };
  const queue = [...commands];
  const ports = {
    sdk, readInstructions: async () => "frame",
    createHandler: (deps: any) => { trace.calls.push("handler"); trace.handlerArgs ??= deps; return async () => ({ snapshot: true }); },
    assertConfig: (config: any, registration: any) => { trace.calls.push("assert"); trace.assertedConfig = { config, registration }; if (over.failConfig) throw new Error("no"); },
    createProcess: () => { trace.calls.push("process"); return { proc: true }; },
    emit: (line: any) => { if (line.kind === "host-spawn") { trace.calls.push("emit-spawn"); if (over.emitSpawnThrows) throw new Error("pipe"); } trace.lines.push(line); },
    nextCommand: async () => (queue.length ? queue.shift()! : null),
  };
  return { trace, ports: ports as any };
}
const run = (fake: ReturnType<typeof fakes>) => H.runGuidedHost(H.parseHostMetadata(metaBytes(hostMeta())), fake.ports) as Promise<any>;
const replies = (fake: ReturnType<typeof fakes>, kind: string) => fake.trace.lines.filter(line => line.kind === kind);

test("C-H6 order: claim issuer, advance, handler, prepare, mint, query; the same callback objects reach prepare and query", async () => {
  const f = fakes([]); await run(f);
  expect(f.trace.calls.slice(0, 6)).toEqual(["claim", "advance", "handler", "prepare", "mint", "query"]);
  const { onRuntimeContext, spawnClaudeCodeProcess, guidedQueryPreparation, requireRuntimeContext, executionPosture, guidedGuestTicket } = f.trace.options;
  expect(guidedQueryPreparation.callbacks.onRuntimeContext).toBe(onRuntimeContext);
  expect(guidedQueryPreparation.callbacks.spawnClaudeCodeProcess).toBe(spawnClaudeCodeProcess);
  expect([requireRuntimeContext, executionPosture, guidedGuestTicket.id]).toEqual([true, "confined-guest", 1]);
  expect(f.trace.options.model).toBe("m");
  // The options the SDK query actually receives: exactly the closed host list plus the guided keys, never Root's config spread.
  expect(Object.keys(f.trace.options).sort()).toEqual([...Object.keys(H.hostQueryOptions(RUNTIME_CONFIG)), "guidedQueryPreparation", "requireRuntimeContext", "onRuntimeContext", "spawnClaudeCodeProcess", "guidedGuestTicket"].sort());
  expect(f.trace.options).not.toHaveProperty("winterHome"); expect(f.trace.options).not.toHaveProperty("storeHome");
});
test("C-H7 the spawn hook consumes the correlation from the exact args and asserts the real emitted config before any process exists", async () => {
  const f = fakes(["dispatch 1", "finish"]); await run(f);
  expect(f.trace.consumed).toEqual({ claim: "claim-token", args: ["--run", "--config-json", emittedConfig] });
  expect(f.trace.assertedConfig).toEqual({ config: { ...RUNTIME_CONFIG, requiredRuntimeContext: { version: 1, bindingId: BIND } }, registration: { r: 1, requiredRuntimeContext: { version: 1, bindingId: BIND } } });
  expect(Object.keys(f.trace.assertedConfig.config)).not.toContain("brand");
  const calls = f.trace.calls;
  expect(calls.indexOf("consume")).toBeLessThan(calls.indexOf("assert")); expect(calls.indexOf("assert")).toBeLessThan(calls.indexOf("emit-spawn")); expect(calls.indexOf("emit-spawn")).toBeLessThan(calls.indexOf("process"));
});
test("C-H7 the registration asserted against is the metadata's plus the SDK's own binding id, frozen, and the metadata object is untouched", async () => {
  const f = fakes(["dispatch 1", "finish"]); const meta = H.parseHostMetadata(metaBytes(hostMeta())); const before = JSON.stringify(meta.readerRegistration);
  await H.runGuidedHost(meta, f.ports);
  const registration = f.trace.assertedConfig.registration;
  expect(Object.isFrozen(registration) && Object.isFrozen(registration.requiredRuntimeContext)).toBe(true);
  expect(JSON.stringify(meta.readerRegistration)).toBe(before); expect(Object.hasOwn(meta.readerRegistration, "requiredRuntimeContext")).toBe(false);
});
test("C-H7 the host-spawn line carries exactly the SDK's binding id, once, before the process exists; no other line carries it", async () => {
  const f = fakes(); await run(f);
  expect(f.trace.lines.filter(line => line.kind === "host-spawn")).toEqual([{ version: 1, kind: "host-spawn", bindingId: BIND }]);
  expect(f.trace.lines.filter(line => JSON.stringify(line).includes(BIND)).map(line => line.kind)).toEqual(["host-spawn"]);
  expect(f.trace.calls.filter(call => call === "emit-spawn")).toHaveLength(1);
});
test("C-H7 a spawn is refused, with no host-spawn line and no process, when the correlation is not a v1 uuid-v4, the config names another or no binding id, or the profile refuses", async () => {
  const cases: Array<[string, Parameters<typeof fakes>[1]]> = [
    ["not a uuid", { correlation: { version: 1, bindingId: "b" } }], ["uppercase uuid", { correlation: { version: 1, bindingId: BIND.toUpperCase() } }],
    ["uuid v1", { correlation: { version: 1, bindingId: "3f2b8c1e-9a47-1d5e-8b21-7c6d5e4f3a29" } }], ["correlation version 2", { correlation: { version: 2, bindingId: BIND } }],
    ["profile refuses", { failConfig: true }],
  ];
  for (const [label, over] of cases) {
    const f = fakes(["dispatch 1", "finish"], over); const result = await run(f);
    expect([label, f.trace.calls.includes("process"), f.trace.lines.some(line => line.kind === "host-spawn")]).toEqual([label, false, false]);
    expect([label, result.passed]).toEqual([label, false]);
  }
});
test("C-H7 the emitted config is never parsed or asserted: unparseable emitted text still spawns, on the trusted config", async () => {
  const f = fakes(["dispatch 1", "finish"], { garbageEmitted: true }); const result = await run(f);
  expect(f.trace.calls).toContain("process"); expect(replies(f, "host-dispatch")[0]).toMatchObject({ ok: true });
  expect(f.trace.assertedConfig.config.sessionId).toBe("backend1"); expect(result.passed).toBe(false); // only because the finish came before the revoke steps
});
test("C-H6 host query options come from Root's config by a closed list: homes, the executable and unknown keys are not forwarded", async () => {
  const options = H.hostQueryOptions({ ...RUNTIME_CONFIG, winterHome: "/x", storeHome: "/y", extra: 1, pathToClaudeCodeExecutable: "evil", env: { A: "1" }, brand: {} });
  expect(Object.keys(options).sort()).toEqual(["allowDangerouslySkipPermissions", "allowedTools", "cwd", "env", "executionPosture", "includePartialMessages", "maxBufferSize", "mcpServers", "model", "pathToClaudeCodeExecutable",
    "permissionMode", "permissions", "persistSession", "plugins", "sessionId", "settingSources", "skills", "strictMcpConfig", "tools"]);
  expect(options.env).toEqual({}); expect(Object.keys(options.env as object)).toEqual([]);
  expect(options).toMatchObject({ executionPosture: "confined-guest", env: {}, pathToClaudeCodeExecutable: "winter-confined-guest", sessionId: "backend1", cwd: "/workspace/folders/src", allowDangerouslySkipPermissions: false });
  expect(H.hostQueryOptions({ ...RUNTIME_CONFIG, executionPosture: "none", allowDangerouslySkipPermissions: "yes" })).toMatchObject({ executionPosture: "confined-guest", allowDangerouslySkipPermissions: false });
  expect(H.hostQueryOptions({ ...RUNTIME_CONFIG, allowDangerouslySkipPermissions: true }).allowDangerouslySkipPermissions).toBe(true);
});
test("C-H4 the registration id is never printed or compared: no stdout line carries it", async () => {
  const meta = hostMeta({ readerRegistration: { r: 1, registrationId: "5e0b0000-0000-4000-8000-000000000001" } });
  const f = fakes(); await H.runGuidedHost(H.parseHostMetadata(metaBytes(meta)), f.ports);
  expect(JSON.stringify(f.trace.lines)).not.toContain("5e0b0000");
  expect(f.trace.assertedConfig.registration.registrationId).toBe("5e0b0000-0000-4000-8000-000000000001");
});
test("C-H7 if the host-spawn line cannot be written, no process is created", async () => {
  const f = fakes(["dispatch 1", "finish"], { emitSpawnThrows: true }); const result = await run(f);
  expect(f.trace.calls).not.toContain("process"); expect(result.passed).toBe(false);
});
test("C-H7 a refused config creates no process; the dispatch reports failure and the run does not pass", async () => {
  const f = fakes(["dispatch 1", "finish"], { failConfig: true }); const result = await run(f);
  expect(f.trace.calls).not.toContain("process");
  expect(replies(f, "host-dispatch")[0]).toMatchObject({ n: 1, ok: false, ended: "failed:config" });
  expect(result.passed).toBe(false);
});
test("C-H8 the record, grant, boot and registration ports given to Core are the in-memory fixture, and frames are the SDK's reader", async () => {
  const f = fakes([]); await run(f);
  const deps = f.trace.handlerArgs;
  expect(Object.keys(deps).sort()).toEqual(["capture", "currentBootId", "frames", "grants", "records", "registration"]);
  expect(deps.capture).toEqual({ workspaceId: "ws" });
  expect(await deps.frames.readFrame(new AbortController().signal)).toBe("frame");
});
test("C-H9 each command gets exactly one reply: dispatch answers, premint, spent-ticket reuse, revoke, premint presented after the revoke", async () => {
  const f = fakes(); const result = await run(f);
  const kinds = f.trace.lines.map(line => line.kind).filter(kind => kind !== "host-spawn" && kind !== "host-query-ended");
  expect(kinds).toEqual(["host-dispatch", "host-dispatch", "host-premint", "host-presented", "host-revoked", "host-presented", "host-result"]);
  expect(replies(f, "host-dispatch").map(line => [line.n, line.ok, line.answer])).toEqual([[1, true, "a:p1"], [2, true, "a:p2"]]);
  expect(replies(f, "host-presented")).toEqual([
    { version: 1, kind: "host-presented", which: "spent", refused: true, errorClass: "required_context_unavailable", processStarted: false },
    { version: 1, kind: "host-presented", which: "premint", refused: true, errorClass: "required_context_unavailable", processStarted: false }]);
  expect(result).toMatchObject({ passed: true, dispatchesOk: 2, revoked: true, reuseRefused: true, presentRefused: true, resultsAfterRevoke: 0, refusedCommands: 0 });
  expect(f.trace.lines.at(-1)).toEqual(result);
});
test("C-H10 the premint is minted BEFORE the revoke and presented after it; the issuer revoke is the only revoke", async () => {
  const f = fakes(); await run(f);
  const order = f.trace.calls.filter(call => call === "mint" || call.startsWith("revoke") || call === "query");
  expect(order).toEqual(["mint", "query", "mint", "query", "revoke:ws", "query"]);
  expect(f.trace.calls.lastIndexOf("mint")).toBeLessThan(f.trace.calls.indexOf("revoke:ws"));
  expect(f.trace.calls.filter(call => call.startsWith("revoke"))).toEqual(["revoke:ws"]);
});
test("C-H10 a presentation that is NOT refused is reported as such and fails the run", async () => {
  const f = fakes(HAPPY, { reuseAccepted: true }); const result = await run(f);
  expect(replies(f, "host-presented")[0]).toMatchObject({ which: "spent", refused: false, errorClass: "none", processStarted: true });
  expect(result).toMatchObject({ passed: false, reuseRefused: false });
});
test("C-H7 a second spawn, from any preparation, is refused before anything is consumed or created", async () => {
  const f = fakes(HAPPY, { reuseAccepted: true }); const result = await run(f);
  expect(f.trace.calls.filter(call => call === "process")).toHaveLength(1);
  expect(f.trace.calls.filter(call => call === "consume")).toHaveLength(1);
  expect(f.trace.calls.filter(call => call === "assert")).toHaveLength(1);
  expect(replies(f, "host-presented")[0]).toMatchObject({ which: "spent", refused: false, processStarted: true });
  expect(result.passed).toBe(false);
  const both = fakes(HAPPY, { reuseAccepted: true, spawnBeforeRefuse: true }); await run(both);
  expect(both.trace.calls.filter(call => call === "process")).toHaveLength(1);
});
test("C-H10 the first query is torn down by the revoke and says so; a dispatch after it is refused as out of order", async () => {
  const f = fakes(["dispatch 1", "dispatch 2", "revoke", "dispatch 1", "finish"]); const result = await run(f);
  expect(replies(f, "host-query-ended")).toHaveLength(1);
  expect(replies(f, "host-command-refused")).toEqual([{ version: 1, kind: "host-command-refused", code: "order" }]);
  expect(result.passed).toBe(false);
});
test("C-H11 unknown, malformed and out-of-order commands are refused with a closed code and never execute", async () => {
  for (const bad of ["", "dispatch 3", "dispatch  1", "Dispatch 1", "revoke\r", "reuse now", "oversize", "dispatch 1 "]) {
    const f = fakes([bad, "finish"]); const result = await run(f);
    expect(replies(f, "host-command-refused")).toEqual([{ version: 1, kind: "host-command-refused", code: "unknown" }]);
    expect(f.trace.calls.filter(call => call.startsWith("revoke"))).toEqual([]);
    expect(result.passed).toBe(false);
  }
  for (const early of [["dispatch 2"], ["reuse"], ["present-premint"], ["revoke", "revoke"], ["revoke", "premint"], ["premint", "premint"], ["premint", "present-premint"], ["dispatch 1", "revoke", "dispatch 2"]]) {
    const f = fakes([...early, "finish"]); const result = await run(f);
    expect(replies(f, "host-command-refused").length).toBeGreaterThan(0); expect(result.refusedCommands).toBeGreaterThan(0); expect(result.passed).toBe(false);
  }
  expect(H.parseCommand("finish")).toBe("finish");
});
test("C-H11 end of input without finish, or a failed dispatch result, does not pass", async () => {
  expect((await run(fakes(HAPPY.slice(0, -1)))).passed).toBe(false);
  const f = fakes(HAPPY, { failResult: true }); const result = await run(f);
  expect(replies(f, "host-dispatch")[0]).toMatchObject({ ok: false }); expect(result.passed).toBe(false);
});
test("C-H11 the run passes only if every step happened: a skipped reuse or present, a late result, a refused command, a missing context call or a non-closed refusal fails it", async () => {
  for (const commands of [["dispatch 1", "dispatch 2", "premint", "reuse", "revoke", "finish"], ["dispatch 1", "dispatch 2", "premint", "revoke", "present-premint", "finish"],
    ["nonsense", ...HAPPY], ["dispatch 1", "finish"], HAPPY.slice(0, 2).concat("finish")]) expect((await run(fakes(commands))).passed).toBe(false);
  expect((await run(fakes(HAPPY, { noContext: true }))).passed).toBe(false);
  const late = await run(fakes(HAPPY, { lateResult: true })); expect(late).toMatchObject({ passed: false, resultsAfterRevoke: 1 });
  const other = fakes(HAPPY, { otherError: true }); const result = await run(other);
  expect(replies(other, "host-presented").map(line => [line.refused, line.errorClass])).toEqual([[true, "other"], [true, "other"]]);
  expect(result).toMatchObject({ passed: false, reuseRefused: false, presentRefused: false });
  const spawned = fakes(HAPPY, { spawnBeforeRefuse: true }); const spawnedResult = await run(spawned);
  expect(replies(spawned, "host-presented")[0]).toMatchObject({ refused: false, processStarted: true }); expect(spawnedResult.passed).toBe(false);
});
test("C-H4 stdout carries only the closed line kinds and never a prompt, binding id or claim; an answer is bounded", async () => {
  const f = fakes(); await run(f);
  expect([...new Set(f.trace.lines.map(line => line.kind))].sort()).toEqual(["host-dispatch", "host-premint", "host-presented", "host-query-ended", "host-result", "host-revoked", "host-spawn"]);
  for (const line of f.trace.lines.map(line => JSON.stringify(line))) { expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(H.HOST_LIMITS.reportLineBytes); expect(line).not.toMatch(/"p[123]"|claim-token|"b"|frame/); if (!line.includes("host-spawn")) expect(line).not.toContain(BIND); }
  const long = fakes(["dispatch 1", "finish"], { longAnswer: true }); await run(long);
  expect(replies(long, "host-dispatch")[0].answer.length).toBe(H.HOST_ANSWER_BYTES);
  expect(H.HOST_COMMANDS).toEqual(["dispatch 1", "dispatch 2", "premint", "reuse", "revoke", "present-premint", "finish"]);
});
test("C-H12 failure codes are closed and never echo a message; exit codes are fixed", () => {
  expect(H.hostFailureCode(new Error("required_context_unavailable"))).toBe("required_context_unavailable");
  expect(H.hostFailureCode(new Error("/some/path secret"))).toBe("host_failure");
  expect(H.hostFailureCode("string")).toBe("host_failure");
  expect(H.hostFailureCode(new Error("toString"))).toBe("host_failure");
  expect(H.refusalClass(new Error("required_context_unavailable"))).toBe("required_context_unavailable");
  expect(H.refusalClass(new Error("secret path"))).toBe("other");
  expect(H.HOST_EXIT).toEqual({ passed: 0, runFailed: 1, startupRefused: 2 });
});
