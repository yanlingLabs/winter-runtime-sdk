/** Private framing seam, not a launcher, native owner or admission capability. */
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { runHomeBrandOf } from "../run-home/types.ts";
import type { InstructionReaderInvocation } from "./instruction-reader.ts";

const brand = runHomeBrandOf({ brand: WINTER_BRAND });
const INPUT_BYTES = 16 * 1024, OUTPUT_BYTES = 320 * 1024, INTERRUPTS = 32;
const HOME = "/run/winter/instruction-reader", SHARED = "/run/winter/shared-instructions";
const ENV = { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME, TMPDIR: "/tmp", PATH: "/usr/bin:/bin" };
export class InstructionReaderTransportError extends Error {
  constructor() { super("instruction_reader_unavailable"); }
}
const fail = (): never => { throw new InstructionReaderTransportError(); };
export interface ReaderRoleObservation {
  platform: string; pid: number; uid: number; euid: number; gid: number; egid: number;
  executable: string; args: readonly string[]; cwd: string; env: Record<string, string | undefined>;
}
/** Misuse check only: matching facts never prove Root ownership, UID independence or isolation. */
export function readerRoleMatches(value: ReaderRoleObservation): boolean {
  return value.platform === "linux" && value.pid === 1 && Number.isSafeInteger(value.uid) && value.uid >= 1000
    && value.euid === value.uid && value.gid === value.uid && value.egid === value.uid && value.executable === "/instruction-reader"
    && value.args.length === 1 && value.args[0] === "--instruction-reader-v1" && value.cwd === HOME
    && Object.keys(value.env).length === 6 && Object.entries(ENV).every(([key, expected]) => value.env[key] === expected);
}
export interface InstructionReaderTransport {
  /** Return EOF as null, never an unbounded read. */
  read(maximum: number): Uint8Array | null;
  /** Synchronous partial-write contract. Frame memory is capped; no background queue. */
  write(bytes: Uint8Array): number;
  /** Test-only substitution. The actual entry imports the existing private reader after its guard. */
  reader?: (request: InstructionReaderInvocation) => Promise<string>;
}
function interrupted(error: unknown): boolean { return !!error && typeof error === "object" && (error as { code?: unknown }).code === "EINTR"; }
function freezeOwned(value: unknown, depth = 0): void {
  if (depth > 8) return fail();
  if (!value || typeof value !== "object") return;
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return fail();
  for (const child of Object.values(value)) freezeOwned(child, depth + 1);
  Object.freeze(value);
}
function viewPath(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 4096 && value.startsWith("/") && !/[\\\x00-\x1f\x7f]/.test(value)
    && Buffer.from(value, "utf8").toString("utf8") === value && !value.endsWith("/")
    && !value.split("/").some((part, i) => i > 0 && ["", ".", ".."].includes(part));
}
function parseRequest(transport: InstructionReaderTransport): InstructionReaderInvocation {
  const chunks: Uint8Array[] = []; let count = 0, retries = 0;
  for (;;) {
    const maximum = Math.min(8192, INPUT_BYTES - count + 1);
    let chunk: Uint8Array | null;
    try { chunk = transport.read(maximum); }
    catch (error) { if (interrupted(error) && ++retries <= INTERRUPTS) continue; return fail(); }
    if (chunk === null) break;
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > maximum) return fail();
    count += chunk.byteLength; if (count > INPUT_BYTES) return fail();
    chunks.push(chunk.slice()); // Capture bytes before the producer can reuse its bounded buffer.
  }
  const bytes = new Uint8Array(count); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  // Preserve BOM so JSON.parse refuses it, and reject invalid UTF8 before interpreting anything.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const own: unknown = JSON.parse(text);
  // Root must send compact literal-UTF8 JSON with no LF. This rejects duplicate keys,
  // whitespace variants, escaped-Unicode aliases and unsafe-number round-trip changes.
  if (JSON.stringify(own) !== text) return fail();
  if (!own || typeof own !== "object" || Array.isArray(own) || Object.getPrototypeOf(own) !== Object.prototype) return fail();
  freezeOwned(own);
  const request = own as InstructionReaderInvocation, views = request.views;
  const source = views?.sourceRoot;
  if (typeof source !== "string" || !/^\/workspace\/(folders|repos)\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(source)
    || !viewPath(views.sourceCwd) || (views.sourceCwd !== source && !views.sourceCwd.startsWith(`${source}/`))
    || views.sharedRoot !== SHARED || views.sharedPath !== `${SHARED}/${brand.instructionsFile}`) return fail();
  return request;
}
function stable(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
function output(frame: string, request: InstructionReaderInvocation): Uint8Array {
  if (typeof frame !== "string" || Buffer.byteLength(frame, "utf8") > OUTPUT_BYTES || !frame.endsWith("\n") || frame.slice(0, -1).includes("\n")) return fail();
  const own: unknown = JSON.parse(frame);
  if (!own || typeof own !== "object" || Array.isArray(own) || Object.keys(own).sort().join(",") !== "limits,owner,readId,snapshot,version,views") return fail();
  const { snapshot, ...echo } = own as Record<string, unknown>;
  if (stable(echo) !== stable(request) || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || Object.keys(snapshot).sort().join(",") !== "blocks,digest,droppedImports,files,provenance,skippedLinks,text,tiers") return fail();
  return new TextEncoder().encode(frame);
}
/** One request, one private-reader call, one fully validated frame. No cleanup/native proof. */
export async function runInstructionReaderTransport(transport: InstructionReaderTransport): Promise<void> {
  try {
    const request = parseRequest(transport);
    const reader = transport.reader ?? (await import("./instruction-reader.ts")).readInstructionFrame;
    const bytes = output(await reader(request), request);
    let at = 0, retries = 0;
    while (at < bytes.byteLength) {
      let written: number;
      try { written = transport.write(bytes.subarray(at)); }
      catch (error) { if (interrupted(error) && ++retries <= INTERRUPTS) continue; return fail(); }
      if (!Number.isSafeInteger(written) || written < 1 || written > bytes.byteLength - at) return fail();
      at += written;
    }
  } catch { throw new InstructionReaderTransportError(); }
}
