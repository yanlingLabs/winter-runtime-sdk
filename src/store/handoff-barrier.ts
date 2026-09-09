// THE HANDOFF BARRIER (WS-05 §12) — the eight steps, and the three ways they can end.
//
// "Exactly one runtime owns a compatibility session at a time." Everything here is in service of that
// one sentence, and of the one that closes §12: "Any unprovable step → keep the source owner, offer a
// visibly lossy fork; never label the fallback perfect resume."
//
// SO THERE ARE EXACTLY THREE OUTCOMES, and which one you get is a fact about which step stopped:
//
//   * `resumed`      — all eight steps proved out; the destination owns the session.
//   * `blocked`      — step 4's own vocabulary: the canonical store disagrees with the recorded
//                      local-write root (`repair-required`), the mirror failed and cannot be
//                      reconciled (`mirror-error`), or another live process holds the session
//                      (`lease-held`). The SOURCE KEEPS THE SESSION; nothing was moved.
//   * `lossy-fork-offered` — a step could not be PROVEN (the drain never reached an idle boundary, the
//                      JSONL does not validate, the destination never confirmed init). The outcome
//                      names the step, because "step 8: the destination never confirmed the same
//                      session and level" is actionable and "handoff failed" is not.
//
// THE COMMIT POINT IS THE PRODUCER RECORD, and it is one write. §12 step 6 asks for "the new
// dialect/producer record + projection cursor + source-generation completion" to be persisted
// ATOMICALLY, across what are physically two stores (the transcript's summary sidecar and the host's
// runtime directory). There is no distributed transaction available, so the barrier does not pretend
// to have one: all three facts go into ONE `append()` of a `winter_dialect_record`, which the concrete
// store folds into `<sessionId>.summary.json` with a single write-temp-and-rename. The directory
// store's copy is written AFTER, as a derived cache — a crash between them leaves the transcript's own
// record authoritative, which is exactly the direction WS-05 §5.4 and WS-16 §4 already point.
//
// WHAT THIS FILE DOES NOT DO: ask the user anything. R-7b-3 splits WS-13 §8.2 — the router owns the
// MECHANICS and the Claude-leg injection; "switch UX/confirmations" stay with the host (Phase 8,
// D19c). `plan()` produces something a host can render and confirm; `execute()` acts on the plan it is
// given.
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { DIALECT_RECORD_ENTRY_TYPE, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkError } from "../errors.ts";
import type { SeamContextWithDirectory } from "../seams/context.ts";
import type { RuntimeDirectoryEntry } from "../seams/directory-store.ts";
import type { HandoffBarrier, HandoffOutcome, HandoffPlan, HandoffStep, HandoffStepNumber } from "../seams/handoff.ts";
import type { MaterializedResumeDoor } from "../seams/materialized-resume.ts";
import type { SerializedRuntimeAddress } from "../seams/messaging-contract.ts";
import type { RuntimeKind, RuntimeSelection } from "../selection/runtime-selection.ts";
import { createMaterializedResumeDecorator, materializedTranscriptPath, resumeStagingRoot, type MaterializedResumeDecoratorHandle } from "./materialized-resume.ts";
import { canonicalTranscriptPath, reconcileLocalWriteRoot, compareTranscriptTail } from "./reconcile.ts";
import { materializeTempContinuity, resolveEngineTempLayout, tempContinuityModeFor, type EngineTempLayout } from "./temp-continuity.ts";
import { lazySharedSessionStore, type SharedSessionStore } from "./wiring.ts";

/** WS-05 §5.4's advertised levels. "Never silently downgrade an advertised level." */
export type CompatibilityLevel = "conversation" | "agent-state" | "full-filesystem";

const LEVEL_ORDER: CompatibilityLevel[] = ["conversation", "agent-state", "full-filesystem"];

/** WS-05 §12's eight steps, named once so a plan, an outcome and a test all read the same words. */
export const HANDOFF_STEPS: ReadonlyArray<{ step: HandoffStepNumber; name: string }> = [
  { step: 1, name: "acquire the handoff lease; stop new turns and peer messages" },
  { step: 2, name: "drain the active turn to an idle terminal boundary; classify every background effect" },
  { step: 3, name: "drain the SDK stream through its terminal result; wait for every append() to settle" },
  { step: 4, name: "compare the canonical tail against the recorded local-write root" },
  { step: 5, name: "validate JSONL framing, uuids, the parent chain, tool pairing, compaction and subkeys" },
  { step: 6, name: "close the owner; persist the producer record, cursor and generation; transfer the writer lease" },
  { step: 7, name: "materialize temp continuity (destination Winter adopts; destination Claude clone-copies)" },
  { step: 8, name: "resume the same backend uuid and project key; hold the next user message until init confirms" },
];

/**
 * A step's own answer. `ok: false` is "not proven", which is what makes a fork the honest offer.
 *
 * `producer` is step 8's only extra: WS-05 §5.4's `producerSdkVersion`/`producerEngineVersion` describe
 * the runtime that will WRITE the session from now on, and only that runtime knows them (review r2,
 * F11). A destination that does not report them leaves the fields OUT of the record, which is the one
 * honest alternative — the first version wrote the SOURCE's versions under the destination's name.
 */
export type HandoffStepReport =
  | { ok: true; detail?: string; producer?: { sdkVersion?: string; engineVersion?: string } }
  | { ok: false; reason: string };

/** Structurally Lane A's `OfficialSessionHealth` (`src/official/adapter.ts`), never imported from it. */
export interface HandoffOwnerHealth {
  launchedThroughProxy: boolean;
  recordedLocalWriteRoot?: string;
  transcriptHealth: "ok" | "repair-required";
}

/** Structurally Lane A's `HandoffEligibility` — its `officialHandoffEligibility()` produces one. */
export type HandoffEligibilityLike = { eligible: true } | { eligible: false; reason: string; detail: string };

/**
 * The live runtime that owns the session today.
 *
 * EVERY MEMBER IS OPTIONAL EXCEPT THE THREE DRAINS, and an ABSENT owner is a supported case: an exited
 * session has nothing to drain and nothing to close, which is a cold handoff rather than a failure. What
 * an absent owner cannot do is REPORT — so a session with no owner also has no recorded local-write root,
 * and step 4 falls back to comparing the canonical file against itself (see `compareAgainstLocalRoot`).
 */
export interface HandoffSourceOwner {
  readonly runtimeKind: RuntimeKind;
  /** WS-14 §5/§6's session health. */
  health?(): HandoffOwnerHealth | Promise<HandoffOwnerHealth>;
  /** Lane A's `officialHandoffEligibility(health)`, when the owner is an official session. */
  eligibility?(): HandoffEligibilityLike | Promise<HandoffEligibilityLike>;
  /** §12 step 1's second half. */
  stopNewTurns?(): void | Promise<void>;
  /** §12 step 2. */
  drainToIdleBoundary(): HandoffStepReport | Promise<HandoffStepReport>;
  /** §12 step 3's SDK-stream half; the append barrier is the store's. */
  drainStream(): HandoffStepReport | Promise<HandoffStepReport>;
  /** §12 step 6's "close the owner gracefully". */
  close(): HandoffStepReport | void | Promise<HandoffStepReport | void>;
  /** `RuntimeSessionRecord.effectiveTempDir` as the source recorded it (WS-16 §4). */
  readonly effectiveTempDir?: string;
}

/** What step 8 hands the destination runtime. */
export interface HandoffResumeTarget {
  address?: SerializedRuntimeAddress;
  runtimeKind: RuntimeKind;
  /** §12 step 8: "resume the SAME backend UUID and project key". */
  backendSessionId: string;
  projectKey: string;
  /** §12 step 8: init must confirm the same session AND level. */
  compatibilityLevel: CompatibilityLevel;
  /** The transcript the destination reads: the materialized copy, or the canonical file. */
  resumePath: string;
  /**
   * The `<tmpdir>/claude-resume-<uuid>` root a `store-backed-resume` launch needs — it IS that
   * generation's `CLAUDE_CONFIG_DIR` (WS-14 §1). Present for a `claude-agent` destination, absent for
   * a Winter one, which reads the canonical store directly.
   */
  stagingRoot?: string;
  /** WS-14 §1's two launch profiles, as the destination's own plan will declare it. */
  profile?: "fresh-spool" | "store-backed-resume";
  /** WS-05 §9.1's post-handoff `effectiveTempDir`. */
  effectiveTempDir: string;
  door: MaterializedResumeDoor;
  selection: RuntimeSelection;
}

/** The runtime that will own the session after the barrier. */
export interface HandoffDestinationRuntime {
  readonly runtimeKind: RuntimeKind;
  /** §12 step 8. `ok: false` keeps the source owner and offers the fork. */
  confirmInit(target: HandoffResumeTarget): HandoffStepReport | Promise<HandoffStepReport>;
}

/** Who is on each end. Both are optional; see `HandoffSourceOwner` and step 8's default. */
export interface HandoffParticipants {
  source?(session: SessionKey, from: RuntimeKind): Promise<HandoffSourceOwner | undefined> | HandoffSourceOwner | undefined;
  destination?(session: SessionKey, to: RuntimeKind): Promise<HandoffDestinationRuntime | undefined> | HandoffDestinationRuntime | undefined;
}

/** A `plan()` that cannot be built at all — the session is unknown, so nothing about it can be planned. */
export class HandoffPlanError extends RuntimeSdkError {
  constructor(session: SessionKey, reason: string) {
    super(`winter-runtime-sdk: no handoff can be planned for ${session.projectKey}/${session.sessionId} — ${reason}`);
  }
}

/** The outcome, widened with the detail the pinned union has no room for. Assignable to it. */
export type DetailedHandoffOutcome = HandoffOutcome & {
  /** The step the barrier reached. Present on every arm, including `resumed` (always 8). */
  step: HandoffStepNumber;
  detail: string;
  /** Everything step 8 handed the destination — a host renders the resume from this. */
  target?: HandoffResumeTarget;
  steps: Array<{ step: HandoffStepNumber; name: string; ok: boolean; detail: string }>;
};

export interface HandoffBarrierDeps {
  /** The one shared store. Built lazily from the peer + `winterHome` when a host does not pass one. */
  shared?: SharedSessionStore;
  /** Defaults to the peer's own `resolveWinterHome()` — the production answer, resolved at first use. */
  winterHome?: string;
  /**
   * A decorator to use instead of the barrier's own.
   *
   * IT MUST BE OVER THE SAME STORE, and the barrier checks (review r1, F2) rather than trusting: two
   * stores over one home means two decoration registries, and a decoration registered in one washes
   * back through the other's canonical append gate. A host wiring both seams should take
   * `barrier.decorator` instead of building a second one.
   */
  decorator?: MaterializedResumeDecoratorHandle;
  participants?: HandoffParticipants;
  /** Where the handoff leases live. Defaults to `<winterHome>/runtimes/handoff-leases`. */
  leaseRoot?: string;
  /** Overrides the staging root a `claude-agent` destination resumes from (tests point it at a tmpdir). */
  stagingRootFor?: (uuid: string) => string;
  /** The temp layout for a session. Defaults to D18's derivation from the resolved brand. */
  tempLayoutFor?: (entry: RuntimeDirectoryEntry, session: SessionKey) => EngineTempLayout;
  /** The handoff note's text. The host owns the wording; this is the default. */
  noteText?: (args: { from: RuntimeKind; to: RuntimeKind; session: SessionKey }) => string;
  now?: () => Date;
}

export interface HandoffBarrierHandle extends HandoffBarrier {
  execute(plan: HandoffPlan): Promise<DetailedHandoffOutcome>;
  /** The shared store this barrier writes through — the same object both branches were given. */
  readonly shared: SharedSessionStore;
  /** The decorator, over that same store. The spine wires `decorator: barrier.decorator`. */
  readonly decorator: MaterializedResumeDecoratorHandle;
}

/** A barrier and a decorator that do not share one store — a wiring mistake, refused rather than run. */
export class HandoffWiringError extends RuntimeSdkError {
  constructor(reason: string) {
    super(`winter-runtime-sdk: this handoff barrier is mis-wired — ${reason}`);
  }
}

/**
 * WS-05 §12's mechanics. Lane C's implementation of the spine's seam.
 *
 * THE DIRECTORY IS READ THROUGH THE STORE SEAM, not through `context.directory`. Both are the same
 * data; the difference is that `RuntimeDirectoryStore` is implemented (the spine ships an in-memory
 * default) while `RuntimeDirectory` is Lane B's policy layer over it. A barrier that reached for the
 * policy layer would be unable to run until another lane landed, for no gain: everything the barrier
 * needs is a record, not a resolution.
 */
export function createHandoffBarrier(context: SeamContextWithDirectory, deps: HandoffBarrierDeps = {}): HandoffBarrierHandle {
  const now = deps.now ?? (() => new Date());
  // EVERYTHING THE STORE TOUCHES IS RESOLVED ON FIRST USE. The spine's wiring line calls this factory
  // for every `createRuntimeSdk`, most of which never hand a session off and some of which (every
  // `test/spine/*` case) inject a peer with no store class at all. See `lazySharedSessionStore`.
  const sharedOf = deps.shared === undefined ? lazySharedSessionStore({ peers: context.peers, brand: context.brand, ...(deps.winterHome === undefined ? {} : { winterHome: deps.winterHome }) }) : () => deps.shared!;
  const homeOf = (): string => deps.winterHome ?? sharedOf().identity.winterHome;
  let decorator: MaterializedResumeDecoratorHandle | undefined = deps.decorator as MaterializedResumeDecoratorHandle | undefined;
  /**
   * ONE store for the barrier AND the decorator (review r1, F2).
   *
   * The wiring that was owed to the spine built them independently, each resolving its own store over
   * the same home — two 100 ms batch queues interleaving appends into one file, and, worse, TWO
   * decoration registries: a decoration registered in the decorator's was invisible to the canonical
   * append gate, which consulted the barrier's, and washed straight back into the byte-pure file.
   * So the barrier BUILDS the decorator by default, and REFUSES an injected one that does not report
   * the same store instance. The property is checked, not documented.
   */
  const decoratorOf = (): MaterializedResumeDecoratorHandle => {
    if (decorator === undefined) decorator = createMaterializedResumeDecorator(context, { shared: sharedOf, now });
    return decorator;
  };

  /**
   * The F2 identity check, moved OFF the accessor (review r2, N1).
   *
   * The first version read the decorator's `shared` getter inside `decoratorOf()`, and that getter
   * RESOLVES the store — so `barrier.decorator`, the one expression the spine's wiring line evaluates,
   * threw `SharedStoreUnavailableError` for every peer without a resolvable store: the spine's fake
   * peer, this lane's own hermetic bed, and the `seams.test.ts` block the report prescribes. The check
   * that existed to make one store structural destroyed the laziness the same fix depends on.
   *
   * So: the barrier's OWN decorator needs no check at all — it is constructed with `sharedOf` — and an
   * INJECTED one is checked here, from `plan()`/`execute()`, after `loadEntry` has already resolved the
   * store for its own reasons. Nothing about `barrier.decorator` touches a store any more.
   */
  const assertOneDecoratorStore = (): void => {
    if (deps.decorator === undefined) return;
    const theirs = (deps.decorator as { shared?: SharedSessionStore }).shared;
    if (theirs === undefined) {
      throw new HandoffWiringError(
        "the injected decorator does not report the store it writes into, so the barrier cannot prove the two share one; pass `barrier.decorator`, or a decorator built by `createMaterializedResumeDecorator`",
      );
    }
    if (theirs !== sharedOf()) {
      throw new HandoffWiringError(
        "the decorator was built over a DIFFERENT session store than the barrier's; two stores over one home means two decoration registries, and a decoration registered in one washes back through the other (WS-05 §6, WS-13 §8.2)",
      );
    }
  };

  const leaseRootOf = (): string => deps.leaseRoot ?? join(homeOf(), "runtimes", "handoff-leases");
  const stagingRootFor = deps.stagingRootFor ?? ((uuid: string) => resumeStagingRoot(uuid));

  const findEntry = async (session: SessionKey): Promise<RuntimeDirectoryEntry> => {
    const entries = await context.directoryStore.load();
    const match =
      entries.find((entry) => entry.backendSessionId === session.sessionId) ??
      entries.find((entry) => entry.parsed.winterSessionId === session.sessionId);
    if (match === undefined) {
      throw new HandoffPlanError(session, "it is not in the runtime directory, so there is no record of which runtime owns it or which backend session it is");
    }
    return match;
  };

  /**
   * Reads the entry AND repairs an interrupted handoff (review r1, F1).
   *
   * The barrier's commit is two writes that cannot be one: the transcript's producer record (atomic,
   * in the summary sidecar) and the host directory's derived copy. A crash between them used to leave
   * them disagreeing forever. Now the state before the flip is marked with a `pendingHandoff` record,
   * so the next `plan()` can tell the two cases apart:
   *
   *   * a pendingHandoff is present -> the flip never happened. The SOURCE still owns the session; the
   *     marker is cleared and nothing moves.
   *   * no marker, but the producer record and the directory disagree -> the flip's first write landed
   *     and its second did not. The transcript's own record is authoritative (WS-05 §5.4, WS-16 §4),
   *     so the directory is repaired to match it.
   */
  const loadEntry = async (session: SessionKey): Promise<RuntimeDirectoryEntry> => {
    const entry = await findEntry(session);
    const shared = sharedOf();
    const summary = await shared.canonical.readSessionSummary({ projectKey: session.projectKey, sessionId: session.sessionId });
    if (summary === null) return entry;
    const pending = summary["pendingHandoff"];
    if (typeof pending === "object" && pending !== null) {
      // A LIVE HOLDER'S MARKER IS LEFT ALONE (review r2, N6). `plan()` is a read the host renders, and
      // clearing another barrier's in-flight marker would destroy the one record that makes a crash
      // inside the flip recoverable. Only a marker whose holder is GONE is a leftover to clean up —
      // the same liveness rule the handoff lease itself uses.
      const holder = (pending as { pid?: unknown }).pid;
      if (typeof holder === "number" && isPidAlive(holder)) return entry;
      await shared.store.append(session, [{ type: DIALECT_RECORD_ENTRY_TYPE, pendingHandoff: null }]);
      await shared.settle(session);
      return entry;
    }
    const producer = summary["producerRuntime"];
    if ((producer === "claude-agent" || producer === "winter-agent") && producer !== entry.runtimeKind) {
      const repaired: RuntimeDirectoryEntry = { ...entry, runtimeKind: producer, generation: entry.generation + 1, updatedAt: now().toISOString() };
      // THE REPAIR IS BEST-EFFORT, AND THE RETURNED ENTRY IS CORRECT EITHER WAY (review r2, N2.3). A
      // directory that refuses the write used to propagate a raw host error out of every future
      // `plan()`, which made the session permanently unplannable — a worse outcome than a stale cache.
      // The transcript's record is authoritative, so the entry returned reflects it; persisting is
      // retried on the next call.
      try {
        await context.directoryStore.upsert(repaired);
        const cursor = summary["projectionCursor"];
        if (typeof cursor === "string" && cursor.length > 0) await context.directoryStore.cursors.set(entry.address, cursor);
      } catch {
        /* the cache stays behind; the authoritative record is what this returns */
      }
      return repaired;
    }
    return entry;
  };

  /** The `knownUnprovable` markers, computed from CURRENT state — `plan()` renders them, `execute()` obeys them. */
  const markersFor = (args: { entry: RuntimeDirectoryEntry; to: RuntimeKind; health?: HandoffOwnerHealth; session: SessionKey }): Map<HandoffStepNumber, string> => {
    const markers = new Map<HandoffStepNumber, string>();
    if (args.entry.runtimeKind === args.to) {
      markers.set(1, `the session is already owned by ${args.to}; a handoff to the same runtime moves nothing`);
    }
    // BOTH health sources (review r1, F8). The owner reports its own; the shared store records the
    // mirror failures the owner never hears about. A plan that consulted only the first told a host
    // that step 4 was fine while the store already held a `repair-required` flag for the session.
    // `sharedOf()`, not `deps.shared` (review r2, F8). The WIRED shape never sets `deps.shared`, so the
    // gate that was supposed to make this fix production-safe was exactly what made it inert in
    // production. `loadEntry` has already resolved the store before any caller reaches this.
    const storeHealth = sharedOf().health(args.session);
    const unhealthy = args.health?.transcriptHealth === "repair-required" || storeHealth.transcriptHealth === "repair-required";
    if (unhealthy) {
      markers.set(
        4,
        args.health?.recordedLocalWriteRoot === undefined
          ? "the mirror is unhealthy and no local-write root was recorded, so there is nothing to reconcile the canonical store against"
          : `the mirror is unhealthy; the canonical store must be reconciled against ${args.health.recordedLocalWriteRoot} first`,
      );
    }
    if (deps.participants?.destination === undefined) {
      markers.set(8, "no destination runtime was supplied, so nothing can confirm the resumed session and level");
    }
    return markers;
  };

  const plan = async (session: SessionKey, to: RuntimeKind): Promise<HandoffPlan> => {
    const entry = await loadEntry(session);
    assertOneDecoratorStore();
    const from = entry.runtimeKind;
    const owner = (await deps.participants?.source?.(session, from)) ?? undefined;
    const health = owner?.health === undefined ? undefined : await owner.health();
    const markers = markersFor({ entry, to, session, ...(health === undefined ? {} : { health }) });
    const steps: HandoffStep[] = HANDOFF_STEPS.map(({ step, name }) => {
      const knownUnprovable = markers.get(step);
      return knownUnprovable === undefined ? { step, name } : { step, name, knownUnprovable };
    });
    return {
      session,
      from,
      to,
      steps,
      decorationDoor: decoratorOf().door,
      tempContinuity: tempContinuityModeFor(to),
    };
  };

  const execute = async (plan: HandoffPlan): Promise<DetailedHandoffOutcome> => {
    const trail: DetailedHandoffOutcome["steps"] = [];
    const record = (step: HandoffStepNumber, ok: boolean, detail: string): void => {
      trail.push({ step, name: HANDOFF_STEPS[step - 1]!.name, ok, detail });
    };
    const lossy = (step: HandoffStepNumber, reason: string): DetailedHandoffOutcome => {
      record(step, false, reason);
      return { kind: "lossy-fork-offered", reason, step, detail: reason, steps: trail };
    };
    const blocked = (step: HandoffStepNumber, reason: "repair-required" | "mirror-error" | "lease-held", detail: string): DetailedHandoffOutcome => {
      record(step, false, detail);
      return { kind: "blocked", reason, step, detail, steps: trail };
    };

    const session = plan.session;
    const shared = sharedOf();
    const winterHome = homeOf();
    const entry = await loadEntry(session);

    // A STALE PLAN IS NOT EXECUTED (review r1, F9). Between `plan()` and `execute()` the session can
    // change hands — a plan built when Winter owned it would otherwise run its whole eight steps
    // against a record that has since moved, and report `resumed` for a transfer that never applied.
    if (entry.runtimeKind !== plan.from) {
      return lossy(1, `this plan was built when ${plan.from} owned the session and ${entry.runtimeKind} owns it now; re-plan against the current owner`);
    }

    const owner = (await deps.participants?.source?.(session, plan.from)) ?? undefined;
    const healthNow = owner?.health === undefined ? undefined : await owner.health();

    // PLAN AND EXECUTE AGREE BY CONSTRUCTION (review r1, F7). A step the plan already knows cannot be
    // proven is refused here rather than run: `execute()` used to ignore the markers entirely and
    // drive a same-runtime "handoff" to `resumed`, bumping the generation and rewriting the producer
    // record for a transfer that moved nothing.
    //
    // STEP 4 IS THE ONE EXCEPTION, and it is not a loophole: its own logic below reaches the SAME
    // refusal with the specific vocabulary WS-05 §12 gives it (`blocked: repair-required` /
    // `mirror-error`), and collapsing that into a fork would lose the one distinction a host acts on.
    const markers = new Map([...markersFor({ entry, to: plan.to, session, ...(healthNow === undefined ? {} : { health: healthNow }) })]);
    for (const step of plan.steps) {
      if (step.knownUnprovable !== undefined) markers.set(step.step, step.knownUnprovable);
    }
    for (const [step, reason] of [...markers.entries()].sort((a, b) => a[0] - b[0])) {
      if (step === 4) continue;
      return lossy(step, reason);
    }

    let lease: HandoffLease;
    try {
      lease = acquireHandoffLease(leaseRootOf(), session);
    } catch (error) {
      return blocked(1, "lease-held", error instanceof Error ? error.message : String(error));
    }
    let stagedRoot: string | undefined;
    let pendingWritten = false;
    /** True once the producer record has landed: from that instant the handoff IS committed. */
    let committed = false;
    /** The step `execute()` is inside, so an unexpected throw is still attributed (review r2, N3). */
    let at: HandoffStepNumber = 1;

    /**
     * Everything step 6's pending mark left behind, undone — and NOTHING ELSE.
     *
     * IT NEVER THROWS: it runs on the failure path, and a failure inside the cleanup of a failure would
     * replace an outcome the host can act on with an exception it cannot.
     *
     * IT NEVER DELETES A CONFIRMED DESTINATION'S STAGING ROOT (review r2, N2.2). The barrier hands the
     * root to `confirmInit` itself, so a destination that answered `ok` is by definition reading it;
     * `stagedRoot` is cleared the instant that happens, and a copy leaked by a later failure is the
     * right outcome.
     */
    const unwind = async (): Promise<void> => {
      try {
        if (pendingWritten) {
          await shared.store.append(session, [{ type: DIALECT_RECORD_ENTRY_TYPE, pendingHandoff: null }]);
          await shared.settle(session);
          pendingWritten = false;
        }
        if (stagedRoot !== undefined) {
          rmSync(stagedRoot, { recursive: true, force: true });
          stagedRoot = undefined;
        }
      } catch {
        /* the marker self-heals on the next plan(); a leaked copy is inert once its root is gone */
      }
    };

    try {
      await owner?.stopNewTurns?.();
      record(1, true, "the handoff lease is held by this process and the source is not taking new turns");

      // ---- step 2: drain to an idle terminal boundary ------------------------------------------------
      at = 2;
      const drained = owner === undefined ? ({ ok: true, detail: "there is no live owner to drain" } as HandoffStepReport) : await owner.drainToIdleBoundary();
      if (!drained.ok) return lossy(2, drained.reason);
      record(2, true, drained.detail ?? "the active turn reached an idle terminal boundary");

      // ---- step 3: the SDK stream, then the host-side pending append barrier -------------------------
      at = 3;
      const streamed = owner === undefined ? ({ ok: true, detail: "there is no live stream to drain" } as HandoffStepReport) : await owner.drainStream();
      if (!streamed.ok) return lossy(3, streamed.reason);
      const settled = await shared.settle(session);
      if (!settled.settled) return lossy(3, "the pending append barrier did not settle, so the canonical tail is still moving");
      record(3, true, `${streamed.detail ?? "the stream reached its terminal result"}; ${settled.batchesCommitted} canonical append batch(es) settled`);

      // ---- step 4: canonical tail vs the recorded local-write root -----------------------------------
      at = 4;
      const eligibility = owner?.eligibility === undefined ? undefined : await owner.eligibility();
      if (eligibility !== undefined && !eligibility.eligible) {
        // Lane A's `officialHandoffEligibility` answers this for an official session. Its three reasons
        // map onto §12's own vocabulary: a mirror failure the barrier cannot locate a root for is a
        // `mirror-error`; a locatable one is `repair-required` — the difference is whether reconciling
        // is even possible, which is the only thing a host can act on differently.
        const reason = eligibility.reason === "default-spawn-mirror-error" ? "mirror-error" : "repair-required";
        return blocked(4, reason, eligibility.detail);
      }
      const localRoot = healthNow?.recordedLocalWriteRoot;
      const comparison = await compareAgainstLocalRoot({ shared, session, localRoot });
      if (comparison.kind === "canonical-behind") {
        // §12 step 4: "reconcile while state still exists". A LAG IS NOT A MISMATCH — the mirror is
        // asynchronous by construction, so the barrier repairs it here rather than refusing a handoff
        // for the ordinary case.
        const report = await reconcileLocalWriteRoot(localRoot!, { shared, only: { projectKey: session.projectKey, sessionId: session.sessionId } });
        // THE REPAIR IS VERIFIED, NOT ASSUMED (review r2, N4). The comparison addresses the transcript
        // by path; the repair used to reach it through a SCAN, and a scan that found nothing reported
        // `nothing-to-do` — which is not `diverged`, so the barrier said "reconciled" and completed a
        // handoff that silently dropped the tail the source had written.
        if (report.status === "diverged" || report.appended !== comparison.missing.length) {
          return blocked(
            4,
            "repair-required",
            `the canonical store could not be reconciled against ${localRoot}: ${comparison.missing.length} entr(y|ies) were missing and ${report.appended} landed (${report.status})`,
          );
        }
        record(4, true, `the canonical tail was ${comparison.missing.length} entr(y|ies) behind the recorded local-write root and has been reconciled`);
      } else if (comparison.kind === "diverged" || comparison.kind === "canonical-ahead") {
        return blocked(4, "repair-required", comparison.reason);
      } else {
        record(4, true, comparison.reason);
      }
      const storeHealth = shared.health(session);
      if (storeHealth.transcriptHealth !== "ok") {
        const cause = storeHealth.errors[storeHealth.errors.length - 1];
        return blocked(4, "mirror-error", `the mirror recorded ${storeHealth.errors.length} failure(s) for this session${cause === undefined ? "" : ` (last: ${cause.cause})`}, and it is not reconciled`);
      }

      // ---- step 5: validate the JSONL -----------------------------------------------------------------
      at = 5;
      const validation = await validateSessionTranscript(shared, session, winterHome);
      if (!validation.ok) return lossy(5, validation.reason);
      record(5, true, validation.detail);

      // ---- step 6: close the owner, and MARK the handoff as pending ------------------------------------
      //
      // OWNERSHIP DOES NOT MOVE HERE (review r1, F1). The first version persisted the producer record,
      // the cursor and the directory entry at step 6 — so every failure at 7 or 8 returned
      // `lossy-fork-offered`, whose pinned meaning is "KEEP THE SOURCE OWNER", while the persisted
      // state already named a destination that never started. What lands here is a marker; the
      // producer record is written at the end of step 8.
      at = 6;
      const closed = (await owner?.close()) ?? undefined;
      if (closed !== undefined && closed.ok === false) return lossy(6, closed.reason);
      const level = raiseLevel(await currentLevel(shared, session), entry);
      let staged: PendingCommit;
      // SET BEFORE THE CALL (review r2, nit 1): a throw from inside `markHandoffPending` — after its
      // append, from its own `settle()` — would otherwise leave a marker `unwind()` does not know about.
      // Clearing a marker that was never written is a no-op fold, which is the cheap side of the trade.
      pendingWritten = true;
      try {
        staged = await markHandoffPending({ shared, session, entry, plan, level, now: now() });
      } catch (error) {
        await unwind();
        if (isLeaseError(error)) return blocked(6, "lease-held", (error as Error).message);
        return lossy(6, `the handoff could not be staged: ${error instanceof Error ? error.message : String(error)}`);
      }
      record(6, true, `the owner is closed, the writer lease is this process's, and a pending handoff to ${plan.to} at level ${level} is recorded — ownership has NOT moved`);

      // ---- step 7: temp continuity ---------------------------------------------------------------------
      at = 7;
      let continuity;
      try {
        const layout = (deps.tempLayoutFor ?? defaultTempLayout(context))(entry, session);
        continuity = materializeTempContinuity({
          to: plan.to,
          layout,
          ...(owner?.effectiveTempDir === undefined ? {} : { recordedTempDir: owner.effectiveTempDir }),
        });
      } catch (error) {
        await unwind();
        return lossy(7, `temp continuity could not be materialized: ${error instanceof Error ? error.message : String(error)}`);
      }
      record(
        7,
        true,
        `${continuity.mode}: the session's scratch is at ${continuity.effectiveTempDir}${continuity.supersededDir === undefined ? "" : `, superseding ${continuity.supersededDir} (retained)`}`,
      );

      // ---- step 8: stage, confirm, and only THEN commit --------------------------------------------------
      at = 8;
      const stagingRoot = plan.to === "claude-agent" ? stagingRootFor(staged.stagingUuid) : undefined;
      if (stagingRoot !== undefined) stagedRoot = stagingRoot;
      const decorated = await decoratorOf().decorate({
        session,
        to: plan.to,
        materializedPath: stagingRoot === undefined ? canonicalTranscriptPath(winterHome, session) : materializedTranscriptPath(stagingRoot, session),
        decoration: {
          kind: "handoff",
          from: plan.from,
          at: now().toISOString(),
          text: (deps.noteText ?? defaultNoteText)({ from: plan.from, to: plan.to, session }),
        },
      });
      const target: HandoffResumeTarget = {
        address: entry.address,
        runtimeKind: plan.to,
        backendSessionId: session.sessionId,
        projectKey: session.projectKey,
        compatibilityLevel: level,
        resumePath: decorated.resumePath,
        ...(stagingRoot === undefined ? {} : { stagingRoot, profile: "store-backed-resume" as const }),
        effectiveTempDir: continuity.effectiveTempDir,
        door: decorated.door,
        // The persisted selection, with the RUNTIME it is being handed to (review r2, nit 3: the target
        // used to say `runtimeKind: <source>` while the `resumed` outcome said `<destination>`). The
        // provider, model and auth family are NOT rewritten — WS-00 §2's D13 makes the persisted choice
        // authoritative, and deciding a session serves a different provider is the selector's business,
        // never the barrier's. A destination whose branch cannot serve this selection is the host's
        // question, asked before it calls `handoff()`.
        selection: { ...entry.selection, runtimeKind: plan.to },
      };
      const destination = (await deps.participants?.destination?.(session, plan.to)) ?? undefined;
      if (destination === undefined) {
        await unwind();
        return lossy(8, "no destination runtime confirmed the resumed session and level, and the next user message must not be delivered until one does");
      }
      const confirmed = await destination.confirmInit(target);
      if (!confirmed.ok) {
        await unwind();
        return lossy(8, confirmed.reason);
      }
      // THE COPY IS THE DESTINATION'S FROM THIS INSTANT (review r2, N2.2): it answered `ok` to a target
      // naming that root, so it is reading it. Nothing after this line may delete it.
      stagedRoot = undefined;

      // THE COMMIT, and it is the last act. Ownership moves only now — after a destination has
      // confirmed the same session and level. The producer record is the AUTHORITATIVE write (WS-05
      // §5.4); the directory's copy is a derived cache that follows it.
      try {
        await commitProducerRecord({ shared, session, staged, ...(confirmed.producer === undefined ? {} : { producer: confirmed.producer }) });
        committed = true;
        pendingWritten = false;
      } catch (error) {
        await unwind();
        return lossy(8, `the destination confirmed init but the producer record could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }

      // FROM HERE THE OUTCOME IS `resumed` WHATEVER FAILS (review r2, N2.1). The transcript's own record
      // already names the destination and a destination is already running on it; reporting
      // "the source kept the session" would be false, and the host would watch ownership move on its
      // next read. Each remaining write is best-effort and its failure is NAMED in the detail.
      const notes: string[] = [];
      try {
        await syncDirectoryEntry({ context, entry, plan, staged, now: now() });
      } catch (error) {
        notes.push(`the host directory's derived copy is behind and will be repaired on the next plan(): ${error instanceof Error ? error.message : String(error)}`);
      }
      // The FALLBACK note enters the canonical file HERE and nowhere else: §8.2's "sole case where
      // injected handoff content enters the canonical file", after the destination that will read it
      // has confirmed it started (review r1, F1/F2).
      if (decorated.note !== undefined) {
        try {
          await shared.store.append(session, [decorated.note]);
          await shared.settle(session);
        } catch (error) {
          notes.push(`the labelled handoff note could not be appended: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      record(8, true, confirmed.detail ?? `the destination confirmed ${session.sessionId} at level ${level}, and ownership moved`);

      return {
        kind: "resumed",
        selection: { ...entry.selection, runtimeKind: plan.to },
        step: 8,
        detail: `the session resumed on ${plan.to} at level ${level} through the ${decorated.door} decoration door${notes.length === 0 ? "" : ` — ${notes.join("; ")}`}`,
        target,
        steps: trail,
      };
    } catch (error) {
      // `execute()` HAS THREE ARMS AND NO FOURTH (review r2, N3). Four awaits used to be bare — the
      // staging-root factory, `decorate()`, the destination RESOLVER and the note's own append — so a
      // throw escaped as a raw error, skipped `unwind()` and left a marker and a staged copy behind.
      const detail = error instanceof Error ? error.message : String(error);
      if (committed) {
        // Past the producer record there is no honest way to say the source kept the session.
        return {
          kind: "resumed",
          selection: { ...entry.selection, runtimeKind: plan.to },
          step: 8,
          detail: `the session resumed on ${plan.to}, but the barrier failed afterwards: ${detail}`,
          steps: trail,
        };
      }
      await unwind();
      return lossy(at, `the barrier failed at step ${at}: ${detail}`);
    } finally {
      releaseHandoffLease(lease);
    }
  };

  return {
    plan,
    execute,
    get shared() {
      return sharedOf();
    },
    /**
     * The decorator this barrier uses — over the SAME store (review r1, F2).
     *
     * This accessor is the wiring: `src/sdk.ts` writes `decorator: barrier.decorator` rather than
     * building a second one, so one store, one registry and one door are structural instead of being
     * a rule someone has to remember.
     */
    get decorator() {
      return decoratorOf();
    },
  };
}

function defaultNoteText(args: { from: RuntimeKind; to: RuntimeKind; session: SessionKey }): string {
  return `This conversation continues on the ${args.to} runtime. It was produced up to this point by the ${args.from} runtime; the transcript above is unchanged.`;
}

/** D18's layout for a session, from the resolved brand and the entry's own keys. */
function defaultTempLayout(context: SeamContextWithDirectory): (entry: RuntimeDirectoryEntry, session: SessionKey) => EngineTempLayout {
  return (entry, session) =>
    resolveEngineTempLayout({
      brand: context.brand,
      // WS-05 §9: temp is keyed by `tempProjectKey` and the BACKEND uuid, never the product id.
      tempProjectKey: session.projectKey,
      backendUuid: entry.backendSessionId ?? session.sessionId,
    });
}

// --- step 4 -------------------------------------------------------------------------------------------

type LocalRootComparison =
  | { kind: "match"; reason: string }
  | { kind: "canonical-behind"; missing: unknown[]; reason: string }
  | { kind: "diverged"; reason: string }
  | { kind: "canonical-ahead"; reason: string };

/**
 * §12 step 4's comparison, including the case the spec's prose does not name: THERE IS NO LOCAL ROOT.
 *
 * A Winter-owned session writes the canonical file itself — the local write and the canonical write are
 * the same write — so there is nothing to compare it against and the step is vacuously satisfied. Saying
 * so explicitly is the point: a barrier that silently skipped step 4 for half its sessions would look
 * identical to one that ran it.
 */
async function compareAgainstLocalRoot(args: { shared: SharedSessionStore; session: SessionKey; localRoot: string | undefined }): Promise<LocalRootComparison> {
  if (args.localRoot === undefined) {
    return { kind: "match", reason: "the source writes the canonical transcript directly, so there is no separate local-write root to compare against" };
  }
  const localPath = join(args.localRoot, "projects", args.session.projectKey, `${args.session.sessionId}.jsonl`);
  if (!existsSync(localPath)) {
    return { kind: "match", reason: `the recorded local-write root holds no transcript for this session (${localPath}), so there is nothing it could disagree with` };
  }
  const entries = (await args.shared.store.load(args.session)) ?? [];
  const canonicalLines = entries.filter((entry) => entry["type"] !== "agent_metadata").map((entry) => JSON.stringify(entry));
  const comparison = compareTranscriptTail({ localPath, canonicalLines, isDecoration: (uuid) => args.shared.decorations.has(args.session, uuid) });
  switch (comparison.kind) {
    case "match":
      return { kind: "match", reason: `the canonical tail matches the recorded local-write root over all ${comparison.lines} entries` };
    case "canonical-behind":
      return { kind: "canonical-behind", missing: comparison.missing, reason: `the canonical tail is ${comparison.missing.length} entr(y|ies) behind ${localPath}` };
    case "diverged":
      return { kind: "diverged", reason: comparison.reason };
    case "canonical-ahead":
      return { kind: "canonical-ahead", reason: `the canonical store holds ${comparison.extra} entr(y|ies) the recorded local-write root does not, so they are not the same history` };
  }
}

// --- step 5 -------------------------------------------------------------------------------------------

export type TranscriptValidation = { ok: true; detail: string } | { ok: false; reason: string };

/**
 * §12 step 5: "validate JSONL framing, UUID uniqueness, parent-chain reachability, tool_use/result
 * pairing, compaction boundary, subkeys, declared adjacent stores".
 *
 * FRAMING IS CHECKED ON THE BYTES, everything else on what `load()` returns — because framing is the one
 * property `load()` REPAIRS (the concrete store quarantines a torn tail), so a check that ran only on the
 * loaded entries would report clean on a file it had just truncated.
 */
export async function validateSessionTranscript(shared: SharedSessionStore, session: SessionKey, winterHome: string): Promise<TranscriptValidation> {
  const path = canonicalTranscriptPath(winterHome, session);
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return { ok: false, reason: `there is no canonical transcript at ${path} to validate` };
  }
  if (raw.length > 0 && !raw.endsWith("\n")) return { ok: false, reason: "the canonical transcript's final line is unterminated (framing)" };
  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    try {
      JSON.parse(line);
    } catch {
      return { ok: false, reason: `line ${index + 1} of the canonical transcript is not valid JSON (framing)` };
    }
  }

  const entries = (await shared.store.load(session)) ?? [];
  const chain = validateChain(entries);
  if (!chain.ok) return chain;
  const pairing = validateToolPairing(entries);
  if (!pairing.ok) return pairing;
  const compaction = validateCompaction(entries);
  if (!compaction.ok) return compaction;

  const subkeys = await shared.canonical.listSubkeys({ projectKey: session.projectKey, sessionId: session.sessionId });
  for (const subpath of subkeys) {
    const child = await shared.store.load({ ...session, subpath });
    if (child === null) return { ok: false, reason: `subkey ${subpath} is listed but does not load` };
    const childChain = validateChain(child);
    if (!childChain.ok) return { ok: false, reason: `subkey ${subpath}: ${childChain.reason}` };
  }

  // "declared adjacent stores": the provider-state sidecar is the one this package can check without
  // guessing, and WS-05 §13's own rule for it is a PAIRING rule, not an integrity one — a record without
  // its entry is collectable and an entry without its record degrades. Neither is corruption, so neither
  // fails this step; the count is reported so a host can say so.
  const sidecar = adjacentSidecarReport(winterHome, session);
  return {
    ok: true,
    detail: `${lines.length} framed line(s), ${chain.detail}, ${pairing.detail}, ${compaction.detail} intact, ${subkeys.length} subkey(s) loadable${sidecar}`,
  };
}

/**
 * WS-05 §12's "UUID uniqueness, parent-chain REACHABILITY".
 *
 * THE SET IS BUILT INCREMENTALLY (review r1, F14). The first version collected every uuid in the file
 * and then checked that each `parentUuid` was in that set — which is parent PRESENCE, not
 * reachability: a forward reference (a child written before its parent) and a two-entry cycle both
 * passed. Requiring the parent to have been SEEN ALREADY is the same loop with the set built as it
 * goes, and it makes both impossible.
 */
function validateChain(entries: readonly SessionStoreEntry[]): TranscriptValidation {
  const seen = new Set<string>();
  for (const entry of entries) {
    const parent = entry["parentUuid"];
    if (typeof parent === "string" && !seen.has(parent)) {
      return { ok: false, reason: `entry ${String(entry["uuid"])} has an unreachable parentUuid: ${parent} (it does not appear earlier in the transcript)` };
    }
    const uuid = entry["uuid"];
    if (typeof uuid !== "string") continue;
    if (seen.has(uuid)) return { ok: false, reason: `duplicate uuid in the transcript: ${uuid}` };
    seen.add(uuid);
  }
  return { ok: true, detail: `${seen.size} uuid(s), all unique and reachable` };
}

/**
 * Every `tool_use` has its `tool_result`, and every `tool_result` has its `tool_use`.
 *
 * NO EXEMPTION FOR THE FINAL ENTRY (review r1, F3). The first version exempted a trailing unpaired
 * call as "the idle boundary step 2 drained to" — and the FALLBACK door then appended its note after
 * it, so the exemption stopped applying and the session could never be handed off again. The rule the
 * barrier actually wants is the stricter one: an interrupted turn is not a valid terminal boundary, so
 * it is a step-5 fork BEFORE anything is written, and the session becomes handoffable the moment its
 * tool result lands.
 */
function validateToolPairing(entries: readonly SessionStoreEntry[]): TranscriptValidation {
  const opened = new Map<string, number>();
  const closed = new Set<string>();
  entries.forEach((entry, index) => {
    for (const block of contentBlocks(entry)) {
      if (block["type"] === "tool_use" && typeof block["id"] === "string") opened.set(block["id"], index);
      if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") closed.add(block["tool_use_id"]);
    }
  });
  for (const [id] of opened) {
    if (closed.has(id)) continue;
    return {
      ok: false,
      reason: `tool_use ${id} has no tool_result: the turn was interrupted at a tool call, which is not the idle terminal boundary a handoff needs`,
    };
  }
  for (const id of closed) {
    if (!opened.has(id)) return { ok: false, reason: `tool_result ${id} has no tool_use to pair with` };
  }
  return { ok: true, detail: `${opened.size} tool call(s) paired` };
}

function contentBlocks(entry: SessionStoreEntry): Array<Record<string, unknown>> {
  const message = entry["message"];
  if (typeof message !== "object" || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null);
}

/**
 * A compaction boundary, in EITHER of the two shapes a shared store really holds (review r1, F5).
 *
 * The first version matched a top-level `type: "compact_boundary"` and demanded a preceding
 * `compact_summary` — a pairing the corpus does not have, on a shape the vendor does not write, so the
 * step was inert on real data and would have refused data that does not exist.
 *
 * There are TWO real shapes and this recognises both, deliberately:
 *   * `{type:"system", subtype:"compact_boundary", compact_metadata}` — WS-05 §5.1's observed corpus
 *     lists `compact_boundary` under SYSTEM SUBTYPES (30 real transcripts), and the SDK's own
 *     `SDKCompactBoundaryMessage` (`packages/sdk/src/protocol/frames.ts`) has exactly that shape.
 *   * `{type:"compact_boundary", compact_metadata}` — what the Winter dialect's own transcript writer
 *     emits (`packages/runtime/src/store/dialect.ts`'s `compactBoundaryEntry`).
 * A shared compatibility store can hold both, so a validator that knew only one would be inert on half
 * its input. Neither is "the" shape; the METADATA is what both carry and what is worth validating.
 */
function isCompactBoundary(entry: SessionStoreEntry): boolean {
  if (entry["type"] === "compact_boundary") return true;
  return entry["type"] === "system" && entry["subtype"] === "compact_boundary";
}

/**
 * WS-05 §5.1's compaction linkage: `preserved_messages` supersedes `preserved_segment`, and a reader
 * "looks each uuid up directly ... rather than walking the parentUuid chain" — which is a
 * RESUME-CORRECTNESS requirement, so a boundary naming a uuid the transcript does not have is a
 * boundary whose kept segment cannot be rebuilt.
 */
function validateCompaction(entries: readonly SessionStoreEntry[]): TranscriptValidation {
  const uuids = new Set(entries.map((entry) => entry["uuid"]).filter((uuid): uuid is string => typeof uuid === "string"));
  let boundaries = 0;
  for (const entry of entries) {
    if (!isCompactBoundary(entry)) continue;
    boundaries += 1;
    const metadata = entry["compact_metadata"];
    if (typeof metadata !== "object" || metadata === null) {
      return { ok: false, reason: `compaction boundary ${String(entry["uuid"])} carries no compact_metadata, so its kept segment cannot be rebuilt` };
    }
    const preserved = (metadata as { preserved_messages?: unknown }).preserved_messages;
    if (preserved === undefined) continue; // "unset when compaction summarizes everything" — nothing kept
    if (typeof preserved !== "object" || preserved === null) {
      return { ok: false, reason: `compaction boundary ${String(entry["uuid"])} has a malformed preserved_messages` };
    }
    const anchor = (preserved as { anchor_uuid?: unknown }).anchor_uuid;
    const kept = (preserved as { uuids?: unknown }).uuids;
    if (typeof anchor !== "string" || !Array.isArray(kept)) {
      return { ok: false, reason: `compaction boundary ${String(entry["uuid"])} has a malformed preserved_messages (anchor_uuid and uuids are required together)` };
    }
    if (!uuids.has(anchor)) {
      return { ok: false, reason: `compaction boundary ${String(entry["uuid"])} anchors on ${anchor}, which is not in this transcript` };
    }
    for (const uuid of kept) {
      if (typeof uuid !== "string" || !uuids.has(uuid)) {
        return { ok: false, reason: `compaction boundary ${String(entry["uuid"])} preserves ${String(uuid)}, which is not in this transcript` };
      }
    }
  }
  return { ok: true, detail: `${boundaries} compaction boundar(y|ies)` };
}

function adjacentSidecarReport(winterHome: string, session: SessionKey): string {
  const path = join(winterHome, "projects", session.projectKey, `${session.sessionId}.provider-state.jsonl`);
  try {
    const size = statSync(path).size;
    return `, and a provider-state sidecar of ${size} byte(s) left untouched`;
  } catch {
    return "";
  }
}

// --- step 6 -------------------------------------------------------------------------------------------

/** What step 6 staged, carried to the flip at the end of step 8. */
interface PendingCommit {
  cursor: string;
  stagingUuid: string;
  /** The producer record the flip will write, complete except for the moment it happens. */
  record: SessionStoreEntry;
}

async function currentLevel(shared: SharedSessionStore, session: SessionKey): Promise<CompatibilityLevel> {
  const summary = await shared.canonical.readSessionSummary({ projectKey: session.projectKey, sessionId: session.sessionId });
  const level = summary?.["compatibilityLevel"];
  return typeof level === "string" && (LEVEL_ORDER as string[]).includes(level) ? (level as CompatibilityLevel) : "conversation";
}

/** WS-05 §12: "Never silently downgrade an advertised level." A directory entry may only RAISE it. */
function raiseLevel(recorded: CompatibilityLevel, entry: RuntimeDirectoryEntry): CompatibilityLevel {
  const declared = (entry as unknown as { compatibilityLevel?: unknown }).compatibilityLevel;
  if (typeof declared !== "string" || !(LEVEL_ORDER as string[]).includes(declared)) return recorded;
  return LEVEL_ORDER.indexOf(declared as CompatibilityLevel) > LEVEL_ORDER.indexOf(recorded) ? (declared as CompatibilityLevel) : recorded;
}

/**
 * PHASE ONE of §12 step 6's commit: the writer lease, and a marker that says a handoff is in flight.
 *
 * NOTHING HERE MOVES OWNERSHIP (review r1, F1). `producerRuntime` is not written, the directory is not
 * touched, and the cursor is not advanced — the marker exists so a crash BEFORE the flip is
 * distinguishable from a crash INSIDE it (see `loadEntry`'s repair). The record it returns is the one
 * the flip will write, built now so the flip itself is a single append.
 */
async function markHandoffPending(args: {
  shared: SharedSessionStore;
  session: SessionKey;
  entry: RuntimeDirectoryEntry;
  plan: HandoffPlan;
  level: CompatibilityLevel;
  now: Date;
}): Promise<PendingCommit> {
  // The writer lease, re-verified before anything is written: a DIFFERENT live process holding it is
  // exactly the "exactly one runtime owns a compatibility session at a time" violation, and the store's
  // own typed `WinterStoreLeaseError` is the honest way to learn it.
  await args.shared.canonical.acquireSessionLease({ projectKey: args.session.projectKey, sessionId: args.session.sessionId });

  const entries = (await args.shared.store.load(args.session)) ?? [];
  const chainable = entries.filter((entry) => typeof entry["uuid"] === "string");
  const cursor = (chainable[chainable.length - 1]?.["uuid"] as string | undefined) ?? "";
  const health = args.shared.health(args.session);
  const record: SessionStoreEntry = {
    type: DIALECT_RECORD_ENTRY_TYPE,
    // WS-05 §5.4's `TranscriptDialectRecord`, as far as this package can honestly fill it in.
    backendSessionId: args.session.sessionId,
    transcriptProjectKey: args.session.projectKey,
    dialectFamily: "claude-code-jsonl",
    producerRuntime: args.plan.to,
    // NO producer VERSIONS HERE (review r2, F11). They describe the runtime that will write the session
    // from now on; the persisted selection this record is built from is the SOURCE's, and writing its
    // versions under the destination's name is exactly the mislabelling the review measured. They are
    // merged in at the commit, from `confirmInit`'s own report, or left out.
    compatibilityLevel: args.level,
    // DERIVED from the store, not asserted (review r1, F11): step 4 guarantees `ok` on the path that
    // reaches here, and reading it back is how the guarantee stays a fact rather than a comment.
    health: health.transcriptHealth === "ok" ? "clean" : "repair-required",
    // §12 step 6's other two facts, landing in the same atomic fold as the producer record — at the flip.
    projectionCursor: cursor,
    sourceGenerationCompleted: args.entry.generation,
    handoffAt: args.now.toISOString(),
    pendingHandoff: null,
  };
  await args.shared.store.append(args.session, [
    {
      type: DIALECT_RECORD_ENTRY_TYPE,
      // THE HOLDER'S PID (review r2, N6): a concurrent `plan()` must not clear a LIVE handoff's marker,
      // and the only way to tell a live one from a leftover is the same liveness probe the handoff
      // lease uses.
      pendingHandoff: { pid: process.pid, from: args.plan.from, to: args.plan.to, at: args.now.toISOString(), level: args.level, sourceGeneration: args.entry.generation, cursor },
    },
  ]);
  await args.shared.settle(args.session);
  return { cursor, stagingUuid: cryptoRandomUuid(), record };
}

/**
 * PHASE TWO, FIRST WRITE: the producer record — the AUTHORITATIVE one.
 *
 * One atomic fold carries the producer record, the projection cursor and the source generation's
 * completion, and clears the pending marker. The instant it lands the handoff IS committed: WS-05 §5.4
 * makes this record the transcript's own statement of its producer, and a destination is already
 * running (`confirmInit` returned first). That is why the caller reports `resumed` for every failure
 * after this point rather than `lossy-fork-offered` (review r2, N2.1).
 */
async function commitProducerRecord(args: {
  shared: SharedSessionStore;
  session: SessionKey;
  staged: PendingCommit;
  producer?: { sdkVersion?: string; engineVersion?: string };
}): Promise<void> {
  const record: SessionStoreEntry = {
    ...args.staged.record,
    // WS-05 §5.4's producer versions, from the runtime that will write the session (review r2, F11).
    // Absent when the destination did not report them — never the source's, under the destination's name.
    ...(args.producer?.sdkVersion === undefined ? {} : { producerSdkVersion: args.producer.sdkVersion }),
    ...(args.producer?.engineVersion === undefined ? {} : { producerEngineVersion: args.producer.engineVersion }),
  };
  await args.shared.store.append(args.session, [record]);
  await args.shared.settle(args.session);
  // READ BACK, because the mirror SWALLOWS (WS-14 §5: a failed append must not fail the turn). Without
  // this the commit would report success for a record that never landed, and the barrier would return
  // `resumed` over a transcript that still names the source.
  const summary = await args.shared.canonical.readSessionSummary({ projectKey: args.session.projectKey, sessionId: args.session.sessionId });
  if (summary?.["producerRuntime"] !== record["producerRuntime"]) {
    throw new HandoffCommitError(`the producer record did not land: the summary still names ${String(summary?.["producerRuntime"] ?? "no producer")}`);
  }
}

/** The producer record — the barrier's one authoritative write — did not reach the store. */
export class HandoffCommitError extends RuntimeSdkError {
  constructor(reason: string) {
    super(`winter-runtime-sdk: the handoff could not be committed — ${reason}`);
  }
}

/**
 * PHASE TWO, SECOND WRITE: the host directory's derived copy.
 *
 * A CACHE, and treated as one. Its failure does not undo the handoff — `loadEntry`'s repair reads the
 * authoritative record and brings this back into line on the next `plan()`.
 */
async function syncDirectoryEntry(args: {
  context: SeamContextWithDirectory;
  entry: RuntimeDirectoryEntry;
  plan: HandoffPlan;
  staged: PendingCommit;
  now: Date;
}): Promise<void> {
  await args.context.directoryStore.cursors.set(args.entry.address, args.staged.cursor);
  await args.context.directoryStore.upsert({ ...args.entry, runtimeKind: args.plan.to, generation: args.entry.generation + 1, updatedAt: args.now.toISOString() });
}

function cryptoRandomUuid(): string {
  return globalThis.crypto.randomUUID();
}

function isLeaseError(error: unknown): boolean {
  return error instanceof Error && error.name === "WinterStoreLeaseError";
}

// --- step 1's lease -------------------------------------------------------------------------------------

interface HandoffLease {
  path: string;
}

/**
 * The handoff lease — a DIFFERENT lease from the store's writer lease, and it has to be.
 *
 * The writer lease is per `(projectKey, sessionId)` and RE-ENTRANT for the same pid (the SDK's
 * `acquireLease` says so in as many words), which is correct for it: the router's own process mirrors
 * for every branch, so a barrier that took the writer lease as its mutex would find it always available
 * — including to a second barrier running in the same process on the same session. So this lease is
 * held in TWO dimensions: an on-disk lock for other processes, and a module-level set for this one.
 */
const HELD_IN_PROCESS = new Set<string>();

export function acquireHandoffLease(leaseRoot: string, session: SessionKey): HandoffLease {
  const dir = join(leaseRoot, session.projectKey);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${session.sessionId}.lock`);
  if (HELD_IN_PROCESS.has(path)) {
    throw new HandoffLeaseError(path, "another handoff for this session is already running in this process");
  }
  const info = JSON.stringify({ pid: process.pid, startTimeMs: Date.now() });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, Buffer.from(info, "utf8"));
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temp, path); // atomic expose: EEXIST if anything already holds it
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      rmSync(temp, { force: true });
      throw error;
    }
    const holder = readHolder(path);
    if (holder !== undefined && holder !== process.pid && isPidAlive(holder)) {
      rmSync(temp, { force: true });
      throw new HandoffLeaseError(path, `another live process (pid ${holder}) holds this session's handoff lease`);
    }
    // Stale (the holder is gone) or unreadable: take it over. Same posture as the store's own lease.
    rmSync(path, { force: true });
    linkSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  HELD_IN_PROCESS.add(path);
  return { path };
}

export function releaseHandoffLease(lease: HandoffLease): void {
  HELD_IN_PROCESS.delete(lease.path);
  try {
    unlinkSync(lease.path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
}

export class HandoffLeaseError extends RuntimeSdkError {
  constructor(path: string, reason: string) {
    super(`winter-runtime-sdk: the handoff lease at ${path} could not be acquired — ${reason}`);
  }
}

function readHolder(path: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ESRCH") return false;
    return true; // EPERM: alive but foreign. "Cannot prove it is dead" is treated as alive.
  }
}
