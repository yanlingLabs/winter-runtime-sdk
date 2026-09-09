// THE DOOR PASSES THROUGH VERBATIM.
//
// "A selector + adapter, never a translation layer: the pinned `query()`/`Options`/`SDKMessage`
// contract passes through verbatim plus runtime-selection inputs." Deep equality would not prove
// that — a router that rebuilt every option into a structurally identical object would pass a
// deep-equal test while having quietly decided which members it knows about. So these assertions are
// about IDENTITY: the same prompt object, the same option VALUES, and the same message objects out of
// the stream.
import { describe, expect, test } from "bun:test";

import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { createRuntimeSdk, forwardableOptions, ROUTER_ONLY_OPTION_KEYS } from "../../src/index.ts";
import { RuntimeSdkDisposedError } from "../../src/errors.ts";
import type { RouterOptions } from "../../src/sdk.ts";
import type { SdkMessage } from "@yanlinglabs/winter-agent-sdk";
import { RuntimeHandoffRequiredError, RuntimeLaunchInputError } from "../../src/errors.ts";
import type { RuntimeSelection, SelectionInput } from "../../src/selection/runtime-selection.ts";
import { NOW, VERSIONS, credentials, listing } from "../selection/fixtures.ts";

const keychain = createFakeKeychain();

describe("query(): options", () => {
  test("with no router-owned key, the caller's OWN object is forwarded, by reference", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const options: RouterOptions = { model: "some-model", cwd: "/tmp/nowhere", allowedTools: ["Read"] };
    sdk.query({ prompt: "hello", options });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toBe(options);
  });

  test("a router-owned key is stripped, and every other member keeps its own value identity", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const env = { PATH: "/usr/bin" };
    const options: RouterOptions = {
      model: "some-model",
      env,
      runtime: {},
    };
    sdk.query({ prompt: "hello", options });
    const forwarded = calls[0]?.options as Record<string, unknown>;
    expect(forwarded).not.toBe(options);
    expect("runtime" in forwarded).toBe(false);
    expect(forwarded["model"]).toBe("some-model");
    // The SAME env object, not a copy of it.
    expect(forwarded["env"]).toBe(env);
    expect(Object.keys(forwarded).sort()).toEqual(["env", "model"]);
  });

  test("no options at all forwards an empty object -- the Winter door requires one", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    sdk.query({ prompt: "hello" });
    expect(calls[0]?.options).toEqual({});
  });

  test("`forwardableOptions` is the one place the rule lives, and it is exported", () => {
    expect(ROUTER_ONLY_OPTION_KEYS).toEqual(["runtime"]);
    const plain = { model: "m" };
    expect(forwardableOptions(plain)).toBe(plain);
    const withRouterKey = { model: "m", runtime: {} };
    expect(forwardableOptions(withRouterKey)).toEqual({ model: "m" });
  });
});

describe("query(): prompt and stream", () => {
  test("a string prompt is forwarded unchanged", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    sdk.query({ prompt: "the exact prompt" });
    expect(calls[0]?.prompt).toBe("the exact prompt");
  });

  test("an async-iterable prompt is forwarded BY REFERENCE -- never drained, never re-wrapped", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    let drained = false;
    const prompt = (async function* () {
      drained = true;
      yield "one";
    })();
    sdk.query({ prompt });
    expect(calls[0]?.prompt).toBe(prompt);
    // The router must not have consumed a single element on the way past.
    expect(drained).toBe(false);
    const first = await prompt.next();
    expect(first.value).toBe("one");
  });

  test("the message stream yields the peer's OWN objects, in order", async () => {
    const scripted = [
      { type: "system", subtype: "init" } as unknown as SdkMessage,
      { type: "assistant" } as unknown as SdkMessage,
      { type: "result", subtype: "success" } as unknown as SdkMessage,
    ];
    const { peer } = createFakeWinterPeer({ messages: scripted });
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const seen: SdkMessage[] = [];
    for await (const message of sdk.query({ prompt: "hello" })) seen.push(message);
    expect(seen).toHaveLength(3);
    for (let i = 0; i < scripted.length; i++) expect(seen[i]).toBe(scripted[i]);
  });

  test("the returned handle IS the peer's `Query` -- its methods are not shadowed", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const query = sdk.query({ prompt: "hello" });
    // The fake rejects every non-scripted `Query` method by name; a wrapper that swallowed the call
    // (or answered it itself) would not produce this message.
    await expect(query.interrupt()).rejects.toThrow(/Query.interrupt\(\) is not scripted/);
  });
});

describe("dispose()", () => {
  test("is idempotent, and a later query() fails as itself", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    await sdk.dispose();
    await sdk.dispose();
    expect(() => sdk.query({ prompt: "hello" })).toThrow(RuntimeSdkDisposedError);
  });
});

// ====================================================================================================
// TASK 6b — THE DOOR DECIDES, AND SERVES BOTH RUNTIMES.
//
// F-4's finding was that `query()` STRIPPED the selection: a host passing the persisted choice the
// whole selection lane exists to honour (`runtime.selection = { runtimeKind: "claude-agent", … }`) got
// a WINTER session, with no error, no diagnostic and no record of which runtime ran — D13's "never a
// silent rewrite" broken at the one door. The fix wave made that a typed refusal; this routes it.
//
// THE PASS-THROUGH IS UNCHANGED for the Winter leg, which is what the rest of this file pins: the
// additive key is still stripped, the options object is still forwarded by identity when there is
// nothing to remove, and a query with no selection input at all still just goes. The tests below add
// the OTHER half — that a claude-agent selection does not reach the Winter peer, and that the door
// refuses rather than guesses what only a host can tell it.
// ====================================================================================================
describe("Task 6b — a claude-agent selection leaves the Winter leg alone", () => {
  const selectionFor = (runtimeKind: "winter-agent" | "claude-agent"): RuntimeSelection => ({
    runtimeKind,
    providerId: "anthropic",
    modelRef: "anthropic/claude-opus-5",
    family: "claude",
    authFamily: "api-key",
    sdkVersion: "0.0.2",
    reason: "door fixture",
    decidedAt: new Date(0).toISOString(),
  });

  test("a persisted `claude-agent` selection never reaches the Winter peer", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    // No `runtime.official` at all: the door needs the session id its directory row is addressed by,
    // and refuses rather than inventing one. THE POINT: before F-4 this produced a Winter session.
    expect(() => sdk.query({ prompt: "hello", options: { runtime: { selection: selectionFor("claude-agent") } } })).toThrow(RuntimeLaunchInputError);
    expect(calls).toHaveLength(0);
  });

  test("the refusal names the field a host must supply, and why the Winter leg needs none of it", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    try {
      sdk.query({ prompt: "hello", options: { runtime: { selection: selectionFor("claude-agent") } } });
      throw new Error("unreachable: the query should have refused");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeLaunchInputError);
      expect((error as RuntimeLaunchInputError).field).toBe("runtime.official");
      expect((error as Error).message).toContain("session id");
    }
  });

  test("a `select` input is DECIDED, and a decision of claude-agent takes the official leg", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const select: SelectionInput = {
      mode: "code",
      requested: { provider: "anthropic", model: "anthropic/claude-opus-5" },
      families: listing("claude"),
      credentials: credentials(["anthropic"]),
      hasClaudePeer: true,
      claudeOauthApproved: false,
      versions: VERSIONS,
      now: NOW,
    };
    // The same input decided outside the door, so the test knows what it is asserting about.
    expect(sdk.selectRuntime(select).runtimeKind).toBe("claude-agent");
    expect(() => sdk.query({ prompt: "hello", options: { runtime: { select } } })).toThrow(RuntimeLaunchInputError);
    expect(calls).toHaveLength(0);
  });

  test("a `winter-agent` selection goes through, and the router's own key is still stripped", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "hello", options: { model: "sonnet", runtime: { selection: selectionFor("winter-agent") } } })) void _;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).not.toHaveProperty("runtime");
    expect(calls[0]?.options).toMatchObject({ model: "sonnet" });
  });

  test("no selection input at all is unchanged — the door does not invent a decision", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "hello" })) void _;
    expect(calls).toHaveLength(1);
  });
});

// ====================================================================================================
// BRIEF ITEM 2 — A RUNTIME CHANGE MID-SESSION IS A HANDOFF, NEVER A REWRITE.
//
// `runtime.selection` is documented as "already persisted for this session", so a selection that
// disagrees with the session's record is a REQUEST TO CHANGE RUNTIME. D13 answers that with the
// certified handoff or a visible fork; serving the new runtime on the old transcript is the one answer
// that destroys evidence, because the transcript then contains turns from a runtime that never wrote
// any of it. The door refuses in-process on both legs (below) and, on the official leg, against the
// DURABLE directory row before a credential is read (`test/door/official-leg.test.ts`).
// ====================================================================================================
describe("Task 6b — a mid-session runtime change is `handoff-required`", () => {
  const selectionFor = (runtimeKind: "winter-agent" | "claude-agent"): RuntimeSelection => ({
    runtimeKind,
    providerId: "anthropic",
    modelRef: "anthropic/claude-opus-5",
    family: "claude",
    authFamily: "api-key",
    sdkVersion: "0.0.2",
    reason: "door fixture",
    decidedAt: new Date(0).toISOString(),
  });

  test("a second query naming the other runtime is refused, and points at `sdk.handoff()`", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "one", options: { runtime: { sessionId: "s-1", selection: selectionFor("winter-agent") } } })) void _;
    expect(calls).toHaveLength(1);
    try {
      sdk.query({ prompt: "two", options: { runtime: { sessionId: "s-1", selection: selectionFor("claude-agent"), official: { sessionId: "s-1" } } } });
      throw new Error("unreachable: the change should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeHandoffRequiredError);
      expect((error as RuntimeHandoffRequiredError).from).toBe("winter-agent");
      expect((error as RuntimeHandoffRequiredError).to).toBe("claude-agent");
      expect((error as Error).message).toContain("sdk.handoff");
    }
    // NOTHING WAS SERVED: the refusal is before the peer, not after it.
    expect(calls).toHaveLength(1);
  });

  test("the SAME runtime twice is not a change", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "one", options: { runtime: { sessionId: "s-2", selection: selectionFor("winter-agent") } } })) void _;
    for await (const _ of sdk.query({ prompt: "two", options: { runtime: { sessionId: "s-2", selection: selectionFor("winter-agent") } } })) void _;
    expect(calls).toHaveLength(2);
  });

  // ==================================================================================================
  // REVIEW r1, I-1 — THE LEDGER RECORDS A LEG THAT OPENED, NEVER A DECISION THAT WAS THEN REFUSED.
  //
  // It used to be written the moment `query()` decided, which poisoned it on every path that then
  // refused. The session was wedged on BOTH legs: the official one by whatever refused it, the Winter
  // one by a ledger that named a runtime the session had never run on — and `sdk.handoff()` cannot
  // move a session that was never there.
  // ==================================================================================================
  test("a claude-agent query that REFUSED for want of `runtime.official` does not wedge the Winter leg", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    expect(() => sdk.query({ prompt: "one", options: { runtime: { sessionId: "led-1", selection: selectionFor("claude-agent") } } })).toThrow(RuntimeLaunchInputError);
    // THE POINT: nothing was served, so nothing is persisted — and the session's own correct runtime
    // is still available to it.
    for await (const _ of sdk.query({ prompt: "two", options: { runtime: { sessionId: "led-1", selection: selectionFor("winter-agent") } } })) void _;
    expect(calls).toHaveLength(1);
  });

  test("the ledger is keyed by ADDRESS: a session `x` and a child `x` of some parent do not collide", async () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "one", options: { runtime: { sessionId: "x", selection: selectionFor("winter-agent") } } })) void _;
    // `agent:p:x` is a different object from `session:x` — the claude child of a Winter parent
    // (R-7b-1). Before L-3 the bare id `x` made these one slot, and the second call was refused
    // outright. The official leg is deferred, so the refusal (or its absence) is on the first pull.
    const child = sdk.query({ prompt: "two", options: { cwd: "/work", runtime: { selection: selectionFor("claude-agent"), official: { sessionId: "x", parentSessionId: "p" } } } });
    const failure: unknown = await (async (): Promise<unknown> => {
      try {
        for await (const _ of child as AsyncIterable<unknown>) void _;
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    // It fails for want of a vendored runtime — NOT because the ledger thought this address was Winter.
    expect(failure).not.toBeInstanceOf(RuntimeHandoffRequiredError);
    expect((failure as Error).message).toContain("WinterCompatibilitySessionStore");
    expect(calls).toHaveLength(1);
  });

  test("without a session id the door has nothing to hold a caller to, and says nothing", async () => {
    // The honest boundary: the ledger is keyed by session, and a caller that names no session is
    // asking for a fresh one. This test exists so the boundary is a decision rather than a gap.
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    for await (const _ of sdk.query({ prompt: "one", options: { runtime: { selection: selectionFor("winter-agent") } } })) void _;
    for await (const _ of sdk.query({ prompt: "two", options: { runtime: { selection: selectionFor("winter-agent") } } })) void _;
    expect(calls).toHaveLength(2);
  });
});
