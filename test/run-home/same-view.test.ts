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
}

interface Run {
  messages: Array<Record<string, unknown>>;
  requests: Array<Record<string, unknown>>;
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
 * stdio server that records its own start and exits, so "did this leg start it" is measured on the
 * process, not read off an init report. `winter` is the brand's standing-server name, which the router
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
  const server = (name: string): Record<string, unknown> => ({ type: "stdio", command: "/bin/sh", args: ["-c", `echo started >> '${join(mcpMarkers, markerLabel(name))}'; exit 1`] });
  put(join(sdkHome, "WINTER.md"), `${TOKENS.userInstructions}\n`);
  put(join(root, "WINTER.md"), `${TOKENS.projectInstructions}\n`);
  put(join(sdkHome, "rules", "user-rule.md"), `${TOKENS.userRule}\n`);
  put(join(root, ".winter", "rules", "project-rule.md"), `${TOKENS.projectRule}\n`);
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
  runWinter(runHome: RunHome, over?: { prompt?: string; resume?: string; permissionMode?: string; canUseTool?: CanUseToolLike }): Promise<Run>;
  runClaude(runHome: RunHome, winterSessionId: string, over?: { prompt?: string; sessionId?: string; canUseTool?: CanUseToolLike; permissionMode?: string }): Promise<Run>;
  /** Set by a test that drives `sdk.handoff`: what each confirming destination opens. */
  destinations: Map<string, (runKind: "claude-agent" | "winter-agent") => Promise<HandoffStepReport>>;
}

async function withSameViewBed<T>(
  options: { trusted: boolean; installRecord?: boolean; outputStyle?: string; dirName?: string; turns?: (root: string) => readonly SameViewTurn[]; userPermissions?: (root: string) => Record<string, string[]> },
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
              const turn = turns[Math.min(toolResultsIn(body), turns.length - 1)] ?? { text: "ok" };
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
      const drain = async (query: unknown): Promise<Array<Record<string, unknown>>> => {
        const out: Array<Record<string, unknown>> = [];
        for await (const message of query as AsyncIterable<Record<string, unknown>>) out.push(message);
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
                runtime: { runHome },
              } as never,
            }),
          );
          return { messages, requests: [...requests], stderr: stderr.join(""), hookRuns: hookRuns() - before, mcpStarted: await startedSince(startsBefore) };
          // (the Winter runtime's Query offers no `initializationResult`, so no style list is read here)
        },
        async runClaude(runHome, winterSessionId, over = {}) {
          requests.length = 0;
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
              runtime: {
                runHome,
                selection: ws21Selection,
                official: { sessionId: winterSessionId, credentials: [{ variable: "ANTHROPIC_API_KEY", ref: CREDENTIAL }], connectionEnv: { ANTHROPIC_BASE_URL: baseUrl }, base: childEnv },
              },
            } as never,
          }) as unknown as AsyncIterable<unknown> & { initializationResult?: () => Promise<Record<string, unknown>>; setPermissionMode?: (mode: string) => Promise<void> };
          if (stream !== undefined) await handle.setPermissionMode?.(over.permissionMode as string);
          const draining = (async () => {
            const out: Array<Record<string, unknown>> = [];
            for await (const message of handle as AsyncIterable<Record<string, unknown>>) {
              out.push(message);
              if (stream !== undefined && message["type"] === "result") stream.close();
            }
            return out;
          })();
          if (stream !== undefined) await stream.push(over.prompt ?? "hello");
          // THE STYLE LIST: claude answers it on its initialize response (`available_output_styles`).
          const initialization = typeof handle.initializationResult === "function" ? await handle.initializationResult().catch(() => undefined) : undefined;
          const messages = await draining;
          const availableOutputStyles = initialization?.["available_output_styles"];
          return {
            messages,
            requests: [...requests],
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
const ITEMS = ["skills", "skillListing", "agents", "plugins", "mcpServers", "mcpStarted", "outputStyle", "styleText", "pluginStyleText", "instructions", "hookRuns", "workflows", "slashDuplicates"] as const;
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
};

/**
 * SV-n STILL OPEN: a measured difference in the Winter runtime's own reading, kept as a `test.todo`
 * (the real assertion; `bun test --todo` fails it the moment the SDK is fixed).
 */
const LEDGER: Partial<Record<Item, string>> = {
  slashDuplicates:
    "SV-9 (regression at ws21/sdk@20b623e: the Winter runtime lists every workflow TWICE in init `slash_commands` — once through the synthetic workflow skills, once through the explicit append)",
};

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
    expect({ skills: claude.skills, skillListing: claude.skillListing, agents: claude.agents, plugins: claude.plugins, mcpServers: claude.mcpServers, mcpStarted: claude.mcpStarted, workflows: claude.workflows, instructions: claude.instructions }).toEqual(expected);
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
