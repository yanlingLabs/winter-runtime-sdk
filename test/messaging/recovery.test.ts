// WS-15 §6.4's SEVEN-STEP RESTART RECOVERY, against the R-7b-2 seam.
//
// Each step is asserted by its EFFECT on the store, not by the presence of its line in the report:
// a report is a string, and a string can say "2 marked unavailable" while nothing was written.
import { describe, expect, test } from "bun:test";

import { createRuntimeDirectory } from "../../src/messaging/index.ts";
import { NOTIFY_IDLE_EXPIRY_MS } from "@yanlinglabs/winter-agent-sdk/messaging";
import { childEntry, createBed, envelope, sessionAddress, sessionEntry } from "./support.ts";

describe("WS-15 §6.4: restart recovery", () => {
  test("all seven steps run, in order, and the report names each one", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("a"));
    const report = await directory.recover();
    expect(report.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    for (const step of report.steps) expect(step.name.length).toBeGreaterThan(10);
  });

  test("step 1 rebuilds the mappings and counts the cursors it restored", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("a", { backendSessionId: "backend-a" }));
    await directory.record(sessionEntry("b"));
    await bed.store.cursors.set("session:a", "cursor-42");

    const report = await directory.recover();
    expect(report.entriesLoaded).toBe(2);
    expect(report.cursorsRestored).toBe(1);
    expect(report.steps[0]?.outcome).toContain("1 with a backend session id");
    // The cursor is not consumed by the sweep — WS-17 row 11's "preserves … cursors" starts here.
    expect(await bed.store.cursors.get("session:a")).toBe("cursor-42");
  });

  test("step 2 marks every previously live handle unavailable when NOTHING can revalidate", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("live", { status: "running", processIdentity: { pid: 10, startedAt: "t0" } }));
    await directory.record(sessionEntry("idle", { status: "idle" }));
    await directory.record(sessionEntry("gone", { status: "exited" }));

    const report = await directory.recover();
    expect(report.staleMarked).toBe(2);
    expect((await directory.get("session:live"))?.status).toBe("unavailable");
    expect((await directory.get("session:idle"))?.status).toBe("unavailable");
    // An already-terminal row is NOT touched: recovery marks what claimed to be live, and nothing else.
    expect((await directory.get("session:gone"))?.status).toBe("exited");
    expect(report.steps[1]?.outcome).toContain("no process-identity probe was supplied");
  });

  test("step 2 revalidates on pid PLUS start identity — a recycled pid does not count", async () => {
    const bed = createBed();
    const seen: Array<{ pid: number; startedAt: string }> = [];
    const directory = createRuntimeDirectory(bed.context, {
      now: bed.clock.now,
      revalidateProcessIdentity: (entry) => {
        seen.push(entry.processIdentity as { pid: number; startedAt: string });
        // The probe a host would write: the pid is alive AND it started when we recorded it.
        return entry.processIdentity?.startedAt === "t0";
      },
    });
    await directory.record(sessionEntry("same", { processIdentity: { pid: 77, startedAt: "t0" } }));
    await directory.record(sessionEntry("recycled", { processIdentity: { pid: 77, startedAt: "t1" } }));

    const report = await directory.recover();
    expect(seen.length).toBe(2);
    expect((await directory.get("session:same"))?.status).toBe("running");
    expect((await directory.get("session:recycled"))?.status).toBe("unavailable");
    expect(report.steps[1]?.outcome).toContain("1 revalidated");
  });

  test("step 3 reattaches only through the host's policy hook, and says so when there is none", async () => {
    const bed = createBed();
    const noHook = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await noHook.record(sessionEntry("a"));
    expect((await noHook.recover()).steps[2]?.outcome).toContain("no reattachment policy supplied");

    const asked: string[] = [];
    const withHook = createRuntimeDirectory(bed.context, {
      now: bed.clock.now,
      reattachSupervised: (entry) => {
        asked.push(entry.address);
        return "reattached";
      },
    });
    const report = await withHook.recover();
    expect(asked).toEqual(["session:a"]);
    expect(report.steps[2]?.outcome).toContain("1 session(s) reattached");
  });

  test("step 4 marks a child whose owner did not survive as unavailable, never as absent", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("parent"));
    await directory.record(childEntry("parent", "kept"));
    await directory.record(childEntry("vanished", "orphan"));

    const report = await directory.recover();
    expect(report.steps[3]?.outcome).toContain("1 with no surviving owner");
    // STILL THERE, and that is the point: a resume can now refuse with a reason instead of a not-found.
    expect((await directory.get("agent:vanished:orphan"))?.status).toBe("unavailable");
    expect(await directory.get("agent:parent:kept")).toBeDefined();
  });

  test("step 5 turns every claimed-but-unreceipted delivery into delivery_uncertain, and redelivers nothing", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await bed.store.deliveries.put({ messageId: "crashed", message: envelope({ messageId: "crashed" }), toGeneration: 1, claimedBy: "claude-agent", updatedAt: "t" });
    await bed.store.deliveries.put({ messageId: "settled", message: envelope({ messageId: "settled" }), toGeneration: 1, claimedBy: "winter-agent", outcome: { status: "delivered", messageId: "settled" }, updatedAt: "t" });

    const report = await directory.recover();
    expect(report.steps[4]?.outcome).toContain("1 claimed-without-receipt");
    const crashed = await bed.store.deliveries.get("crashed");
    expect(crashed?.outcome?.status).toBe("delivery_uncertain");
    if (crashed?.outcome?.status === "delivery_uncertain") {
      expect(crashed.outcome.deliveryMayHaveOccurred).toBe(true);
      expect(crashed.outcome.reason).toContain("claude-agent");
    }
    // A settled record is untouched — recovery reconciles the crash window, it does not rewrite history.
    expect((await bed.store.deliveries.get("settled"))?.outcome?.status).toBe("delivered");
    expect(await bed.store.deliveries.claimedWithoutReceipt()).toEqual([]);
  });

  test("step 6 releases leases whose holder is gone or is a NEWER generation, and expires subscriptions by TTL and by generation", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("holder", { displayName: "keeper", generation: 1 }));
    await directory.record(sessionEntry("subscriber"));
    await directory.record(sessionEntry("target", { generation: 2 }));
    // A lease left behind by an object that is no longer in the directory at all.
    await bed.store.names.claim({ name: "ghost", address: "session:ghost", generation: 1, claimedAt: "t" });

    const at = bed.clock.now();
    await bed.store.subscriptions.add({ messageId: "fresh", subscriber: "session:subscriber", target: "session:target", targetGeneration: 2, createdAt: at, expiresAt: at + NOTIFY_IDLE_EXPIRY_MS });
    await bed.store.subscriptions.add({ messageId: "old-generation", subscriber: "session:subscriber", target: "session:target", targetGeneration: 1, createdAt: at, expiresAt: at + NOTIFY_IDLE_EXPIRY_MS });
    await bed.store.subscriptions.add({ messageId: "expired", subscriber: "session:subscriber", target: "session:target", targetGeneration: 2, createdAt: at - 1, expiresAt: at - 1 });

    const report = await directory.recover();
    expect(report.steps[5]?.outcome).toContain("1 name lease(s) released");
    expect((await bed.store.names.held()).map((lease) => lease.name)).toEqual(["keeper"]);
    expect((await bed.store.subscriptions.list()).map((record) => record.messageId)).toEqual(["fresh"]);
    expect(report.steps[5]?.outcome).toContain("2 idle subscription(s) expired");
  });

  test("step 7 finds held mail and releases NONE of it", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("receiver"));
    await bed.store.mailboxes.hold({ messageId: "h1", receiver: "session:receiver", reason: "held for review", kind: "explicit", heldAt: 0, message: envelope({ messageId: "h1" }) });

    const report = await directory.recover();
    expect(report.heldMessagesFound).toBe(1);
    expect(report.steps[6]?.outcome).toContain("none released");
    // Still held: releasing it requires the RECEIVER's own policy to re-evaluate (WS-10 §13), which is
    // the router's door and needs a live receiver this process has just been told it does not have.
    expect((await bed.store.mailboxes.listHeld("session:receiver")).length).toBe(1);
  });

  test("recovery is idempotent: a second run marks nothing new and reconciles nothing twice", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("live"));
    await bed.store.deliveries.put({ messageId: "crashed", message: envelope({ messageId: "crashed" }), toGeneration: 1, claimedBy: "winter-agent", updatedAt: "t" });

    const first = await directory.recover();
    const second = await directory.recover();
    expect(first.staleMarked).toBe(1);
    expect(second.staleMarked).toBe(0);
    expect(second.steps[4]?.outcome).toContain("0 claimed-without-receipt");
  });

  test("a stale name survives recovery as a REFUSAL rather than as an unknown name", async () => {
    const bed = createBed();
    const directory = createRuntimeDirectory(bed.context, { now: bed.clock.now });
    await directory.record(sessionEntry("caller"));
    await directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    await directory.forget("session:peer");
    await directory.recover();

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("stale-name");
  });
});
