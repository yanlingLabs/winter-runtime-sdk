// R-7b-2: THE PERSISTENCE SEAM. The router never opens the host's `runtime-state.db`.
//
// WS-15 §6's directory and messaging service move down into this package (D19b) but their persistence
// sink does NOT: `runtime-state.db` is the host's product record (WS-16), with the host's migrations,
// the host's backup story and the host's schema. So the router defines what it needs — entries,
// cursors, held mailboxes — and RECEIVES an implementation. A default in-memory implementation ships
// for tests and for hosts with no durable state; restart recovery (WS-15 §6.4) is specified against
// this seam, not against a database.
//
// WHAT LIVES ON WHICH SIDE, because the split only works if it is stated:
//   * THE STORE (this file) is a dumb sink: it holds records, hands them back, and forgets them when
//     told. It enforces no caps, expires nothing, resolves no names, and knows no policy.
//   * THE ROUTER (Lane B) owns every rule: WS-10 §13's 50-accepted/100-held caps, the 5-minute
//     dialog expiry, the 12-hour idle subscription, dedupe, retries, loop prevention, and the §11
//     resolution order. A cap enforced in the store would be a second, invisible copy of a rule the
//     router must apply anyway (it has to produce the visible refusal), and the two would drift.
import type { RuntimeSelection } from "../selection/runtime-selection.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, RuntimeAddress, RuntimeKind, RuntimeObjectKind, SerializedRuntimeAddress } from "./messaging-contract.ts";

/**
 * WS-15 §6.1's `transport`, which `runtimeKind × objectKind` CANNOT recover (review r1, M1).
 *
 * An in-daemon Dispatch/Chat session (`winter-thread`) and a spawned Code session (`winter-session`)
 * are both `winter-agent`/`session`, and that is precisely the split the Winter messaging adapter
 * routes on: a direct in-process push versus the spawned session's `Query.messaging` wire facet.
 */
export type RuntimeTransport = "winter-thread" | "winter-session" | "claude-handle" | "claude-child";

/**
 * WS-15 §6.1's directory record: one addressable runtime object (a session or one of its children).
 *
 * `selection` is the object's OWN persisted runtime, never its parent's — R-7b-1's whole point, and
 * what makes WS-13c §8 ("the child's own record is authoritative on resume") enforceable rather than
 * aspirational. `generation` is WS-10 §12's monotonic counter, the thing a `toGeneration` on an
 * envelope is checked against so a message addressed to a previous incarnation is refused rather
 * than delivered to its successor.
 */
export interface RuntimeDirectoryEntry {
  /** The canonical serialization — the key every other method takes. */
  address: SerializedRuntimeAddress;
  /** The structured form of `address`. Stored alongside so a reader never re-parses. */
  parsed: RuntimeAddress;
  runtimeKind: RuntimeKind;
  objectKind: RuntimeObjectKind;
  /** WS-15 §6.1's own field — see `RuntimeTransport`; NOT derivable from the two above. */
  transport: RuntimeTransport;
  /** The display name a `ListAgents` listing shows; absent when the object has never been named. */
  displayName?: string;
  /** WS-15 §6.1's `title` — the session's own title, when it has one. */
  title?: string;
  status: ListedRuntimeObject["status"];
  /** `code` | `dispatch` | `chat` — an open string here because the mode vocabulary is the host's (WS-15 §2). */
  mode: string;
  cwd?: string;
  /** WS-10 §12's incarnation counter. */
  generation: number;
  /** This object's own persisted runtime choice (R-7b-1 / WS-13c §8). */
  selection: RuntimeSelection;
  /** Present for a child; the canonical address of its parent session. */
  parentAddress?: SerializedRuntimeAddress;
  /** The backend (runtime-side) session id, absent while "starting". */
  backendSessionId?: string;
  capabilities: ListedRuntimeObject["capabilities"];
  /**
   * ISO-8601. A DELIBERATE DEPARTURE from WS-15 §6.1's `updatedAt: number`: every other timestamp on
   * this seam that a human ever reads is ISO (`RuntimeSelection.decidedAt`, the lease records below),
   * and one record carrying epoch milliseconds while its neighbours carry ISO is the kind of
   * inconsistency that produces a `new Date(isoString)` bug in a host months later. The epoch-ms
   * spelling is kept where it is load-bearing for arithmetic — `HeldMessageRecord.heldAt/expiresAt`,
   * which the mailbox's own expiry compares numerically, matching the runtime's mailbox exactly.
   */
  updatedAt: string;
}

/**
 * Per-address delivery cursors (WS-15 §6.4's recovery, WS-17 row 11's "index.db rebuild preserves
 * runtime mappings, backend IDs, cursors").
 *
 * A cursor is an OPAQUE string to this seam: what it points at is the adapter's business.
 */
export interface CursorStore {
  get(address: SerializedRuntimeAddress): Promise<string | undefined>;
  set(address: SerializedRuntimeAddress, cursor: string): Promise<void>;
  remove(address: SerializedRuntimeAddress): Promise<void>;
  /** Every cursor, for the restart sweep. */
  all(): Promise<Record<SerializedRuntimeAddress, string>>;
}

/**
 * One held message, as the store keeps it.
 *
 * The FULL envelope is stored, not a reference: WS-15 §6.4's restart recovery has to be able to
 * deliver a message the process was holding when it died, and a record that only remembered an id
 * would need the message to have been persisted somewhere else as well.
 */
export interface HeldMessageRecord {
  messageId: string;
  /** The canonical address the message is held FOR. */
  receiver: SerializedRuntimeAddress;
  reason: string;
  /** WS-10 §13: an explicit hold persists; a default-class hold expires (5-minute dialog expiry). */
  kind: "default" | "explicit";
  /** Epoch milliseconds, matching the runtime's own mailbox. */
  heldAt: number;
  /** Present only for `kind: "default"`. */
  expiresAt?: number;
  message: GlobalAgentMessage;
}

/** The held-mailbox sink. Caps and expiry are the ROUTER's (see this file's header). */
export interface MailboxStore {
  listHeld(receiver: SerializedRuntimeAddress): Promise<HeldMessageRecord[]>;
  hold(record: HeldMessageRecord): Promise<void>;
  takeHeld(receiver: SerializedRuntimeAddress, messageId: string): Promise<HeldMessageRecord | undefined>;
  clear(receiver: SerializedRuntimeAddress): Promise<void>;
  /** Every receiver holding at least one message — the entry point of the restart sweep. */
  receivers(): Promise<SerializedRuntimeAddress[]>;
}

/**
 * ONE DELIVERY, from the moment its id exists to the moment its receipt does (WS-15 §6.2).
 *
 * The pipeline the router runs is explicit about what must be durable, and in which order: "allocate
 * and **persist** the request/message ID **before address resolution** (so ambiguous/missing/
 * unavailable outcomes are idempotent too) → **persist the envelope** and resolved target generation
 * → … → **persist the adapter receipt**", so that "a retry returns the stored outcome instead of
 * starting a second turn".
 *
 * `claimedBy` set with no `outcome` is the crash window: WS-15 §6.4 step 5 reconciles exactly those
 * as `delivery_uncertain`, which is why they are two fields and not one status enum — the pair is the
 * evidence, and a single "status" would let a writer describe a state it had not actually reached.
 */
export interface DeliveryRecord {
  /** WS-10 §12: derived from (sender session, tool-call id), so a retry allocates the SAME id. */
  messageId: string;
  /** The envelope, persisted before resolution — a restart must be able to finish what it started. */
  message: GlobalAgentMessage;
  /** The target generation resolution picked. A later generation is a different incarnation. */
  toGeneration: number;
  /** Set at the atomic claim, before the adapter is invoked; a claim with no receipt is "uncertain". */
  claimedBy?: RuntimeKind;
  /** THE RECEIPT. A retry with the same `messageId` returns this instead of delivering again. */
  outcome?: DeliveryOutcome;
  /** ISO-8601. */
  updatedAt: string;
}

/** The idempotency sink. Policy (dedupe windows, retry limits, loop guards) stays with the router. */
export interface DeliveryRecordStore {
  get(messageId: string): Promise<DeliveryRecord | undefined>;
  put(record: DeliveryRecord): Promise<void>;
  /** WS-15 §6.4 step 5's entry point: claimed, never receipted — every one is `delivery_uncertain`. */
  claimedWithoutReceipt(): Promise<DeliveryRecord[]>;
}

/**
 * A pending `notify_when_idle` (WS-10 §14, WS-15 §6.3).
 *
 * §6.3 is explicit that this one "survives restart only when durably stored with valid target
 * identity/generation" — hence `targetGeneration`, without which a notice could fire for a different
 * incarnation of the same address.
 */
export interface IdleSubscriptionRecord {
  messageId: string;
  /** Who gets the notice. */
  subscriber: SerializedRuntimeAddress;
  /** What is being watched. */
  target: SerializedRuntimeAddress;
  targetGeneration: number;
  /** Epoch milliseconds — compared numerically against WS-10 §14's 12-hour expiry. */
  createdAt: number;
  expiresAt: number;
}

export interface IdleSubscriptionStore {
  list(): Promise<IdleSubscriptionRecord[]>;
  add(record: IdleSubscriptionRecord): Promise<void>;
  remove(messageId: string): Promise<void>;
}

/**
 * A display-name lease, live or released (WS-10 §11 rule 5, WS-15 §6.4 step 6).
 *
 * WHY THE HISTORY OUTLIVES THE ENTRY. Rule 5 says a STALE name is refused — not "not found". Telling
 * those two apart after the object is gone requires remembering that the name once meant something,
 * which `RuntimeDirectoryEntry.displayName` cannot do (it disappears with `remove()`). A released
 * lease is that memory, and it is the only thing that lets the router answer "that name referred to a
 * session that has since exited" instead of "no such agent".
 */
export interface NameLeaseRecord {
  /** The display name, exactly as a model or user would write it. */
  name: string;
  address: SerializedRuntimeAddress;
  /** The holder's generation at the time of the claim. */
  generation: number;
  /** ISO-8601. */
  claimedAt: string;
  /** ISO-8601; absent while the lease is held. */
  releasedAt?: string;
}

export interface NameLeaseStore {
  /** Every record for a name — a held one (at most one) plus released ones. Order is the caller's business. */
  lookup(name: string): Promise<NameLeaseRecord[]>;
  claim(record: NameLeaseRecord): Promise<void>;
  release(name: string, address: SerializedRuntimeAddress, releasedAt: string): Promise<void>;
  /** Every currently-held lease — WS-15 §6.4 step 6 sweeps these by generation. */
  held(): Promise<NameLeaseRecord[]>;
}

/**
 * R-7b-2's seam.
 *
 * The plan pins the first five members; `deliveries`, `subscriptions` and `names` were added in fix
 * round 1 (review r1, I1) because three obligations the plan assigns Lane B — WS-15 §6.2's persisted
 * id/envelope/claim/receipt, §6.3's restart-surviving idle subscriptions, and §6.4 step 6 / WS-10 §11
 * rule 5's name leases — had no durable sink at all, here or in the SDK-side router core (whose
 * outcome map and notification queue are bounded, explicitly non-durable, in-memory `Map`s). The
 * router's store is the only durable place they can live.
 */
export interface RuntimeDirectoryStore {
  load(): Promise<RuntimeDirectoryEntry[]>;
  upsert(e: RuntimeDirectoryEntry): Promise<void>;
  remove(address: SerializedRuntimeAddress): Promise<void>;
  cursors: CursorStore;
  mailboxes: MailboxStore;
  deliveries: DeliveryRecordStore;
  subscriptions: IdleSubscriptionStore;
  names: NameLeaseStore;
}

/**
 * A defensive copy. `structuredClone` is present in Node 18+ and Bun, and the fallback keeps this
 * module importable anywhere else.
 *
 * WHY COPY AT ALL, in a store whose whole point is to be simple: a caller that mutated an entry it
 * had `load()`ed would be editing the store's own state without an `upsert()`, and every later reader
 * would see a record nobody wrote. That is exactly the class of bug a durable implementation cannot
 * have (it serializes), so the in-memory default must not have it either — otherwise the test double
 * and production disagree about something no test would think to check.
 */
function copy<T>(value: T): T {
  const clone = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone;
  return typeof clone === "function" ? clone(value) : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * The in-memory `RuntimeDirectoryStore` — the default when a host injects none, and the store every
 * hermetic test uses.
 *
 * FULLY IMPLEMENTED, not a stub: it is the test default, so "the directory works" must be provable
 * without a host. It touches no filesystem, no `~/.winter`, no keychain, and holds nothing across a
 * process — which is also the honest statement of what a host gets if it never supplies one.
 */
export function createInMemoryRuntimeDirectoryStore(): RuntimeDirectoryStore {
  const entries = new Map<SerializedRuntimeAddress, RuntimeDirectoryEntry>();
  const cursors = new Map<SerializedRuntimeAddress, string>();
  const held = new Map<SerializedRuntimeAddress, HeldMessageRecord[]>();
  const deliveries = new Map<string, DeliveryRecord>();
  const subscriptions = new Map<string, IdleSubscriptionRecord>();
  const leases = new Map<string, NameLeaseRecord[]>();

  return {
    async load() {
      return [...entries.values()].map((entry) => copy(entry));
    },
    async upsert(entry) {
      entries.set(entry.address, copy(entry));
    },
    async remove(address) {
      entries.delete(address);
    },
    cursors: {
      async get(address) {
        return cursors.get(address);
      },
      async set(address, cursor) {
        cursors.set(address, cursor);
      },
      async remove(address) {
        cursors.delete(address);
      },
      async all() {
        return Object.fromEntries(cursors);
      },
    },
    mailboxes: {
      async listHeld(receiver) {
        return (held.get(receiver) ?? []).map((record) => copy(record));
      },
      async hold(record) {
        const box = held.get(record.receiver);
        if (box === undefined) held.set(record.receiver, [copy(record)]);
        else box.push(copy(record));
      },
      async takeHeld(receiver, messageId) {
        const box = held.get(receiver);
        if (box === undefined) return undefined;
        const index = box.findIndex((record) => record.messageId === messageId);
        if (index === -1) return undefined;
        const [taken] = box.splice(index, 1);
        if (box.length === 0) held.delete(receiver);
        return taken;
      },
      async clear(receiver) {
        held.delete(receiver);
      },
      async receivers() {
        return [...held.keys()];
      },
    },
    deliveries: {
      async get(messageId) {
        const record = deliveries.get(messageId);
        return record === undefined ? undefined : copy(record);
      },
      async put(record) {
        deliveries.set(record.messageId, copy(record));
      },
      async claimedWithoutReceipt() {
        return [...deliveries.values()].filter((r) => r.claimedBy !== undefined && r.outcome === undefined).map((r) => copy(r));
      },
    },
    subscriptions: {
      async list() {
        return [...subscriptions.values()].map((r) => copy(r));
      },
      async add(record) {
        subscriptions.set(record.messageId, copy(record));
      },
      async remove(messageId) {
        subscriptions.delete(messageId);
      },
    },
    names: {
      async lookup(name) {
        return (leases.get(name) ?? []).map((r) => copy(r));
      },
      async claim(record) {
        const existing = leases.get(record.name);
        if (existing === undefined) leases.set(record.name, [copy(record)]);
        else existing.push(copy(record));
      },
      async release(name, address, releasedAt) {
        // A RELEASE IS A STAMP, NOT A DELETE. The record has to outlive the object for WS-10 §11
        // rule 5 to tell a stale name from an unknown one; deleting it here would collapse those two
        // answers into "not found", which is the refusal rule 5 exists to avoid.
        for (const record of leases.get(name) ?? []) {
          if (record.address === address && record.releasedAt === undefined) record.releasedAt = releasedAt;
        }
      },
      async held() {
        return [...leases.values()].flat().filter((r) => r.releasedAt === undefined).map((r) => copy(r));
      },
    },
  };
}
