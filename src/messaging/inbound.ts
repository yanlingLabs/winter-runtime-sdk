// WS-15 §6.3 / WS-10 §13: THE INBOUND POLICY, "in the router BEFORE any adapter delivery".
//
// The subpath owns the RULES — `resolveInboundDecision` (unauthenticated → refuse; an explicit
// receiver setting always wins; otherwise the class matrix), `createMailbox` (the 100-held/50-accepted
// caps, the 5-minute default-class expiry, the explicit holds that never auto-promote, and the
// re-evaluation sweep). This module owns the three things a shared, in-process rule set cannot own:
//
//   1. WHERE THE POLICY RUNS. Inside the router, before the owner adapter is called — which is what
//      makes "the receiver's own policy" true for a receiver in ANOTHER process, on either runtime.
//   2. DURABILITY. The subpath's mailbox is an in-memory `Map`; WS-15 §6.4 step 7 has to find held
//      mail after a restart, so every hold is also written to `RuntimeDirectoryStore.mailboxes` and
//      the in-memory box is REHYDRATED from it the first time a receiver is touched. Without the
//      rehydrate the caps would silently reset to zero on restart, which is the one direction a cap
//      must never move.
//   3. THE ACCEPTED-QUEUE RESERVATION. A cap is only enforceable if it is checked BEFORE delivery
//      ("overflow refused visibly, never pretended success"), and a message's fate is not known until
//      after. So an accept RESERVES a slot before the adapter is called and RELEASES it unless the
//      outcome was `queued` — the one outcome that means "accepted and still waiting to be read".
//
// SCOPE, restated from the subpath's own header because it is the rule most easily over-applied: this
// runs on the SESSION path only. Steering a running child or resuming a terminal one is "delivered
// inside the owning parent session" (WS-10 §10.3) — the child already runs under the parent's
// permission mode, and there is no second receiver to have a policy.
import { buildDefaultHoldEntry, buildExplicitHoldEntry, createMailbox, held as heldOutcome, refused as refusedOutcome, resolveInboundDecision, ACCEPTED_QUEUE_CAP, HELD_INBOX_CAP } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { CrossSessionInbound, HeldEntry, Mailbox, PermissionClassLabel } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { HeldMessageRecord, RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, SerializedRuntimeAddress } from "../seams/messaging-contract.ts";

export interface InboundPolicyHooks {
  /**
   * The receiver's own explicit `crossSessionInbound` setting, when the host has one.
   *
   * WS-10 §13: an explicit setting ALWAYS WINS over the class matrix. It is a host fact (the settings
   * hierarchy is the host's), so it is asked for rather than assumed; absent means "no explicit
   * setting", which is what makes the matrix the default rather than the only rule.
   */
  explicitSetting?: (receiver: RuntimeDirectoryEntry) => Promise<CrossSessionInbound | undefined> | CrossSessionInbound | undefined;
  /**
   * WS-10 §13: "an unauthenticated route is refused BEFORE the matrix."
   *
   * The router's own default answer is "authenticated exactly when the sender is an object this
   * directory authored" — a canonical address the router itself issued and can still resolve. That is
   * the strongest claim a library can make on its own; a cross-machine or phone-originated route
   * "requires an authenticated Winter transport plus its own policy gate", which is the host's, and
   * this hook is where the host says so.
   */
  authenticatedRoute?: (input: { message: GlobalAgentMessage; receiver: RuntimeDirectoryEntry; senderKnown: boolean }) => Promise<boolean> | boolean;
  /** An explicit hold is the receiver's own choice to queue rather than to take; the kind is its own. */
  holdKind?: (input: { message: GlobalAgentMessage; receiver: RuntimeDirectoryEntry; decision: CrossSessionInbound }) => "default" | "explicit";
}

export interface InboundPolicyDeps extends InboundPolicyHooks {
  store: RuntimeDirectoryStore;
  now(): number;
  /** The receiver's permission class, asked of the runtime that actually holds it (WS-10 §13). */
  receiverClass(receiver: RuntimeDirectoryEntry): Promise<PermissionClassLabel>;
}

export type InboundVerdict =
  /** Deliver. `release()` MUST be called with the eventual outcome so the accepted-queue slot is freed. */
  | { kind: "accept"; release(outcome: DeliveryOutcome): void }
  | { kind: "settled"; outcome: DeliveryOutcome };

export interface InboundPolicy {
  /** Runs the whole of WS-10 §13 for one envelope against one receiver. */
  decide(receiver: RuntimeDirectoryEntry, message: GlobalAgentMessage, senderKnown: boolean): Promise<InboundVerdict>;
  /**
   * The DECISION alone, with no mailbox effect — the matrix, the explicit setting and the
   * authentication gate, and nothing else.
   *
   * WS-10 §14's returning idle notice is the caller that needs this: "inbound policy applies to the
   * returning notice", and a held subscription "delivers a REDUCED-STATUS notice, not treated as
   * ordinary delivered text". A notice is therefore never held in the mailbox and never occupies an
   * accepted slot — it is reduced or dropped — so it needs the verdict without the bookkeeping that
   * ordinary mail earns.
   */
  classify(receiver: RuntimeDirectoryEntry, message: GlobalAgentMessage, senderKnown: boolean): Promise<CrossSessionInbound>;
  /**
   * WS-10 §13's "held messages are re-evaluated when the receiver's mode or settings change".
   *
   * Sweeps the 5-minute expiry first, then re-runs the decision for every DEFAULT-class hold (an
   * explicit hold "persists until a later accept/refusal/session end", so it is never auto-promoted),
   * and hands back the envelopes that are now deliverable. Delivering them is the router's job — this
   * module never calls an adapter.
   */
  reevaluate(receiver: RuntimeDirectoryEntry): Promise<{ released: GlobalAgentMessage[]; expired: HeldEntry[] }>;
  /** WS-10 §13's 5-minute dialog expiry, applied on its own. Returns what it swept. */
  sweepExpired(receiverKey: SerializedRuntimeAddress): Promise<HeldEntry[]>;
  /** What is held for a receiver right now, durably. */
  listHeld(receiverKey: SerializedRuntimeAddress): Promise<HeldMessageRecord[]>;
  readonly caps: { held: number; accepted: number };
  /** Exposed for the router's own counters; the mailbox is this module's, not the router's. */
  readonly mailbox: Mailbox;
}

export function createInboundPolicy(deps: InboundPolicyDeps): InboundPolicy {
  const mailbox = createMailbox();
  const rehydrated = new Set<SerializedRuntimeAddress>();

  /**
   * Load a receiver's durable holds into the in-memory box, once.
   *
   * WITHOUT THIS THE CAP IS A LIE ACROSS A RESTART: the durable store would hold 100 messages while
   * the fresh in-memory box reported zero, so the 101st would be accepted — and WS-10 §13's cap is
   * exactly the thing that must not silently grow.
   */
  async function ensureRehydrated(receiverKey: SerializedRuntimeAddress): Promise<void> {
    if (rehydrated.has(receiverKey)) return;
    rehydrated.add(receiverKey);
    for (const record of await deps.store.mailboxes.listHeld(receiverKey)) {
      mailbox.hold(receiverKey, toHeldEntry(record));
    }
  }

  function toHeldEntry(record: HeldMessageRecord): HeldEntry {
    return {
      messageId: record.messageId,
      reason: record.reason,
      kind: record.kind,
      heldAt: record.heldAt,
      ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    };
  }

  async function sweepExpired(receiverKey: SerializedRuntimeAddress): Promise<HeldEntry[]> {
    await ensureRehydrated(receiverKey);
    const expired = mailbox.sweepExpired(receiverKey, deps.now());
    for (const entry of expired) await deps.store.mailboxes.takeHeld(receiverKey, entry.messageId);
    return expired;
  }

  return {
    caps: { held: HELD_INBOX_CAP, accepted: ACCEPTED_QUEUE_CAP },
    mailbox,
    sweepExpired,

    async listHeld(receiverKey) {
      return deps.store.mailboxes.listHeld(receiverKey);
    },

    async classify(receiver, message, senderKnown) {
      const authenticated = deps.authenticatedRoute === undefined ? senderKnown : await deps.authenticatedRoute({ message, receiver, senderKnown });
      const explicitSetting = deps.explicitSetting === undefined ? undefined : await deps.explicitSetting(receiver);
      // The RECEIVER's class is asked of the runtime that holds the receiver; the SENDER's class rides
      // on the envelope, stamped by the router at the sending end (WS-10 §13's matrix input). A
      // caller-side `accept` can therefore still come back `held` — the envelope's class is an input,
      // never a verdict.
      const receiverClass = await deps.receiverClass(receiver);
      return resolveInboundDecision({
        authenticated,
        ...(explicitSetting === undefined ? {} : { explicitSetting }),
        receiverClass,
        senderClass: message.senderPermissionClass,
      });
    },

    async decide(receiver, message, senderKnown) {
      const receiverKey = receiver.address;
      await sweepExpired(receiverKey);

      const authenticated = deps.authenticatedRoute === undefined ? senderKnown : await deps.authenticatedRoute({ message, receiver, senderKnown });
      const explicitSetting = deps.explicitSetting === undefined ? undefined : await deps.explicitSetting(receiver);
      const receiverClass = await deps.receiverClass(receiver);
      const decision = await this.classify(receiver, message, senderKnown);

      if (decision === "refuse") {
        // "Refusal is terminal for that message ID" (WS-10 §13). Nothing is held, nothing is retried,
        // and the reason names which half of the rule fired so a sender can act on it.
        return {
          kind: "settled",
          outcome: refusedOutcome(
            message.messageId,
            authenticated
              ? `the receiver refuses cross-session messages (crossSessionInbound: "refuse"); refusal is terminal for this message id`
              : `the route carrying this message is not authenticated, which is refused before the inbound matrix (WS-10 §13)`,
          ),
        };
      }

      if (decision === "hold") {
        const kind = deps.holdKind === undefined ? (explicitSetting === "hold" ? "explicit" : "default") : deps.holdKind({ message, receiver, decision });
        const reason =
          explicitSetting === "hold"
            ? `the receiver holds cross-session messages for review (crossSessionInbound: "hold")`
            : `the receiver's permission class (${receiverClass}) holds messages from a ${message.senderPermissionClass} sender by default (WS-10 §13)`;
        const entry = kind === "explicit" ? buildExplicitHoldEntry(message.messageId, reason, deps.now()) : buildDefaultHoldEntry(message.messageId, reason, deps.now());
        if (!mailbox.hold(receiverKey, entry)) {
          // OVERFLOW IS VISIBLE (WS-10 §13), never a silent drop — and it is `refused` rather than
          // `unavailable` because nothing about the receiver is transient: its inbox is full.
          return { kind: "settled", outcome: refusedOutcome(message.messageId, `the receiver is already holding ${HELD_INBOX_CAP} messages, the documented cap; this one was refused rather than dropped`) };
        }
        await deps.store.mailboxes.hold({
          messageId: message.messageId,
          receiver: receiverKey,
          reason,
          kind: entry.kind,
          heldAt: entry.heldAt,
          ...(entry.expiresAt === undefined ? {} : { expiresAt: entry.expiresAt }),
          message,
        });
        return { kind: "settled", outcome: heldOutcome(message.messageId, reason) };
      }

      if (!mailbox.accept(receiverKey)) {
        return { kind: "settled", outcome: refusedOutcome(message.messageId, `the receiver already has ${ACCEPTED_QUEUE_CAP} accepted messages waiting, the documented cap; this one was refused rather than dropped`) };
      }
      return {
        kind: "accept",
        release(outcome) {
          // `queued` is the ONLY outcome that leaves a message sitting in the receiver's accepted
          // queue (it is read at the next tool boundary). Everything else — delivered into a turn,
          // refused, uncertain — is no longer occupying a slot, so the reservation is given back.
          if (outcome.status !== "queued") mailbox.releaseAccepted(receiverKey, 1);
        },
      };
    },

    async reevaluate(receiver) {
      const receiverKey = receiver.address;
      const expired = await sweepExpired(receiverKey);
      const authenticated = true; // a held message was already accepted onto an authenticated route
      const explicitSetting = deps.explicitSetting === undefined ? undefined : await deps.explicitSetting(receiver);
      const receiverClass = await deps.receiverClass(receiver);
      const durable = await deps.store.mailboxes.listHeld(receiverKey);
      const byId = new Map(durable.map((record) => [record.messageId, record]));
      const promoted = mailbox.reevaluate(receiverKey, (entry) => {
        const record = byId.get(entry.messageId);
        return resolveInboundDecision({
          authenticated,
          ...(explicitSetting === undefined ? {} : { explicitSetting }),
          receiverClass,
          senderClass: record?.message.senderPermissionClass ?? "unknown",
        });
      });
      const released: GlobalAgentMessage[] = [];
      for (const { entry, next } of promoted) {
        const record = await deps.store.mailboxes.takeHeld(receiverKey, entry.messageId);
        if (record === undefined) continue;
        // A re-evaluation that lands on `refuse` is terminal: the message leaves the mailbox and is
        // NOT delivered. Only an `accept` produces an envelope for the router to deliver.
        if (next === "accept") released.push(record.message);
      }
      return { released, expired };
    },
  };
}
