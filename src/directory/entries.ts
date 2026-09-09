// WHAT A DIRECTORY ENTRY IS, SEEN FROM THE FOUR PLACES THAT READ ONE.
//
// A `RuntimeDirectoryEntry` is the router's durable record of one addressable runtime object
// (WS-15 §6.1). Four different consumers want four different views of it, and every one of those
// views is built HERE so that "what the model sees", "what resolution sees" and "what an adapter is
// handed" can never disagree about the same row:
//
//   * `entryToListedRuntimeObject` — WS-10 §11's listing row: what `ListAgents` renders and what
//     `resolveTarget` matches a display name against.
//   * `entryToChildLike` — the subpath's `ChildLike` boundary, so the SHARED resolution code
//     (rules 2/3/5, which are written against children) runs over directory rows rather than over a
//     second, router-local copy of the same rules.
//   * `owningSessionIdOf` — WS-10 §10.3's owning-parent fence, spelled once.
//   * `mergeAdapterOwnedFields` — the one field-level merge rule this package has, and it exists
//     because two lanes write the same row (see that function's own note).
import type { PermissionMode } from "@yanlinglabs/winter-agent-sdk";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { ChildLike, ChildLikeStatus } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { RuntimeDirectoryEntry } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, RuntimeAddress, SerializedRuntimeAddress } from "../seams/messaging-contract.ts";

/**
 * The session that OWNS an address (WS-10 §10.3, §11 rule 2).
 *
 * For a session that is the session itself; for an agent it is the parent, never the child — "a child
 * is only addressable within its owning parent", and every fence in this package is that one
 * sentence applied to a concrete pair of ids.
 */
export function owningSessionIdOf(address: RuntimeAddress): string {
  return address.objectKind === "agent" ? (address.parentWinterSessionId ?? address.winterSessionId) : address.winterSessionId;
}

/** WS-10 §11's listing row for one entry. The row IS the directory record — nothing is inferred. */
export function entryToListedRuntimeObject(entry: RuntimeDirectoryEntry): ListedRuntimeObject {
  return {
    address: entry.address,
    ...(entry.displayName === undefined ? {} : { name: entry.displayName }),
    objectKind: entry.objectKind,
    // THE DECLARED KIND, ALWAYS. A serialized address carries no runtime kind by design (WS-10 §11:
    // "runtime kind and backend IDs live in the directory record"), so this field is the ONLY honest
    // source for it — and it is what the router picks an adapter by.
    runtimeKind: entry.runtimeKind,
    status: entry.status,
    mode: entry.mode,
    ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
    capabilities: { ...entry.capabilities },
  };
}

/** `starting`/`running` are live for resolution's purposes; everything else is terminal or worse. */
export function isLiveStatus(status: RuntimeDirectoryEntry["status"]): boolean {
  return status === "starting" || status === "running" || status === "idle";
}

/**
 * WS-10 §10.2's LISTING eligibility — deliberately narrower than resolution's.
 *
 * "It lists what `SendMessage` can currently reach — children of this parent, teammates, eligible
 * LIVE peer sessions — and does NOT enumerate exited transcripts on disk." A terminal CHILD is still
 * listed (it is resumable through its owner, and the subpath's own child row says so with
 * `capabilities.resume`); an exited SESSION is not, because listing one is the enumeration that
 * sentence forbids. Resolution still reaches an exited session by canonical address — WS-15 §6.2's
 * routing table has a row for delivering to one — which is exactly why these are two functions and
 * not one.
 */
export function isListableFrom(entry: RuntimeDirectoryEntry, callerOwningSessionId: string): boolean {
  if (entry.status === "archived") return false;
  if (entry.objectKind === "agent") return owningSessionIdOf(entry.parsed) === callerOwningSessionId;
  return isLiveStatus(entry.status);
}

/**
 * What RESOLUTION may see: every non-archived object this caller could legitimately address.
 *
 * An archived session "refuses until a deliberate user/product resume unarchives it" (WS-15 §6.2), so
 * it is not resolvable at all — the refusal belongs at the delivery door only for objects a caller can
 * name, and an archived row is not one of them.
 */
export function isResolvableFrom(entry: RuntimeDirectoryEntry, callerOwningSessionId: string): boolean {
  if (entry.status === "archived") return false;
  if (entry.objectKind === "agent") return owningSessionIdOf(entry.parsed) === callerOwningSessionId;
  return true;
}

/**
 * A `ChildLike` view of a child entry, so WS-10 §11's SHARED resolution runs over directory rows.
 *
 * `steer`/`resume` are the two doors `ChildLike` requires. The router never calls them — the core's
 * own `deliverEnvelope` calls `adapter.steerChild`/`adapter.resumeChild` and uses `ChildLike` only
 * for `status()` and the three `record` fields — so they are wired to the caller's own delivery
 * function rather than left as throws: a `ChildLike` that threw would be a trap for any future caller
 * that reasonably used the interface it was handed.
 *
 * `permission.effectiveMode` is the one member with no source on a directory row, and it is
 * UNOBSERVABLE by construction: the only place the subpath reads it is
 * `childToListedRuntimeObject`'s `mode`, and this package never renders a child through that function
 * — `resolve()` maps every candidate back to `entryToListedRuntimeObject`, which reads the entry's own
 * `mode`. It is stated here rather than left to be discovered, because a future caller that DID
 * render a `ChildLike` directly would otherwise show every child the same made-up mode.
 */
export function entryToChildLike(entry: RuntimeDirectoryEntry, deliver: (entry: RuntimeDirectoryEntry, msg: GlobalAgentMessage) => Promise<DeliveryOutcome>): ChildLike {
  const status: ChildLikeStatus = entry.status === "running" || entry.status === "starting" ? "running" : entry.status === "unavailable" ? "failed" : "completed";
  return {
    record: {
      id: entry.parsed.childId ?? entry.address,
      parentSessionId: owningSessionIdOf(entry.parsed),
      ...(entry.displayName === undefined ? {} : { name: entry.displayName }),
      permission: { effectiveMode: "default" as PermissionMode },
    },
    status: () => status,
    steer: (msg) => deliver(entry, msg),
    resume: (msg) => deliver(entry, msg),
  };
}

/**
 * THE ONE FIELD-LEVEL MERGE RULE IN THIS PACKAGE, and it exists because two lanes write one row.
 *
 * Lane A's supervised spawn proxy records WS-14 §6 rule 2's observed `CLAUDE_CONFIG_DIR` and §9's
 * pid-plus-start-identity onto the LAUNCHED SESSION's own directory entry, through the store's
 * `upsert` — which is a full REPLACE. A host that later records a status change through
 * `RuntimeDirectory.record()` builds its entry from what IT knows, which is never those two fields:
 * a plain `upsert` would drop them, and WS-15 §6.4 step 2 (revalidate process identity) plus §6 rule
 * 5 (clear the recorded root only after verified cleanup) would then be reading a row that lost its
 * evidence — silently, with nothing failing at the time.
 *
 * SO THE RULE IS NARROW AND STATED: exactly the two ADAPTER-OWNED fields are carried forward when the
 * incoming entry omits them. Everything else is the caller's, including a caller's `undefined` for a
 * field it owns, because a merge that preserved every absent field would make a display name or a
 * parent impossible to clear. Lane A's own `clear()` writes through the STORE (not through this
 * door), so rule 5's clearing still works exactly as it did.
 */
export function mergeAdapterOwnedFields(incoming: RuntimeDirectoryEntry, existing: RuntimeDirectoryEntry | undefined): RuntimeDirectoryEntry {
  if (existing === undefined) return incoming;
  const carried: Partial<RuntimeDirectoryEntry> = {
    ...(incoming.configDir === undefined && existing.configDir !== undefined ? { configDir: existing.configDir } : {}),
    ...(incoming.processIdentity === undefined && existing.processIdentity !== undefined ? { processIdentity: { ...existing.processIdentity } } : {}),
  };
  return { ...incoming, ...carried };
}

/** Many rows, one mapping — so no caller ever writes the `.map(entryToListedRuntimeObject)` itself. */
export function entryToListedRuntimeObjectList(entries: readonly RuntimeDirectoryEntry[]): ListedRuntimeObject[] {
  return entries.map((entry) => entryToListedRuntimeObject(entry));
}

/**
 * The parent's canonical address for a child entry.
 *
 * `parentAddress` is optional on the record, so the fallback derives it from the child's own parsed
 * address — through the SUBPATH's serializer, never a template literal, so this package has exactly
 * one spelling of WS-10 §11's serialization.
 */
export function parentAddressOf(entry: RuntimeDirectoryEntry): SerializedRuntimeAddress | undefined {
  if (entry.objectKind !== "agent") return undefined;
  return entry.parentAddress ?? serializeRuntimeAddress(buildSessionAddress(owningSessionIdOf(entry.parsed)));
}

/** The canonical address of a session id — the same one spelling. */
export function sessionAddressOf(winterSessionId: string): SerializedRuntimeAddress {
  return serializeRuntimeAddress(buildSessionAddress(winterSessionId));
}
