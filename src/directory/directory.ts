// WS-15 §6.1 (D19b's relocation): THE RUNTIME DIRECTORY, over the R-7b-2 persistence seam.
//
// The directory is the router's answer to "what is out there, and which of them is this name". Three
// properties are what make it that rather than a cache:
//
//   1. IT IS THE ONLY AUTHOR OF RUNTIME KIND. "Runtime kind and backend IDs live in the directory
//      record, never trusted from user or model text" (WS-10 §11). A serialized address carries
//      neither, so every listing row this module builds carries the ENTRY's declared kind, and the
//      shared `resolveTarget` carries that row's kind onto the resolved address — which is what the
//      messaging router picks an adapter by.
//   2. RESOLUTION IS A MUST-ORDER, NOT A HEURISTIC (WS-10 §11 rules 1–6). The order is implemented
//      ONCE, in the SDK subpath's `resolveTarget`, shared with the Winter runtime's own in-process
//      router; this module supplies the rows and owns the two things a live-roster resolver cannot
//      know — the NAME-LEASE HISTORY behind rule 5's stale-name refusal, and the archived/exited
//      eligibility split between "what a listing shows" and "what an address may still reach".
//   3. IT NEVER OPENS THE HOST'S DATABASE (R-7b-2). Everything durable goes through
//      `RuntimeDirectoryStore`; the in-memory default is the test store and the answer for a host
//      with no durable state.
import { parseRuntimeAddress, resolveTarget, serializeRuntimeAddress, validateToField } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { ChildLike } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { SeamContext } from "../seams/context.ts";
import type { DirectoryResolution, DirectoryResolutionContext, RuntimeDirectory, RuntimeDirectoryRecovery } from "../seams/directory.ts";
import type { NameLeaseRecord, RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, SerializedRuntimeAddress } from "../seams/messaging-contract.ts";
import { entryToChildLike, entryToListedRuntimeObject, entryToListedRuntimeObjectList, isListableFrom, isResolvableFrom, mergeAdapterOwnedFields, owningSessionIdOf } from "./entries.ts";
import { recoverDirectory, type RuntimeDirectoryRecoveryHooks } from "./recovery.ts";

/** What a caller may configure. Every field has an answer that is correct when it is absent. */
export interface RuntimeDirectoryOptions extends RuntimeDirectoryRecoveryHooks {
  /** Injected so a test never races a real clock. */
  now?: () => number;
  /**
   * How a `ChildLike` built from a directory row delivers, for the two doors that interface requires.
   *
   * The router core never uses them (it calls `adapter.steerChild`/`resumeChild` and reads `ChildLike`
   * only for `status()` and its record) — see `entryToChildLike`. Absent means those two doors answer
   * a typed non-retryable `unavailable` rather than throwing, so a caller that used the interface it
   * was handed gets an outcome instead of a crash.
   */
  deliverToChild?: (entry: RuntimeDirectoryEntry, message: GlobalAgentMessage) => Promise<DeliveryOutcome>;
}

/**
 * The directory, plus the two views the messaging router needs and the seam does not name.
 *
 * `RuntimeDirectory` is what `RuntimeSdk.directory` exposes; a host needs nothing more. The router
 * lives in the same package and needs the SAME snapshot resolution used, or its listing and its
 * resolution could disagree about a row that changed between two `load()` calls.
 */
export interface RuntimeDirectoryHandle extends RuntimeDirectory {
  /** One consistent read of the store, with the caller-scoped views built from it. */
  snapshot(caller: { owningSessionId: string }): Promise<DirectorySnapshot>;
  /** Resolve against an ALREADY-TAKEN snapshot — the router resolves and delivers over one read. */
  resolveIn(snapshot: DirectorySnapshot, to: string, context: DirectoryResolutionContext): Promise<DirectoryResolution>;
}

export interface DirectorySnapshot {
  /** Every entry the store held at the moment of the read. */
  readonly entries: readonly RuntimeDirectoryEntry[];
  readonly byAddress: ReadonlyMap<SerializedRuntimeAddress, RuntimeDirectoryEntry>;
  /** WS-10 §11's resolution input: this caller's own children, as the shared `ChildLike` boundary. */
  readonly children: readonly ChildLike[];
  /** Every object this caller may ADDRESS (includes exited sessions — WS-15 §6.2 has a row for them). */
  readonly resolvable: readonly ListedRuntimeObject[];
  /** Every object a listing may SHOW (WS-10 §10.2 — never an exited session). */
  readonly listable: readonly ListedRuntimeObject[];
}

const unavailableChildDelivery = async (): Promise<DeliveryOutcome> => ({
  status: "unavailable",
  messageId: "",
  retryable: false,
  reason: "this ChildLike was built for resolution only; deliver through the messaging router, which picks the child's own runtime adapter",
});

export function createRuntimeDirectory(context: SeamContext, options: RuntimeDirectoryOptions = {}): RuntimeDirectoryHandle {
  const store: RuntimeDirectoryStore = context.directoryStore;
  const now = options.now ?? (() => Date.now());
  const deliverToChild = options.deliverToChild ?? unavailableChildDelivery;

  async function snapshot(caller: { owningSessionId: string }): Promise<DirectorySnapshot> {
    const entries = await store.load();
    const byAddress = new Map(entries.map((entry) => [entry.address, entry]));
    const children = entries.filter((entry) => entry.objectKind === "agent" && isResolvableFrom(entry, caller.owningSessionId)).map((entry) => entryToChildLike(entry, deliverToChild));
    const resolvable = entryToListedRuntimeObjectList(entries.filter((entry) => isResolvableFrom(entry, caller.owningSessionId)));
    const listable = entryToListedRuntimeObjectList(entries.filter((entry) => isListableFrom(entry, caller.owningSessionId)));
    return { entries, byAddress, children, resolvable, listable };
  }

  /**
   * WS-10 §11 rule 5, the half a live roster cannot answer — and the line between it and rule 4.
   *
   * Rules 4 and 5 both fire on a name more than one object has owned, and they answer DIFFERENTLY:
   *
   *   * rule 4 is TWO LIVE HOLDERS AT ONCE — "ambiguity returns candidates, the router never chooses
   *     arbitrarily". Both objects are addressable; the caller picks.
   *   * rule 5 is REUSE OVER TIME — "a name previously used by a DIFFERENT child in the same
   *     conversation triggers a stale-name refusal unless addressed canonically". There may be exactly
   *     one live holder, and that is precisely when the refusal matters: a plain name would resolve,
   *     confidently, to something the sender may not have meant.
   *
   * The lease history is what tells them apart, and it is the reason `NameLeaseStore.release` STAMPS
   * rather than deletes: `ever` counts every address that has held the name, `current` counts those
   * still holding it. `ever > current` means someone let it go — reuse — and that is rule 5.
   * `current > 1` is rule 4, and is left to `resolveTarget`, which builds the candidate set.
   */
  async function nameHistory(to: string, callerOwningSessionId: string, entries: ReadonlyMap<SerializedRuntimeAddress, RuntimeDirectoryEntry>): Promise<{ ever: SerializedRuntimeAddress[]; current: SerializedRuntimeAddress[] }> {
    // SCOPED TO THE CALLER'S CONVERSATION (review r1, M2). Both WS-10 §11 rule 5 and WS-15 §6.1 rule 5
    // say "a name previously used by a different child IN THE SAME CONVERSATION" — and the shared
    // core's own rule 5 is scoped exactly that way (it filters `ownChildren` by
    // `callerParentSessionId` before counting distinct ids). This directory-level preflight exists to
    // remember a name ACROSS a restart or after `forget()`, which the core cannot; its scope was
    // wrong, and the two harms were real:
    //
    //   * FUNCTIONAL — a name that is unique and live inside one conversation became permanently
    //     unaddressable because an unrelated conversation had once used it, and a lease has no expiry,
    //     so the poisoning never lapsed.
    //   * DISCLOSURE — the refusal text and the candidate rows carried another conversation's
    //     canonical CHILD address, name, mode and status to the model, through the model-facing tool,
    //     in a shape that told a hit from a miss. `ListAgents` refuses to enumerate that same child
    //     and delivery refuses to reach it; the refusal text was the one door left open.
    //
    // A `session:` lease stays in scope for every caller, because a top-level session's name IS global
    // — every caller resolves session names from the same peer set, so remembering that one is gone
    // discloses nothing a listing would not.
    const leases: NameLeaseRecord[] = await store.names.lookup(to);
    const inScope = leases.filter((lease) => {
      const parsed = parseRuntimeAddress(lease.address);
      // NEW-6: a lease whose address does not parse is DROPPED, not admitted. `syncLeases` always
      // writes `entry.address`, so this is unreachable through this package — but a host writing the
      // store directly could put anything there, and the reason text is echoed to the model verbatim.
      // An address the router cannot even name is not one it should be quoting.
      if (parsed === undefined) return false;
      if (parsed.objectKind !== "agent") return true;
      return owningSessionIdOf(parsed) === callerOwningSessionId;
    });
    return {
      ever: [...new Set(inScope.map((lease) => lease.address))],
      current: [...new Set(inScope.filter((lease) => lease.releasedAt === undefined).map((lease) => lease.address))],
    };
  }

  /**
   * The refusal a stale name earns, in the two shapes it comes in.
   *
   * They are different sentences because they are different facts, and a sender acts on them
   * differently: a name that meant SEVERAL things needs the canonical address of the one meant, while
   * a name that meant ONE thing that is gone needs to know the object is gone.
   */
  function staleReason(to: string, holders: readonly SerializedRuntimeAddress[], entries: ReadonlyMap<SerializedRuntimeAddress, RuntimeDirectoryEntry>): string {
    // COUNT THE LEASE, REDACT THE ADDRESS (review r3, NEW-8). NEW-7 was right that an ARCHIVED
    // holder's canonical address must not be quoted to the model — canonical addressing refuses that
    // session outright and no listing shows it — but the fix dropped the lease from the set rule 5
    // COUNTS as well as from the text, and rule 5 stopped firing: a plain name that had belonged to a
    // different object resolved silently and confidently to a live one, which is the exact
    // mis-resolution rule 5 exists to prevent. So the holder still counts and only its NAME is
    // withheld; when nothing nameable is left, the sentence says what happened without naming anything.
    const nameable = holders.filter((address) => entries.get(address)?.status !== "archived");
    const tail = "address the one you mean by its canonical address from the listing";
    // WHICH SENTENCE is decided by how many objects have HELD the name (the fact rule 5 is about);
    // WHICH ADDRESSES appear is decided by how many of them may be named. Deciding the sentence from
    // the nameable count instead would tell a caller that a LIVE holder is "no longer reachable" as
    // soon as an archived sibling was redacted out.
    if (holders.length > 1) return `"${to}" has been used by more than one runtime object${nameable.length > 0 ? ` (${nameable.join(", ")})` : ""}; ${tail}`;
    return nameable.length === 1 ? `"${to}" referred to ${nameable.join(", ")}, which is no longer reachable; ${tail}` : `"${to}" referred to an object that is no longer reachable; ${tail}`;
  }

  /**
   * The rows behind a set of holder addresses — through the CALLER's own eligibility (review r1, M2).
   *
   * `snap.byAddress` is every entry in the store, unfiltered; rendering out of it handed another
   * conversation's child row to the model as a "candidate" it could never address. `isResolvableFrom`
   * is the same fence `snapshot()` builds its views with, so a candidate is now by construction
   * something the caller could actually have meant.
   */
  function candidatesFor(snap: DirectorySnapshot, holders: readonly SerializedRuntimeAddress[], callerOwningSessionId: string): ListedRuntimeObject[] {
    return holders.flatMap((address) => {
      const entry = snap.byAddress.get(address);
      if (entry === undefined || !isResolvableFrom(entry, callerOwningSessionId)) return [];
      return [entryToListedRuntimeObject(entry)];
    });
  }

  /**
   * A FREE FUNCTION, not a method read off `this` (review r1, n1).
   *
   * `RuntimeDirectory` is a published seam (`RuntimeSdk.directory`), and `const { record } =
   * sdk.directory` is an ordinary thing for a host to write — which threw, because `record` reached
   * its collaborator through `this`. The rule `inbound.ts` argues for in its own comment applies here
   * too: a method that needs a sibling calls the function, never the object.
   */
  async function get(address: SerializedRuntimeAddress): Promise<RuntimeDirectoryEntry | undefined> {
    return (await store.load()).find((entry) => entry.address === address);
  }

  async function resolveIn(snap: DirectorySnapshot, to: string, ctx: DirectoryResolutionContext): Promise<DirectoryResolution> {
    // WS-10 §10.1's own `to` constraints. The tool layer validates them too (its refusal is what the
    // model reads); this one is the door's own, so a host calling `resolve()` directly gets the same
    // answer rather than an unbounded string reaching resolution.
    const valid = validateToField(to);
    if (!valid.ok) return { kind: "not-found", reason: valid.message };

    const callerOwner = owningSessionIdOf(ctx.from);
    const isCanonical = parseRuntimeAddress(to) !== undefined;
    const isChildId = !isCanonical && snap.children.some((child) => child.record.id === to);

    // RULE 5 BEFORE RULE 3, and only on the NAME branch. Rules 1 and 2 address an object by an
    // identity that cannot be reused, so a stale-name history says nothing about them — which is
    // exactly why rule 5's own text ends "unless addressed canonically".
    if (!isCanonical && !isChildId) {
      const history = await nameHistory(to, callerOwner, snap.byAddress);
      if (history.ever.length > history.current.length) {
        return { kind: "stale-name", reason: staleReason(to, history.ever, snap.byAddress), candidates: candidatesFor(snap, history.ever, callerOwner) };
      }
    }

    // `peers` is SESSION ROWS ONLY — the same filter the shared core applies to its own
    // `listReachable` answer before resolving. Handing children in on both sides would make a child
    // its own second candidate and turn every child name into a rule-4 ambiguity with itself.
    const resolved = resolveTarget({ to, callerParentSessionId: callerOwner, children: snap.children, peers: snap.resolvable.filter((row) => row.objectKind === "session") });
    if (resolved.kind === "ambiguous") {
      // The candidates come back through the DIRECTORY rather than through the subpath's own child
      // renderer: the row a caller is shown must be the durable record (kind, mode, capabilities),
      // and a child rendered from a `ChildLike` would carry this module's placeholder permission mode
      // as its `mode` (see `entryToChildLike`).
      return { kind: "ambiguous", candidates: candidatesFor(snap, resolved.candidates.map((candidate) => candidate.address), callerOwner) };
    }
    if (resolved.kind === "stale") return { kind: "stale-name", reason: resolved.message, candidates: [] };
    if (resolved.kind === "not_found") {
      // A name the directory REMEMBERS but cannot reach is stale, not unknown — the whole reason a
      // released lease outlives the row it named.
      const history = await nameHistory(to, callerOwner, snap.byAddress);
      if (history.ever.length > 0 && !isCanonical && !isChildId) {
        return { kind: "stale-name", reason: staleReason(to, history.ever, snap.byAddress), candidates: candidatesFor(snap, history.ever, callerOwner) };
      }
      return { kind: "not-found", reason: resolved.message };
    }
    const entry = snap.byAddress.get(serializeRuntimeAddress(resolved.address));
    /* c8 ignore next */
    if (entry === undefined) return { kind: "not-found", reason: `resolved "${to}" to an address with no directory record` }; // unreachable: every row resolution saw came from `snap`
    return { kind: "resolved", entry };
  }

  /**
   * The name-lease side of `record()` (WS-10 §11 rule 5, WS-15 §6.4 step 6).
   *
   * A lease is claimed when an object presents a name, and RELEASED — stamped, never deleted — the
   * moment that object stops being able to answer to it: it was renamed, it lost its name, or it
   * reached a terminal status. The stamp is the entire difference between "that name is stale" and
   * "no such agent" once the row is gone.
   */
  async function syncLeases(incoming: RuntimeDirectoryEntry, previous: RuntimeDirectoryEntry | undefined): Promise<void> {
    const stamp = new Date(now()).toISOString();
    const terminal = incoming.status === "exited" || incoming.status === "archived" || incoming.status === "unavailable";
    if (previous?.displayName !== undefined && (previous.displayName !== incoming.displayName || terminal)) {
      await store.names.release(previous.displayName, previous.address, stamp);
    }
    if (incoming.displayName === undefined || terminal) return;
    const held = (await store.names.lookup(incoming.displayName)).filter((lease) => lease.releasedAt === undefined && lease.address === incoming.address);
    if (held.some((lease) => lease.generation === incoming.generation)) return;
    // A NEW GENERATION IS A NEW HOLDER OF THE SAME NAME. Releasing the old lease first is what makes
    // WS-15 §6.4 step 6's "expire stale name leases by generation" a sweep with something to find,
    // rather than a row that quietly accumulates one held lease per restart.
    for (const lease of held) await store.names.release(lease.name, lease.address, stamp);
    await store.names.claim({ name: incoming.displayName, address: incoming.address, generation: incoming.generation, claimedAt: stamp });
  }

  const directory: RuntimeDirectoryHandle = {
    snapshot,
    resolveIn,

    async list(scope) {
      const entries = await store.load();
      if (scope?.parent === undefined) return entries;
      return entries.filter((entry) => entry.parentAddress === scope.parent);
    },

    get,

    /**
     * Upsert one row — MERGING the two adapter-owned fields rather than replacing them.
     *
     * See `mergeAdapterOwnedFields`: Lane A's spawn proxy writes `configDir`/`processIdentity` onto
     * the same row through the store, and the store's `upsert` is a full replace, so a host recording
     * a status change would otherwise drop WS-14 §6 rule 2's durable record and WS-15 §6.4 step 2's
     * revalidation input — with nothing failing at the time.
     */
    async record(entry) {
      const existing = await get(entry.address);
      const merged = mergeAdapterOwnedFields(entry, existing);
      await store.upsert(merged);
      await syncLeases(merged, existing);
    },

    /**
     * Forget one row. Its name leases are RELEASED (stamped), which is what turns the name into a
     * stale-name refusal instead of a "no such agent".
     *
     * DELIBERATELY NOT TOUCHED: the row's cursor and any messages held for it. A held message is
     * evidence that something was addressed to this object and never delivered; dropping it here
     * would erase that silently, and WS-15 §6.4 step 7's sweep is where held mail is accounted for.
     */
    async forget(address) {
      const existing = await get(address);
      if (existing?.displayName !== undefined) {
        await store.names.release(existing.displayName, address, new Date(now()).toISOString());
      }
      await store.remove(address);
    },

    async resolve(to, ctx) {
      const snap = await snapshot({ owningSessionId: owningSessionIdOf(ctx.from) });
      return resolveIn(snap, to, ctx);
    },

    async recover(): Promise<RuntimeDirectoryRecovery> {
      return recoverDirectory({ store, now, hooks: options });
    },
  };
  return directory;
}
