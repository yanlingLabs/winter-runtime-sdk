// SMOKE: `@yanlinglabs/winter-provider-conformance`'s loopback fakes load and bind, hermetically.
//
// Same narrow point as the conformance smoke: it proves the wiring, so that a lane's first real
// capture fails for its own reasons. What it additionally proves is the HERMETICITY SHAPE this phase
// requires — `127.0.0.1`, an ephemeral port, and a close in a `finally` — by standing a fake up,
// talking to it, and then showing the port is gone.
import { describe, expect, test } from "bun:test";

import { anthropicFake, openaiResponsesFake, requestsTo, withHermeticHomes, withLoopbackFake } from "../../src/testing/index.ts";

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

  // WS-23: the official-capture environment (`officialCaptureEnv`, the four traffic opt-outs it set,
  // and their identity with the official child-env builder's) went with the official runtime.

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
