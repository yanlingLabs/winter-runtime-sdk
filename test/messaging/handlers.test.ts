// THE TWO HANDLERS WS-14 §7's ALIASES RESOLVE TO — rows 1 and 2's handler half.
//
// Row 1: "Real model-emitted `SendMessage` through the TS alias reaches [the canonical handler] with
// NATIVE ARGS and returns the visible result." Lane A proves the alias half against the real 0.3.250
// runtime with a recording fake in this position; these tests prove the half that fake stood in for —
// that the handler accepts exactly the native schema, does the routing, and returns a result the model
// can act on.
//
// Row 2: "`ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behaviour without
// Tool Search." The handler half is the OUTPUT CONTRACT: "exactly `{ listing: string }`", and "does
// NOT enumerate exited transcripts on disk".
import { describe, expect, test } from "bun:test";

import { createRuntimeMessaging } from "../../src/messaging/index.ts";
// THE HANDLERS ARE THE SDK'S (R-8-1): one declaration for both hosts. The router supplies the PORT —
// its own `GlobalMessagingHandle`, which satisfies `MessagingToolPort` structurally (ruling P-3).
import { createMessagingToolHandlers } from "@yanlinglabs/winter-agent-sdk/tools";
import { toolUseIdFromExtra, VENDOR_TOOL_USE_ID_META_KEY } from "@yanlinglabs/winter-agent-sdk/tools";
import { childEntry, createBed, createFakeFacet, declaredClasses, sessionEntry, winterHandle, winterWriterHandle } from "./support.ts";

function bedWith() {
  const bed = createBed();
  const { directory, messaging } = createRuntimeMessaging(bed.context, { directory: { now: bed.clock.now }, messaging: { now: bed.clock.now } });
  return { ...bed, directory, messaging };
}

// THE SDK HANDLER ANSWERS `{ text, isError? }` (ruling P-4); each host wraps it in its own runtime's
// result type, and the router's wrap is `mcp-descriptors.ts`'s four-line `mcpResult`.
const parse = (result: { text: string }): Record<string, unknown> => JSON.parse(result.text === "" ? "{}" : result.text) as Record<string, unknown>;

// THE ACCEPTOR PLANTS ARE GONE, AND THAT IS THE POINT (R-8-1, carry 3). They asserted the router's own
// copy of WS-10 §10.1/§10.2's model-facing contract — the four native fields, `to`'s rules, the
// `summary` cap, `ListAgents`' two reserved fields — against `src/native-args.ts`, which no longer
// exists. The contract is declared once in `@yanlinglabs/winter-agent-sdk/tools` and tested there, at
// the source, for both hosts. What remains HERE is the only half that is the router's: what happens
// when those accepted arguments meet Lane B's real router over Lane B's real directory.
//
// The acceptors' BEHAVIOUR also moved with them (ruling P-4): the SDK truncates an over-long `summary`
// where the router used to refuse it, refuses an empty message without `notify_when_idle`, and rejects
// arrays. Tests that pinned the old answers are deleted rather than re-pinned here.

describe("row 1's handler half — a native SendMessage block, routed", () => {
  test("the handler delivers and returns the typed outcome as the model's visible result", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    world.messaging.attachWinterSession("session:peer", winterHandle(facet));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller", toolUseId: "toolu_1" });

    const result = await handlers.sendMessage({ to: "reviewer", message: "take a look" });
    expect(result.isError).toBeUndefined();
    const payload = parse(result);
    expect(payload["status"]).toBe("queued");
    expect(typeof payload["messageId"]).toBe("string");
    expect(facet.delivered[0]?.body).toBe("take a look");
  });

  test("the CALLER is bound at registration — a model cannot name a different sender", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer"));
    world.messaging.attachWinterSession("session:peer", winterHandle(facet));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller", toolUseId: "toolu_1" });

    // `from` is not in the native schema at all, so this is refused as an unknown argument rather than
    // silently honoured — the sender's identity is the key every fence in this package rests on.
    const forged = await handlers.sendMessage({ to: "session:peer", message: "hi", from: "session:root" });
    expect(forged.isError).toBe(true);
    await handlers.sendMessage({ to: "session:peer", message: "hi" });
    expect(facet.delivered[0]?.from.winterSessionId).toBe("caller");
  });

  test("a classified failure comes back as a tool ERROR the model can act on, with its candidates", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("one", { displayName: "reviewer" }));
    await world.directory.record(sessionEntry("two", { displayName: "reviewer" }));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller", toolUseId: "toolu_1" });

    const result = await handlers.sendMessage({ to: "reviewer", message: "hi" });
    expect(result.isError).toBe(true);
    const payload = parse(result);
    expect(payload["status"]).toBe("ambiguous");
    expect((payload["candidates"] as Array<{ address: string }>).map((row) => row.address).sort()).toEqual(["session:one", "session:two"]);
  });

  test("a HELD message is not an error — it is a receipt the model should read and stop worrying about", async () => {
    const world = bedWith();
    const senderFacet = createFakeFacet();
    senderFacet.setSenderClass("bypasses");
    const receiverFacet = createFakeFacet();
    receiverFacet.setSenderClass("prompts");
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer"));
    world.messaging.attachWinterSession("session:caller", winterHandle(senderFacet));
    world.messaging.attachWinterSession("session:peer", winterHandle(receiverFacet));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller", toolUseId: "toolu_1" });

    const result = await handlers.sendMessage({ to: "session:peer", message: "hi" });
    expect(result.isError).toBeUndefined();
    expect(parse(result)["status"]).toBe("held");
  });

  test("a combined call reports the SUBSCRIPTION as a separate fact beside the delivery outcome", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer"));
    world.messaging.attachWinterSession("session:peer", winterHandle(facet));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller", toolUseId: "toolu_1" });

    const result = await handlers.sendMessage({ to: "session:peer", message: "hi", notify_when_idle: true });
    const payload = parse(result);
    expect(payload["status"]).toBe("queued");
    expect(payload["notify"]).toEqual({ subscribed: true });
    expect(facet.subscribes.length).toBe(1);
  });

  test("the handler's caller identity carries the tool-call id, so a retry is a lookup", async () => {
    const world = bedWith();
    const facet = createFakeFacet();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer"));
    world.messaging.attachWinterSession("session:peer", winterHandle(facet));
    let toolUseId = "toolu_1";
    const handlers = createMessagingToolHandlers(world.messaging, () => ({ sessionId: "caller", toolUseId }));

    const first = parse(await handlers.sendMessage({ to: "session:peer", message: "hi" }));
    const retry = parse(await handlers.sendMessage({ to: "session:peer", message: "hi" }));
    expect(retry).toEqual(first);
    expect(facet.delivered.length).toBe(1);

    // A DIFFERENT tool call is a different message — and this one is suppressed as a rapid repeat
    // rather than deduped, which is the distinction WS-10 §12 draws between the two mechanisms.
    toolUseId = "toolu_2";
    expect(parse(await handlers.sendMessage({ to: "session:peer", message: "hi" }))["status"]).toBe("refused");
  });
});

describe("row 2's handler half — ListAgents' output contract", () => {
  test("the output is EXACTLY `{ listing: string }`", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller" });

    const payload = parse(await handlers.listAgents({}));
    expect(Object.keys(payload)).toEqual(["listing"]);
    expect(typeof payload["listing"]).toBe("string");
    expect(payload["listing"]).toContain("reviewer (session:peer)");
  });

  test("it never enumerates EXITED transcripts, and never lists the caller itself", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller", { displayName: "me" }));
    await world.directory.record(sessionEntry("live", { displayName: "live-one" }));
    await world.directory.record(sessionEntry("gone", { displayName: "yesterday", status: "exited" }));
    await world.directory.record(sessionEntry("filed", { displayName: "archived-one", status: "archived" }));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller" });

    const listing = String(parse(await handlers.listAgents({}))["listing"]);
    expect(listing).toContain("live-one");
    expect(listing).not.toContain("yesterday");
    expect(listing).not.toContain("archived-one");
    expect(listing).not.toContain("session:caller");
  });

  test("a caller's own children are listed, terminal ones included, and another session's are not", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller"));
    await world.directory.record(sessionEntry("other"));
    await world.directory.record(childEntry("caller", "mine", { displayName: "my-helper" }));
    await world.directory.record(childEntry("caller", "done", { displayName: "finished-helper", status: "exited" }));
    await world.directory.record(childEntry("other", "theirs", { displayName: "their-helper" }));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller" });

    const listing = String(parse(await handlers.listAgents({}))["listing"]);
    expect(listing).toContain("my-helper");
    expect(listing).toContain("finished-helper"); // resumable through its owner — not a transcript on disk
    expect(listing).not.toContain("their-helper");
  });

  test("an empty listing is a sentence, not an empty string", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller"));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller" });
    expect(String(parse(await handlers.listAgents({}))["listing"])).toContain("No agents or sessions");
  });

  test("a malformed ListAgents call is a readable refusal rather than a throw", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("caller"));
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "caller" });
    const result = await handlers.listAgents({ limit: 10 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("limit");
  });
});

// ====================================================================================================
// ITEM 15 — WS-10 §12's RETRY KEY ON THE OFFICIAL BRANCH.
//
// §12 wants the message id derived from (sender session, TOOL-CALL id) so a retry allocates the SAME
// id and gets the stored outcome back instead of starting a second turn. The Winter branch binds the
// tool-use id at registration; the official branch's handler runs inside the vendor's in-process MCP
// server, where the caller is bound once and cannot know the id of any individual call — so until the
// vendor's `extra` was forwarded, an identical official-branch retry was caught only by the
// rapid-repeat guard (a 5-second window), never by idempotency.
//
// THAT `extra` CARRIES THE ID IS A MEASUREMENT, not an assumption — `test/official/runtime-aliases`
// records it against the pinned artifact. What is pinned here is the derivation, hermetically.
// ====================================================================================================
describe("item 15 — the per-call tool-use id from the vendor's `extra`", () => {
  const declaredBed = () => {
    const bed = createBed();
    const { directory, messaging } = createRuntimeMessaging(bed.context, {
      directory: { now: bed.clock.now },
      messaging: { now: bed.clock.now, ...declaredClasses() },
    });
    return { ...bed, directory, messaging };
  };

  // THE READER'S OWN PLANT WENT WITH THE READER (R-8-1, carry 3). Six defensive cases over
  // `toolUseIdFromExtra` — undefined, null, `{}`, a null `_meta`, a non-string value, an empty string —
  // asserted the SDK's function from the consumer side, which is the same duplication the acceptor
  // plants were deleted for. `@yanlinglabs/winter-agent-sdk/tools` tests it at the source. What stays
  // here is the only half that is the router's: that the id it reads becomes THIS session's retry key
  // against Lane B's real router, which the two plants below drive end to end.

  test("a retry with the SAME vendor tool-use id returns the stored outcome, not a second delivery", async () => {
    // The receiver's class is DECLARED here: since D2 an unknown class holds, and this test's subject
    // is the retry key rather than the hold.
    const world = declaredBed();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    const writer = winterWriterHandle(() => "idle");
    world.messaging.attachWinterSession("session:receiver", writer.handle);
    // The caller is bound ONCE, exactly as the official branch registers it — with no tool-use id.
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "sender" });
    const extra = { _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "toolu_retry" } };

    const first = JSON.parse((await handlers.sendMessage({ to: "session:receiver", message: "hi" }, extra)).text) as { messageId: string; status: string };
    const retry = JSON.parse((await handlers.sendMessage({ to: "session:receiver", message: "hi" }, extra)).text) as { messageId: string; status: string };

    // THE SAME ID, derived from the vendor's own per-call value — §12's whole requirement.
    expect(first.messageId).toBe("msg:sender:toolu_retry");
    expect(retry.messageId).toBe(first.messageId);
    // …and exactly ONE turn was started. Before the forwarding, the second call had no key to be
    // idempotent on and only the 5-second rapid-repeat guard stood between it and a second delivery.
    expect(writer.pushed).toHaveLength(1);
  });

  test("two DIFFERENT tool calls are two messages, so the key does not over-collapse", async () => {
    const world = declaredBed();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    const writer = winterWriterHandle(() => "idle");
    world.messaging.attachWinterSession("session:receiver", writer.handle);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "sender" });

    const a = JSON.parse((await handlers.sendMessage({ to: "session:receiver", message: "one" }, { _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "toolu_a" } })).text) as { messageId: string };
    const b = JSON.parse((await handlers.sendMessage({ to: "session:receiver", message: "two" }, { _meta: { [VENDOR_TOOL_USE_ID_META_KEY]: "toolu_b" } })).text) as { messageId: string };
    expect(a.messageId).not.toBe(b.messageId);
    expect(writer.pushed).toHaveLength(2);
  });

  test("with no `extra` the BOUND caller's id is used, so the Winter branch is unchanged", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("sender"));
    await world.directory.record(sessionEntry("receiver"));
    world.messaging.attachWinterSession("session:receiver", winterWriterHandle(() => "idle").handle);
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "sender", toolUseId: "toolu_bound" });
    const result = JSON.parse((await handlers.sendMessage({ to: "session:receiver", message: "hi" })).text) as { messageId: string };
    expect(result.messageId).toBe("msg:sender:toolu_bound");
  });
});
