// R-7b-8 — THE D29 ADVISOR PROBE, run against the pinned official runtime through the loopback fake.
//
// THE QUESTION, from WS-14's own amendment: "whether the pinned official Agent SDK 0.3.250 exposes
// Anthropic's advisor server tool inside an SDK session, and under which option or account condition,
// is UNVERIFIED… The 7b task probes it against the pinned artifact through the loopback capture
// harness and records the result before the D29 'each branch gets its own advisor' split is relied
// upon." `docs/probes/d29-advisor.md` is that record; this file is what produces it, so the record
// can be re-derived rather than believed.
//
// HERMETIC, AND THE FAKE IS THE PROOF (R-7b-6). The runtime is handed a REPLACEMENT environment of
// exactly four variables (`officialCaptureEnv`): `ANTHROPIC_BASE_URL` pointing at a `127.0.0.1` fake
// from `@yanlinglabs/winter-provider-conformance`, an obviously-fake key, a fresh `CLAUDE_CONFIG_DIR`
// and a fresh `HOME` — the last one because `os.homedir()` falls back to the OS user database and
// would otherwise reach the real user's home regardless of the config dir. Every working directory is
// an `mkdtemp` removed in a `finally`, `settingSources: []` reads no settings file at any level, and
// every request the runtime makes is recorded on the fake. No real key, no real endpoint, no network.
//
// THE PINNED ARTIFACT, NOT WHATEVER IS ON PATH. `pathToClaudeCodeExecutable` is set explicitly to the
// platform binary inside THIS repository's `node_modules` (WS-14 §5.1: "the vendored runtime — never
// the user's installed Claude binary"), and the resolved package version is asserted against the
// version matrix's own pin before a single condition runs. That assertion is not ceremony: resolving
// the same specifier from a scratch directory during this probe's development picked up a DIFFERENT
// version out of a global install cache, and a probe of the wrong artifact is worse than no probe.
//
// SKIPS WITH A PRINTED REASON when the runtime cannot start here (no platform binary for this
// os/arch, a version that is not the pin, a launch that throws or never yields `system/init`), which
// is the one thing that must not turn into a red suite on a machine that simply has no binary.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { anthropicFake, normalizeTrace, officialCaptureEnv, withLoopbackFake } from "../../src/testing/index.ts";
import type { ConformanceTraceEntry } from "../../src/testing/index.ts";
import { SUPPORTED } from "../../src/version-matrix.ts";

/** Every advisor-shaped name this probe looks for, in an inventory or on the wire. */
const ADVISOR = /advisor/i;

/** How long one condition may take before the probe gives up on the runtime and skips. */
const CONDITION_TIMEOUT_MS = 60_000;

interface ConditionResult {
  label: string;
  /** What the session was configured with, for the record. */
  conditions: string;
  /** `system/init.tools` — the client-side advertised inventory. */
  initTools: string[];
  /** Every distinct tool entry the runtime sent to the endpoint, as `type:name` (or `name`). */
  wireTools: string[];
  /** The distinct request paths the fake received. */
  paths: string[];
  /** Content-block `type:name` pairs the SDK yielded on assistant messages. */
  assistantBlocks: string[];
  /** The SDK message kinds, normalized. */
  kinds: string[];
  /** The runtime's own `user-agent` on the endpoint request — which artifact actually ran. */
  userAgent: string;
}

type Probe = { ok: true; sdkVersion: string; binary: string; results: ConditionResult[] } | { ok: false; reason: string };

/** The platform package that carries the runtime binary, resolved FROM the SDK package's own dir. */
function resolvePinnedBinary(sdkPackageDir: string): string | undefined {
  const bases = [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`];
  for (const base of bases) {
    try {
      return join(dirname(Bun.resolveSync(`${base}/package.json`, sdkPackageDir)), "claude");
    } catch {
      // The next candidate, or none: a machine without a binary for this os/arch is a SKIP, not a
      // failure, and the reason names exactly which package could not be resolved.
    }
  }
  return undefined;
}

/**
 * One canned Anthropic turn for whatever model the runtime asks for.
 *
 * A PROXY over the fake's model-keyed scenario table, on purpose: the runtime resolves its own alias
 * (`sonnet` → a full model id) and that id moves with the pinned version, so keying the table on a
 * guessed id would make this probe fail for a reason that has nothing to do with what it measures.
 */
function scenarioForAnyModel(content: unknown[]): Record<string, () => Response> {
  const answer = () =>
    Response.json({
      id: "msg_d29_probe",
      type: "message",
      role: "assistant",
      model: "probe",
      content,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  return new Proxy({}, { get: () => answer }) as Record<string, () => Response>;
}

interface ConditionSpec {
  label: string;
  conditions: string;
  options?: Record<string, unknown>;
  env?: Record<string, string>;
  /** What the fake answers with. Defaults to one text block. */
  content?: unknown[];
}

const CONDITIONS: ConditionSpec[] = [
  { label: "A default", conditions: "the minimal options: model alias, cwd, settingSources: []" },
  {
    label: "B tools preset + allowedTools naming advisor",
    conditions: 'tools: { type: "preset", preset: "claude_code" }, allowedTools: ["advisor", "Advisor"]',
    options: { tools: { type: "preset", preset: "claude_code" }, allowedTools: ["advisor", "Advisor"] },
  },
  { label: "C tools array naming advisor", conditions: 'tools: ["Read", "advisor"]', options: { tools: ["Read", "advisor"] } },
  {
    label: "D systemPrompt preset",
    conditions: 'systemPrompt: { type: "preset", preset: "claude_code" }',
    options: { systemPrompt: { type: "preset", preset: "claude_code" } },
  },
  { label: "E settings.advisorModel", conditions: "settings: { advisorModel: <a model alias> }", options: { settings: { advisorModel: "opus" } } },
  {
    label: "F settings.advisorModel with every builtin tool off",
    conditions: "settings: { advisorModel: <alias> }, tools: []",
    options: { settings: { advisorModel: "opus" }, tools: [] },
  },
  { label: "G extraArgs advisor flag", conditions: "extraArgs: { advisor: <alias> } (the CLI flag)", options: { extraArgs: { advisor: "opus" } } },
  {
    label: "H experimental env, no advisor model",
    conditions: "the documented experimental enable variable, with NO advisor model configured",
    env: { CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: "1" },
  },
  {
    label: "I the endpoint answers with an advisor server_tool_use block",
    conditions: "settings: { advisorModel: <alias> }; the fake replies with a server_tool_use block named advisor",
    options: { settings: { advisorModel: "opus" } },
    content: [{ type: "server_tool_use", id: "srvtoolu_d29_probe", name: "advisor", input: {} }, { type: "text", text: "ok" }],
  },
];

async function runCondition(sdk: { query: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>> }, binary: string, spec: ConditionSpec): Promise<ConditionResult> {
  const root = mkdtempSync(join(tmpdir(), "winter-d29-"));
  try {
    const home = mkdtempSync(join(root, "home-"));
    const claudeConfigDir = mkdtempSync(join(root, "config-"));
    const cwd = mkdtempSync(join(root, "cwd-"));
    return await withLoopbackFake(
      { routes: anthropicFake.anthropicFakeRoutes({ messages: scenarioForAnyModel(spec.content ?? [{ type: "text", text: "ok" }]) }) },
      async (fake) => {
        const entries: ConformanceTraceEntry[] = [];
        const abortController = new AbortController();
        const watchdog = setTimeout(() => abortController.abort(), CONDITION_TIMEOUT_MS);
        try {
          const query = sdk.query({
            prompt: "hi",
            options: {
              model: "sonnet",
              cwd,
              settingSources: [],
              // WS-14 §5.1 / R-7b-6: the package's own bundled runtime, never the user's.
              pathToClaudeCodeExecutable: binary,
              abortController,
              env: { ...officialCaptureEnv({ baseUrl: fake.url, claudeConfigDir, home }), ...spec.env },
              ...spec.options,
            },
          });
          for await (const message of query) {
            const type = String(message["type"]);
            const subtype = message["subtype"];
            entries.push({ sequence: entries.length, direction: "runtime-to-host", kind: type === "system" && typeof subtype === "string" ? `system/${subtype}` : type, payload: message });
          }
        } finally {
          clearTimeout(watchdog);
        }
        const normalized = normalizeTrace(entries);
        const init = normalized.find((entry) => entry.kind === "system/init");
        const initTools = Array.isArray((init?.payload as { tools?: unknown } | undefined)?.tools) ? ((init?.payload as { tools: string[] }).tools) : [];
        const wireTools = new Set<string>();
        for (const request of fake.requests) {
          if (request.path !== "/v1/messages" || request.body === "") continue;
          const body = JSON.parse(request.body) as { tools?: Array<{ type?: string; name?: string }> };
          for (const tool of body.tools ?? []) wireTools.add(tool.type === undefined ? String(tool.name) : `${tool.type}:${String(tool.name)}`);
        }
        const assistantBlocks: string[] = [];
        for (const entry of normalized) {
          if (entry.kind !== "assistant") continue;
          const content = (entry.payload as { message?: { content?: Array<{ type?: string; name?: string }> } }).message?.content ?? [];
          for (const block of content) assistantBlocks.push(block.name === undefined ? String(block.type) : `${String(block.type)}:${block.name}`);
        }
        const messagesRequest = fake.requests.find((request) => request.path === "/v1/messages");
        return {
          label: spec.label,
          conditions: spec.conditions,
          userAgent: messagesRequest?.headers["user-agent"] ?? "(none observed)",
          initTools,
          wireTools: [...wireTools],
          paths: [...new Set(fake.requests.map((r) => `${r.method} ${r.path}`))],
          assistantBlocks,
          kinds: normalized.map((entry) => entry.kind),
        };
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function prepareProbe(): Promise<Probe> {
  let sdkPackageDir: string;
  let sdkVersion: string;
  try {
    sdkPackageDir = dirname(Bun.resolveSync("@anthropic-ai/claude-agent-sdk/package.json", import.meta.dir));
    sdkVersion = String((await Bun.file(join(sdkPackageDir, "package.json")).json()).version);
  } catch (error) {
    return { ok: false, reason: `the optional official peer is not installed here (${error instanceof Error ? error.message : String(error)})` };
  }
  if (sdkVersion !== SUPPORTED.claudeAgentSdk) {
    return { ok: false, reason: `the resolved official SDK is ${sdkVersion}, not the pinned ${SUPPORTED.claudeAgentSdk} — a probe of the wrong artifact would be worse than none` };
  }
  const binary = resolvePinnedBinary(sdkPackageDir);
  if (binary === undefined) {
    return { ok: false, reason: `no runtime binary is installed for ${process.platform}-${process.arch} (the optional platform package for this host is absent)` };
  }
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as { query: (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>> };
  const results: ConditionResult[] = [];
  for (const spec of CONDITIONS) {
    try {
      const result = await runCondition(sdk, binary, spec);
      // A run that yields no `system/init` never really started; every later assertion would be
      // vacuously true, so the whole probe skips rather than passing on an empty inventory.
      if (result.kinds.includes("system/init")) results.push(result);
      else return { ok: false, reason: `condition ${spec.label} produced no system/init frame (kinds: ${result.kinds.join(", ") || "none"})` };
    } catch (error) {
      return { ok: false, reason: `condition ${spec.label} could not run: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  return { ok: true, sdkVersion, binary, results };
}

const probe = await prepareProbe();

describe("D29 — does the pinned official runtime expose an advisor server tool in an SDK session?", () => {
  if (!probe.ok) {
    console.log(`[d29] SKIPPED — ${probe.reason}`);
    test.skip(`the probe is skipped here: ${probe.reason}`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  const byLabel = (prefix: string): ConditionResult => {
    const found = probe.results.find((result) => result.label.startsWith(prefix));
    if (found === undefined) throw new Error(`no probe condition labelled ${prefix}`);
    return found;
  };

  test("the probe drove the PINNED artifact, over loopback only, and printed its inventories", () => {
    expect(probe.sdkVersion).toBe(SUPPORTED.claudeAgentSdk);
    expect(probe.binary).toContain("node_modules");
    for (const result of probe.results) {
      // Everything the runtime was GIVEN as an endpoint was the fake; these are the paths it used.
      for (const path of result.paths) expect(path.includes("/v1/") || path.includes("/api/")).toBe(true);
      console.log(`[d29] ${result.label}\n        conditions: ${result.conditions}\n        runtime user-agent: ${result.userAgent}\n        init.tools (${result.initTools.length}): ${result.initTools.join(", ")}\n        wire tools (${result.wireTools.length}): ${result.wireTools.join(", ")}\n        advisor on the wire: ${JSON.stringify(result.wireTools.filter((n) => ADVISOR.test(n)))}\n        assistant blocks: ${result.assistantBlocks.join(", ")}\n        fake saw: ${result.paths.join(" | ")}`);
    }
  });

  test("D29 — no condition puts an advisor tool in the session's advertised tool inventory", () => {
    // `system/init.tools` is the CLIENT-side inventory: what the host can allow, deny, alias or
    // rename. An advisor never appears in it under any of the nine conditions — which is exactly why
    // WS-14 §11's "toolAliases cannot intercept a server tool" holds.
    for (const result of probe.results) {
      expect({ label: result.label, advisor: result.initTools.filter((name) => ADVISOR.test(name)) }).toEqual({ label: result.label, advisor: [] });
    }
    // NOT VACUOUS: the default condition really did advertise a substantial inventory, and the one
    // empty inventory in the set is condition F, which asked for `tools: []`.
    expect(byLabel("A ").initTools.length).toBeGreaterThan(10);
    expect(probe.results.filter((result) => result.initTools.length === 0).map((result) => result.label)).toEqual([byLabel("F ").label]);
  });

  test("D29 — naming advisor in tools or allowedTools does not make it appear anywhere", () => {
    for (const prefix of ["B ", "C "]) {
      const result = byLabel(prefix);
      expect(result.initTools.filter((name) => ADVISOR.test(name))).toEqual([]);
      expect(result.wireTools.filter((name) => ADVISOR.test(name))).toEqual([]);
    }
  });

  test("D29 — with no advisor model configured the runtime sends no advisor tool to the endpoint", () => {
    for (const prefix of ["A ", "B ", "C ", "D ", "H "]) {
      const result = byLabel(prefix);
      expect({ label: result.label, advisor: result.wireTools.filter((name) => ADVISOR.test(name)) }).toEqual({ label: result.label, advisor: [] });
      // Not vacuous: the runtime really did send its ordinary tool set on the same request.
      expect(result.wireTools.length).toBeGreaterThan(0);
    }
  });

  test("D29 — configuring an advisor model adds a SERVER-tool schema to the endpoint request", () => {
    for (const prefix of ["E ", "F ", "G "]) {
      const result = byLabel(prefix);
      const advisor = result.wireTools.filter((name) => ADVISOR.test(name));
      expect({ label: result.label, count: advisor.length }).toEqual({ label: result.label, count: 1 });
      // A versioned server-tool `type` beside the bare `name` — the shape of an API-side tool, not of
      // a client tool the host could implement, alias or deny.
      expect(advisor[0]).toMatch(/^advisor_\d+:advisor$/);
      expect(result.initTools.filter((name) => ADVISOR.test(name))).toEqual([]);
    }
  });

  test("D29 — the advisor server tool is independent of the client tool set entirely", () => {
    // `tools: []` turns every builtin off. The advisor entry survives, and in that condition it is the
    // ONLY tool on the wire — so no allow/deny surface the host controls can remove it.
    const result = byLabel("F ");
    expect(result.initTools.length).toBe(0);
    expect(result.wireTools).toEqual([expect.stringMatching(/^advisor_\d+:advisor$/)]);
  });

  test("D29 — an advisor server_tool_use in the response reaches the SDK consumer verbatim", () => {
    // What a host's projector will actually see. It arrives as an assistant content block named
    // `advisor`, with no client-side tool ever having been advertised for it.
    const result = byLabel("I ");
    expect(result.assistantBlocks).toContain("server_tool_use:advisor");
  });
});
