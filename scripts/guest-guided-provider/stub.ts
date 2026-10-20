/** Inert, private fixture port. No engine, listener, credential or admission is created. */
import { createHash } from "node:crypto";

type ObjectValue = Record<string, unknown>;
export const LIMITS = Object.freeze({ requestBytes: 2 * 1024 * 1024 + 4096, scriptBytes: 64 * 1024, markers: 32, textBytes: 4096 });
export const SELECTION = Object.freeze({ providerId: "openai", modelKey: "openai/gpt-5.6", providerModelId: "gpt-5.6", family: "openai", protocol: "openai-responses", continuationDomain: "openai/gpt-5.6", capabilities: Object.freeze({ toolCalling: "native", readableState: "summary" }) });
/** Reserved selection for the guest's scripted stand-in. No catalog row has it. It is reachable only by passing it to
 * createGuidedFixturePort explicitly; the default port, and every script written for it, stay on SELECTION. */
export type StubSelection = typeof SELECTION | typeof STANDIN_SELECTION;
export const STANDIN_SELECTION = Object.freeze({ providerId: "winter-standin", modelKey: "winter-standin/scripted", providerModelId: "scripted", family: "winter-standin", protocol: "openai-responses", continuationDomain: "winter-standin/scripted", capabilities: Object.freeze({ toolCalling: "native", readableState: "summary" }) });
const SCOPE = ["homeId", "workspaceId", "sessionId", "backendSessionId", "taskId", "incarnationId", "bootId", "leaseEpoch", "grantRevision", "accountRevision", "modelRevision"];
const TURN = ["model", "messages", "system", "systemBlocks", "tools", "toolChoice", "effort", "thinking", "maxOutputTokens", "requestSummary", "cacheTtl", "cacheDiagnostics", "cacheKey", "allowedTools", "toolChanges", "resumesPausedTurn"];
/** The closed refusal-site vocabulary: WHERE a request was refused, never what it carried. `read_null` and `frame_empty_or_nul` are the
 * provider worker's own sites (before the port sees anything); `reply_frame` is the worker refusing the port's reply. */
export const REFUSAL_SITES = Object.freeze(["read_null", "frame_empty_or_nul", "decode", "keys", "scope", "sequence", "model", "system_marker", "user_marker", "absent_marker", "not_meta", "closed", "reply_frame"] as const);
export type RefusalSite = (typeof REFUSAL_SITES)[number];
export class FixtureRefusal extends Error {
  constructor(readonly site: RefusalSite = "keys") {
    super(`guided fixture refused: ${site}`);
  }
}
function refuse(site?: RefusalSite): never { throw new FixtureRefusal(site); }
/** The site of any thrown value: a fixture refusal's own, otherwise `decode` (an unexpected error inside the port is a malformed input). */
export function refusalSite(error: unknown): RefusalSite { return error instanceof FixtureRefusal ? error.site : "decode"; }
function object(value: unknown): ObjectValue { if (!value || typeof value !== "object" || Array.isArray(value)) refuse(); return value as ObjectValue; }
function keys(value: ObjectValue, required: string[], optional: string[] = []): void { if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) refuse(); }
function text(value: unknown, limit = 256): string { if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > limit) refuse(); return value; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as ObjectValue)[key])}`).join(",")}}`; return JSON.stringify(value); }
export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function digest(value: unknown): string { return sha256(Buffer.from(canonical(value))); }
function frozen<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value; }
function json(bytes: Uint8Array): ObjectValue {
  let raw: string, value: ObjectValue; try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = object(JSON.parse(raw)); } catch (error) { if (error instanceof FixtureRefusal) throw error; return refuse("decode"); }
  // Existing SDK frames are JSON.stringify output. This also refuses duplicate keys,
  // replacement UTF-8, alternate number encodings and trailing/concatenated payloads.
  if (JSON.stringify(value) !== raw) refuse("decode"); return value;
}
export function encodeFrame(value: unknown): Uint8Array { const body = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); return frame; }
function decodeFrame(bytes: Uint8Array): ObjectValue {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > LIMITS.requestBytes + 4) refuse("decode");
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (frame.readUInt32BE() !== frame.length - 4) refuse("decode"); return json(frame.subarray(4));
}
interface Step { system: string[]; user: string[]; absentSystem: string[]; absentUser: string[]; response: string }
interface Script { scope: ObjectValue; steps: Step[] }
function markers(value: unknown, allowEmpty = false): string[] { if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > LIMITS.markers) refuse(); return value.map(item => { const marker = text(item, LIMITS.textBytes); if (/[\r\n]/.test(marker)) refuse(); return marker; }); }
function readScript(bytes: Uint8Array, expectedHash: string, selection: StubSelection): Script {
  if (!(bytes instanceof Uint8Array) || bytes.length > LIMITS.scriptBytes || !/^[a-f0-9]{64}$/.test(expectedHash) || sha256(bytes) !== expectedHash) refuse();
  const script = json(bytes); keys(script, ["version", "scope", "selection", "steps"]);
  if (script.version !== 1 || canonical(script.selection) !== canonical(selection)) refuse();
  const scope = object(script.scope); keys(scope, SCOPE);
  for (const key of SCOPE) { const value = scope[key]; if (key.endsWith("Id")) text(value); else if (!Number.isSafeInteger(value) || Number(value) < 1) refuse(); }
  if (!Array.isArray(script.steps) || script.steps.length !== 2) refuse();
  const steps = script.steps.map(value => { const step = object(value); keys(step, ["system", "user", "absentSystem", "absentUser", "response"]); return { system: markers(step.system, selection === STANDIN_SELECTION), user: markers(step.user, selection === STANDIN_SELECTION), absentSystem: markers(step.absentSystem, true), absentUser: markers(step.absentUser, true), response: text(step.response, LIMITS.textBytes) }; });
  return frozen({ scope, steps });
}
function ordered(haystack: string, needles: string[], site: RefusalSite): void { const lines = haystack.split(/\r?\n/); let at = 0; for (const needle of needles) { const found = lines.indexOf(needle, at); if (found < 0) refuse(site); at = found + 1; } }
function absent(haystack: string, needles: string[]): void { if (needles.some(needle => haystack.includes(needle))) refuse("absent_marker"); }
function content(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) refuse();
  return value.map(item => { const block = object(item); keys(block, ["type", "text"]); if (block.type !== "text" || typeof block.text !== "string") refuse(); return block.text; }).join("\n");
}
const REMINDER_OPEN = "<system-reminder>", REMINDER_CLOSE = "</system-reminder>";
/** The merged layout's userContext: message content that is an array of at least two text blocks whose FIRST is one closed system-reminder
 * (the prompt follows in its own block). Returns that first block's text, or undefined for any other content. */
function reminderBlock(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const first = value[0] as ObjectValue | null;
  if (!first || typeof first !== "object" || first.type !== "text" || typeof first.text !== "string") return undefined;
  const body = first.text.trimEnd();
  return first.text.startsWith(REMINDER_OPEN) && body.endsWith(REMINDER_CLOSE) && body.indexOf(REMINDER_CLOSE) === body.length - REMINDER_CLOSE.length ? first.text : undefined;
}
function optionalTurnFields(turn: ObjectValue): void {
  for (const key of ["cacheKey"]) if (turn[key] !== undefined) text(turn[key], LIMITS.requestBytes);
  if (turn.effort !== undefined && !(typeof turn.effort === "number" && Number.isFinite(turn.effort)) && !(typeof turn.effort === "string" && ["low", "medium", "high", "xhigh", "max"].includes(turn.effort))) refuse();
  if (turn.maxOutputTokens !== undefined && (!Number.isSafeInteger(turn.maxOutputTokens) || Number(turn.maxOutputTokens) < 1)) refuse();
  if (turn.requestSummary !== undefined && typeof turn.requestSummary !== "boolean") refuse();
  for (const key of ["toolChanges", "resumesPausedTurn"]) if (turn[key] !== undefined && turn[key] !== true) refuse();
  if (turn.cacheTtl !== undefined && !(typeof turn.cacheTtl === "string" && ["5m", "1h"].includes(turn.cacheTtl))) refuse();
  if (turn.allowedTools !== undefined) { if (!Array.isArray(turn.allowedTools)) refuse(); for (const name of turn.allowedTools) text(name); }
  if (turn.cacheDiagnostics !== undefined) { const value = object(turn.cacheDiagnostics); keys(value, ["previousMessageId"]); if (value.previousMessageId !== null) text(value.previousMessageId); }
  if (turn.thinking !== undefined) { const value = object(turn.thinking); keys(value, ["type"], value.type === "enabled" ? ["budgetTokens"] : []); if (!(typeof value.type === "string" && ["enabled", "disabled", "adaptive"].includes(value.type))) refuse(); if (value.budgetTokens !== undefined && (!Number.isSafeInteger(value.budgetTokens) || Number(value.budgetTokens) < 1)) refuse(); }
  if (turn.toolChoice !== undefined) { const value = object(turn.toolChoice); keys(value, ["type"], value.type === "tool" ? ["name"] : []); if (!(typeof value.type === "string" && ["auto", "any", "tool"].includes(value.type))) refuse(); if (value.type === "tool") text(value.name); }
  if (turn.tools !== undefined) {
    if (!Array.isArray(turn.tools)) refuse();
    for (const item of turn.tools) { const tool = object(item); keys(tool, ["name", "description", "inputSchema"], ["deferLoading", "namespace", "toolSearch"]); text(tool.name); if (typeof tool.description !== "string") refuse(); object(tool.inputSchema); if (tool.namespace !== undefined) text(tool.namespace); for (const key of ["deferLoading", "toolSearch"]) if (tool[key] !== undefined && tool[key] !== true) refuse(); }
  }
}
function validateTurn(value: unknown, step: Step, selection: StubSelection): ObjectValue {
  const turn = object(value); keys(turn, ["model", "messages"], TURN);
  if (turn.model !== selection.providerModelId) refuse("model");
  if (typeof turn.system !== "string" || !Array.isArray(turn.messages) || !turn.messages.length) refuse();
  optionalTurnFields(turn);
  if (turn.systemBlocks !== undefined) {
    if (!Array.isArray(turn.systemBlocks)) refuse();
    const blocks = turn.systemBlocks.map(value => { const block = object(value); keys(block, ["text", "cacheScope"]); if (typeof block.text !== "string" || !["global", "org", null].includes(block.cacheScope as string | null)) refuse(); return block.text; });
    if (blocks.join("\n\n") !== turn.system) refuse();
  }
  for (const value of turn.messages) {
    const message = object(value); keys(message, ["role", "content"], ["uuid", "origin", "decoration", "meta", "isMeta"]);
    if (!(typeof message.role === "string" && ["user", "assistant"].includes(message.role)) || message.isMeta !== undefined && message.isMeta !== true) refuse();
    if (message.uuid !== undefined) text(message.uuid);
    if (message.origin !== undefined) { const origin = object(message.origin); keys(origin, ["providerId", "modelKey", "family"], ["continuationDomain"]); for (const value of Object.values(origin)) text(value); }
    if (message.decoration !== undefined) { const decoration = object(message.decoration); keys(decoration, ["text", "door"]); if (typeof decoration.text !== "string" || !(typeof decoration.door === "string" && ["tag", "thinking-channel"].includes(decoration.door))) refuse(); }
    if (message.meta !== undefined) { const meta = object(message.meta); keys(meta, ["attachment"]); text(object(meta.attachment).type); }
    content(message.content);
  }
  const current = object(turn.messages[0]);
  // Match current userContext only; stale markers in historical user/assistant text
  // cannot satisfy the next-dispatch guidance oracle.
  // The engine merges the meta userContext message into the user turn that follows it (request-layout.ts buildRequestMessages: consecutive
  // user-role messages become one, which drops `isMeta`), so the real first message is `[closed <system-reminder> block, prompt block]` with no
  // flag. The separate `isMeta` message is the other accepted shape. In the merged shape the markers are matched against the reminder block
  // ONLY: a marker in the prompt block, or in a block the user typed, is not the userContext.
  if (current.role !== "user") refuse("not_meta");
  let userText: string;
  if (selection === STANDIN_SELECTION || current.isMeta === true) userText = content(current.content);
  else { const block = reminderBlock(current.content); if (block === undefined) return refuse("not_meta"); userText = block; }
  ordered(turn.system, step.system, "system_marker"); ordered(userText, step.user, "user_marker");
  absent(turn.system, step.absentSystem); absent(userText, step.absentUser);
  return frozen(turn);
}
export interface CapturedTurn { readonly invocationId: string; readonly ordinal: number; readonly sha256: string; readonly turn: Readonly<ObjectValue> }
export interface GuidedFixturePort {
  exchange(frame: Uint8Array, signal?: AbortSignal): Promise<Uint8Array>;
  close(): void;
  receipt(): Readonly<{ scriptSha256: string; receivedFrames: number; receivedBegins: number; acceptedBegins: number; completed: number; closed: boolean; turns: readonly CapturedTurn[]; engineDispatchProven: false; nativeAdmissionProven: false }>;
}
/** The expected hash is Root fixture configuration, never taken from a request. */
export function createGuidedFixturePort(scriptBytes: Uint8Array, expectedScriptSha256: string, selection: StubSelection = SELECTION): GuidedFixturePort {
  if (selection !== SELECTION && selection !== STANDIN_SELECTION) refuse();
  const script = readScript(scriptBytes, expectedScriptSha256, selection);
  let receivedFrames = 0, receivedBegins = 0, acceptedBegins = 0, completed = 0, closed = false, ordinal = 0;
  let active: { id: string; ordinal: number; next: number; response: string } | undefined;
  const seen = new Set<string>(), turns: CapturedTurn[] = [];
  return Object.freeze({
    async exchange(frame: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
      receivedFrames++; // Actual ingress, including closed/malformed/aborted input.
      try {
        const request = decodeFrame(frame);
        if (request.operation === "begin") receivedBegins++;
        if (closed || signal?.aborted) refuse("closed");
        keys(request, ["version", "operation", "invocationId", "invocationOrdinal", "scope", "sequence"], request.operation === "begin" ? ["turn"] : []);
        const id = text(request.invocationId, 128);
        if (request.version !== 1 || !Number.isSafeInteger(request.invocationOrdinal) || Number(request.invocationOrdinal) < 1 || !Number.isSafeInteger(request.sequence) || Number(request.sequence) < 0) refuse("sequence");
        if (canonical(request.scope) !== canonical(script.scope)) refuse("scope");
        const reply = (value: ObjectValue): Uint8Array => encodeFrame({ version: 1, invocationId: id, sequence: request.sequence, ...value });
        if (request.operation === "begin") {
          const step = script.steps[acceptedBegins];
          if (active || !step || request.sequence !== 0 || request.invocationOrdinal !== ordinal + 1 || seen.has(id)) refuse("sequence");
          const turn = validateTurn(request.turn, step, selection);
          ordinal++; seen.add(id); acceptedBegins++;
          turns.push(frozen({ invocationId: id, ordinal, sha256: digest(turn), turn }));
          active = { id, ordinal, next: 1, response: step.response };
          return reply({ kind: "accepted" });
        }
        if (!active || id !== active.id || request.invocationOrdinal !== active.ordinal || request.sequence !== active.next++) refuse("sequence");
        if (request.operation === "cancel") { active = undefined; closed = true; return reply({ kind: "closed" }); }
        if (request.operation !== "next") refuse("sequence");
        if (request.sequence === 1) return reply({ kind: "event", event: { type: "text_delta", text: active.response } });
        if (request.sequence !== 2) refuse("sequence");
        active = undefined; completed++;
        return reply({ kind: "event", event: { type: "done", stopReason: "end_turn" } });
      } catch (error) { closed = true; active = undefined; if (error instanceof FixtureRefusal) throw error; return refuse("decode"); }
    },
    close(): void { closed = true; active = undefined; },
    receipt() { return frozen({ scriptSha256: expectedScriptSha256, receivedFrames, receivedBegins, acceptedBegins, completed, closed, turns: [...turns], engineDispatchProven: false as const, nativeAdmissionProven: false as const }); },
  });
}
