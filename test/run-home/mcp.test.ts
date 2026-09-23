// WS-21 §3.4.5: the run folder's MCP config — a copy of the shared home's global config file with the
// local and trusted project servers folded into the top level, the disabled and reserved ones dropped,
// and no `projects` map left for the runtime to consult.
import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildRunHome } from "../../src/index.ts";
import type { RunMode } from "../../src/run-home/types.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const server = (tag: string): Record<string, unknown> => ({ type: "stdio", command: `/bin/${tag}` });

function repo(bed: RunHomeBed): string {
  const root = join(bed.root, "repo");
  mkdirSync(root, { recursive: true });
  return root;
}

async function config(bed: RunHomeBed, overrides: Parameters<typeof inputFor>[1] = {}): Promise<{ file: Record<string, unknown>; dropped: unknown; dir: string }> {
  const runHome = await buildRunHome(inputFor(bed, overrides));
  return { file: JSON.parse(readFileSync(join(runHome.dir, ".winter.json"), "utf8")) as Record<string, unknown>, dropped: runHome.report.droppedMcpServers, dir: runHome.dir };
}

describe("the generated .winter.json", () => {
  test("a copy of sdk/.winter.json, its other keys kept, its `projects` map deleted", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, ".winter.json"), json({ numStartups: 3, theme: "dark", mcpServers: { a: server("a") }, projects: { "/somewhere": { mcpServers: { x: server("x") } } } }));
    const { file } = await config(bed);
    expect(file).toEqual({ numStartups: 3, theme: "dark", mcpServers: { a: server("a") } });
  });

  test("local (for gitRoot ?? cwd) beats the trusted project's .winter/mcp.json, which beats user", async () => {
    const bed = runHomeBed();
    const root = repo(bed);
    put(
      join(bed.sdk, ".winter.json"),
      json({ mcpServers: { shared: server("user"), userOnly: server("user") }, projects: { [root]: { mcpServers: { shared: server("local"), localOnly: server("local") } }, "/other": { mcpServers: { otherOnly: server("other") } } } }),
    );
    put(join(root, ".winter", "mcp.json"), json({ mcpServers: { shared: server("project"), projectOnly: server("project"), localOnly: server("project") } }));
    const { file } = await config(bed, { cwd: root, trustedProjectRoot: root, gitRoot: root });
    expect(file["mcpServers"]).toEqual({ shared: server("local"), userOnly: server("user"), localOnly: server("local"), projectOnly: server("project") });
  });

  test("the local key is the cwd when there is no git root", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, ".winter.json"), json({ projects: { [bed.cwd]: { mcpServers: { here: server("here") } } } }));
    const { file } = await config(bed, { gitRoot: null });
    expect(file["mcpServers"]).toEqual({ here: server("here") });
  });

  test("an untrusted project's .winter/mcp.json is not read", async () => {
    const bed = runHomeBed();
    const root = repo(bed);
    put(join(root, ".winter", "mcp.json"), json({ mcpServers: { planted: server("planted") } }));
    const { file } = await config(bed, { cwd: root, trustedProjectRoot: null, gitRoot: root });
    expect(file["mcpServers"]).toBeUndefined();
  });

  test("the walk's `$HOME` stop (fix round 1, M2, as ruled): never `$HOME/.winter/mcp.json` or one above it — but a local scope keyed at `$HOME` still applies, as claude applies it", async () => {
    const bed = runHomeBed("hm");
    const userHome = join(bed.root, "u");
    const daemonHome = join(userHome, ".winter");
    mkdirSync(join(userHome, "p"), { recursive: true });
    const moved: RunHomeBed = { ...bed, home: daemonHome, sdk: join(daemonHome, "sdk"), cwd: userHome };
    put(join(moved.sdk, ".winter.json"), json({ mcpServers: { u: server("user") }, projects: { [userHome]: { mcpServers: { homeLocal: server("home") } }, [bed.root]: { mcpServers: { aboveLocal: server("above") } } } }));
    put(join(daemonHome, "mcp.json"), json({ mcpServers: { daemonHome: server("daemon") } }));
    put(join(bed.root, ".winter", "mcp.json"), json({ mcpServers: { aboveHome: server("above") } }));
    const expected: Record<string, Record<string, unknown>> = {
      [userHome]: { u: server("user"), homeLocal: server("home") },
      [bed.root]: { u: server("user"), aboveLocal: server("above") },
    };
    for (const root of [userHome, bed.root]) {
      const runHome = await buildRunHome(inputFor(moved, { cwd: root, trustedProjectRoot: root, gitRoot: root }), { userHome });
      const file = JSON.parse(readFileSync(join(runHome.dir, ".winter.json"), "utf8")) as Record<string, unknown>;
      expect([root, file["mcpServers"]]).toEqual([root, expected[root]]);
    }
    // Below `$HOME` the project file applies too.
    const below = join(userHome, "p");
    put(join(below, ".winter", "mcp.json"), json({ mcpServers: { project: server("project") } }));
    put(join(moved.sdk, ".winter.json"), json({ mcpServers: { u: server("user") }, projects: { [below]: { mcpServers: { local: server("local") } } } }));
    const runHome = await buildRunHome(inputFor(moved, { cwd: below, trustedProjectRoot: below, gitRoot: below }), { userHome });
    const file = JSON.parse(readFileSync(join(runHome.dir, ".winter.json"), "utf8")) as Record<string, unknown>;
    expect(file["mcpServers"]).toEqual({ u: server("user"), project: server("project"), local: server("local") });
  });

  test("disabled servers and reserved names are dropped and reported — the brand's standing server name included", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, ".winter.json"), json({ mcpServers: { keep: server("k"), off: server("o"), winter__computer: server("c"), winter: server("w") } }));
    const { file, dropped } = await config(bed, { mcpDisabled: ["off"], reservedMcpServerNames: ["winter__computer"] });
    expect(file["mcpServers"]).toEqual({ keep: server("k") });
    expect(dropped).toEqual([
      { name: "off", reason: "disabled" },
      { name: "winter__computer", reason: "reserved-name" },
      { name: "winter", reason: "reserved-name" },
    ]);
  });

  test("0600, with a relative `.claude.json` link to it", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, ".winter.json"), json({ mcpServers: { a: server("a") } }));
    const { dir } = await config(bed);
    expect(statSync(join(dir, ".winter.json")).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(dir, ".claude.json")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dir, ".claude.json"))).toBe("./.winter.json");
  });

  test("no shared config at all is an empty object, still written", async () => {
    const bed = runHomeBed();
    const { file } = await config(bed);
    expect(file).toEqual({});
  });

  test("every mode gets the servers (spec §3.2)", async () => {
    for (const mode of ["code", "dispatch", "chat"] as RunMode[]) {
      const bed = runHomeBed();
      put(join(bed.sdk, ".winter.json"), json({ mcpServers: { a: server("a") } }));
      const { file } = await config(bed, { mode });
      expect([mode, file["mcpServers"]]).toEqual([mode, { a: server("a") }]);
    }
  });
});
