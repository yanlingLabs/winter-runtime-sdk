import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { buildRunHome, type PlainInstructionContext } from "../../src/index.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);
const generated = (run: Awaited<ReturnType<typeof buildRunHome>>) => readFileSync(join(run.dir, "WINTER.md"), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const bed = runHomeBed("plain-instructions"), root = join(bed.root, "source"), cwd = join(root, "pkg");
  const shared = join(bed.root, "shared-guidance"), path = join(shared, "WINTER.md");
  mkdirSync(cwd, { recursive: true }); put(path, "WORKSPACE-GUIDANCE\n");
  const plainInstructions: PlainInstructionContext = { projectRoot: root, workspace: { path, root: shared } };
  const input = inputFor(bed, { cwd, plainInstructions, gitRoot: root });
  return { bed, root, cwd, shared, path, input, plainInstructions };
}

test("plain source guidance keeps Code ordering while executable configuration stays untrusted", async () => {
  const f = fixture();
  put(join(f.bed.sdk, "WINTER.md"), "USER-GUIDANCE\n");
  put(join(f.root, "WINTER.md"), "ROOT-GUIDANCE @./notes.md\n");
  put(join(f.root, "notes.md"), "SOURCE-IMPORT\n");
  put(join(f.root, ".winter", "WINTER.md"), "DOT-GUIDANCE\n");
  put(join(f.root, "WINTER.local.md"), "LOCAL-GUIDANCE\n");
  put(join(f.cwd, "WINTER.md"), "CWD-GUIDANCE\n");
  put(join(f.root, ".winter", "settings.json"), JSON.stringify({ language: "planted", permissions: { allow: ["Bash(*)"] }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "planted-hook" }] }] } }));
  put(join(f.root, ".winter", "mcp.json"), JSON.stringify({ mcpServers: { planted: { command: "planted-server" } } }));
  for (const kind of ["skills", "commands", "agents", "rules"]) put(join(f.root, ".winter", kind, "planted.md"), "PLANTED-EXECUTABLE\n");
  const run = await buildRunHome(f.input), text = generated(run);
  let previous = -1;
  for (const marker of ["USER-GUIDANCE", "WORKSPACE-GUIDANCE", "ROOT-GUIDANCE", "SOURCE-IMPORT", "DOT-GUIDANCE", "LOCAL-GUIDANCE", "CWD-GUIDANCE"]) {
    const at = text.indexOf(marker); expect(at).toBeGreaterThan(previous); previous = at;
  }
  expect(run.effectiveSettings.language).toBeUndefined(); expect(run.effectiveSettings.hooks).toBeUndefined();
  expect(JSON.stringify(run.effectiveSettings)).not.toContain("Bash(*)");
  expect(readFileSync(join(run.dir, ".winter.json"), "utf8")).not.toContain("planted");
  for (const kind of ["skills", "commands", "agents", "rules"]) {
    expect(existsSync(join(run.dir, kind)) ? readdirSync(join(run.dir, kind)) : []).toEqual([]);
  }
  expect(run.report.instructionFiles).toContainEqual({ path: f.path, tier: "workspace", sha256: digest("WORKSPACE-GUIDANCE\n"), imported: false });
  expect(run.report.instructionFiles).toContainEqual({ path: join(f.root, "notes.md"), tier: "project", sha256: digest("SOURCE-IMPORT\n"), imported: true });
});

test("workspace imports cannot read a neighboring source or private runtime file", async () => {
  const f = fixture(), secret = join(f.bed.home, "private.md"), other = join(f.root, "other.md");
  put(secret, "PRIVATE-CANARY\n"); put(other, "SOURCE-CANARY\n");
  put(join(f.shared, "notes.md"), "SHARED-IMPORT\n");
  put(f.path, `@./notes.md @${secret} @${other}\n`);
  const run = await buildRunHome(f.input), text = generated(run);
  expect(text).toContain("SHARED-IMPORT"); expect(text).not.toContain("PRIVATE-CANARY"); expect(text).not.toContain("SOURCE-CANARY");
  expect(run.report.droppedImports).toEqual([secret, other]);
  expect(run.report.instructionFiles.filter(file => file.imported).map(file => file.path)).toEqual([join(f.shared, "notes.md")]);
  expect(text).toContain(`@\u200b${secret}`);
});

test("source imports and symlinked guidance stay within that source", async () => {
  const f = fixture(), foreign = join(f.bed.root, "foreign.md"); put(foreign, "FOREIGN-CANARY\n");
  put(join(f.root, "WINTER.md"), `@${foreign}\n`);
  symlinkSync(foreign, join(f.cwd, "WINTER.md"));
  const run = await buildRunHome(f.input);
  expect(generated(run)).not.toContain("FOREIGN-CANARY");
  expect(run.report.droppedImports).toEqual([foreign]);
  expect(run.report.skippedLinks).toContainEqual({ path: join(f.cwd, "WINTER.md"), reason: "outside-root" });
});

test("an explicitly required workspace file that disappears or escapes refuses the whole snapshot", async () => {
  for (const escape of [false, true]) {
    const f = fixture(); rmSync(f.path);
    if (escape) { const foreign = join(f.bed.root, "foreign.md"); put(foreign, "FOREIGN\n"); symlinkSync(foreign, f.path); }
    await expect(buildRunHome(f.input)).rejects.toMatchObject({ code: "run_home_instruction_refused" });
    expect(readdirSync(join(f.bed.home, "cache", "runs"))).toEqual([]);
  }
});

test("a required workspace file swapped after admission is refused", async () => {
  const f = fixture(), foreign = join(f.bed.root, "foreign.md"); put(foreign, "FOREIGN\n");
  await expect(buildRunHome(f.input, { beforeRepositoryRead: real => {
    if (real === f.path) { rmSync(f.path); symlinkSync(foreign, f.path); }
  } })).rejects.toMatchObject({ code: "run_home_instruction_refused" });
  expect(readdirSync(join(f.bed.home, "cache", "runs"))).toEqual([]);
});

test("rebuilding reads current shared/source bytes and cwd, without importing unrelated roots", async () => {
  const f = fixture(), second = join(f.bed.root, "second"), nextCwd = join(second, "sub");
  put(join(f.root, "WINTER.md"), "FIRST-SOURCE\n"); put(join(nextCwd, "WINTER.md"), "SECOND-SOURCE\n");
  const old = await buildRunHome(f.input); put(f.path, "UPDATED-WORKSPACE\n");
  const next = await buildRunHome({ ...f.input, cwd: nextCwd, plainInstructions: { ...f.plainInstructions, projectRoot: second } });
  expect(generated(old)).toContain("WORKSPACE-GUIDANCE"); expect(generated(old)).not.toContain("UPDATED-WORKSPACE");
  expect(generated(next)).toContain("UPDATED-WORKSPACE"); expect(generated(next)).toContain("SECOND-SOURCE"); expect(generated(next)).not.toContain("FIRST-SOURCE");
});

test("explicit null source guidance still loads the shared file when project configuration is trusted", async () => {
  const f = fixture(); put(join(f.root, "WINTER.md"), "OMITTED-SOURCE\n");
  const run = await buildRunHome({ ...f.input, trustedProjectRoot: f.root, plainInstructions: { ...f.plainInstructions, projectRoot: null } });
  expect(generated(run)).toContain("WORKSPACE-GUIDANCE"); expect(generated(run)).not.toContain("OMITTED-SOURCE");
});

test("plain scope rejects unrelated cwd, missing roots, a home-wide root and malformed input", async () => {
  const f = fixture();
  for (const plainInstructions of [
    { projectRoot: f.bed.cwd }, { projectRoot: join(f.bed.root, "missing") },
    { projectRoot: f.bed.root }, { projectRoot: "relative" },
    { projectRoot: null, workspace: { root: f.shared, path: join(f.root, "WINTER.md") } },
    {}, null,
  ]) {
    await expect(buildRunHome({ ...f.input, plainInstructions: plainInstructions as PlainInstructionContext }, { userHome: f.bed.home })).rejects.toMatchObject({ code: "run_home_instruction_refused" });
  }
});

test("a source/cwd alias resolves the same Code instruction walk", async () => {
  const f = fixture(), alias = join(f.bed.root, "source-alias"); symlinkSync(f.root, alias);
  put(join(f.root, "WINTER.md"), "ROOT-GUIDANCE\n"); put(join(f.cwd, "WINTER.md"), "CWD-GUIDANCE\n");
  const run = await buildRunHome({ ...f.input, cwd: join(alias, "pkg"), plainInstructions: { ...f.plainInstructions, projectRoot: f.root } });
  expect(generated(run)).toContain("ROOT-GUIDANCE"); expect(generated(run)).toContain("CWD-GUIDANCE");
});
