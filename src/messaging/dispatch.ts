// THE DISPATCHING ADAPTER: one `RuntimeMessagingAdapter` for the shared router core, which fans out
// to the per-runtime adapters — and, on the way, is where WS-15 §6.2's pipeline actually happens.
//
// The core (`@yanlinglabs/winter-agent-sdk/messaging`) is written against ONE adapter, because in the
// Winter runtime there is one. The router has two, and the choice between them is not the core's to
// make: "runtime kind and backend IDs live in the directory record" (WS-10 §11), so the adapter is
// picked by the resolved ENTRY's own declared `runtimeKind`. That single line is also what makes
// R-7b-1's cross-runtime pair work — a `claude-agent` child of a `winter-agent` parent is dispatched
// to the official adapter because the CHILD's record says so, and nothing about the parent's current
// runtime enters the decision (WS13c-SM1/SM2).
//
// WHAT ELSE HAPPENS HERE, and why here rather than in the core or in an owner adapter:
//
//   * THE ENVELOPE AND ITS RESOLVED GENERATION ARE PERSISTED (§6.2). The core builds an envelope with
//     `toGeneration: 0` — it has no directory to ask — so this is the one place that knows the real
//     incarnation counter, stamps it, and writes the envelope down before anything is attempted.
//   * INBOUND POLICY RUNS BEFORE ANY ADAPTER DELIVERY (§6.3), on the session path only (WS-10 §10.3:
//     steering a child is "delivered inside the owning parent session", which has no second receiver).
//   * THE DELIVERY IS ATOMICALLY CLAIMED FOR ONE ADAPTER (§6.2) before it is invoked. A claim with no
//     receipt is exactly WS-10 §12's crash window, and WS-15 §6.4 step 5 reconciles those as
//     `delivery_uncertain` — which is why the claim is written first and the receipt separately, and
//     why nothing here ever writes both in one step.
import { deliveryUncertain, notFound, serializeRuntimeAddress, unavailable } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { RuntimeMessagingAdapter } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { DirectorySnapshot } from "../directory/directory.ts";
import type { RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress, RuntimeKind } from "../seams/messaging-contract.ts";
import type { InboundPolicy } from "./inbound.ts";

/**
 * WS-10 §15's adapter, plus the ONE fact the router must know about a runtime that the interface has
 * nowhere to put: whether it has a reliable idle signal at all.
 *
 * WS-10 §14 requires that "subagents, teammates, cloud/remote targets, AND ADAPTERS WITHOUT A RELIABLE
 * IDLE SIGNAL MUST refuse the ENTIRE call (including any attached message)". The shared core enforces
 * that from the target row's `capabilities.notifyWhenIdle` flag — which is a DIRECTORY field, written
 * by a host. A host that sets it optimistically on an official-runtime row would get the body
 * delivered and only the subscription refused, which is precisely the "delivered and then
 * un-delivered" shape §14 exists to prevent. So the adapter declares it, and the dispatcher clears the
 * flag on every row belonging to a runtime that cannot back it. Absent means "yes" — the honest
 * default for a host-registered adapter this package knows nothing about.
 */
export interface RouterMessagingAdapter extends RuntimeMessagingAdapter {
  readonly supportsIdleSubscriptions?: boolean;
  /**
   * PER ADDRESS, where `supportsIdleSubscriptions` is per RUNTIME (review r2, NEW-2).
   *
   * The runtime-wide flag is not fine enough: the Winter branch genuinely has a reliable idle signal
   * (its engine is the session-status event source), but only for a session this process holds a
   * FACET for — its own `subscribeIdle` refuses a facet-less one by address. So a row whose
   * `capabilities.notifyWhenIdle` a host wrote `true` (the ordinary case) attached through a plain
   * input-stream writer passed the core's eligibility check, the body was DELIVERED, and only the
   * subscription came back refused — which is exactly what WS-10 §14's "refuse the ENTIRE call
   * (including any attached message) so the sender can retry without the flag" forbids.
   *
   * Absent means "the runtime-wide flag is the whole answer", which is the honest default for a
   * host-registered adapter this package cannot see inside.
   */
  canSubscribeIdle?(address: RuntimeAddress): Promise<boolean> | boolean;
}

export interface DispatchDeps {
  snapshot: DirectorySnapshot;
  adapters: ReadonlyMap<RuntimeKind, RouterMessagingAdapter>;
  policy: InboundPolicy;
  store: RuntimeDirectoryStore;
  now(): number;
  /**
   * Which rows the core is allowed to see through `listReachable`.
   *
   * `resolve` is every object this caller may ADDRESS — including an exited session, which WS-15 §6.2
   * has a routing row for. `list` is WS-10 §10.2's narrower listing eligibility. They are two views of
   * the same snapshot rather than two reads, so a listing and a resolution can never disagree about a
   * row that changed in between.
   */
  view: "resolve" | "list";
  /**
   * WHERE A SUBSCRIBE GOES (review r1, M1). Absent = straight to the owner adapter.
   *
   * The shared core calls `adapter.subscribeIdle` for both the pure-subscription and the combined
   * `SendMessage{notify_when_idle}` call — the MODEL-facing path. Delegating that to the owner adapter
   * subscribes at the RUNTIME and writes nothing durable, so the router's own `store.subscriptions` —
   * the only thing `noteIdle()` reads — stayed empty and the one notice WS-10 §14 promises could never
   * be routed to anyone. The model was told `subscribed: true` and nothing ever arrived.
   *
   * So the core's dispatcher is given the ROUTER's own subscription door here, and only the router's
   * door talks to the owner adapter (with this field absent, which is also what stops the two from
   * recursing into each other).
   */
  subscribeIdleVia?: (target: RuntimeAddress, request: { messageId: string }) => Promise<DeliveryOutcome>;
  /**
   * The inbound decision has ALREADY been made for this envelope (review r1, low 2).
   *
   * Set when a HELD message is released: `InboundPolicy.reevaluate` decided it and removed its durable
   * record, so re-running `decide` on the way out could produce a second, divergent answer that holds
   * a message whose record is gone — losing it. The accepted-queue slot is still reserved, because
   * that is the half a release genuinely changes.
   */
  inboundDecided?: boolean;
}

/** The generations a delivery is stamped with, read from the directory rather than from the sender. */
function stamped(message: GlobalAgentMessage, snapshot: DirectorySnapshot, target: RuntimeDirectoryEntry): GlobalAgentMessage {
  const from = snapshot.byAddress.get(serializeRuntimeAddress(message.from));
  return { ...message, toGeneration: target.generation, fromGeneration: from?.generation ?? message.fromGeneration };
}

export function createDispatchingAdapter(deps: DispatchDeps): RuntimeMessagingAdapter {
  function entryFor(address: RuntimeAddress): RuntimeDirectoryEntry | undefined {
    return deps.snapshot.byAddress.get(serializeRuntimeAddress(address));
  }

  function adapterFor(entry: RuntimeDirectoryEntry): RouterMessagingAdapter | undefined {
    return deps.adapters.get(entry.runtimeKind);
  }

  /**
   * WS-10 §14's target-side truth, applied to the row the core reads it from — per RUNTIME and then
   * PER ADDRESS (review r2, NEW-2).
   *
   * The core checks `capabilities.notifyWhenIdle` BEFORE it delivers anything, which is the only
   * position from which §14's whole-call refusal is possible. So the row it reads has to carry what
   * the adapter would actually answer, not what a host optimistically wrote.
   */
  async function withIdleTruth(row: ListedRuntimeObject): Promise<ListedRuntimeObject> {
    if (!row.capabilities.notifyWhenIdle) return row;
    const adapter = deps.adapters.get(row.runtimeKind);
    const cleared = { ...row, capabilities: { ...row.capabilities, notifyWhenIdle: false } };
    if (adapter === undefined || adapter.supportsIdleSubscriptions === false) return adapter === undefined ? row : cleared;
    if (adapter.canSubscribeIdle === undefined) return row;
    const parsed = deps.snapshot.byAddress.get(row.address)?.parsed;
    if (parsed === undefined) return row;
    return (await adapter.canSubscribeIdle(parsed)) ? row : cleared;
  }

  function noAdapter(entry: RuntimeDirectoryEntry, messageId: string): DeliveryOutcome {
    return unavailable(messageId, false, `no messaging adapter is registered for the ${entry.runtimeKind} runtime, which is the runtime ${entry.address} is recorded on`);
  }

  /** §6.2's "persist the envelope and resolved target generation", before anything is attempted. */
  async function persistEnvelope(message: GlobalAgentMessage, target: RuntimeDirectoryEntry): Promise<void> {
    await deps.store.deliveries.put({ messageId: message.messageId, message, toGeneration: target.generation, updatedAt: new Date(deps.now()).toISOString() });
  }

  /** §6.2's "atomically claim for one adapter" — written BEFORE the adapter is invoked, never with it. */
  async function claim(message: GlobalAgentMessage, target: RuntimeDirectoryEntry): Promise<void> {
    await deps.store.deliveries.put({ messageId: message.messageId, message, toGeneration: target.generation, claimedBy: target.runtimeKind, updatedAt: new Date(deps.now()).toISOString() });
  }

  async function childDoor(address: RuntimeAddress, message: GlobalAgentMessage, door: "steerChild" | "resumeChild"): Promise<DeliveryOutcome> {
    const entry = entryFor(address);
    if (entry === undefined) return notFound(message.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
    const adapter = adapterFor(entry);
    if (adapter === undefined) return noAdapter(entry, message.messageId);
    const envelope = stamped(message, deps.snapshot, entry);
    await persistEnvelope(envelope, entry);
    await claim(envelope, entry);
    return adapter[door](address, envelope);
  }

  return {
    async listReachable(scope) {
      const rows: readonly ListedRuntimeObject[] = await Promise.all((deps.view === "list" ? deps.snapshot.listable : deps.snapshot.resolvable).map(withIdleTruth));
      if (scope.parent === undefined) return [...rows];
      // The snapshot is already scoped to the caller (its children are its own), so `parent` narrows
      // nothing further here; it is honoured rather than ignored so a caller passing it gets what it
      // asked for and not a wider list.
      const parentKey = serializeRuntimeAddress(scope.parent);
      return rows.filter((row) => row.objectKind === "session" || (deps.snapshot.byAddress.get(row.address)?.parentAddress ?? "") === parentKey);
    },

    steerChild(address, message) {
      return childDoor(address, message, "steerChild");
    },

    resumeChild(address, message) {
      return childDoor(address, message, "resumeChild");
    },

    async deliverToSession(address, message) {
      const entry = entryFor(address);
      if (entry === undefined) return notFound(message.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
      const adapter = adapterFor(entry);
      if (adapter === undefined) return noAdapter(entry, message.messageId);
      const envelope = stamped(message, deps.snapshot, entry);
      await persistEnvelope(envelope, entry);

      // WS-15 §6.3, in the one position the whole rule depends on: before the adapter.
      const senderKnown = deps.snapshot.byAddress.has(serializeRuntimeAddress(envelope.from));
      const verdict = deps.inboundDecided === true ? deps.policy.reserveAccepted(entry.address, envelope.messageId) : await deps.policy.decide(entry, envelope, senderKnown);
      if (verdict.kind === "settled") return verdict.outcome;

      await claim(envelope, entry);
      try {
        const outcome = await adapter.deliverToSession(address, envelope);
        verdict.release(outcome);
        return outcome;
      } catch (error) {
        // The accepted-queue reservation is given back on the way out, so a throwing adapter cannot
        // leak a slot; the THROW itself is re-raised for the core to classify (its `classifyDeliveryError`
        // is where a policy refusal is told apart from a genuine crash window).
        verdict.release(deliveryUncertain(envelope.messageId, "the adapter threw"));
        throw error;
      }
    },

    async subscribeIdle(address, request) {
      const entry = entryFor(address);
      if (entry === undefined) return notFound(request.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
      const adapter = adapterFor(entry);
      if (adapter === undefined) return noAdapter(entry, request.messageId);
      // NOT A DELIVERY: no envelope, no claim, no receipt. WS-10 §14 is explicit that subscribing
      // "never starts a target turn", so recording it as an in-flight delivery would make WS-15 §6.4
      // step 5 reconcile a message that never existed.
      //
      // IT IS STILL DURABLE, THOUGH — through the router's own door (M1). Only the router's door
      // itself passes no `subscribeIdleVia`, and that is what reaches the owner adapter.
      if (deps.subscribeIdleVia !== undefined) return deps.subscribeIdleVia(address, request);
      return adapter.subscribeIdle(address, request);
    },

    async senderPermissionClass(address): Promise<PermissionClassLabel> {
      const entry = entryFor(address);
      if (entry === undefined) return "unknown";
      const adapter = adapterFor(entry);
      if (adapter === undefined) return "unknown";
      return adapter.senderPermissionClass(address);
    },
  };
}
