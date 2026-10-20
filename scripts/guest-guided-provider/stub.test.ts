import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { createGuidedFixturePort, encodeFrame, LIMITS, SELECTION, STANDIN_SELECTION, sha256 } from "./stub.ts";

const scope = { homeId: "home", workspaceId: "workspace", sessionId: "logical", backendSessionId: "backend", taskId: "task", incarnationId: "incarnation", bootId: "boot", leaseEpoch: 1, grantRevision: 2, accountRevision: 3, modelRevision: 4 };
function script() { return { version: 1, scope: { ...scope }, selection: SELECTION, steps: [{ system: ["FACT:workspace", "HOST:publication"], user: ["SHARED:old", "SOURCE:root", "SOURCE:cwd"], absentSystem: [], absentUser: ["SHARED:new"], response: "guided-one" }, { system: ["FACT:workspace", "HOST:publication"], user: ["SHARED:new", "SOURCE:root", "SOURCE:cwd"], absentSystem: [], absentUser: ["SHARED:old"], response: "guided-two" }] }; }
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
  const baseline = p.receipt(); expect(baseline).toMatchObject({ receivedFrames: 6, receivedBegins: 2, completed: 2, closed: true });
  await expect(p.exchange(encodeFrame(request("begin", 0, 3, "third")))).rejects.toThrow("fixture refused");
  expect(p.receipt().receivedBegins - baseline.receivedBegins).toBe(1);
  expect(p.receipt().receivedFrames - baseline.receivedFrames).toBe(1);
  expect(p.receipt().acceptedBegins).toBe(2); expect(baseline.receivedBegins).toBe(2);
});

test("current guidance excludes old markers and matches only complete delimited lines", async () => {
  const mixed = port(); await finish(mixed);
  const second = request("begin", 0, 2, "two") as any;
  second.turn.messages[0].content[0].text = "SHARED:old\nSHARED:new\nSOURCE:root\nSOURCE:cwd";
  await expect(mixed.exchange(encodeFrame(second))).rejects.toThrow("fixture refused: absent_marker");
  expect(mixed.receipt().acceptedBegins).toBe(1);
  for (const marker of ["SHARED:older", "prefix SHARED:old", "SHARED:old suffix"]) {
    const control = port(); await finish(control);
    const p = port(), r = request() as any;
    r.turn.messages[0].content[0].text = `${marker}\nSOURCE:root\nSOURCE:cwd`;
    await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused: user_marker");
  }
});

test("absence refuses stale substrings in either role while ordered markers stay line-exact", async () => {
  for (const leak of ["note: SHARED:old", "SHARED:old suffix", "SHARED:older"]) {
    const control = port(); await finish(control); await finish(control, 2, "two");
    const p = port(); await finish(p); const r = request("begin", 0, 2, "two") as any;
    r.turn.messages[0].content[0].text += `\n${leak}`;
    await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused: absent_marker");
    expect(p.receipt()).toMatchObject({ acceptedBegins: 1, receivedBegins: 2, closed: true });
  }
  const s = script(); (s.steps[0] as { absentSystem: string[] }).absentSystem = ["STALE:fact"];
  const control = port(s); await finish(control);
  const p = port(s), r = request() as any; r.turn.system += "\nnote: STALE:fact suffix"; delete r.turn.systemBlocks;
  await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused: absent_marker");
});

test("multiple text blocks preserve marker lines and cannot hide old guidance", async () => {
  const p = port(), r = request() as any;
  r.turn.messages[0].content = ["SHARED:old", "SOURCE:root", "SOURCE:cwd"].map(text => ({ type: "text", text }));
  expect(decode(await p.exchange(encodeFrame(r))).kind).toBe("accepted");
  const control = port(); await finish(control); await finish(control, 2, "two");
  const mixed = port(); await finish(mixed); const second = request("begin", 0, 2, "two") as any;
  second.turn.messages[0].content = ["SHARED:new", "SOURCE:root", "SOURCE:cwd", "note: SHARED:old"].map(text => ({ type: "text", text }));
  await expect(mixed.exchange(encodeFrame(second))).rejects.toThrow("fixture refused: absent_marker");
});

test("CRLF and first-line markers work, absent arrays may be empty but must exist", async () => {
  const p = port(), r = request() as any;
  r.turn.messages[0].content[0].text = "SHARED:old\r\nSOURCE:root\r\nSOURCE:cwd";
  r.turn.system = "FACT:workspace\r\n\r\nHOST:publication"; delete r.turn.systemBlocks;
  expect(decode(await p.exchange(encodeFrame(r))).kind).toBe("accepted");
  const empty = script(); empty.steps[0]!.absentUser = []; const control = port(empty); await finish(control);
  for (const key of ["absentSystem", "absentUser"]) {
    const s = script() as any; delete s.steps[0][key];
    expect(() => port(s)).toThrow("fixture refused: keys");
  }
});

test("enum arrays refuse, and every closed or malformed ingress remains counted", async () => {
  for (const mutate of [
    (r: any) => { r.turn.effort = ["low"]; },
    (r: any) => { r.turn.thinking = { type: ["enabled"] }; },
    (r: any) => { r.turn.toolChoice = { type: ["auto"] }; },
    (r: any) => { r.turn.messages[1].role = ["user"]; },
    (r: any) => { r.turn.cacheTtl = ["5m"]; },
    (r: any) => { r.turn.messages[1].decoration = { text: "tag", door: ["tag"] }; },
  ]) { const p = port(), r = request(); mutate(r); await expect(p.exchange(encodeFrame(r))).rejects.toThrow("fixture refused"); }
  const p = port(); p.close();
  for (const [frame, begins] of [[null, 0], [encodeFrame(request("next", 1)), 0], [encodeFrame(request()), 1]] as const) {
    const before = p.receipt();
    await expect(p.exchange(frame as Uint8Array)).rejects.toThrow("fixture refused");
    const after = p.receipt();
    expect(after.receivedFrames).toBe(before.receivedFrames + 1);
    expect(after.receivedBegins).toBe(before.receivedBegins + begins);
    expect(after.acceptedBegins).toBe(0);
  }
  expect(p.receipt()).toMatchObject({ receivedFrames: 3, receivedBegins: 1, closed: true });
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

// ---- reserved `winter-standin` selection: reachable only by explicit choice; the default behaviour is unchanged ----
const standinScript = (over: (s: any) => void = () => {}) => {
  const value: any = { version: 1, scope: { ...scope }, selection: STANDIN_SELECTION, steps: [
    { system: [], user: [], absentSystem: [], absentUser: [], response: "canned-one" }, { system: [], user: [], absentSystem: [], absentUser: [], response: "canned-two" }] };
  over(value); return value;
};
const standinPort = (value: unknown = standinScript()) => { const bytes = Buffer.from(JSON.stringify(value)); return createGuidedFixturePort(bytes, sha256(bytes), STANDIN_SELECTION); };
const standinTurn = (over: (t: any) => void = () => {}) => { const t: any = { model: STANDIN_SELECTION.providerModelId, system: "any", messages: [{ role: "user", content: "hello" }] }; over(t); return t; };
const standinRequest = (operation = "begin", sequence = 0, ordinal = 1, id = "invocation-one", t: unknown = standinTurn()): Record<string, unknown> => ({ version: 1, operation, invocationId: id, invocationOrdinal: ordinal, scope, sequence, ...(operation === "begin" ? { turn: t } : {}) });
async function standinFinish(p: ReturnType<typeof standinPort>, ordinal: number, id: string) {
  for (const [operation, sequence] of [["begin", 0], ["next", 1], ["next", 2]] as const) await p.exchange(encodeFrame(standinRequest(operation, sequence, ordinal, id, standinTurn())));
}

test("the default selection and the default port are byte-for-byte what they were", () => {
  expect(JSON.stringify(SELECTION)).toBe('{"providerId":"openai","modelKey":"openai/gpt-5.6","providerModelId":"gpt-5.6","family":"openai","protocol":"openai-responses","continuationDomain":"openai/gpt-5.6","capabilities":{"toolCalling":"native","readableState":"summary"}}');
  expect(JSON.stringify(STANDIN_SELECTION)).toBe('{"providerId":"winter-standin","modelKey":"winter-standin/scripted","providerModelId":"scripted","family":"winter-standin","protocol":"openai-responses","continuationDomain":"winter-standin/scripted","capabilities":{"toolCalling":"native","readableState":"summary"}}');
  expect(Object.isFrozen(STANDIN_SELECTION) && Object.isFrozen(STANDIN_SELECTION.capabilities)).toBe(true);
  const bytes = Buffer.from(JSON.stringify(script())); // no third argument: the same port as before
  expect(createGuidedFixturePort(bytes, sha256(bytes)).receipt()).toMatchObject({ receivedFrames: 0, closed: false });
});
test("the stand-in serves exactly two canned answers with empty markers and a non-meta first message, then refuses and counts a third begin", async () => {
  const p = standinPort();
  await standinFinish(p, 1, "i1"); await standinFinish(p, 2, "i2");
  expect(p.receipt()).toMatchObject({ receivedFrames: 6, receivedBegins: 2, acceptedBegins: 2, completed: 2, closed: false });
  await expect(p.exchange(encodeFrame(standinRequest("begin", 0, 3, "i3")))).rejects.toThrow("fixture refused");
  expect(p.receipt()).toMatchObject({ receivedFrames: 7, receivedBegins: 3, acceptedBegins: 2, completed: 2, closed: true });
});
test("the stand-in's answers are its script's", async () => {
  const p = standinPort();
  expect(decode(await p.exchange(encodeFrame(standinRequest())))).toMatchObject({ kind: "accepted" });
  expect(decode(await p.exchange(encodeFrame(standinRequest("next", 1))))).toMatchObject({ kind: "event", event: { text: "canned-one" } });
});
test("each selection accepts only its own script and its own model", async () => {
  const bytesOf = (value: unknown) => Buffer.from(JSON.stringify(value));
  const standinBytes = bytesOf(standinScript()), defaultBytes = bytesOf(script());
  expect(() => createGuidedFixturePort(standinBytes, sha256(standinBytes))).toThrow("fixture refused"); // default port, stand-in script
  expect(() => createGuidedFixturePort(defaultBytes, sha256(defaultBytes), STANDIN_SELECTION)).toThrow("fixture refused"); // stand-in port, default script
  const wrongModel = standinPort(); await expect(wrongModel.exchange(encodeFrame(standinRequest("begin", 0, 1, "i1", standinTurn(t => { t.model = SELECTION.providerModelId; }))))).rejects.toThrow("fixture refused");
  const defaultPort = port(); await expect(defaultPort.exchange(encodeFrame({ ...request(), turn: { ...turn(), model: STANDIN_SELECTION.providerModelId } }))).rejects.toThrow("fixture refused");
});
test("empty markers and a non-meta first message are accepted ONLY by the stand-in", async () => {
  for (const mutate of [(s: any) => { s.steps[0].system = []; }, (s: any) => { s.steps[0].user = []; }]) { const v = script(); mutate(v); expect(() => port(v)).toThrow("fixture refused"); }
  const nonMeta = port(); await expect(nonMeta.exchange(encodeFrame({ ...request(), turn: { ...turn(), messages: [{ role: "user", content: "hello" }] } }))).rejects.toThrow("fixture refused");
});
test("the stand-in keeps every other refusal: scope, order, replay, absent markers, marker lines, bad hash, extra keys", async () => {
  const bytes = Buffer.from(JSON.stringify(standinScript()));
  expect(() => createGuidedFixturePort(bytes, "0".repeat(64), STANDIN_SELECTION)).toThrow("fixture refused");
  for (const mutate of [(s: any) => { s.authorized = true; }, (s: any) => { s.version = 2; }, (s: any) => { s.steps.push(s.steps[0]); }, (s: any) => { s.scope.leaseEpoch = 0; },
    (s: any) => { s.selection = SELECTION; }, (s: any) => { s.steps[0].system = "x"; }, (s: any) => { s.steps[0].response = ""; }, (s: any) => { s.steps[0].user = ["a\nb"]; }]) expect(() => standinPort(standinScript(mutate))).toThrow("fixture refused");
  const wrongScope = standinPort(); await expect(wrongScope.exchange(encodeFrame({ ...standinRequest(), scope: { ...scope, taskId: "other" } }))).rejects.toThrow("fixture refused");
  const replay = standinPort(); await replay.exchange(encodeFrame(standinRequest())); await expect(replay.exchange(encodeFrame(standinRequest()))).rejects.toThrow("fixture refused");
  const absent = standinPort(standinScript(s => { s.steps[0].absentSystem = ["FORBIDDEN"]; }));
  await expect(absent.exchange(encodeFrame(standinRequest("begin", 0, 1, "i1", standinTurn(t => { t.system = "FORBIDDEN"; }))))).rejects.toThrow("fixture refused");
  const marked = standinPort(standinScript(s => { s.steps[0].user = ["MUST:see"]; })); // non-empty markers are still enforced
  await expect(marked.exchange(encodeFrame(standinRequest()))).rejects.toThrow("fixture refused");
});
test("the selection argument is explicit and exact: undefined is the default; a copy, null, a string or another object is refused", () => {
  const bytes = Buffer.from(JSON.stringify(script())), hash = sha256(bytes);
  expect(() => createGuidedFixturePort(bytes, hash, undefined)).not.toThrow();
  expect(() => createGuidedFixturePort(bytes, hash, SELECTION)).not.toThrow();
  for (const bad of [{ ...SELECTION }, { ...STANDIN_SELECTION }, null, "winter-standin", {}, 0] as any[]) expect(() => createGuidedFixturePort(bytes, hash, bad)).toThrow("fixture refused");
});

// The engine merges the meta userContext message into the following user turn (request-layout.ts buildRequestMessages), so a real first message has no `isMeta`.
const merged = (second = false) => ({ ...turn(second), messages: [{ role: "user", content: [{ type: "text", text: `<system-reminder>\n# claudeMd\nSHARED:${second ? "new" : "old"}\nSOURCE:root\nSOURCE:cwd\n\n</system-reminder>\n` }, { type: "text", text: "question" }] }] });
const withTurn = (value: unknown, ordinal = 1, id = "invocation-one") => ({ ...request("begin", 0, ordinal, id), turn: value });
const refusedAt = async (value: unknown) => { const p = port(); try { await p.exchange(encodeFrame(withTurn(value))); } catch (error: any) { return error.site; } return undefined; };

test("the real merged first message (a reminder block then the prompt, no isMeta) is the current userContext, and the old separate-meta shape still is", async () => {
  const p = port();
  expect(decode(await p.exchange(encodeFrame(withTurn(merged()))))).toMatchObject({ kind: "accepted" });
  await finish(port());
  const q = port();
  expect(decode(await q.exchange(encodeFrame(withTurn(turn()))))).toMatchObject({ kind: "accepted" });
});
test("a first message that is neither meta nor opens with the reminder marker is not the userContext", async () => {
  const plain = { ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "SHARED:old\nSOURCE:root\nSOURCE:cwd" }, { type: "text", text: "question" }] }] };
  expect(await refusedAt(plain)).toBe("not_meta");
  const late = { ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "question" }, { type: "text", text: "<system-reminder>\nSHARED:old\nSOURCE:root\nSOURCE:cwd\n</system-reminder>" }] }] };
  expect(await refusedAt(late)).toBe("not_meta");
  const text = { ...turn(), messages: [{ role: "user", content: "SHARED:old\nSOURCE:root\nSOURCE:cwd" }] };
  expect(await refusedAt(text)).toBe("not_meta");
  expect(await refusedAt({ ...turn(), messages: [{ role: "assistant", content: "<system-reminder>" }, { role: "user", content: "q" }] })).toBe("not_meta");
  // the reminder-first shape needs an ARRAY of at least two blocks whose first is one closed reminder
  expect(await refusedAt({ ...turn(), messages: [{ role: "user", content: "<system-reminder>\nSHARED:old\nSOURCE:root\nSOURCE:cwd\n</system-reminder>" }] })).toBe("not_meta");
  expect(await refusedAt({ ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nSHARED:old\nSOURCE:root\nSOURCE:cwd\n</system-reminder>" }] }] })).toBe("not_meta");
  expect(await refusedAt({ ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nSHARED:old\nSOURCE:root\nSOURCE:cwd" }, { type: "text", text: "q" }] }] })).toBe("not_meta");
  expect(await refusedAt({ ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nSHARED:old\n</system-reminder>\nSOURCE:root\nSOURCE:cwd\n</system-reminder>" }, { type: "text", text: "q" }] }] })).toBe("not_meta");
});
test("reviewer probes: markers carried by the prompt block, or by one block the user typed, are not the userContext", async () => {
  // (a) a reminder block with no markers, then a prompt block that carries them
  const a = { ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder>\nnothing here\n</system-reminder>\n" }, { type: "text", text: "SHARED:old\nSOURCE:root\nSOURCE:cwd" }] }] };
  expect(await refusedAt(a)).toBe("user_marker");
  // (b) one user-typed block that opens with the tag and carries the markers (no second block, no closing tag)
  const b = { ...turn(), messages: [{ role: "user", content: [{ type: "text", text: "<system-reminder> SHARED:old\nSOURCE:root\nSOURCE:cwd" }] }] };
  expect(await refusedAt(b)).toBe("not_meta");
  expect(await refusedAt({ ...turn(), messages: [{ role: "user", content: "<system-reminder> SHARED:old\nSOURCE:root\nSOURCE:cwd" }] })).toBe("not_meta");
  // an absent marker that only the prompt block carries is not the userContext's, so it does not refuse a good reminder
  const c = merged(); (c.messages[0]!.content as any[])[1].text = "SHARED:new";
  const p = port(); expect(decode(await p.exchange(encodeFrame(withTurn(c))))).toMatchObject({ kind: "accepted" });
});
test("the reminder marker does not excuse a missing or stale marker: user, system and absent checks still apply to the merged shape", async () => {
  const stale = merged(); (stale.messages[0]!.content[0] as any).text = (stale.messages[0]!.content[0] as any).text.replace("SHARED:old", "SHARED:old\nSHARED:new");
  expect(await refusedAt(stale)).toBe("absent_marker");
  const missing = merged(); (missing.messages[0]!.content[0] as any).text = "<system-reminder>\nnothing\n</system-reminder>";
  expect(await refusedAt(missing)).toBe("user_marker");
  expect(await refusedAt({ ...merged(), system: "nothing", systemBlocks: undefined })).toBe("system_marker");
});

// The cross-check: the REAL engine layout, vendored with its source pinned, run through the stub for both dispatches of the hosted fixture.
const layout = JSON.parse(readFileSync(new URL("./real-request-layout.fixture.json", import.meta.url), "utf8"));
test("the vendored fixture names the pinned agent-sdk source it was generated from", () => {
  expect(layout.source).toMatchObject({ repository: "yanlingLabs/winter-agent-sdk", commit: "9c980c326638489e0183d7fcddcf1a93553be0ba", path: "packages/runtime/src/context/request-layout.ts", sha256: "8a664c059c43016f188f34bde83ad1fb3681025e10fb9d86f4541fa36d4fd605" });
  expect(layout.dispatch1[0].isMeta).toBeUndefined();
  expect(layout.dispatch1).toHaveLength(1); expect(layout.dispatch1[0].content).toHaveLength(2);
  expect(layout.dispatch2[0].isMeta).toBeUndefined(); expect(layout.dispatch2.map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
});
test("the stub accepts the real engine's request layout for both hosted dispatches, with the real guidance markers", async () => {
  const markers = (version: string, mark: string) => [`Guided hosted run guidance, ${version} version.`, `The shared guidance marker is ${mark}.`];
  const hosted = { version: 1, scope: { ...scope }, selection: SELECTION, steps: [
    { system: ["Cowork current host context"], user: markers("first", "ALPHA"), absentSystem: [], absentUser: markers("second", "BRAVO"), response: "first deterministic answer" },
    { system: ["Cowork current host context"], user: markers("second", "BRAVO"), absentSystem: [], absentUser: markers("first", "ALPHA"), response: "second deterministic answer" }] };
  const p = port(hosted);
  for (const [ordinal, key] of [[1, "dispatch1"], [2, "dispatch2"]] as const) {
    const id = `invocation-${ordinal}`, t = { model: SELECTION.providerModelId, system: "Cowork current host context\n\nbase", messages: layout[key] };
    expect(decode(await p.exchange(encodeFrame(withTurn(t, ordinal, id))))).toMatchObject({ kind: "accepted" });
    for (const sequence of [1, 2]) await p.exchange(encodeFrame(request("next", sequence, ordinal, id)));
  }
  expect(p.receipt()).toMatchObject({ receivedBegins: 2, acceptedBegins: 2, completed: 2 });
});
