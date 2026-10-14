import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstructionReaderTransport } from "../../src/guest/instruction-reader-transport.ts";
import { loadStructuredInstructionSnapshot } from "../../src/run-home/instructions.ts";

// This is an ordinary source-consumer check. The Python process exports owned
// fixture DATA only; no packet source, compiled artifact or native launcher runs.
function fixtureData() {
  const path = fileURLToPath(new URL("../../scripts/guest-reader-native/fixture.py", import.meta.url));
  const script = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('reader_fixture',sys.argv[1])
fixture=importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
print(json.dumps({'source':fixture.CONTENTS['source'].decode(),'shared':fixture.CONTENTS['shared'].decode(),
 'request':fixture.request(),'requestText':fixture.request_bytes().decode(),'snapshot':fixture.expected_snapshot()}))
`;
  const result = Bun.spawnSync(["python3", "-I", "-S", "-B", "-c", script, path], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.length).toBeLessThan(16 * 1024);
  return JSON.parse(result.stdout.toString());
}

test("native harness fixture matches the actual structured loader on temporary DATA", async () => {
  const fixture = fixtureData();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "winter-reader-consumer-")));
  try {
    const source = join(root, "source"), shared = join(root, "shared"), home = join(root, "reader-home");
    for (const path of [source, shared, home]) mkdirSync(path);
    writeFileSync(join(source, "WINTER.md"), fixture.source, { mode: 0o444 });
    writeFileSync(join(shared, "WINTER.md"), fixture.shared, { mode: 0o444 });
    const snapshot = await loadStructuredInstructionSnapshot({
      home, cwd: source, trustedProjectRoot: null, tiers: "admitted-only",
      plainInstructions: { projectRoot: source, workspace: { path: join(shared, "WINTER.md"), root: shared } },
      limits: fixture.request.limits,
    }, { userHome: home });
    // Normalize only disposable host paths into the declared logical fixture view.
    // This is not evidence of a native mount, reader role or atomic attribution.
    const normalized = JSON.parse(JSON.stringify(snapshot, (_key, value) => typeof value === "string"
      ? value.replaceAll(source, fixture.request.views.sourceRoot).replaceAll(shared, fixture.request.views.sharedRoot) : value));
    normalized.digest = createHash("sha256").update(normalized.text).digest("hex");
    expect(normalized).toEqual(fixture.snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual reader transport accepts the fixture and refuses its old trailing LF before any read", async () => {
  const fixture = fixtureData();
  let calls = 0;
  async function run(text: string) {
    let consumed = false;
    const chunks: Uint8Array[] = [];
    await runInstructionReaderTransport({
      read(maximum) {
        if (consumed) return null;
        consumed = true;
        const bytes = Buffer.from(text);
        expect(bytes.length).toBeLessThanOrEqual(maximum);
        return bytes;
      },
      write(bytes) { chunks.push(bytes.slice()); return bytes.length; },
      async reader(request) {
        calls++;
        expect(request).toEqual(fixture.request);
        return `${JSON.stringify({ ...request, snapshot: fixture.snapshot })}\n`;
      },
    });
    return Buffer.concat(chunks).toString("utf8");
  }
  await expect(run(`${JSON.stringify(fixture.request)}\n`)).rejects.toThrow("instruction_reader_unavailable");
  expect(calls).toBe(0);
  expect(fixture.requestText).toBe(JSON.stringify(fixture.request));
  const response = await run(fixture.requestText);
  expect(calls).toBe(1);
  expect(response.split("\n")).toHaveLength(2);
  expect(JSON.parse(response)).toEqual({ ...fixture.request, snapshot: fixture.snapshot });
});
