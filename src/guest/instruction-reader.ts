/** Private callable source seam. No CLI, autorun, transport or native admission lives here. */
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { loadStructuredInstructionSnapshot } from "../run-home/instructions.ts";
import { runHomeBrandOf } from "../run-home/types.ts";

const brand = runHomeBrandOf({ brand: WINTER_BRAND });
const READER_HOME = "/run/winter/instruction-reader";
export const INSTRUCTION_READER_REQUEST_BYTES = 16 * 1024;
export const INSTRUCTION_READER_FRAME_BYTES = 320 * 1024;
const limits = Object.freeze({ maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 });
export interface InstructionReaderInvocation {
  readonly version: 1;
  readonly readId: string;
  readonly owner: Readonly<{ logicalSessionId: string; backendSessionId: string; generation: number; bootId: string; incarnationId: string; leaseEpoch: number }>;
  readonly views: Readonly<{ sourceRoot: string; sourceCwd: string; sharedRoot: string; sharedPath: string }>;
  readonly limits: Readonly<typeof limits>;
}
export class InstructionReaderError extends Error {
  constructor() { super("instruction_reader_unavailable"); this.name = "InstructionReaderError"; }
}
const fail = (): never => { throw new InstructionReaderError(); };
const utf8 = (value: string) => Buffer.byteLength(value, "utf8");
function closed(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)) return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !Object.hasOwn(fields, name))
    || Reflect.ownKeys(fields).some(key => typeof key !== "string" || !names.includes(key))
    || Object.values(fields).some(field => !("value" in field))) return fail();
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]));
}
function path(value: unknown): string {
  if (typeof value !== "string" || value === "/" || utf8(value) > 4096 || !value.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(value)
    || Buffer.from(value, "utf8").toString("utf8") !== value || value.endsWith("/") || value.split("/").some((part, i) => i > 0 && ["", ".", ".."].includes(part))) return fail();
  return value;
}
const within = (value: string, root: string) => value === root || value.startsWith(`${root}/`);
function invocation(value: unknown): InstructionReaderInvocation {
  const v = closed(value, ["version", "readId", "owner", "views", "limits"]);
  if (v.version !== 1 || typeof v.readId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.readId)) return fail();
  const owner = closed(v.owner, ["logicalSessionId", "backendSessionId", "generation", "bootId", "incarnationId", "leaseEpoch"]);
  for (const key of ["logicalSessionId", "backendSessionId", "bootId", "incarnationId"]) {
    if (typeof owner[key] !== "string" || utf8(owner[key] as string) > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(owner[key] as string)) return fail();
  }
  if (![owner.generation, owner.leaseEpoch].every(n => Number.isSafeInteger(n) && (n as number) > 0)) return fail();
  const views = closed(v.views, ["sourceRoot", "sourceCwd", "sharedRoot", "sharedPath"]);
  for (const key of Object.keys(views)) views[key] = path(views[key]);
  const { sourceRoot, sourceCwd, sharedRoot, sharedPath } = views as Record<string, string>;
  if (!within(sourceCwd!, sourceRoot!) || sharedPath !== `${sharedRoot}/${brand.instructionsFile}` || within(sourceRoot!, sharedRoot!) || within(sharedRoot!, sourceRoot!)
    || [sourceRoot!, sharedRoot!].some(root => within(READER_HOME, root) || within(root, READER_HOME))) return fail();
  const supplied = closed(v.limits, Object.keys(limits));
  for (const [key, expected] of Object.entries(limits)) if (supplied[key] !== expected) return fail();
  return Object.freeze({ version: 1, readId: v.readId, owner: Object.freeze(owner), views: Object.freeze(views), limits }) as unknown as InstructionReaderInvocation;
}
/** Exact JSON string-token bytes, including escaped controls and unpaired UTF-16 surrogates. */
function quotedBytes(value: string): number {
  let count = 2;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n === 34 || n === 92 || [8, 9, 10, 12, 13].includes(n)) count += 2;
    else if (n < 32) count += 6;
    else if (n >= 0xd800 && n <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { count += 4; i++; } else count += 6;
    } else if (n >= 0xdc00 && n <= 0xdfff) count += 6;
    else count += n < 128 ? 1 : n < 2048 ? 2 : 3;
  }
  return count;
}
/** Bound each token before encoding/retaining it, including JSON escape amplification. */
function encode(value: unknown, maximum: number): string {
  const parts: string[] = []; let count = 0;
  const append = (piece: string, size = utf8(piece)) => { count += size; if (count > maximum) return fail(); parts.push(piece); };
  const quoted = (text: string) => { const size = quotedBytes(text); if (count + size > maximum) return fail(); append(JSON.stringify(text), size); };
  const emit = (item: unknown): void => {
    if (typeof item === "string") { quoted(item); return; }
    if (typeof item === "number" && Number.isFinite(item) || typeof item === "boolean" || item === null) { append(JSON.stringify(item)); return; }
    if (Array.isArray(item)) {
      append("["); for (let i = 0; i < item.length; i++) { if (i) append(","); emit(item[i]); } append("]"); return;
    }
    if (!item || typeof item !== "object") return fail();
    append("{"); let first = true;
    for (const [key, child] of Object.entries(item)) { if (!first) append(","); first = false; quoted(key); append(":"); emit(child); }
    append("}");
  };
  emit(value); return parts.join("");
}
/** Root owns invocation/view/entry admission. Frozen object shape and echo do not establish it.
 * Per call: one actual current loader snapshot, one bounded JSON line, no cached fallback. */
export async function readInstructionFrame(value: unknown): Promise<string> {
  try {
    const request = invocation(value);
    encode(request, INSTRUCTION_READER_REQUEST_BYTES);
    const snapshot = await loadStructuredInstructionSnapshot({ home: READER_HOME, brand, cwd: request.views.sourceCwd, trustedProjectRoot: null, tiers: "admitted-only",
      plainInstructions: { projectRoot: request.views.sourceRoot, workspace: { path: request.views.sharedPath, root: request.views.sharedRoot } }, limits }, { userHome: READER_HOME });
    const body = encode({ ...request, snapshot }, INSTRUCTION_READER_FRAME_BYTES - 1);
    return `${body}\n`;
  } catch { throw new InstructionReaderError(); }
}
