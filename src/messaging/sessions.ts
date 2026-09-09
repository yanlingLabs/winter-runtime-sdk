// THE LIVE HALF OF THE DIRECTORY: which addressable objects this process actually holds a handle to.
//
// A `RuntimeDirectoryEntry` is durable and survives a restart; a handle is neither. WS-15 §6.1 splits
// them in exactly this way ("live state refreshes from adapters; durable identity/backing lives in
// WS-16"), and the split is what makes the routing table implementable: "running/idle official Claude
// session (supervised) → deliver through the OWNING LIVE SDK/CONTROL HANDLE", "exited official Claude
// session → explicitly resume by `backendSessionId`, re-establish the adapter, THEN deliver". The
// difference between those two rows is entirely whether this registry has a handle.
//
// R-7b-4 names what a live delivery IS: "Top-level delivery into a LIVE session of either runtime is
// a push into that session's input stream (both `query()`s accept an async-iterable prompt); cold
// resume is a new `query({ resume })` on the persisted runtime." So a handle is, minimally, a way to
// push text — plus, on the Winter branch, the per-session messaging facet, which is the only door
// into a spawned session's CHILDREN.
import type { SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";

import type { ListedRuntimeObject, SerializedRuntimeAddress } from "../seams/messaging-contract.ts";

/** The live status a handle can report, when it can. Same vocabulary as the directory's own. */
export type LiveSessionStatus = ListedRuntimeObject["status"];

export interface AttachedSession {
  /**
   * Push one turn into this session's input stream.
   *
   * The text is ALREADY RENDERED (attributed, escaped) by the time it gets here — a handle is a pipe,
   * not a policy. Absent on a Winter handle that only carries a facet: the facet's own `deliver` is
   * the runtime-side push, and it renders on the far side.
   */
  push?(text: string): void | Promise<void>;
  /** The live status, when the host tracks one. Absent falls back to the durable row's `status`. */
  status?(): LiveSessionStatus;
}

export interface AttachedWinterSession extends AttachedSession {
  /**
   * `Query.messaging` (R-7b-4). The ONLY door into a spawned Winter session's children — a child
   * engine has no facet surface of its own, so `steer_child`/`resume_child` on the PARENT's facet is
   * how a child is reached, never a session address (Task 0 fix r2, concern 4).
   */
  readonly messaging?: SessionMessagingFacet;
}

export interface AttachedOfficialSession extends AttachedSession {
  /**
   * REQUIRED on this branch, because there is no alternative. The pinned official SDK exposes no
   * messaging surface of any kind (its `Query` declares none), so an input-stream push is the whole
   * mechanism — for the session itself and, owner-qualified, for its children.
   */
  push(text: string): void | Promise<void>;
}

export interface AttachedSessionRegistry<T extends AttachedSession> {
  /** Register a handle for a canonical address. Returns the detach function. */
  attach(address: SerializedRuntimeAddress, handle: T): () => void;
  detach(address: SerializedRuntimeAddress): void;
  get(address: SerializedRuntimeAddress): T | undefined;
  addresses(): SerializedRuntimeAddress[];
}

/**
 * A registry, and deliberately nothing more: no liveness inference, no reaping, no ordering.
 *
 * ATTACHING IS THE HOST'S CALL, not something this package can discover. `RuntimeSdk.query()` is
 * where a session is created, and until that door routes to both branches (spine-owned, Task 6) a
 * host attaches what it launched. `attach` returning its own detach — rather than the caller
 * remembering the address — is what keeps a handle from outliving the session in the one case that
 * matters, a re-launch of the same address: the OLD detach then removes only the handle it added.
 */
export function createAttachedSessionRegistry<T extends AttachedSession>(): AttachedSessionRegistry<T> {
  const handles = new Map<SerializedRuntimeAddress, T>();
  return {
    attach(address, handle) {
      handles.set(address, handle);
      return () => {
        if (handles.get(address) === handle) handles.delete(address);
      };
    },
    detach(address) {
      handles.delete(address);
    },
    get(address) {
      return handles.get(address);
    },
    addresses() {
      return [...handles.keys()];
    },
  };
}
