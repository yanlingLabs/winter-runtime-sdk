// WS-15 §6.2–6.4: THE CROSS-RUNTIME MESSAGING ROUTER — the shared core (R-7b-4) composed with two
// adapters, a directory, and the durable ledger the in-process reference never needed.
//
// WHAT THE CORE BRINGS, and is therefore NOT re-implemented here: WS-10 §12's id allocation and retry
// short-circuit, §11's resolution order (rules 1–6), the self-target refusal, the size bound and the
// rapid-repeat loop guard, §14's sender- and target-side eligibility, the steer-vs-resume split, and
// the throw classifier. Every one of those is `@yanlinglabs/winter-agent-sdk/messaging`'s, shared
// verbatim with the Winter runtime's own router, which is the whole point of R-7b-4.
//
// WHAT THIS MODULE ADDS, in the order WS-15 §6.2 puts it:
//
//   1. A DURABLE LEDGER. "Allocate and persist the request/message ID BEFORE address resolution (so
//      ambiguous/missing/unavailable outcomes are idempotent too) → persist the envelope and resolved
//      target generation → apply inbound policy → atomically claim for one adapter → … → persist the
//      adapter receipt", so "a retry returns the stored outcome instead of starting a second turn".
//      The core's ledger is an in-memory `Map` (it says so); this one survives the process, which is
//      what makes WS-15 §6.4 step 5's reconciliation possible at all.
//   2. A MESSAGE ID THAT IS STABLE ACROSS A RESTART. §12 derives it "from the sender session plus
//      tool-call ID" — so it is DERIVED here, not counted. A counter (`msg-1`, `msg-2`) is stable
//      within a process and collides across one.
//   3. THE TWO DOORS THE MODEL-FACING SCHEMA DOES NOT REACH: `deliver()` for an already-addressed
//      envelope (a released hold, a reply) with the TTL, hop-count and GENERATION checks a fresh send
//      cannot fail; and `reply()`, which is what makes `MAX_HOP_COUNT` reachable machinery rather than
//      documentation (the core's own note says the model-facing schema can never exceed it).
//   4. THE IDLE RETURN PATH. §14's notice comes back over the Winter facet as a live `idle_notice` or
//      through its `read_notifications` drain; this module dedupes the two by `notification_id`,
//      applies inbound policy to the RETURNING NOTICE (a held subscriber gets a reduced-status
//      notice), fires each subscription at most once, and drops the durable record when it does.
import {
  createLoopGuard,
  createMessagingRouter,
  createNotificationQueue,
  createSubscriberDirectory,
  hopCountExceeded,
  isIdleSubscribeSenderAllowed,
  isIdleSubscribeTargetAllowed,
  rememberBounded,
  refused,
  notFound,
  serializeRuntimeAddress,
  subscribed as subscribedOutcome,
  DEFAULT_HOLD_EXPIRY_MS,
  DEFAULT_MESSAGE_TTL_MS,
  NOTIFY_IDLE_EXPIRY_MS,
} from "@yanlinglabs/winter-agent-sdk/messaging";
import type { MessagingRouterSeam, MessagingRuntimeDeps, NotificationRecord, RuntimeMessagingAdapter, SendMessageResult } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { DirectorySnapshot, RuntimeDirectoryHandle } from "../directory/directory.ts";
import { owningSessionIdOf } from "../directory/entries.ts";
import type { SeamContext } from "../seams/context.ts";
import type { GlobalMessaging, SendMessageRequest } from "../seams/global-messaging.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress, RuntimeKind, SerializedRuntimeAddress } from "../seams/messaging-contract.ts";
import { createDispatchingAdapter, type RouterMessagingAdapter } from "./dispatch.ts";
import { createInboundPolicy, type InboundPolicy, type InboundPolicyHooks } from "./inbound.ts";
import { createOfficialMessagingAdapter, type OfficialMessagingAdapter, type OfficialMessagingAdapterDeps } from "./official-adapter.ts";
import { createAttachedSessionRegistry, type AttachedOfficialSession, type AttachedSessionRegistry, type AttachedWinterSession } from "./sessions.ts";
import { createWinterMessagingAdapter, type WinterMessagingAdapter, type WinterMessagingAdapterDeps } from "./winter-adapter.ts";

/** The context this factory needs: the seam's, with the directory as the concrete handle. */
export interface GlobalMessagingContext extends SeamContext {
  directory: RuntimeDirectoryHandle;
}

export interface GlobalMessagingOptions extends InboundPolicyHooks {
  now?: () => number;
  /** Passed to the Winter adapter this factory builds (cold-resume options, child resume context). */
  winter?: Omit<WinterMessagingAdapterDeps, "peers" | "directory" | "sessions">;
  /** Passed to the official adapter this factory builds (the resume collaborator, the class hook). */
  official?: Omit<OfficialMessagingAdapterDeps, "directory" | "sessions">;
  /**
   * R-7b-4's one behavioural seam, forwarded to the core: how a THROW out of an adapter is classified.
   *
   * ABSENT MEANS EVERYTHING IS UNCERTAIN, which is the conservative reading and the core's own default
   * — `refused` asserts the effect did NOT happen, and from this side "the call failed" and "the
   * effect happened and then the call failed" are indistinguishable (WS-10 §12).
   */
  classifyDeliveryError?: (error: unknown) => "refused" | "uncertain";
}

export interface ReplyRequest {
  /** The envelope being replied to. Its `to` becomes the reply's `from`, and its `from` the target. */
  original: GlobalAgentMessage;
  body: string;
  summary?: string;
}

/** The seam, plus the doors a host and this package's own tool handlers need. */
export interface GlobalMessagingHandle extends GlobalMessaging {
  readonly winterAdapter: WinterMessagingAdapter;
  readonly officialAdapter: OfficialMessagingAdapter;
  /** Register a live Winter session AND bridge its idle notices. Returns the detach function. */
  attachWinterSession(address: SerializedRuntimeAddress, handle: AttachedWinterSession): () => void;
  attachOfficialSession(address: SerializedRuntimeAddress, handle: AttachedOfficialSession): () => void;
  /**
   * `send()`, keeping the shared core's SUPPLEMENTARY fact about a combined call.
   *
   * The seam pins `send(): Promise<DeliveryOutcome>`, and the delivery outcome is rightly primary —
   * but a call that carried both a message AND `notify_when_idle` has a second, separate result (was
   * the subscription honoured?), and WS-10 §10.1's own result text allows for it. The core reports it
   * beside the outcome rather than inventing an eleventh status; this door is where that survives, and
   * `send()` is exactly `(await sendDetailed(...)).outcome`.
   */
  sendDetailed(request: SendMessageRequest): Promise<SendMessageResult>;
  /** WS-10 §13's re-evaluation door: sweep, re-decide, deliver what is now acceptable. */
  releaseHeld(receiver: SerializedRuntimeAddress): Promise<DeliveryOutcome[]>;
  /** Reply routing — the one path on which `hopCount` grows, and therefore the one the bound binds. */
  reply(request: ReplyRequest): Promise<DeliveryOutcome>;
  /** WS-06 §3.6's `ReadNotifications` page for one session's own queue. */
  readNotifications(sessionId: string): { notifications: NotificationRecord[]; remaining: number };
  /**
   * "This target has gone idle" — WS-10 §14's firing edge, from whatever noticed it.
   *
   * Called by the Winter facet bridge for every live notice and every drained one; a host that detects
   * idleness some other way calls it too. Returns how many notices were pushed.
   */
  noteIdle(target: SerializedRuntimeAddress, notice?: { notificationId?: string; content?: string }): Promise<number>;
  /** The caps and windows this router enforces, so a host can render them without re-deriving them. */
  readonly bounds: { heldCap: number; acceptedCap: number; holdExpiryMs: number; idleSubscriptionMs: number; messageTtlMs: number };
}

/**
 * WS-10 §12's message id: "derived/persisted from the sender session plus tool-call ID", so that "a
 * retry with the same ID returns the stored outcome".
 *
 * DERIVED, NOT COUNTED, and that is the whole point: the shared core allocates `msg-1`, `msg-2` from
 * an in-process counter, which is stable within one process and COLLIDES across a restart — two
 * different messages would share an id, and the second would be answered with the first's stored
 * outcome. Both components are percent-encoded so the pair can never be ambiguous.
 */
export function deriveMessageId(senderSessionId: string, toolUseId: string): string {
  return `msg:${encodeURIComponent(senderSessionId)}:${encodeURIComponent(toolUseId)}`;
}

const MAX_TRACKED_NOTICES = 1_000;

export function createGlobalMessaging(context: GlobalMessagingContext, options: GlobalMessagingOptions = {}): GlobalMessagingHandle {
  const store = context.directoryStore;
  const directory = context.directory;
  const now = options.now ?? (() => Date.now());

  const winterSessions: AttachedSessionRegistry<AttachedWinterSession> = createAttachedSessionRegistry<AttachedWinterSession>();
  const officialSessions: AttachedSessionRegistry<AttachedOfficialSession> = createAttachedSessionRegistry<AttachedOfficialSession>();

  const winterAdapter = createWinterMessagingAdapter({ peers: context.peers, directory, sessions: winterSessions, ...(options.winter ?? {}) });
  const officialAdapter = createOfficialMessagingAdapter({ directory, sessions: officialSessions, ...(options.official ?? {}) });
  const adapters = new Map<RuntimeKind, RouterMessagingAdapter>([
    ["winter-agent", winterAdapter],
    ["claude-agent", officialAdapter],
  ]);

  const policy: InboundPolicy = createInboundPolicy({
    store,
    now,
    ...options,
    // NEW-10: a held message that leaves the mailbox WITHOUT being delivered — swept by the five-minute
    // dialog expiry, or re-evaluated to `refuse` — gets its delivery receipt written through. The
    // ledger is the router's, so the policy names the event and this writes it down; otherwise a
    // sender's durable receipt reads `held` forever for a message that no longer exists.
    onHoldTerminal: async (message, outcome) => {
      const recorded = await store.deliveries.get(message.messageId);
      await persistReceipt(message.messageId, recorded?.message ?? message, recorded?.toGeneration ?? message.toGeneration, recorded?.claimedBy, outcome);
    },
    /**
     * The receiver's class, asked of the runtime that HOLDS the receiver — and `unknown` when it
     * cannot say, which the policy then FAILS CLOSED on (review r1, D2).
     *
     * This used to substitute `prompts`, on the reasoning that WS-10 §13's matrix has no unknown
     * RECEIVER row and that both runtimes' own default mode classifies as prompting. The reasoning is
     * sound and the substitution is still wrong, for one row: if the receiver was launched in
     * `bypassPermissions`, §13's `bypasses x prompts -> hold` — the row that exists to stop a
     * prompting sender's mail landing unreviewed in a bypassing session — never runs. A hold is
     * visible, releasable and reversible; a delivery into a bypassing session is not.
     *
     * So the substitution is gone: `inbound.ts` holds an unknown-class receiver's mail with a reason
     * that names exactly that, and a host clears it by telling the adapter what it launched
     * (`winter.permissionClass` / `official.permissionClass`) or by setting the receiver's own
     * `crossSessionInbound`.
     */
    receiverClass: async (receiver) => (await adapters.get(receiver.runtimeKind)?.senderPermissionClass(receiver.parsed)) ?? "unknown",
  });

  // INSTANCE-LEVEL, not per call: the loop guard is a memory of what was sent moments ago (WS-10 §12's
  // rapid-repeat suppression), the subscriber directory is what remembers who asked about an idle
  // target, and the notification queue is what `ReadNotifications` drains. A per-call copy of any of
  // them would silently disable the rule it implements.
  const loopGuard = createLoopGuard();
  const subscribers = createSubscriberDirectory();
  const notifications = createNotificationQueue();
  const seenNotices = new Map<string, true>();

  async function snapshotFor(from: RuntimeAddress): Promise<DirectorySnapshot> {
    return directory.snapshot({ owningSessionId: owningSessionIdOf(from) });
  }

  function depsFor(snapshot: DirectorySnapshot, seam: MessagingRouterSeam, view: "resolve" | "list", from: RuntimeAddress): MessagingRuntimeDeps {
    return {
      seam,
      // M1: the core's `subscribeIdle` goes through the ROUTER's durable door, not straight to the
      // owner adapter. `from` is the caller the core is running for — the subscriber whose queue the
      // eventual notice belongs to, and the field WS-10 §15's own adapter signature has nowhere to put.
      adapter: createDispatchingAdapter({ snapshot, adapters, policy, store, now, view, subscribeIdleVia: (target, request) => handle.notifyWhenIdle(target, { from, messageId: request.messageId }) }),
      notifications,
      loopGuard,
      subscribers,
      now,
      ...(options.classifyDeliveryError === undefined ? {} : { classifyDeliveryError: options.classifyDeliveryError }),
    };
  }

  /**
   * The core's bookkeeping seam, bound to ONE call and backed by the durable ledger.
   *
   * `allocateMessageId` recomputes the same derivation the caller already used, so the core and the
   * router agree on the id without passing it; `lookupOutcome` answers from what was loaded BEFORE the
   * call (the core's is synchronous, the store is not); `recordOutcome` captures rather than persists,
   * because the receipt must be written once, by the caller, after the core has settled.
   */
  function bindSeam(snapshot: DirectorySnapshot, prior: DeliveryOutcome | undefined): MessagingRouterSeam & { recorded: DeliveryOutcome | undefined } {
    const state: { recorded: DeliveryOutcome | undefined } = { recorded: undefined };
    return {
      get recorded() {
        return state.recorded;
      },
      allocateMessageId: (senderSessionId, toolUseId) => deriveMessageId(senderSessionId, toolUseId),
      recordOutcome: (_messageId, outcome) => {
        state.recorded = outcome;
      },
      lookupOutcome: () => prior,
      children: () => [...snapshot.children],
    };
  }

  async function persistReceipt(messageId: string, message: GlobalAgentMessage, toGeneration: number, claimedBy: RuntimeKind | undefined, outcome: DeliveryOutcome): Promise<void> {
    await store.deliveries.put({
      messageId,
      message,
      toGeneration,
      ...(claimedBy === undefined ? {} : { claimedBy }),
      outcome,
      updatedAt: new Date(now()).toISOString(),
    });
  }

  /** The provisional envelope §6.2's first step persists — before there is a resolved target at all. */
  function provisionalEnvelope(request: SendMessageRequest, messageId: string): GlobalAgentMessage {
    const at = now();
    return {
      messageId,
      from: request.from,
      fromGeneration: 0,
      // PRE-RESOLUTION, `to` HOLDS THE RAW TARGET STRING the caller wrote, not an address: there is no
      // resolved address yet, which is precisely what "persist the ID before address resolution" means.
      // The record is overwritten with the resolved envelope the moment resolution produces one, so
      // this shape is only ever observable in the crash window between the two writes — where it is the
      // most useful thing that could be there.
      to: { objectKind: "session", runtimeKind: request.from.runtimeKind, winterSessionId: request.to },
      toGeneration: 0,
      body: request.body,
      ...(request.summary === undefined ? {} : { summary: request.summary }),
      notifyWhenIdle: request.notifyWhenIdle === true,
      createdAt: at,
      expiresAt: at + DEFAULT_MESSAGE_TTL_MS,
      hopCount: 0,
      ...(request.originToolCallId === undefined ? {} : { originToolCallId: request.originToolCallId }),
      senderPermissionClass: "unknown",
    };
  }

  /**
   * Deliver an ALREADY-ADDRESSED envelope through the dispatcher, with no id allocation and no
   * resolution. The internal half of `deliver()`, and the path a released hold and a reply both take.
   */
  /** The `from` this router could not name at all — WS-10 §15: "the daemon authors canonical addresses". */
  function unaddressableSender(from: RuntimeAddress): string | undefined {
    try {
      serializeRuntimeAddress(from);
      return undefined;
    } catch (error) {
      return `the envelope's sender is not a canonical address (${error instanceof Error ? error.message : String(error)}); nothing was delivered`;
    }
  }

  async function dispatchEnvelope(message: GlobalAgentMessage, dispatchOptions: { inboundDecided?: boolean } = {}): Promise<DeliveryOutcome> {
    // D1's shape, for the OTHER malformation (review r2, NEW-4): an `agent:` sender with no `childId`
    // cannot be serialized at all, and the throw used to land in this function's own catch as
    // `delivery_uncertain` — "the delivery may have occurred" about an envelope that never reached an
    // adapter. Reachable only through the host's `deliver()`/`reply()` doors with a hand-built
    // address, never by a model; a refusal either way, and this one is honest about having happened.
    const senderRefusal = unaddressableSender(message.from);
    if (senderRefusal !== undefined) return refused(message.messageId, senderRefusal);
    const snapshot = await snapshotFor(message.from);
    const key = serializeRuntimeAddress(message.to);
    const entry = snapshot.byAddress.get(key);
    if (entry === undefined) return notFound(message.messageId, `no directory record for ${key}`);

    // WS-15 §6.1: "delivery resolves and records the target generation so a STALE SEND CANNOT REACH A
    // REPLACEMENT PROCESS". A fresh send stamps the current generation and can never fail this; an
    // envelope that has been sitting in a mailbox, or that a caller built earlier, can and must.
    if (message.toGeneration !== entry.generation) {
      return refused(message.messageId, `addressed to generation ${message.toGeneration} of ${key}, which is now generation ${entry.generation}; a message never reaches a replacement incarnation (WS-15 §6.1)`);
    }
    if (now() >= message.expiresAt) {
      return refused(message.messageId, `the message expired before it could be delivered (a finite TTL is required by WS-10 §12); nothing was delivered`);
    }
    if (hopCountExceeded(message.hopCount)) {
      return refused(message.messageId, `the message exceeded the maximum hop count; a relay chain is stopped rather than followed (WS-10 §12's loop detection)`);
    }

    const dispatcher = createDispatchingAdapter({ snapshot, adapters, policy, store, now, view: "resolve", ...(dispatchOptions.inboundDecided === true ? { inboundDecided: true } : {}) });
    let outcome: DeliveryOutcome;
    try {
      if (message.to.objectKind === "agent") {
        // WS-10 §10.3's steer-vs-resume split, decided by the CHILD's own live status — the same rule
        // the core applies through `ChildLike.status()`, applied here to the durable row.
        outcome = entry.status === "running" || entry.status === "starting" ? await dispatcher.steerChild(message.to, message) : await dispatcher.resumeChild(message.to, message);
      } else {
        outcome = await dispatcher.deliverToSession(message.to, message);
      }
    } catch (error) {
      outcome =
        options.classifyDeliveryError?.(error) === "refused"
          ? refused(message.messageId, error instanceof Error ? error.message : String(error))
          : { status: "delivery_uncertain", messageId: message.messageId, deliveryMayHaveOccurred: true, reason: `unexpected error during delivery: ${error instanceof Error ? error.message : String(error)}` };
    }
    // The receipt carries the record's OWN claim rather than an assumed one: a message the inbound
    // policy held was never handed to an adapter, and a record that claimed otherwise would make
    // WS-15 §6.4 step 5's "claimed but unreceipted" reconciliation read a fiction.
    const recorded = await store.deliveries.get(message.messageId);
    await persistReceipt(message.messageId, recorded?.message ?? message, recorded?.toGeneration ?? entry.generation, recorded?.claimedBy, outcome);
    return outcome;
  }

  /**
   * Drain the notices a session queued while this host was not listening, and fire each one.
   *
   * BOUNDED BY PAGES, not by a `while (remaining > 0)`: `remaining` comes from the far side of a wire,
   * and a loop that trusted it would spin forever against a runtime that answered wrongly. Ten pages
   * is far past any real backlog (a subscription is one-shot and expires in twelve hours), and the
   * unread remainder stays queued rather than being dropped.
   */
  async function drainMissedNotices(address: SerializedRuntimeAddress, facet: NonNullable<AttachedWinterSession["messaging"]>): Promise<void> {
    for (let page = 0; page < 10; page += 1) {
      let drained: { notifications: NotificationRecord[]; remaining: number };
      try {
        drained = await facet.readNotifications();
      } catch {
        return; // a facet that cannot answer is not an error the attach should raise
      }
      for (const record of drained.notifications) {
        await handle.noteIdle(address, { notificationId: record.notification_id, content: record.content });
      }
      if (drained.remaining === 0 || drained.notifications.length === 0) return;
    }
  }

  const handle: GlobalMessagingHandle = {
    winterAdapter,
    officialAdapter,
    bounds: {
      heldCap: policy.caps.held,
      acceptedCap: policy.caps.accepted,
      holdExpiryMs: DEFAULT_HOLD_EXPIRY_MS,
      idleSubscriptionMs: NOTIFY_IDLE_EXPIRY_MS,
      messageTtlMs: DEFAULT_MESSAGE_TTL_MS,
    },

    attachWinterSession(address, session) {
      const detachHandle = winterSessions.attach(address, session);
      if (session.messaging === undefined) return detachHandle;
      const facet = session.messaging;
      // THE IDLE RETURN PATH (Task 0's addendum), both halves. The live `idle_notice` frame and the
      // durable `read_notifications` drain are DELIBERATELY THE SAME NOTICE, correlated by
      // `notification_id`: a host that missed the frame (it crashed, it restarted, it had not
      // connected yet) still collects it, and a host that got both dedupes on the id. `noteIdle` is
      // that dedupe, so both halves can feed it without either having to know about the other.
      const unsubscribe = facet.onIdleNotice((payload) => {
        void handle.noteIdle(address, { notificationId: payload.notice.notification_id, content: payload.notice.content });
      });
      // THE CATCH-UP HALF, run once at attach: whatever was queued while nothing was listening. A
      // DRAIN IS THE ACKNOWLEDGEMENT (it removes), which is why it happens here and not on a timer —
      // draining repeatedly would take notices away from a host that had not acted on them, and
      // draining never would leave WS-15 §6.4's restart recovery with a queue nobody reads.
      void drainMissedNotices(address, facet);
      return () => {
        unsubscribe();
        detachHandle();
      };
    },

    attachOfficialSession(address, session) {
      return officialSessions.attach(address, session);
    },

    registerAdapter(kind, adapter) {
      adapters.set(kind, adapter);
    },

    async listReachable(scope) {
      const snapshot = await snapshotFor(scope.from);
      const selfKey = serializeRuntimeAddress(scope.from);
      const rows: ListedRuntimeObject[] = snapshot.listable.filter((row) => row.address !== selfKey);
      // "Live state refreshes from adapters" (WS-15 §6.1): the durable row is the identity, the
      // adapter's answer is the status. An adapter can never ADD a row here — it is asked only about
      // addresses the directory already holds.
      for (const adapter of new Set(adapters.values())) {
        const live = await adapter.listReachable({ parent: scope.from });
        for (const row of live) {
          const index = rows.findIndex((candidate) => candidate.address === row.address);
          if (index >= 0) rows[index] = { ...(rows[index] as ListedRuntimeObject), status: row.status, capabilities: row.capabilities };
        }
      }
      return rows;
    },

    async send(request) {
      return (await handle.sendDetailed(request)).outcome;
    },

    async sendDetailed(request) {
      const caller = {
        sessionId: owningSessionIdOf(request.from),
        ...(request.from.objectKind === "agent" && request.from.childId !== undefined ? { agentId: request.from.childId } : {}),
        // WS-10 §12's retry key is (sender session, tool-call id). A caller with no tool-call id has
        // nothing that identifies a retry, so it gets a fresh id per call and NO dedupe — stated
        // rather than faked, because a fabricated stable key would make two different messages one.
        toolUseId: request.originToolCallId ?? `no-tool-call:${now()}:${Math.random().toString(36).slice(2, 10)}`,
      };
      const messageId = deriveMessageId(caller.sessionId, caller.toolUseId);

      const prior = await store.deliveries.get(messageId);
      if (prior?.outcome !== undefined) return { outcome: prior.outcome }; // §12: a retry returns the stored outcome

      // §6.2 STEP 1, and it is a step rather than a detail: the id is persisted BEFORE resolution, so
      // an ambiguous/not-found/unavailable answer is idempotent too.
      const provisional = provisionalEnvelope(request, messageId);
      await store.deliveries.put({ messageId, message: provisional, toGeneration: 0, updatedAt: new Date(now()).toISOString() });

      const snapshot = await snapshotFor(request.from);

      // RULE 5 IS THE DIRECTORY'S TO APPLY, and it has to be applied HERE or not at all. The shared
      // core resolves rule 5 over the children it can see — a live roster — which is the whole of the
      // rule inside one conversation and none of it across a restart or after an object is forgotten.
      // The directory holds the name-lease history that remembers a reused name, so the preflight asks
      // it, over the SAME snapshot the core is about to resolve against. Only the stale answer is acted
      // on: ambiguity and not-found are the core's, with its own candidate set.
      const preflight = await directory.resolveIn(snapshot, request.to, { from: request.from });
      if (preflight.kind === "stale-name") {
        const outcome = refused(messageId, preflight.reason);
        await persistReceipt(messageId, provisional, 0, undefined, outcome);
        return { outcome };
      }

      const seam = bindSeam(snapshot, undefined);
      const core = createMessagingRouter(depsFor(snapshot, seam, "resolve", request.from));
      const result = await core.sendMessage(caller, {
        to: request.to,
        message: request.body,
        ...(request.summary === undefined ? {} : { summary: request.summary }),
        ...(request.notifyWhenIdle === undefined ? {} : { notify_when_idle: request.notifyWhenIdle }),
      });

      // The receipt. The envelope written here is the dispatcher's stamped one when it got that far,
      // and the provisional one when the core settled before resolution — either way the RECORD ends
      // with an outcome, which is what makes the next retry a lookup.
      const recorded = await store.deliveries.get(messageId);
      await persistReceipt(messageId, recorded?.message ?? provisional, recorded?.toGeneration ?? 0, recorded?.claimedBy, result.outcome);
      return result;
    },

    async deliver(message) {
      const prior = await store.deliveries.get(message.messageId);
      if (prior?.outcome !== undefined) return prior.outcome;
      return dispatchEnvelope(message);
    },

    async notifyWhenIdle(target, request) {
      const key = serializeRuntimeAddress(target);
      // WS-10 §14, sender side: "only a main conversation may subscribe".
      if (!isIdleSubscribeSenderAllowed({ isChild: request.from.objectKind === "agent" })) {
        return refused(request.messageId, "notify_when_idle: only a main conversation may subscribe (WS-10 §14)");
      }
      const entry = await directory.get(key);
      if (entry === undefined) return notFound(request.messageId, `no directory record for ${key}`);
      // Target side, driven by the PINNED capability flag rather than by a probe call: a subagent is
      // never a valid target, and a peer whose adapter has no reliable idle signal reports the same.
      // The row's flag AND the adapter's own answer — per runtime and then per ADDRESS (review r2,
      // NEW-2). A host may not opt a runtime into an idle signal it does not have, and a runtime that
      // has one in general may still not have one for THIS session.
      const adapter = adapters.get(entry.runtimeKind);
      const runtimeCanSignalIdle = adapter?.supportsIdleSubscriptions !== false && (adapter?.canSubscribeIdle === undefined || (await adapter.canSubscribeIdle(entry.parsed)));
      if (!isIdleSubscribeTargetAllowed({ objectKind: entry.objectKind, hasReliableIdleSignal: entry.capabilities.notifyWhenIdle && runtimeCanSignalIdle })) {
        return refused(request.messageId, `notify_when_idle: ${key} is not a valid target — subagents, teammates, remote targets and adapters without a reliable idle signal refuse the whole call (WS-10 §14)`);
      }
      const at = now();
      // DURABLE FIRST, because §6.3 says a subscription "survives restart only when DURABLY STORED
      // with valid target identity/generation" — and the generation is what stops a notice firing for
      // a different incarnation of the same address.
      await store.subscriptions.add({ messageId: request.messageId, subscriber: serializeRuntimeAddress(request.from), target: key, targetGeneration: entry.generation, createdAt: at, expiresAt: at + NOTIFY_IDLE_EXPIRY_MS });
      subscribers.remember(request.messageId, owningSessionIdOf(request.from));
      const dispatcher = createDispatchingAdapter({ snapshot: await snapshotFor(request.from), adapters, policy, store, now, view: "resolve" });
      const outcome = await dispatcher.subscribeIdle(target, { messageId: request.messageId });
      if (outcome.status !== "subscribed") {
        // A refusal leaves NOTHING behind. A durable record with no runtime subscription behind it
        // would fire nothing and expire silently twelve hours later.
        await store.subscriptions.remove(request.messageId);
        return outcome;
      }
      return subscribedOutcome(request.messageId);
    },

    async senderPermissionClass(address): Promise<PermissionClassLabel> {
      const entry = await directory.get(serializeRuntimeAddress(address));
      if (entry === undefined) return "unknown";
      return (await adapters.get(entry.runtimeKind)?.senderPermissionClass(address)) ?? "unknown";
    },

    async releaseHeld(receiver) {
      const entry = await directory.get(receiver);
      if (entry === undefined) return [];
      const { released } = await policy.reevaluate(entry);
      const outcomes: DeliveryOutcome[] = [];
      // ALREADY DECIDED by `reevaluate`, which removed the durable record when it promoted the
      // message — so the delivery must not re-run the policy and risk a second answer that holds a
      // message nothing is holding any more (review r1, low 2).
      for (const message of released) outcomes.push(await dispatchEnvelope(message, { inboundDecided: true }));
      return outcomes;
    },

    async reply(request) {
      const { original } = request;
      const from = original.to;
      const to = original.from;
      // NEW-11: the door ANSWERS, it does not raise. `reply` serializes both halves of the original
      // envelope while building the reply — before `dispatchEnvelope`'s own guard is ever reached — so
      // a hand-built malformed address used to come out of the router as an unhandled throw. It is the
      // same refusal D1 and NEW-4 established for the other two doors, and it is host-only: a model
      // never builds an address.
      // …AND IT SAYS WHICH HALF (review r4's nit). One message for both halves reported a malformed
      // TARGET as "the envelope's sender is not a canonical address", which sends a host looking at the
      // wrong field. `from` is the original's `to` and vice versa, so the roles are named explicitly.
      const malformedSender = unaddressableSender(from);
      const malformed = malformedSender ?? unaddressableSender(to)?.replace("the envelope's sender", "the envelope's target");
      if (malformed !== undefined) return refused(deriveMessageId(original.messageId, "reply"), malformed);
      const snapshot = await snapshotFor(from);
      const targetKey = serializeRuntimeAddress(to);
      const target = snapshot.byAddress.get(targetKey);
      const messageId = deriveMessageId(owningSessionIdOf(from), `reply:${original.messageId}`);
      const prior = await store.deliveries.get(messageId);
      if (prior?.outcome !== undefined) return prior.outcome;
      if (target === undefined) return notFound(messageId, `no directory record for ${targetKey}, so there is nobody to reply to`);
      if (!target.capabilities.reply) {
        return refused(messageId, `${targetKey} does not accept replies (its own listing row says so); a reply is never forced onto an object that cannot read one`);
      }
      const at = now();
      const envelope: GlobalAgentMessage = {
        messageId,
        from,
        fromGeneration: snapshot.byAddress.get(serializeRuntimeAddress(from))?.generation ?? original.toGeneration,
        to,
        toGeneration: target.generation,
        body: request.body,
        ...(request.summary === undefined ? {} : { summary: request.summary }),
        notifyWhenIdle: false,
        createdAt: at,
        expiresAt: at + DEFAULT_MESSAGE_TTL_MS,
        // THE ONE PATH ON WHICH HOP COUNT GROWS. The model-facing schema has no hop field, so every
        // originated message starts at zero and the bound is unreachable through it (the core says so
        // itself); a reply chain is the relay this router actually has, so this is where WS-10 §12's
        // loop detection stops being documentation.
        hopCount: original.hopCount + 1,
        originToolCallId: original.messageId,
        senderPermissionClass: await handle.senderPermissionClass(from),
      };
      if (hopCountExceeded(envelope.hopCount)) {
        const outcome = refused(messageId, `this reply would be hop ${envelope.hopCount}, past the maximum hop count; the chain is stopped rather than followed (WS-10 §12)`);
        await persistReceipt(messageId, envelope, target.generation, undefined, outcome);
        return outcome;
      }
      return dispatchEnvelope(envelope);
    },

    readNotifications(sessionId) {
      return notifications.drain(sessionId);
    },

    async noteIdle(target, notice) {
      if (notice?.notificationId !== undefined) {
        if (seenNotices.has(notice.notificationId)) return 0;
        rememberBounded(seenNotices, notice.notificationId, true, MAX_TRACKED_NOTICES);
      }
      const targetEntry = await directory.get(target);
      const at = now();
      let pushed = 0;
      for (const subscription of await store.subscriptions.list()) {
        if (subscription.target !== target) continue;
        if (subscription.expiresAt <= at || targetEntry === undefined || targetEntry.generation !== subscription.targetGeneration) {
          // Expired, or about a different incarnation than the one subscribed to — dropped rather than
          // delivered, which is what "valid target identity/generation" means in §6.3.
          await store.subscriptions.remove(subscription.messageId);
          continue;
        }
        const subscriberEntry = await directory.get(subscription.subscriber);
        // ONE-SHOT: the record is removed whatever happens next, so "at most one notice" is structural
        // rather than a promise the firing code has to keep.
        await store.subscriptions.remove(subscription.messageId);
        if (subscriberEntry === undefined) continue;
        const senderClass = await handle.senderPermissionClass(targetEntry.parsed);
        const noticeEnvelope: GlobalAgentMessage = {
          messageId: subscription.messageId,
          from: targetEntry.parsed,
          fromGeneration: targetEntry.generation,
          to: subscriberEntry.parsed,
          toGeneration: subscriberEntry.generation,
          body: notice?.content ?? `${target} is now idle`,
          notifyWhenIdle: false,
          createdAt: at,
          expiresAt: at + DEFAULT_MESSAGE_TTL_MS,
          hopCount: 0,
          senderPermissionClass: senderClass,
        };
        // "Inbound policy applies to the returning notice" (WS-10 §14) — and a held subscription
        // "delivers a REDUCED-STATUS notice, not treated as ordinary delivered text". A refusal drops
        // it entirely; neither ever enters the mailbox, because a notice is not mail.
        const decision = await policy.classify(subscriberEntry, noticeEnvelope, true);
        if (decision === "refuse") continue;
        notifications.push(owningSessionIdOf(subscriberEntry.parsed), {
          origin: target,
          content:
            decision === "hold"
              ? `${target} changed state (reduced-status notice: this session is currently holding cross-session messages from that sender's class)`
              : noticeEnvelope.body,
          queuedAtMs: at,
        });
        pushed += 1;
      }
      return pushed;
    },
  };

  return handle;
}

