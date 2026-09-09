// THE SHARED SESSION STORE (WS-05 §6, WS-14 §5) — one instance, one version, both branches.
//
// WS-05 §6 in one sentence: "One filesystem-backed store implemented in the SDK repo; Winter v2 and
// the official branch consume the IDENTICAL package/version." That is not a statement about two
// stores that happen to agree — it is a statement about ONE object. Two `WinterCompatibilitySessionStore`
// instances over the same home would each take the same per-session writer lease from the same pid
// (leases.ts's same-process re-entry always succeeds), so nothing would fail; the two would simply
// interleave their appends with no ordering between them. `attach()` below is therefore the ONLY door
// that puts a store on an options object, and `assertOneSharedStore` is the assertion that says the
// two branches got the same one.
//
// WHY THERE IS A FACADE AT ALL, rather than handing the raw store to both branches:
//
//   1. WS-14 §5's MIRROR SEMANTICS have to hold for BOTH branches. "local JSONL write first; ~100 ms
//      batches; ≤3 append attempts with short backoff; a timed-out append is NOT retried." The
//      official wrapper batches on its own side; the Winter branch does not batch at all. A facade is
//      the one place the contract can be true for whoever is writing.
//   2. `mirror_error` HANDLING IS THE ROUTER'S. §5: a mirror failure "MUST NOT retroactively fail the
//      model turn", MUST set `transcriptHealth: repair-required`, and MUST block Claude↔Winter handoff
//      "until the canonical store is reconciled ... before wrapper cleanup". A store that threw would
//      fail the turn; a store that swallowed silently would lose the health flag. The facade resolves
//      the caller's promise and records the failure.
//   3. WS-05 §12 STEP 3 NEEDS A PENDING BARRIER: "wait for all received `append()` calls to settle
//      (host-side pending barrier — the SDK has no flush method)". That sentence only has meaning if
//      `append()` returning is not the same as the write having landed — which is exactly what a
//      ~100 ms batch window makes true. `settle()` is that barrier.
//
// NOTHING HERE EVER LOOKS INSIDE AN ENTRY, and nothing here logs one. Opaque provider state
// (`encrypted_content`, thinking signatures, `reasoning_item`) travels through `append()` as ordinary
// entry content; a `MirrorErrorRecord` carries counts and a cause, never a payload, and this module
// has no logging of any kind (WS-05 §13, the global constraint).
import { randomUUID } from "node:crypto";

import type { SessionKey, SessionStore, SessionStoreEntry, SessionSummaryEntry } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../errors.ts";
import type { RuntimeSdkPeers } from "../sdk.ts";

// --- the pieces of the SDK's concrete store this package uses --------------------------------------

/**
 * The concrete store's surface, as the router uses it.
 *
 * STRUCTURAL, not `InstanceType<typeof peers.winter.WinterCompatibilitySessionStore>`, for the same
 * reason `seams/official-sdk-shapes.ts` types the official module structurally: the peer is INJECTED,
 * so the router must describe what it needs rather than name a class it never imports. The four
 * Winter-only members below are on the concrete class and deliberately NOT on the pinned
 * `SessionStore` type (WS-03 §10 pins that at exactly six members) — the store's own comments say so.
 */
export interface CanonicalSessionStore extends SessionStore {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries(projectKey: string): Promise<SessionSummaryEntry[]>;
  delete(key: SessionKey): Promise<void>;
  listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]>;
  listProjectKeys(): Promise<string[]>;
  readSessionSummary(key: { projectKey: string; sessionId: string }): Promise<SessionSummaryEntry | null>;
  acquireSessionLease(key: { projectKey: string; sessionId: string }): Promise<void>;
}

/** The constructor the injected peer exports. */
export type CanonicalSessionStoreConstructor = new (opts: { winterHome: string }) => CanonicalSessionStore;

// --- typed refusals (WS-14 §13's "never a collapsed `Error`", applied to the store's own surface) ---

/** WS-14 §5.1: an options combination the shared store cannot be used with. */
export class SharedStoreOptionsError extends RuntimeSdkError {
  readonly option: "persistSession" | "enableFileCheckpointing" | "sessionStore";
  constructor(args: { option: "persistSession" | "enableFileCheckpointing" | "sessionStore"; reason: string }) {
    super(`winter-runtime-sdk: ${args.option} is incompatible with the shared session store — ${args.reason}`);
    this.option = args.option;
  }
}

/**
 * WS-14 §5: "Blind `importSessionToStore()` after partial mirror failure is forbidden."
 *
 * A THROW AND NOT A WARNING. The import transports a whole local transcript into the canonical store;
 * run after a PARTIAL mirror it re-imports entries that already landed and re-orders around the ones
 * that did not, which is the one failure the canonical file cannot recover from by itself. The safe
 * door is `reconcile.ts`'s suffix-only reconciliation, and this class names it.
 */
export class BlindStoreImportError extends RuntimeSdkError {
  readonly key: Readonly<SessionKey>;
  constructor(key: SessionKey, detail: string) {
    super(
      `winter-runtime-sdk: a blind session import into ${key.projectKey}/${key.sessionId} is forbidden while the mirror is unhealthy (WS-14 §5) — ${detail}. Reconcile the canonical tail against the recorded local-write root first (transcript-only, suffix-only).`,
    );
    this.key = Object.freeze({ ...key });
  }
}

/** The injected Winter peer does not carry the concrete store (a peer built for a different purpose). */
export class SharedStoreUnavailableError extends RuntimeSdkError {
  constructor() {
    super(
      "winter-runtime-sdk: the injected Winter peer exports no `WinterCompatibilitySessionStore`, so there is no store for the two branches to share (WS-05 §6 requires the identical package/version on both legs)",
    );
  }
}

// --- WS-14 §5's mirror policy ----------------------------------------------------------------------

export interface MirrorPolicy {
  /** §5's "~100 ms batches". Appends inside one window become ONE canonical append. */
  batchWindowMs: number;
  /** §5's "≤3 append attempts". */
  maxAttempts: number;
  /** §5's "short backoff" between attempts. */
  backoffMs: number;
  /**
   * How long ONE attempt may take before it is abandoned.
   *
   * §5: "a timed-out append is **not** retried". The reason is not politeness — a timed-out append may
   * still land, so a retry is the one action that can duplicate entries in an append-only file.
   */
  attemptTimeoutMs: number;
}

export const DEFAULT_MIRROR_POLICY: MirrorPolicy = Object.freeze({
  batchWindowMs: 100,
  maxAttempts: 3,
  backoffMs: 25,
  attemptTimeoutMs: 5_000,
});

export type TranscriptHealth = "ok" | "repair-required";

/** What a failed mirror records. COUNTS AND A CAUSE — never entry content (WS-05 §13). */
export interface MirrorErrorRecord {
  projectKey: string;
  sessionId: string;
  subpath?: string;
  /** How many entries were in the batch that failed. Never what they were. */
  entryCount: number;
  attempts: number;
  cause: "append-failed" | "timed-out";
  /** The failure's own message, from the store's typed error — never an entry. */
  detail: string;
  at: string;
}

export interface SessionMirrorHealth {
  transcriptHealth: TranscriptHealth;
  errors: readonly MirrorErrorRecord[];
  /** Canonical appends this session has completed — the "~100 ms batches" observation. */
  batchesCommitted: number;
  /** `append()` calls received from a branch. Two inside one window commit as one batch. */
  appendsReceived: number;
}

export interface SettleReport {
  /** True when every pending batch reached a terminal state (committed or recorded as a mirror error). */
  settled: boolean;
  batchesCommitted: number;
  errors: readonly MirrorErrorRecord[];
  transcriptHealth: TranscriptHealth;
}

/** The identity that makes "one instance, one version" checkable rather than asserted. */
export interface SharedStoreIdentity {
  packageName: string;
  /** The injected peer's own version identity — the version BOTH branches are therefore using. */
  packageVersion: string;
  /** Unique per `createSharedSessionStore` call, so "the same store" is provable by value. */
  instanceId: string;
  winterHome: string;
}

/** Options members WS-14 §5.1 rules on. Structural, so both branches' option objects fit. */
export interface StoreBearingOptions {
  sessionStore?: unknown;
  persistSession?: boolean;
  enableFileCheckpointing?: boolean;
}

export interface SharedSessionStore {
  /** THE object handed to both branches as `Options.sessionStore`. */
  readonly store: SessionStore;
  /** The underlying concrete store, for the barrier's lease/summary doors. Never handed to a branch. */
  readonly canonical: CanonicalSessionStore;
  readonly identity: SharedStoreIdentity;
  readonly policy: MirrorPolicy;
  /** WS-05 §12 step 3's host-side pending barrier. No key = every session. */
  settle(key?: SessionKey): Promise<SettleReport>;
  health(key: SessionKey): SessionMirrorHealth;
  /**
   * Clears a session's `repair-required` flag. THE ONLY CALLER IS A COMPLETED RECONCILIATION
   * (`reconcile.ts`) — the flag exists to block a handoff until the canonical store is reconciled, so
   * anything else clearing it would be clearing the evidence rather than the cause.
   */
  markReconciled(key: SessionKey, detail: string): void;
  /** Attaches the shared store to an options object, refusing §5.1's two combinations. */
  attach<T extends StoreBearingOptions>(options: T): T & { sessionStore: SessionStore };
  /** WS-14 §5's blind-import ban, as a guard a host calls before `importSessionToStore()`. */
  assertImportAllowed(key: SessionKey): void;
  /** WS-13 §8.2's no-wash-back mechanism. Shared with the decorator and the reconciler. */
  readonly decorations: DecorationRegistry;
}

// --- WS-13 §8.2's no-wash-back mechanism -------------------------------------------------------------

/**
 * The uuids of entries that exist ONLY in a materialized resume copy.
 *
 * WHY THIS EXISTS AT ALL. WS-13 §8.2's PREFERRED door bakes decorations into the copy the destination
 * runtime reads, "the canonical file stays byte-pure". But the destination then WRITES its next turn
 * with `parentUuid` pointing at whatever it read last — including a decoration — and mirrors that turn
 * back through this store. Without a registry, the byte-pure canonical file would acquire either the
 * decoration itself (via reconciliation's suffix append) or an entry whose parent is unreachable in it
 * (WS-05 §12 step 5's own validation would then fail the NEXT handoff). Both are the wash-back the
 * probe is about; this is the mechanism that makes the probe pass rather than a hope that it does.
 *
 * IN-MEMORY BY DESIGN. §8.2: "decorations are recomputed fresh at every leg spawn (never stale)". A
 * copy outlives neither the generation that staged it nor the process that decorated it, so a durable
 * ledger would only ever hold entries about copies that no longer exist.
 */
export interface DecorationRegistry {
  /** Records an entry that lives only in the copy, with the parent the canonical chain should keep. */
  record(key: SessionKey, decoration: { uuid: string; parentUuid: string | null }): void;
  has(key: SessionKey, uuid: string): boolean;
  list(key: SessionKey): readonly string[];
  /** The parent a decoration stands in front of, resolving a chain of them. */
  canonicalParentOf(key: SessionKey, uuid: string): string | null;
  forget(key: SessionKey): void;
}

export function createDecorationRegistry(): DecorationRegistry {
  const bySession = new Map<string, Map<string, string | null>>();
  const of = (key: SessionKey): Map<string, string | null> => {
    const id = sessionOf(key);
    let map = bySession.get(id);
    if (map === undefined) {
      map = new Map();
      bySession.set(id, map);
    }
    return map;
  };
  return {
    record(key, decoration) {
      of(key).set(decoration.uuid, decoration.parentUuid);
    },
    has(key, uuid) {
      return of(key).has(uuid);
    },
    list(key) {
      return [...of(key).keys()];
    },
    canonicalParentOf(key, uuid) {
      const map = of(key);
      let cursor: string | null = uuid;
      const seen = new Set<string>();
      while (cursor !== null && map.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        cursor = map.get(cursor) ?? null;
      }
      return cursor;
    },
    forget(key) {
      bySession.delete(sessionOf(key));
    },
  };
}

export interface StripDecorationsResult {
  entries: SessionStoreEntry[];
  dropped: number;
  reparented: number;
}

/**
 * Removes copy-only entries from a batch on its way into the canonical store, and re-links the chain.
 *
 * RE-PARENTING IS NOT OPTIONAL. Dropping a decoration whose child points at it would leave the child
 * with an unreachable `parentUuid` — exactly what WS-05 §12 step 5 validates and refuses. The child's
 * `parentUuid` becomes the decoration's own parent, which is the link the canonical file would have had
 * if the decoration had never been staged. Nothing else about the entry is touched, and an entry with
 * no decorated parent is returned by IDENTITY (never a copy), so a batch with no decorations in it is
 * byte-identical to the one the branch handed us.
 */
export function stripDecorations(key: SessionKey, entries: readonly SessionStoreEntry[], registry: DecorationRegistry): StripDecorationsResult {
  let dropped = 0;
  let reparented = 0;
  const out: SessionStoreEntry[] = [];
  for (const entry of entries) {
    const uuid = entry["uuid"];
    if (typeof uuid === "string" && registry.has(key, uuid)) {
      dropped += 1;
      continue;
    }
    const parentUuid = entry["parentUuid"];
    if (typeof parentUuid === "string" && registry.has(key, parentUuid)) {
      out.push({ ...entry, parentUuid: registry.canonicalParentOf(key, parentUuid) });
      reparented += 1;
      continue;
    }
    out.push(entry);
  }
  return { entries: out, dropped, reparented };
}

const keyOf = (key: SessionKey): string => JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
const sessionOf = (key: SessionKey): string => JSON.stringify([key.projectKey, key.sessionId]);

interface PendingBatch {
  /**
   * The key this batch belongs to, carried rather than parsed back out of the map id.
   *
   * `projectKey`/`sessionId` reject only empty, `/`, `.` and `..` (the concrete store's own
   * `assertSafeSingleSegment`), so a space or a colon is a legal key and any separator character a map
   * id chose could collide with one. Keeping the key means nothing ever has to split an id apart.
   */
  key: SessionKey;
  entries: SessionStoreEntry[];
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves when this batch has reached a terminal state. */
  done: Promise<void>;
  resolve: () => void;
}

interface SessionState {
  health: TranscriptHealth;
  errors: MirrorErrorRecord[];
  batchesCommitted: number;
  appendsReceived: number;
}

/**
 * WS-14 §5.1's two refusals, over any options object carrying a store.
 *
 * BOTH BRANCHES, ONE RULE. The Winter SDK's own `query()` refuses the same two combinations at
 * construction (`packages/sdk/src/query.ts`), and Lane A's `assertOptionsInvariants` refuses them on
 * the official template. This is the third site on purpose: it is the one that runs when the ROUTER
 * attaches the store, i.e. before either branch exists, and it throws a TYPED class rather than the
 * bare `Error` the SDK's constructor-time check throws.
 */
export function assertStoreCompatibleOptions(options: StoreBearingOptions): void {
  if (options.persistSession === false) {
    throw new SharedStoreOptionsError({
      option: "persistSession",
      reason: "the store is a MIRROR of local transcript writes, and `persistSession: false` suppresses the local writes there is nothing left to mirror from (WS-14 §5.1)",
    });
  }
  if (options.enableFileCheckpointing === true) {
    throw new SharedStoreOptionsError({
      option: "enableFileCheckpointing",
      reason: "backup blobs are not mirrored, so `rewindFiles()` fails after a store-backed resume; §5.1 says the option MUST NOT be set on this branch at all",
    });
  }
}

/**
 * Asserts that every options object listed carries the SAME store object (WS-05 §6).
 *
 * BY IDENTITY, because that is the only check that means anything: two stores over one home are
 * type-identical, version-identical, and still two writers.
 */
export function assertOneSharedStore(shared: SharedSessionStore, ...options: ReadonlyArray<{ sessionStore?: unknown }>): void {
  for (const candidate of options) {
    if (candidate.sessionStore === undefined) {
      throw new SharedStoreOptionsError({ option: "sessionStore", reason: "one of the branches was given no session store at all, so the two cannot be sharing one (WS-05 §6)" });
    }
    if (candidate.sessionStore !== shared.store) {
      throw new SharedStoreOptionsError({
        option: "sessionStore",
        reason: "the two branches were given DIFFERENT store objects; WS-05 §6 requires the identical instance, and two instances over one home interleave their appends with no ordering between them",
      });
    }
  }
}

export interface SharedSessionStoreInput {
  peers: RuntimeSdkPeers;
  winterHome: string;
  policy?: Partial<MirrorPolicy>;
  /** Injectable clock for the records' timestamps. */
  now?: () => Date;
  /** WS-13 §8.2's decoration registry. A fresh one per store unless a host shares one deliberately. */
  decorations?: DecorationRegistry;
}

/**
 * Builds the one store both branches share.
 *
 * THE CLASS COMES FROM THE INJECTED PEER, never from an import of this package's own: a host that
 * vendored its own copy of the Winter SDK gets ITS store, ITS lease semantics and ITS typed errors —
 * the same argument `createRuntimeSdk` already makes for `resolveBrand`/`InvalidBrandError`.
 */
export function createSharedSessionStore(input: SharedSessionStoreInput): SharedSessionStore {
  const Store = (input.peers.winter as unknown as { WinterCompatibilitySessionStore?: CanonicalSessionStoreConstructor }).WinterCompatibilitySessionStore;
  if (typeof Store !== "function") throw new SharedStoreUnavailableError();
  const canonical = new Store({ winterHome: input.winterHome });
  const policy: MirrorPolicy = { ...DEFAULT_MIRROR_POLICY, ...input.policy };
  const now = input.now ?? (() => new Date());
  const identity: SharedStoreIdentity = {
    packageName: "@yanlinglabs/winter-agent-sdk",
    packageVersion: readPeerVersion(input.peers),
    instanceId: randomUUID(),
    winterHome: input.winterHome,
  };

  const decorations = input.decorations ?? createDecorationRegistry();
  const batches = new Map<string, PendingBatch>();
  const sessions = new Map<string, SessionState>();

  const stateFor = (key: SessionKey): SessionState => {
    const id = sessionOf(key);
    let state = sessions.get(id);
    if (state === undefined) {
      state = { health: "ok", errors: [], batchesCommitted: 0, appendsReceived: 0 };
      sessions.set(id, state);
    }
    return state;
  };

  const recordMirrorError = (key: SessionKey, record: Omit<MirrorErrorRecord, "projectKey" | "sessionId" | "subpath" | "at">): void => {
    const state = stateFor(key);
    state.health = "repair-required";
    state.errors.push({
      projectKey: key.projectKey,
      sessionId: key.sessionId,
      ...(key.subpath === undefined ? {} : { subpath: key.subpath }),
      ...record,
      at: now().toISOString(),
    });
  };

  /**
   * One batch's trip to the canonical store: §5's attempt policy, in one place.
   *
   * A TIMED-OUT ATTEMPT ENDS THE BATCH. The abandoned promise keeps a `catch` so an eventual rejection
   * is not an unhandled one, and its eventual SUCCESS is exactly why no retry follows it: the write may
   * have landed, and a second attempt would duplicate it in an append-only file.
   */
  const commit = async (key: SessionKey, entries: SessionStoreEntry[]): Promise<void> => {
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const appended = canonical.append(key, entries);
      appended.catch(() => undefined); // an abandoned attempt must never surface as unhandled
      const timedOut = Symbol("timed-out");
      try {
        const outcome = await Promise.race([
          appended.then(() => undefined),
          new Promise<typeof timedOut>((resolve) => {
            timer = setTimeout(() => resolve(timedOut), policy.attemptTimeoutMs);
          }),
        ]);
        if (outcome === timedOut) {
          recordMirrorError(key, {
            entryCount: entries.length,
            attempts: attempt,
            cause: "timed-out",
            detail: `the canonical append did not settle within ${policy.attemptTimeoutMs} ms; WS-14 §5 forbids retrying it because it may still land`,
          });
          return;
        }
        stateFor(key).batchesCommitted += 1;
        return;
      } catch (error) {
        if (attempt === policy.maxAttempts) {
          recordMirrorError(key, {
            entryCount: entries.length,
            attempts: attempt,
            cause: "append-failed",
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, policy.backoffMs));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  };

  /**
   * Flushes one key's pending batch.
   *
   * FIFO ACROSS BATCHES: the next batch's `commit` is chained onto this one, because an append-only
   * transcript whose batches raced would be ordered by whichever `write(2)` won.
   */
  let tail: Promise<void> = Promise.resolve();
  const flush = (key: SessionKey): Promise<void> => {
    const id = keyOf(key);
    const batch = batches.get(id);
    if (batch === undefined) return Promise.resolve();
    batches.delete(id);
    if (batch.timer !== undefined) clearTimeout(batch.timer);
    tail = tail.then(() => commit(key, batch.entries)).then(() => batch.resolve());
    return batch.done;
  };

  const enqueue = (key: SessionKey, entries: SessionStoreEntry[]): void => {
    const id = keyOf(key);
    let batch = batches.get(id);
    if (batch === undefined) {
      let resolve!: () => void;
      const done = new Promise<void>((r) => {
        resolve = r;
      });
      batch = { key, entries: [], timer: undefined, done, resolve };
      batches.set(id, batch);
      batch.timer = setTimeout(() => void flush(key), policy.batchWindowMs);
      // A pending batch must not hold a process open: the window is a coalescing convenience, and
      // `settle()` is what a caller uses when it needs the bytes to be down.
      batch.timer.unref?.();
    }
    batch.entries.push(...entries);
  };

  const settle = async (key?: SessionKey): Promise<SettleReport> => {
    if (key === undefined) {
      // Every pending batch, then the whole chain — over a SNAPSHOT of the batches, because flushing
      // mutates the map.
      for (const batch of [...batches.values()]) await flush(batch.key);
      await tail;
      const errors = [...sessions.values()].flatMap((state) => state.errors);
      return {
        settled: batches.size === 0,
        batchesCommitted: [...sessions.values()].reduce((sum, state) => sum + state.batchesCommitted, 0),
        errors,
        transcriptHealth: [...sessions.values()].some((state) => state.health === "repair-required") ? "repair-required" : "ok",
      };
    }
    // A session's OWN pending work includes its subkeys: a subagent append is part of the same
    // session's tail, and WS-05 §12 step 3 drains the session, not one file of it.
    const session = sessionOf(key);
    for (const batch of [...batches.values()]) {
      if (sessionOf(batch.key) !== session) continue;
      await flush(batch.key);
    }
    await tail;
    const state = stateFor(key);
    return { settled: true, batchesCommitted: state.batchesCommitted, errors: [...state.errors], transcriptHealth: state.health };
  };

  /**
   * The facade.
   *
   * READS SETTLE FIRST. `append()` returning before the bytes are down is what makes step 3's barrier
   * meaningful — but it would also make `load()` lie to anything that wrote and then read. Every read
   * and the delete transaction flush the session's own pending work first, so the facade is
   * read-your-writes consistent while still batching.
   */
  const store: SessionStore = {
    async append(key, entries) {
      if (entries.length === 0) return; // the concrete store's own true-no-op contract, preserved
      stateFor(key).appendsReceived += 1;
      // WS-13 §8.2: a decoration lives ONLY in the materialized copy. This is the one gate every
      // write to the canonical store passes through — the destination runtime's mirrored turns AND
      // the reconciler's suffix appends — so "the canonical file stays byte-pure" is enforced once.
      const stripped = stripDecorations(key, entries, decorations);
      if (stripped.entries.length === 0) return;
      enqueue(key, stripped.entries);
    },
    async load(key) {
      await settle(key);
      return canonical.load(key);
    },
    async listSessions(projectKey) {
      await settle();
      return canonical.listSessions(projectKey);
    },
    async listSessionSummaries(projectKey) {
      await settle();
      return canonical.listSessionSummaries(projectKey);
    },
    async delete(key) {
      await settle(key);
      return canonical.delete(key);
    },
    async listSubkeys(key) {
      await settle({ projectKey: key.projectKey, sessionId: key.sessionId });
      return canonical.listSubkeys(key);
    },
  };

  return {
    store,
    canonical,
    identity,
    policy,
    settle,
    health(key) {
      const state = stateFor(key);
      return { transcriptHealth: state.health, errors: [...state.errors], batchesCommitted: state.batchesCommitted, appendsReceived: state.appendsReceived };
    },
    markReconciled(key, detail) {
      const state = stateFor(key);
      state.health = "ok";
      state.errors = [];
      void detail; // the reason is the caller's to record durably; this object holds no history
    },
    attach(options) {
      assertStoreCompatibleOptions(options);
      return { ...options, sessionStore: store };
    },
    assertImportAllowed(key) {
      const state = stateFor(key);
      if (state.health !== "ok") {
        throw new BlindStoreImportError(key, `the mirror recorded ${state.errors.length} failure(s) for this session`);
      }
    },
    decorations,
  };
}

/**
 * The peer's own version identity, for the shared identity record.
 *
 * BEST EFFORT AND NEVER FATAL: `assertVersionMatrix` is the gate that refuses an unsupported peer, and
 * it has already run by the time anything builds a store. This is a label, so an unlabelled peer gets
 * the honest string rather than a throw.
 */
function readPeerVersion(peers: RuntimeSdkPeers): string {
  const winter = peers.winter as unknown as { SDK_VERSION?: unknown; VERSION?: unknown };
  if (typeof winter.SDK_VERSION === "string") return winter.SDK_VERSION;
  if (typeof winter.VERSION === "string") return winter.VERSION;
  return "unknown";
}
