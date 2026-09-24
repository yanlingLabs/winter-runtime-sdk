// WS-21 §10 — THE SAME-VIEW TEST: real claude (the pinned 0.3.250, scripted loopback) and the real
// Winter runtime (`WINTER_RUNTIME_EXECUTABLE`) each run on a run home built from ONE fixture home, and
// must see the same things: the init report's `skills`, `agents`, `plugins` and `mcp_servers` names
// and `output_style` (all restricted to the fixture's own `sv-` names — each runtime also ships its
// own built-ins), the skill listing's descriptions, the output style's text, the plugin's hook, and
// the instructions context of the first model request (as the ordered list of the fixture's tokens).
//
// CLAUDE IS THE REFERENCE. Every scenario first asserts claude's view against the fixture's expected
// view (so a comparison can never pass because both runtimes lost everything), then asserts the Winter
// runtime's view equals claude's, item by item.
//
// MCP (Touch 2): starting a server is not offering it. The fixture servers are real stdio MCP servers,
// and one describe holds each leg to OFFERING their `mcp__<server>__echo` tools to the model, reporting
// them `connected` on a live status request, and answering a call to each.
//
// SCENARIOS: fresh (trusted); after a store-backed claude resume; after a Winter → claude → Winter
// switch through `sdk.handoff` (each destination confirms by opening its generation on a fresh run
// home); an untrusted variant, where every project item is absent on both; and a plugin enabled only in
// settings, with no install record (claude reads a directory marketplace in place).
//
// A DIFFERENCE THE ROUTER CANNOT FIX (the Winter runtime's own reading) is kept as a `test.todo` whose
// name carries its same-view ledger id (SV-n, lane-L2 report): the assertion is the real one, not a
// weakened one, and `bun test --todo` fails the moment the SDK is fixed and the todo can be removed.
// SV-1..SV-4 were fixed in `ws21/sdk`@267ea34, SV-5 and SV-6 in `ws21/sdk`@57e7fef, SV-7 and SV-8 in
// `ws21/sdk`@20b623e; all are plain assertions now, named as regression guards.
// SV-12 (live-gate F2: claude's parallel-call DAG read along one parentUuid chain) is OPEN — its rows
// are `test.todo`.
//
// PLUGIN OUTPUT STYLES AND WORKFLOWS (round 3). The style LIST is observable on claude only
// (`initializationResult().available_output_styles`, names without descriptions); the Winter Query has
// no such surface, so the list is asserted on claude as the reference and the comparison is the ACTIVE
// style: selected in settings, both legs must report it and send its text. A plugin workflow is listed
// by claude as `<plugin>:<meta.name>` in init `skills`, `slash_commands` and the Skill listing.
//
// HERMETIC: `HOME` is an `mkdtemp` root with a decoy vendor home; the daemon home is `<HOME>/.winter`;
// the keychain is the in-memory seam (claude) and an inline loopback key (Winter), and the Winter child
// is pointed at a throwaway keychain service. Nothing reads or writes `~/.winter*`, `~/.claude*` or a
// real Keychain item. Skips (with a warning) without `WINTER_RUNTIME_EXECUTABLE` or the pinned claude.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as winterSdk from "@yanlinglabs/winter-agent-sdk";
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";
import { switchFactsFor } from "@yanlinglabs/winter-provider-runtime";

import { buildRunHome, createOfficialInputStream, createRuntimeSdk, escapeRulePath, type RunHome, type RunLeg, type RuntimeSdk, type RuntimeSdkPeers } from "../../src/index.ts";
import { createInMemoryRuntimeDirectoryStore, type RuntimeDirectoryEntry, type RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import type { HandoffStepReport } from "../../src/store/index.ts";
import { anthropicFake, createFakeKeychain, withLoopbackFake } from "../../src/testing/index.ts";
import { decoyUntouched, officialRuntimeBed, type HermeticSession } from "../official/support.ts";
import { declaredClasses } from "../messaging/support.ts";
import { ws21Selection } from "./official-bed.ts";

const WINTER_EXE = process.env["WINTER_RUNTIME_EXECUTABLE"];
const runtime = officialRuntimeBed();
if (WINTER_EXE === undefined || WINTER_EXE.length === 0) {
  // eslint-disable-next-line no-console
  console.warn("[same-view] SKIPPING the same-view test — WINTER_RUNTIME_EXECUTABLE is unset (point it at a WS-21 `winter` build)");
}
const describeBoth = WINTER_EXE === undefined || WINTER_EXE.length === 0 || runtime === undefined ? describe.skip : describe;

const TIMEOUT = 240_000;
const CREDENTIAL = { kind: "keychain", account: "loopback:same-view", service: "com.example.ws21-same-view" } as const;
/** A catalog row the Winter runtime can drive with tools (the anthropic provider, pointed at the loopback). */
const WINTER_MODEL = "anthropic/claude-sonnet-5";

/** The fixture's tokens, in the order a correct instructions context carries them (claude's order). */
const TOKENS = {
  userInstructions: "USER-INSTR-TOKEN-a1",
  projectInstructions: "PROJECT-INSTR-TOKEN-b2",
  projectRule: "PROJECT-RULE-TOKEN-d4",
  userRule: "USER-RULE-TOKEN-c3",
} as const;
/**
 * R.3, C1: what the fixture's `@imports` may bring into a generation. A trusted project's rule imports a
 * file OUTSIDE the root (and one inside it); its instructions file holds two shapes the old neutraliser
 * took for code or missed (a tab-led fence; `**x**@path`), each naming a file outside the root. Only the
 * in-root content may ever reach either leg — expanded by the router, since in the run folder the rule's
 * relative token would resolve against `<run>/rules`.
 */
const IMPORT_TOKENS = {
  ruleOutside: "RULE-OUTSIDE-SECRET-g7",
  fenceOutside: "FENCE-OUTSIDE-SECRET-h8",
  strongOutside: "STRONG-OUTSIDE-SECRET-i9",
  ruleInRoot: "RULE-INROOT-TOKEN-j0",
} as const;
const STYLE_TOKEN = "STYLE-TOKEN-e5";
const PLUGIN_STYLE_TOKEN = "PLUGIN-STYLE-TOKEN-f6";
/** claude's name for the plugin's output style (`initializationResult().available_output_styles`, measured). */
const PLUGIN_STYLE = "sv-plugin:sv-plug-style";
/**
 * claude's name for the plugin's workflow: `<plugin>:<meta.name>` — the file is `flow-file.js`, its
 * declared `meta.name` is `sv-flow` (measured: claude lists `sv-plugin:sv-flow` in init `skills`, in
 * `slash_commands` and in the Skill listing, with the meta's description).
 */
const PLUGIN_WORKFLOW = "sv-plugin:sv-flow";
/** claude's name for the USER-tier workflow `<sdk>/workflows/user-flow-file.js` (`meta.name: "sv-user-flow"`): the bare meta name (measured). */
const USER_WORKFLOW = "sv-user-flow";
/** Any listed name that could be the fixture workflow, under either naming (meta name or file name). */
const isWorkflowName = (name: string): boolean => name.includes("sv-flow") || name.includes("flow-file") || name.includes("sv-user-flow");

interface SameView {
  skills: string[];
  /** `- <name>: <description>` lines of the skill listing(s) the model was sent, for the fixture's skills. */
  skillListing: string[];
  agents: string[];
  plugins: string[];
  mcpServers: string[];
  outputStyle: unknown;
  styleText: boolean;
  /** The fixture's tokens in the first request's instructions context, in order. */
  instructions: string[];
  /** How many times the plugin's SessionStart hook ran during this generation. */
  hookRuns: number;
  /** The fixture MCP servers whose process this generation STARTED (a start marker, not the init report). */
  mcpStarted: string[];
  /** The plugin output style's text reached the model (it is the active style). */
  pluginStyleText: boolean;
  /** Where the fixture workflows are listed: `skills:`, `slash:` and `listing:` entries (each once), under whatever name. */
  workflows: string[];
  /** Fixture names listed MORE THAN ONCE in init `slash_commands`. */
  slashDuplicates: string[];
  /** R.3, C1: which of the fixture's import tokens reached the first request ANYWHERE in it (sorted). */
  imports: string[];
}

interface Run {
  messages: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
  /** Touch 3: epoch ms — when the run began, when each message arrived, when each request reached the loopback. */
  startedAt: number;
  messageTimes: number[];
  requestTimes: number[];
  stderr: string;
  hookRuns: number;
  mcpStarted: string[];
  /** claude only: `initializationResult().available_output_styles` — the Winter runtime's Query has no such surface. */
  availableOutputStyles?: string[];
}

/** `SAME_VIEW_VERBOSE=1` prints every measured view (the same aid `PLUGIN_PROBE_VERBOSE` is in the plugin suite). */
const verbose = (label: string, value: unknown): void => {
  // eslint-disable-next-line no-console
  if (process.env["SAME_VIEW_VERBOSE"] !== undefined) console.log(`[same-view] ${label}: ${JSON.stringify(value, null, 1)}`);
};

const ours = (name: string): boolean => name.startsWith("sv-") || name.includes(":sv-");

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** One scripted model turn, served to BOTH legs (SSE to the Winter runtime, a plain message to claude). */
type SameViewTurn = { text: string } | { toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> };

/**
 * F2: every `tool_use` in a request that has no `tool_result` for its id anywhere after it — the pairing a
 * Responses provider enforces ("No tool output found for function call <id>", HTTP 400).
 */
function unpairedToolUses(body: Record<string, unknown>): string[] {
  const messages = (body["messages"] ?? []) as Array<{ content?: unknown }>;
  const unpaired: string[] = [];
  messages.forEach((message, index) => {
    if (!Array.isArray(message.content)) return;
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_use") continue;
      const id = String(block["id"]);
      const answered = messages.slice(index + 1).some((later) => Array.isArray(later.content) && (later.content as Array<Record<string, unknown>>).some((b) => b["type"] === "tool_result" && b["tool_use_id"] === id));
      if (!answered) unpaired.push(id);
    }
  });
  return unpaired;
}

/** How many tool results the conversation carries — the script's cursor (the runtimes' side requests carry none). */
function toolResultsIn(body: Record<string, unknown>): number {
  let count = 0;
  for (const message of (body["messages"] ?? []) as Array<{ content?: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) if (block["type"] === "tool_result") count += 1;
  }
  return count;
}

const sessionRoots: string[] = [];

/**
 * `hermeticSession`'s shape on a REAL-PATH root. The Winter child keys its transcripts by the CANONICAL
 * cwd (on macOS `/private/var/…`, never the `/var/…` spelling `tmpdir()` returns), while the router
 * and claude key them by the cwd they are given — so a switch over a non-canonical cwd looks for the
 * transcript under a key the Winter child never wrote. A daemon hands both legs a canonical cwd; so
 * does this bed. The base is the real temp dir when its key fits the pinned runtime's 64-character
 * `CLAUDE_CODE_PROJECT_DIR_NAME` cap, else the real `/tmp`.
 */
function realPathSession(dirName = "w"): HermeticSession {
  const fits = (base: string): boolean => winterSdk.transcriptProjectKey(join(base, "w-XXXXXX", dirName)).length <= 64;
  const base = [tmpdir(), "/tmp"].filter((candidate) => existsSync(candidate)).map((candidate) => realpathSync(candidate)).find(fits);
  if (base === undefined) throw new Error("the same-view bed needs a real temp root short enough for the pinned runtime's 64-character project-key cap; set TMPDIR to a shorter path");
  const root = mkdtempSync(join(base, "w-"));
  sessionRoots.push(root);
  const home = join(root, "home");
  const brandHome = join(home, ".winter");
  const spool = join(brandHome, "runtimes", "official-agent-spool");
  const cwd = join(root, dirName);
  const decoyVendorHome = join(home, ".claude");
  for (const dir of [home, brandHome, spool, cwd, decoyVendorHome]) mkdirSync(dir, { recursive: true });
  // The same decoy `hermeticSession` plants, so `decoyUntouched` reads it the same way.
  writeFileSync(join(decoyVendorHome, "decoy.json"), '{"planted":"by the test bed"}\n');
  return { home, spool, cwd, brandHome, decoyVendorHome };
}

const cleanupSessions = (): void => {
  for (const root of sessionRoots.splice(0)) rmSync(root, { recursive: true, force: true });
};

const initOf = (run: Run): Record<string, unknown> | undefined => run.messages.find((message) => message["type"] === "system" && message["subtype"] === "init");

function viewOf(run: Run): SameView {
  const init = initOf(run) ?? {};
  // The FIRST model request that carries the instructions context (a runtime may make side requests).
  const first = run.requests.find((request) => JSON.stringify(request).includes("# claudeMd")) ?? run.requests[0] ?? {};
  const text = JSON.stringify(first);
  const start = text.indexOf("# claudeMd");
  const context = start < 0 ? "" : text.slice(start, Math.max(start, text.indexOf("# currentDate", start)));
  return {
    // The fixture's SKILLS — the plugin workflow, which claude also lists here, is its own item below.
    skills: ((init["skills"] as string[] | undefined) ?? []).filter((name) => ours(name) && !isWorkflowName(name)).sort(),
    // EVERY listing line the model was sent for a fixture skill — on a resumed generation that is the
    // listing replayed from the transcript (whichever runtime wrote it) plus the runtime's own delta.
    skillListing: [...new Set([...text.matchAll(/\\n- (sv-[\w:-]*skill): ([^"\\]*)/g)].map((match) => `- ${match[1]}: ${match[2]}`))].sort(),
    agents: ((init["agents"] as string[] | undefined) ?? []).filter(ours).sort(),
    plugins: ((init["plugins"] as Array<{ name: string }> | undefined) ?? []).map((plugin) => plugin.name).filter(ours).sort(),
    // NAMES, not status: the init report is a snapshot, and a stdio server that is still connecting on
    // one runtime ("pending") has already failed on the other ("failed") — the same server either way.
    mcpServers: ((init["mcp_servers"] as Array<{ name: string }> | undefined) ?? []).map((server) => server.name).filter(ours).sort(),
    outputStyle: init["output_style"],
    styleText: text.includes(STYLE_TOKEN),
    instructions: Object.values(TOKENS)
      .filter((token) => context.includes(token))
      .sort((a, b) => context.indexOf(a) - context.indexOf(b)),
    hookRuns: run.hookRuns,
    mcpStarted: run.mcpStarted,
    pluginStyleText: text.includes(PLUGIN_STYLE_TOKEN),
    slashDuplicates: [...new Set(((init["slash_commands"] as string[] | undefined) ?? []).filter((name, index, all) => ours(name) && all.indexOf(name) !== index))].sort(),
    imports: Object.values(IMPORT_TOKENS)
      .filter((token) => text.includes(token))
      .sort(),
    workflows: [...new Set([
      ...((init["skills"] as string[] | undefined) ?? []).filter(isWorkflowName).map((name) => `skills:${name}`),
      ...((init["slash_commands"] as string[] | undefined) ?? []).filter(isWorkflowName).map((name) => `slash:${name}`),
      ...new Set([...text.matchAll(/\\n- (sv-[\w:-]*): ([^"\\]*)/g)].filter((match) => isWorkflowName(match[1]!)).map((match) => `listing:- ${match[1]}: ${match[2]}`)),
    ])].sort(),
  };
}

interface Fixture {
  root: string;
  marker: string;
  market: string;
  /** How many times each fixture MCP server's process has started so far (by server name). */
  mcpStarts(): Record<string, number>;
}

/**
 * The fixture's MCP servers, by the name they are CONFIGURED under → the marker label. Every one is a
 * real stdio MCP server with one `echo` tool (Touch 2; it used to record its start and exit) that records
 * its own start, so "did this leg start it" is measured on the process, not read off an init report — and
 * the Touch 2 describe holds each leg to OFFERING its tool and answering a call to it. `winter` is the brand's standing-server name, which the router
 * reserves for itself: a user server under it must never start on either leg (SV-2's guard), exactly
 * like the host-reserved `sv-reserved-mcp` and the user-disabled `sv-disabled-mcp`.
 */
const MCP_SERVERS = {
  user: "sv-user-mcp",
  local: "sv-local-mcp",
  project: "sv-project-mcp",
  disabled: "sv-disabled-mcp",
  reserved: "sv-reserved-mcp",
  standingName: winterSdk.WINTER_BRAND.mcpServerName,
} as const;
const markerLabel = (name: string): string => (name === MCP_SERVERS.standingName ? "sv-standing-name-mcp" : name);

/**
 * What runs the fixture server script: `node` when it is on PATH, else this process's own `bun`.
 * MEASURED: spawned by either runtime, `bun` took 2.5–4.5 s from process start to the script's first
 * statement (the servers then started after the generation had ended); `node` took ~25 ms.
 */
const MCP_SERVER_INTERPRETER = Bun.which("node") ?? process.execPath;

/** The fixture servers' one tool, and what a call answers (Touch 2). */
const MCP_TOOL = "echo";
const MCP_ECHO_MARK = "MCP-ECHO";
/** The canonical name a leg offers the model for a fixture server's tool. */
const mcpToolName = (server: string): string => `mcp__${server}__${MCP_TOOL}`;
/** A fixture server's tool, under the canonical `mcp__<server>__<tool>` name. */
const isFixtureMcpTool = (name: string): boolean => name.startsWith("mcp__sv-");

/**
 * A minimal stdio MCP server (newline-delimited JSON-RPC): `initialize`, `tools/list` with one `echo`
 * tool, `tools/call` answering `MCP-ECHO <server>: <text>`, `ping`. argv: <start marker> <server name> [ms to wait before answering `initialize` — Touch 3].
 * Timing lines `at <event> <epoch ms>` (start, initialize-received, initialize-answered, call) go to the
 * marker file too; the start and listed counters read only their own exact lines.
 * It records its start FIRST (the SV-2 guard counts `started` lines), a `listed` line each time a client
 * reads its tool list, and exits when its client closes stdin.
 */
const MCP_FIXTURE_SERVER = `import { appendFileSync } from "node:fs";
const [marker, name, initializeDelay] = process.argv.slice(2);
appendFileSync(marker, "started\\n");
const at = (event) => appendFileSync(marker, "at " + event + " " + Date.now() + "\\n");
at("start");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (line.length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined || message.id === null) continue;
    const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      at("initialize-received");
      setTimeout(() => {
        at("initialize-answered");
        reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1.0.0" } });
      }, Number(initializeDelay ?? 0));
    }
    else if (message.method === "tools/list") {
      appendFileSync(marker, "listed\\n");
      reply({ tools: [{ name: "${MCP_TOOL}", description: "echoes its text (" + name + ")", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
    }
    else if (message.method === "tools/call") {
      at("call");
      reply({ content: [{ type: "text", text: "${MCP_ECHO_MARK} " + name + ": " + String(message.params?.arguments?.text ?? "") }] });
    }
    else if (message.method === "ping") reply({});
    else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`;

/**
 * The fixture home and project (brief L2.10): user/project/clashing skills, user/project agents plus a
 * DOUBLE-BOM agent, user/project rules, user/project instructions, an output style, a user MCP server
 * a local-scope one and a project `.winter/mcp.json` one (plus a disabled and a reserved-name one the
 * router must drop),
 * and an enabled directory-marketplace plugin with a skill and a SessionStart hook.
 */
function plantFixture(session: HermeticSession, options: { installRecord: boolean; outputStyle?: string; userPermissions?: (root: string) => Record<string, string[]> }): Fixture {
  const sdkHome = join(session.brandHome, "sdk");
  const root = session.cwd;
  const mcpMarkers = join(session.home, "markers", "mcp");
  mkdirSync(mcpMarkers, { recursive: true });
  // Touch 2: every fixture server is a REAL stdio MCP server (one `echo` tool), so a leg can be held to
  // OFFERING its tools, not only to starting it. It still records its own start first.
  const serverScript = join(session.home, "markers", "mcp-server.mjs");
  put(serverScript, MCP_FIXTURE_SERVER);
  const server = (name: string): Record<string, unknown> => ({ type: "stdio", command: MCP_SERVER_INTERPRETER, args: [serverScript, join(mcpMarkers, markerLabel(name)), name] });
  put(join(sdkHome, "WINTER.md"), `${TOKENS.userInstructions}\n`);
  put(join(sdkHome, "rules", "user-rule.md"), `${TOKENS.userRule}\n`);
  put(join(root, ".winter", "rules", "project-rule.md"), `${TOKENS.projectRule}\n`);
  // R.3, C1: files OUTSIDE the project root (under the hermetic HOME) and one inside it, named by imports.
  const outside = join(session.home, "outside");
  put(join(outside, "rule-secret.md"), `${IMPORT_TOKENS.ruleOutside}\n`);
  put(join(outside, "fence-secret.md"), `${IMPORT_TOKENS.fenceOutside}\n`);
  put(join(outside, "strong-secret.md"), `${IMPORT_TOKENS.strongOutside}\n`);
  put(join(root, "docs", "rule-inroot.md"), `${IMPORT_TOKENS.ruleInRoot}\n`);
  put(join(root, ".winter", "rules", "import-rule.md"), `import rule: @${join(outside, "rule-secret.md")} and @../../docs/rule-inroot.md\n`);
  // The tab-led "fence" is NOT one (an indented line), so it gets no closing line: a closing "```" would
  // OPEN a real fence and swallow what follows (measured with marked).
  put(join(root, "WINTER.md"), `${TOKENS.projectInstructions}\n\n**x**@${join(outside, "strong-secret.md")}\n\n\t\`\`\`\n@${join(outside, "fence-secret.md")}\n`);
  const skill = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
  put(join(sdkHome, "skills", "sv-user-skill", "SKILL.md"), skill("sv-user-skill", "the user skill"));
  put(join(root, ".winter", "skills", "sv-project-skill", "SKILL.md"), skill("sv-project-skill", "the project skill"));
  put(join(sdkHome, "skills", "sv-clash-skill", "SKILL.md"), skill("sv-clash-skill", "the USER clash"));
  put(join(root, ".winter", "skills", "sv-clash-skill", "SKILL.md"), skill("sv-clash-skill", "the PROJECT clash"));
  put(join(sdkHome, "agents", "sv-user-agent.md"), "---\nname: sv-user-agent\ndescription: the user agent\n---\nYou are the user agent.\n");
  put(join(root, ".winter", "agents", "sv-project-agent.md"), "---\nname: sv-project-agent\ndescription: the project agent\n---\nYou are the project agent.\n");
  // TWO leading BOMs: claude strips ONE, so its frontmatter split does not match and it reads NO keys —
  // the agent has no name and is not listed. The Winter runtime must read exactly that too (never, say,
  // strip both and honour the `permissionMode`/`memory` the router did not rewrite).
  const bom = String.fromCharCode(0xfeff);
  put(join(root, ".winter", "agents", "sv-bom-agent.md"), `${bom}${bom}---\nname: sv-bom-agent\ndescription: the double-BOM agent\npermissionMode: acceptEdits\nmemory: project\n---\nYou are the double-BOM agent.\n`);
  put(join(sdkHome, "output-styles", "sv-style.md"), `---\nname: sv-style\ndescription: the fixture style\n---\n${STYLE_TOKEN}\n`);
  const market = join(session.home, "markets", "sv");
  put(join(market, ".claude-plugin", "marketplace.json"), `${JSON.stringify({ name: "sv", owner: { name: "user" }, plugins: [{ name: "sv-plugin", source: "./sv-plugin", description: "the fixture plugin" }] })}\n`);
  put(join(market, "sv-plugin", ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "sv-plugin", version: "1.0.0" })}\n`);
  put(join(market, "sv-plugin", "skills", "sv-plug-skill", "SKILL.md"), skill("sv-plug-skill", "the plugin skill"));
  // A plugin OUTPUT STYLE, and a plugin WORKFLOW whose declared `meta.name` differs from its file name.
  put(join(market, "sv-plugin", "output-styles", "sv-plug-style.md"), `---\nname: sv-plug-style\ndescription: the plugin style\n---\n${PLUGIN_STYLE_TOKEN}\n`);
  put(join(market, "sv-plugin", "workflows", "flow-file.js"), 'export const meta = { name: "sv-flow", description: "the fixture workflow" };\n');
  // A USER-TIER workflow (the shared home's own `workflows/`), whose declared name also differs from its file.
  put(join(sdkHome, "workflows", "user-flow-file.js"), 'export const meta = { name: "sv-user-flow", description: "the user workflow" };\n');
  const marker = join(session.home, "markers", "sv-plugin-session-start");
  mkdirSync(dirname(marker), { recursive: true });
  // claude's own plugin hooks file shape: `{ "hooks": { <Event>: [...] } }`.
  put(join(market, "sv-plugin", "hooks", "hooks.json"), `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `echo ran >> '${marker}'` }] }] } })}\n`);
  put(join(sdkHome, "settings.json"), `${JSON.stringify({ ...(options.userPermissions === undefined ? {} : { permissions: options.userPermissions(root) }), outputStyle: options.outputStyle ?? "sv-style", extraKnownMarketplaces: { sv: { source: { source: "directory", path: market } } }, enabledPlugins: { "sv-plugin@sv": true } })}\n`);
  if (options.installRecord) {
    // What `winter plugin marketplace add` + `winter plugin install sv-plugin@sv` write for a directory
    // marketplace, under the shared plugin root: the marketplace record, and an install record whose
    // path IS the marketplace's own directory (read in place). Without the marketplace record claude's
    // FIRST session in a home only registers the marketplace and loads the plugin's components from
    // the next one (measured) — a claude first-run behaviour, not a run-home question.
    put(join(sdkHome, "plugins", "known_marketplaces.json"), `${JSON.stringify({ sv: { source: { source: "directory", path: market }, installLocation: market, lastUpdated: new Date(0).toISOString(), autoUpdate: false } })}\n`);
    put(join(sdkHome, "plugins", "installed_plugins.json"), `${JSON.stringify({ version: 2, plugins: { "sv-plugin@sv": [{ scope: "user", installPath: join(market, "sv-plugin"), version: "1.0.0", installedAt: new Date(0).toISOString() }] } })}\n`);
  }
  put(
    join(sdkHome, ".winter.json"),
    `${JSON.stringify({
      mcpServers: { [MCP_SERVERS.user]: server(MCP_SERVERS.user), [MCP_SERVERS.disabled]: server(MCP_SERVERS.disabled), [MCP_SERVERS.reserved]: server(MCP_SERVERS.reserved), [MCP_SERVERS.standingName]: server(MCP_SERVERS.standingName) },
      // The LOCAL scope for this checkout (`winter mcp add --scope local`), keyed by the project root.
      projects: { [root]: { mcpServers: { [MCP_SERVERS.local]: server(MCP_SERVERS.local) } } },
    })}\n`,
  );
  put(join(root, ".winter", "mcp.json"), `${JSON.stringify({ mcpServers: { [MCP_SERVERS.project]: server(MCP_SERVERS.project) } })}\n`);
  const mcpStarts = (): Record<string, number> =>
    Object.fromEntries(
      Object.values(MCP_SERVERS).map((name) => {
        const path = join(mcpMarkers, markerLabel(name));
        return [name, existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line === "started").length : 0];
      }),
    );
  return { root, marker, market, mcpStarts };
}

/** The view claude must show for the fixture (and the Winter runtime must equal). */
function expectedView(trusted: boolean): Omit<SameView, "hookRuns" | "outputStyle" | "styleText" | "pluginStyleText" | "slashDuplicates"> {
  return {
    skills: trusted ? ["sv-clash-skill", "sv-plugin:sv-plug-skill", "sv-project-skill", "sv-user-skill"] : ["sv-clash-skill", "sv-plugin:sv-plug-skill", "sv-user-skill"],
    skillListing: trusted
      ? ["- sv-clash-skill: the USER clash", "- sv-plugin:sv-plug-skill: the plugin skill", "- sv-project-skill: the project skill", "- sv-user-skill: the user skill"]
      : ["- sv-clash-skill: the USER clash", "- sv-plugin:sv-plug-skill: the plugin skill", "- sv-user-skill: the user skill"],
    agents: trusted ? ["sv-project-agent", "sv-user-agent"] : ["sv-user-agent"],
    plugins: ["sv-plugin"],
    // The local scope is not trust-gated (it is the user's own entry in the shared file).
    mcpServers: trusted ? ["sv-local-mcp", "sv-project-mcp", "sv-user-mcp"] : ["sv-local-mcp", "sv-user-mcp"],
    mcpStarted: trusted ? ["sv-local-mcp", "sv-project-mcp", "sv-user-mcp"] : ["sv-local-mcp", "sv-user-mcp"],
    workflows: [
      `listing:- ${PLUGIN_WORKFLOW}: the fixture workflow`,
      `listing:- ${USER_WORKFLOW}: the user workflow`,
      `skills:${PLUGIN_WORKFLOW}`,
      `skills:${USER_WORKFLOW}`,
      `slash:${PLUGIN_WORKFLOW}`,
      `slash:${USER_WORKFLOW}`,
    ],
    instructions: trusted ? [TOKENS.userInstructions, TOKENS.projectInstructions, TOKENS.projectRule, TOKENS.userRule] : [TOKENS.userInstructions, TOKENS.userRule],
    // R.3, C1: only the IN-ROOT import, expanded by the router; nothing from outside the root, on any shape.
    imports: trusted ? [IMPORT_TOKENS.ruleInRoot] : [],
  };
}

type CanUseToolLike = (toolName: string, input: Record<string, unknown>, options?: { decisionReason?: string; blockedPath?: string }) => Promise<Record<string, unknown>>;

interface SameViewBed {
  session: HermeticSession;
  fixture: Fixture;
  sdk: RuntimeSdk;
  directory: RuntimeDirectoryStore;
  projectKey: string;
  build(leg: RunLeg): Promise<RunHome>;
  runWinter(runHome: RunHome, over?: { prompt?: string; resume?: string; permissionMode?: string; canUseTool?: CanUseToolLike; probeMcp?: boolean }): Promise<Run>;
  runClaude(runHome: RunHome, winterSessionId: string, over?: { prompt?: string; sessionId?: string; canUseTool?: CanUseToolLike; permissionMode?: string; model?: string; effort?: string }): Promise<Run>;
  /** Set by a test that drives `sdk.handoff`: what each confirming destination opens. */
  destinations: Map<string, (runKind: "claude-agent" | "winter-agent") => Promise<HandoffStepReport>>;
  /**
   * Touch 2: awaited before the loopback answers a MAIN model request (one offering tools), with the
   * number of tool results the conversation carries — so a test can gate a turn on a live condition.
   */
  hooks: { onTurn?: (index: number) => Promise<void> };
  /**
   * Touch 2: the LIVE generation's MCP status, while it runs — the Winter leg through an `mcp_status`
   * control_request on its own stdio (`runWinter(…, { probeMcp: true })`), claude through its
   * `mcpServerStatus()`. Cleared when the run ends.
   */
  live: { mcpStatus?: () => Promise<Array<{ name: string; status: string }>> };
  /** F2: the model requests the loopback has recorded since the current run began — readable when a run THREW (a provider 400 ends the Winter query with an error). */
  requestsSoFar(): Array<Record<string, unknown>>;
}

/**
 * Touch 2: a Winter-leg spawn that ALSO lets the test ask the live runtime for its MCP status — an
 * `mcp_status` control_request (top-level `subtype: "mcp_status"`, the runtime's own handler) written on
 * the child's stdin, its `control_response` taken out of stdout before the SDK sees it (the SDK has no
 * such request of its own, so an answer to one would be a stranger to it). Everything else passes through.
 */
function mcpStatusProbingSpawn(live: SameViewBed["live"]): (opts: Parameters<typeof winterSdk.defaultSpawn>[0]) => ReturnType<typeof winterSdk.defaultSpawn> {
  return (opts) => {
    const proc = winterSdk.defaultSpawn(opts);
    const waiting = new Map<string, (servers: Array<{ name: string; status: string }>) => void>();
    let counter = 0;
    live.mcpStatus = () =>
      new Promise((resolve) => {
        const requestId = `sv-mcp-status-${(counter += 1)}`;
        waiting.set(requestId, resolve);
        proc.stdin.write(`${JSON.stringify({ type: "control_request", requestId, subtype: "mcp_status", payload: null })}\n`);
      });
    const stdout = (async function* (): AsyncGenerator<string> {
      let carry = "";
      for await (const chunk of proc.stdout) {
        carry += chunk;
        const lines = carry.split("\n");
        carry = lines.pop() ?? "";
        const passed: string[] = [];
        for (const line of lines) {
          let frame: { type?: unknown; requestId?: unknown; payload?: { servers?: Array<{ name: string; status: string }> } } | undefined;
          try {
            frame = JSON.parse(line) as typeof frame;
          } catch {
            frame = undefined;
          }
          const answer = frame?.type === "control_response" && typeof frame.requestId === "string" ? waiting.get(frame.requestId) : undefined;
          if (answer !== undefined && frame !== undefined) {
            waiting.delete(frame.requestId as string);
            answer((frame.payload?.servers ?? []).map(({ name, status }) => ({ name, status })));
            continue;
          }
          passed.push(`${line}\n`);
        }
        if (passed.length > 0) yield passed.join("");
      }
      if (carry.length > 0) yield carry;
    })();
    return { stdin: proc.stdin, stdout, ...(proc.stderr === undefined ? {} : { stderr: proc.stderr }), kill: (signal?: string) => proc.kill(signal), exited: proc.exited, get pid() { return proc.pid; } };
  };
}

async function withSameViewBed<T>(
  options: {
    trusted: boolean;
    installRecord?: boolean;
    outputStyle?: string;
    dirName?: string;
    turns?: (root: string) => readonly SameViewTurn[];
    userPermissions?: (root: string) => Record<string, string[]>;
    /** F2: answer a request that carries a `tool_use` without its `tool_result` with the provider's HTTP 400, as a Responses provider does. */
    rejectUnpairedToolUse?: boolean;
  },
  fn: (bed: SameViewBed) => Promise<T>,
): Promise<T> {
  /* c8 ignore next */
  if (runtime === undefined || WINTER_EXE === undefined) throw new Error("unreachable: the same-view suite is skipped without both runtimes");
  const session = realPathSession(options.dirName);
  const turns: readonly SameViewTurn[] = options.turns?.(session.cwd) ?? [{ text: "ok" }];
  const fixture = plantFixture(session, {
    installRecord: options.installRecord ?? true,
    ...(options.outputStyle === undefined ? {} : { outputStyle: options.outputStyle }),
    ...(options.userPermissions === undefined ? {} : { userPermissions: options.userPermissions }),
  });
  const home = session.brandHome;
  const sdkHome = join(home, "sdk");
  const projectKey = winterSdk.transcriptProjectKey(fixture.root);
  const fakes = await anthropicFake();
  const requests: Array<Record<string, unknown>> = [];
  const requestTimes: number[] = [];
  const hooks: SameViewBed["hooks"] = {};
  const live: SameViewBed["live"] = {};
  return withLoopbackFake(
    {
      routes: [
        {
          path: "*",
          // THE BODY COMES FROM `recorded` (the base already consumed the stream; see `scriptedLoopback`).
          handler: async (_req: Request, recorded: { method: string; path: string; body: string }) => {
            if (recorded.method === "POST" && recorded.path === "/v1/messages") {
              let body: Record<string, unknown> = {};
              try {
                body = JSON.parse(recorded.body) as Record<string, unknown>;
              } catch {
                /* a shape this bed did not anticipate: recorded as empty, still answered */
              }
              requests.push(body);
              requestTimes.push(Date.now());
              const unpaired = options.rejectUnpairedToolUse === true ? unpairedToolUses(body) : [];
              if (unpaired.length > 0) {
                return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No tool output found for function call ${unpaired[0]}.` } }), {
                  status: 400,
                  headers: { "content-type": "application/json" },
                });
              }
              // A subagent's own requests (its prompt carries this marker) get a plain answer, so a script
              // indexed by the parent's tool results is never replayed inside the subagent.
              const isSubagent = JSON.stringify(body["messages"] ?? []).includes("SUBAGENT-PROMPT-7f");
              if (!isSubagent && Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0) await hooks.onTurn?.(toolResultsIn(body));
              const turn = isSubagent ? { text: "sub done" } : (turns[Math.min(toolResultsIn(body), turns.length - 1)] ?? { text: "ok" });
              const usage = { input_tokens: 10, output_tokens: 2 };
              // The Winter runtime streams (SSE); the pinned claude accepts a plain message body.
              if (body["stream"] === true) {
                return fakes.anthropicTurnResponse(
                  "text" in turn
                    ? { blocks: [{ type: "text", chunks: [turn.text] }], stopReason: "end_turn", usage }
                    : { blocks: turn.toolUses.map((use) => ({ type: "tool_use" as const, id: use.id, name: use.name, jsonChunks: [JSON.stringify(use.input)] })), stopReason: "tool_use", usage },
                );
              }
              const content = "text" in turn ? [{ type: "text", text: turn.text }] : turn.toolUses.map((use) => ({ type: "tool_use", id: use.id, name: use.name, input: use.input }));
              return new Response(JSON.stringify({ id: "msg_same_view", type: "message", role: "assistant", model: "claude-sonnet-4-5-20250929", content, stop_reason: "text" in turn ? "end_turn" : "tool_use", stop_sequence: null, usage }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          },
        },
      ],
    },
    async (fake) => {
      const baseUrl = fake.url.replace(/\/$/, "");
      const declared = declaredClasses();
      const directory = createInMemoryRuntimeDirectoryStore();
      const destinations = new Map<string, (runKind: "claude-agent" | "winter-agent") => Promise<HandoffStepReport>>();
      const sdk = createRuntimeSdk({
        peers: {
          winter: {
            ...winterSdk,
            resolveWinterHome: () => {
              throw new Error("a hermetic test must never resolve the real Winter home");
            },
          } as unknown as RuntimeSdkPeers["winter"],
          claude: runtime.module,
        },
        keychain: createFakeKeychain([{ ref: CREDENTIAL, material: "sk-ant-loopback" }]),
        directoryStore: directory,
        vendoredOfficialRuntime: runtime.executable,
        toInputShape: runtime.toInputShape,
        requireRunHome: true,
        handoff: {
          winterHome: home,
          participants: {
            // The generations below are drained before any handoff: there is no live owner to drain.
            source: () => undefined,
            destination: (_session, to) => {
              const open = destinations.get(to);
              return open === undefined ? undefined : { runtimeKind: to, confirmInit: () => open(to as "claude-agent" | "winter-agent") };
            },
          },
        },
        messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass }, official: { permissionClass: declared.official.permissionClass } } },
      });
      /**
       * The servers this generation started. A stdio server is spawned asynchronously (the Winter
       * runtime reports it `pending` at init), so the snapshot waits until the always-expected user
       * server has recorded its start — proof this leg's spawns have happened — then a little longer.
       */
      const startedSince = async (before: Record<string, number>): Promise<string[]> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && fixture.mcpStarts()[MCP_SERVERS.user]! <= before[MCP_SERVERS.user]!) await Bun.sleep(50);
        await Bun.sleep(400);
        const after = fixture.mcpStarts();
        return Object.keys(after)
          .filter((name) => after[name]! > before[name]!)
          .sort();
      };
      const hookRuns = (): number => (existsSync(fixture.marker) ? readFileSync(fixture.marker, "utf8").split("\n").filter((line) => line === "ran").length : 0);
      const drain = async (query: unknown, times: number[]): Promise<Array<Record<string, unknown>>> => {
        const out: Array<Record<string, unknown>> = [];
        for await (const message of query as AsyncIterable<Record<string, unknown>>) {
          out.push(message);
          times.push(Date.now());
        }
        return out;
      };
      const allow = async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input });
      const childEnv = { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
      const bed: SameViewBed = {
        session,
        fixture,
        sdk,
        directory,
        projectKey,
        destinations,
        hooks,
        live,
        requestsSoFar: () => [...requests],
        build: (leg) =>
          buildRunHome({
            home,
            mode: "code",
            dispatchChild: false,
            leg,
            cwd: fixture.root,
            trustedProjectRoot: options.trusted ? fixture.root : null,
            gitRoot: options.trusted ? fixture.root : null,
            mcpDisabled: ["sv-disabled-mcp"],
            reservedMcpServerNames: ["sv-reserved-mcp"],
            memoryDir: join(sdkHome, "projects", projectKey, "memory"),
          }),
        async runWinter(runHome, over = {}) {
          requests.length = 0;
          requestTimes.length = 0;
          const startedAt = Date.now();
          const messageTimes: number[] = [];
          const before = hookRuns();
          const startsBefore = fixture.mcpStarts();
          const stderr: string[] = [];
          const messages = await drain(
            sdk.query({
              prompt: over.prompt ?? "hello",
              options: {
                cwd: fixture.root,
                model: WINTER_MODEL,
                provider: { providerId: "anthropic", authRef: { kind: "inline", value: "sk-ant-loopback" }, connection: { baseUrl, local: true } },
                pathToClaudeCodeExecutable: WINTER_EXE,
                keychainService: "com.example.ws21-same-view",
                env: childEnv,
                stderr: (chunk: string) => stderr.push(chunk),
                canUseTool: over.canUseTool ?? allow,
                ...(over.permissionMode === undefined ? {} : { permissionMode: over.permissionMode }),
                ...(over.resume === undefined ? {} : { resume: over.resume }),
                ...(over.probeMcp === true ? { spawnClaudeCodeProcess: mcpStatusProbingSpawn(live) } : {}),
                runtime: { runHome },
              } as never,
            }),
            messageTimes,
          );
          delete live.mcpStatus;
          return { messages, requests: [...requests], startedAt, messageTimes, requestTimes: [...requestTimes], stderr: stderr.join(""), hookRuns: hookRuns() - before, mcpStarted: await startedSince(startsBefore) };
          // (the Winter runtime's Query offers no `initializationResult`, so no style list is read here)
        },
        async runClaude(runHome, winterSessionId, over = {}) {
          requests.length = 0;
          requestTimes.length = 0;
          const startedAt = Date.now();
          const messageTimes: number[] = [];
          const before = hookRuns();
          const startsBefore = fixture.mcpStarts();
          // A PERMISSION MODE IS SET LIVE (the pin's own control request) on a streamed prompt: the
          // launch path does not forward `Options.permissionMode` (a pre-existing gap, reported).
          const stream = over.permissionMode === undefined ? undefined : createOfficialInputStream();
          const handle = sdk.query({
            prompt: stream ?? over.prompt ?? "hello",
            options: {
              cwd: fixture.root,
              canUseTool: over.canUseTool ?? allow,
              ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
              ...(over.model === undefined ? {} : { model: over.model }),
              ...(over.effort === undefined ? {} : { effort: over.effort }),
              runtime: {
                runHome,
                selection: ws21Selection,
                official: { sessionId: winterSessionId, credentials: [{ variable: "ANTHROPIC_API_KEY", ref: CREDENTIAL }], connectionEnv: { ANTHROPIC_BASE_URL: baseUrl }, base: childEnv },
              },
            } as never,
          }) as unknown as AsyncIterable<unknown> & { initializationResult?: () => Promise<Record<string, unknown>>; setPermissionMode?: (mode: string) => Promise<void>; mcpServerStatus?: () => Promise<Array<{ name: string; status: string }>> };
          live.mcpStatus = async () => ((await handle.mcpServerStatus?.()) ?? []).map(({ name, status }) => ({ name, status }));
          if (stream !== undefined) await handle.setPermissionMode?.(over.permissionMode as string);
          const draining = (async () => {
            const out: Array<Record<string, unknown>> = [];
            for await (const message of handle as AsyncIterable<Record<string, unknown>>) {
              out.push(message);
              messageTimes.push(Date.now());
              if (stream !== undefined && message["type"] === "result") stream.close();
            }
            return out;
          })();
          if (stream !== undefined) await stream.push(over.prompt ?? "hello");
          // THE STYLE LIST: claude answers it on its initialize response (`available_output_styles`).
          const initialization = typeof handle.initializationResult === "function" ? await handle.initializationResult().catch(() => undefined) : undefined;
          const messages = await draining;
          delete live.mcpStatus;
          const availableOutputStyles = initialization?.["available_output_styles"];
          return {
            messages,
            requests: [...requests],
            startedAt,
            messageTimes,
            requestTimes: [...requestTimes],
            stderr: "",
            hookRuns: hookRuns() - before,
            mcpStarted: await startedSince(startsBefore),
            ...(Array.isArray(availableOutputStyles) ? { availableOutputStyles: (availableOutputStyles as string[]).slice().sort() } : {}),
          };
        },
      };
      return fn(bed);
    },
  );
}

/** The per-item assertions, shared by every scenario. */
const ITEMS = ["skills", "skillListing", "agents", "plugins", "mcpServers", "mcpStarted", "outputStyle", "styleText", "pluginStyleText", "instructions", "hookRuns", "workflows", "slashDuplicates", "imports"] as const;
type Item = (typeof ITEMS)[number];

/**
 * SV-n: the differences the first measurement found in the Winter runtime's own reading (lane-L2
 * report, "L2.10 same-view"), fixed in the SDK (`ws21/sdk`@267ea34) and kept here as named regression
 * guards. SV-1 needs a trusted project's rule to lose, so it names only the trusted comparisons.
 */
const GUARDS: Partial<Record<Item, { id: string; trustedOnly?: boolean }>> = {
  instructions: { id: "SV-1 guard: rules are read from the run folder, so the trusted project's rules are there", trustedOnly: true },
  mcpServers: { id: "SV-2 guard: the global config is the run folder's, folded and filtered by the router" },
  mcpStarted: { id: "SV-2 guard" },
  hookRuns: { id: "SV-3 guard: claude's `hooks/hooks.json` `{ hooks: … }` document is unwrapped" },
  workflows: { id: "SV-5 guard: a workflow is listed under `meta.name` in init `skills`, `slash_commands` and the Skill listing" },
  slashDuplicates: { id: "SV-9 guard: every workflow is listed ONCE in init `slash_commands` (a regression at ws21/sdk@20b623e, fixed by 6170adb)" },
};

/**
 * SV-n STILL OPEN: a measured difference in the Winter runtime's own reading, kept as a `test.todo`
 * (the real assertion; `bun test --todo` fails it the moment the SDK is fixed).
 */
const LEDGER: Partial<Record<Item, string>> = {};

function itemTests(label: string, trusted: boolean, views: () => { claude: SameView; winter: SameView }): void {
  for (const item of ITEMS) {
    const entry = GUARDS[item];
    const guard = entry === undefined || (entry.trustedOnly === true && !trusted) ? "" : ` (${entry.id})`;
    const ledger = LEDGER[item];
    const body = (): void => {
      const { claude, winter } = views();
      expect(winter[item]).toEqual(claude[item]);
    };
    if (ledger === undefined) test(`${label}: the Winter runtime's ${item} equal claude's${guard}`, body);
    else test.todo(`${label}: the Winter runtime's ${item} equal claude's — ${ledger}`, body);
  }
}

function claudeReferenceTests(label: string, trusted: boolean, view: () => SameView): void {
  test(`${label}: claude (the reference) shows exactly the fixture's view`, () => {
    const claude = view();
    const expected = expectedView(trusted);
    expect({ skills: claude.skills, skillListing: claude.skillListing, agents: claude.agents, plugins: claude.plugins, mcpServers: claude.mcpServers, mcpStarted: claude.mcpStarted, workflows: claude.workflows, instructions: claude.instructions, imports: claude.imports }).toEqual(expected);
    expect(claude.outputStyle).toBe("sv-style");
    expect(claude.styleText).toBe(true);
    expect(claude.pluginStyleText).toBe(false);
    expect(claude.slashDuplicates).toEqual([]);
    expect(claude.hookRuns).toBe(1);
    // The double-BOM agent: claude reads no keys from it, so it has no name and is not listed.
    expect(claude.agents).not.toContain("sv-bom-agent");
  });
}

/**
 * SV-2'S REGRESSION GUARD: over a whole scenario (every generation on both legs), the server the user
 * disabled, the host-reserved server and a user server under the standing server's own name NEVER
 * start — while the user server (the control) does, on every leg.
 */
function forbiddenServerTests(label: string, measured: () => { starts: Record<string, number>; perRun: Array<{ leg: string; started: string[] }> }): void {
  test(`${label}: a disabled server, a host-reserved one and one named like the standing server never start on either leg (SV-2 guard)`, () => {
    const { starts, perRun } = measured();
    expect(perRun.length).toBeGreaterThan(0);
    for (const run of perRun) expect([run.leg, run.started.includes(MCP_SERVERS.user)]).toEqual([run.leg, true]);
    expect({ disabled: starts[MCP_SERVERS.disabled], reserved: starts[MCP_SERVERS.reserved], standingName: starts[MCP_SERVERS.standingName] }).toEqual({ disabled: 0, reserved: 0, standingName: 0 });
  });
}

describeBoth("WS-21 same view: claude and the Winter runtime read one run home the same way", () => {
  afterAll(cleanupSessions);

  describe("fresh, trusted project", () => {
    let claude: SameView;
    let winter: SameView;
    let winterStderr = "";
    let starts: Record<string, number> = {};
    beforeAll(async () => {
      await withSameViewBed({ trusted: true }, async (bed) => {
        const w = await bed.runWinter(await bed.build("winter"));
        winterStderr = w.stderr;
        winter = viewOf(w);
        const claudeRun = await bed.runClaude(await bed.build("official"), "s_sv_fresh");
        claude = viewOf(claudeRun);
        starts = bed.fixture.mcpStarts();
        verbose("fresh", { claude, winter, starts, claudeStyles: claudeRun.availableOutputStyles, claudeSkills: initOf(claudeRun)?.["skills"], claudeSlash: ((initOf(claudeRun)?.["slash_commands"] as string[]) ?? []).filter(ours) });
        expect(decoyUntouched(bed.session)).toBe(true);
      });
    }, TIMEOUT);
    claudeReferenceTests("fresh", true, () => claude);
    itemTests("fresh", true, () => ({ claude, winter }));
    forbiddenServerTests("fresh", () => ({ starts, perRun: [{ leg: "winter", started: winter.mcpStarted }, { leg: "claude", started: claude.mcpStarted }] }));
    test("fresh: the USER-tier workflow is listed identically on both legs, under its meta.name (never its file name)", () => {
      const user = (view: SameView): string[] => view.workflows.filter((entry) => entry.includes(USER_WORKFLOW) || entry.includes("user-flow-file"));
      expect(user(claude)).toEqual([`listing:- ${USER_WORKFLOW}: the user workflow`, `skills:${USER_WORKFLOW}`, `slash:${USER_WORKFLOW}`]);
      expect(user(winter)).toEqual(user(claude));
    });
    test("fresh: the local-scope and the project-scope servers reach both legs identically — listed and started", () => {
      for (const view of [claude, winter]) {
        expect(view.mcpServers).toEqual(expect.arrayContaining([MCP_SERVERS.local, MCP_SERVERS.project]));
        expect(view.mcpStarted).toEqual(expect.arrayContaining([MCP_SERVERS.local, MCP_SERVERS.project]));
      }
      expect({ listed: winter.mcpServers, started: winter.mcpStarted }).toEqual({ listed: claude.mcpServers, started: claude.mcpStarted });
    });
    test("fresh: the double-BOM agent is read the same way — no keys, no agent — on both", () => {
      expect(claude.agents).not.toContain("sv-bom-agent");
      expect(winter.agents).not.toContain("sv-bom-agent");
      // The Winter runtime says so, and names the run folder's copy (never the repository's file).
      expect(winterStderr).toContain("sv-bom-agent.md");
    });
  });

  describe("after a store-backed claude resume", () => {
    let claude: SameView;
    let winter: SameView;
    let resumedPrompt = false;
    let starts: Record<string, number> = {};
    const perRun: Array<{ leg: string; started: string[] }> = [];
    beforeAll(async () => {
      await withSameViewBed({ trusted: true }, async (bed) => {
        winter = viewOf(await bed.runWinter(await bed.build("winter")));
        perRun.push({ leg: "winter", started: winter.mcpStarted });
        const first = await bed.runClaude(await bed.build("official"), "s_sv_resume", { prompt: "RESUME-FIRST-PROMPT-71c" });
        const backend = String(initOf(first)?.["session_id"]);
        const resumed = await bed.runClaude(await bed.build("official"), "s_sv_resume", { prompt: "RESUME-SECOND-PROMPT-2de", sessionId: backend });
        resumedPrompt = JSON.stringify(resumed.requests).includes("RESUME-FIRST-PROMPT-71c");
        claude = viewOf(resumed);
        perRun.push({ leg: "claude (first)", started: first.mcpStarted }, { leg: "claude (resumed)", started: claude.mcpStarted });
        starts = bed.fixture.mcpStarts();
        verbose("resume", { claude, winter, starts });
      });
    }, TIMEOUT);
    test("resume: the claude generation really resumed the first one (its transcript reached the model)", () => {
      expect(resumedPrompt).toBe(true);
    });
    claudeReferenceTests("resume", true, () => claude);
    itemTests("resume", true, () => ({ claude, winter }));
    forbiddenServerTests("resume", () => ({ starts, perRun }));
  });

  describe("after a Winter → claude → Winter switch (sdk.handoff)", () => {
    let claude: SameView | undefined;
    let winterBefore: SameView;
    let winterAfter: SameView | undefined;
    const outcomes: string[] = [];
    const reached: string[] = [];
    let starts: Record<string, number> = {};
    beforeAll(async () => {
      await withSameViewBed({ trusted: true }, async (bed) => {
        const first = await bed.runWinter(await bed.build("winter"), { prompt: "SWITCH-FIRST-PROMPT-5b8" });
        winterBefore = viewOf(first);
        const backend = String(initOf(first)?.["session_id"]);
        const winterSessionId = "s_sv_switch";
        const selection: RuntimeSelection = { ...ws21Selection, runtimeKind: "winter-agent", providerId: "anthropic", modelRef: WINTER_MODEL, authFamily: "api-key" };
        const entry = {
          address: `session:${winterSessionId}`,
          parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId, backendSessionId: backend },
          runtimeKind: "winter-agent",
          objectKind: "session",
          transport: "winter-session",
          status: "idle",
          mode: "code",
          generation: 1,
          selection,
          backendSessionId: backend,
          capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
          cwd: bed.fixture.root,
          updatedAt: new Date().toISOString(),
        } as unknown as RuntimeDirectoryEntry;
        await bed.directory.upsert(entry);
        const key: SessionKey = { projectKey: bed.projectKey, sessionId: backend };
        // Each destination CONFIRMS by opening its generation on a fresh run home, on the transcript. As
        // the daemon's own `confirmInit` does, it first moves the session's row to the destination leg
        // (the door refuses a claude generation on a row that still names the Winter runtime — D13).
        const moveRow = async (runtimeKind: "claude-agent" | "winter-agent"): Promise<void> => {
          const current = (await bed.directory.load()).find((row) => row.address === entry.address);
          await bed.directory.upsert({ ...(current ?? entry), runtimeKind, parsed: { ...(current ?? entry).parsed, runtimeKind }, updatedAt: new Date().toISOString() } as RuntimeDirectoryEntry);
        };
        bed.destinations.set("claude-agent", async () => {
          await moveRow("claude-agent");
          const run = await bed.runClaude(await bed.build("official"), winterSessionId, { prompt: "SWITCH-SECOND-PROMPT-c41", sessionId: backend });
          reached.push(`claude:${JSON.stringify(run.requests).includes("SWITCH-FIRST-PROMPT-5b8")}`);
          claude = viewOf(run);
          return initOf(run) === undefined ? { ok: false, reason: "no init from the resumed claude generation" } : { ok: true };
        });
        bed.destinations.set("winter-agent", async () => {
          await moveRow("winter-agent");
          const run = await bed.runWinter(await bed.build("winter"), { prompt: "SWITCH-THIRD-PROMPT-9e0", resume: backend });
          reached.push(`winter:${JSON.stringify(run.requests).includes("SWITCH-FIRST-PROMPT-5b8")}`);
          winterAfter = viewOf(run);
          return initOf(run) === undefined ? { ok: false, reason: `no init from the resumed Winter generation: ${run.stderr.slice(0, 400)}` } : { ok: true };
        });
        const toClaude = await bed.sdk.handoff(key, "claude-agent");
        outcomes.push(`${toClaude.kind}: ${String((toClaude as { detail?: string }).detail ?? "")}`);
        const toWinter = await bed.sdk.handoff(key, "winter-agent");
        outcomes.push(`${toWinter.kind}: ${String((toWinter as { detail?: string }).detail ?? "")}`);
        starts = bed.fixture.mcpStarts();
        verbose("switch", { outcomes, reached, claude, winterBefore, winterAfter, starts });
      });
    }, TIMEOUT);
    test("switch: both handoffs resumed, and each destination's model saw the first turn", () => {
      expect(outcomes.map((outcome) => outcome.split(":")[0])).toEqual(["resumed", "resumed"]);
      expect(reached).toEqual(["claude:true", "winter:true"]);
    });
    claudeReferenceTests("switch (claude leg)", true, () => claude as SameView);
    itemTests("switch (Winter before the switch vs claude)", true, () => ({ claude: claude as SameView, winter: winterBefore }));
    itemTests("switch (Winter after the switch back vs claude)", true, () => ({ claude: claude as SameView, winter: winterAfter as SameView }));
    forbiddenServerTests("switch", () => ({
      starts,
      perRun: [
        { leg: "winter (before)", started: winterBefore.mcpStarted },
        { leg: "claude (switched)", started: (claude as SameView).mcpStarted },
        { leg: "winter (switched back)", started: (winterAfter as SameView).mcpStarted },
      ],
    }));
  });

  describe("a plugin enabled only in settings (no install record)", () => {
    let claude: SameView;
    let winter: SameView;
    beforeAll(async () => {
      await withSameViewBed({ trusted: true, installRecord: false }, async (bed) => {
        // claude's FIRST session in the home registers the directory marketplace (`known_marketplaces.json`)
        // and loads the plugin's components from the next one; it writes no install record for it.
        await bed.runClaude(await bed.build("official"), "s_sv_warm");
        winter = viewOf(await bed.runWinter(await bed.build("winter")));
        claude = viewOf(await bed.runClaude(await bed.build("official"), "s_sv_settings_only"));
        verbose("settings-only plugin", { claude, winter });
      });
    }, TIMEOUT);
    test("settings-only plugin: claude (the reference) reads the enabled directory-marketplace plugin in place", () => {
      expect(claude.plugins).toEqual(["sv-plugin"]);
      expect(claude.skills).toContain("sv-plugin:sv-plug-skill");
      expect(claude.hookRuns).toBe(1);
    });
    test("settings-only plugin: the Winter runtime loads it too, skill and hook alike (SV-4 guard: an enabled directory-marketplace plugin is read in place, no install record needed)", () => {
      expect({ plugins: winter.plugins, skills: winter.skills, hookRuns: winter.hookRuns }).toEqual({ plugins: claude.plugins, skills: claude.skills, hookRuns: claude.hookRuns });
    });
  });

  describe("the plugin's output style, selected in settings (`outputStyle: \"sv-plugin:sv-plug-style\"`)", () => {
    let claude: SameView;
    let winter: SameView;
    let claudeStyles: string[] | undefined;
    beforeAll(async () => {
      await withSameViewBed({ trusted: true, outputStyle: PLUGIN_STYLE }, async (bed) => {
        winter = viewOf(await bed.runWinter(await bed.build("winter")));
        const claudeRun = await bed.runClaude(await bed.build("official"), "s_sv_plugin_style");
        claude = viewOf(claudeRun);
        claudeStyles = claudeRun.availableOutputStyles;
        verbose("plugin style", { claude, winter, claudeStyles });
      });
    }, TIMEOUT);
    test("plugin style: claude (the reference) lists it as `sv-plugin:sv-plug-style` beside the user's style, and makes it the active one", () => {
      expect(claudeStyles).toEqual(expect.arrayContaining([PLUGIN_STYLE, "sv-style"]));
      expect(claude.outputStyle).toBe(PLUGIN_STYLE);
      expect(claude.pluginStyleText).toBe(true);
      expect(claude.styleText).toBe(false);
    });
    test("plugin style: the Winter runtime reports the same active style and sends the same style text", () => {
      expect({ outputStyle: winter.outputStyle, pluginStyleText: winter.pluginStyleText, styleText: winter.styleText }).toEqual({ outputStyle: claude.outputStyle, pluginStyleText: claude.pluginStyleText, styleText: claude.styleText });
    });
  });

  describe("SV-6: a user `deny` rule with a character class reads the same on both legs", () => {
    // The shared home's own rule, absolute: `[ab]` is a CLASS in claude's gitignore-style grammar, and
    // in the Winter runtime's since `ws21/sdk`@57e7fef. The root part is spelled with `escapeRulePath`.
    // The model writes `<root>/a/x.txt` (inside the class: denied) and `<root>/c/y.txt` (outside: asked,
    // and the broker allows it) on each leg in turn.
    const results: Record<string, { inClassWritten: boolean; outsideWritten: boolean; askedInClass: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          userPermissions: (root) => ({ deny: [`Edit(/${escapeRulePath(root)}/[ab]/**)`] }),
          turns: (root) => [
            { toolUses: [{ id: "toolu_in_class", name: "Write", input: { file_path: join(root, "a", "x.txt"), content: "a\n" } }] },
            { toolUses: [{ id: "toolu_outside", name: "Write", input: { file_path: join(root, "c", "y.txt"), content: "c\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const inClass = join(bed.fixture.root, "a", "x.txt");
          const outside = join(bed.fixture.root, "c", "y.txt");
          for (const dir of ["a", "c"]) mkdirSync(join(bed.fixture.root, dir), { recursive: true });
          const measure = async (leg: string, run: (canUseTool: CanUseToolLike) => Promise<Run>): Promise<void> => {
            rmSync(inClass, { force: true });
            rmSync(outside, { force: true });
            const asked: string[] = [];
            await run(async (_tool, input) => {
              asked.push(String(input["file_path"]));
              return { behavior: "allow", updatedInput: input };
            });
            results[leg] = { inClassWritten: existsSync(inClass), outsideWritten: existsSync(outside), askedInClass: asked.includes(inClass) };
          };
          await measure("winter", async (canUseTool) => bed.runWinter(await bed.build("winter"), { canUseTool }));
          await measure("claude", async (canUseTool) => bed.runClaude(await bed.build("official"), "s_sv_deny_class", { canUseTool }));
          verbose("SV-6 deny class", results);
        },
      );
    }, TIMEOUT);
    test("SV-6: claude (the reference) denies the write inside the class and lets the one outside through", () => {
      expect(results["claude"]).toEqual({ inClassWritten: false, outsideWritten: true, askedInClass: false });
    });
    test("SV-6 guard: the Winter runtime reads the class the same way", () => {
      expect(results["winter"]).toEqual(results["claude"]);
    });
  });

  describe("the Winter leg under a trusted root NAMED `[wip] app`", () => {
    // Since the Winter runtime reads claude's grammar (SV-6), a raw `[wip]` in a router-written anchor
    // is a class there too. Under acceptEdits: the project's own re-anchored `ask` rule and the
    // protected project item dir both reach canUseTool; an ordinary sibling write does not.
    const asked: string[] = [];
    const reasons: Record<string, string> = {};
    const written: Record<string, boolean> = {};
    let paths: { free: string; guarded: string; protectedFile: string; denied: string } | undefined;
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          dirName: "[wip] app",
          turns: (root) => [
            { toolUses: [{ id: "toolu_free", name: "Write", input: { file_path: join(root, "free.txt"), content: "free\n" } }] },
            { toolUses: [{ id: "toolu_guarded", name: "Write", input: { file_path: join(root, "guarded.txt"), content: "guarded\n" } }] },
            { toolUses: [{ id: "toolu_protected", name: "Write", input: { file_path: join(root, "p", ".winter", "skills", "x", "SKILL.md"), content: "---\nname: x\ndescription: x\n---\n" } }] },
            { toolUses: [{ id: "toolu_denied", name: "Write", input: { file_path: join(root, "denied.txt"), content: "denied\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const root = bed.fixture.root;
          paths = { free: join(root, "free.txt"), guarded: join(root, "guarded.txt"), protectedFile: join(root, "p", ".winter", "skills", "x", "SKILL.md"), denied: join(root, "denied.txt") };
          // The trusted project's own rules, relative to its root (F17), re-anchored by the router.
          put(join(root, ".winter", "settings.json"), `${JSON.stringify({ permissions: { ask: ["Edit(/guarded.txt)", "Write(/guarded.txt)"], deny: ["Edit(/denied.txt)", "Write(/denied.txt)"] } })}\n`);
          const runHome = await bed.build("winter");
          verbose("[wip] winter rules", runHome.effectiveSettings["permissions"]);
          await bed.runWinter(runHome, {
            permissionMode: "acceptEdits",
            canUseTool: async (_tool, input, options) => {
              asked.push(String(input["file_path"]));
              reasons[String(input["file_path"])] = String(options?.decisionReason ?? "");
              return { behavior: "deny", message: "the test broker records and denies" };
            },
          });
          for (const [name, path] of Object.entries(paths)) written[name] = existsSync(path);
          verbose("[wip] winter", { asked, written, reasons });
        },
      );
    }, TIMEOUT);
    test("[wip] app, Winter leg: the trusted project's own re-anchored `ask` rule fires (the Winter runtime names the rule)", () => {
      expect(asked).toContain(paths!.guarded);
      expect(reasons[paths!.guarded]).toContain("matched ask rule");
      expect(written["guarded"]).toBe(false);
    });
    test("[wip] app, Winter leg: the trusted project's own re-anchored `deny` rule fires — never asked, never written", () => {
      expect(asked).not.toContain(paths!.denied);
      expect(written["denied"]).toBe(false);
    });
    test("[wip] app, Winter leg: a protected project item dir asks too", () => {
      expect(asked).toContain(paths!.protectedFile);
      expect(reasons[paths!.protectedFile]).toContain("protected path");
      expect(written["protectedFile"]).toBe(false);
    });
    test("[wip] app, Winter leg: an ordinary in-cwd write under acceptEdits is not asked, as on claude (SV-8 guard: the acceptEdits bound is a plain prefix test)", () => {
      expect(asked).not.toContain(paths!.free);
      expect(written["free"]).toBe(true);
    });
  });

  describe("SV-7: which rules a Write is matched against", () => {
    // claude matches a Write against `Edit(...)` rules — for deny AND ask (a `Write(...)` rule never
    // fired on the pin, measured). The model writes `<root>/d/z.txt` (an `Edit` deny covers `d/`) and
    // `<root>/q/z.txt` (an `Edit` ask covers `q/`), under acceptEdits, on each leg in turn.
    const results: Record<string, { denyStopsWrite: boolean; askAskedForWrite: boolean; askedTargetWritten: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          userPermissions: (root) => ({ deny: [`Edit(/${escapeRulePath(root)}/d/**)`], ask: [`Edit(/${escapeRulePath(root)}/q/**)`] }),
          turns: (root) => [
            { toolUses: [{ id: "toolu_d", name: "Write", input: { file_path: join(root, "d", "z.txt"), content: "d\n" } }] },
            { toolUses: [{ id: "toolu_q", name: "Write", input: { file_path: join(root, "q", "z.txt"), content: "q\n" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const denied = join(bed.fixture.root, "d", "z.txt");
          const guarded = join(bed.fixture.root, "q", "z.txt");
          for (const dir of ["d", "q"]) mkdirSync(join(bed.fixture.root, dir), { recursive: true });
          const measure = async (leg: string, run: (canUseTool: CanUseToolLike) => Promise<Run>): Promise<void> => {
            rmSync(denied, { force: true });
            rmSync(guarded, { force: true });
            const asked: string[] = [];
            await run(async (_tool, input) => {
              asked.push(String(input["file_path"]));
              return { behavior: "deny", message: "the test broker records and denies" };
            });
            results[leg] = { denyStopsWrite: !existsSync(denied) && !asked.includes(denied), askAskedForWrite: asked.includes(guarded), askedTargetWritten: existsSync(guarded) };
          };
          await measure("winter", async (canUseTool) => bed.runWinter(await bed.build("winter"), { canUseTool, permissionMode: "acceptEdits" }));
          await measure("claude", async (canUseTool) => bed.runClaude(await bed.build("official"), "s_sv_edit_rules", { canUseTool, permissionMode: "acceptEdits" }));
          verbose("SV-7", results);
        },
      );
    }, TIMEOUT);
    test("SV-7: claude (the reference) — an `Edit(...)` deny stops a Write, and an `Edit(...)` ask asks for one", () => {
      expect(results["claude"]).toEqual({ denyStopsWrite: true, askAskedForWrite: true, askedTargetWritten: false });
    });
    test("SV-7 deny: the Winter runtime's `Edit(...)` deny stops a Write too", () => {
      expect(results["winter"]?.denyStopsWrite).toBe(results["claude"]?.denyStopsWrite);
    });
    test("SV-7 ask guard: the Winter runtime's `Edit(...)` ask asks for a Write too (claude's tool-to-rule-kind map)", () => {
      expect({ askAskedForWrite: results["winter"]?.askAskedForWrite, askedTargetWritten: results["winter"]?.askedTargetWritten }).toEqual({ askAskedForWrite: results["claude"]?.askAskedForWrite, askedTargetWritten: results["claude"]?.askedTargetWritten });
    });
  });

  describe("round 5: the rule grammar under acceptEdits, on both legs", () => {
    // User-tier rules (the shared home's own settings), each measured on claude (the reference) and
    // compared on the Winter runtime (claude's full file-rule pipeline since ws21/sdk@20b623e). The
    // broker records every ask and ALLOWS it, so an ask is visible and a denied write never lands.
    const TARGETS = {
      nestedSecret: ["pkg", "secrets", "a"],
      rootSecret: ["secrets", "b"],
      nestedEnv: ["pkg", ".env"],
      literalWip: ["[wip]", "x.txt"],
      classSibling: ["w", "x.txt"],
      askTarget: ["q", "z.txt"],
      free: ["free.txt"],
    } as const;
    type Target = keyof typeof TARGETS;
    const results: Record<string, Record<Target, { asked: boolean; written: boolean }>> = {};
    // THE TRAILING-SPACE ROW (R.3 touch; the SDK reviewer, from the 2.1.250 dump): a Write to `<root>/sp `
    // is TRIMMED before any rule is consulted — `validateInput` trims the path through `ht`, the backfill
    // trims it again, and deny rules are matched only on the trimmed candidates — so the escaped `sp ` deny
    // can never match a Write: under acceptEdits nothing asks and the file `<root>/sp` is WRITTEN. The Winter
    // runtime does the same from ws21/sdk@79773aa (at 5e37898 it asked for `sp ` instead, and the test broker
    // denied it). IF THIS ROW IS EVER RUN IN DEFAULT MODE, compare the asked path against the TRIMMED
    // `<root>/sp` as well as `sp `.
    const trailing: Record<string, { askedRaw: boolean; askedTrimmed: boolean; rawWritten: boolean; trimmedWritten: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          userPermissions: (root) => ({
            deny: ["Edit(./secrets/**)", "Edit(.env)", `Edit(/${escapeRulePath(root)}/\\[wip\\]/**)`],
            ask: [`Edit(/${escapeRulePath(root)}/q/**)`],
          }),
          turns: (root) => [
            ...Object.entries(TARGETS).map(([name, parts]) => ({ toolUses: [{ id: `toolu_${name}`, name: "Write", input: { file_path: join(root, ...parts), content: `${name}\n` } }] })),
            { text: "done" },
          ],
        },
        async (bed) => {
          const pathOf = (name: Target): string => join(bed.fixture.root, ...TARGETS[name]);
          for (const name of Object.keys(TARGETS) as Target[]) mkdirSync(dirname(pathOf(name)), { recursive: true });
          const measure = async (leg: string, run: (canUseTool: CanUseToolLike) => Promise<Run>): Promise<void> => {
            for (const name of Object.keys(TARGETS) as Target[]) rmSync(pathOf(name), { force: true });
            const asked: string[] = [];
            await run(async (_tool, input) => {
              asked.push(String(input["file_path"]));
              return { behavior: "allow", updatedInput: input };
            });
            results[leg] = Object.fromEntries((Object.keys(TARGETS) as Target[]).map((name) => [name, { asked: asked.includes(pathOf(name)), written: existsSync(pathOf(name)) }])) as Record<Target, { asked: boolean; written: boolean }>;
          };
          await measure("winter", async (canUseTool) => bed.runWinter(await bed.build("winter"), { canUseTool, permissionMode: "acceptEdits" }));
          await measure("claude", async (canUseTool) => bed.runClaude(await bed.build("official"), "s_sv_grammar", { canUseTool, permissionMode: "acceptEdits" }));
          verbose("round 5 grammar", results);
        },
      );
    }, TIMEOUT);
    const CASES: Array<{ label: string; targets: Target[]; claude: Record<string, { asked: boolean; written: boolean }> }> = [
      {
        label: "a relative deny `Edit(./secrets/**)` blocks a NESTED `pkg/secrets/a` (and the top-level `secrets/b`)",
        targets: ["nestedSecret", "rootSecret"],
        claude: { nestedSecret: { asked: false, written: false }, rootSecret: { asked: false, written: false } },
      },
      { label: "a bare `Edit(.env)` deny blocks a nested `pkg/.env`", targets: ["nestedEnv"], claude: { nestedEnv: { asked: false, written: false } } },
      {
        label: "an escaped `Edit(//<root>/\\[wip\\]/**)` deny matches the literal `[wip]` dir — and not `w/`, which the unescaped class would",
        targets: ["literalWip", "classSibling"],
        claude: { literalWip: { asked: false, written: false }, classSibling: { asked: false, written: true } },
      },
      { label: "an `Edit(...)` ask rule makes the leg ask before a Write (the broker allows it)", targets: ["askTarget"], claude: { askTarget: { asked: true, written: true } } },
      { label: "an unruled in-cwd write is neither asked nor refused (control)", targets: ["free"], claude: { free: { asked: false, written: true } } },
    ];
    for (const entry of CASES) {
      const pick = (leg: string): Record<string, unknown> => Object.fromEntries(entry.targets.map((name) => [name, results[leg]?.[name]]));
      test(`round 5, claude (the reference): ${entry.label}`, () => {
        expect(pick("claude")).toEqual(entry.claude);
      });
      test(`round 5, the Winter runtime the same: ${entry.label}`, () => {
        expect(pick("winter")).toEqual(pick("claude"));
      });
    }
  });

  describe("round 5: invoking the plugin workflow — Skill(), the slash command, and the Workflow tool", () => {
    // MEASURED: on both legs neither `Skill("sv-plugin:sv-flow")` nor `/sv-plugin:sv-flow` runs the
    // workflow itself — each expands to an instruction to call `Workflow({ name: "sv-plugin:sv-flow" })`
    // with the workflow's description (claude in an injected text block after "Launching skill: …", the
    // Winter runtime in the tool result / the expanded prompt; the wording differs). The run is the
    // Workflow tool's. A repository's vendor-dir workflow (`.claude/workflows/`) is neither listed nor
    // resolvable by name on either leg under a run home.
    const INSTRUCTION = `Workflow({ name: \\"${PLUGIN_WORKFLOW}\\" })`;
    const seen: Record<string, { afterSkill: string; slashPrompt: string; workflow: string; vendorListed: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          turns: () => [
            { toolUses: [{ id: "toolu_skill_flow", name: "Skill", input: { skill: PLUGIN_WORKFLOW } }] },
            { toolUses: [{ id: "toolu_workflow_flow", name: "Workflow", input: { name: PLUGIN_WORKFLOW } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          put(join(bed.fixture.root, ".claude", "workflows", "vendor-flow.js"), 'export const meta = { name: "sv-vendor-flow", description: "a repository vendor-dir workflow" };\n');
          const allowAll: CanUseToolLike = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
          /** Everything the model was sent after the Skill call (the tool result and whatever rode with it). */
          const afterTool = (run: Run, id: string): string => {
            for (const request of run.requests) {
              const messages = (request["messages"] ?? []) as Array<{ content?: unknown }>;
              const index = messages.findIndex((message) => Array.isArray(message.content) && (message.content as Array<Record<string, unknown>>).some((block) => block["type"] === "tool_result" && block["tool_use_id"] === id));
              if (index >= 0) return JSON.stringify(messages.slice(index));
            }
            return "";
          };
          const resultOf = (run: Run, id: string): string => {
            for (const request of run.requests) {
              for (const message of (request["messages"] ?? []) as Array<{ content?: unknown }>) {
                if (!Array.isArray(message.content)) continue;
                for (const block of message.content as Array<Record<string, unknown>>) if (block["type"] === "tool_result" && block["tool_use_id"] === id) return JSON.stringify(block["content"]);
              }
            }
            return "";
          };
          const firstPrompt = (run: Run): string => JSON.stringify((run.requests[0]?.["messages"] ?? []) as unknown[]);
          const w = await bed.runWinter(await bed.build("winter"), { canUseTool: allowAll });
          const wSlash = await bed.runWinter(await bed.build("winter"), { canUseTool: allowAll, prompt: `/${PLUGIN_WORKFLOW}` });
          seen["winter"] = { afterSkill: afterTool(w, "toolu_skill_flow"), slashPrompt: firstPrompt(wSlash), workflow: resultOf(w, "toolu_workflow_flow"), vendorListed: JSON.stringify(initOf(w)).includes("sv-vendor-flow") };
          const c = await bed.runClaude(await bed.build("official"), "s_sv_skill_flow", { canUseTool: allowAll });
          const cSlash = await bed.runClaude(await bed.build("official"), "s_sv_slash_flow", { canUseTool: allowAll, prompt: `/${PLUGIN_WORKFLOW}` });
          seen["claude"] = { afterSkill: afterTool(c, "toolu_skill_flow"), slashPrompt: firstPrompt(cSlash), workflow: resultOf(c, "toolu_workflow_flow"), vendorListed: JSON.stringify(initOf(c)).includes("sv-vendor-flow") };
          verbose("workflow invocation", { winterWorkflow: seen["winter"]?.workflow.slice(0, 300), claudeWorkflow: seen["claude"]?.workflow.slice(0, 300) });
        },
      );
    }, TIMEOUT);
    for (const leg of ["claude", "winter"]) {
      test(`round 5, ${leg}: Skill("${PLUGIN_WORKFLOW}") directs the model to ${INSTRUCTION.replace(/\\\\/g, "")}, with the workflow's description`, () => {
        expect(seen[leg]?.afterSkill).toContain(INSTRUCTION);
        expect(seen[leg]?.afterSkill).toContain("the fixture workflow");
      });
      test(`round 5, ${leg}: the slash command /${PLUGIN_WORKFLOW} expands to the same instruction`, () => {
        expect(seen[leg]?.slashPrompt).toContain(INSTRUCTION);
        expect(seen[leg]?.slashPrompt).toContain("the fixture workflow");
      });
      test(`round 5, ${leg}: a repository's vendor-dir workflow is not listed`, () => {
        expect(seen[leg]?.vendorListed).toBe(false);
      });
    }
    test("round 5, winter: the Workflow tool launches the plugin workflow by its qualified name", () => {
      expect(seen["winter"]?.workflow).toContain("async_launched");
      expect(seen["winter"]?.workflow).toContain("sv-flow");
    });
    test("round 5, claude: the Workflow tool launches it too under a run home (R-1 ruling: the containment floor lets a named workflow through)", () => {
      expect(seen["claude"]?.workflow).toContain("Workflow launched");
      expect(seen["claude"]?.workflow).toContain("the fixture workflow");
    });
  });

  describe("session artifacts survive the run folder (official leg), and what each leg's transcript points at", () => {
    // MEASURED (claude 2.1.250): a large tool output is saved to `<config dir>/projects/<key>/<sid>/
    // tool-results/<id>.txt` and the transcript names that ABSOLUTE path; a launched workflow saves
    // `workflows/scripts/<name>-<run>.js` and `workflows/<run>.json`; a subagent adds
    // `subagents/agent-<id>.meta.json` beside its transcript.
    const seen: Record<string, { outcomeBeforeDispose: string; persisted: boolean; references: string[]; existsAfterDispose: boolean[]; storeHas: boolean[]; storeFiles: string[] }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          turns: () => [
            { toolUses: [{ id: "toolu_big", name: "Bash", input: { command: "seq 1 120000", description: "print a lot" } }] },
            { toolUses: [{ id: "toolu_wf", name: "Workflow", input: { name: PLUGIN_WORKFLOW } }] },
            { toolUses: [{ id: "toolu_agent", name: "Agent", input: { description: "a sub", prompt: "SUBAGENT-PROMPT-7f say hi", subagent_type: "general-purpose" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const allow: CanUseToolLike = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
          const storeProjects = join(bed.session.brandHome, "sdk", "projects");
          const measure = async (leg: "claude" | "winter", runHome: RunHome, run: () => Promise<Run>): Promise<void> => {
            const result = await run();
            await Bun.sleep(1500);
            const text = JSON.stringify(result.requests.at(-1)?.["messages"] ?? []);
            const persisted = text.includes("<persisted-output>");
            const references = [...new Set([...text.matchAll(/(\/[^"\\ ]*?\/projects\/[^"\\ ]*?\/tool-results\/[^"\\ ]+?\.txt)/g)].map((match) => match[1]!))];
            const outcomeBeforeDispose = bed.sdk.runHomeOutcome(runHome.runId);
            await runHome.dispose();
            const relativeToProjects = (path: string): string => path.slice(path.indexOf("/projects/") + "/projects/".length);
            const files = Bun.spawnSync(["/bin/sh", "-c", `cd '${storeProjects}' && find . -type f | sort`]).stdout.toString().split("\n").filter((line) => line.length > 0);
            seen[leg] = {
              outcomeBeforeDispose,
              persisted,
              references,
              existsAfterDispose: references.map((path) => existsSync(path)),
              storeHas: references.map((path) => existsSync(join(storeProjects, relativeToProjects(path)))),
              storeFiles: files,
            };
          };
          const official = await bed.build("official");
          await measure("claude", official, () => bed.runClaude(official, "s_sv_artifacts", { canUseTool: allow }));
          const winter = await bed.build("winter");
          await measure("winter", winter, () => bed.runWinter(winter, { canUseTool: allow }));
          verbose("session artifacts", seen);
        },
      );
    }, TIMEOUT);
    test("official leg: the run home is SAFE when disposed (review I-1: a subagent's metadata never conflicts); afterwards the large tool result, the workflow's script and run record, and the subagent's transcript and metadata (the mirror's) are in sdk/projects/<key>/<sid>/", () => {
      expect(seen["claude"]!.outcomeBeforeDispose).toBe("safe");
      const files = seen["claude"]!.storeFiles;
      for (const pattern of [/\/tool-results\/[^/]+\.txt$/, /\/workflows\/scripts\/sv-flow-[^/]+\.js$/, /\/workflows\/wf_[^/]+\.json$/, /\/subagents\/agent-[^/]+\.meta\.json$/]) {
        expect([String(pattern), files.some((file) => pattern.test(file))]).toEqual([String(pattern), true]);
      }
      // The file the transcript names is in the store, under the same path below `projects/`.
      expect(seen["claude"]!.references.length).toBeGreaterThan(0);
      expect(seen["claude"]!.storeHas.every(Boolean)).toBe(true);
    });
    test.todo(
      "Winter leg: a large tool output is persisted like claude's (`<persisted-output>` + a tool-results file the transcript names) — SV-10 (the Winter runtime returns the whole 711.8 KB `seq 1 120000` output inline; claude saves it to `tool-results/<id>.txt` and sends a 2 KB preview)",
      () => {
        expect({ persisted: seen["winter"]!.persisted, named: seen["winter"]!.references.length > 0, survives: seen["winter"]!.storeHas.every(Boolean) }).toEqual({ persisted: true, named: true, survives: true });
      },
    );
    test.todo(
      "official leg: the LITERAL path the transcript names still resolves after the run folder is disposed — R-2 (claude writes `<run folder>/projects/<key>/<sid>/tool-results/<id>.txt` into the transcript as an absolute path; the carried-back copy lives at `<sdk>/projects/<key>/<sid>/tool-results/<id>.txt`, so a later generation that Reads the named path gets ENOENT — needs a ruling)",
      () => {
        expect(seen["claude"]!.existsAfterDispose.every(Boolean)).toBe(true);
      },
    );
  });

  describe("review I-2: a workflow agent with isolation worktree, under a run home in a git repository (official leg)", () => {
    // MEASURED before the fix: `agent(prompt, { isolation: "worktree" })` inside a workflow script is
    // started by the workflow runtime (no `Agent` tool call for the PreToolUse floor to see) and created
    // `<repo>/.claude/worktrees/` plus a branch in the repository's `.git`. The containment floor now
    // installs a `WorktreeCreate` hook while worktrees are denied; the runtime asks it INSTEAD of running
    // `git worktree add`, and the refusal fails that agent.
    let result: { vendorDir: boolean; worktrees: string; record: string } | undefined;
    beforeAll(async () => {
      const script = 'export const meta = { name: "sv-wt", description: "worktree probe", phases: [{ title: "Only" }] };\nphase("Only");\nconst r = await agent("SUBAGENT-PROMPT-7f do nothing", { isolation: "worktree" });\n';
      await withSameViewBed({ trusted: true, turns: () => [{ toolUses: [{ id: "toolu_wt", name: "Workflow", input: { script } }] }, { text: "done" }] }, async (bed) => {
        const root = bed.fixture.root;
        const git = (args: string[]): string =>
          Bun.spawnSync(["git", ...args], { cwd: root, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: bed.session.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).stdout.toString();
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.email", "bed@example.invalid"]);
        git(["config", "user.name", "the test bed"]);
        git(["add", "-A"]);
        git(["commit", "-qm", "seed"]);
        const allow: CanUseToolLike = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
        const runHome = await bed.build("official");
        await bed.runClaude(runHome, "s_sv_worktree", { canUseTool: allow });
        // The workflow runs in the background; its run record lands under the run folder.
        let record = "";
        for (let attempt = 0; attempt < 40 && !record.includes('"status"'); attempt += 1) {
          await Bun.sleep(250);
          record = Bun.spawnSync(["/bin/sh", "-c", `find '${runHome.dir}/projects' -name 'wf_*.json' -exec cat {} + 2>/dev/null`]).stdout.toString();
        }
        result = { vendorDir: existsSync(join(root, ".claude")), worktrees: git(["worktree", "list", "--porcelain"]), record };
        verbose("I-2 worktree", result);
      });
    }, TIMEOUT);
    test("I-2: no vendor worktree directory in the repository, no extra git worktree, and the workflow's agent was refused by the WorktreeCreate hook", () => {
      expect(result?.vendorDir).toBe(false);
      expect((result?.worktrees ?? "").split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(1);
      expect(result?.record).toContain("WorktreeCreate hook failed");
    });
  });

  describe("review N-1: a workflow that spawns an agent — its run journal survives the run folder (official leg)", () => {
    // MEASURED (claude 2.1.250): a workflow's `agent(...)` writes the run's journal at
    // `<run folder>/projects/<key>/<sid>/subagents/workflows/<run>/journal.jsonl` — uuid-less lines
    // (`{"type":"started",…}`, `{"type":"result",…}`) appended by the workflow runtime, never mirrored.
    // Before the fix the exit said `safe` and the journal died with the folder.
    let result: { outcome: string; local: Record<string, string>; store: Record<string, string>; record: string } | undefined;
    beforeAll(async () => {
      const script = 'export const meta = { name: "sv-journal", description: "journal probe", phases: [{ title: "Only" }] };\nphase("Only");\nconst r = await agent("SUBAGENT-PROMPT-7f do nothing");\n';
      await withSameViewBed({ trusted: true, turns: () => [{ toolUses: [{ id: "toolu_journal", name: "Workflow", input: { script } }] }, { text: "done" }] }, async (bed) => {
        const allow: CanUseToolLike = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
        const runHome = await bed.build("official");
        await bed.runClaude(runHome, "s_sv_journal", { canUseTool: allow });
        const journals = (projects: string): Record<string, string> => {
          const out: Record<string, string> = {};
          const found = Bun.spawnSync(["/bin/sh", "-c", `cd '${projects}' 2>/dev/null && find . -type f -name 'journal.jsonl' | sort`]).stdout.toString().split("\n").filter((line) => line.length > 0);
          for (const path of found) out[path] = readFileSync(join(projects, path), "utf8");
          return out;
        };
        let record = "";
        for (let attempt = 0; attempt < 40 && !record.includes('"status"'); attempt += 1) {
          await Bun.sleep(250);
          record = Bun.spawnSync(["/bin/sh", "-c", `find '${runHome.dir}/projects' -name 'wf_*.json' -exec cat {} + 2>/dev/null`]).stdout.toString();
        }
        let outcome = bed.sdk.runHomeOutcome(runHome.runId);
        for (let attempt = 0; attempt < 40 && outcome === "pending"; attempt += 1) {
          await Bun.sleep(250);
          outcome = bed.sdk.runHomeOutcome(runHome.runId);
        }
        const local = journals(join(runHome.dir, "projects"));
        await runHome.dispose();
        result = { outcome, local, store: journals(join(bed.session.brandHome, "sdk", "projects")), record };
        verbose("N-1 journal", result);
      });
    }, TIMEOUT);
    test("N-1: the run home is SAFE, and after dispose the run's journal is in sdk/projects/<key>/<sid>/subagents/workflows/<run>/journal.jsonl, byte for byte", () => {
      expect(result?.record).toContain('"status"');
      expect(result?.outcome).toBe("safe");
      const paths = Object.keys(result?.local ?? {});
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/^\.\/[^/]+\/[^/]+\/subagents\/workflows\/[^/]+\/journal\.jsonl$/);
      expect(result?.local[paths[0]!]).toContain('"sub done"');
      expect(result?.store).toEqual(result?.local);
    });
  });

  describe("review N-1 minor: a project's relative sandbox `denyWrite` under a root NAMED `[wip] app`", () => {
    // MEASURED (claude 2.1.250): a `sandbox.filesystem` entry holding `[` is a glob there, so a deny
    // re-anchored RAW under `[wip] app` was a class matching `w app` — the sandboxed write to the literal
    // `guarded/` went through. The router now spells the anchor `[[]wip] app` on BOTH legs (R.3, C-1: the
    // Winter runtime routes every deny entry through claude's glob-shape check since ws21/sdk round 11).
    // (Every write under a bracketed cwd is refused by claude's own default write root, which is the cwd
    // spelled raw — so the bed grants the parent explicitly, the shape in which a deny is the only fence.)
    const written: Record<string, Record<string, boolean>> = {};
    // C-1 (R.3): what each leg's BUILT run folder carries (`<run>/settings.json`, read back from disk).
    const built: Record<string, unknown> = {};
    let fixtureRoot = "";
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          dirName: "[wip] app",
          turns: (root) => [
            { toolUses: [{ id: "toolu_sandbox_deny", name: "Bash", input: { command: `cd '${root}' && for d in free guarded; do mkdir -p "$d"; echo x > "$d/f"; done; true`, description: "write two files" } }] },
            { text: "done" },
          ],
        },
        async (bed) => {
          const root = bed.fixture.root;
          put(join(root, ".winter", "settings.json"), `${JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: [join(root, "..")], denyWrite: ["guarded"] } } })}\n`);
          const allow: CanUseToolLike = async (_tool, input) => ({ behavior: "allow", updatedInput: input });
          const observe = (leg: string): void => {
            written[leg] = { free: existsSync(join(root, "free", "f")), guarded: existsSync(join(root, "guarded", "f")) };
            for (const d of ["free", "guarded"]) rmSync(join(root, d), { recursive: true, force: true });
          };
          fixtureRoot = root;
          const filesystemOf = (runHome: RunHome): unknown => (JSON.parse(readFileSync(join(runHome.dir, "settings.json"), "utf8")) as { sandbox?: { filesystem?: unknown } }).sandbox?.filesystem;
          const winter = await bed.build("winter");
          built["winter"] = filesystemOf(winter);
          await bed.runWinter(winter, { canUseTool: allow });
          observe("winter");
          const official = await bed.build("official");
          built["official"] = filesystemOf(official);
          verbose("[wip] sandbox", official.effectiveSettings["sandbox"]);
          await bed.runClaude(official, "s_sv_sandbox_deny", { canUseTool: allow });
          observe("claude");
          verbose("[wip] sandbox written", written);
        },
      );
    }, TIMEOUT);
    test("official leg: the re-anchored deny stops the sandboxed write to the literal `guarded/`; the sibling write goes through", () => {
      expect(written["claude"]).toEqual({ free: true, guarded: false });
    });
    test("C-1 (R.3): BOTH legs' built run folders carry the re-anchored deny spelled for the sandbox glob grammar (`[[]wip] app/guarded`) — the Winter runtime reads these entries through claude's glob-shape check too", () => {
      const parent = dirname(fixtureRoot);
      const expected = { allowWrite: [parent], denyWrite: [join(parent, "[[]wip] app", "guarded")] };
      expect(built).toEqual({ winter: expected, official: expected });
    });
    // SV-11 was OPEN at ws21/sdk@20b623e (the Winter runtime did not apply the run home's
    // `sandbox.filesystem.denyWrite` at all). Fixed in the SDK; with the router's C-1 half (the anchor
    // spelled `[[]wip] app` on this leg too) the shared binary at 5e37898 holds the deny — `bun test --todo`
    // reported this todo as passing, so it is a named guard now. Without C-1 the literal `[wip] app` anchor
    // is a class on this leg and the write lands (measured: `guarded: true`).
    test("Winter leg: the same deny stops the same write (SV-11 guard + C-1: the Winter runtime reads the escaped anchor through claude's glob-shape check; needs a binary at ws21/sdk round 11 or later)", () => {
      expect(written["winter"]).toEqual({ free: true, guarded: false });
    });
  });

  describe("the escape table: a trusted root NAMED `Project (old)`, and deny targets holding `\\` and `\\(`", () => {
    // `escapeRulePath` is claude's rule-content escape over the gitignore escape (the escape-table
    // round). Under acceptEdits: the project's own re-anchored deny, and two user-tier denies the host
    // spells with `escapeRulePath` over paths holding a backslash (never the cwd — claude refuses a
    // backslash cwd), stop their writes without asking; the protected item dir asks; a free write lands.
    // MEASURED before this round: the old spelling (`\\` → two) never matched on claude, and a `\\(`
    // spelled by `c()` alone failed to compile on both runtimes.
    const TARGETS = {
      free: ["free.txt"],
      projectDeny: ["denied.txt"],
      backslash: ["b\\x", "f.txt"],
      backslashParen: ["q\\(y", "f.txt"],
      trailingSpace: ["sp "],
      // R.3 M1: claude's `I_t` also escapes `| + ^ $`; node-ignore reads them literally either way, so
      // this row holds with the old spelling too — the proof that the exact table changes no match.
      regexSpecials: ["a|b+c^d$e", "f.txt"],
      protectedItem: ["p", ".winter", "skills", "x", "SKILL.md"],
    } as const;
    type Target = keyof typeof TARGETS;
    const results: Record<string, Record<Target, { asked: boolean; written: boolean }>> = {};
    // THE TRAILING-SPACE ROW (R.3 touch; the SDK reviewer, from the 2.1.250 dump): a Write to `<root>/sp `
    // is TRIMMED before any rule is consulted — `validateInput` trims the path through `ht`, the backfill
    // trims it again, and deny rules are matched only on the trimmed candidates — so the escaped `sp ` deny
    // can never match a Write: under acceptEdits nothing asks and the file `<root>/sp` is WRITTEN. The Winter
    // runtime does the same from ws21/sdk@79773aa (at 5e37898 it asked for `sp ` instead, and the test broker
    // denied it). IF THIS ROW IS EVER RUN IN DEFAULT MODE, compare the asked path against the TRIMMED
    // `<root>/sp` as well as `sp `.
    const trailing: Record<string, { askedRaw: boolean; askedTrimmed: boolean; rawWritten: boolean; trimmedWritten: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          dirName: "Project (old)",
          // The trailing-space FILE ends its rule. The rule is the one a host would spell with `escapeRulePath`,
          // and it can never match a Write: both runtimes trim the path first (see `trailing` above).
          userPermissions: (root) => ({ deny: [`Edit(/${escapeRulePath(join(root, "b\\x"))}/**)`, `Edit(/${escapeRulePath(join(root, "q\\(y"))}/**)`, `Edit(/${escapeRulePath(join(root, "sp "))})`, `Edit(/${escapeRulePath(join(root, "a|b+c^d$e"))}/**)`] }),
          turns: (root) => [
            ...Object.entries(TARGETS).map(([name, parts]) => ({ toolUses: [{ id: `toolu_${name}`, name: "Write", input: { file_path: join(root, ...parts), content: `${name}\n` } }] })),
            { text: "done" },
          ],
        },
        async (bed) => {
          const root = bed.fixture.root;
          const pathOf = (name: Target): string => join(root, ...TARGETS[name]);
          for (const dir of ["b\\x", "q\\(y", "a|b+c^d$e"]) mkdirSync(join(root, dir), { recursive: true });
          put(join(root, ".winter", "settings.json"), `${JSON.stringify({ permissions: { deny: ["Edit(/denied.txt)"] } })}\n`);
          const trimmedPath = join(root, "sp");
          const measure = async (leg: string, run: (canUseTool: CanUseToolLike) => Promise<Run>): Promise<void> => {
            for (const name of Object.keys(TARGETS) as Target[]) rmSync(pathOf(name), { force: true });
            rmSync(trimmedPath, { force: true });
            const asked: string[] = [];
            await run(async (_tool, input) => {
              asked.push(String(input["file_path"]));
              return { behavior: "deny", message: "the test broker records and denies" };
            });
            results[leg] = Object.fromEntries((Object.keys(TARGETS) as Target[]).map((name) => [name, { asked: asked.includes(pathOf(name)), written: existsSync(pathOf(name)) }])) as Record<Target, { asked: boolean; written: boolean }>;
            trailing[leg] = { askedRaw: asked.includes(pathOf("trailingSpace")), askedTrimmed: asked.includes(trimmedPath), rawWritten: existsSync(pathOf("trailingSpace")), trimmedWritten: existsSync(trimmedPath) };
          };
          await measure("claude", async (canUseTool) => bed.runClaude(await bed.build("official"), "s_sv_escape_table", { canUseTool, permissionMode: "acceptEdits" }));
          await measure("winter", async (canUseTool) => bed.runWinter(await bed.build("winter"), { canUseTool, permissionMode: "acceptEdits" }));
          verbose("escape table", { results, trailing });
        },
      );
    }, TIMEOUT);
    /** The deny table: every row but the trailing-space one, which is not a deny row (see `trailing`). */
    const denyTable = (leg: string): Record<string, unknown> => Object.fromEntries(Object.entries(results[leg] ?? {}).filter(([name]) => name !== "trailingSpace"));
    test("claude (the reference): every deny holds without asking, the protected item dir asks, the free write lands", () => {
      expect(denyTable("claude")).toEqual({
        free: { asked: false, written: true },
        projectDeny: { asked: false, written: false },
        backslash: { asked: false, written: false },
        backslashParen: { asked: false, written: false },
        regexSpecials: { asked: false, written: false },
        protectedItem: { asked: true, written: false },
      });
    });
    test("the Winter runtime reads the same table the same way (needs a binary at ws21/sdk@6170adb or later — L1a's rule-content port)", () => {
      expect(denyTable("winter")).toEqual(denyTable("claude"));
    });
    const trimmedRow = { askedRaw: false, askedTrimmed: false, rawWritten: false, trimmedWritten: true };
    test("trailing space, claude (the reference): both trim; the escaped rule can never match a Write — `<root>/sp` is written, `sp ` is not, nothing asked", () => {
      expect(trailing["claude"]).toEqual(trimmedRow);
    });
    test("trailing space, the Winter runtime: both trim; the escaped rule can never match a Write — `<root>/sp` is written, `sp ` is not, nothing asked (needs a binary at ws21/sdk@79773aa or later; 5e37898 asks for `sp `)", () => {
      expect(trailing["winter"]).toEqual(trimmedRow);
    });
  });

  describe("Touch 2: the folded MCP servers' tools are OFFERED to the model, and callable — not only started", () => {
    // THE LIVE GATE (R.3): the Winter runtime at ws21/sdk@47d9adc connected every server folded into the
    // run folder and offered NONE of their tools to the model, while every row above — which measures only
    // which servers START — passed. Here each fixture server is a real stdio MCP server with one `echo`
    // tool, folded from the user, local and project scopes; the dropped ones (disabled, host-reserved, the
    // standing name) must never be offered.
    //
    // THE STARTUP DEADLINE. Neither leg waits for a stdio server before its init report or its first
    // request (MEASURED: both init reports say `pending`, and claude's first request offers no `mcp__`
    // tool), so the loopback holds the first main request until every folded server has answered a
    // `tools/list` for this run (10 s at most) and asks the live generation for its MCP status; the NEXT
    // turn calls each server's tool. "Offered" is every `mcp__sv-…` tool in any model request of the run;
    // "called" is each server's echo reaching the following request as a tool result.
    const expected = [MCP_SERVERS.local, MCP_SERVERS.project, MCP_SERVERS.user].sort();
    const PROBE_FAILURES: ReadonlySet<string> = new Set(["status-request-failed", "no-status-probe"]);
    const measured: Record<string, { offered: string[]; status: Array<{ name: string; status: string }>; called: string[] }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          // Turn 0 is a plain Read: a request is built BEFORE the gate holds it, so the one that can offer
          // the connected servers' tools is the next (MEASURED on claude: a call made on turn 0 names a tool
          // its request did not offer, and claude answers "no such tool").
          turns: (root) => [
            { toolUses: [{ id: "toolu_read", name: "Read", input: { file_path: join(root, "WINTER.md") } }] },
            { toolUses: expected.map((server, index) => ({ id: `toolu_mcp_${index}`, name: mcpToolName(server), input: { text: `hello ${server}` } })) },
            { text: "done" },
          ],
        },
        async (bed) => {
          const markers = join(bed.session.home, "markers", "mcp");
          const listed = (server: string): number => {
            const path = join(markers, markerLabel(server));
            return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line === "listed").length : 0;
          };
          const measure = async (leg: string, run: () => Promise<Run>): Promise<void> => {
            const before = Object.fromEntries(expected.map((server) => [server, listed(server)]));
            let status: Array<{ name: string; status: string }> = [];
            let gated = false;
            bed.hooks.onTurn = async (index) => {
              if (index !== 0 || gated) return;
              gated = true;
              const deadline = Date.now() + 10_000;
              while (Date.now() < deadline && expected.some((server) => listed(server) <= before[server]!)) await Bun.sleep(50);
              await Bun.sleep(300);
              status = (await bed.live.mcpStatus?.().catch((error: unknown) => [{ name: "status-request-failed", status: String(error) }])) ?? [{ name: "no-status-probe", status: "absent" }];
            };
            const result = await run();
            delete bed.hooks.onTurn;
            const text = JSON.stringify(result.requests);
            measured[leg] = {
              offered: [...new Set(result.requests.flatMap((request) => ((request["tools"] as Array<{ name?: unknown }> | undefined) ?? []).map((tool) => String(tool.name ?? "")).filter(isFixtureMcpTool)))].sort(),
              // The fixture's own servers (and a failed probe, so it shows); the brand's standing server is not ours.
              status: status.filter((entry) => entry.name.startsWith("sv-") || PROBE_FAILURES.has(entry.name)).sort((a, b) => (a.name < b.name ? -1 : 1)),
              called: expected.filter((server) => text.includes(`${MCP_ECHO_MARK} ${server}: hello ${server}`)),
            };
          };
          await measure("claude", async () => bed.runClaude(await bed.build("official"), "s_sv_mcp_offered"));
          await measure("winter", async () => bed.runWinter(await bed.build("winter"), { probeMcp: true }));
          verbose("mcp offered", measured);
        },
      );
    }, TIMEOUT);
    const connected = expected.map((name) => ({ name, status: "connected" }));
    test("claude (the reference): every folded server's tool is offered to the model, `mcpServerStatus()` says connected, and a call to each gets its result", () => {
      expect(measured["claude"]).toEqual({ offered: expected.map(mcpToolName), status: connected, called: expected });
    });
    test("the Winter runtime OFFERS the same `mcp__sv-…` tools as claude (RED at ws21/sdk@47d9adc: none offered; needs SDK round 19)", () => {
      expect(measured["winter"]?.offered).toEqual(measured["claude"]?.offered);
    });
    test("the Winter runtime's `mcp_status` control request says every folded server is connected", () => {
      expect(measured["winter"]?.status).toEqual(connected);
    });
    test("a scripted call to each folded server's tool gets its result on the Winter runtime too (needs SDK round 19)", () => {
      expect(measured["winter"]?.called).toEqual(measured["claude"]?.called);
    });
  });

  // TOUCH 3: claude's SDK-driven runner waits up to 2 s for pending MCP servers before its first turn
  // (the SDK reviewer, 2.1.250: `runHeadless`, `km` default 2000 ms with `waitForDeferrable`; `system/init`
  // is built per query AFTER the wait). A server connecting within that window is in claude's init AND
  // its first request; one connecting later is not. Two servers under `node` (never `bun`: its startup
  // alone took 2.5–4.5 s here, Touch 2) answer `initialize` after ~1 s and ~3.5 s. NO hold on any answer.
  const NODE = Bun.which("node");
  if (NODE === null) {
    // eslint-disable-next-line no-console
    console.warn("[same-view] SKIPPING the Touch 3 MCP prewait row — it needs `node` on PATH (bun's own startup would swamp the 1 s / 3.5 s timing)");
  }
  (NODE === null ? describe.skip : describe)("Touch 3: the pre-first-turn MCP wait — a server connecting within 2 s is in the init report AND the first request; one connecting later is not, until a later turn", () => {
    const FAST = "sv-fast-mcp";
    const SLOW = "sv-slow-mcp";
    const DELAY: Record<string, number> = { [FAST]: 1000, [SLOW]: 3500 };
    /**
     * Turn 0 calls BOTH tools, plus a `Bash` `sleep` — so turn 1's request is built after the slow
     * server has connected on EITHER leg, whatever turn 0's MCP calls did (the tool's own latency, not a
     * hold on an answer; the first attempt put the delay in the fast call itself, which coupled the slow
     * row to the fast one). Turn 1 (three tool results in the conversation) calls the slow one again.
     */
    const SLEEP_S = 5;
    type Kind = string;
    interface Observed {
      init: Record<string, string>;
      firstRequest: Record<string, boolean>;
      turn0: Record<string, Kind>;
      turn1Request: Record<string, boolean>;
      turn1: Record<string, Kind>;
    }
    const observed: Record<string, Observed> = {};
    const timings: Record<string, Record<string, number | null>> = {};
    const refusalText: Record<string, string> = {};
    beforeAll(async () => {
      const t0 = {
        toolUses: [
          { id: "toolu_t0_fast", name: mcpToolName(FAST), input: { text: "t0 fast" } },
          { id: "toolu_t0_slow", name: mcpToolName(SLOW), input: { text: "t0 slow" } },
          { id: "toolu_t0_sleep", name: "Bash", input: { command: `sleep ${SLEEP_S}`, description: "wait a moment" } },
        ],
      };
      const t1 = { toolUses: [{ id: "toolu_t1_slow", name: mcpToolName(SLOW), input: { text: "t1 slow" } }] };
      // Indexed by the tool results in the conversation: 0 → turn 0; 3 → turn 1; 4 → done.
      await withSameViewBed({ trusted: true, turns: () => [t0, t1, t1, t1, { text: "done" }] }, async (bed) => {
        const sdkHome = join(bed.session.brandHome, "sdk");
        const markers = join(bed.session.home, "markers", "mcp");
        const script = join(bed.session.home, "markers", "mcp-server.mjs");
        const config = JSON.parse(readFileSync(join(sdkHome, ".winter.json"), "utf8")) as { mcpServers: Record<string, unknown> };
        for (const name of [FAST, SLOW]) config.mcpServers[name] = { type: "stdio", command: NODE as string, args: [script, join(markers, name), name, String(DELAY[name])] };
        writeFileSync(join(sdkHome, ".winter.json"), `${JSON.stringify(config)}\n`);
        /** The server's `at <event> <ms>` lines at or after `since`, first of each event. */
        const eventsOf = (name: string, since: number): Record<string, number> => {
          const path = join(markers, name);
          const out: Record<string, number> = {};
          if (!existsSync(path)) return out;
          for (const line of readFileSync(path, "utf8").split("\n")) {
            const match = /^at (\S+) (\d+)$/.exec(line);
            if (match === null || Number(match[2]) < since || out[match[1]!] !== undefined) continue;
            out[match[1]!] = Number(match[2]);
          }
          return out;
        };
        const mainRequests = (run: Run): Array<{ body: Record<string, unknown>; at: number }> =>
          run.requests.map((body, index) => ({ body, at: run.requestTimes[index]! })).filter(({ body }) => Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0);
        const offers = (body: Record<string, unknown> | undefined, name: string): boolean => ((body?.["tools"] as Array<{ name?: unknown }> | undefined) ?? []).some((tool) => tool.name === mcpToolName(name));
        const resultText = (run: Run, toolUseId: string): string | undefined => {
          for (const body of run.requests) {
            for (const message of (body["messages"] ?? []) as Array<{ content?: unknown }>) {
              if (!Array.isArray(message.content)) continue;
              for (const block of message.content as Array<Record<string, unknown>>) {
                if (block["type"] !== "tool_result" || block["tool_use_id"] !== toolUseId) continue;
                const content = block["content"];
                return typeof content === "string" ? content : JSON.stringify(content);
              }
            }
          }
          return undefined;
        };
        const kindOf = (text: string | undefined, server: string, said: string): Kind => {
          if (text === undefined) return "no result";
          if (text.includes(`${MCP_ECHO_MARK} ${server}: ${said}`)) return "echo";
          if (text.includes("No such tool available")) return "No such tool available";
          return `other: ${text.slice(0, 160)}`;
        };
        const measure = async (leg: string, run: () => Promise<Run>): Promise<void> => {
          const result = await run();
          const init = initOf(result);
          const initIndex = result.messages.indexOf(init as Record<string, unknown>);
          const statuses = Object.fromEntries(((init?.["mcp_servers"] as Array<{ name: string; status: string }> | undefined) ?? []).map((server) => [server.name, server.status]));
          const main = mainRequests(result);
          const turn1 = main.find(({ body }) => toolResultsIn(body) === 3);
          observed[leg] = {
            init: { [FAST]: statuses[FAST] ?? "absent", [SLOW]: statuses[SLOW] ?? "absent" },
            firstRequest: { [FAST]: offers(main[0]?.body, FAST), [SLOW]: offers(main[0]?.body, SLOW) },
            turn0: { [FAST]: kindOf(resultText(result, "toolu_t0_fast"), FAST, "t0 fast"), [SLOW]: kindOf(resultText(result, "toolu_t0_slow"), SLOW, "t0 slow") },
            turn1Request: { [SLOW]: offers(turn1?.body, SLOW) },
            turn1: { [SLOW]: kindOf(resultText(result, "toolu_t1_slow"), SLOW, "t1 slow") },
          };
          refusalText[leg] = (resultText(result, "toolu_t0_slow") ?? "").slice(0, 200);
          const since = result.startedAt;
          const rel = (at: number | undefined): number | null => (at === undefined ? null : at - since);
          const fast = eventsOf(FAST, since);
          const slow = eventsOf(SLOW, since);
          timings[leg] = {
            fastStart: rel(fast["start"]),
            fastInitializeAnswered: rel(fast["initialize-answered"]),
            slowStart: rel(slow["start"]),
            slowInitializeAnswered: rel(slow["initialize-answered"]),
            initFrame: initIndex < 0 ? null : rel(result.messageTimes[initIndex]),
            firstRequest: rel(main[0]?.at),
            turn1Request: rel(turn1?.at),
          };
        };
        await measure("claude", async () => bed.runClaude(await bed.build("official"), "s_sv_mcp_prewait"));
        await measure("winter", async () => bed.runWinter(await bed.build("winter")));
        verbose("mcp prewait", { observed, timings, refusalText });
      });
    }, TIMEOUT);
    const expected: Observed = {
      init: { [FAST]: "connected", [SLOW]: "pending" },
      firstRequest: { [FAST]: true, [SLOW]: false },
      turn0: { [FAST]: "echo", [SLOW]: "No such tool available" },
      turn1Request: { [SLOW]: true },
      turn1: { [SLOW]: "echo" },
    };
    const fastRow = (o: Observed | undefined) => ({ init: o?.init[FAST], firstRequest: o?.firstRequest[FAST], turn0: o?.turn0[FAST] });
    const slowRow = (o: Observed | undefined) => ({ init: o?.init[SLOW], firstRequest: o?.firstRequest[SLOW], turn0: o?.turn0[SLOW], turn1Request: o?.turn1Request[SLOW], turn1: o?.turn1[SLOW] });
    test("claude (the reference): the ~1 s server is `connected` in its init report, in its first request, and its turn-0 call succeeds; the ~3.5 s server is `pending`, absent from the first request, answered \"No such tool available\" on turn 0, and offered and callable on turn 1", () => {
      expect(observed["claude"]).toEqual(expected);
    });
    test("the Winter runtime, the ~1 s server: the same as claude — `connected` at init, in the first request, its turn-0 call succeeds (RED at ws21/sdk@b97200a: round 19 removed the pre-first-turn wait; round 20 restores it)", () => {
      expect(fastRow(observed["winter"])).toEqual(fastRow(observed["claude"]));
    });
    test("the Winter runtime, the ~3.5 s server: the same as claude — `pending` at init, absent from the first request, \"No such tool available\" on turn 0, offered and callable on turn 1", () => {
      expect(slowRow(observed["winter"])).toEqual(slowRow(observed["claude"]));
    });
  });

  describe("F2 (SV-12): a claude turn with parallel Skill, ToolSearch and MCP calls, switched to the Winter runtime (sdk.handoff)", () => {
    // THE LIVE GATE (R.3, F2): a claude session that had called `Skill`, `ToolSearch` and MCP tools was
    // switched to `codex-oauth/gpt-5.6-terra`; the first Winter turn failed with the provider's HTTP 400
    // "No tool output found for function call <the Skill call's id>". The loopback here answers exactly
    // that 400 whenever a request carries a `tool_use` with no `tool_result` for it.
    //
    // THE CAUSE IS THE WINTER RUNTIME'S OWN READING (SV-12, MEASURED here): claude persists a parallel
    // batch as one ONE-BLOCK `assistant` entry per `tool_use`, chained by `parentUuid`, and parents each
    // `tool_result` entry on ITS OWN call's entry (`sourceToolAssistantUUID`) — a DAG, whose leaf chain
    // runs through the LAST call's result only. claude's own reader splices the other results back in;
    // the Winter runtime's `rebuildProviderMessages` (and the switch review's `switchFactsFor`) walk the
    // single `parentUuid` chain from the leaf, so every call of the batch but the last reaches the
    // provider without its output. Nothing here is the router's: the Winter destination resumes the
    // canonical transcript itself, and step 5's pairing check (whole file) is right to pass it.
    const SKILL_ID = "toolu_f2_skill";
    const SEARCH_ID = "toolu_f2_search";
    const MCP_ID = "toolu_f2_mcp";
    const CALLS = ["toolu_f2_read", SKILL_ID, SEARCH_ID, MCP_ID];
    const SV12 = "SV-12: the Winter runtime reads claude's parallel-call DAG along one parentUuid chain (RED at ws21/sdk@38d9940)";
    let outcome = "";
    let claudeRun: Run | undefined;
    let winterRun: Run | undefined;
    let winterRequests: Array<Record<string, unknown>> = [];
    let entries: winterSdk.SessionStoreEntry[] = [];
    const blocksOf = (content: unknown): string[] =>
      Array.isArray(content) ? (content as Array<Record<string, unknown>>).map((b) => (b["type"] === "tool_use" ? `use:${String(b["id"])}` : b["type"] === "tool_result" ? `result:${String(b["tool_use_id"])}` : String(b["type"]))) : [typeof content];
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          rejectUnpairedToolUse: true,
          turns: (root) => [
            // Turn 0 is a plain Read, so the MCP server has connected before the batch names its tool (Touch 2).
            { toolUses: [{ id: "toolu_f2_read", name: "Read", input: { file_path: join(root, "WINTER.md") } }] },
            {
              toolUses: [
                { id: SKILL_ID, name: "Skill", input: { skill: "sv-user-skill" } },
                { id: SEARCH_ID, name: "ToolSearch", input: { query: `select:${mcpToolName(MCP_SERVERS.user)}`, max_results: 1 } },
                { id: MCP_ID, name: mcpToolName(MCP_SERVERS.user), input: { text: "f2" } },
              ],
            },
            { text: "F2-DONE" },
          ],
        },
        async (bed) => {
          const winterSessionId = "s_sv_f2";
          claudeRun = await bed.runClaude(await bed.build("official"), winterSessionId, { prompt: "F2-FIRST-PROMPT-3a1" });
          const backend = String(initOf(claudeRun)?.["session_id"]);
          const key: SessionKey = { projectKey: bed.projectKey, sessionId: backend };
          entries = (await new winterSdk.WinterCompatibilitySessionStore({ winterHome: join(bed.session.brandHome, "sdk") }).load(key)) ?? [];
          const selection: RuntimeSelection = { ...ws21Selection, runtimeKind: "winter-agent", providerId: "anthropic", modelRef: WINTER_MODEL, authFamily: "api-key" };
          const entry = {
            address: `session:${winterSessionId}`,
            parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId, backendSessionId: backend },
            runtimeKind: "claude-agent",
            objectKind: "session",
            transport: "winter-session",
            status: "idle",
            mode: "code",
            generation: 1,
            selection,
            backendSessionId: backend,
            capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
            cwd: bed.fixture.root,
            updatedAt: new Date().toISOString(),
          } as unknown as RuntimeDirectoryEntry;
          await bed.directory.upsert(entry);
          bed.destinations.set("winter-agent", async () => {
            const current = (await bed.directory.load()).find((row) => row.address === entry.address) ?? entry;
            await bed.directory.upsert({ ...current, runtimeKind: "winter-agent", parsed: { ...current.parsed, runtimeKind: "winter-agent" }, updatedAt: new Date().toISOString() } as RuntimeDirectoryEntry);
            // A provider 400 ends the Winter query by THROWING, so the requests are read off the bed either way.
            try {
              winterRun = await bed.runWinter(await bed.build("winter"), { prompt: "F2-SECOND-PROMPT-7d2", resume: backend });
            } finally {
              winterRequests = bed.requestsSoFar();
            }
            return initOf(winterRun) === undefined ? { ok: false, reason: `no init from the resumed Winter generation: ${winterRun.stderr.slice(0, 400)}` } : { ok: true };
          });
          const toWinter = await bed.sdk.handoff(key, "winter-agent");
          outcome = `${toWinter.kind}: ${String((toWinter as { detail?: string }).detail ?? "")}`;
          verbose("F2", {
            outcome,
            topology: entries.filter((e) => typeof e["uuid"] === "string").map((e) => ({ type: e.type, uuid: e["uuid"], parentUuid: e["parentUuid"], ...(e["isMeta"] === true ? { isMeta: true } : {}), blocks: blocksOf((e["message"] as { content?: unknown } | undefined)?.content) })),
            winterRequests: winterRequests.map((r) => ({ unpaired: unpairedToolUses(r), messages: ((r["messages"] ?? []) as Array<{ role?: unknown; content?: unknown }>).map((m) => `${String(m.role)}:${blocksOf(m.content).join(",")}`) })),
          });
        },
      );
    }, TIMEOUT);
    const firstWinterRequest = (): Record<string, unknown> => winterRequests.find((request) => Array.isArray(request["tools"]) && (request["tools"] as unknown[]).length > 0) ?? {};
    test("F2, claude (the reference): every request claude built pairs each of its calls, and its turn finished", () => {
      expect(claudeRun?.requests.map(unpairedToolUses)).toEqual(claudeRun?.requests.map(() => []));
      const last = claudeRun?.requests.at(-1) ?? {};
      expect(CALLS.filter((id) => JSON.stringify(last).includes(`"tool_use_id":"${id}"`))).toEqual(CALLS);
      expect(JSON.stringify(claudeRun?.messages.filter((m) => m["type"] === "result"))).toContain("F2-DONE");
    });
    test("F2, claude's writing (MEASURED): the batch is one one-block assistant entry per call, and each result is parented on its OWN call's entry — the leaf chain holds only the last call's result", () => {
      const byCall = new Map<string, { uuid: unknown; parentUuid: unknown }>();
      const byResult = new Map<string, unknown>();
      for (const e of entries) {
        for (const block of blocksOf((e["message"] as { content?: unknown } | undefined)?.content)) {
          if (block.startsWith("use:")) byCall.set(block.slice(4), { uuid: e["uuid"], parentUuid: e["parentUuid"] });
          if (block.startsWith("result:")) byResult.set(block.slice(7), e["parentUuid"]);
        }
      }
      const batch = [SKILL_ID, SEARCH_ID, MCP_ID];
      // The transcript really holds every call and its result — a wrong store root or key (an empty load)
      // must fail here, never pass the shape checks below as `undefined === undefined`.
      expect(batch.map((id) => byCall.has(id) && byResult.has(id))).toEqual([true, true, true]);
      // Each call's entry chains on the one before it…
      expect(batch.slice(1).map((id, index) => byCall.get(id)?.parentUuid === byCall.get(batch[index]!)?.uuid)).toEqual([true, true]);
      // …and each result names its own call's entry as its parent.
      expect(batch.map((id) => byResult.get(id) === byCall.get(id)?.uuid)).toEqual([true, true, true]);
    });
    test.todo(`F2: the claude → Winter handoff resumed — ${SV12}`, () => {
      expect(outcome.split(":")[0]).toBe("resumed");
    });
    test.todo(`F2: the Winter runtime's first request carries every call with its output — the Skill, ToolSearch and MCP calls included — ${SV12}`, () => {
      const first = firstWinterRequest();
      expect(unpairedToolUses(first)).toEqual([]);
      expect(CALLS.filter((id) => JSON.stringify(first).includes(`"tool_use_id":"${id}"`))).toEqual(CALLS);
    });
    test.todo(`F2: the first Winter turn after the switch succeeds (no provider 400) — ${SV12}`, () => {
      const result = winterRun?.messages.find((m) => m["type"] === "result");
      expect([result?.["subtype"], result?.["is_error"]]).toEqual(["success", false]);
      expect(JSON.stringify(result)).toContain("F2-DONE");
    });
    test.todo(`F2: the switch review counts every completed tool result the session holds — ${SV12} (\`switchFactsFor\`, the lossy warning's "N completed tool results")`, () => {
      const facts = switchFactsFor({ entries, sidecarRecords: [], from: { providerId: "anthropic", modelKey: "claude-sonnet-4-5" } as never });
      expect(facts.completedToolResults).toBe(CALLS.length);
    });
  });

  describe("Touch 4 (F3), official leg: a sandboxed Bash call's output reaches the model on the SAME turn — claude's own `.cc-writes` staging is bookkeeping, not a breach", () => {
    // THE LIVE GATE: claude 2.1.250 creates `<cwd>/.claude/.cc-writes/` (and `<home>/.claude/…` and
    // `<config dir>/.cc-writes`) before every sandboxed Bash call (`ensureAtomicWriteStagingDirs`). The
    // router's post-call sweep saw a new `<cwd>/.claude`, removed it and ENDED THE TURN: the model never
    // saw the output and no follow-up request was made, while the host saw a normal completion. The
    // existing Bash rows never asked for a follow-up request, which is why it was missed.
    const measured: Record<string, { mainRequests: number; outputReachedModel: boolean; vendorDirLeft: boolean; stagedInConfigDir: boolean }> = {};
    beforeAll(async () => {
      await withSameViewBed(
        {
          trusted: true,
          turns: () => [
            {
              toolUses: [
                {
                  id: "toolu_bash",
                  name: "Bash",
                  // Row 1's call is an ordinary echo; row 2's builds the vendor's name out of fragments (so the
                  // pre-hoc floor cannot read it) and writes `<cwd>/.claude/settings.json` — the model-created
                  // content the sweep must still end the turn for.
                  input: { command: `if [ -f row2 ]; then d=.cla; d="\${d}ude"; mkdir -p "$d" && echo '{}' > "$d/settings.json"; fi; echo BASH-OUT-$(cat row 2>/dev/null)`, description: "echo a token" },
                },
              ],
            },
            { text: "done" },
          ],
        },
        async (bed) => {
          const root = bed.fixture.root;
          const measure = async (row: string, settings: Record<string, unknown>): Promise<void> => {
            put(join(root, ".winter", "settings.json"), `${JSON.stringify(settings)}\n`);
            writeFileSync(join(root, "row"), row);
            if (row === "r2") writeFileSync(join(root, "row2"), "");
            const runHome = await bed.build("official");
            const run = await bed.runClaude(runHome, `s_sv_cc_writes_${row}`);
            const main = run.requests.filter((body) => Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0);
            measured[row] = {
              mainRequests: main.length,
              outputReachedModel: main.slice(1).some((body) => JSON.stringify(body["messages"] ?? []).includes(`BASH-OUT-${row}`)),
              vendorDirLeft: existsSync(join(root, ".claude")),
              stagedInConfigDir: existsSync(join(runHome.dir, ".cc-writes")),
            };
            rmSync(join(root, "row"), { force: true });
            rmSync(join(root, "row2"), { force: true });
          };
          // Row 1: the sandbox on (claude stages `.cc-writes` for a SANDBOXED call); an ordinary echo.
          await measure("r1", { sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });
          // Row 2: the sandbox off (a sandboxed write under `.claude/` is refused by claude's own sandbox, so
          // it would never reach the sweep); the call writes `<cwd>/.claude/settings.json`.
          await measure("r2", {});
          verbose("cc-writes", measured);
        },
      );
    }, TIMEOUT);
    test("row 1: claude really staged `.cc-writes` for the call (its config-dir copy is there), and the Bash output reached the model in a FOLLOW-UP request of the same turn; no `<cwd>/.claude` is left in the repository", () => {
      expect(measured["r1"]).toEqual({ mainRequests: 2, outputReachedModel: true, vendorDirLeft: false, stagedInConfigDir: true });
    });
    test("row 2: a model-written `<cwd>/.claude/settings.json` still ENDS the turn — no follow-up request, and nothing survives", () => {
      expect({ mainRequests: measured["r2"]?.mainRequests, outputReachedModel: measured["r2"]?.outputReachedModel, vendorDirLeft: measured["r2"]?.vendorDirLeft }).toEqual({ mainRequests: 1, outputReachedModel: false, vendorDirLeft: false });
    });
  });

  describe("Touch 4 (F1), official leg: the door forwards `Options.model` and `Options.effort` — the spawned child runs them", () => {
    // THE LIVE GATE: the official door never forwarded the query's top-level `Options.model` or
    // `Options.effort` (0.0.11 and the WS-21 build): a daemon session recorded on one model ran claude's own
    // default, and its effort was dropped. The pinned wrapper turns them into `--model` and `--effort`.
    const MODEL = "claude-sonnet-5";
    const EFFORT = "low";
    const measured: Record<string, { initModel: unknown; requestModels: string[]; requestEffort: unknown[] }> = {};
    beforeAll(async () => {
      await withSameViewBed({ trusted: true }, async (bed) => {
        const measure = async (label: string, over: { model?: string; effort?: string }): Promise<void> => {
          const run = await bed.runClaude(await bed.build("official"), `s_sv_f1_${label}`, over);
          const main = run.requests.filter((body) => Array.isArray(body["tools"]) && (body["tools"] as unknown[]).length > 0);
          measured[label] = {
            initModel: initOf(run)?.["model"],
            requestModels: [...new Set(main.map((body) => String(body["model"])))],
            requestEffort: main.map((body) => (body["output_config"] as { effort?: unknown } | undefined)?.effort ?? null),
          };
          verbose(`f1 ${label} body keys`, main.map((body) => Object.keys(body).sort()));
          verbose(`f1 ${label} output_config/thinking`, main.map((body) => ({ output_config: body["output_config"], thinking: body["thinking"] })));
        };
        await measure("forwarded", { model: MODEL, effort: EFFORT });
        await measure("default", {});
        verbose("f1", measured);
      });
    }, TIMEOUT);
    test("the child reports the forwarded model at init and sends it on every request, and its requests carry the forwarded effort", () => {
      expect(measured["forwarded"]).toEqual({ initModel: MODEL, requestModels: [MODEL], requestEffort: [EFFORT] });
    });
    test("control: without them the child runs its own default model and sends no effort of ours", () => {
      expect(measured["default"]?.initModel).not.toBe(MODEL);
      expect(measured["default"]?.requestEffort).not.toContain(EFFORT);
    });
  });

  describe("untrusted project: every project item is absent on both", () => {
    let claude: SameView;
    let winter: SameView;
    let starts: Record<string, number> = {};
    beforeAll(async () => {
      await withSameViewBed({ trusted: false }, async (bed) => {
        winter = viewOf(await bed.runWinter(await bed.build("winter")));
        claude = viewOf(await bed.runClaude(await bed.build("official"), "s_sv_untrusted"));
        starts = bed.fixture.mcpStarts();
        verbose("untrusted", { claude, winter, starts });
      });
    }, TIMEOUT);
    claudeReferenceTests("untrusted", false, () => claude);
    itemTests("untrusted", false, () => ({ claude, winter }));
    forbiddenServerTests("untrusted", () => ({ starts, perRun: [{ leg: "winter", started: winter.mcpStarted }, { leg: "claude", started: claude.mcpStarted }] }));
    test("untrusted: the local-scope server still reaches both legs (it is the user's own entry, not the repository's); the project-scope one reaches neither", () => {
      for (const view of [claude, winter]) {
        expect(view.mcpStarted).toContain(MCP_SERVERS.local);
        expect(view.mcpStarted).not.toContain(MCP_SERVERS.project);
        expect(view.mcpServers).not.toContain(MCP_SERVERS.project);
      }
      expect(winter.mcpStarted).toEqual(claude.mcpStarted);
    });
    test("untrusted: no project item, instruction or server reaches the Winter runtime either", () => {
      const all = [...winter.skills, ...winter.agents, ...winter.mcpServers, ...winter.instructions];
      expect(all.filter((name) => /project|PROJECT/.test(name))).toEqual([]);
    });
  });
});
