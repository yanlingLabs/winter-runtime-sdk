// THE WINTER BRANCH'S `RuntimeMessagingAdapter` (WS-10 §15), as R-7b-4 specifies it:
//
//   * a LIVE session is its `Query.messaging` facet plus an input-stream push;
//   * a LIVE session's CHILDREN are reached through that same facet's `steer_child`/`resume_child` —
//     never through a session address, because a child engine has no facet surface of its own
//     (Task 0 fix r2, concern 4);
//   * an EXITED session is a COLD RESUME: a new `query({ resume })` on the persisted runtime, through
//     the injected Winter peer, followed by one delivered turn.
//
// WS-15 §6.2's routing table is the specification for the outcomes, and the three rows this file
// implements are deliberately distinguishable: "running Winter session → enqueue after the current
// tool boundary" is `queued`; "idle Winter session → persist one inbound message event; start one
// turn" is `delivered`; "exited Winter session → open through the normal session runtime; deliver one
// turn" is `resumed_and_delivered` — and only when resume AND delivery both completed, because
// "`resumed_and_delivered` MUST NOT be claimed for resume alone" (WS-10 §10.3).
//
// WHAT THIS ADAPTER DOES NOT DO, because WS-10 §15 says an adapter "performs owner-specific
// operations only": it resolves no names, applies no inbound policy, allocates no message id, and
// invents no directory row. Every one of those belongs to the router above it, once, for both
// runtimes.
import type { Options } from "@yanlinglabs/winter-agent-sdk";
import { delivered, deliveryUncertain, notFound, refused, resumedAndDelivered, queued, serializeRuntimeAddress, unavailable } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { RuntimeSdkPeers } from "../sdk.ts";
import { entryToListedRuntimeObject, owningSessionIdOf, parentAddressOf, sessionAddressOf } from "../directory/entries.ts";
import type { RuntimeDirectory } from "../seams/directory.ts";
import type { RuntimeDirectoryEntry } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress } from "../seams/messaging-contract.ts";
import type { RouterMessagingAdapter } from "./dispatch.ts";
import type { ChildSelectionInput } from "../selection/runtime-selection.ts";
import { resumeChildSelection } from "../selection/child-runtime.ts";
import { renderAttributedTurn } from "./attribution.ts";
import type { AttachedSessionRegistry, AttachedWinterSession } from "./sessions.ts";

export interface WinterMessagingAdapterDeps {
  peers: RuntimeSdkPeers;
  directory: RuntimeDirectory;
  sessions: AttachedSessionRegistry<AttachedWinterSession>;
  /**
   * The `Options` a COLD RESUME is opened with, beside the `resume` the adapter supplies itself.
   *
   * A resume needs a cwd, a model, a permission mode — session facts the messaging layer does not
   * hold and must not invent. Absent means an empty options object, which is a legitimate resume (the
   * transcript carries the session's own configuration) and is what the hermetic tests use.
   */
  resumeOptions?: (entry: RuntimeDirectoryEntry) => Options | Promise<Options>;
  /**
   * WS-13c §8 / WS-10's Phase 6.6 amendment: the catalogue a RESUMED CHILD re-resolves against.
   *
   * `resumeChildSelection` answers "is the row this child is RECORDED on still servable?" — and a
   * refusal is `{ status: "unavailable", retryable: false, reason: "child-provider-unavailable: …" }`
   * WITH NO GENERATION STARTED, which is why the check runs before the parent's facet is touched.
   * Absent: nothing re-resolves, and the child's own persisted record stands — which is the correct
   * fallback rather than a silent skip, because WS-13c §8 makes that record authoritative anyway; the
   * check only detects DRIFT, and a host with no catalogue has nothing to detect it against.
   */
  childResumeContext?: (entry: RuntimeDirectoryEntry) => Omit<ChildSelectionInput, "slot" | "model" | "provider"> | undefined;
}

/** The adapter plus the one thing the router attaches to it: the live-session registry. */
export interface WinterMessagingAdapter extends RouterMessagingAdapter {
  readonly sessions: AttachedSessionRegistry<AttachedWinterSession>;
}

export function createWinterMessagingAdapter(deps: WinterMessagingAdapterDeps): WinterMessagingAdapter {
  async function entryFor(address: RuntimeAddress): Promise<RuntimeDirectoryEntry | undefined> {
    return deps.directory.get(serializeRuntimeAddress(address));
  }

  function liveStatus(entry: RuntimeDirectoryEntry, handle: AttachedWinterSession | undefined): RuntimeDirectoryEntry["status"] {
    return handle?.status?.() ?? entry.status;
  }

  /** WS-15 §6.2: a running session queues at its next tool boundary; an idle one starts one turn. */
  function liveOutcome(messageId: string, status: RuntimeDirectoryEntry["status"]): DeliveryOutcome {
    return status === "running" ? queued(messageId) : delivered(messageId);
  }

  /**
   * Deliver into one runtime object that HAS A SESSION OF ITS OWN — live handle first, cold resume
   * otherwise. Reached both by `deliverToSession` and by a cross-runtime child (see `childDelivery`).
   */
  async function deliverIntoSession(entry: RuntimeDirectoryEntry, message: GlobalAgentMessage): Promise<DeliveryOutcome> {
    const handle = deps.sessions.get(entry.address);
    if (handle !== undefined) {
      // THE FACET FIRST. It is the runtime's own attributed push: it renders on the far side with the
      // same published escapes this package uses, enforces the owning-parent fence on the sender, and
      // answers `unavailable` for a stream that has already ended — three things a bare writer cannot
      // do. A router-held writer is the fallback for a session the router launched itself.
      if (handle.messaging !== undefined) return handle.messaging.deliver(message);
      if (handle.push !== undefined) {
        try {
          await handle.push(renderAttributedTurn(message, { winterSessionId: entry.parsed.winterSessionId }));
        } catch (error) {
          return deliveryUncertain(message.messageId, `the input-stream push failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return liveOutcome(message.messageId, liveStatus(entry, handle));
      }
    }
    if (entry.status === "archived") {
      return refused(message.messageId, `${entry.address} is archived; it refuses delivery until a deliberate user or product resume unarchives it (WS-15 §6.2)`);
    }
    return coldResume(entry, message);
  }

  async function childDelivery(address: RuntimeAddress, message: GlobalAgentMessage, door: "steer" | "resume"): Promise<DeliveryOutcome> {
    const entry = await entryFor(address);
    if (entry === undefined) return notFound(message.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
    if (door === "resume") {
      const context = deps.childResumeContext?.(entry);
      if (context !== undefined) {
        const outcome = resumeChildSelection(entry.selection, context);
        // NO GENERATION IS STARTED on a refusal: this returns before the parent's facet is reached, so
        // the parent's own turn is untouched (WS13c-SM3).
        if (outcome.kind === "unavailable") return unavailable(message.messageId, outcome.retryable, outcome.reason);
      }
    }
    // A CROSS-RUNTIME CHILD IS ITS OWN SESSION ON THIS RUNTIME (R-7b-1). When a `claude`-family parent
    // spawns a child whose own slot selects Winter, that child is not an engine inside the parent's
    // process — the router launched it here, as a spawned session with its own handle, its own facet
    // and its own backend id. `transport` is the field that says which it is (WS-15 §6.1), and it is
    // the reason the field exists: `winter-session` is a session of its own, `winter-thread` is an
    // in-process child with NO surface of its own, reachable only through its parent's
    // steer/resume (Task 0 fix r2, concern 4). Same shape, two entirely different doors.
    if (entry.transport === "winter-session") return deliverIntoSession(entry, message);

    const parentAddress = parentAddressOf(entry);
    /* c8 ignore next */
    if (parentAddress === undefined) return notFound(message.messageId, `${entry.address} is not a child, so it has no owning parent to route through`); // unreachable: entryFor was called with an agent address
    const parent = deps.sessions.get(parentAddress);
    if (parent?.messaging === undefined) {
      // WS-10 §10.3: "not reachable from another parent without routing through the owner". With no
      // live owner there is no door at all — and RETRYABLE, because the owner coming back is exactly
      // what would change the answer.
      return unavailable(message.messageId, true, `the owning parent ${parentAddress} is not live in this process; a child is only addressable through its owner (WS-10 §10.3)`);
    }
    const childId = entry.parsed.childId ?? entry.address;
    return door === "steer" ? parent.messaging.steerChild(childId, message) : parent.messaging.resumeChild(childId, message);
  }

  /**
   * The cold resume (R-7b-4): a new `query({ resume })` on the persisted runtime, then one turn.
   *
   * HOW "DELIVERED" IS ESTABLISHED, rather than assumed. `system/init` proves only that the runtime
   * came back; the message is delivered when the turn it is part of actually begins, so the stream is
   * read until an `assistant` or `result` message appears. The three failure shapes are told apart by
   * what they PROVE, which is the same distinction WS-10 §12 draws:
   *
   *   * a throw before any message — nothing ran: `unavailable`, RETRYABLE;
   *   * a throw after some message — the turn may already have happened: `delivery_uncertain`;
   *   * a stream that ends with neither — the runtime came and went without a turn we can point at,
   *     which is also indistinguishable from a delivered-then-lost turn: `delivery_uncertain`.
   */
  async function coldResume(entry: RuntimeDirectoryEntry, message: GlobalAgentMessage): Promise<DeliveryOutcome> {
    if (entry.backendSessionId === undefined) {
      return unavailable(message.messageId, false, `${entry.address} has no backend session id, so there is no transcript to resume; a cold resume needs the persisted runtime's own id (WS-15 §6.2)`);
    }
    const base = (await deps.resumeOptions?.(entry)) ?? ({} as Options);
    const options: Options = { ...base, resume: entry.backendSessionId };
    let seen = 0;
    try {
      const query = deps.peers.winter.query({ prompt: renderAttributedTurn(message, { winterSessionId: entry.parsed.winterSessionId }), options });
      for await (const sdkMessage of query) {
        seen += 1;
        if (sdkMessage.type === "assistant" || sdkMessage.type === "result") return resumedAndDelivered(message.messageId);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return seen === 0 ? unavailable(message.messageId, true, `the resumed session could not be opened: ${reason}`) : deliveryUncertain(message.messageId, `the resumed session failed after it had started producing output: ${reason}`);
    }
    return deliveryUncertain(message.messageId, "the resumed session ended without producing a turn, so whether the message was delivered cannot be established");
  }

  return {
    sessions: deps.sessions,
    // The engine IS the session-status event source (Task 0's self-peer registers with
    // `hasReliableIdleSignal: true`), so this branch can honestly back a subscription.
    supportsIdleSubscriptions: true,

    /**
     * The LIVE view this adapter owns: status for the addresses it actually holds a handle for.
     *
     * IT NEVER INVENTS A ROW. WS-10 §15 puts canonical addresses with the daemon, and a runtime that
     * could add rows to a listing could make a session reachable that the router never recorded. So
     * every row here is a directory row, refreshed — "live state refreshes from adapters" (WS-15 §6.1)
     * with the emphasis on REFRESHES.
     */
    async listReachable(scope) {
      const rows: ListedRuntimeObject[] = [];
      for (const address of deps.sessions.addresses()) {
        const entry = await deps.directory.get(address);
        if (entry === undefined || entry.runtimeKind !== "winter-agent") continue;
        if (scope.parent !== undefined && entry.objectKind === "agent" && owningSessionIdOf(entry.parsed) !== owningSessionIdOf(scope.parent)) continue;
        rows.push({ ...entryToListedRuntimeObject(entry), status: liveStatus(entry, deps.sessions.get(address)) });
      }
      return rows;
    },

    steerChild(address, message) {
      return childDelivery(address, message, "steer");
    },

    resumeChild(address, message) {
      return childDelivery(address, message, "resume");
    },

    async deliverToSession(address, message) {
      const entry = await entryFor(address);
      if (entry === undefined) return notFound(message.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
      return deliverIntoSession(entry, message);
    },

    async subscribeIdle(address, request) {
      const key = serializeRuntimeAddress(address);
      if (address.objectKind !== "session") {
        return refused(request.messageId, "notify_when_idle targets a top-level session only; a subagent is never a valid target (WS-10 §14)");
      }
      const handle = deps.sessions.get(key);
      if (handle?.messaging === undefined) {
        // "Adapters without a reliable idle signal MUST refuse the ENTIRE call" (WS-10 §14). A session
        // this process holds no facet for has no idle signal at all, and a `subscribed` here would be
        // a promise with no mechanism behind it.
        return refused(request.messageId, `${key} is not live in this process, so there is no idle signal to subscribe to (WS-10 §14)`);
      }
      return handle.messaging.subscribeIdle(key, { messageId: request.messageId });
    },

    async senderPermissionClass(address): Promise<PermissionClassLabel> {
      // A CHILD ANSWERS WITH ITS OWNER'S CLASS, because it runs under the owning parent's permission
      // mode — there is no separate mode to report (WS-10 §10.3's "delivered inside the owning parent
      // session"). A session with no live facet is `unknown`, which is WS-10 §13's own word for "an
      // authenticated route that cannot prove sender class".
      const owner = deps.sessions.get(sessionAddressOf(owningSessionIdOf(address)));
      if (owner?.messaging === undefined) return "unknown";
      try {
        return await owner.messaging.senderClass();
      } catch {
        return "unknown";
      }
    },
  };
}
