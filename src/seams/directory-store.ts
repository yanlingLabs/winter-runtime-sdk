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
import type { GlobalAgentMessage, ListedRuntimeObject, RuntimeAddress, RuntimeKind, RuntimeObjectKind, SerializedRuntimeAddress } from "./messaging-contract.ts";

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
  /** The display name a `ListAgents` listing shows; absent when the object has never been named. */
  displayName?: string;
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
  /** ISO-8601. */
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

/** R-7b-2's seam, as the plan pins it. */
export interface RuntimeDirectoryStore {
  load(): Promise<RuntimeDirectoryEntry[]>;
  upsert(e: RuntimeDirectoryEntry): Promise<void>;
  remove(address: SerializedRuntimeAddress): Promise<void>;
  cursors: CursorStore;
  mailboxes: MailboxStore;
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
  };
}
