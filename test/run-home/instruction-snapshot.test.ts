import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";
import { buildRunHome, loadInstructionSnapshot, type InstructionSnapshotInput } from "../../src/index.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);
const file = WINTER_BRAND.instructionsFile, dot = WINTER_BRAND.projectDirName;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function fixture() {
  const bed = runHomeBed("instruction-snapshot"), root = join(bed.root, "source"), cwd = join(root, "pkg");
  const shared = join(bed.root, "shared-guidance"), path = join(shared, file);
  mkdirSync(cwd, { recursive: true });put(path, "SHARED\n");
  const input: InstructionSnapshotInput = { home: bed.home, cwd, trustedProjectRoot: null, plainInstructions: { projectRoot: root, workspace: { path, root: shared } } };
  return { bed, root, cwd, shared, path, input };
}

test("snapshot is the exact instruction producer consumed by both plain and ordinary builds", async () => {
  for (const plain of [true, false]) {
    const f = fixture();put(join(f.bed.sdk, file), "USER\n");put(join(f.root, file), "ROOT @./notes.md\n");put(join(f.root, "notes.md"), "IMPORT\n");put(join(f.root, dot, file), "DOT\n");put(join(f.cwd, file), "CWD\n");
    const input: InstructionSnapshotInput = plain ? f.input : { home: f.bed.home, cwd: f.cwd, trustedProjectRoot: f.root };
    const snapshot = await loadInstructionSnapshot(input);
    const run = await buildRunHome(inputFor(f.bed, input));
    expect(readFileSync(join(run.dir, file), "utf8")).toBe(snapshot.text);
    expect(snapshot.digest).toBe(digest(snapshot.text));expect(run.report.instructionFiles).toEqual(snapshot.files);
    expect(run.report.skippedLinks).toEqual(snapshot.skippedLinks);expect(run.report.droppedImports).toEqual(snapshot.droppedImports);
  }
});

test("every load sees current files/imports and cwd/source switching without a cache or storage creation", async () => {
  const f = fixture();f.input.home = join(f.bed.root, "not-created-home");
  put(join(f.root, file), "FIRST @./notes.md\n");put(join(f.root, "notes.md"), "OLD-IMPORT\n");put(join(f.cwd, file), "FIRST-CWD\n");
  const first = await loadInstructionSnapshot(f.input);put(f.path, "CURRENT-SHARED\n");put(join(f.root, "notes.md"), "NEW-IMPORT\n");
  const edited = await loadInstructionSnapshot(f.input);
  expect(first.text).toContain("OLD-IMPORT");expect(edited.text).toContain("NEW-IMPORT");expect(edited.text).toContain("CURRENT-SHARED");expect(edited.digest).not.toBe(first.digest);
  const second = join(f.bed.root, "second-source"), next = join(second, "sub");put(join(next, file), "SECOND-CWD\n");
  const moved = await loadInstructionSnapshot({ ...f.input, cwd: next, plainInstructions: { ...f.input.plainInstructions!, projectRoot: second } });
  expect(moved.text).toContain("SECOND-CWD");expect(moved.text).toContain("CURRENT-SHARED");expect(moved.text).not.toContain("FIRST");
  expect(existsSync(f.input.home)).toBe(false);expect(existsSync(join(f.bed.home, "cache"))).toBe(false);
  // Returned data belongs to its caller, never to a retained loader cache.
  edited.files.length = 0;edited.skippedLinks.push({ path: "caller-mutation", reason: "missing" });
  const fresh = await loadInstructionSnapshot(f.input);expect(fresh.files.length).toBeGreaterThan(0);expect(fresh.skippedLinks).toEqual([]);
});

test("loads original current sources instead of stale generated run-home snapshots", async () => {
  const f = fixture();put(join(f.root, file), "BEFORE\n");const run = await buildRunHome(inputFor(f.bed, f.input));
  put(join(run.dir, file), "STALE-GENERATED-SNAPSHOT\n");put(join(f.root, file), "AFTER\n");
  const snapshot = await loadInstructionSnapshot(f.input);
  expect(snapshot.text).toContain("AFTER");expect(snapshot.text).not.toContain("STALE-GENERATED-SNAPSHOT");
  expect(readFileSync(join(run.dir, file), "utf8")).toBe("STALE-GENERATED-SNAPSHOT\n");
});

test("snapshot never discovers executable configuration, items, rules or MCP", async () => {
  const f = fixture(), reads: string[] = [];put(join(f.root, file), "ONLY-GUIDANCE\n");
  for (const base of [f.bed.sdk, join(f.root, dot)]) {
    for (const name of ["settings.json", "settings.local.json", "mcp.json"]) put(join(base, name), "malformed planted executable configuration\n");
    for (const kind of ["skills", "commands", "agents", "rules", "output-styles"]) put(join(base, kind, "planted.md"), "PLANTED-ITEM\n");
  }
  const before = readdirSync(f.bed.home).sort();
  const snapshot = await loadInstructionSnapshot(f.input, { beforeRepositoryRead: path => reads.push(path) });
  expect(snapshot.text).toContain("ONLY-GUIDANCE");expect(snapshot.text).not.toContain("PLANTED");expect(snapshot.text).not.toContain("malformed");
  expect(reads).toEqual([f.path, join(f.root, file)]);expect(readdirSync(f.bed.home).sort()).toEqual(before);
  expect(existsSync(join(f.bed.home, "cache"))).toBe(false);
});

test("alias provenance and scoped imports preserve accepted behavior on repeated snapshots", async () => {
  const f = fixture(), target = join(f.root, "docs", "guide.md"), requested = join(f.root, file), foreign = join(f.bed.root, "foreign.md");
  put(target, `ALIASED @./docs/notes.md @${foreign}\n`);put(join(f.root, "docs", "notes.md"), "IN-ROOT\n");put(foreign, "OUTSIDE\n");symlinkSync(target, requested);
  const snapshot = await loadInstructionSnapshot(f.input);
  expect(snapshot.files).toContainEqual({ path: target, requestedPath: requested, tier: "project", sha256: digest(`ALIASED @./docs/notes.md @${foreign}\n`), imported: false });
  expect(snapshot.files).toContainEqual({ path: join(f.root, "docs", "notes.md"), tier: "project", sha256: digest("IN-ROOT\n"), imported: true });
  expect(snapshot.droppedImports).toEqual([foreign]);expect(snapshot.text).not.toContain("OUTSIDE");expect(snapshot.text).toContain(`@\u200b${foreign}`);
  symlinkSync(foreign, join(f.cwd, file));const next = await loadInstructionSnapshot(f.input);
  expect(next.skippedLinks).toContainEqual({ path: join(f.cwd, file), reason: "outside-root" });
});

test("required shared missing, escaped and swapped files refuse without creating a run tree", async () => {
  for (const kind of ["missing", "escaped", "swapped"] as const) {
    const f = fixture(), foreign = join(f.bed.root, "foreign.md");put(foreign, "OUTSIDE\n");
    if (kind !== "swapped") { rmSync(f.path);if (kind === "escaped") symlinkSync(foreign, f.path); }
    await expect(loadInstructionSnapshot(f.input, kind === "swapped" ? { beforeRepositoryRead: path => { if (path === f.path) { rmSync(f.path);symlinkSync(foreign, f.path); } } } : {})).rejects.toMatchObject({ code: "run_home_instruction_refused" });
    expect(existsSync(join(f.bed.home, "cache"))).toBe(false);
  }
  const f = fixture();put(f.path, "");const empty = await loadInstructionSnapshot(f.input);
  expect(empty.files).toContainEqual({ path: f.path, tier: "workspace", sha256: digest(""), imported: false });
});

test("workspace imports remain confined and explicit null source guidance stays independent", async () => {
  const f = fixture(), secret = join(f.bed.home, "private.md");put(secret, "PRIVATE\n");put(join(f.shared, "notes.md"), "SHARED-IMPORT\n");put(f.path, `@./notes.md @${secret}\n`);put(join(f.root, file), "SOURCE\n");
  const snapshot = await loadInstructionSnapshot({ ...f.input, trustedProjectRoot: f.root, plainInstructions: { ...f.input.plainInstructions!, projectRoot: null } });
  expect(snapshot.text).toContain("SHARED-IMPORT");expect(snapshot.text).not.toContain("PRIVATE");expect(snapshot.text).not.toContain("SOURCE");expect(snapshot.droppedImports).toEqual([secret]);
});

test("brand-derived filenames and home/root input boundaries apply to the public resolver", async () => {
  const f = fixture(), brand = { ...WINTER_BRAND, instructionsFile: "GUIDE.md", projectDirName: ".guide" };
  put(join(f.bed.sdk, brand.instructionsFile), "BRAND-USER\n");put(join(f.root, brand.instructionsFile), "BRAND-ROOT\n");put(join(f.root, brand.projectDirName, brand.instructionsFile), "BRAND-DOT\n");put(join(f.cwd, "GUIDE.local.md"), "BRAND-LOCAL\n");
  const input = { ...f.input, brand };const snapshot = await loadInstructionSnapshot(input);
  expect(snapshot.text).toContain("BRAND-USER");expect(snapshot.text).toContain("BRAND-ROOT");expect(snapshot.text).toContain("BRAND-DOT");expect(snapshot.text).toContain("BRAND-LOCAL");
  const run = await buildRunHome(inputFor(f.bed, input));expect(readFileSync(join(run.dir, brand.instructionsFile), "utf8")).toBe(snapshot.text);
  await expect(loadInstructionSnapshot({ ...f.input, home: "relative" })).rejects.toBeInstanceOf(TypeError);
  await expect(loadInstructionSnapshot({ ...f.input, cwd: "relative" })).rejects.toBeInstanceOf(TypeError);
  await expect(loadInstructionSnapshot({ ...f.input, trustedProjectRoot: "relative" })).rejects.toBeInstanceOf(TypeError);
  await expect(loadInstructionSnapshot({ ...f.input, plainInstructions: { projectRoot: f.bed.root } }, { userHome: f.bed.home })).rejects.toMatchObject({ code: "run_home_instruction_refused" });
});
