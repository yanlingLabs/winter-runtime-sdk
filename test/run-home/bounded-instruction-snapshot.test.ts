import { afterAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildRunHome, loadInstructionSnapshot, loadStructuredInstructionSnapshot, type InstructionSnapshotLimits, type InstructionReadChunk } from "../../src/index.ts";
import { expandImports } from "../../src/run-home/instructions.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed } from "./support.ts";
afterAll(cleanupRunHomeBeds);
const limits: InstructionSnapshotLimits = { maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 };
function fixture() {
  const bed = runHomeBed("bounded-guidance"), root = bed.cwd, leaf = join(root, "WINTER.md");
  put(leaf, "ROOT");
  return { bed, root, leaf, input: { home: bed.home, cwd: root, trustedProjectRoot: root, tiers: "admitted-only" as const } };
}
const overBound = (pending: Promise<unknown>) => expect(pending).rejects.toMatchObject({ code: "run_home_instruction_over_bound" });
test("explicit bounded output remains identical while legacy/default Code has no new limits", async () => {
  const f = fixture(); put(f.leaf, "ROOT @./notes.md\n`@./missing.md`\n"); put(join(f.root, "notes.md"), "NOTES");
  const legacy = await loadInstructionSnapshot(f.input), bounded = await loadStructuredInstructionSnapshot({ ...f.input, limits });
  expect(bounded.text).toBe(legacy.text); expect(bounded.files).toEqual(legacy.files);
  expect(Object.keys(bounded).sort()).toEqual(["blocks", "digest", "droppedImports", "files", "provenance", "skippedLinks", "text", "tiers"]);
  const run = await buildRunHome(inputFor(f.bed, { trustedProjectRoot: f.root })); expect(readFileSync(join(run.dir, "WINTER.md"), "utf8")).toBe(legacy.text);
  put(f.leaf, "x".repeat(limits.maxFileBytes + 1)); await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits }));
  expect((await loadStructuredInstructionSnapshot(f.input)).provenance[0]!.text.length).toBe(limits.maxFileBytes + 1);
  expect((await loadInstructionSnapshot({ ...f.input, limits } as typeof f.input)).files).toHaveLength(1);
});
test("invalid schemas and hard ceilings refuse before any content read, without invoking getters", async () => {
  const f = fixture(); let reads = 0, getters = 0;
  for (const value of [{ ...limits, maxFileBytes: 0 }, { ...limits, maxReadOccurrences: 257 }, { ...limits, extra: 1 }, { maxFileBytes: 1 },
    Object.defineProperty({ ...limits }, "maxExpandedBytes", { get() { getters++; return 1; } })]) {
    await expect(loadStructuredInstructionSnapshot({ ...f.input, limits: value as InstructionSnapshotLimits }, { beforeInstructionRead() { reads++; } })).rejects.toThrow("invalid instruction snapshot limits");
  }
  expect(reads).toBe(0); expect(getters).toBe(0);
});
test("a static oversized regular file is refused before reading bytes", async () => {
  const f = fixture(); put(f.leaf, "x".repeat(8192)); const chunks: InstructionReadChunk[] = [];
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxFileBytes: 64 } }, { onInstructionReadChunk: chunk => chunks.push(chunk) }));
  expect(chunks).toEqual([]);
});
test("a regular file growing after the first held-fd read stops at limit plus one", async () => {
  const f = fixture(); put(f.leaf, "x"); const chunks: InstructionReadChunk[] = []; let grew = false;
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxFileBytes: 8 } }, { onInstructionReadChunk(chunk) {
    chunks.push(chunk); if (!grew) { grew = true; appendFileSync(f.leaf, "y".repeat(100)); }
  } }));
  expect(grew).toBe(true); expect(chunks.at(-1)!.fileBytes).toBe(9); expect(chunks.at(-1)!.totalBytes).toBe(9);
});
test("cumulative read limits and occurrence caps include repeated imports", async () => {
  const f = fixture(); put(f.leaf, "@./a.md @./a.md @./a.md"); put(join(f.root, "a.md"), "A".repeat(30));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxReadBytes: 70 } }));
  const chunks: InstructionReadChunk[] = [];
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxReadOccurrences: 2 } }, { onInstructionReadChunk: c => chunks.push(c) }));
  expect(Math.max(...chunks.map(c => c.occurrences))).toBe(2);
});
test("UTF8 BOM, split multibyte and invalid input match Buffer decoding when within budget", async () => {
  const f = fixture();
  for (const raw of [Buffer.from([0xef, 0xbb, 0xbf, 0x41]), Buffer.from(`${"a".repeat(8191)}é🙂`), Buffer.from([0xe2, 0x82]), Buffer.from([0xff, 0xc3, 0x41])]) {
    writeFileSync(f.leaf, raw); const result = await loadStructuredInstructionSnapshot({ ...f.input, limits });
    expect(result.provenance[0]!.text).toBe(raw.toString("utf8"));
  }
  writeFileSync(f.leaf, Buffer.from([0xff])); await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxFileBytes: 1 } }));
  writeFileSync(f.leaf, Buffer.from([0xc3])); await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxFileBytes: 1 } }));
});
test("decoded cumulative bytes are bounded independently from raw bytes", async () => {
  const f = fixture(); put(f.leaf, "@./a.md @./a.md"); writeFileSync(join(f.root, "a.md"), Buffer.from([0xff, 0xff, 0xff]));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxReadBytes: 25 } }));
});
test("recursive replacements and multiline joins refuse expansion growth before accumulating oversized output", async () => {
  const f = fixture(); put(f.leaf, "@./a.md\n@./a.md\n@./a.md"); put(join(f.root, "a.md"), "@./b.md @./b.md"); put(join(f.root, "b.md"), "B".repeat(80));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxExpandedBytes: 200 } }));
});
test("neutralization, trailing newline and headings participate in the expanded-text budget", async () => {
  const f = fixture(); put(f.leaf, "@missing ".repeat(20));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxExpandedBytes: 200 } }));
  put(f.leaf, ""); const normal = await loadStructuredInstructionSnapshot(f.input), exact = Buffer.byteLength(normal.text);
  expect((await loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxExpandedBytes: exact } })).text).toBe(normal.text);
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxExpandedBytes: exact - 1 } }));
});
test("structured all-tier user reads use budgets without changing public import callback arity", async () => {
  const f = fixture(); put(join(f.bed.sdk, "WINTER.md"), "u".repeat(32));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, tiers: "all", limits: { ...limits, maxFileBytes: 16 } }));
  put(join(f.root, "a.md"), "A"); const calls: unknown[][] = [];
  expect(expandImports({ content: "@./a.md", filePath: f.leaf, tier: "project", projectRoot: f.root, onRead: (...args) => calls.push(args) }).content).toBe("A");
  expect(calls).toEqual([[join(f.root, "a.md"), "A"]]);
});

test("import overflow rejects the whole snapshot, and required shared absence keeps its distinct refusal", async () => {
  const f = fixture(); put(f.leaf, "@./big.md"); put(join(f.root, "big.md"), "x".repeat(33));
  await overBound(loadStructuredInstructionSnapshot({ ...f.input, limits: { ...limits, maxFileBytes: 32 } }));
  const shared = join(f.bed.root, "shared"), path = join(shared, "WINTER.md"); put(path, "x".repeat(33));
  const input = { ...f.input, trustedProjectRoot: null, plainInstructions: { projectRoot: f.root, workspace: { path, root: shared } }, limits: { ...limits, maxFileBytes: 32 } };
  await overBound(loadStructuredInstructionSnapshot(input)); rmSync(path);
  await expect(loadStructuredInstructionSnapshot(input)).rejects.toMatchObject({ code: "run_home_instruction_refused" });
});
