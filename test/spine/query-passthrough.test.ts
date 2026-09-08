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
