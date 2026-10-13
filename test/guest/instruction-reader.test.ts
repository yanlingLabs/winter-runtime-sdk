import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as publicSdk from "../../src/index.ts";
import { readInstructionFrame, InstructionReaderError, INSTRUCTION_READER_FRAME_BYTES, type InstructionReaderInvocation } from "../../src/guest/instruction-reader.ts";
import { cleanupRunHomeBeds, put, runHomeBed } from "../run-home/support.ts";
afterAll(cleanupRunHomeBeds);
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function fixture() {
  const bed = runHomeBed("private-reader"), sourceRoot = join(bed.root, "source"), sourceCwd = join(sourceRoot, "pkg"), sharedRoot = join(bed.root, "shared"), sharedPath = join(sharedRoot, "WINTER.md");
  put(join(sourceCwd, "WINTER.md"), "CWD"); put(join(sourceRoot, "WINTER.md"), "ROOT @./notes.md"); put(join(sourceRoot, "notes.md"), "NOTES"); put(sharedPath, "SHARED @./shared-notes.md"); put(join(sharedRoot, "shared-notes.md"), "SHARED IMPORT");
  const request: InstructionReaderInvocation = freeze({ version: 1, readId: "12345678-1234-4234-8234-123456789abc",
    owner: { logicalSessionId: "parent", backendSessionId: "backend", generation: 1, bootId: "fixture-boot", incarnationId: "fixture-incarnation", leaseEpoch: 1 },
    views: { sourceRoot, sourceCwd, sharedRoot, sharedPath },
    limits: { maxFileBytes: 128 * 1024, maxReadBytes: 256 * 1024, maxReadOccurrences: 256, maxExpandedBytes: 128 * 1024 } });
  return { bed, sourceRoot, sourceCwd, sharedRoot, sharedPath, request };
}
async function refused(value: unknown) {
  let error: unknown; try { await readInstructionFrame(value); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(InstructionReaderError); expect((error as Error).message).toBe("instruction_reader_unavailable");
}
test("private one-shot function uses actual structured loader with exact copied correlation and required order", async () => {
  const f = fixture(), frame = await readInstructionFrame(f.request), reply = JSON.parse(frame);
  expect(frame.endsWith("\n")).toBe(true); expect(frame.split("\n")).toHaveLength(2); expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(INSTRUCTION_READER_FRAME_BYTES);
  expect(Object.keys(reply).sort()).toEqual(["limits", "owner", "readId", "snapshot", "version", "views"]);
  const { snapshot, ...echo } = reply; expect(echo).toEqual(f.request); expect(snapshot.tiers).toBe("admitted-only");
  expect(Object.keys(snapshot).sort()).toEqual(["blocks", "digest", "droppedImports", "files", "provenance", "skippedLinks", "text", "tiers"]);
  expect(snapshot.blocks.map((b: { requestedPath: string }) => b.requestedPath)).toEqual([f.sharedPath, join(f.sourceRoot, "WINTER.md"), join(f.sourceCwd, "WINTER.md")]);
  expect(snapshot.text).toContain("SHARED SHARED IMPORT"); expect(snapshot.text).toContain("ROOT NOTES"); expect(snapshot.digest).toBe(sha(snapshot.text));
  expect(snapshot.provenance.some((p: { tier: string }) => p.tier === "user")).toBe(false);
});
test("empty required shared file is valid; missing one refuses without cached fallback", async () => {
  const f = fixture(); put(f.sharedPath, ""); const reply = JSON.parse(await readInstructionFrame(f.request)); expect(reply.snapshot.blocks[0].text).toBe("\n");
  rmSync(f.sharedPath); await refused(f.request);
});
test("next fresh call observes shared replacement and source edits, not an immutable file copy", async () => {
  const f = fixture(), before = JSON.parse(await readInstructionFrame(f.request));
  const replacement = join(f.sharedRoot, "replacement"); put(replacement, "REPLACED"); renameSync(replacement, f.sharedPath); put(join(f.sourceRoot, "notes.md"), "CURRENT NOTES");
  const next = freeze({ ...f.request, readId: "12345678-1234-4234-9234-123456789abc" });
  const after = JSON.parse(await readInstructionFrame(next)); expect(after.snapshot.text).toContain("REPLACED"); expect(after.snapshot.text).toContain("CURRENT NOTES"); expect(after.snapshot.digest).not.toBe(before.snapshot.digest);
});
test("planted executable configuration is not consumed by the callable module", async () => {
  const f = fixture(), canary = join(f.bed.root, "preload-canary"), key = "WINTER_READER_FIXTURE_ENV_CANARY", previous = process.env[key], cwd = process.cwd();
  for (const root of [f.sourceRoot, f.sourceCwd]) {
    put(join(root, "preload.js"), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(canary)}, 'EXECUTED');`);
    put(join(root, "bunfig.toml"), 'preload = ["./preload.js"]'); put(join(root, ".env"), `${key}=PLANTED`);
    put(join(root, "tsconfig.json"), '{"compilerOptions":{"plugins":[{"name":"./preload.js"}]}}');
    put(join(root, "package.json"), '{"scripts":{"preload":"bun preload.js"}}');
    put(join(root, ".winter", "settings.json"), "INVALID SETTINGS"); put(join(root, ".winter", "mcp.json"), "INVALID MCP");
  }
  const frame = await readInstructionFrame(f.request); expect(existsSync(canary)).toBe(false); expect(process.env[key]).toBe(previous); expect(process.cwd()).toBe(cwd);
  expect(frame).not.toContain("INVALID SETTINGS"); expect(frame).not.toContain("INVALID MCP");
  // This does not exercise a compiled process's Bun autoload behavior; native entry flags remain owed.
});
test("closed immutable request and correlation fields refuse malformed data and zero-call accessors", async () => {
  const f = fixture(); let getters = 0;
  const cases: unknown[] = [structuredClone(f.request), freeze({ ...f.request, extra: true }), freeze({ ...f.request, version: 2 }), freeze({ ...f.request, readId: "wrong" }),
    freeze({ ...f.request, owner: { ...f.request.owner, agentId: "child" } }), freeze({ ...f.request, owner: { ...f.request.owner, generation: 0 } }),
    freeze({ ...f.request, owner: { ...f.request.owner, logicalSessionId: "x".repeat(129) } }),
    freeze({ ...f.request, views: { ...f.request.views, sourceCwd: `${f.sourceRoot}-foreign` } }),
    freeze({ ...f.request, views: { ...f.request.views, sharedRoot: f.sourceRoot, sharedPath: join(f.sourceRoot, "WINTER.md") } }),
    freeze({ ...f.request, views: { ...f.request.views, sourceRoot: "/", sourceCwd: "/" } }),
    freeze({ ...f.request, views: { ...f.request.views, sharedPath: join(f.sharedRoot, "other.md") } }),
    freeze({ ...f.request, limits: { ...f.request.limits, maxReadOccurrences: 255 } }),
  ];
  const accessor = Object.freeze(Object.defineProperty({ ...f.request }, "readId", { get() { getters++; return f.request.readId; } })); cases.push(accessor);
  for (const value of cases) await refused(value); expect(getters).toBe(0);
});
test("request paths and serialized envelope size are bounded before filesystem access", async () => {
  const f = fixture();
  await refused(freeze({ ...f.request, views: { ...f.request.views, sourceRoot: `/tmp/${"x".repeat(4096)}`, sourceCwd: `/tmp/${"x".repeat(4096)}` } }));
  // Four individually bounded escaped paths can exceed the 16KiB JSON request cap.
  const a = `/${'"'.repeat(4000)}`, b = `/${'"'.repeat(3990)}shared`;
  await refused(freeze({ ...f.request, views: { sourceRoot: a, sourceCwd: a, sharedRoot: b, sharedPath: `${b}/WINTER.md` } }));
});
test("actual loader byte/occurrence/expansion limits refuse rather than emitting partial frames", async () => {
  const f = fixture(); put(f.sharedPath, "x".repeat(128 * 1024 + 1)); await refused(f.request);
  put(f.sharedPath, "@./many.md ".repeat(256)); put(join(f.sharedRoot, "many.md"), "M"); await refused(f.request);
  put(f.sharedPath, "@./expand.md @./expand.md"); put(join(f.sharedRoot, "expand.md"), "@./leaf.md @./leaf.md"); put(join(f.sharedRoot, "leaf.md"), "L".repeat(40_000)); await refused(f.request);
});
test("JSON-escaped output growth and duplicated structured text obey the strict frame ceiling", async () => {
  const f = fixture(); put(f.sharedPath, "\u0001".repeat(60_000));
  // Raw/decoded/expanded loader budgets fit, but JSON string escaping alone exceeds frame cap.
  await refused(f.request);
  put(f.sharedPath, "A".repeat(110_000)); await refused(f.request); // Aggregate+block+raw exceeds320KiB.
});
test("outside source guidance aliases refuse/skips remain data rather than protected-read claims", async () => {
  const f = fixture(); put(join(f.sourceRoot, "notes.md"), "@../outside.md"); put(join(f.bed.root, "outside.md"), "INERT OUTSIDE");
  const reply = JSON.parse(await readInstructionFrame(f.request)); expect(reply.snapshot.droppedImports).toContain(join(f.bed.root, "outside.md"));
  expect(reply.snapshot.text).not.toContain("INERT OUTSIDE");
  // Host v1 mapper rejects non-empty drops. This is ordinary guardrail behavior, not a race-proof test.
});

test("private reader is not exported through the public Runtime SDK door", () => {
  expect("readInstructionFrame" in publicSdk).toBe(false);
  expect("InstructionReaderInvocation" in publicSdk).toBe(false);
});

test("path grammar refuses every C0/DEL/backslash and unpaired surrogate before loading", async () => {
  const f = fixture();
  for (const char of [...Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)), "\x7f", "\\", "\ud800", "\udfff"]) {
    await refused(freeze({ ...f.request, views: { ...f.request.views, sourceRoot: `${f.sourceRoot}${char}`, sourceCwd: `${f.sourceRoot}${char}/pkg` } }));
  }
});
test("normal spaces and Unicode view names remain readable", async () => {
  const f = fixture(), sourceRoot = join(f.bed.root, "source with space é🙂"), sourceCwd = join(sourceRoot, "sub 中文"), sharedRoot = join(f.bed.root, "shared with space α");
  put(join(sourceCwd, "WINTER.md"), "UNICODE SOURCE"); const sharedPath = join(sharedRoot, "WINTER.md"); put(sharedPath, "UNICODE SHARED");
  const request = freeze({ ...f.request, views: { sourceRoot, sourceCwd, sharedRoot, sharedPath } });
  const reply = JSON.parse(await readInstructionFrame(request)); expect(reply.views).toEqual(request.views);
  expect(reply.snapshot.text).toContain("UNICODE SOURCE"); expect(reply.snapshot.text).toContain("UNICODE SHARED");
});
