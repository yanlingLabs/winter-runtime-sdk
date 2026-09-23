// V19 (WS-21 §7.3): every direct per-source settings read of the PINNED runtime, enumerated LIVE from
// its embedded JS and held against `fixtures/v19-classification.json`. A key the runtime reads from a
// repository's own settings files, whatever the setting sources are, must be closed: pinned in the flag
// layer, neutralised by an env variable the router sets, or harmless for a stated reason. A new pinned
// version that adds a read fails here until someone has classified it — and a read that disappeared
// fails too, so the fixture stays the runtime's exact list.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { buildOfficialOptions } from "../../src/official/options-template.ts";
import { buildOfficialChildEnv } from "../../src/official/env-allowlist.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { officialRuntimeBed } from "./support.ts";
import { enumerateV19Reads, readBinaryText } from "./v19-enumerate.ts";

const bed = officialRuntimeBed();
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "v19-classification.json"), "utf8")) as { pinnedRuntime: string; keys: Record<string, string> };

const CLOSURE = /^(flag-pinned|env-neutralised:[A-Z0-9_]+|harmless:.{10,})$/;

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "V19",
  decidedAt: new Date(0).toISOString(),
};

describe("V19 — the fixture's own shape", () => {
  test("every entry carries a closure: flag-pinned, env-neutralised:<VARIABLE> or harmless:<reason>", () => {
    for (const [key, closure] of Object.entries(fixture.keys)) expect([key, CLOSURE.test(closure)]).toEqual([key, true]);
  });

  test("every flag-pinned key IS in the router's flag layer on a run-home launch", () => {
    const options = buildOfficialOptions({
      mode: "code",
      selection,
      cwd: "/work/repo",
      sessionStore: { append: async () => undefined, load: async () => null } as unknown as SessionStore,
      autoMemoryDirectory: "/h/sdk/projects/k/memory",
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: "/vendored/claude",
      spawnProxy: () => {
        throw new Error("not spawned");
      },
      profile: "fresh-spool",
      configDir: "/h/cache/runs/r",
      runHome: { runId: "r", dir: "/h/cache/runs/r", sdkHome: "/h/sdk", home: "/h", trustedProjectRoot: "/work/repo", memoryDir: "/h/sdk/projects/k/memory", autoMemoryEnabled: true, skillOverrides: { "some-skill": "off" } },
    });
    const flag = options.settings as Record<string, unknown>;
    for (const [key, closure] of Object.entries(fixture.keys)) if (closure === "flag-pinned") expect([key, key in flag]).toEqual([key, true]);
  });

  test("every env-neutralised key names a variable the router sets on a run-home launch", () => {
    const env = buildOfficialChildEnv({ selection, configDir: "/h/cache/runs/r", brand: WINTER_BRAND, credentials: { ANTHROPIC_API_KEY: "sk-x" }, runHome: { sdkHome: "/h/sdk" } });
    for (const [key, closure] of Object.entries(fixture.keys)) {
      if (!closure.startsWith("env-neutralised:")) continue;
      const variable = closure.slice("env-neutralised:".length);
      expect([key, env[variable]]).toEqual([key, "1"]);
    }
  });
});

(bed === undefined ? describe.skip : describe)("V19 — the live enumeration over the pinned binary", () => {
  test(
    "the reader is found by its call shape, and every key it reads is classified (and every classified key is still read)",
    () => {
      /* c8 ignore next */
      if (bed === undefined) return;
      expect(bed.version).toBe(fixture.pinnedRuntime);
      const { readers, reads } = enumerateV19Reads(readBinaryText(bed.executable));
      // NOT VACUOUS: the main per-source reader was found and reads the memory directory through it.
      expect(readers.length).toBeGreaterThan(0);
      expect(reads.some((read) => read.key === "autoMemoryDirectory" && read.source === "projectSettings")).toBe(true);
      const discovered = [...new Set(reads.map((read) => read.key))].sort();
      const unclassified = discovered.filter((key) => !(key in fixture.keys));
      expect(unclassified).toEqual([]);
      const stale = Object.keys(fixture.keys).filter((key) => !discovered.includes(key));
      expect(stale).toEqual([]);
    },
    120_000,
  );
});
