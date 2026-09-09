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

import { createMessagingToolHandlers, createRuntimeMessaging } from "../../src/messaging/index.ts";
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

describe("one envelope, one answer: attribution before any push (review r1, D1)", () => {
  // THE DEFECT: `renderAttributedTurn`'s owner check — a claimed `agent:` sender the receiving session
  // does not own (WS-10 §10.3) — was evaluated in three different places on three delivery paths. The
  // Winter WRITER evaluated it INSIDE the `try` whose `catch` returns `delivery_uncertain`, so a
  // refusal that provably pushed NOTHING was recorded as "the delivery may have occurred" — and
  // WS-10 §12 then forbids retrying it, so a clean side-effect-free "no" became a permanently
  // ambiguous record. The OFFICIAL path did not evaluate it at all and delivered the envelope. The
  // FACET path refused. Same input, three answers, chosen by which handle shape the host attached.

  /** An envelope claiming to come from a child of a DIFFERENT session than the receiver. */
  const foreign = (to: ReturnType<typeof sessionAddress>) => envelope({ messageId: "m-foreign", from: childAddress("stranger", "c1"), to });

  test("all three delivery paths answer `refused`, and none of them pushes anything", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("stranger"));
    // The sender is a REAL child of a real other session, so the route is authenticated and the
    // inbound matrix accepts it: the attribution fence is then the only thing that can refuse, which
    // is what makes this a test of the fence rather than of the authentication gate.
    await world.directory.record(childEntry("stranger", "c1"));
    await world.directory.record(sessionEntry("writer"));
    await world.directory.record(sessionEntry("faceted"));
    await world.directory.record(sessionEntry("official", { runtimeKind: "claude-agent" }));
    const writer = winterWriterHandle(() => "running");
    const facet = createFakeFacet();
    const official = createFakeOfficialSession("running");
    world.messaging.attachWinterSession("session:writer", writer.handle);
    world.messaging.attachWinterSession("session:faceted", winterHandle(facet));
    world.messaging.attachOfficialSession("session:official", official.handle);

    const paths = [
      { name: "winter writer", outcome: await world.messaging.deliver(foreign(sessionAddress("writer"))), pushed: writer.pushed.length },
      { name: "winter facet", outcome: await world.messaging.deliver({ ...foreign(sessionAddress("faceted")), messageId: "m-foreign-2" }), pushed: facet.delivered.length },
      { name: "official", outcome: await world.messaging.deliver({ ...foreign(sessionAddress("official")), messageId: "m-foreign-3" }), pushed: official.pushed.length },
    ];

    for (const path of paths) {
      expect([path.name, path.outcome.status]).toEqual([path.name, "refused"]);
      expect([path.name, path.pushed]).toEqual([path.name, 0]);
      if (path.outcome.status === "refused") expect(path.outcome.reason).toContain("does not own");
    }
  });

  test("the owner's OWN child is still delivered on every path — the fence refuses, it does not block", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("parent"));
    await world.directory.record(childEntry("parent", "c1"));
    const writer = winterWriterHandle(() => "idle");
    world.messaging.attachWinterSession("session:parent", writer.handle);

    const outcome = await world.messaging.deliver(envelope({ messageId: "m-own", from: childAddress("parent", "c1"), to: sessionAddress("parent") }));
    expect(outcome.status).toBe("delivered");
    expect(writer.pushed[0]).toContain('from="agent:parent:c1"');
  });

  test("NEW-4 — a sender address the router cannot even NAME is a refusal, not a crash window", async () => {
    // D1's shape for the OTHER malformation: an `agent:` sender with no `childId` cannot be serialized
    // at all, and the throw used to land in `dispatchEnvelope`'s catch as `delivery_uncertain` — "the
    // delivery may have occurred" about an envelope that never reached an adapter. Reachable only
    // through the host's `deliver()`/`reply()` doors with a hand-built address, never by a model.
    const world = bedWith();
    const writer = winterWriterHandle(() => "idle");
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", writer.handle);

    const outcome = await world.messaging.deliver(
      envelope({ messageId: "m-malformed", from: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "s", parentWinterSessionId: "s" }, to: sessionAddress("receiver") }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("not a canonical address");
    expect(writer.pushed.length).toBe(0);
  });

  test("NEW-11 — `reply()` ANSWERS on a malformed address, it does not throw", async () => {
    // `reply` serializes both halves of the original envelope while building the reply — before
    // `dispatchEnvelope`'s own guard is reached — so a hand-built malformed address came out of the
    // router as an unhandled throw. Host-only (a model never builds an address), and the whole point
    // of D1/NEW-4 is that these doors answer.
    const world = bedWith();
    await world.directory.record(sessionEntry("a"));
    await world.directory.record(sessionEntry("b"));
    const malformed = { objectKind: "agent" as const, runtimeKind: "winter-agent" as const, winterSessionId: "a", parentWinterSessionId: "a" };

    const asSender = await world.messaging.reply({ original: envelope({ from: sessionAddress("a"), to: malformed }), body: "hi" });
    expect(asSender.status).toBe("refused");
    if (asSender.status === "refused") expect(asSender.reason).toContain("not a canonical address");

    const asTarget = await world.messaging.reply({ original: envelope({ from: malformed, to: sessionAddress("b") }), body: "hi" });
    expect(asTarget.status).toBe("refused");
  });

  test("the official OWNER-QUALIFIED child relay keeps its deliberate absence of an owner", async () => {
    // A message FOR a child is handed to the parent that owns the child but NOT the sender — the one
    // place the owner check must not run, and the reason `renderOwnerQualifiedTurn` takes no owner.
    const world = bedWith();
    const parent = createFakeOfficialSession("running");
    await world.directory.record(sessionEntry("stranger"));
    await world.directory.record(childEntry("stranger", "c1"));
    await world.directory.record(sessionEntry("claude-parent", { runtimeKind: "claude-agent" }));
    await world.directory.record(childEntry("claude-parent", "sub-1", { runtimeKind: "claude-agent" }));
    world.messaging.attachOfficialSession("session:claude-parent", parent.handle);

    const outcome = await world.messaging.deliver(
      envelope({ messageId: "m-relay", from: childAddress("stranger", "c1"), to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "claude-parent", parentWinterSessionId: "claude-parent", childId: "sub-1" } }),
    );
    expect(outcome.status).toBe("queued");
    expect(parent.pushed[0]).toContain('for="agent:claude-parent:sub-1"');
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

// ====================================================================================================
// NEW-12 — A THROWING HOST `permissionClass` HOOK IS AN ANSWER, NOT A CRASH.
//
// The hook is the ONLY way an official session's class is ever known and the documented way a host
// declares one for any session driven through a plain writer; this package's own note describes it as
// something that "may be an IPC round trip", so FAILING is its expected mode. Unwrapped, it came out
// of `send()`, `reply()` and the model-facing `SendMessage` handler as a raw throw — a model's tool
// call erroring instead of receiving a classified failure, which is the same class D1/NEW-4 closed on
// the adapter side. Falling through to `unknown` is not a weakening: it is §13's own word for "an
// authenticated route that cannot prove sender class" and already what a host with NO hook gets, so
// D2 stays fail-closed and the message is HELD.
// ====================================================================================================
describe("NEW-12 — a host permission-class hook that raises", () => {
  const boom = () => {
    throw new Error("boom: the host's permission-class IPC round trip failed");
  };

  for (const [label, hooks] of [
    ["the WINTER adapter's host hook", { winter: { permissionClass: boom } }],
    ["the OFFICIAL adapter's host hook", { official: { permissionClass: boom } }],
  ] as const) {
    test(`${label} falls through to unknown, and D2 HOLDS rather than delivering`, async () => {
      const world = bedWith(hooks as GlobalMessagingOptions);
      await world.directory.record(sessionEntry("sender"));
      // The hook under test has to be the one the RECEIVER's branch reads, so the receiver's runtime
      // follows the adapter being exercised.
      const receiverKind = "official" in hooks ? ("claude-agent" as const) : ("winter-agent" as const);
      await world.directory.record(sessionEntry("receiver", { runtimeKind: receiverKind }));
      world.messaging.attachWinterSession("session:receiver", winterWriterHandle(() => "idle").handle);

      // BEFORE: this line threw, out of `send()` and out of the model-facing handler with it.
      const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t1" });
      expect(outcome.status).toBe("held");
      // `unknown` is §13's own word, and holding is exactly what a host with NO hook already gets —
      // so the catch preserves D2's fail-closed reading rather than weakening it.
      expect("reason" in outcome ? outcome.reason : "").toContain("class unknown");
    });
  }

  test("the model-facing SendMessage handler answers with a tool_result, not an exception", async () => {
    const world = bedWith({ winter: { permissionClass: boom } });
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterWriterHandle(() => "idle").handle);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "sender", toolUseId: "toolu-new12" });
    const result = await handlers.sendMessage({ to: "session:receiver", message: "a message only this test sends" });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0]?.text).toContain("held");
    expect(result.content[0]?.text).toContain("class unknown");
  });

  test("a hook that ANSWERS is unaffected — the catch is a fall-through, not a swallow", async () => {
    const world = bedWith({ winter: { permissionClass: () => "prompts" as const } });
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterWriterHandle(() => "idle").handle);
    const outcome = await world.messaging.send({ from: sessionAddress("sender"), to: "session:receiver", body: "hi", originToolCallId: "t-ok" });
    expect(outcome.status).toBe("delivered");
  });
});
