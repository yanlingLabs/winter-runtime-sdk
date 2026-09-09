// WS-15 §6.4's RESTART RECOVERY — the seven steps, against the R-7b-2 seam rather than a database.
//
//   1. Rebuild durable address/backend mappings.
//   2. Mark previously live handles unavailable until process identity revalidates.
//   3. Reattach/resume supervised top-level runtimes where policy permits.
//   4. Rebuild Winter child ownership/resume context from durable state.
//   5. Reconcile claimed-but-unreceipted messages as uncertain; never blind-redeliver to any
//      official-runtime target.
//   6. Expire stale name leases and idle subscriptions by generation/TTL.
//   7. Resume queued product-session messages only after receiver policy re-evaluates.
//
// TWO STEPS NEED A COLLABORATOR THIS PACKAGE CANNOT BE, and both default to the conservative answer
// rather than to a guess:
//
//   * step 2 asks whether a recorded `{pid, startedAt}` is still THAT process. Nothing portable in a
//     library can answer it (an OS recycles pids, which is why the field is a pair), so the host
//     supplies the probe. WITH NO PROBE, NOTHING REVALIDATES — every previously live handle is marked
//     unavailable, which is the step's own default state and never a false claim of liveness.
//   * step 3 says "where policy permits", and policy is the host's (D19c keeps switch/resume UX with
//     the harness). With no hook, nothing is reattached and the step says so.
//
// AND ONE STEP IS A DELIBERATE NON-ACTION. Step 7 counts held mail and delivers none of it: releasing
// a held message requires the RECEIVER's policy to be re-evaluated (WS-10 §13 — "held messages are
// re-evaluated when the receiver's mode or settings change"), which needs a live receiver this
// process has just been told it does not have. The messaging router's own release door is where that
// happens; recovery's job is to make sure the mail is still there and counted.
import type { RuntimeDirectoryRecovery, RuntimeDirectoryRecoveryStep } from "../seams/directory.ts";
import type { RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../seams/directory-store.ts";
import { deliveryUncertain } from "@yanlinglabs/winter-agent-sdk/messaging";
import { isLiveStatus, parentAddressOf } from "./entries.ts";

export interface RuntimeDirectoryRecoveryHooks {
  /**
   * WS-15 §6.4 step 2 / WS-14 §9: is the recorded `{pid, startedAt}` still that same process?
   *
   * A BARE PID IS NEVER ENOUGH — an OS recycles them — so an implementation must compare the start
   * identity too, which is why the field is a pair. Absent: nothing revalidates.
   */
  revalidateProcessIdentity?: (entry: RuntimeDirectoryEntry) => Promise<boolean> | boolean;
  /** WS-15 §6.4 step 3: "where policy permits" — the host's call, never the router's. */
  reattachSupervised?: (entry: RuntimeDirectoryEntry) => Promise<"reattached" | "skipped"> | "reattached" | "skipped";
}

export interface RecoverDirectoryInput {
  store: RuntimeDirectoryStore;
  now: () => number;
  hooks: RuntimeDirectoryRecoveryHooks;
}

export async function recoverDirectory(input: RecoverDirectoryInput): Promise<RuntimeDirectoryRecovery> {
  const { store, now, hooks } = input;
  const steps: RuntimeDirectoryRecoveryStep[] = [];
  const at = new Date(now()).toISOString();

  // --- 1. Rebuild durable address/backend mappings --------------------------------------------------
  const entries = await store.load();
  const cursors = await store.cursors.all();
  const cursorsRestored = Object.keys(cursors).length;
  const withBackend = entries.filter((entry) => entry.backendSessionId !== undefined).length;
  steps.push({
    step: 1,
    name: "rebuild durable address/backend mappings",
    outcome: `${entries.length} entr${entries.length === 1 ? "y" : "ies"} loaded (${withBackend} with a backend session id), ${cursorsRestored} cursor(s) restored`,
  });

  // --- 2. Mark previously live handles unavailable until process identity revalidates ----------------
  const previouslyLive = entries.filter((entry) => isLiveStatus(entry.status));
  let revalidated = 0;
  let staleMarked = 0;
  for (const entry of previouslyLive) {
    const ok = entry.processIdentity !== undefined && hooks.revalidateProcessIdentity !== undefined ? await hooks.revalidateProcessIdentity(entry) : false;
    if (ok) {
      revalidated += 1;
      continue;
    }
    // NEVER DELETED, ONLY MARKED. WS-15 §6.1's status vocabulary has `unavailable` precisely so a
    // record can say "I know this object and I cannot reach it" — which is what a resume, a listing
    // and a delivery refusal each need to read. A deleted row would answer "no such agent", and a
    // row still claiming `running` would answer with a process that is gone.
    await store.upsert({ ...entry, status: "unavailable", updatedAt: at });
    staleMarked += 1;
  }
  steps.push({
    step: 2,
    name: "mark previously live handles unavailable until process identity revalidates",
    outcome:
      hooks.revalidateProcessIdentity === undefined
        ? `${staleMarked} of ${previouslyLive.length} previously live handle(s) marked unavailable; no process-identity probe was supplied, so nothing could revalidate`
        : `${revalidated} revalidated by pid + start identity, ${staleMarked} marked unavailable`,
  });

  // --- 3. Reattach/resume supervised top-level runtimes where policy permits -------------------------
  let reattached = 0;
  if (hooks.reattachSupervised !== undefined) {
    for (const entry of entries) {
      if (entry.objectKind !== "session") continue;
      if ((await hooks.reattachSupervised(entry)) === "reattached") reattached += 1;
    }
  }
  steps.push({
    step: 3,
    name: "reattach/resume supervised top-level runtimes where policy permits",
    outcome: hooks.reattachSupervised === undefined ? "no reattachment policy supplied; nothing was reattached (D19c keeps resume policy with the host)" : `${reattached} session(s) reattached`,
  });

  // --- 4. Rebuild child ownership/resume context from durable state ----------------------------------
  const addresses = new Set(entries.map((entry) => entry.address));
  const children = entries.filter((entry) => entry.objectKind === "agent");
  let orphaned = 0;
  for (const child of children) {
    const parent = parentAddressOf(child);
    if (parent !== undefined && addresses.has(parent)) continue;
    // A CHILD WHOSE OWNER IS GONE IS UNREACHABLE, not absent: "a child is only addressable within its
    // owning parent" (WS-10 §10.3), so with no parent record there is no door left — and saying so is
    // what lets a resume refuse with a reason instead of a not-found.
    if (child.status !== "unavailable") {
      await store.upsert({ ...child, status: "unavailable", updatedAt: at });
      staleMarked += 1;
    }
    orphaned += 1;
  }
  steps.push({
    step: 4,
    name: "rebuild child ownership/resume context from durable state",
    outcome: `${children.length} child record(s); ${orphaned} with no surviving owner marked unavailable`,
  });

  // --- 5. Reconcile claimed-but-unreceipted messages as uncertain ------------------------------------
  const claimed = await store.deliveries.claimedWithoutReceipt();
  for (const record of claimed) {
    await store.deliveries.put({
      ...record,
      outcome: deliveryUncertain(
        record.messageId,
        `the router was interrupted between claiming this message for the ${record.claimedBy ?? "unknown"} runtime and recording its receipt; recovery never repeats effectful work (WS-10 §12, WS-15 §6.4 step 5)`,
      ),
      updatedAt: at,
    });
  }
  steps.push({
    step: 5,
    name: "reconcile claimed-but-unreceipted messages as uncertain",
    outcome: `${claimed.length} claimed-without-receipt message(s) recorded as delivery_uncertain; none were redelivered`,
  });

  // --- 6. Expire stale name leases and idle subscriptions by generation/TTL --------------------------
  const byAddress = new Map(entries.map((entry) => [entry.address, entry]));
  let leasesReleased = 0;
  for (const lease of await store.names.held()) {
    const holder = byAddress.get(lease.address);
    if (holder !== undefined && holder.generation === lease.generation) continue;
    await store.names.release(lease.name, lease.address, at);
    leasesReleased += 1;
  }
  const nowMs = now();
  let subscriptionsExpired = 0;
  let subscriptionsKept = 0;
  for (const subscription of await store.subscriptions.list()) {
    const target = byAddress.get(subscription.target);
    // WS-15 §6.3: a subscription "survives restart only when durably stored with VALID TARGET
    // IDENTITY/GENERATION". A target that is gone, or that came back as a new incarnation, is not the
    // thing the subscriber asked about — firing for it later would be a notice about somebody else.
    if (subscription.expiresAt <= nowMs || target === undefined || target.generation !== subscription.targetGeneration) {
      await store.subscriptions.remove(subscription.messageId);
      subscriptionsExpired += 1;
      continue;
    }
    subscriptionsKept += 1;
  }
  steps.push({
    step: 6,
    name: "expire stale name leases and idle subscriptions by generation/TTL",
    outcome: `${leasesReleased} name lease(s) released (holder gone or a newer generation), ${subscriptionsExpired} idle subscription(s) expired, ${subscriptionsKept} still valid`,
  });

  // --- 7. Resume queued product-session messages only after receiver policy re-evaluates -------------
  const receivers = await store.mailboxes.receivers();
  let heldMessagesFound = 0;
  for (const receiver of receivers) heldMessagesFound += (await store.mailboxes.listHeld(receiver)).length;
  steps.push({
    step: 7,
    name: "resume queued product-session messages only after receiver policy re-evaluates",
    outcome: `${heldMessagesFound} held message(s) for ${receivers.length} receiver(s); none released — a release requires the receiver's own inbound policy to re-evaluate (WS-10 §13)`,
  });

  return { steps, entriesLoaded: entries.length, staleMarked, cursorsRestored, heldMessagesFound };
}
