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
import { HandoffPlanError } from "../../src/store/index.ts";
import { stubGlobalMessaging, stubHandoffBarrier, stubMaterializedResumeDecorator, stubOfficialAdapter, stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { SeamContext, SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { DeliveryRecord, IdleSubscriptionRecord, NameLeaseRecord, RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import type { GlobalAgentMessage } from "../../src/seams/messaging-contract.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { WINTER_BRAND, type SessionKey } from "@yanlinglabs/winter-agent-sdk";

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
  transport: "winter-session",
  status: "running",
  mode: "code",
  generation: 1,
  selection: selection(),
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: new Date(0).toISOString(),
});

/** A context with the shape every seam factory takes, over an in-memory store and a fake peer. */
function seamContext(): SeamContextWithDirectory {
  const { peer } = createFakeWinterPeer();
  const base: SeamContext = { peers: { winter: peer }, keychain, brand: WINTER_BRAND, directoryStore: createInMemoryRuntimeDirectoryStore() };
  return { ...base, directory: stubRuntimeDirectory(base) };
}

const message = (): GlobalAgentMessage => ({
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
  senderPermissionClass: "prompts",
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
  test("the official adapter STUB is Lane A's, including the spawn proxy", async () => {
    const adapter = stubOfficialAdapter(seamContext());
    expect(await laneOfThrow(() => adapter.launch({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.resume({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.buildOptions({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.buildChildEnv({} as never))).toBe("lane-a");
    expect(await laneOfThrow(() => adapter.spawnProxy({} as never))).toBe("lane-a");
  });

  test("…but the WIRED official seam is Lane A's real adapter — the stub above is no longer constructed", () => {
    // Review r2, NEW-8. This file's header promises "nothing pretends to work", and it verified that
    // by calling `stubOfficialAdapter` DIRECTLY — which stayed true after `src/sdk.ts` stopped wiring
    // it, so the assertion was about a factory nothing constructs. Both facts are now stated: the stub
    // is still honest, and the handle no longer uses it.
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const official = runtimeSdkInternals(sdk)?.official;
    expect(official).toBeDefined();
    // A real adapter builds options; the stub throws `NotImplementedYet` from every member.
    expect(() => official?.buildChildEnv({} as never)).not.toThrow(NotImplementedYet);
  });

  test("the directory and the messaging router are Lane B's", async () => {
    const directory = stubRuntimeDirectory(seamContext());
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
    const messaging = stubGlobalMessaging(seamContext());
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
    const barrier = stubHandoffBarrier(seamContext());
    const key: SessionKey = { projectKey: "p", sessionId: "s" };
    expect(await laneOfThrow(() => barrier.plan(key, "claude-agent"))).toBe("lane-c");
    expect(await laneOfThrow(() => barrier.execute({} as never))).toBe("lane-c");

    const decorator = stubMaterializedResumeDecorator(seamContext());
    // WS-13 §8.2 makes FALLBACK the always-available door and PREFERRED the one four probes open.
    // "Which door is open" has a correct answer before Lane C lands, and reporting "preferred" would
    // be the lie -- so this one is a value, not a throw.
    expect(decorator.door).toBe("fallback");
    expect(await laneOfThrow(() => decorator.probe())).toBe("lane-c");
    expect(await laneOfThrow(() => decorator.decorate({} as never))).toBe("lane-c");
  });

  // LANE D HAS LANDED, so this seam no longer throws `NotImplementedYet` — it answers. The stub
  // assertion that stood here is replaced by the one property of the seam this file still owns: the
  // handle's `selectRuntime` is wired to the real selector rather than to a stub. The selector's own
  // behaviour (the D13/D28 table, the refusals, the persisted choice) is proven in
  // `test/selection/select-runtime.test.ts`, and the handle's throw-on-refusal contract in that same
  // file's "the handle's selectRuntime throws the refusal that the function returns".
  test("selection is Lane D's, and the handle now reaches the landed selector", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const decided = sdk.selectRuntime({
      mode: "code",
      requested: { model: "m-1" },
      families: {
        active: undefined,
        families: [
          {
            id: "other",
            displayName: "other",
            vendor: "(various)",
            slots: [],
            models: [{ canonicalModelId: "m-1", displayName: "m-1", rows: [{ key: "local/m-1", providerId: "local", status: "candidate", pricingBasis: "free", servable: "present" }] }],
          },
        ],
      },
      credentials: { byProvider: { local: "none" } },
      hasClaudePeer: false,
      claudeOauthApproved: false,
    });
    expect(decided.runtimeKind).toBe("winter-agent");
    expect(decided.providerId).toBe("local");
  });

  // LANE C HAS LANDED (controller wiring): the handle's `handoff()` reaches the real barrier, whose
  // `plan()` refuses a session the directory has never heard of with a typed `HandoffPlanError` --
  // not a `NotImplementedYet`. The barrier's own behaviour is proven in `test/store/`.
  test("the handle's handoff() reaches Lane C's barrier", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    await expect(sdk.handoff({ projectKey: "p", sessionId: "s" }, "claude-agent")).rejects.toThrow(HandoffPlanError);
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

  test("the observed CLAUDE_CONFIG_DIR and the child's process identity round-trip (NEW-1)", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    // What Lane A's spawn proxy records BEFORE it returns the process (WS-14 §6 rule 2 / §9).
    await store.upsert({
      ...entry("session:a"),
      transport: "claude-handle",
      runtimeKind: "claude-agent",
      configDir: "/var/folders/tmp/claude-resume-9f2c",
      processIdentity: { pid: 4242, startedAt: new Date(1000).toISOString() },
    });
    const loaded = (await store.load())[0]!;
    expect(loaded.configDir).toBe("/var/folders/tmp/claude-resume-9f2c");
    // PID **plus** start identity -- a bare pid is a lie the moment the OS recycles it.
    expect(loaded.processIdentity).toEqual({ pid: 4242, startedAt: new Date(1000).toISOString() });

    // WS-15 §6.4 step 2's read: a previously live handle is marked unavailable until process identity
    // revalidates -- which is only expressible because both facts survived the restart.
    const revalidates = (e: typeof loaded, observed: { pid: number; startedAt: string }): boolean =>
      e.processIdentity?.pid === observed.pid && e.processIdentity?.startedAt === observed.startedAt;
    expect(revalidates(loaded, { pid: 4242, startedAt: new Date(1000).toISOString() })).toBe(true);
    // A RECYCLED pid with a different start time does NOT revalidate. This is the whole reason the
    // field is a pair.
    expect(revalidates(loaded, { pid: 4242, startedAt: new Date(9999).toISOString() })).toBe(false);
  });

  test("WS-14 §6 rule 5: the recorded root is CLEARED after verified cleanup, and only then", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const recorded = { ...entry("session:a"), runtimeKind: "claude-agent" as const, transport: "claude-handle" as const, configDir: "/tmp/claude-resume-1" };
    await store.upsert(recorded);
    expect((await store.load())[0]?.configDir).toBe("/tmp/claude-resume-1");
    const { configDir: _cleared, ...afterCleanup } = recorded;
    await store.upsert(afterCleanup);
    expect((await store.load())[0]?.configDir).toBeUndefined();
  });

  test("both are ABSENT for an in-daemon object -- a `winter-thread` has no child at all", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    await store.upsert({ ...entry("session:a"), transport: "winter-thread" });
    const loaded = (await store.load())[0]!;
    expect(loaded.configDir).toBeUndefined();
    expect(loaded.processIdentity).toBeUndefined();
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

  test("...including the NESTED process identity (NEW-1's field is an object, not a scalar)", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    await store.upsert({ ...entry("session:a"), processIdentity: { pid: 1, startedAt: new Date(0).toISOString() } });
    const loaded = (await store.load())[0]!;
    loaded.processIdentity!.pid = 999;
    expect((await store.load())[0]?.processIdentity?.pid).toBe(1);
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
    await store.mailboxes.hold({ messageId: "m1", receiver: "session:b", reason: "default-class", kind: "default", heldAt: 0, message: message() });
    expect(await store.mailboxes.receivers()).toEqual(["session:b"]);
    expect((await store.mailboxes.listHeld("session:b")).map((r) => r.messageId)).toEqual(["m1"]);
    expect((await store.mailboxes.takeHeld("session:b", "m1"))?.message.body).toBe("hi");
    // Taken ONCE: WS-10 §12's "a retry with the same id returns the stored outcome" is the router's
    // rule, but the store must not hand the same held message out twice.
    expect(await store.mailboxes.takeHeld("session:b", "m1")).toBeUndefined();
    expect(await store.mailboxes.receivers()).toEqual([]);
    await store.mailboxes.hold({ messageId: "m2", receiver: "session:b", reason: "explicit", kind: "explicit", heldAt: 0, message: message() });
    await store.mailboxes.clear("session:b");
    expect(await store.mailboxes.listHeld("session:b")).toEqual([]);
  });

  test("the store enforces NO policy -- caps and expiry belong to the router (Lane B)", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    for (let i = 0; i < 150; i++) {
      await store.mailboxes.hold({ messageId: `m${i}`, receiver: "session:b", reason: "r", kind: "default", heldAt: 0, message: message() });
    }
    // 150 > WS-10 §13's held cap of 100, ON PURPOSE: a cap enforced here would be a second, invisible
    // copy of a rule the router has to apply anyway (it owes the visible refusal), and the two would
    // drift. The store is a sink.
    expect(await store.mailboxes.listHeld("session:b")).toHaveLength(150);
  });
});

describe("the durable sinks WS-15 §6.2-6.4 needs (I1)", () => {
  const delivery = (messageId: string, overrides: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
    messageId,
    message: { ...message(), messageId },
    toGeneration: 1,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });

  test("a delivery record round-trips, and a retry reads the STORED outcome", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    expect(await store.deliveries.get("m1")).toBeUndefined();
    // WS-15 §6.2's order: the id and the envelope are persisted BEFORE resolution, so even an
    // ambiguous or not-found outcome is idempotent.
    await store.deliveries.put(delivery("m1"));
    expect((await store.deliveries.get("m1"))?.message.body).toBe("hi");
    await store.deliveries.put(delivery("m1", { claimedBy: "winter-agent", outcome: { status: "delivered", messageId: "m1" } }));
    expect((await store.deliveries.get("m1"))?.outcome).toEqual({ status: "delivered", messageId: "m1" });
  });

  test("claimed-but-unreceipted is exactly the crash window, and nothing else", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    await store.deliveries.put(delivery("never-claimed"));
    await store.deliveries.put(delivery("claimed", { claimedBy: "claude-agent" }));
    await store.deliveries.put(delivery("receipted", { claimedBy: "winter-agent", outcome: { status: "queued", messageId: "receipted" } }));
    expect((await store.deliveries.claimedWithoutReceipt()).map((r) => r.messageId)).toEqual(["claimed"]);
  });

  test("idle subscriptions survive as records with their target GENERATION", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const sub: IdleSubscriptionRecord = { messageId: "m1", subscriber: "session:a", target: "session:b", targetGeneration: 3, createdAt: 0, expiresAt: 12 * 60 * 60 * 1000 };
    await store.subscriptions.add(sub);
    expect(await store.subscriptions.list()).toEqual([sub]);
    // The generation is what stops a notice firing for a later incarnation of the same address.
    expect((await store.subscriptions.list())[0]?.targetGeneration).toBe(3);
    await store.subscriptions.remove("m1");
    expect(await store.subscriptions.list()).toEqual([]);
  });

  test("a name lease is STAMPED on release, never deleted -- that is what makes a stale name refusable", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const lease: NameLeaseRecord = { name: "reviewer", address: "agent:session:a:c1", generation: 1, claimedAt: new Date(0).toISOString() };
    await store.names.claim(lease);
    expect((await store.names.held()).map((r) => r.name)).toEqual(["reviewer"]);
    await store.names.release("reviewer", "agent:session:a:c1", new Date(1000).toISOString());
    expect(await store.names.held()).toEqual([]);
    // WS-10 §11 rule 5: the name is STALE, which is a different answer from "no such agent" -- and
    // the only reason the router can tell them apart is that this record outlived the entry.
    const history = await store.names.lookup("reviewer");
    expect(history).toHaveLength(1);
    expect(history[0]?.releasedAt).toBe(new Date(1000).toISOString());
    expect(await store.names.lookup("never-used")).toEqual([]);
  });

  test("a re-claim after a release is a second record, and only the live one is `held`", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    await store.names.claim({ name: "reviewer", address: "agent:session:a:c1", generation: 1, claimedAt: new Date(0).toISOString() });
    await store.names.release("reviewer", "agent:session:a:c1", new Date(1).toISOString());
    await store.names.claim({ name: "reviewer", address: "agent:session:a:c2", generation: 2, claimedAt: new Date(2).toISOString() });
    expect((await store.names.lookup("reviewer")).map((r) => r.address)).toEqual(["agent:session:a:c1", "agent:session:a:c2"]);
    expect((await store.names.held()).map((r) => r.address)).toEqual(["agent:session:a:c2"]);
  });

  test("WS-15 §6.4 steps 5-7 are EXPRESSIBLE against the seam -- the whole point of I1", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    // A process died mid-flight: one claimed-unreceipted delivery, one pending subscription, one
    // held message, one live name lease.
    await store.deliveries.put(delivery("in-flight", { claimedBy: "claude-agent" }));
    await store.subscriptions.add({ messageId: "sub-1", subscriber: "session:a", target: "session:b", targetGeneration: 1, createdAt: 0, expiresAt: 1 });
    await store.mailboxes.hold({ messageId: "held-1", receiver: "session:b", reason: "receiver is prompting", kind: "default", heldAt: 0, expiresAt: 5 * 60 * 1000, message: message() });
    await store.names.claim({ name: "reviewer", address: "session:b", generation: 1, claimedAt: new Date(0).toISOString() });

    // STEP 5 — reconcile claimed-but-unreceipted as uncertain.
    const uncertain = await store.deliveries.claimedWithoutReceipt();
    expect(uncertain.map((r) => r.messageId)).toEqual(["in-flight"]);
    for (const record of uncertain) {
      await store.deliveries.put({
        ...record,
        outcome: { status: "delivery_uncertain", messageId: record.messageId, deliveryMayHaveOccurred: true, reason: "process exited between the claim and the receipt" },
        updatedAt: new Date(10).toISOString(),
      });
    }
    expect(await store.deliveries.claimedWithoutReceipt()).toEqual([]);
    expect((await store.deliveries.get("in-flight"))?.outcome?.status).toBe("delivery_uncertain");

    // STEP 6 — expire stale name leases and idle subscriptions by generation/TTL.
    for (const sub of await store.subscriptions.list()) if (sub.expiresAt <= 2) await store.subscriptions.remove(sub.messageId);
    expect(await store.subscriptions.list()).toEqual([]);
    for (const lease of await store.names.held()) {
      const entryForLease = (await store.load()).find((e) => e.address === lease.address);
      if (entryForLease === undefined) await store.names.release(lease.name, lease.address, new Date(11).toISOString());
    }
    expect(await store.names.held()).toEqual([]);
    expect((await store.names.lookup("reviewer"))[0]?.releasedAt).toBe(new Date(11).toISOString());

    // STEP 7 — re-evaluate held messages (release or keep) once policy is known again.
    const receivers = await store.mailboxes.receivers();
    expect(receivers).toEqual(["session:b"]);
    const released = await store.mailboxes.takeHeld("session:b", "held-1");
    expect(released?.message.body).toBe("hi");
    expect(await store.mailboxes.receivers()).toEqual([]);
  });
});

describe("the handle's internals are reachable for the lanes' own wiring", () => {
  test("`runtimeSdkInternals` hands back the seams and the ONE context every factory was given", () => {
    const { peer } = createFakeWinterPeer();
    const store = createInMemoryRuntimeDirectoryStore();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, directoryStore: store, vendoredOfficialRuntime: "/vendored/winter" });
    const internals = runtimeSdkInternals(sdk);
    expect(internals?.context.directoryStore).toBe(store);
    expect(internals?.context.keychain).toBe(keychain);
    expect(internals?.context.peers.winter).toBe(peer);
    expect(internals?.context.vendoredOfficialRuntime).toBe("/vendored/winter");
    // The directory on the handle IS the one in the context -- one object, not two (M3's hoist).
    expect(internals?.context.directory).toBe(sdk.directory);
    expect(runtimeSdkInternals({} as never)).toBeUndefined();
  });

  test("with no store injected, the default is the in-memory one", async () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const internals = runtimeSdkInternals(sdk);
    expect(await internals?.context.directoryStore.load()).toEqual([]);
  });
});
