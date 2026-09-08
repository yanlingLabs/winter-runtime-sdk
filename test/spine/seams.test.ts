// THE SEAMS: final signatures, honest stubs, and one store that is fully real.
//
// The spine's promise to four parallel lanes is "your signature will not move". The promise back is
// "nothing pretends to work". This file holds both to account: every stub throws a typed
// `NotImplementedYet` naming its own lane, and the in-memory `RuntimeDirectoryStore` — the default,
// and the store every hermetic test uses — behaves like a store rather than like a placeholder.
import { describe, expect, test } from "bun:test";

import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { createInMemoryRuntimeDirectoryStore, createRuntimeSdk, runtimeSdkInternals } from "../../src/index.ts";
import { NotImplementedYet } from "../../src/errors.ts";
import { stubGlobalMessaging, stubHandoffBarrier, stubMaterializedResumeDecorator, stubOfficialAdapter, stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import type { SessionKey } from "@yanlinglabs/winter-agent-sdk";

const keychain = createFakeKeychain();

const selection = (): RuntimeSelection => ({
  runtimeKind: "winter-agent",
  providerId: "anthropic",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "fixture",
  decidedAt: new Date(0).toISOString(),
});

const entry = (address: string): RuntimeDirectoryEntry => ({
  address,
  parsed: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: address.replace("session:", "") },
  runtimeKind: "winter-agent",
  objectKind: "session",
  status: "running",
  mode: "code",
  generation: 1,
  selection: selection(),
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: new Date(0).toISOString(),
});

/** Collects the lane of every `NotImplementedYet` a thunk throws (sync or async). */
async function laneOfThrow(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof NotImplementedYet) return error.lane;
    throw error;
  }
  throw new Error("expected NotImplementedYet, nothing was thrown");
}

describe("every stub throws NotImplementedYet, naming its lane", () => {
  test("the official adapter is Lane A's, including the spawn proxy", async () => {
    const adapter = stubOfficialAdapter();
    expect(await laneOfThrow(() => adapter.launch({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.resume({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.buildOptions({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.buildChildEnv({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.spawnProxy({} as never))).toBe("lane-a");
  });

  test("the directory and the messaging router are Lane B's", async () => {
    const directory = stubRuntimeDirectory(createInMemoryRuntimeDirectoryStore());
    for (const call of [
      () => directory.list(),
      () => directory.get("session:x"),
      () => directory.record(entry("session:x")),
      () => directory.forget("session:x"),
      () => directory.resolve("someone", { from: entry("session:x").parsed }),
      () => directory.recover(),
    ]) {
      expect(await laneOfThrow(call)).toBe("lane-b");
    }
    const messaging = stubGlobalMessaging();
    for (const call of [
      () => messaging.listReachable({ from: entry("session:x").parsed }),
      () => messaging.send({ from: entry("session:x").parsed, to: "someone", body: "hi" }),
      () => messaging.deliver({} as never),
      () => messaging.notifyWhenIdle(entry("session:x").parsed, { from: entry("session:y").parsed, messageId: "m" }),
      () => messaging.senderPermissionClass(entry("session:x").parsed),
      () => messaging.registerAdapter("winter-agent", {} as never),
    ]) {
      expect(await laneOfThrow(call)).toBe("lane-b");
    }
  });

  test("the barrier and the decorator are Lane C's -- but the decorator's DOOR already answers", async () => {
    const barrier = stubHandoffBarrier();
    const key: SessionKey = { projectKey: "p", sessionId: "s" };
    expect(await laneOfThrow(() => barrier.plan(key, "claude-agent"))).toBe("lane-c");
    expect(await laneOfThrow(() => barrier.execute({} as never))).toBe("lane-c");

    const decorator = stubMaterializedResumeDecorator();
    // WS-13 §8.2 makes FALLBACK the always-available door and PREFERRED the one four probes open.
    // "Which door is open" has a correct answer before Lane C lands, and reporting "preferred" would
    // be the lie -- so this one is a value, not a throw.
    expect(decorator.door).toBe("fallback");
    expect(await laneOfThrow(() => decorator.probe())).toBe("lane-c");
    expect(await laneOfThrow(() => decorator.decorate({} as never))).toBe("lane-c");
  });

  test("selection is Lane D's, through the handle as well as the function", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    expect(await laneOfThrow(() => sdk.selectRuntime({} as never))).toBe("lane-d");
  });

  test("the handle's handoff() reaches Lane C's barrier", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    expect(await laneOfThrow(() => sdk.handoff({ projectKey: "p", sessionId: "s" }, "claude-agent"))).toBe("lane-c");
  });

  test("a NotImplementedYet says what it is about, not just that it is missing", () => {
    const error = new NotImplementedYet("lane-a", "OfficialAdapter.launch (WS-14 §1)");
    expect(error.seam).toBe("OfficialAdapter.launch (WS-14 §1)");
    expect(error.message).toContain("Phase 7b lane-a owns it");
    expect(error.name).toBe("NotImplementedYet");
  });
});

describe("the in-memory RuntimeDirectoryStore is the real thing", () => {
  test("entries round-trip, upsert replaces, remove removes", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    expect(await store.load()).toEqual([]);
    await store.upsert(entry("session:a"));
    await store.upsert(entry("session:b"));
    expect((await store.load()).map((e) => e.address).sort()).toEqual(["session:a", "session:b"]);
    await store.upsert({ ...entry("session:a"), status: "idle" });
    expect((await store.load()).filter((e) => e.address === "session:a")[0]?.status).toBe("idle");
    await store.remove("session:a");
    expect((await store.load()).map((e) => e.address)).toEqual(["session:b"]);
  });

  test("a loaded entry is a COPY -- mutating it does not edit the store behind its own back", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    await store.upsert(entry("session:a"));
    const loaded = (await store.load())[0]!;
    loaded.status = "exited";
    loaded.selection.providerId = "somewhere-else";
    const again = (await store.load())[0]!;
    expect(again.status).toBe("running");
    expect(again.selection.providerId).toBe("anthropic");
  });

  test("cursors round-trip and enumerate", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    expect(await store.cursors.get("session:a")).toBeUndefined();
    await store.cursors.set("session:a", "seq-7");
    await store.cursors.set("session:b", "seq-9");
    expect(await store.cursors.get("session:a")).toBe("seq-7");
    expect(await store.cursors.all()).toEqual({ "session:a": "seq-7", "session:b": "seq-9" });
    await store.cursors.remove("session:a");
    expect(await store.cursors.all()).toEqual({ "session:b": "seq-9" });
  });

  test("held messages: hold, list, take once, clear, and the receiver sweep", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const message = {
      messageId: "m1",
      from: entry("session:a").parsed,
      fromGeneration: 1,
      to: entry("session:b").parsed,
      toGeneration: 1,
      body: "hi",
      notifyWhenIdle: false,
      createdAt: 0,
      expiresAt: 0,
      hopCount: 0,
      senderPermissionClass: "prompts" as const,
    };
    await store.mailboxes.hold({ messageId: "m1", receiver: "session:b", reason: "default-class", kind: "default", heldAt: 0, message });
    expect(await store.mailboxes.receivers()).toEqual(["session:b"]);
    expect((await store.mailboxes.listHeld("session:b")).map((r) => r.messageId)).toEqual(["m1"]);
    expect((await store.mailboxes.takeHeld("session:b", "m1"))?.message.body).toBe("hi");
    // Taken ONCE: WS-10 §12's "a retry with the same id returns the stored outcome" is the router's
    // rule, but the store must not hand the same held message out twice.
    expect(await store.mailboxes.takeHeld("session:b", "m1")).toBeUndefined();
    expect(await store.mailboxes.receivers()).toEqual([]);
    await store.mailboxes.hold({ messageId: "m2", receiver: "session:b", reason: "explicit", kind: "explicit", heldAt: 0, message });
    await store.mailboxes.clear("session:b");
    expect(await store.mailboxes.listHeld("session:b")).toEqual([]);
  });

  test("the store enforces NO policy -- caps and expiry belong to the router (Lane B)", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const message = {
      messageId: "m",
      from: entry("session:a").parsed,
      fromGeneration: 1,
      to: entry("session:b").parsed,
      toGeneration: 1,
      body: "hi",
      notifyWhenIdle: false,
      createdAt: 0,
      expiresAt: 0,
      hopCount: 0,
      senderPermissionClass: "prompts" as const,
    };
    for (let i = 0; i < 150; i++) {
      await store.mailboxes.hold({ messageId: `m${i}`, receiver: "session:b", reason: "r", kind: "default", heldAt: 0, message });
    }
    // 150 > WS-10 §13's held cap of 100, ON PURPOSE: a cap enforced here would be a second, invisible
    // copy of a rule the router has to apply anyway (it owes the visible refusal), and the two would
    // drift. The store is a sink.
    expect(await store.mailboxes.listHeld("session:b")).toHaveLength(150);
  });
});

describe("the handle's internals are reachable for the lanes' own wiring", () => {
  test("`runtimeSdkInternals` hands back the seams and the injected collaborators", () => {
    const { peer } = createFakeWinterPeer();
    const store = createInMemoryRuntimeDirectoryStore();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, directoryStore: store, vendoredOfficialRuntime: "/vendored/winter" });
    const internals = runtimeSdkInternals(sdk);
    expect(internals?.directoryStore).toBe(store);
    expect(internals?.keychain).toBe(keychain);
    expect(internals?.peers.winter).toBe(peer);
    expect(internals?.vendoredOfficialRuntime).toBe("/vendored/winter");
    expect(runtimeSdkInternals({} as never)).toBeUndefined();
  });

  test("with no store injected, the default is the in-memory one", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const internals = runtimeSdkInternals(sdk);
    expect(await internals?.directoryStore.load()).toEqual([]);
  });
});
