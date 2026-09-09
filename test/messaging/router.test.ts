// WS-17 ROW 7: "Messaging: addressing, ambiguity/staleness, dedupe, queue bounds, TTL, retries, crash
// windows, loop prevention, reply routing, `notify_when_idle`."
//
// One test per clause, plus the two properties the clauses rest on: the delivery pipeline's ORDER
// (WS-15 §6.2) and its durability across a restart, which is what makes a retry a lookup instead of a
// second turn.
import { describe, expect, test } from "bun:test";

import { MAX_GLOBAL_MESSAGE_SIZE, MAX_HOP_COUNT, RAPID_REPEAT_WINDOW_MS, NOTIFY_IDLE_EXPIRY_MS } from "@yanlinglabs/winter-agent-sdk/messaging";
import { createMessagingToolHandlers, createRuntimeMessaging } from "../../src/messaging/index.ts";
import type { GlobalMessagingOptions } from "../../src/messaging/index.ts";
import { childEntry, createBed, createFakeFacet, envelope, sessionAddress, sessionEntry, winterHandle, declaredClasses } from "./support.ts";

function bedWith(options: GlobalMessagingOptions = {}) {
  const bed = createBed();
  // The bed DECLARES the receivers' permission classes, because its subject is delivery: since D2 an
  // unknown class fails closed and every one of these tests would otherwise measure the hold rather
  // than the route. A test whose subject IS the unknown class builds its bed without them.
  const messagingOptions = {
    now: bed.clock.now,
    ...options,
    winter: { ...declaredClasses().winter, ...(options.winter ?? {}) },
    official: { ...declaredClasses().official, ...(options.official ?? {}) },
  };
  const { directory, messaging } = createRuntimeMessaging(bed.context, { directory: { now: bed.clock.now }, messaging: messagingOptions });
  return { ...bed, directory, messaging };
}

describe("row 7 — addressing", () => {
  test("a canonical address delivers into the target's own facet, with the body byte-identical", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "look at @notes.md and then run /init", originToolCallId: "tool-1" });
    expect(outcome.status).toBe("queued");
    expect(facet.delivered.length).toBe(1);
    // WS-10 §10.4: bodies are delivered as LITERAL PLAIN TEXT — an `@` mention and a slash-command
    // shaped string are never expanded or executed by the router.
    expect(facet.delivered[0]?.body).toBe("look at @notes.md and then run /init");
    expect(facet.delivered[0]?.to.winterSessionId).toBe("receiver");
  });

  test("a display name resolves, and the resolved envelope carries the DIRECTORY's runtime kind", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("official", { runtimeKind: "claude-agent", displayName: "reviewer" }));
    // The official adapter is what must receive it — chosen by the ROW's declared kind, since a
    // serialized address carries none.
    const official = { pushed: [] as string[], push: (text: string) => void official.pushed.push(text), status: () => "idle" as const };
    world.messaging.attachOfficialSession("session:official", official);
    world.messaging.attachWinterSession("session:sender", winterHandle(facet));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "reviewer", body: "hello", originToolCallId: "t1" });
    expect(outcome.status).toBe("delivered");
    expect(official.pushed.length).toBe(1);
    expect(facet.delivered.length).toBe(0);
  });

  test("a send to your own session is refused (WS-10 §16's self-target rule)", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("solo"));
    const outcome = await world.messaging.send({ from: sessionAddress("solo"), to: "session:solo", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("self-target");
  });
});

describe("row 7 — ambiguity and staleness", () => {
  test("an ambiguous name returns CANDIDATES and delivers nothing", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("one", { displayName: "reviewer" }));
    await world.directory.record(sessionEntry("two", { displayName: "reviewer" }));
    world.messaging.attachWinterSession("session:one", winterHandle(facet));
    world.messaging.attachWinterSession("session:two", winterHandle(facet));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "reviewer", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") expect(outcome.candidates.map((row) => row.address).sort()).toEqual(["session:one", "session:two"]);
    expect(facet.delivered.length).toBe(0);
  });

  test("a REUSED name is refused as stale on the send path, and its canonical address still works", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("first", { displayName: "scout" }));
    await world.directory.forget("session:first");
    await world.directory.record(sessionEntry("second", { displayName: "scout" }));
    world.messaging.attachWinterSession("session:second", winterHandle(facet));

    const stale = await world.messaging.send({ from: sessionAddress("sender"), to: "scout", body: "hi", originToolCallId: "t1" });
    expect(stale.status).toBe("refused");
    if (stale.status === "refused") expect(stale.reason).toContain("canonical address");
    expect(facet.delivered.length).toBe(0);

    const canonical = await world.messaging.send({ from: sessionAddress("sender"), to: "session:second", body: "hi", originToolCallId: "t2" });
    expect(canonical.status).toBe("queued");
    expect(facet.delivered.length).toBe(1);
  });
});

describe("row 7 — dedupe, retries and the durable ledger", () => {
  test("a retry of the same (sender, tool-call) pair returns the STORED outcome and starts no second turn", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));

    const first = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "once", originToolCallId: "tool-7" });
    const retry = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "once", originToolCallId: "tool-7" });
    expect(retry).toEqual(first);
    expect(facet.delivered.length).toBe(1);
  });

  test("the dedupe survives a RESTART, because the id is derived rather than counted", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));
    await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "once", originToolCallId: "tool-7" });

    // A NEW ROUTER over the SAME store: everything in-memory is gone, the ledger is not.
    const restarted = createRuntimeMessaging(world.context, { directory: { now: world.clock.now }, messaging: { now: world.clock.now } });
    const secondFacet = createFakeFacet();
    restarted.messaging.attachWinterSession("session:receiver", winterHandle(secondFacet));
    const retry = await restarted.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "once", originToolCallId: "tool-7" });

    expect(retry.status).toBe("queued");
    expect(secondFacet.delivered.length).toBe(0); // nothing was delivered a second time
  });

  test("an ambiguous outcome is idempotent too — the id is persisted BEFORE resolution", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("one", { displayName: "reviewer" }));
    await world.directory.record(sessionEntry("two", { displayName: "reviewer" }));

    const first = await world.messaging.send({ from: sessionAddress("sender"), to: "reviewer", body: "hi", originToolCallId: "t1" });
    expect(first.status).toBe("ambiguous");
    const stored = await world.store.deliveries.get(first.messageId);
    expect(stored?.outcome?.status).toBe("ambiguous");
    const retry = await world.messaging.send({ from: sessionAddress("sender"), to: "reviewer", body: "hi", originToolCallId: "t1" });
    expect(retry).toEqual(first);
  });

  test("a caller with NO tool-call id gets a fresh id per call — no dedupe, and the record says so", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));

    const first = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi" });
    const second = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi again" });
    expect(first.messageId).not.toBe(second.messageId);
    expect(facet.delivered.length).toBe(2);
  });
});

describe("row 7 — the pipeline's order, its claim, and its crash window", () => {
  test("the envelope and its resolved generation are persisted, and the delivery is CLAIMED, before the adapter runs", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver", { generation: 9 }));

    let claimedDuringDelivery: string | undefined;
    let generationDuringDelivery: number | undefined;
    facet.setDeliverOutcome((message) => ({ status: "queued", messageId: message.messageId }));
    world.messaging.attachWinterSession("session:receiver", {
      messaging: {
        ...facet.facet,
        async deliver(message) {
          const record = await world.store.deliveries.get(message.messageId);
          claimedDuringDelivery = record?.claimedBy;
          generationDuringDelivery = record?.toGeneration;
          return facet.facet.deliver(message);
        },
      },
    });

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("queued");
    expect(claimedDuringDelivery).toBe("winter-agent");
    expect(generationDuringDelivery).toBe(9);
    // The envelope the adapter saw carries the resolved generation, not the core's placeholder zero.
    expect(facet.delivered[0]?.toGeneration).toBe(9);
    const receipt = await world.store.deliveries.get(outcome.messageId);
    expect(receipt?.outcome?.status).toBe("queued");
  });

  test("an adapter that THROWS is delivery_uncertain, and the record keeps the claim", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", {
      messaging: {
        ...createFakeFacet().facet,
        deliver() {
          throw new Error("the pipe broke");
        },
      },
    });

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("delivery_uncertain");
    if (outcome.status === "delivery_uncertain") {
      expect(outcome.deliveryMayHaveOccurred).toBe(true);
      expect(outcome.reason).toContain("the pipe broke");
    }
    const record = await world.store.deliveries.get(outcome.messageId);
    expect(record?.claimedBy).toBe("winter-agent");
  });

  test("a throw the OWNER classifies as a policy refusal is `refused`, not uncertain", async () => {
    class PolicyRefusal extends Error {}
    const world = bedWith({ classifyDeliveryError: (error) => (error instanceof PolicyRefusal ? "refused" : "uncertain") });
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", {
      messaging: {
        ...createFakeFacet().facet,
        deliver() {
          throw new PolicyRefusal("the receiver's own resume modes are incomparable");
        },
      },
    });

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("refused");
  });
});

describe("row 7 — TTL, generation, loop prevention and reply routing", () => {
  test("an EXPIRED envelope is refused at the deliver door, and nothing is pushed", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("a"));
    await world.directory.record(sessionEntry("b"));
    world.messaging.attachWinterSession("session:b", winterHandle(facet));

    const outcome = await world.messaging.deliver(envelope({ messageId: "expired-1", expiresAt: world.clock.now() - 1 }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("expired");
    expect(facet.delivered.length).toBe(0);
  });

  test("an envelope addressed to a PREVIOUS generation never reaches the replacement", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("a"));
    await world.directory.record(sessionEntry("b", { generation: 4 }));
    world.messaging.attachWinterSession("session:b", winterHandle(facet));

    const outcome = await world.messaging.deliver(envelope({ messageId: "stale-gen", toGeneration: 3 }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("generation 3");
    expect(facet.delivered.length).toBe(0);
  });

  test("an identical rapid repeat is suppressed with a VISIBLE outcome, and allowed again after the window", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));

    const first = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "same", originToolCallId: "t1" });
    // A DIFFERENT tool-call id, so this is not a retry — it is the model sending the same content again.
    const repeat = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "same", originToolCallId: "t2" });
    expect(first.status).toBe("queued");
    expect(repeat.status).toBe("refused");
    if (repeat.status === "refused") expect(repeat.reason).toContain("rapid repeat");
    expect(facet.delivered.length).toBe(1);

    world.clock.advance(RAPID_REPEAT_WINDOW_MS + 1);
    const later = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "same", originToolCallId: "t3" });
    expect(later.status).toBe("queued");
    expect(facet.delivered.length).toBe(2);
  });

  test("a body over MAX_GLOBAL_MESSAGE_SIZE is refused before anything is resolved", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterHandle(facet));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "x".repeat(MAX_GLOBAL_MESSAGE_SIZE + 1), originToolCallId: "t1" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("MAX_GLOBAL_MESSAGE_SIZE");
    expect(facet.delivered.length).toBe(0);
  });

  test("a reply routes back to the original sender and INCREMENTS the hop count", async () => {
    const world = bedWith();
    const senderFacet = createFakeFacet();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:sender", winterHandle(senderFacet));
    world.messaging.attachWinterSession("session:receiver", winterHandle(createFakeFacet()));

    const original = envelope({ messageId: "orig", from: sessionAddress("sender"), to: sessionAddress("receiver") });
    const outcome = await world.messaging.reply({ original, body: "thanks" });
    expect(outcome.status).toBe("queued");
    expect(senderFacet.delivered.length).toBe(1);
    expect(senderFacet.delivered[0]?.hopCount).toBe(1);
    expect(senderFacet.delivered[0]?.to.winterSessionId).toBe("sender");
    expect(senderFacet.delivered[0]?.body).toBe("thanks");
  });

  test("a reply chain is stopped at MAX_HOP_COUNT — the bound is machinery, not documentation", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:sender", winterHandle(createFakeFacet()));

    const original = envelope({ messageId: "deep", from: sessionAddress("sender"), to: sessionAddress("receiver"), hopCount: MAX_HOP_COUNT - 1 });
    const outcome = await world.messaging.reply({ original, body: "one hop too far" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("hop");
  });

  test("a reply to an object whose row says it cannot read one is refused", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender", { capabilities: { reply: false } }));
    await world.directory.record(sessionEntry("receiver"));
    const outcome = await world.messaging.reply({ original: envelope({ from: sessionAddress("sender"), to: sessionAddress("receiver") }), body: "hi" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("does not accept replies");
  });
});

describe("row 7 — notify_when_idle through the MODEL-facing path (review r1, M1)", () => {
  // THE DEFECT THIS BLOCK EXISTS FOR: the model's own `SendMessage{notify_when_idle}` reaches the
  // shared core, which calls `adapter.subscribeIdle` — the dispatching adapter. That used to delegate
  // straight to the owner adapter, so the subscription was made AT THE RUNTIME and the router's own
  // `store.subscriptions` — the only thing `noteIdle()` reads — stayed empty. The model was told
  // `subscribed: true` and the one notice WS-10 §14 promises could never be routed to anybody.
  //
  // Every idle test the lane had went through the HOST door (`messaging.notifyWhenIdle`), which did
  // write the record — which is exactly why the suite could not see it.

  async function watcherAndTarget(world: ReturnType<typeof bedWith>) {
    const targetFacet = createFakeFacet();
    const watcherFacet = createFakeFacet();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target"));
    world.messaging.attachWinterSession("session:watcher", winterHandle(watcherFacet));
    world.messaging.attachWinterSession("session:target", winterHandle(targetFacet));
    return { targetFacet, watcherFacet };
  }

  test("a COMBINED SendMessage subscribes durably, and the target's idle notice actually arrives", async () => {
    const world = bedWith();
    const { targetFacet } = await watcherAndTarget(world);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "watcher", toolUseId: "toolu_1" });

    const payload = JSON.parse((await handlers.sendMessage({ to: "session:target", message: "ping", notify_when_idle: true })).content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload["status"]).toBe("queued");
    expect(payload["notify"]).toEqual({ subscribed: true });
    // …and the claim is backed by a durable record with the target's identity AND generation.
    const stored = await world.store.subscriptions.list();
    expect(stored.length).toBe(1);
    expect(stored[0]?.subscriber).toBe("session:watcher");
    expect(stored[0]?.target).toBe("session:target");
    expect(stored[0]?.targetGeneration).toBe(1);

    targetFacet.fireIdle({ subscriberSessionId: "host:target", notice: { notification_id: "note-1", origin: "session:target", queued_at: "t", content: "session:target is now idle" } });
    await Bun.sleep(0);
    const page = world.messaging.readNotifications("watcher");
    expect(page.notifications.length).toBe(1);
    expect(page.notifications[0]?.content).toContain("idle");
  });

  test("a PURE subscription (an empty message) does the same, and delivers nothing", async () => {
    const world = bedWith();
    const { targetFacet } = await watcherAndTarget(world);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "watcher", toolUseId: "toolu_2" });

    const payload = JSON.parse((await handlers.sendMessage({ to: "session:target", message: "", notify_when_idle: true })).content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload["status"]).toBe("subscribed");
    expect(targetFacet.delivered.length).toBe(0); // WS-10 §10.1: an empty message is the subscription
    expect((await world.store.subscriptions.list()).length).toBe(1);

    expect(await world.messaging.noteIdle("session:target")).toBe(1);
    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(1);
  });

  test("the subscription SURVIVES A RESTART — a new router over the same store still fires it", async () => {
    const world = bedWith();
    await watcherAndTarget(world);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "watcher", toolUseId: "toolu_3" });
    expect(JSON.parse((await handlers.sendMessage({ to: "session:target", message: "", notify_when_idle: true })).content[0]?.text ?? "{}")["status"]).toBe("subscribed");

    // WS-15 §6.3: "survives restart only when DURABLY STORED with valid target identity/generation."
    const restarted = createRuntimeMessaging(world.context, { directory: { now: world.clock.now }, messaging: { now: world.clock.now } });
    const report = await restarted.directory.recover();
    expect(report.steps[5]?.outcome).toContain("1 still valid");

    expect(await restarted.messaging.noteIdle("session:target")).toBe(1);
    expect(restarted.messaging.readNotifications("watcher").notifications.length).toBe(1);
  });

  test("a REFUSED model-facing subscribe leaves no durable record, and refuses the whole call", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("official", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:official", { push: () => undefined, status: () => "running" });
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "watcher", toolUseId: "toolu_4" });

    const payload = JSON.parse((await handlers.sendMessage({ to: "session:official", message: "hi", notify_when_idle: true })).content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(payload["status"]).toBe("refused");
    expect((await world.store.subscriptions.list()).length).toBe(0);
  });
});

describe("row 7 — notify_when_idle, end to end", () => {
  test("subscribe, then the target's live idle notice reaches the subscriber's queue exactly once", async () => {
    const world = bedWith();
    const targetFacet = createFakeFacet();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target"));
    world.messaging.attachWinterSession("session:target", winterHandle(targetFacet));

    const outcome = await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });
    expect(outcome.status).toBe("subscribed");
    expect(targetFacet.subscribes).toEqual([{ id: "session:target", messageId: "sub-1" }]);
    expect((await world.store.subscriptions.list()).length).toBe(1);

    targetFacet.fireIdle({ subscriberSessionId: "host:target", notice: { notification_id: "note-1", origin: "session:target", queued_at: "t", content: "session:target is now idle" } });
    await Bun.sleep(0); // the bridge is fire-and-forget by design; let its promise settle

    const page = world.messaging.readNotifications("watcher");
    expect(page.notifications.length).toBe(1);
    expect(page.notifications[0]?.content).toContain("idle");
    // ONE-SHOT: the durable record is gone, so a second notice fires nothing.
    expect((await world.store.subscriptions.list()).length).toBe(0);
    targetFacet.fireIdle({ subscriberSessionId: "host:target", notice: { notification_id: "note-2", origin: "session:target", queued_at: "t", content: "again" } });
    await Bun.sleep(0);
    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(0);
  });

  test("the live notice and its drained twin are ONE notice, deduped by notification_id", async () => {
    const world = bedWith();
    const targetFacet = createFakeFacet();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target"));
    world.messaging.attachWinterSession("session:target", winterHandle(targetFacet));
    await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });

    const notice = { notification_id: "note-1", origin: "session:target", queued_at: "t", content: "session:target is now idle" };
    targetFacet.fireIdle({ subscriberSessionId: "host:target", notice });
    await Bun.sleep(0);
    // The same notice arriving a second time — the catch-up drain a reconnecting host performs.
    expect(await world.messaging.noteIdle("session:target", { notificationId: "note-1", content: notice.content })).toBe(0);
    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(1);
  });

  test("a notice queued while nothing was listening is CAUGHT UP at attach, and drained exactly once", async () => {
    const world = bedWith();
    const targetFacet = createFakeFacet();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target"));
    // Subscribe first, THEN attach: the shape of a host that reconnects to a session it had
    // subscribed to before it went away (WS-15 §6.4's restart recovery).
    world.messaging.attachWinterSession("session:target", winterHandle(targetFacet));
    await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });

    targetFacet.queueNotice({ notification_id: "note-missed", origin: "session:target", queued_at: "t", content: "session:target is now idle" });
    const detach = world.messaging.attachWinterSession("session:target", winterHandle(targetFacet));
    await Bun.sleep(0);

    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(1);
    // …and the live frame carrying the SAME notice adds nothing: one notice, two transports.
    targetFacet.fireIdle({ subscriberSessionId: "host:target", notice: { notification_id: "note-missed", origin: "session:target", queued_at: "t", content: "session:target is now idle" } });
    await Bun.sleep(0);
    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(0);
    detach();
  });

  test("a subscription for a PREVIOUS generation of the target fires nothing", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target", { generation: 1 }));
    world.messaging.attachWinterSession("session:target", winterHandle(createFakeFacet()));
    await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });

    await world.directory.record(sessionEntry("target", { generation: 2 }));
    expect(await world.messaging.noteIdle("session:target")).toBe(0);
    expect(world.messaging.readNotifications("watcher").notifications.length).toBe(0);
  });

  test("a subscription past its 12-hour expiry fires nothing and is swept", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("target"));
    world.messaging.attachWinterSession("session:target", winterHandle(createFakeFacet()));
    await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });

    world.clock.advance(NOTIFY_IDLE_EXPIRY_MS + 1);
    expect(await world.messaging.noteIdle("session:target")).toBe(0);
    expect((await world.store.subscriptions.list()).length).toBe(0);
  });

  test("a CHILD may not subscribe, and a child may not be subscribed TO", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record(childEntry("parent", "c1"));
    await world.directory.record(sessionEntry("target"));

    const fromChild = await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "parent", parentWinterSessionId: "parent", childId: "c1" }, messageId: "s1" });
    expect(fromChild.status).toBe("refused");
    if (fromChild.status === "refused") expect(fromChild.reason).toContain("main conversation");

    const toChild = await world.messaging.notifyWhenIdle({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "parent", parentWinterSessionId: "parent", childId: "c1" }, { from: sessionAddress("target"), messageId: "s2" });
    expect(toChild.status).toBe("refused");
    expect((await world.store.subscriptions.list()).length).toBe(0);
  });

  test("a refused subscribe leaves NO durable record behind", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("watcher"));
    // No handle at all: the Winter adapter has no idle signal for it, so it refuses the whole call.
    await world.directory.record(sessionEntry("target"));

    const outcome = await world.messaging.notifyWhenIdle(sessionAddress("target"), { from: sessionAddress("watcher"), messageId: "sub-1" });
    expect(outcome.status).toBe("refused");
    expect((await world.store.subscriptions.list()).length).toBe(0);
  });
});
