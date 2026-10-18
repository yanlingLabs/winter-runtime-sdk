/** Guided providerWorker, pure core. No import, no I/O, no native call: every effect is an injected port, so
 * test_guided_build.py's static scan and guided-entries.test.ts can pin the contract without a guest.
 * Contract ids C-P1..C-P10 are defined in scripts/guest-guided-build/README.md and cited by the tests. */

export const PROVIDER_ARGV = Object.freeze(["--listener-fd", "3", "--admission-fd", "4", "--owner-library-fd", "5", "--metadata-fd", "6"]);
export const PROVIDER_EXIT = Object.freeze({ stopped: 0, startupRefused: 2, nativeFailure: 3 });
export const PROVIDER_LIMITS = Object.freeze({ metadataBytes: 64 * 1024, libraryBytes: 4 * 1024 * 1024, requestBytes: 2 * 1024 * 1024 + 4096, reportLineBytes: 4096 });
/** C-P3: a Root-owned, immutable, single-link regular file. The entry feeds it fstat results. */
export interface InputStat { isFile(): boolean; uid: number; nlink: number; mode: number; size: number }

export class ProviderStartupRefusal extends Error {
  constructor(readonly code: "argv" | "platform" | "input" | "metadata") { super(`provider worker refused: ${code}`); }
}
const refuse = (code: ProviderStartupRefusal["code"]): never => { throw new ProviderStartupRefusal(code); };

/** C-P1. Exactly the fixed argv, on Linux. Nothing is read from the environment. */
export function checkStartup(platform: string, argv: readonly string[]): void {
  if (platform !== "linux") refuse("platform");
  if (argv.length !== PROVIDER_ARGV.length || argv.some((value, index) => value !== PROVIDER_ARGV[index])) refuse("argv");
}
/** C-P2 */
export function checkImmutableInput(stat: InputStat, maxBytes: number): void {
  if (!stat.isFile() || stat.uid !== 0 || stat.nlink !== 1 || (stat.mode & 0o222) !== 0 || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maxBytes) refuse("input");
}
export interface ProviderMetadata { runtimeUid: number; scriptSha256: string; scriptBytes: Uint8Array }
/** C-P3: closed keys, JSON.stringify bytes only (a re-serialization round trip must reproduce the input), the script
 * hash is Root's independent value and is verified by the fixture port, not here. */
export function parseMetadata(bytes: Uint8Array): ProviderMetadata {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > PROVIDER_LIMITS.metadataBytes) return refuse("metadata");
  let value: any, raw: string;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = JSON.parse(raw); } catch { return refuse("metadata"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value) !== raw) return refuse("metadata");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "runtimeUid,script,scriptSha256,version") return refuse("metadata");
  if (value.version !== 1 || !Number.isSafeInteger(value.runtimeUid) || value.runtimeUid < 1000 || value.runtimeUid > 0xffff_fffe
    || typeof value.scriptSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.scriptSha256)
    || !value.script || typeof value.script !== "object" || Array.isArray(value.script)) return refuse("metadata");
  return { runtimeUid: value.runtimeUid, scriptSha256: value.scriptSha256, scriptBytes: new TextEncoder().encode(JSON.stringify(value.script)) };
}

/** C-P6: the native owner frames a request as one NUL-terminated JSON line; the fixture port frames it as a 4-byte
 * big-endian length plus the same bytes. Only the length prefix is added or removed; the JSON bytes pass unchanged. */
export function toPortFrame(nativeText: string): Uint8Array | undefined {
  const body = new TextEncoder().encode(nativeText);
  if (body.byteLength < 1 || body.byteLength > PROVIDER_LIMITS.requestBytes || body.includes(0)) return undefined;
  const frame = new Uint8Array(body.byteLength + 4);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, 4);
  return frame;
}
/** The reply for the native writer: the body without the prefix, NUL-terminated. Undefined when the prefix lies. */
export function toNativeReply(frame: Uint8Array): Uint8Array | undefined {
  if (!(frame instanceof Uint8Array) || frame.byteLength < 5 || new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0) !== frame.byteLength - 4) return undefined;
  const body = frame.subarray(4);
  if (body.includes(0)) return undefined;
  const out = new Uint8Array(body.byteLength + 1);
  out.set(body);
  return out;
}

/** The slice of the fixture port's receipt the worker reports. Turn bodies never leave the process. */
export interface PortReceipt { scriptSha256: string; receivedFrames: number; receivedBegins: number; acceptedBegins: number; completed: number; closed: boolean; turns: readonly { sha256: string }[] }
export interface WorkerPort { exchange(frame: Uint8Array): Promise<Uint8Array>; receipt(): PortReceipt; close(): void }
export type Outcome = "accepted" | "refused" | "unreadable";
export const PROVIDER_CONTROL = Object.freeze({ lineBytes: 64, maxOutcomes: 64 });
/** C-P11: Root's control line is exactly `receipt <tag>` with a short lowercase tag; anything else is refused, never guessed. */
export function parseControl(line: string): { tag: string } | undefined {
  const match = /^receipt ([a-z0-9][a-z0-9-]{0,31})$/.exec(line);
  return match ? { tag: match[1]! } : undefined;
}

/** C-P4, C-P5, C-P7, C-P8. `write` is a synchronous, complete line write (the entry passes fs.writeSync(1, ...)). */
export function createProviderCounter(port: WorkerPort, write: (line: string) => void) {
  let arrivals = 0, unreadable = 0, unframed = 0, refused = 0, answered = 0, controlRefused = 0;
  const outcomes: Outcome[] = [];
  const emit = (value: Record<string, unknown>): void => {
    const line = JSON.stringify(value) + "\n";
    if (Buffer.byteLength(line) > PROVIDER_LIMITS.reportLineBytes) throw new Error("provider report line bound");
    write(line);
  };
  return {
    ready(): void { emit({ kind: "provider-ready", version: 1 }); },
    /** One native request arrival. The arrival is counted and reported BEFORE anything is decoded or answered. A refused
     * request returns undefined (the entry writes nothing and closes the client); the worker keeps running. */
    async arrive(nativeText: string | null): Promise<Uint8Array | undefined> {
      const n = ++arrivals;
      emit({ kind: "provider-request", n, readable: nativeText !== null });
      let reply: Uint8Array | undefined, outcome: Outcome = "refused";
      const frame = nativeText === null ? undefined : toPortFrame(nativeText);
      if (nativeText === null) { unreadable++; outcome = "unreadable"; }
      else if (frame === undefined) unframed++;
      else {
        try { reply = toNativeReply(await port.exchange(frame)); if (reply) { outcome = "accepted"; answered++; } } catch { reply = undefined; }
      }
      if (outcome === "refused") refused++;
      if (outcomes.length < PROVIDER_CONTROL.maxOutcomes) outcomes.push(outcome);
      emit({ kind: "provider-outcome", n, outcome });
      return reply;
    },
    /** C-P11: a consistent snapshot on Root's request. No await sits between an arrival's count and the fixture port's own
     * count, so a snapshot can never see one without the other. Read-only: it changes nothing and counts no arrival. */
    receipt(tag: string): Record<string, unknown> {
      const receipt = port.receipt();
      const line = { kind: "provider-receipt", version: 1, tag, requests: arrivals, unreadable, unframed, refused, answered,
        receivedFrames: receipt.receivedFrames, receivedBegins: receipt.receivedBegins, acceptedBegins: receipt.acceptedBegins, completed: receipt.completed,
        portClosed: receipt.closed, outcomes: [...outcomes], countersAgree: arrivals === receipt.receivedFrames + unreadable + unframed, controlRefused };
      emit(line);
      return line;
    },
    controlLine(text: string): void {
      const parsed = parseControl(text);
      if (parsed) this.receipt(parsed.tag);
      else { controlRefused++; emit({ kind: "provider-control-refused", version: 1, code: "line" }); }
    },
    summary(reason: "signal" | "owner-gone" | "failure"): Record<string, unknown> {
      const receipt = port.receipt();
      const line = { kind: "provider-summary", version: 1, reason, requests: arrivals, unreadable, unframed, refused, answered, controlRefused,
        receivedFrames: receipt.receivedFrames, receivedBegins: receipt.receivedBegins, acceptedBegins: receipt.acceptedBegins, completed: receipt.completed,
        portClosed: receipt.closed, outcomes: [...outcomes], scriptSha256: receipt.scriptSha256, turnSha256: receipt.turns.map(turn => turn.sha256),
        countersAgree: arrivals === receipt.receivedFrames + unreadable + unframed };
      emit(line);
      return line;
    },
    arrivals: () => arrivals,
  };
}
