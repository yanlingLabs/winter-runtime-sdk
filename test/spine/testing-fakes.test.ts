// SMOKE: `@yanlinglabs/winter-provider-conformance`'s loopback fakes load and bind, hermetically.
//
// Same narrow point as the conformance smoke: it proves the wiring, so that a lane's first real
// capture fails for its own reasons. What it additionally proves is the HERMETICITY SHAPE this phase
// requires — `127.0.0.1`, an ephemeral port, and a close in a `finally` — by standing a fake up,
// talking to it, and then showing the port is gone.
import { describe, expect, test } from "bun:test";

import { anthropicFake, HERMETIC_TRAFFIC_OPT_OUTS, officialCaptureEnv, openaiResponsesFake, requestsTo, withHermeticHomes, withLoopbackFake } from "../../src/testing/index.ts";
import { NON_CREDENTIAL_ENV_REGISTRY, buildOfficialChildEnv } from "../../src/official/index.ts";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

describe("the loopback fakes", () => {
  test("bind 127.0.0.1 on an ephemeral port, record what they receive, and close after the body", async () => {
    let url = "";
    const anthropic = await anthropicFake();
    const recorded = await withLoopbackFake(
      {
        routes: anthropic.anthropicFakeRoutes({
          messages: {
            "claude-sonnet-4-5": (): Response =>
              anthropic.anthropicTurnResponse({ model: "claude-sonnet-4-5", blocks: [{ type: "text", chunks: ["hello"] }] }),
          },
        }),
      },
      async (fake) => {
        url = fake.url;
        expect(fake.url.startsWith("http://127.0.0.1:")).toBe(true);
        const response = await fetch(`${fake.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": "sk-ant-fake" },
          body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }),
        });
        expect(response.status).toBe(200);
        await response.text();
        return requestsTo(fake, "/v1/messages");
      },
    );
    expect(recorded).toHaveLength(1);
    // The credential keeps its SCHEME and loses its material in the fake's own log -- the property
    // that makes a recorded request safe to print in a failure message.
    expect(recorded[0]?.headers["x-api-key"]).toBe("***");

    // CLOSED IN THE `finally`: nothing answers on that port any more.
    let stillUp = true;
    try {
      await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
    } catch {
      stillUp = false;
    }
    expect(stillUp).toBe(false);
  });

  test("a second family's fake is reachable through the same door (the barrel is not one-family)", async () => {
    // Named for what a lane will actually reach for: the Responses-API stream builder. Its shape
    // differs from the Anthropic family's (frames + a stream, rather than a route table), which is
    // exactly why this smoke names a real export rather than asserting the namespace is non-empty.
    const openai = await openaiResponsesFake();
    const anthropic = await anthropicFake();
    expect(typeof openai.responsesStream).toBe("function");
    expect(typeof openai.responsesFrames).toBe("function");
    expect(typeof anthropic.anthropicFakeRoutes).toBe("function");
  });

  test("the official-capture env is a REPLACEMENT, never a spread of process.env", async () => {
    await withHermeticHomes(async ({ home, claudeConfigDir }) => {
      const env = officialCaptureEnv({ baseUrl: "http://127.0.0.1:1", claudeConfigDir, home });
      expect(Object.keys(env).sort()).toEqual([
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
        "CLAUDE_CONFIG_DIR",
        "DISABLE_AUTOUPDATER",
        "DISABLE_ERROR_REPORTING",
        "DISABLE_TELEMETRY",
        "HOME",
      ]);
      expect(env["HOME"]).toBe(home);
      expect(env["CLAUDE_CONFIG_DIR"]).toBe(claudeConfigDir);
      // Neither points anywhere near a real home -- the whole reason both are set.
      expect(env["HOME"]?.includes("/.claude")).toBe(false);
      expect(env["CLAUDE_CONFIG_DIR"]?.includes("/.claude")).toBe(false);
    });
  });

  // ==================================================================================================
  // F-1 — THE ONLY ENDPOINT A CHILD RUNTIME MAY REACH IS THE FAKE.
  //
  // The fake proves the MODEL endpoint is loopback; nothing in it can prove the child made no OTHER
  // request, because those never pass through `ANTHROPIC_BASE_URL`. The pinned artifact fetches remote
  // feature configuration, telemetry, error reports and update checks from its own hosts, and the
  // measured consequence was not theoretical: the advertised tool inventory grew by four entries when
  // that fetch succeeded, so the branch's "what 0.3.250 does" proofs recorded a remotely-gated answer
  // and went red when the fetch timed out. The four opt-outs are therefore part of what "hermetic"
  // MEANS here, and this is the test that says so.
  // ==================================================================================================
  test("every traffic opt-out is set by default, and only an explicit flag removes them", async () => {
    await withHermeticHomes(async ({ home, claudeConfigDir }) => {
      const hermetic = officialCaptureEnv({ baseUrl: "http://127.0.0.1:1", claudeConfigDir, home });
      for (const [name, value] of Object.entries(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, value: hermetic[name] }).toEqual({ name, value });
      // The ONE escape hatch, spelled at its call site so a reader can see which legs are which.
      const permissive = officialCaptureEnv({ baseUrl: "http://127.0.0.1:1", claudeConfigDir, home, allowRemoteConfig: true });
      for (const name of Object.keys(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, present: name in permissive }).toEqual({ name, present: false });
      expect(Object.keys(permissive).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "HOME"]);
    });
  });

  test("the capture env's four ARE the production builder's four, by identity", () => {
    // R-7b-11 MOVED THEM. They used to be a test-only copy handed to `configuredExtras`; a copy is
    // exactly how a bed and a shipped session end up measuring two different artifacts, so the testing
    // constant is now a re-export of the one the env builder sets, and the builder sets it by default.
    const built = buildOfficialChildEnv({
      selection: { runtimeKind: "claude-agent", providerId: "anthropic", modelRef: "anthropic/claude-opus-5", family: "claude", authFamily: "api-key", sdkVersion: "0.0.2", reason: "f-1 fixture", decidedAt: new Date(0).toISOString() },
      configDir: "/tmp/f1-config",
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_API_KEY: "k" },
      base: { PATH: "/usr/bin:/bin", HOME: "/tmp/f1-home" },
    });
    // NO POLICY AT ALL — the default is what carries it.
    for (const [name, value] of Object.entries(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, value: built[name] }).toEqual({ name, value });
    // …and they are still names the pinned artifact's own registry declares, so they are not inert.
    const folded = new Set(NON_CREDENTIAL_ENV_REGISTRY.map((name) => name.toUpperCase()));
    for (const name of Object.keys(HERMETIC_TRAFFIC_OPT_OUTS)) expect({ name, declared: folded.has(name) }).toEqual({ name, declared: true });
  });

  test("withHermeticHomes removes what it created", async () => {
    let seen = "";
    await withHermeticHomes(async ({ home }) => {
      seen = home;
      expect(await Bun.file(`${home}/.keep`).exists()).toBe(false);
    });
    const { existsSync } = await import("node:fs");
    expect(existsSync(seen)).toBe(false);
  });
});
