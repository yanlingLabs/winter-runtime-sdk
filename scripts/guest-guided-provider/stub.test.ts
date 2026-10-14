import { expect, test } from "bun:test";
import { createGuidedFixturePort, encodeFrame, LIMITS, SELECTION, sha256 } from "./stub.ts";

const scope = { homeId: "home", workspaceId: "workspace", sessionId: "logical", backendSessionId: "backend", taskId: "task", incarnationId: "incarnation", bootId: "boot", leaseEpoch: 1, grantRevision: 2, accountRevision: 3, modelRevision: 4 };
function script() { return { version: 1, scope: { ...scope }, selection: SELECTION, steps: [{ system: ["FACT:workspace", "HOST:publication"], user: ["SHARED:old", "SOURCE:root", "SOURCE:cwd"], response: "guided-one" }, { system: ["FACT:workspace", "HOST:publication"], user: ["SHARED:new", "SOURCE:root", "SOURCE:cwd"], response: "guided-two" }] }; }
function port(value: unknown = script()) { const bytes = Buffer.from(JSON.stringify(value)); return createGuidedFixturePort(bytes, sha256(bytes)); }
function turn(second = false) { return { model: SELECTION.providerModelId, system: "FACT:workspace\n\nHOST:publication", systemBlocks: [{ text: "FACT:workspace", cacheScope: "org" }, { text: "HOST:publication", cacheScope: null }], messages: [{ role: "user", isMeta: true, content: [{ type: "text", text: `SHARED:${second ? "new" : "old"}\nSOURCE:root\nSOURCE:cwd` }] }, { role: "user", content: "question" }], cacheKey: "runtime-generated" }; }
function request(operation = "begin", sequence = 0, ordinal = 1, id = "invocation-one"): Record<string, unknown> { return { version: 1, operation, invocationId: id, invocationOrdinal: ordinal, scope, sequence, ...(operation === "begin" ? { turn: turn(ordinal === 2) } : {}) }; }
function decode(bytes: Uint8Array) { return JSON.parse(Buffer.from(bytes).subarray(4).toString()); }
async function finish(p: ReturnType<typeof port>, ordinal = 1, id = "invocation-one") {
  const begin = request("begin", 0, ordinal, id);
  expect(decode(await p.exchange(encodeFrame(begin)))).toEqual({ version: 1, invocationId: id, sequence: 0, kind: "accepted" });
  expect(decode(await p.exchange(encodeFrame(request("next", 1, ordinal, id))))).toMatchObject({ kind: "event", event: { type: "text_delta", text: ordinal === 1 ? "guided-one" : "guided-two" } });
  expect(decode(await p.exchange(encodeFrame(request("next", 2, ordinal, id))))).toMatchObject({ kind: "event", event: { type: "done", stopReason: "end_turn" } });
}

test("two framed normalized turns capture current role data and deterministic events without engine dispatch", async () => {
  const p = port(); await finish(p); await finish(p, 2, "invocation-two");
  const receipt = p.receipt();
  expect(receipt).toMatchObject({ receivedFrames: 6, receivedBegins: 2, acceptedBegins: 2, completed: 2, engineDispatchProven: false, nativeAdmissionProven: false });
  expect(receipt.turns[0]?.turn).toEqual(turn()); expect(receipt.turns[1]?.turn).toEqual(turn(true));
  expect(receipt.turns[0]?.sha256).toMatch(/^[a-f0-9]{64}$/); expect(receipt.turns[1]?.sha256).not.toBe(receipt.turns[0]?.sha256);
  expect(Object.isFrozen(receipt.turns[0]?.turn.messages)).toBe(true);
  expect(() => { (receipt as any).receivedBegins = 0; }).toThrow();
});

test("hash/closed script/refused selection cannot create a port", () => {
  const bytes = Buffer.from(JSON.stringify(script()));
  expect(() => createGuidedFixturePort(bytes, "0".repeat(64))).toThrow("fixture refused");
  for (const mutate of [
    (s: any) => { s.authorized = true; }, (s: any) => { s.version = 2; },
    (s: any) => { s.selection = { ...s.selection, providerModelId: "other" }; },
    (s: any) => { s.steps.push(s.steps[0]); }, (s: any) => { s.steps[0].user = []; },
    (s: any) => { s.scope.backendSessionId = ""; }, (s: any) => { s.scope.leaseEpoch = 0; },
    (s: any) => { s.steps[0].response = "x".repeat(LIMITS.textBytes + 1); },
  ]) { const s = script(); mutate(s); expect(() => port(s)).toThrow("fixture refused"); }
});

test("zero after close is observed only when no ingress occurs; closed begins still count", async () => {
  const p = port(); await finish(p); await finish(p, 2, "invocation-two"); p.close();
  const baseline = p.receipt(); expect(p.receipt().receivedBegins - baseline.receivedBegins).toBe(0);
  await expect(p.exchange(encodeFrame(request("begin", 0, 3, "third")))).rejects.toThrow("fixture refused");
  expect(p.receipt().receivedBegins - baseline.receivedBegins).toBe(1);
  expect(p.receipt().receivedFrames - baseline.receivedFrames).toBe(1);
  expect(p.receipt().acceptedBegins).toBe(2); expect(baseline.receivedBegins).toBe(2);
});

test("malformed framing, UTF8, duplicates and oversize count ingress and fail closed", async () => {
  const valid = encodeFrame(request()), wrongLength = valid.slice(); wrongLength[0] = 1;
  const duplicated = Buffer.from(JSON.stringify(request()).replace('"version":1', '"version":0,"version":1'));
  const invalidUtf8 = new Uint8Array([0, 0, 0, 1, 255]);
  const duplicateFrame = Buffer.alloc(duplicated.length + 4); duplicateFrame.writeUInt32BE(duplicated.length); duplicated.copy(duplicateFrame, 4);
  for (const frame of [new Uint8Array(), wrongLength, invalidUtf8, duplicateFrame, new Uint8Array(LIMITS.requestBytes + 5)]) {
    const p = port(); await expect(p.exchange(frame)).rejects.toThrow("fixture refused");
    expect(p.receipt()).toMatchObject({ receivedFrames: 1, acceptedBegins: 0, closed: true });
  }
});

test("foreign scope/model, unknown envelope/turn, wrong sequence and incoming assertions refuse", async () => {
  for (const mutate of [
    (r: any) => { r.scope = { ...scope, grantRevision: 99 }; }, (r: any) => { r.turn.model = "other"; },
    (r: any) => { r.authorized = true; }, (r: any) => { r.turn.expectedMarkers = script().steps[0]; },
    (r: any) => { r.sequence = 1; }, (r: any) => { r.invocationOrdinal = 2; },
    (r: any) => { r.turn.systemBlocks[0].text = "contradictory"; },
    (r: any) => { r.turn.messages[0].content[0].unexpected = true; },
    (r: any) => { r.turn.tools = [{ name: "Read", description: "text", inputSchema: {}, executable: "never" }]; },
    (r: any) => { r.turn.effort = {}; }, (r: any) => { r.turn.thinking = { type: "unknown" }; },
    (r: any) => { r.turn.toolChoice = { type: "tool" }; }, (r: any) => { r.turn.cacheDiagnostics = {}; },
  ]) { const p = port(), r = request(); mutate(r); await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused"); expect(p.receipt()).toMatchObject({ receivedBegins: 1, acceptedBegins: 0, closed: true }); }
});

test("stale history, wrong role/order and missing host obligation cannot satisfy markers", async () => {
  for (const mutate of [
    (r: any) => { r.turn.messages[0].content[0].text = "SOURCE:root\nSHARED:old\nSOURCE:cwd"; },
    (r: any) => { r.turn.messages[0].role = "assistant"; },
    (r: any) => { delete r.turn.messages[0].isMeta; },
    (r: any) => { r.turn.messages[0].content[0].text = "missing"; r.turn.messages[1].content = "SHARED:old SOURCE:root SOURCE:cwd"; },
    (r: any) => { r.turn.system = "FACT:workspace"; delete r.turn.systemBlocks; },
  ]) { const p = port(), r = request(); mutate(r); await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused"); }
  const p = port(); await finish(p); const r = request("begin", 0, 2, "two"); r.turn = turn();
  await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused"); expect(p.receipt().receivedBegins).toBe(2); expect(p.receipt().acceptedBegins).toBe(1);
});

test("replay, cross-invocation pulls, cancel and aborted ingress retain counts and fence", async () => {
  const replay = port(); await finish(replay); await expect(replay.exchange(encodeFrame(request("begin", 0, 2)))).rejects.toThrow(); expect(replay.receipt().acceptedBegins).toBe(1);
  for (const r of [request("next", 2), request("next", 1, 1, "foreign"), request("next", 1, 2), { ...request("next", 1), turn: turn() }]) {
    const p = port(); await p.exchange(encodeFrame(request())); await expect(p.exchange(encodeFrame(r))).rejects.toThrow(); expect(p.receipt().closed).toBe(true);
  }
  const p = port(); await p.exchange(encodeFrame(request())); expect(decode(await p.exchange(encodeFrame(request("cancel", 1))))).toMatchObject({ kind: "closed" }); expect(p.receipt()).toMatchObject({ completed: 0, receivedFrames: 2, closed: true });
  const aborted = port(), abort = new AbortController(); abort.abort(); await expect(aborted.exchange(encodeFrame(request()), abort.signal)).rejects.toThrow(); expect(aborted.receipt()).toMatchObject({ receivedBegins: 1, acceptedBegins: 0 });
});
