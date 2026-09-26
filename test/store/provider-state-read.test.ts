// WS-23 — the provider-state sidecar's ONE reader keeps memory bounded, the way the SDK's own streamed
// read does (`packages/runtime/src/store/provider-state.ts`, review r1 I-4): an oversized line is skipped
// unread, the OLDEST records are let go once the kept bytes pass the bound, and the working list never
// grows with the file. Every home is an `mkdtemp` directory removed in a `finally`.
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";

import { providerStateSidecarPath, readProviderStateSidecar } from "../../src/store/index.ts";

const key: SessionKey = { projectKey: "-tmp-project", sessionId: "sess-read" };

function withHome(run: (home: string, path: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "runtime-sdk-sidecar-read-"));
  const path = providerStateSidecarPath(home, key);
  mkdirSync(dirname(path), { recursive: true });
  return run(home, path).finally(() => rmSync(home, { recursive: true, force: true }));
}

const record = (n: number): string => `${JSON.stringify({ kind: "origin", uuid: `u-${n}`, n })}\n`;

describe("readProviderStateSidecar: bounded streamed read", () => {
  test("an absent sidecar reads as []", async () => {
    await withHome(async (home) => {
      expect(await readProviderStateSidecar(home, key)).toEqual([]);
    });
  });

  test("a torn tail and a malformed middle line are skipped; every whole record is kept, in order", async () => {
    await withHome(async (home, path) => {
      writeFileSync(path, `${record(1)}not json\n${record(2)}{"kind":"orig`);
      const read = await readProviderStateSidecar(home, key);
      expect(read.map((r) => (r as unknown as { n: number }).n)).toEqual([1, 2]);
    });
  });

  test("a line past the line bound is skipped unread; its neighbours survive", async () => {
    await withHome(async (home, path) => {
      writeFileSync(path, `${record(1)}${"x".repeat(4096)}\n${record(2)}`);
      const read = await readProviderStateSidecar(home, key, { maxLineBytes: 1024 });
      expect(read.map((r) => (r as unknown as { n: number }).n)).toEqual([1, 2]);
    });
  });

  test("past the kept bound the OLDEST go, the newest stay, and the working list stays bounded", async () => {
    await withHome(async (home, path) => {
      const total = 20_000;
      let body = "";
      for (let n = 0; n < total; n++) body += record(n);
      appendFileSync(path, body);
      const lineBytes = record(total - 1).length - 1; // the bound counts a line without its newline
      const stats = { peakRetained: 0 };
      const read = await readProviderStateSidecar(home, key, { maxKeptBytes: lineBytes * 100, stats });
      const ns = read.map((r) => (r as unknown as { n: number }).n);
      expect(ns.length).toBeGreaterThan(0);
      expect(ns.length).toBeLessThanOrEqual(100);
      expect(ns.at(-1)).toBe(total - 1);
      // About twice what the bound keeps, never the file's 20,000 records.
      expect(stats.peakRetained).toBeLessThanOrEqual(250);
    });
  });
});
