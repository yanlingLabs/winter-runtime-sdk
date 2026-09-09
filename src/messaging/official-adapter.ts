// THE OFFICIAL BRANCH'S `RuntimeMessagingAdapter` (WS-10 §15), and the shape of it is dictated by one
// measured fact: THE PINNED OFFICIAL SDK HAS NO MESSAGING SURFACE AT ALL. Its `Query` declares no
// facet, no peer registry and no idle signal (Task 0 measured the absence while adding Winter's), and
// WS-10 §15 rules out emulating the vendor's private per-process registry as the integration path. So
// everything this adapter can do, it does through the ONE door the branch has — an input-stream push
// into a live session (R-7b-4), and a resume for one that is not live.
//
// WHICH MAKES THE CHILD ROWS THE INTERESTING ONES. WS-15 §6.2:
//
//   Running official Claude child    → "native child messaging through the active owning parent session"
//   Completed official Claude child  → "resume/message only through the owning parent after that
//                                       parent is active or explicitly resumed"
//   …and "another top-level session cannot treat an official Claude child as its native peer; Winter
//   may proxy through the retained owning-parent handle, but THE PUBLIC RESULT STAYS OWNER-QUALIFIED."
//
// There is no out-of-band door into an official child, and inventing one would mean speaking the
// vendor's private protocol. What there IS: the parent is a live model session whose own
// `SendMessage` is aliased (WS-14 §7) to this router's handler. So a message for a child is delivered
// to the OWNING PARENT, owner-qualified — the frame names the child it was for — and the parent's own
// next `SendMessage` comes back through the alias into this same router, which then reaches the child
// by the parent's own native mechanism. The loop closes through the alias handlers; it does not close
// through a private socket.
import { delivered, deliveryUncertain, notFound, queued, refused, resumedAndDelivered, serializeRuntimeAddress, unavailable } from "@yanlinglabs/winter-agent-sdk/messaging";

import { entryToListedRuntimeObject, owningSessionIdOf, parentAddressOf } from "../directory/entries.ts";
import type { RuntimeDirectory } from "../seams/directory.ts";
import type { RuntimeDirectoryEntry } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress } from "../seams/messaging-contract.ts";
import type { RouterMessagingAdapter } from "./dispatch.ts";
import { renderAttributedTurn, renderOwnerQualifiedTurn, unattributableReason } from "./attribution.ts";
import type { AttachedOfficialSession, AttachedSessionRegistry } from "./sessions.ts";

export interface OfficialMessagingAdapterDeps {
  directory: RuntimeDirectory;
  sessions: AttachedSessionRegistry<AttachedOfficialSession>;
  /**
   * WS-15 §6.2's "exited official Claude session → explicitly resume by `backendSessionId`,
   * re-establish the adapter, then deliver".
   *
   * INJECTED, because everything that resume needs — WS-14 §2's Options template, §1's launch profile
   * and observed config dir, §3's child environment, §12's credential fetch — belongs to the official
   * ADAPTER lane, and duplicating any of it here would be a second, drifting copy of the branch's
   * hardest-won configuration. This lane owns only the delivery half: it hands back a live handle, and
   * this module pushes into it.
   *
   * Absent: an exited official session is `unavailable`, non-retryable, with the reason naming what is
   * missing — never a silent `not_found`, because the session exists and is resumable by a host that
   * wires this.
   */
  resumeExited?: (entry: RuntimeDirectoryEntry) => Promise<AttachedOfficialSession | undefined>;
  /**
   * The receiver/sender permission class for an official object, when the host tracks one.
   *
   * The pinned runtime exposes no live permission mode to read, so the honest default is `unknown` —
   * which WS-10 §13's matrix handles explicitly rather than by guessing (`prompts × unknown → accept`,
   * `bypasses × unknown → hold`). A host that knows the mode it launched a session with can say so.
   */
  permissionClass?: (entry: RuntimeDirectoryEntry) => Promise<PermissionClassLabel> | PermissionClassLabel;
}

export interface OfficialMessagingAdapter extends RouterMessagingAdapter {
  readonly sessions: AttachedSessionRegistry<AttachedOfficialSession>;
}

export function createOfficialMessagingAdapter(deps: OfficialMessagingAdapterDeps): OfficialMessagingAdapter {
  async function pushInto(handle: AttachedOfficialSession, text: string, messageId: string, status: RuntimeDirectoryEntry["status"]): Promise<DeliveryOutcome> {
    try {
      await handle.push(text);
    } catch (error) {
      // WS-10 §12's crash window, in its smallest form: the write may have landed before the failure.
      return deliveryUncertain(messageId, `the input-stream push failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return status === "running" ? queued(messageId) : delivered(messageId);
  }

  /**
   * Deliver into one official object that HAS A SESSION OF ITS OWN: the live handle, else a resume.
   * Reached by `deliverToSession` and by a cross-runtime child (see `childThroughOwner`).
   */
  async function deliverIntoSession(entry: RuntimeDirectoryEntry, message: GlobalAgentMessage): Promise<DeliveryOutcome> {
    const key = entry.address;
    if (entry.status === "archived") {
      return refused(message.messageId, `${key} is archived; it refuses delivery until a deliberate user or product resume unarchives it (WS-15 §6.2)`);
    }
    // ONE ENVELOPE, ONE ANSWER (review r1, D1): the SAME owner check the Winter branch applies, before
    // any push and outside every `try`. Without it this branch delivered an envelope claiming to come
    // from another session's child while the Winter branch refused the identical message — the answer
    // depended only on which runtime the host had launched the receiver on. The owner-qualified CHILD
    // relay below keeps its deliberate absence of an owner, because there the message is knowingly
    // handed to a parent that does NOT own the sender.
    const refusal = unattributableReason(message, { winterSessionId: entry.parsed.winterSessionId });
    if (refusal !== undefined) return refused(message.messageId, refusal);
    const live = deps.sessions.get(key);
    if (live !== undefined) {
      return pushInto(live, renderAttributedTurn(message, { winterSessionId: entry.parsed.winterSessionId }), message.messageId, live.status?.() ?? entry.status);
    }
    if (deps.resumeExited === undefined) {
      return unavailable(
        message.messageId,
        false,
        `${key} is not live in this process and no official resume was supplied; an exited official session is resumed by its backend session id through the official adapter, which builds the launch this messaging lane deliberately does not (WS-15 §6.2)`,
      );
    }
    if (entry.backendSessionId === undefined) {
      return unavailable(message.messageId, false, `${key} has no backend session id, so there is nothing to resume by (WS-15 §6.2 resumes an exited official session BY backendSessionId)`);
    }
    let resumed: AttachedOfficialSession | undefined;
    try {
      resumed = await deps.resumeExited(entry);
    } catch (error) {
      return unavailable(message.messageId, true, `the official resume failed before anything was delivered: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (resumed === undefined) return unavailable(message.messageId, true, `the official resume produced no live handle for ${key}, so nothing was delivered`);
    const outcome = await pushInto(resumed, renderAttributedTurn(message, { winterSessionId: entry.parsed.winterSessionId }), message.messageId, "idle");
    // "`resumed_and_delivered` is returned only when resume AND delivery both completed" (WS-10 §12).
    // A push that failed after the resume is still uncertain, and says so rather than claiming the pair.
    return outcome.status === "delivered" || outcome.status === "queued" ? resumedAndDelivered(message.messageId) : outcome;
  }

  async function childThroughOwner(address: RuntimeAddress, message: GlobalAgentMessage, door: "steer" | "resume"): Promise<DeliveryOutcome> {
    const key = serializeRuntimeAddress(address);
    const entry = await deps.directory.get(key);
    if (entry === undefined) return notFound(message.messageId, `no directory record for ${key}`);

    // A CROSS-RUNTIME CHILD IS ITS OWN SESSION ON THIS RUNTIME (R-7b-1). A `claude`-family child of a
    // WINTER parent is not a native official subagent living inside another official session — the
    // router launched it here as an official session in its own right, with its own handle and its own
    // backend id. `transport` is the field that says which of the two a child is (WS-15 §6.1):
    // `claude-handle` is a session of its own, `claude-child` is a native subagent reachable only
    // through the parent that owns it.
    if (entry.transport === "claude-handle") return deliverIntoSession(entry, message);

    const parentAddress = parentAddressOf(entry);
    /* c8 ignore next */
    if (parentAddress === undefined) return notFound(message.messageId, `${key} is not a child, so it has no owning parent to route through`); // unreachable: called with an agent address
    const parent = deps.sessions.get(parentAddress);
    if (parent === undefined) {
      return unavailable(
        message.messageId,
        true,
        door === "steer"
          ? `the owning parent ${parentAddress} is not active; an official child is reachable only through the active owning parent session (WS-15 §6.2)`
          : `the owning parent ${parentAddress} is not active; a completed official child can be messaged only after that parent is active or explicitly resumed (WS-15 §6.2)`,
      );
    }
    const parentEntry = await deps.directory.get(parentAddress);
    const status = parent.status?.() ?? parentEntry?.status ?? "running";
    // OWNER-QUALIFIED, ALWAYS. The parent is being handed a message that was addressed to its child,
    // and a frame that read like an ordinary message TO the parent would misattribute the target. The
    // outcome is the PARENT's queueing outcome for the same reason: what actually happened is that the
    // owner received it.
    return pushInto(parent, renderOwnerQualifiedTurn(message, address), message.messageId, status);
  }

  return {
    sessions: deps.sessions,
    // MEASURED, NOT ASSUMED: the pinned official SDK's `Query` exposes no session-status surface at
    // all, so this branch cannot back an idle subscription — and WS-10 §14 makes that a refusal of the
    // WHOLE call, not of the subscription alone. The dispatcher clears `notifyWhenIdle` on every row
    // of this runtime so the refusal happens BEFORE the attached message is delivered.
    supportsIdleSubscriptions: false,
    // Per address as well, so a reader of either field gets the same answer (review r2, NEW-2).
    canSubscribeIdle: () => false,

    /** Live status for the addresses this adapter holds a handle for. It never invents a row. */
    async listReachable(scope) {
      const rows: ListedRuntimeObject[] = [];
      // ONE read, indexed — not one `get` per handle. The store seam has no point lookup (`get` is a
      // `load()` and a find), so a handle-by-handle walk is O(handles x entries) against a host store
      // that may be a database round trip each time.
      const byAddress = new Map((await deps.directory.list()).map((entry) => [entry.address, entry]));
      for (const address of deps.sessions.addresses()) {
        const entry = byAddress.get(address);
        if (entry === undefined || entry.runtimeKind !== "claude-agent") continue;
        if (scope.parent !== undefined && entry.objectKind === "agent" && owningSessionIdOf(entry.parsed) !== owningSessionIdOf(scope.parent)) continue;
        rows.push({ ...entryToListedRuntimeObject(entry), status: deps.sessions.get(address)?.status?.() ?? entry.status });
      }
      return rows;
    },

    steerChild(address, message) {
      return childThroughOwner(address, message, "steer");
    },

    resumeChild(address, message) {
      return childThroughOwner(address, message, "resume");
    },

    async deliverToSession(address, message) {
      const entry = await deps.directory.get(serializeRuntimeAddress(address));
      if (entry === undefined) return notFound(message.messageId, `no directory record for ${serializeRuntimeAddress(address)}`);
      return deliverIntoSession(entry, message);
    },

    async subscribeIdle(_address, request) {
      // WS-10 §14: "adapters without a reliable idle signal MUST refuse the ENTIRE call (including any
      // attached message) so the sender can retry without the flag." This branch has no idle signal to
      // offer — measured, not assumed: the pinned SDK's `Query` exposes no session-status surface —
      // and a `subscribed` here would be a subscription nothing could ever fire.
      return refused(request.messageId, "this runtime exposes no reliable idle signal, so notify_when_idle refuses the entire call (WS-10 §14)");
    },

    async senderPermissionClass(address): Promise<PermissionClassLabel> {
      if (deps.permissionClass === undefined) return "unknown";
      const entry = await deps.directory.get(serializeRuntimeAddress(address));
      if (entry === undefined) return "unknown";
      return deps.permissionClass(entry);
    },
  };
}
