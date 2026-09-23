// WS-21 §3.4.5: THE RUN FOLDER'S MCP CONFIG — `<run>/<home dir name>.json` and its `.claude.json` link.
//
// The shared home's global config file (`sdk/<home dir name>.json`, the official runtime's
// `.claude.json` format) is COPIED, then:
//   1. the LOCAL-scope servers for this project (`projects[<git root ?? cwd>].mcpServers`) and, for a
//      trusted project, `<root>/<project dir>/mcp.json`'s servers are folded into the top-level
//      `mcpServers`, local over project over user — the runtime loads the local scope only with the
//      `localSettings` source, which neither child is given (F9, spec §3.4.5). The trusted project file is
//      not read when the root is `$HOME` or above it (the project walk's own stop); the local scope,
//      an entry in the shared file itself, is;
//   2. `mcp.disabled` servers and any server named like a reserved capability server (the daemon's,
//      and the brand's own standing server, which the official leg registers the messaging tools
//      under) are dropped and reported — this is the guard that used to live in the daemon;
//   3. the `projects` map is deleted, so no other project's local servers can reach this child.
//
// `strictMcpConfig` is `false` on both legs once a run home is applied (spec §3.4.5): these are the
// servers the runtime loads from its config dir, beside the router's own `Options.mcpServers`.
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RunHomeBuildContext } from "./build.ts";
import { isHomeOrAbove } from "./walk.ts";

const PRIVATE_FILE = 0o600;

const isPlainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

async function readObject(path: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The global config file's name for a brand: `<home dir name>.json` (`.claude.json`'s twin). */
export function globalConfigFileNameOf(brand: { homeDirName: string }): string {
  return `${brand.homeDirName}.json`;
}

/** Builds `<run>/<home dir name>.json` and `<run>/.claude.json` → it. */
export async function buildMcpConfig(context: RunHomeBuildContext): Promise<void> {
  const { input, brand, sdkHome, dir, report } = context;
  const fileName = globalConfigFileNameOf(brand);
  const shared = (await readObject(join(sdkHome, fileName))) ?? {};
  const config: Record<string, unknown> = { ...shared };
  delete config["projects"];

  const user = isPlainObject(shared["mcpServers"]) ? shared["mcpServers"] : {};
  let project: Record<string, unknown> = {};
  // FIX ROUND 1, M2: never `$HOME/<project dir>/mcp.json` — that is the daemon's home, not a project.
  if (input.trustedProjectRoot !== null && !isHomeOrAbove(input.trustedProjectRoot, context.userHome)) {
    const file = await readObject(join(input.trustedProjectRoot, brand.projectDirName, "mcp.json"));
    if (file !== undefined && isPlainObject(file["mcpServers"])) project = file["mcpServers"];
  }
  const projects = isPlainObject(shared["projects"]) ? shared["projects"] : {};
  // The LOCAL scope is NOT stopped at `$HOME` (controller ruling on M2): it is an entry in the shared
  // home's own config file, nothing under `$HOME/<project dir>` is read for it, and claude itself loads
  // local servers keyed at `$HOME`.
  const localEntry = projects[input.gitRoot ?? input.cwd];
  const local = isPlainObject(localEntry) && isPlainObject(localEntry["mcpServers"]) ? localEntry["mcpServers"] : {};

  const merged: Record<string, unknown> = { ...user, ...project, ...local };
  const disabled = new Set(input.mcpDisabled);
  const reserved = new Set([...input.reservedMcpServerNames, brand.mcpServerName]);
  const kept: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(merged)) {
    if (disabled.has(name)) {
      report.droppedMcpServers.push({ name, reason: "disabled" });
      continue;
    }
    if (reserved.has(name)) {
      report.droppedMcpServers.push({ name, reason: "reserved-name" });
      continue;
    }
    kept[name] = server;
  }
  if (Object.keys(kept).length > 0) config["mcpServers"] = kept;
  else delete config["mcpServers"];

  await writeFile(join(dir, fileName), `${JSON.stringify(config, null, 2)}\n`, { mode: PRIVATE_FILE, flag: "wx" });
  await symlink(`./${fileName}`, join(dir, ".claude.json"));
}
