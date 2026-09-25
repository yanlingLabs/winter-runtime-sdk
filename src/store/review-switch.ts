// THE ONE PRE-FLIGHT REVIEW FOR A MODEL CHANGE (WS-18 W18-20, P10b) — and the one shared store the
// router hands every reader.
//
// WS-23: this used to be one door of the handoff barrier (`handoff-barrier.ts`), which moved a session
// between the Winter runtime and the official `claude` runtime (WS-05 §12's eight steps). The official
// runtime is retired, so no switch moves ownership any more and the barrier's plan/execute, its leases,
// its staging roots and its decorations are gone. What a host still needs is the question every
// family-crossing model change asks first — can the conversation's carried state survive the move? —
// and that is `reviewSwitch`, moved here unchanged in what it reads and what it answers.
//
// READ-ONLY, ALWAYS. It reads the canonical transcript and the provider-state sidecar through the
// shared store and resolves both endpoints through the host's catalog registry (or the compiled
// catalog's, absent one); it never appends, never repairs a directory row, never takes a lease — a
// host calls it on every `setModel`, including while a Winter child holds the session's writer lease.
//
// A SESSION NOT IN THE RUNTIME DIRECTORY IS A TYPED THROW, never an empty review: "no record" is not
// "nothing to lose". The message keeps the barrier's own wording ("it is not in the runtime
// directory"), which a host matches on to materialize the row and ask once more.
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { reviewModelSwitch, type ContinuityEndpoint, type MessageOrigin, type ProviderStateRecord, type SwitchReview } from "@yanlinglabs/winter-provider-runtime";

import { catalogKnowsModel, defaultEndpointResolver } from "../default-endpoint-resolver.ts";
import { RuntimeSdkError } from "../errors.ts";
import type { SeamContextWithDirectory } from "../seams/context.ts";
import type { RuntimeDirectoryEntry } from "../seams/directory-store.ts";
import type { SwitchReviewer } from "../seams/review-switch.ts";
import type { RuntimeSelection } from "../selection/runtime-selection.ts";
import { readProviderStateSidecar } from "./provider-state.ts";
import { lazySharedSessionStore, type SharedSessionStore } from "./wiring.ts";

export interface SwitchReviewerDeps {
  /** The one shared store. Built lazily from the peer + `winterHome` when a host does not pass one. */
  shared?: SharedSessionStore;
  /** Defaults to the context's, then the peer's own `resolveWinterHome()` — resolved at first use. */
  winterHome?: string;
  /** WS-21: the store's root when it is not `winterHome` (the shared runtime home). Defaults to the context's. */
  storeHome?: string;
  /**
   * WS-18 W18-20 (P10b): turns a stamped `MessageOrigin` into full endpoint facts — normally
   * `createEndpointResolver(registry)` over the host's own (credentialed, live-discovery-aware)
   * catalog registry. Absent means `defaultEndpointResolver()` — a registry built from the COMPILED
   * catalog alone (`default-endpoint-resolver.ts`, fix round 1 CRITICAL): the bare
   * `endpointFromOrigin` fallback reports `readableState: "none"` for every model, which silently
   * over-warns a real lossless exposed-reasoning transfer.
   */
  resolveEndpoint?: (origin: MessageOrigin) => ContinuityEndpoint;
}

export interface SwitchReviewerHandle extends SwitchReviewer {
  /** The shared store this reviewer reads through — the same object the router's recovery door uses. */
  readonly shared: SharedSessionStore;
}

/** A review asked for a session the router has no record of. The text is matched by hosts — keep it. */
export class SwitchReviewError extends RuntimeSdkError {
  constructor(session: SessionKey, reason: string) {
    super(`winter-runtime-sdk: no switch review can be run for ${session.projectKey}/${session.sessionId} — ${reason}`);
  }
}

export function createSwitchReviewer(context: SeamContextWithDirectory, deps: SwitchReviewerDeps = {}): SwitchReviewerHandle {
  // EVERYTHING THE STORE TOUCHES IS RESOLVED ON FIRST USE: most handles never review a switch, and a
  // test peer with no store class must still construct one. See `lazySharedSessionStore`.
  const winterHome = deps.winterHome ?? context.winterHome;
  const storeHome = deps.storeHome ?? context.storeHome;
  const sharedOf =
    deps.shared === undefined
      ? lazySharedSessionStore({ peers: context.peers, brand: context.brand, ...(winterHome === undefined ? {} : { winterHome }), ...(storeHome === undefined ? {} : { storeHome }) })
      : () => deps.shared!;
  const homeOf = (): string => winterHome ?? sharedOf().identity.winterHome;
  // The STORE home: under WS-21 the child writes the sidecar beside the canonical transcript in the
  // shared runtime home, `<home>/sdk` — never under the daemon's own home.
  const storeHomeOf = (): string => sharedOf().identity.storeHome ?? homeOf();

  const findEntry = async (session: SessionKey): Promise<RuntimeDirectoryEntry> => {
    const entries = await context.directoryStore.load();
    const match =
      entries.find((entry) => entry.backendSessionId === session.sessionId) ??
      entries.find((entry) => entry.parsed.winterSessionId === session.sessionId);
    if (match === undefined) {
      throw new SwitchReviewError(session, "it is not in the runtime directory, so there is no record of which runtime owns it or which backend session it is");
    }
    return match;
  };

  /** A `RuntimeSelection`'s identity, as the continuity module's `MessageOrigin` names it. */
  const originFrom = (selection: RuntimeSelection): MessageOrigin => ({ providerId: selection.providerId, modelKey: selection.modelRef, family: selection.family });

  /**
   * fix wave 2 re-review, MAJOR (new) — a failed-call residue entry is not a real reply and must
   * never stand in as the live tip. Claude writes a failed call as an assistant entry carrying
   * `isApiErrorMessage: true` and a synthetic `model: "<synthetic>"` — exactly the shape W18-13(c)'s
   * SDK reader already skips for its own purposes. Left untreated, that entry's unknown model/family
   * defeats the same-family skip right when a user is most likely to switch: immediately after an
   * error.
   */
  const isApiErrorOrSyntheticTip = (entry: SessionStoreEntry): boolean => {
    if (entry["isApiErrorMessage"] === true) return true;
    const message = entry["message"];
    const model = typeof message === "object" && message !== null ? (message as { model?: unknown }).model : undefined;
    return model === "<synthetic>";
  };

  /**
   * WS-18 W18-20 fix wave 2, CRITICAL C1 — walks the lineage BACKWARDS from the true tip (the last
   * chain-linked entry, skipping trailing bookkeeping entries with no uuid) to the most recent REAL
   * ASSISTANT entry — one that is neither `isApiErrorMessage:true` nor the synthetic error-residue
   * model id: those are walked PAST, exactly like a non-chainable bookkeeping entry. `undefined` means
   * the lineage has no REAL assistant entry at all — a session that has not replied yet (or whose only
   * replies are error residue), which `liveSourceOrigin` reads as "nothing live to derive from".
   */
  const findLiveTipAssistant = (entries: readonly SessionStoreEntry[]): SessionStoreEntry | undefined => {
    const chainable = entries.filter((entry) => typeof entry["uuid"] === "string");
    if (chainable.length === 0) return undefined;
    const byUuid = new Map(chainable.map((entry) => [entry["uuid"] as string, entry]));
    let cursor: SessionStoreEntry | undefined = chainable[chainable.length - 1];
    const seen = new Set<string>();
    while (cursor !== undefined) {
      const uuid = cursor["uuid"] as string;
      if (seen.has(uuid)) return undefined; // a cycle: not a real transcript, and never our business to fix here
      seen.add(uuid);
      if (cursor["type"] === "assistant" && !isApiErrorOrSyntheticTip(cursor)) return cursor;
      const parentUuid: unknown = cursor["parentUuid"];
      cursor = typeof parentUuid === "string" ? byUuid.get(parentUuid) : undefined;
    }
    return undefined;
  };

  /**
   * WS-18 W18-20 fix wave 2, CRITICAL C1 — THE REVIEW'S SOURCE IS THE LIVE MODEL, never
   * `entry.selection` alone: a same-runtime model change (gpt -> deepseek) never touches the
   * directory row, so a session created on deepseek and long since talking through gpt still reads
   * `entry.selection.family === "deepseek"`.
   *
   * THE ORDER, per the fix ruling:
   *   1. the tip's own sidecar `kind:"origin"` record (a Winter-written turn always stamps one) —
   *      used WHOLE, verbatim;
   *   2. otherwise the tip's own `message.model`. WS-23: this is no longer dead official-leg code — a
   *      session the retired `claude` runtime created and the host adopted onto the Winter runtime
   *      still has claude-written turns with NO sidecar origin record, and this is how the review
   *      learns what they ran on. The provider comes from the directory row's recorded official
   *      provider (`entry.selection.providerId` when that row still names `claude-agent`) or
   *      `"anthropic"` as the honest last resort; used ONLY when `catalogKnowsModel` confirms it names
   *      a real catalog row. When it does not resolve and the row still names `claude-agent`, that
   *      persisted row is the better substitute; when the row names some other family entirely,
   *      falling back to IT would report the WRONG family outright, so the raw candidate is kept;
   *   3. `entry.selection` — when the lineage has no REAL assistant entry at all.
   */
  const liveSourceOrigin = (args: { entries: readonly SessionStoreEntry[]; sidecarRecords: readonly ProviderStateRecord[]; entry: RuntimeDirectoryEntry }): MessageOrigin => {
    const tip = findLiveTipAssistant(args.entries);
    if (tip === undefined) return originFrom(args.entry.selection);
    const tipUuid = tip["uuid"] as string;
    const origin = args.sidecarRecords.find((record) => record.anchorUuid === tipUuid && record.kind === "origin");
    if (origin !== undefined) return { providerId: origin.provider, modelKey: origin.model, family: origin.family };
    const message = tip["message"];
    const model = typeof message === "object" && message !== null ? (message as { model?: unknown }).model : undefined;
    if (typeof model === "string" && model.length > 0) {
      const officialLegSelection = args.entry.selection.runtimeKind === "claude-agent";
      const providerId = officialLegSelection ? args.entry.selection.providerId : "anthropic";
      const candidate: MessageOrigin = { providerId, modelKey: model, family: "claude" };
      if (catalogKnowsModel(candidate)) return candidate;
      return officialLegSelection ? originFrom(args.entry.selection) : candidate;
    }
    return originFrom(args.entry.selection);
  };

  /**
   * MINOR m3 (fix wave 2): READ-ONLY — the directory is read bare (never repaired) and the store is
   * only loaded. `truncated` is always false: truncation was the claude-ready copy's `dropped`, which
   * only a destination on the official runtime ever had; a Winter destination renders its carry tags
   * inside the runtime itself, at request-build time, which this router never sees.
   */
  const reviewSwitch = async (session: SessionKey, requested: RuntimeSelection): Promise<SwitchReview> => {
    const entry = await findEntry(session);
    const store = sharedOf();
    const entries = (await store.store.load(session)) ?? [];
    const sidecar = await readProviderStateSidecar(storeHomeOf(), session);
    const resolve = deps.resolveEndpoint ?? defaultEndpointResolver();
    const fromEndpoint = resolve(liveSourceOrigin({ entries, sidecarRecords: sidecar, entry }));
    const toEndpoint = resolve(originFrom(requested));
    return reviewModelSwitch({ entries, sidecarRecords: sidecar, from: fromEndpoint, to: toEndpoint, truncated: false });
  };

  return {
    reviewSwitch,
    get shared(): SharedSessionStore {
      return sharedOf();
    },
  };
}
