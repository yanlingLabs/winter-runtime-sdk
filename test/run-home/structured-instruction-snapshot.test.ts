import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { buildRunHome, loadInstructionSnapshot, loadStructuredInstructionSnapshot, type StructuredInstructionSnapshotInput } from "../../src/index.ts";
import { expandImports, MAX_IMPORT_DEPTH } from "../../src/run-home/instructions.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed } from "./support.ts";
afterAll(cleanupRunHomeBeds);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture() {
  const bed = runHomeBed("structured-guidance"), root = join(bed.root, "source"), cwd = join(root, "pkg"), shared = join(bed.root, "shared");
  mkdirSync(cwd, { recursive: true }); put(join(shared, "WINTER.md"), "SHARED");
  const input: StructuredInstructionSnapshotInput = { home: bed.home, cwd, trustedProjectRoot: null, plainInstructions: { projectRoot: root, workspace: { path: join(shared, "WINTER.md"), root: shared } } };
  return { bed, root, cwd, shared, input };
}
test("one walk preserves legacy golden bytes, reports and build output while recording frozen structured data", async () => {
  const f = fixture(), requested = join(f.root, "WINTER.md"), admitted = join(f.root, "guidance", "root.md"), outside = join(f.bed.root, "outside.md");
  put(join(f.bed.sdk, "WINTER.md"), "USER @./user-notes.md"); put(join(f.bed.sdk, "user-notes.md"), "PERSONAL");
  put(admitted, "ROOT @./notes.md @./missing.md @../outside.md\n`span @./notes.md`\n```\n@./notes.md\n```\n"); symlinkSync(admitted, requested);
  put(join(f.root, "notes.md"), "NOTE @./cycle.md"); put(join(f.root, "cycle.md"), "CYCLE @./notes.md"); put(outside, "OUTSIDE"); put(join(f.cwd, "WINTER.md"), "LOCAL");
  symlinkSync(outside, join(f.cwd, "WINTER.local.md"));
  const reads: string[] = [], structured = await loadStructuredInstructionSnapshot(f.input, { beforeInstructionRead: path => reads.push(path) });
  const legacy = await loadInstructionSnapshot(f.input), run = await buildRunHome(inputFor(f.bed, f.input));
  expect(Object.keys(legacy).sort()).toEqual(["digest", "droppedImports", "files", "skippedLinks", "text"]);
  for (const key of ["text", "digest", "files", "skippedLinks", "droppedImports"] as const) expect(structured[key]).toEqual(legacy[key]);
  const expected = [
    `# ${join(f.bed.sdk, "WINTER.md")}\n\nUSER PERSONAL\n`, `# ${join(f.shared, "WINTER.md")}\n\nSHARED\n`,
    `# ${requested}\n\nROOT NOTE CYCLE @\u200b./notes.md @\u200b./missing.md @\u200b../outside.md\n\`span @\u200b./notes.md\`\n\`\`\`\n@\u200b./notes.md\n\`\`\`\n`,
    `# ${join(f.cwd, "WINTER.md")}\n\nLOCAL\n`,
  ].join("\n");
  expect(legacy.text).toBe(expected); expect(legacy.digest).toBe(sha(expected)); expect(readFileSync(join(run.dir, "WINTER.md"), "utf8")).toBe(expected);
  expect(run.report.instructionFiles).toEqual(legacy.files); expect(run.report.skippedLinks).toEqual(legacy.skippedLinks); expect(run.report.droppedImports).toEqual(legacy.droppedImports);
  expect(structured.blocks.map(b => `# ${b.requestedPath}\n\n${b.text}`).join("\n")).toBe(structured.text);
  expect(reads).toEqual(structured.provenance.map(p => p.admittedPath)); // Same successful content reads, no recorder rereads.
  expect(structured.skippedLinks).toContainEqual({ path: join(f.cwd, "WINTER.local.md"), reason: "outside-root" }); expect(structured.droppedImports).toEqual([outside]);
  for (const p of [...structured.provenance, ...structured.blocks]) expect(p.textSha256).toBe(sha(p.text));
  expect(structured.provenance.find(p => p.requestedPath === requested)?.text).toContain("@./notes.md");
  expect(structured.blocks.find(p => p.requestedPath === requested)?.text).toContain("NOTE CYCLE");
  expect(Object.isFrozen(structured)).toBe(true); expect(Object.isFrozen(structured.files)).toBe(true); expect(Object.isFrozen(structured.blocks[0])).toBe(true);
  expect(Object.isFrozen(structured.provenance[0])).toBe(true); expect(structured.tiers).toBe("all");
});
test("admitted-only omits personal file and imports before all content reads and hashes", async () => {
  const f = fixture(), user = join(f.bed.sdk, "WINTER.md"), imported = join(f.bed.sdk, "private-notes.md");
  put(user, "PERSONAL @./private-notes.md"); put(imported, "PRIVATE PERSONAL"); put(join(f.root, "WINTER.md"), "SOURCE");
  const reads: string[] = [];
  const result = await loadStructuredInstructionSnapshot({ ...f.input, tiers: "admitted-only" }, { beforeInstructionRead(path) { reads.push(path); if (path === user || path === imported) throw new Error("personal read must not occur"); } });
  expect(result.tiers).toBe("admitted-only"); expect(reads).toEqual([join(f.shared, "WINTER.md"), join(f.root, "WINTER.md")]);
  expect(result.provenance.some(p => p.tier === "user")).toBe(false); expect(result.files.some(p => p.tier === "user")).toBe(false); expect(result.text).not.toContain("PERSONAL");
  expect((await loadInstructionSnapshot({ ...f.input, tiers: "admitted-only" } as StructuredInstructionSnapshotInput)).text).toContain("PERSONAL"); // Legacy always all.
  await expect(loadStructuredInstructionSnapshot({ ...f.input, tiers: "invalid" as "all" })).rejects.toThrow("invalid instruction snapshot tiers");
});
test("symlinked containing files carry requested and admitted importer identities without changing relative resolution", async () => {
  const f = fixture(), top = join(f.root, "WINTER.md"), actualTop = join(f.root, "actual", "top.md"), requestedImport = join(f.root, "link.md"), actualImport = join(f.root, "actual", "import.md");
  put(actualTop, "TOP @./link.md"); symlinkSync(actualTop, top); put(actualImport, "IMPORT @./nested.md"); symlinkSync(actualImport, requestedImport);
  put(join(f.root, "nested.md"), "LEXICAL"); put(join(f.root, "actual", "nested.md"), "WRONG REALPATH BASE");
  const result = await loadStructuredInstructionSnapshot({ ...f.input, tiers: "admitted-only" });
  const parent = result.provenance.find(p => p.requestedPath === top)!;
  const imported = result.provenance.find(p => p.requestedPath === requestedImport)!;
  const nested = result.provenance.find(p => p.requestedPath === join(f.root, "nested.md"))!;
  expect(imported).toMatchObject({ admittedPath: actualImport, importerPath: top, importerAdmittedPath: actualTop, depth: 1 });
  expect(imported.importerPath).toBe(parent.requestedPath); expect(imported.importerAdmittedPath).toBe(parent.admittedPath);
  expect(nested).toMatchObject({ importerPath: requestedImport, importerAdmittedPath: actualImport, depth: 2 });
  expect(result.text).toContain("LEXICAL"); expect(result.text).not.toContain("WRONG REALPATH BASE");
});
test("depth five is read and recorded while depth six remains import-neutralized literal", async () => {
  const f = fixture(); put(join(f.root, "WINTER.md"), "@./d1.md");
  for (let n = 1; n <= 6; n++) put(join(f.root, `d${n}.md`), n === 6 ? "MUST NOT READ" : `DEPTH ${n} @./d${n + 1}.md`);
  const reads: string[] = [], result = await loadStructuredInstructionSnapshot({ ...f.input, tiers: "admitted-only" }, { beforeInstructionRead: path => reads.push(path) });
  expect(MAX_IMPORT_DEPTH).toBe(5); expect(result.provenance.filter(p => p.depth > 0).map(p => p.depth)).toEqual([1, 2, 3, 4, 5]);
  expect(reads).not.toContain(join(f.root, "d6.md")); expect(result.text).toContain("@\u200b./d6.md"); expect(result.text).not.toContain("MUST NOT READ");
});
test("branch-local cycles/diamond imports and import-then-top-level duplicates retain Code occurrence semantics", async () => {
  const f = fixture(); put(join(f.root, "WINTER.md"), "@./b.md @./c.md @./WINTER.local.md");
  put(join(f.root, "b.md"), "B @./d.md"); put(join(f.root, "c.md"), "C @./d.md"); put(join(f.root, "d.md"), "D @./b.md"); put(join(f.root, "WINTER.local.md"), "LOCAL");
  const result = await loadStructuredInstructionSnapshot({ ...f.input, tiers: "admitted-only" });
  const duplicates = result.provenance.filter(p => p.requestedPath === join(f.root, "d.md"));
  expect(duplicates).toHaveLength(2); expect(duplicates[0]!.textSha256).toBe(duplicates[1]!.textSha256); expect(duplicates.map(p => p.importerPath)).toEqual([join(f.root, "b.md"), join(f.root, "c.md")]);
  expect(result.provenance.filter(p => p.requestedPath === join(f.root, "WINTER.local.md")).map(p => p.depth)).toEqual([1, 0]);
  expect(result.blocks.filter(p => p.requestedPath === join(f.root, "WINTER.local.md"))).toHaveLength(1);
  expect(result.text).toBe((await loadInstructionSnapshot(f.input)).text);
});
test("public expandImports onRead stays exactly two arguments", () => {
  const f = fixture(), notes = join(f.root, "notes.md"); put(notes, "BODY");
  const calls: unknown[][] = [];
  expect(expandImports({ content: "@./notes.md", filePath: join(f.root, "WINTER.md"), tier: "project", projectRoot: f.root, onRead: (...args) => calls.push(args) }).content).toBe("BODY");
  expect(calls).toEqual([[notes, "BODY"]]); expect(calls[0]).toHaveLength(2);
});
test("textSha256 hashes decoded UTF8, and snapshots reflect edits without creating storage", async () => {
  const f = fixture(); f.input.home = join(f.bed.root, "absent-home"); const leaf = join(f.root, "WINTER.md"); writeFileSync(leaf, Buffer.from([0xff, 0x41]));
  const before = await loadStructuredInstructionSnapshot(f.input), raw = before.provenance.find(p => p.requestedPath === leaf)!;
  expect(raw.text).toBe("\ufffdA"); expect(raw.textSha256).toBe(sha("\ufffdA")); expect(raw.textSha256).not.toBe(createHash("sha256").update(Buffer.from([0xff, 0x41])).digest("hex"));
  put(leaf, "CURRENT"); const after = await loadStructuredInstructionSnapshot(f.input); expect(after.text).toContain("CURRENT"); expect(after.digest).not.toBe(before.digest); expect(existsSync(f.input.home)).toBe(false);
});
test("required shared refusal, planted configuration and brand-derived names keep existing behavior", async () => {
  const f = fixture(); put(join(f.root, ".winter", "settings.json"), "MALFORMED EXECUTABLE CONFIG");
  put(join(f.root, "WINTER.md"), "ONLY GUIDANCE"); expect((await loadStructuredInstructionSnapshot(f.input)).text).not.toContain("MALFORMED");
  rmSync(join(f.shared, "WINTER.md")); await expect(loadStructuredInstructionSnapshot(f.input)).rejects.toMatchObject({ code: "run_home_instruction_refused" });
  await expect(loadInstructionSnapshot(f.input)).rejects.toMatchObject({ code: "run_home_instruction_refused" });
  const brand = { ...WINTER_BRAND, instructionsFile: "GUIDE.md", projectDirName: ".example" }; put(join(f.shared, "GUIDE.md"), "BRANDED SHARED"); put(join(f.root, "GUIDE.md"), "BRANDED ROOT");
  const input = { ...f.input, brand, plainInstructions: { ...f.input.plainInstructions!, workspace: { path: join(f.shared, "GUIDE.md"), root: f.shared } } };
  const result = await loadStructuredInstructionSnapshot(input); expect(result.blocks.map(b => b.requestedPath)).toEqual([join(f.shared, "GUIDE.md"), join(f.root, "GUIDE.md")]);
});
