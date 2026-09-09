// THE TWO ADAPTERS, and the WS-15 §6.2 routing table read row by row.
//
// | Target state                          | Required behaviour                                        |
// | Running Winter child                  | enqueue at the child's next round boundary → `queued`     |
// | Terminal Winter child                 | resume through its owner, else `unavailable` with a reason|
// | Running Winter session                | enqueue after the current tool boundary                   |
// | Idle Winter session                   | start one turn                                            |
// | Exited Winter session                 | open through the normal session runtime; deliver one turn |
// | Running/idle official session         | deliver through the owning live handle                    |
// | Exited official session               | resume by backendSessionId, re-establish, THEN deliver    |
// | Running official child                | native child messaging through the ACTIVE owning parent   |
// | Completed official child              | only through the owning parent, once it is active         |
// | Archived session                      | refuse until a deliberate resume unarchives it            |
//
// Plus WS13c-SM1/SM2/SM3: the cross-family pairs, which are the whole reason the adapter is chosen by
// the CHILD's own record rather than by its parent's runtime.
import { describe, expect, test } from "bun:test";

import { createRuntimeMessaging } from "../../src/messaging/index.ts";
import type { GlobalMessagingOptions } from "../../src/messaging/index.ts";
import { childAddress, childEntry, createBed, createFakeFacet, createFakeOfficialSession, envelope, sessionAddress, sessionEntry, winterHandle, winterWriterHandle, declaredClasses } from "./support.ts";
import { credentials, listing, NOW, VERSIONS } from "../selection/fixtures.ts";
import type { SdkMessage } from "@yanlinglabs/winter-agent-sdk";

function bedWith(options: GlobalMessagingOptions = {}, messages?: SdkMessage[]) {
  const bed = createBed(messages === undefined ? {} : { messages });
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

describe("the Winter adapter", () => {
  test("a live session with only a router-held WRITER gets the attributed turn, and its status picks the outcome", async () => {
    const world = bedWith();
    const writer = winterWriterHandle(() => "running");
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", writer.handle);

    const queued = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
    expect(queued.status).toBe("queued"); // running: enqueued after the current tool boundary
    expect(writer.pushed[0]).toContain('<agent-message from="session:sender"');
    expect(writer.pushed[0]).toContain("hi");

    const idleWorld = bedWith();
    const idleWriter = winterWriterHandle(() => "idle");
    await idleWorld.directory.record(sessionEntry("sender"));
    await idleWorld.directory.record(sessionEntry("receiver"));
    idleWorld.messaging.attachWinterSession("session:receiver", idleWriter.handle);
    const delivered = await idleWorld.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
    expect(delivered.status).toBe("delivered"); // idle: one turn is started
  });

  test("an EXITED session is cold-resumed through the router's own query({ resume }), and only then is it `resumed_and_delivered`", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(world.peerCalls.length).toBe(1);
    expect((world.peerCalls[0]?.options as { resume?: string }).resume).toBe("backend-9");
    expect(String(world.peerCalls[0]?.prompt)).toContain("wake up");
  });

  test("a cold resume with NO backend session id is non-retryably unavailable, and opens nothing", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("gone", { status: "exited" }));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") expect(outcome.retryable).toBe(false);
    expect(world.peerCalls.length).toBe(0);
  });

  test("a resumed session that produces no turn at all is delivery_uncertain, never `resumed_and_delivered`", async () => {
    const world = bedWith({}, []); // the stream ends with nothing in it
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }));

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("delivery_uncertain");
    // "resume alone" is precisely what WS-10 §10.3 says must NOT be reported as resumed_and_delivered.
    expect(world.peerCalls.length).toBe(1);
  });

  test("an ARCHIVED session refuses until it is deliberately unarchived", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("filed", { status: "archived", backendSessionId: "b" }));
    const outcome = await world.messaging.deliver(envelope({ messageId: "m", from: sessionAddress("sender"), to: sessionAddress("filed") }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("archived");
    expect(world.peerCalls.length).toBe(0);
  });

  test("a RUNNING child is steered and a TERMINAL one is resumed — through the PARENT's facet, never a session address", async () => {
    const world = bedWith();
    const parentFacet = createFakeFacet();
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record(childEntry("parent", "running-one"));
    await world.directory.record(childEntry("parent", "done-one", { status: "exited" }));
    world.messaging.attachWinterSession("session:parent", winterHandle(parentFacet));

    await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("parent"), to: childAddress("parent", "running-one") }));
    await world.messaging.deliver(envelope({ messageId: "m2", from: sessionAddress("parent"), to: childAddress("parent", "done-one") }));

    expect(parentFacet.steered.map((call) => call.id)).toEqual(["running-one"]);
    expect(parentFacet.resumed.map((call) => call.id)).toEqual(["done-one"]);
    // The child was never addressed as a session: a child engine has no facet surface of its own.
    expect(parentFacet.delivered.length).toBe(0);
  });

  test("a child whose owning parent is not live is RETRYABLY unavailable, naming the owner", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record(childEntry("parent", "c1"));
    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("parent"), to: childAddress("parent", "c1") }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(true);
      expect(outcome.reason).toContain("session:parent");
    }
  });
});

describe("the official adapter", () => {
  test("a live official session is delivered through its own handle, attributed", async () => {
    const world = bedWith();
    const official = createFakeOfficialSession("idle");
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("claude", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:claude", official.handle);

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:claude", body: "hello", originToolCallId: "t1" });
    expect(outcome.status).toBe("delivered");
    expect(official.pushed[0]).toContain('<agent-message from="session:sender"');
    expect(official.pushed[0]).toContain("hello");
  });

  test("a RUNNING official child is delivered to the ACTIVE owning parent, OWNER-QUALIFIED", async () => {
    const world = bedWith();
    const parent = createFakeOfficialSession("running");
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("claude-parent", { runtimeKind: "claude-agent" }));
    await world.directory.record(childEntry("claude-parent", "sub-1", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:claude-parent", parent.handle);

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("sender"), to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "claude-parent", parentWinterSessionId: "claude-parent", childId: "sub-1" } }));
    expect(outcome.status).toBe("queued");
    // The frame names the child it was FOR — "the public result stays owner-qualified" (WS-15 §6.2).
    expect(parent.pushed[0]).toContain('for="agent:claude-parent:sub-1"');
    expect(parent.pushed[0]).toContain('from="session:sender"');
  });

  test("a COMPLETED official child with no active parent is retryably unavailable, and says why", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("claude-parent", { runtimeKind: "claude-agent", status: "exited" }));
    await world.directory.record(childEntry("claude-parent", "sub-1", { runtimeKind: "claude-agent", status: "exited" }));

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("sender"), to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "claude-parent", parentWinterSessionId: "claude-parent", childId: "sub-1" } }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(true);
      expect(outcome.reason).toContain("explicitly resumed");
    }
  });

  test("an EXITED official session is unavailable without a resume collaborator, and resumed_and_delivered with one", async () => {
    const bare = bedWith();
    await bare.directory.record(sessionEntry("sender"));
    await bare.directory.record(sessionEntry("claude", { runtimeKind: "claude-agent", status: "exited", backendSessionId: "b-1" }));
    const refusal = await bare.messaging.send({ from: sessionAddress("sender"), to: "session:claude", body: "hi", originToolCallId: "t1" });
    expect(refusal.status).toBe("unavailable");
    if (refusal.status === "unavailable") {
      expect(refusal.retryable).toBe(false);
      expect(refusal.reason).toContain("official adapter");
    }

    const resumedSession = createFakeOfficialSession("idle");
    const asked: string[] = [];
    const wired = bedWith({
      official: {
        resumeExited: async (entry) => {
          asked.push(entry.backendSessionId ?? "");
          return resumedSession.handle;
        },
      },
    });
    await wired.directory.record(sessionEntry("sender"));
    await wired.directory.record(sessionEntry("claude", { runtimeKind: "claude-agent", status: "exited", backendSessionId: "b-1" }));
    const outcome = await wired.messaging.send({ from: sessionAddress("sender"), to: "session:claude", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(asked).toEqual(["b-1"]); // resumed BY the backend session id, per WS-15 §6.2
    expect(resumedSession.pushed.length).toBe(1);
  });

  test("notify_when_idle against the official branch refuses the WHOLE call — it has no idle signal", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("watcher"));
    await world.directory.record(sessionEntry("claude", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:claude", createFakeOfficialSession().handle);

    const outcome = await world.messaging.notifyWhenIdle(sessionAddress("claude"), { from: sessionAddress("watcher"), messageId: "sub-1" });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("idle signal");
    expect((await world.store.subscriptions.list()).length).toBe(0);
  });

  test("a push that throws is delivery_uncertain — the write may have landed before the failure", async () => {
    const world = bedWith();
    const official = createFakeOfficialSession();
    official.setFailure(new Error("EPIPE"));
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("claude", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:claude", official.handle);

    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:claude", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("delivery_uncertain");
  });
});

describe("WS13c-SM1/SM2/SM3 — the cross-family pairs, routed by the CHILD's own record", () => {
  test("SM1 — a `gpt` Winter parent's `claude` child is reached on the OFFICIAL runtime, and the parent switching changes nothing", async () => {
    const world = bedWith();
    const parentFacet = createFakeFacet();
    const childSession = createFakeOfficialSession("running");
    await world.directory.record(sessionEntry("gpt-parent"));
    // The child's OWN slot selected the official runtime (R-7b-1), so on that runtime it is a session
    // in its own right: `claude-handle`, with its own handle — not a native subagent of an official
    // parent (`claude-child`), which is a different door entirely.
    await world.directory.record({ ...childEntry("gpt-parent", "sonnet-child", { runtimeKind: "claude-agent" }), transport: "claude-handle" });
    world.messaging.attachWinterSession("session:gpt-parent", winterHandle(parentFacet));
    world.messaging.attachOfficialSession("agent:gpt-parent:sonnet-child", childSession.handle);

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("gpt-parent"), to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "gpt-parent", parentWinterSessionId: "gpt-parent", childId: "sonnet-child" } }));
    expect(outcome.status).toBe("queued");
    expect(childSession.pushed.length).toBe(1);
    // The Winter parent's facet was never asked to steer it — the child is not inside that process.
    expect(parentFacet.steered.length).toBe(0);

    // The parent switches runtime. The child's record is untouched, so the next message routes the same
    // way: "resume and SendMessage follow the CHILD's record, never the parent's current runtime."
    await world.directory.record(sessionEntry("gpt-parent", { runtimeKind: "claude-agent" }));
    const after = await world.messaging.deliver(envelope({ messageId: "m2", from: sessionAddress("gpt-parent"), to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "gpt-parent", parentWinterSessionId: "gpt-parent", childId: "sonnet-child" } }));
    expect(after.status).toBe("queued");
    expect(childSession.pushed.length).toBe(2);
    expect((await world.directory.get("agent:gpt-parent:sonnet-child"))?.runtimeKind).toBe("claude-agent");
  });

  test("SM2 — the mirror: an official parent's Winter child is reached on the WINTER runtime, through its own facet", async () => {
    const world = bedWith();
    const officialParent = createFakeOfficialSession("running");
    const childFacet = createFakeFacet();
    await world.directory.record(sessionEntry("claude-parent", { runtimeKind: "claude-agent" }));
    await world.directory.record({ ...childEntry("claude-parent", "winter-child"), transport: "winter-session" });
    world.messaging.attachOfficialSession("session:claude-parent", officialParent.handle);
    world.messaging.attachWinterSession("agent:claude-parent:winter-child", winterHandle(childFacet));

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("claude-parent"), to: childAddress("claude-parent", "winter-child") }));
    expect(outcome.status).toBe("queued");
    expect(childFacet.delivered.length).toBe(1);
    // The official parent was never handed an owner-qualified relay: this child is not its subagent.
    expect(officialParent.pushed.length).toBe(0);
  });

  test("SM3 — a child whose recorded provider is gone refuses with `child-provider-unavailable`, and NO generation is started", async () => {
    const parentFacet = createFakeFacet();
    const world = bedWith({
      winter: {
        // WS-13c §8's resume door: the child re-resolves under its OWN recorded model and provider.
        childResumeContext: () => ({ mode: "code", families: listing("claude"), credentials: credentials(["openai"]), hasClaudePeer: false, claudeOauthApproved: false, versions: VERSIONS, now: NOW }),
      },
    });
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record({
      ...childEntry("parent", "sonnet-child", { status: "exited" }),
      selection: { runtimeKind: "winter-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", family: "claude", authFamily: "api-key", sdkVersion: "0.0.2", reason: "fixture", decidedAt: NOW },
    });
    world.messaging.attachWinterSession("session:parent", winterHandle(parentFacet));

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("parent"), to: childAddress("parent", "sonnet-child") }));
    expect(outcome.status).toBe("unavailable");
    if (outcome.status === "unavailable") {
      expect(outcome.retryable).toBe(false);
      expect(outcome.reason).toContain("child-provider-unavailable");
    }
    // NOTHING WAS STARTED: the refusal happens before the parent's facet is touched at all, so the
    // parent's own turn is undisturbed (WS13c-SM3's own wording).
    expect(parentFacet.resumed.length).toBe(0);
    expect(parentFacet.steered.length).toBe(0);
  });

  test("SM3's good direction — the same child resumes unchanged once its own credential is back", async () => {
    const parentFacet = createFakeFacet();
    const world = bedWith({
      winter: {
        childResumeContext: () => ({ mode: "code", families: listing("claude"), credentials: credentials(["anthropic"]), hasClaudePeer: false, claudeOauthApproved: false, versions: VERSIONS, now: NOW }),
      },
    });
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record({
      ...childEntry("parent", "sonnet-child", { status: "exited" }),
      selection: { runtimeKind: "winter-agent", providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", family: "claude", authFamily: "api-key", sdkVersion: "0.0.2", reason: "fixture", decidedAt: NOW },
    });
    world.messaging.attachWinterSession("session:parent", winterHandle(parentFacet));

    const outcome = await world.messaging.deliver(envelope({ messageId: "m1", from: sessionAddress("parent"), to: childAddress("parent", "sonnet-child") }));
    expect(outcome.status).toBe("queued");
    expect(parentFacet.resumed.map((call) => call.id)).toEqual(["sonnet-child"]);
  });
});
