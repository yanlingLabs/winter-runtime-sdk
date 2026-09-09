// WS-17 ROW 4's MESSAGING HALF, and ROW 5's.
//
// Row 4: "Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake,
// zero visibility into `~/.claude`." The LAST clause is a filesystem fact and is Lane A's, proven
// against the real 0.3.250 runtime under a temp HOME (`test/official/runtime-spool.test.ts`). The
// first four are messaging facts, and they are these tests: what one official session can DISCOVER
// about the other, what reaches it, what its policy does to what reaches it, and what happens when it
// is idle rather than running.
//
// Row 5: "Official parent resume after restart restores completed children for native `SendMessage`
// resume." Three lanes meet here — Lane A resumes the runtime, Lane C reconciles the store, and the
// DIRECTORY is what has to still know the children afterwards. This file proves the directory and
// messaging half end to end: recovery marks the world unavailable, the host resumes the parent, and a
// native `SendMessage` to a COMPLETED child of that parent routes through the resumed parent again.
import { describe, expect, test } from "bun:test";

import { createMessagingToolHandlers, createRuntimeMessaging } from "../../src/messaging/index.ts";
import type { GlobalMessagingOptions } from "../../src/messaging/index.ts";
import { childEntry, createBed, createFakeOfficialSession, sessionEntry } from "./support.ts";

function bedWith(options: GlobalMessagingOptions = {}) {
  const bed = createBed();
  const { directory, messaging } = createRuntimeMessaging(bed.context, { directory: { now: bed.clock.now }, messaging: { now: bed.clock.now, ...options } });
  return { ...bed, directory, messaging };
}

const parse = (result: { content: Array<{ text: string }> }): Record<string, unknown> => JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;

/** Two official sessions, each with its own live handle and one child of its own. */
async function twoOfficialSessions(world: ReturnType<typeof bedWith>) {
  const alpha = createFakeOfficialSession("running");
  const beta = createFakeOfficialSession("running");
  await world.directory.record(sessionEntry("alpha", { runtimeKind: "claude-agent", displayName: "alpha" }));
  await world.directory.record(sessionEntry("beta", { runtimeKind: "claude-agent", displayName: "beta" }));
  await world.directory.record(childEntry("alpha", "a-child", { runtimeKind: "claude-agent", displayName: "alpha-helper" }));
  await world.directory.record(childEntry("beta", "b-child", { runtimeKind: "claude-agent", displayName: "beta-helper" }));
  world.messaging.attachOfficialSession("session:alpha", alpha.handle);
  world.messaging.attachOfficialSession("session:beta", beta.handle);
  return { alpha, beta };
}

describe("row 4's messaging half — two official sessions", () => {
  test("DISCOVERY is isolated: each sees the other session and its OWN children, never the other's", async () => {
    const world = bedWith();
    await twoOfficialSessions(world);
    const fromAlpha = createMessagingToolHandlers(world.messaging, { sessionId: "alpha" });
    const fromBeta = createMessagingToolHandlers(world.messaging, { sessionId: "beta" });

    const alphaListing = String(parse(await fromAlpha.listAgents({}))["listing"]);
    expect(alphaListing).toContain("beta (session:beta)");
    expect(alphaListing).toContain("alpha-helper");
    expect(alphaListing).not.toContain("beta-helper"); // WS-10 §10.3's owning-parent fence, in a listing
    expect(alphaListing).not.toContain("session:alpha ");

    const betaListing = String(parse(await fromBeta.listAgents({}))["listing"]);
    expect(betaListing).toContain("beta-helper");
    expect(betaListing).not.toContain("alpha-helper");
  });

  test("the other session's CHILD is not addressable either — the fence is not merely a listing filter", async () => {
    const world = bedWith();
    const { alpha, beta } = await twoOfficialSessions(world);
    const fromAlpha = createMessagingToolHandlers(world.messaging, { sessionId: "alpha", toolUseId: "t1" });

    const result = await fromAlpha.sendMessage({ to: "agent:beta:b-child", message: "hi" });
    expect(result.isError).toBe(true);
    expect(parse(result)["status"]).toBe("not_found");
    expect(alpha.pushed.length).toBe(0);
    expect(beta.pushed.length).toBe(0);
  });

  test("DELIVERY between the two lands in the receiver's own handle, attributed to the sender", async () => {
    const world = bedWith();
    const { alpha, beta } = await twoOfficialSessions(world);
    const fromAlpha = createMessagingToolHandlers(world.messaging, { sessionId: "alpha", toolUseId: "t1" });

    expect(parse(await fromAlpha.sendMessage({ to: "beta", message: "over to you" }))["status"]).toBe("queued");
    expect(beta.pushed.length).toBe(1);
    expect(beta.pushed[0]).toContain('from="session:alpha"');
    expect(beta.pushed[0]).toContain("over to you");
    expect(alpha.pushed.length).toBe(0);
  });

  test("HOLD and REFUSE are the receiver's, and neither delivers anything", async () => {
    const holding = bedWith({ explicitSetting: (receiver) => (receiver.address === "session:beta" ? "hold" : undefined) });
    const heldPair = await twoOfficialSessions(holding);
    const holdingSender = createMessagingToolHandlers(holding.messaging, { sessionId: "alpha", toolUseId: "t1" });
    expect(parse(await holdingSender.sendMessage({ to: "beta", message: "later" }))["status"]).toBe("held");
    expect(heldPair.beta.pushed.length).toBe(0);
    expect((await holding.store.mailboxes.listHeld("session:beta")).length).toBe(1);

    const refusing = bedWith({ explicitSetting: () => "refuse" });
    const refusedPair = await twoOfficialSessions(refusing);
    const refusingSender = createMessagingToolHandlers(refusing.messaging, { sessionId: "alpha", toolUseId: "t1" });
    const refusal = await refusingSender.sendMessage({ to: "beta", message: "no thanks" });
    expect(parse(refusal)["status"]).toBe("refused");
    expect(refusedPair.beta.pushed.length).toBe(0);
    expect((await refusing.store.mailboxes.listHeld("session:beta")).length).toBe(0); // a refusal is terminal, not a hold
  });

  test("IDLE WAKE: an idle official session starts one turn (`delivered`), a running one queues", async () => {
    const world = bedWith();
    const { beta } = await twoOfficialSessions(world);
    const fromAlpha = createMessagingToolHandlers(world.messaging, { sessionId: "alpha", toolUseId: "t1" });
    expect(parse(await fromAlpha.sendMessage({ to: "beta", message: "while you work" }))["status"]).toBe("queued");

    beta.setStatus("idle");
    const second = createMessagingToolHandlers(world.messaging, { sessionId: "alpha", toolUseId: "t2" });
    expect(parse(await second.sendMessage({ to: "beta", message: "wake up" }))["status"]).toBe("delivered");
    expect(beta.pushed.length).toBe(2);
  });

  test("notify_when_idle against either of them refuses the WHOLE call, message included", async () => {
    const world = bedWith();
    const { beta } = await twoOfficialSessions(world);
    const fromAlpha = createMessagingToolHandlers(world.messaging, { sessionId: "alpha", toolUseId: "t1" });

    const result = await fromAlpha.sendMessage({ to: "beta", message: "tell me when you are done", notify_when_idle: true });
    expect(parse(result)["status"]).toBe("refused");
    // "…refuse the ENTIRE call (including any attached message) so the sender can retry without the
    // flag" — so nothing was delivered either.
    expect(beta.pushed.length).toBe(0);
  });
});

describe("row 5's directory half — an official parent resumed after a restart", () => {
  test("recovery keeps the completed children, and a native SendMessage to one routes through the resumed parent", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("parent", { runtimeKind: "claude-agent", backendSessionId: "backend-p", processIdentity: { pid: 100, startedAt: "t0" } }));
    await world.directory.record(childEntry("parent", "done-1", { runtimeKind: "claude-agent", status: "exited", displayName: "researcher" }));
    await world.directory.record(childEntry("parent", "done-2", { runtimeKind: "claude-agent", status: "exited", displayName: "reviewer" }));

    // THE RESTART. Nothing revalidates, so every live handle is marked unavailable — and the CHILDREN
    // are still there, which is the whole of what row 5 asks the directory for.
    const report = await world.directory.recover();
    expect(report.entriesLoaded).toBe(3);
    expect((await world.directory.get("session:parent"))?.status).toBe("unavailable");
    expect((await world.directory.get("agent:parent:done-1"))?.status).toBe("exited");
    expect((await world.directory.get("agent:parent:done-2"))?.displayName).toBe("reviewer");

    // THE HOST RESUMES THE PARENT (Lane A's `OfficialAdapter.resume`, whose observed spool root and
    // process identity land back on this same row) and attaches the live handle.
    const resumed = createFakeOfficialSession("running");
    await world.directory.record(sessionEntry("parent", { runtimeKind: "claude-agent", backendSessionId: "backend-p", processIdentity: { pid: 200, startedAt: "t1" } }));
    world.messaging.attachOfficialSession("session:parent", resumed.handle);

    // …and the parent's own model resumes a completed child by name, through the aliased tool.
    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "parent", toolUseId: "toolu_after_restart" });
    const listing = String(parse(await handlers.listAgents({}))["listing"]);
    expect(listing).toContain("researcher");

    const result = await handlers.sendMessage({ to: "researcher", message: "carry on where you left off" });
    expect(parse(result)["status"]).toBe("queued");
    expect(resumed.pushed.length).toBe(1);
    // Owner-qualified, because a completed official child is reachable ONLY through its owning parent
    // once that parent is active again (WS-15 §6.2).
    expect(resumed.pushed[0]).toContain('for="agent:parent:done-1"');
    expect(resumed.pushed[0]).toContain("carry on where you left off");
  });

  test("before the parent is resumed, the same send is retryably unavailable rather than not-found", async () => {
    const world = bedWith();
    await world.directory.record(sessionEntry("parent", { runtimeKind: "claude-agent" }));
    await world.directory.record(childEntry("parent", "done-1", { runtimeKind: "claude-agent", status: "exited", displayName: "researcher" }));
    await world.directory.recover();

    const handlers = createMessagingToolHandlers(world.messaging, { sessionId: "parent", toolUseId: "t1" });
    const payload = parse(await handlers.sendMessage({ to: "researcher", message: "hi" }));
    expect(payload["status"]).toBe("unavailable");
    expect(payload["retryable"]).toBe(true);
    // The distinction is the point: the child is KNOWN and unreachable, which is a different answer
    // from "no such agent" and is what tells a caller that resuming the parent would fix it.
    expect(String(payload["reason"])).toContain("session:parent");
  });
});
