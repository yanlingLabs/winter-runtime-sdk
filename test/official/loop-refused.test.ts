// WS-21 §7.3 (d): `/loop` is refused on the official leg — typed, never a silent drop. The pinned
// runtime's `/loop` reads the repository's own `.claude/loop.md` whatever the setting sources are.
import { describe, expect, test } from "bun:test";
import { WinterCompatibilitySessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createOfficialInputStream, createRuntimeSdk, RunHomeError, type RuntimeSdkPeers } from "../../src/index.ts";
import { isLoopCommand } from "../../src/door.ts";
import type { OfficialQuery } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "loop",
  decidedAt: new Date(0).toISOString(),
};

describe("/loop on the official leg", () => {
  test("the command is recognised as a command, never as a word inside a turn", () => {
    for (const text of ["/loop", "/loop 5m check the build", "  /loop\tnow", "/loop\n"]) expect([text, isLoopCommand(text)]).toEqual([text, true]);
    for (const text of ["/looping", "please /loop", "/Loop", "loop", "/loops 5m"]) expect([text, isLoopCommand(text)]).toEqual([text, false]);
  });

  test("a streamed `/loop` turn is refused at `push`, typed, and the stream stays usable", async () => {
    const stream = createOfficialInputStream();
    const refused = await stream.push("/loop 5m x").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RunHomeError);
    expect((refused as RunHomeError).code).toBe("loop_refused");
    expect(stream.closed).toBe(false);
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await stream.push("hello");
    expect(await next).toEqual({ value: "hello", done: false });
  });

  test("a one-shot `/loop` prompt is refused synchronously, before a leg opens", () => {
    const { peer } = createFakeWinterPeer();
    const launched: unknown[] = [];
    const claude = {
      version: "0.3.250",
      query(params: unknown): OfficialQuery {
        launched.push(params);
        throw new Error("never launched");
      },
    };
    const sdk = createRuntimeSdk({ peers: { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"], claude }, keychain: createFakeKeychain(), vendoredOfficialRuntime: "/vendored/claude" });
    let caught: unknown;
    try {
      sdk.query({ prompt: "/loop 5m check", options: { cwd: "/w", runtime: { selection, official: { sessionId: "s-loop", base: { HOME: "/h" } } } } });
    } catch (error) {
      caught = error;
    }
    expect((caught as RunHomeError).code).toBe("loop_refused");
    expect(launched).toHaveLength(0);
  });
});
