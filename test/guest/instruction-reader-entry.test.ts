import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstructionFrame, type InstructionReaderInvocation } from "../../src/guest/instruction-reader.ts";
import { readerRoleMatches, runInstructionReaderTransport, InstructionReaderTransportError, type ReaderRoleObservation } from "../../src/guest/instruction-reader-transport.ts";
import { cleanupRunHomeBeds, put, runHomeBed } from "../run-home/support.ts";
afterAll(cleanupRunHomeBeds);
const request = () => ({ version: 1, readId: "12345678-1234-4234-8234-123456789abc",
  owner: { logicalSessionId: "parent", backendSessionId: "backend", generation: 1, bootId: "boot", incarnationId: "incarnation", leaseEpoch: 1 },
  views: { sourceRoot: "/workspace/folders/source", sourceCwd: "/workspace/folders/source/sub", sharedRoot: "/run/winter/shared-instructions", sharedPath: "/run/winter/shared-instructions/WINTER.md" },
  limits: { maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 } });
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function frame(input: InstructionReaderInvocation) {
  return JSON.stringify({ ...input, snapshot: { text: "", digest: "0".repeat(64), files: [], skippedLinks: [], droppedImports: [], tiers: "admitted-only", blocks: [], provenance: [] } }) + "\n";
}
function stream(data: Uint8Array, chunk = 7) {
  let at = 0; const maximums: number[] = [];
  return { maximums, read(maximum: number) { maximums.push(maximum); if (at === data.length) return null; const end = Math.min(data.length, at + chunk, at + maximum); const bytes = data.subarray(at, end); at = end; return bytes; }, consumed: () => at };
}
async function refuses(pending: Promise<unknown>) { await expect(pending).rejects.toBeInstanceOf(InstructionReaderTransportError); }
test("portable framing copies and freezes its OWN JSON once, handles partial/EINTR writes without a queue", async () => {
  const source = stream(new TextEncoder().encode(JSON.stringify(request()))); let calls = 0, interrupted = false; const output: Uint8Array[] = [];
  await runInstructionReaderTransport({ read: source.read, reader: async value => { calls++; expect(Object.isFrozen(value)).toBe(true); expect(Object.isFrozen(value.views)).toBe(true); return frame(value); },
    write(bytes) { if (!interrupted) { interrupted = true; throw Object.assign(new Error("private error"), { code: "EINTR" }); } const count = Math.min(bytes.length, 3); output.push(bytes.slice(0, count)); return count; } });
  expect(calls).toBe(1); expect(Buffer.concat(output).toString("utf8")).toBe(frame(freeze(request()) as InstructionReaderInvocation)); expect(Math.max(...source.maximums)).toBeLessThanOrEqual(8192);
});
test("input16KiB cutoff is before decode/parse/loader and never consumes beyond one probe byte", async () => {
  const source = stream(new Uint8Array(20_000).fill(255), 8192); let calls = 0, writes = 0;
  await refuses(runInstructionReaderTransport({ read: source.read, reader: async value => { calls++; return frame(value); }, write() { writes++; return 1; } }));
  expect(source.consumed()).toBe(16 * 1024 + 1); expect(calls).toBe(0); expect(writes).toBe(0);
});
for (const [name, raw] of [["invalid UTF8", new Uint8Array([255])], ["BOM", new TextEncoder().encode(`\ufeff${JSON.stringify(request())}`)],
  ["second object", new TextEncoder().encode(`${JSON.stringify(request())}\n${JSON.stringify(request())}`)], ["array", new TextEncoder().encode("[]")], ["truncated", new TextEncoder().encode("{")], ["whitespace", new TextEncoder().encode(` ${JSON.stringify(request())}`)],
  ["trailing LF", new TextEncoder().encode(`${JSON.stringify(request())}\n`)], ["duplicate key", new TextEncoder().encode(JSON.stringify(request()).replace('"version":1', '"version":1,"version":1'))],
  ["unsafe integer", new TextEncoder().encode(JSON.stringify(request()).replace('"generation":1', '"generation":9007199254740993'))]] as const) {
  test(`malformed ${name} refuses before reader/write`, async () => { let calls = 0; const source = stream(raw);
    await refuses(runInstructionReaderTransport({ read: source.read, reader: async value => { calls++; return frame(value); }, write() { throw new Error("must not write"); } })); expect(calls).toBe(0); });
}
test("registered view grammar refuses arbitrary roots, traversal and altered shared scope", async () => {
  for (const kind of ["root", "cwd", "shared", "control"] as const) {
    const value = request(); if (kind === "root") value.views.sourceRoot = "/private/source";
    if (kind === "cwd") value.views.sourceCwd += "/../other"; if (kind === "shared") value.views.sharedRoot += "-foreign";
    if (kind === "control") value.views.sourceCwd += "\t";
    let calls = 0; const source = stream(new TextEncoder().encode(JSON.stringify(value)));
    await refuses(runInstructionReaderTransport({ read: source.read, reader: async input => { calls++; return frame(input); }, write: bytes => bytes.length })); expect(calls).toBe(0);
  }
});
test("bad output/correlation/partial-write behavior refuses; no fabricated cleanup proof", async () => {
  for (const kind of ["oversized", "twoframes", "foreign", "malformed", "zero-write", "interrupted-forever", "partial-EPIPE"] as const) {
    const source = stream(new TextEncoder().encode(JSON.stringify(request()))); let writes = 0;
    await refuses(runInstructionReaderTransport({ read: source.read, reader: async value => {
      if (kind === "oversized") return "x".repeat(320 * 1024 + 1); if (kind === "twoframes") return frame(value) + frame(value);
      if (kind === "foreign") return frame({ ...value, readId: "foreign" }); if (kind === "malformed") return "{}\n"; return frame(value);
    }, write(bytes) { writes++; if (kind === "partial-EPIPE") { if (writes === 1) return 5; throw Object.assign(new Error("/private/path guidance must not leak"), { code: "EPIPE" }); } if (kind === "zero-write") return 0; if (kind === "interrupted-forever") throw Object.assign(new Error("private error"), { code: "EINTR" }); return bytes.length; } }));
    if (["oversized", "twoframes", "foreign", "malformed"].includes(kind)) expect(writes).toBe(0);
    if (kind === "interrupted-forever") expect(writes).toBe(33);
    if (kind === "partial-EPIPE") expect(writes).toBe(2);
  }
});
test("reader call remains one-shot and errors cannot emit guidance or exception text", async () => {
  const source = stream(new TextEncoder().encode(JSON.stringify(request()))); let calls = 0, writes = 0;
  await refuses(runInstructionReaderTransport({ read: source.read, reader: async () => { calls++; throw new Error("/private/path secret guidance"); }, write(bytes) { writes++; return bytes.length; } }));
  expect(calls).toBe(1); expect(writes).toBe(0);
});
test("injected actual-loader temp projection is portable proof, not native/unmodified guest output", async () => {
  const bed = runHomeBed("reader-entry-projection"), sourceRoot = join(bed.root, "source"), sourceCwd = join(sourceRoot, "sub"), sharedRoot = join(bed.root, "shared"), sharedPath = join(sharedRoot, "WINTER.md");
  put(sharedPath, "SHARED"); put(join(sourceRoot, "WINTER.md"), "SOURCE @./notes.md"); put(join(sourceRoot, "notes.md"), "IMPORT"); put(join(sourceCwd, "WINTER.md"), "CWD");
  const guest = request(); guest.views.sourceCwd += "/é🙂";
  const source = stream(new TextEncoder().encode(JSON.stringify(guest))), output: Uint8Array[] = [];
  await runInstructionReaderTransport({ read: source.read, reader: async canonical => {
    // Explicit test-owner namespace substitution for filesystem reads; the actual loader is called.
    const physical = freeze({ ...canonical, views: { sourceRoot, sourceCwd, sharedRoot, sharedPath } });
    const own = JSON.parse(await readInstructionFrame(physical)); own.views = canonical.views; // Restore echo only; snapshot paths remain TEMP evidence.
    return JSON.stringify(own) + "\n";
  }, write(bytes) { output.push(bytes.slice()); return bytes.length; } });
  const reply = JSON.parse(Buffer.concat(output).toString("utf8")); expect(reply.views).toEqual(guest.views);
  expect(reply.snapshot.text).toContain("SOURCE IMPORT"); expect(reply.snapshot.text).toContain("SHARED"); expect(reply.snapshot.blocks[0].requestedPath).toBe(sharedPath);
});
test("cheap role guard refuses ambient misuse and never asserts native ownership/UID independence", () => {
  const role: ReaderRoleObservation = { platform: "linux", pid: 1, uid: 10002, euid: 10002, gid: 10002, egid: 10002, executable: "/instruction-reader", args: ["--instruction-reader-v1"], cwd: "/run/winter/instruction-reader",
    env: { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: "/run/winter/instruction-reader", TMPDIR: "/tmp", PATH: "/usr/bin:/bin" } };
  expect(readerRoleMatches(role)).toBe(true); // Synthetic facts, NOT a native execution/admission proof.
  for (const patch of [{ platform: "darwin" }, { pid: 2 }, { uid: 0 }, { euid: 10003 }, { gid: 10003 }, { executable: "/other" }, { args: [] }, { cwd: "/workspace/folders/source" }, { env: { ...role.env, BUN_OPTIONS: "preload" } }]) expect(readerRoleMatches({ ...role, ...patch })).toBe(false);
  expect(readerRoleMatches({ ...role, uid: 10000, euid: 10000, gid: 10000, egid: 10000 })).toBe(true); // Distinct reservation belongs to Root, not UID shape.
});
test("entry has no import-time execution and recipe disables all four autoload mechanisms", async () => {
  await import("../../src/guest/instruction-reader-entry.ts"); // import.meta.main false: no stdio/process effects.
  const recipe = readFileSync(join(import.meta.dir, "../../docs/instruction-reader-entry.md"), "utf8");
  for (const flag of ["bunfig", "dotenv", "tsconfig", "package-json"]) expect(recipe).toContain(`--no-compile-autoload-${flag}`);
});
