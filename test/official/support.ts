// THE REAL-RUNTIME TEST BED (R-7b-6): the pinned official runtime, driven against a loopback fake.
//
// "Hermetic tests drive the pinned official SDK through a loopback capture against a `127.0.0.1`
// fake, never a real endpoint; `pathToClaudeCodeExecutable` points at the package's own bundled CLI
// in `node_modules` for tests and at the host's vendored copy in production (§5.1)."
//
// THREE THINGS THIS FILE RESOLVES, AND WHY EACH IS RESOLVED THE WAY IT IS:
//
//   1. THE RUNTIME BINARY. The optional peer ships its CLI as a per-platform package
//      (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`), installed by the lockfile. It is resolved
//      THROUGH THE OFFICIAL PACKAGE'S OWN `require` rather than through this package's, because it is
//      that package's optional dependency and not ours — and resolving it explicitly is the point:
//      letting the runtime find its own binary picked up a DIFFERENT VERSION from a Bun install cache
//      on the machine this was written on (0.3.265 against a 0.3.250 wrapper). §5.1's "never the
//      user's installed binary" is the same rule; this is what enforcing it looks like in a test.
//   2. THE SCHEMA CONVERTER. The in-process MCP server takes schemas in the validator's own shape and
//      the router depends on no validator (see `src/official/mcp-descriptors.ts`). The validator is
//      resolved the same way — through the official package, which has it as a peer — so the test
//      supplies the `toInputShape` a host supplies in production, rather than the router growing a
//      dependency for a test's convenience.
//   3. HERMETICITY. `HOME` and `CLAUDE_CONFIG_DIR` are BOTH fresh `mkdtemp` directories, and the
//      environment handed to the child is a REPLACEMENT with no `process.env` spread. `HOME` matters
//      independently: the runtime derives some paths from `os.homedir()`, whose OS-level fallback
//      (the user database) is invisible to `CLAUDE_CONFIG_DIR` scoping. Every test also plants a
//      DECOY vendor home under the temp `HOME`, so "nothing was written there" is an assertion about
//      a directory that exists rather than about one that never could.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import type { JsonSchemaObject, OfficialMcpModule } from "../../src/official/mcp-descriptors.ts";
import type { OfficialSdkModule } from "../../src/seams/official-sdk-shapes.ts";
import { HERMETIC_TRAFFIC_OPT_OUTS } from "../../src/testing/index.ts";

const officialRequire = createRequire(import.meta.url);
const officialPackageJson = officialRequire.resolve("@anthropic-ai/claude-agent-sdk/package.json");
const insideOfficial = createRequire(officialPackageJson);

/** Candidate platform packages, most specific first (musl builds share a platform/arch pair). */
function platformPackageCandidates(): string[] {
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return process.platform === "linux" ? [base, `${base}-musl`] : [base];
}

export interface OfficialRuntimeBed {
  /** The pinned CLI binary — an explicit path, never a bare command name (§5.1). */
  executable: string;
  /** The version the platform package declares; asserted equal to the pinned wrapper's. */
  version: string;
  /** The real injected module, in the shape the seam declares. */
  module: OfficialSdkModule;
  /** The official module's own MCP surface, for §11's materialization. */
  mcpModule: OfficialMcpModule;
  /** A JSON-Schema → validator-shape converter built on the validator the official SDK already has. */
  toInputShape: (schema: JsonSchemaObject) => unknown;
}

/**
 * THE ENV POLICY EVERY REAL-RUNTIME BED USES (whole-branch review, F-1).
 *
 * The four traffic opt-outs ride the `configuredExtras` door, which is a POSITIVE allowlist over the
 * pinned artifact's own non-credential registry — all four names are declared there, so this is the
 * door working as designed rather than an exception carved for tests. Without them the child fetches
 * remote feature configuration and the advertised tool inventory changes under the same pin: measured
 * at 25 tools with the fetch, 21 without, the four extra being `DesignSync`, `Monitor`,
 * `PushNotification` and `advisor_20260301:advisor`. A proof about "what 0.3.250 does" that moves
 * with a CDN is not a proof about 0.3.250.
 */
export function hermeticEnvPolicy(): { env: { configuredExtras: Record<string, string> } } {
  return { env: { configuredExtras: { ...HERMETIC_TRAFFIC_OPT_OUTS } } };
}

let cached: OfficialRuntimeBed | undefined;
let resolutionFailure: string | undefined;

/**
 * Resolves the bed, or records why it could not be resolved.
 *
 * NEVER SILENTLY SKIPS ON A FAILURE THAT IS OURS. A missing platform package (an environment where
 * the optional dependency was not installed) is a legitimate skip; anything else — a wrapper at the
 * wrong version, a module that does not export what §11 needs — must fail loudly, because those are
 * the conditions a green suite would be lying about.
 */
export function officialRuntimeBed(): OfficialRuntimeBed | undefined {
  if (cached !== undefined) return cached;
  if (resolutionFailure !== undefined) return undefined;
  let platformDir: string | undefined;
  for (const candidate of platformPackageCandidates()) {
    try {
      platformDir = dirname(insideOfficial.resolve(`${candidate}/package.json`));
      break;
    } catch {
      /* try the next candidate */
    }
  }
  if (platformDir === undefined) {
    resolutionFailure = `no platform package for ${process.platform}-${process.arch}: the optional dependency was not installed, so the real-runtime proofs cannot run here`;
    // eslint-disable-next-line no-console
    console.warn(`[official runtime bed] SKIPPING the real-runtime proofs — ${resolutionFailure}`);
    return undefined;
  }
  const platformManifest = JSON.parse(readFileSync(join(platformDir, "package.json"), "utf8")) as { version: string };
  const wrapperManifest = JSON.parse(readFileSync(officialPackageJson, "utf8")) as { version: string };
  if (platformManifest.version !== wrapperManifest.version) {
    throw new Error(`the platform runtime is ${platformManifest.version} but the wrapper is ${wrapperManifest.version}: a mixed pair is not the pinned artifact (WS-02 §6)`);
  }
  const executable = join(platformDir, "claude");
  if (!existsSync(executable)) throw new Error(`the platform package at ${platformDir} carries no runtime binary`);

  const module = insideOfficial("@anthropic-ai/claude-agent-sdk") as OfficialSdkModule & OfficialMcpModule;
  const zod = insideOfficial("zod") as { string(): ZodLike; boolean(): ZodLike };
  cached = {
    executable,
    version: wrapperManifest.version,
    module,
    mcpModule: module,
    toInputShape: (schema) => jsonSchemaToShape(schema, zod),
  };
  return cached;
}

interface ZodLike {
  max(n: number): ZodLike;
  optional(): ZodLike;
}

/** The narrow JSON-Schema subset the descriptors use, converted into a validator raw shape. */
function jsonSchemaToShape(schema: JsonSchemaObject, zod: { string(): ZodLike; boolean(): ZodLike }): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const type = property["type"];
    let field: ZodLike = type === "boolean" ? zod.boolean() : zod.string();
    const maxLength = property["maxLength"];
    if (typeof maxLength === "number" && type !== "boolean") field = field.max(maxLength);
    shape[name] = required.has(name) ? field : field.optional();
  }
  return shape;
}

// --------------------------------------------------------------------------------------------------
// Hermetic homes, the decoy, and the loopback script.
// --------------------------------------------------------------------------------------------------

export interface HermeticSessionOptions {
  /**
   * Initialize the working directory as a git repository (review r1, M2).
   *
   * The worktree writers — `EnterWorktree`, an `Agent`/`Task` with `isolation: "worktree"` — REFUSE
   * OUTRIGHT outside a repository ("Cannot create a worktree: not in a git repository"). A row-14
   * proof taken in a bare `mkdtemp` therefore proves nothing about containment: the writer never ran.
   * With a repository they would really create `.claude/worktrees/`, which is what makes the floor's
   * refusal a measurement rather than a coincidence.
   */
  git?: boolean;
}

export interface HermeticSession {
  /** A throwaway `HOME`, with a DECOY vendor home already in it (see this file's header). */
  home: string;
  /** The spool: `<brand home>/runtimes/official-agent-spool`, created. */
  spool: string;
  /** A throwaway working directory. */
  cwd: string;
  /** `<home>/<brand home dir>` — the resolved product home the spool hangs off. */
  brandHome: string;
  /** The decoy vendor home under `home`; nothing may ever be written into it. */
  decoyVendorHome: string;
}

const roots: string[] = [];

/** Creates one hermetic set of directories. Every root is removed by `cleanupHermetic()`. */
export function hermeticSession(prefix = "official", options: HermeticSessionOptions = {}): HermeticSession {
  const root = mkdtempSync(join(tmpdir(), `winter-rt-${prefix}-`));
  roots.push(root);
  const home = join(root, "home");
  const brandHome = join(home, ".winter");
  const spool = join(brandHome, "runtimes", "official-agent-spool");
  const cwd = join(root, "work");
  const decoyVendorHome = join(home, ".claude");
  for (const dir of [home, brandHome, spool, cwd, decoyVendorHome]) mkdirSync(dir, { recursive: true });
  // The decoy carries a file, so "unchanged" is checkable rather than vacuous.
  writeFileSync(join(decoyVendorHome, "decoy.json"), DECOY_CONTENT);
  if (options.git === true) {
    // A real repository, with an identity so nothing reads the developer's own git config.
    const run = (args: string[]): void => {
      const result = spawnSync("git", args, { cwd, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in the hermetic session: ${String(result.stderr)}`);
    };
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "bed@example.invalid"]);
    run(["config", "user.name", "the test bed"]);
    writeFileSync(join(cwd, "seed.txt"), "the repository needs one commit for a worktree\n");
    run(["add", "seed.txt"]);
    run(["commit", "-qm", "seed"]);
  }
  return { home, spool, cwd, brandHome, decoyVendorHome };
}

export function cleanupHermetic(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

/** Every path under `dir`, relative to it — the shape an isolation assertion is made against. */
export function treeOf(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 6) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) out.push(...treeOf(full, depth + 1));
  }
  return out;
}

/** What the decoy holds when nothing has touched it. */
const DECOY_CONTENT = '{"planted":"by the test bed"}\n';

/**
 * The decoy vendor home, exactly as planted — nothing added, nothing changed.
 *
 * COMPARES THE CONTENT, not a byte count: the first version of this helper hard-coded a length that
 * was two bytes off, so it reported "touched" for a directory nothing had touched. A wrong tripwire
 * is worse than none, because the next reader debugs the runtime instead of the assertion.
 */
export function decoyUntouched(session: HermeticSession): boolean {
  const entries = readdirSync(session.decoyVendorHome);
  if (entries.length !== 1 || entries[0] !== "decoy.json") return false;
  return readFileSync(join(session.decoyVendorHome, "decoy.json"), "utf8") === DECOY_CONTENT;
}

// --------------------------------------------------------------------------------------------------
// The loopback script: canned Anthropic-shaped Messages responses, chosen by conversation state.
// --------------------------------------------------------------------------------------------------

export interface ScriptedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** One scripted assistant turn: either text, or one or more tool_use blocks. */
export type ScriptedTurn = ({ text: string } | { toolUses: ScriptedToolUse[] }) & {
  /** Hold the response back this long — what makes a turn long enough to interrupt. */
  delayMs?: number;
};

const MODEL_ID = "claude-sonnet-4-5-20250929";

function messageFor(turn: ScriptedTurn, index: number): unknown {
  const content = "text" in turn ? [{ type: "text", text: turn.text }] : turn.toolUses.map((use) => ({ type: "tool_use", id: use.id, name: use.name, input: use.input }));
  return {
    id: `msg_scripted_${index}`,
    type: "message",
    role: "assistant",
    model: MODEL_ID,
    content,
    stop_reason: "text" in turn ? "end_turn" : "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

export interface LoopbackRecord {
  /** Every `/v1/messages` request body the runtime sent, parsed. */
  requests: Array<Record<string, unknown>>;
  /** Every path the loopback was asked for — evidence that it is the only endpoint reached. */
  paths: string[];
}

/**
 * Serves a SCRIPT of assistant turns, one per model request, repeating the last.
 *
 * Turn selection is by REQUEST COUNT rather than by inspecting the conversation, because a script is
 * what a test is actually writing: "first the model emits this, then that". The canned bodies are
 * standard public Messages-API shapes, independently authored — never a vendor artifact (WS-02 §2).
 */
export function scriptedLoopback(turns: readonly ScriptedTurn[]): {
  routes: Array<{ path: string; method?: string; handler: (req: Request, recorded: { method: string; path: string; body: string }) => Response | Promise<Response> }>;
  record: LoopbackRecord;
} {
  const record: LoopbackRecord = { requests: [], paths: [] };
  return {
    record,
    routes: [
      {
        path: "*",
        // THE BODY COMES FROM `recorded`, NOT FROM `req.text()`. The loopback base has already read
        // the stream to record it, so a second read yields "" — which is silent: every assertion
        // about "what the model was asked" then passes vacuously against an empty object. Found the
        // first time this bed drove the real runtime.
        handler: async (req: Request, recorded: { method: string; path: string; body: string }) => {
          record.paths.push(recorded.path);
          if (recorded.path === "/v1/messages" && recorded.method === "POST") {
            let body: Record<string, unknown> = {};
            try {
              body = JSON.parse(recorded.body) as Record<string, unknown>;
            } catch {
              /* a shape this bed did not anticipate: recorded as empty, still answered */
            }
            record.requests.push(body);
            // TURN SELECTION IS BY CONVERSATION STATE, not by request count: the runtime makes its
            // own side requests (a title, a summary), and a script indexed by count would hand the
            // scripted tool_use to one of those and the real turn to the next line of the script.
            const index = Math.min(countToolResults(body), turns.length - 1);
            const turn = turns[Math.max(index, 0)] ?? { text: "ok" };
            if (turn.delayMs !== undefined) await new Promise<void>((resolve) => setTimeout(resolve, turn.delayMs));
            return new Response(JSON.stringify(messageFor(turn, index + 1)), { status: 200, headers: { "content-type": "application/json" } });
          }
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    ],
  };
}

/** How many tool results this conversation already carries — the script's own cursor. */
function countToolResults(body: Record<string, unknown>): number {
  let count = 0;
  for (const message of (body["messages"] ?? []) as Array<{ content?: unknown }>) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as Array<Record<string, unknown>>) if (block["type"] === "tool_result") count += 1;
  }
  return count;
}

/** The tool names the runtime advertised on a recorded request — row 2's own measurement. */
export function advertisedToolNames(record: LoopbackRecord, index = -1): string[] {
  const request = index < 0 ? record.requests.at(index) : record.requests[index];
  const tools = (request?.["tools"] ?? []) as Array<{ name?: string }>;
  return tools.map((tool) => tool.name ?? "?");
}

/** Every `tool_result` block the runtime sent back to the model, flattened. */
export function toolResults(record: LoopbackRecord): Array<{ tool_use_id?: string; content?: unknown; is_error?: boolean }> {
  const out: Array<{ tool_use_id?: string; content?: unknown; is_error?: boolean }> = [];
  for (const request of record.requests) {
    for (const message of (request["messages"] ?? []) as Array<{ content?: unknown }>) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block["type"] === "tool_result") out.push(block as { tool_use_id?: string; content?: unknown; is_error?: boolean });
      }
    }
  }
  return out;
}
