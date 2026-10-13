import { fstatSync, readSync } from "node:fs";

/** Structured snapshot only. Omitted limits preserve ordinary Code's unbounded behavior. */
export interface InstructionSnapshotLimits {
  maxFileBytes: number;
  maxReadBytes: number;
  maxReadOccurrences: number;
  maxExpandedBytes: number;
}
export interface InstructionReadChunk {
  fileBytes: number; totalBytes: number; decodedFileBytes: number; decodedTotalBytes: number; occurrences: number;
}
/** Internal marker so ordinary filesystem errors retain the walk's existing refusal semantics. */
export class InstructionBudgetFailure extends Error {
  constructor() { super("instruction snapshot limit exceeded"); }
}
const ceilings: InstructionSnapshotLimits = { maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 };
export function instructionLimits(value: unknown): Readonly<InstructionSnapshotLimits> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid instruction snapshot limits");
  const fields = Object.getOwnPropertyDescriptors(value), names = Object.keys(ceilings) as (keyof InstructionSnapshotLimits)[];
  if (Reflect.ownKeys(fields).length !== names.length || names.some(name => !Object.hasOwn(fields, name))
    || Reflect.ownKeys(fields).some(key => typeof key !== "string" || !names.includes(key as keyof InstructionSnapshotLimits))) throw new TypeError("invalid instruction snapshot limits");
  const result = {} as InstructionSnapshotLimits;
  for (const name of names) {
    const field = fields[name]!;
    if (!("value" in field) || !Number.isSafeInteger(field.value) || field.value < 1 || field.value > ceilings[name]) throw new TypeError("invalid instruction snapshot limits");
    result[name] = field.value as number;
  }
  return Object.freeze(result);
}
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
export class InstructionReadBudget {
  private raw = 0;
  private decoded = 0;
  private occurrences = 0;
  private rendered = 0;
  constructor(readonly limits: Readonly<InstructionSnapshotLimits>, private readonly observe?: (chunk: Readonly<InstructionReadChunk>) => void) {}
  read(fd: number): string {
    if (++this.occurrences > this.limits.maxReadOccurrences) throw new InstructionBudgetFailure();
    const allowance = Math.min(this.limits.maxFileBytes, this.limits.maxReadBytes - this.raw);
    if (fstatSync(fd).size > allowance) throw new InstructionBudgetFailure();
    const buffer = Buffer.alloc(Math.min(8192, allowance + 1));
    // ignoreBOM:true preserves U+FEFF, matching Buffer.toString/readFile('utf8').
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const chunks: string[] = [];
    let fileRaw = 0, fileDecoded = 0;
    const append = (piece: string) => {
      const size = bytes(piece); fileDecoded += size; this.decoded += size;
      if (fileDecoded > this.limits.maxFileBytes || this.decoded > this.limits.maxReadBytes) throw new InstructionBudgetFailure();
      chunks.push(piece);
    };
    for (;;) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, allowance - fileRaw + 1), null);
      if (count === 0) break;
      fileRaw += count; this.raw += count;
      // The single probe byte is observed but never decoded/retained after a raw overflow.
      if (fileRaw > allowance) {
        this.observe?.(Object.freeze({ fileBytes: fileRaw, totalBytes: this.raw, decodedFileBytes: fileDecoded, decodedTotalBytes: this.decoded, occurrences: this.occurrences }));
        throw new InstructionBudgetFailure();
      }
      append(decoder.decode(buffer.subarray(0, count), { stream: true }));
      this.observe?.(Object.freeze({ fileBytes: fileRaw, totalBytes: this.raw, decodedFileBytes: fileDecoded, decodedTotalBytes: this.decoded, occurrences: this.occurrences }));
    }
    append(decoder.decode());
    return chunks.join(""); // Both decoded budgets were checked before retaining each chunk.
  }
  join(parts: readonly string[], separator = ""): string {
    let size = separator.length === 0 ? 0 : bytes(separator) * Math.max(0, parts.length - 1);
    for (const piece of parts) { size += bytes(piece); if (size > this.limits.maxExpandedBytes) throw new InstructionBudgetFailure(); }
    if (size > this.limits.maxExpandedBytes) throw new InstructionBudgetFailure();
    return parts.join(separator);
  }
  addRendered(text: string, separator: string): void {
    this.rendered += bytes(text) + bytes(separator);
    if (this.rendered > this.limits.maxExpandedBytes) throw new InstructionBudgetFailure();
  }
}
