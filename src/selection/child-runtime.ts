// R-7b-1 — THE CHILD-RUNTIME RULE (WS-13c §6's deferral, closed by the Phase 7b amendment to WS-14).
//
// THE RULE, VERBATIM: "a child runs on the runtime its OWN slot's family selects under D13/D28 at
// spawn time, independent of the parent's runtime… The child's `RuntimeSelection` is persisted with
// the child record; resume and SendMessage follow the child's record (WS-13c §8), never the parent's
// current runtime; a cross-runtime parent/child pair talks only through the RuntimeDirectory. Nothing
// rewrites a persisted runtime silently."
//
// HOW THIS FILE MAKES "INDEPENDENT OF THE PARENT" STRUCTURAL RATHER THAN INTENDED. `selectChildRuntime`
// takes the parent, because the plan and the spine both pin that signature — and it passes the parent
// to exactly one place: `crossRuntime`, the reporting bit Lane B's router needs. The decision itself
// is `decideRuntime` over a candidate resolved from `ChildSelectionInput` alone, the same table a
// top-level session is decided by. There is no second table to drift, and there is no code path by
// which a parent's `runtimeKind` could reach the answer. `test/selection/child-runtime.test.ts` proves
// it the only way that counts: the same child input under two different parents produces two
// identical records.
//
// WHY A SEPARATE `resumeChildSelection`. WS-13c §8 — "the child's own record is authoritative on
// resume" — and WS-10's Phase 6.6 amendment: "a resumed child re-resolves under its OWN recorded model
// and provider, and the resolved provider id must equal the recorded one — credential loss or a
// drifted mapping is `{ status: "unavailable", retryable: false, reason: "child-provider-unavailable:
// …" }` with no generation started." That is a different question from "which runtime should a NEW
// child use", it has a different answer type, and folding it into the selector would have made a
// resume capable of re-deciding — which is the one thing it must never do.
import type { ChildSelectionInput, RuntimeSelection, SelectionInput, SelectionRefusal } from "./runtime-selection.ts";
import { decideRuntime, resolveCandidate } from "./select-runtime.ts";

const isRefusal = (value: unknown): value is SelectionRefusal => typeof value === "object" && value !== null && (value as SelectionRefusal).refused === true;

/**
 * The child's own request, as the D13 table's input.
 *
 * NO `persisted`, EVER. A child being spawned has no persisted selection by definition — the record
 * this function produces IS the one that gets persisted with the child (R-7b-1). Building the input
 * here rather than letting a caller pass a `SelectionInput` is what keeps a parent's record out of
 * the child's decision: there is no field to put it in.
 */
function childInput(child: ChildSelectionInput): SelectionInput {
  const requested: SelectionInput["requested"] = {
    ...(child.slot === undefined ? {} : { slot: child.slot }),
    ...(child.model === undefined ? {} : { model: child.model }),
    ...(child.provider === undefined ? {} : { provider: child.provider }),
  };
  return {
    mode: child.mode,
    requested,
    families: child.families,
    credentials: child.credentials,
    hasClaudePeer: child.hasClaudePeer,
    claudeOauthApproved: child.claudeOauthApproved,
    ...(child.versions === undefined ? {} : { versions: child.versions }),
    ...(child.now === undefined ? {} : { now: child.now }),
  };
}

/**
 * R-7b-1: the child's runtime, decided by the CHILD's slot, never inherited from the parent.
 *
 * The `parent` argument is read for nothing at all in this function — see
 * `selectChildRuntimePairing` for the one thing it IS for. It stays in the signature because the
 * plan, the spine's pinned interface and every call site name it, and because a caller holding a
 * parent record is exactly the caller who must be told, at the type level, that the parent does not
 * decide.
 */
export function selectChildRuntime(parent: RuntimeSelection, child: ChildSelectionInput): RuntimeSelection | SelectionRefusal {
  void parent;
  const input = childInput(child);
  const candidate = resolveCandidate(input);
  if (isRefusal(candidate)) return candidate;
  return decideRuntime(candidate, input);
}

/**
 * How a parent and its child can talk (WS-15 §6.1, R-7b-1's last clause).
 *
 * `channel` is the bit Lane B's messaging router branches on: a same-runtime pair reaches its child
 * through that runtime's own adapter (a Winter session's `Query.messaging` facet, an official
 * session's own child handles), while a CROSS-RUNTIME pair "talks only through the RuntimeDirectory"
 * — neither runtime can see into the other, so the address must be resolved centrally and the
 * delivery must go through the router's own adapter for the child's runtime.
 */
export interface ChildRuntimePairing {
  /** The child's own record — the thing that gets persisted with the child. */
  child: RuntimeSelection;
  /** The parent's runtime at spawn time, recorded for the pairing only. */
  parentRuntime: RuntimeSelection["runtimeKind"];
  /** True when parent and child ended up on different runtimes. */
  crossRuntime: boolean;
  /** `directory` exactly when `crossRuntime` — the two are one fact, spelled for the two readers. */
  channel: "in-runtime" | "directory";
}

/** `selectChildRuntime` plus the cross-runtime bit, for the messaging lane. */
export function selectChildRuntimePairing(parent: RuntimeSelection, child: ChildSelectionInput): ChildRuntimePairing | SelectionRefusal {
  const selection = selectChildRuntime(parent, child);
  if (isRefusal(selection)) return selection;
  const crossRuntime = selection.runtimeKind !== parent.runtimeKind;
  return {
    child: selection,
    parentRuntime: parent.runtimeKind,
    crossRuntime,
    channel: crossRuntime ? "directory" : "in-runtime",
  };
}

/** WS-10's Phase 6.6 amendment: the exact reason prefix a drifted or credential-less child reports. */
export const CHILD_PROVIDER_UNAVAILABLE = "child-provider-unavailable";

/**
 * The answer to "can this child be resumed on its own record?" (WS-13c §8, WS-10 §15 amendment).
 *
 * `resumed` carries the child's OWN persisted record, by identity — a resume never re-decides and
 * never rewrites. `unavailable` is `retryable: false` because the two things that produce it (a
 * credential that is gone, a mapping that drifted to a different provider) are not transient, and
 * Lane B maps it straight onto `DeliveryOutcome`'s `{ status: "unavailable"; retryable: false; reason }`
 * with NO generation started.
 */
export type ChildResumeOutcome =
  | { kind: "resumed"; selection: RuntimeSelection }
  | { kind: "unavailable"; retryable: false; reason: string };

/**
 * Re-resolves a child under its OWN recorded model and provider, for a resume or a SendMessage.
 *
 * THE ONE COMPARISON THIS FUNCTION EXISTS FOR: "the resolved provider id must equal the recorded one".
 * So it resolves the recorded `modelRef` — the provider-qualified catalog key, which is why row 17's
 * identity matters — against the CURRENT listing and credential map, and then checks that what came
 * back is the same provider the record names. Anything else is a refusal: not a substitution onto
 * whichever provider still has a credential, which is exactly the silent re-routing WS-13c §4's
 * "never a substitution; never a different family" forbids, and which would strand a session's
 * continuation on a backend it never ran on.
 *
 * THE RUNTIME IS NEVER RE-DECIDED EITHER. Even when the fresh resolution succeeds, the returned
 * selection is the persisted record, not a new one — "resume and SendMessage follow the child's
 * record, never the parent's current runtime" (R-7b-1), and a resume that re-ran the D13 table could
 * move a live child between runtimes on a credential change.
 */
export function resumeChildSelection(record: RuntimeSelection, context: Omit<ChildSelectionInput, "slot" | "model" | "provider">): ChildResumeOutcome {
  const resolved = resolveCandidate(
    childInput({
      ...context,
      model: record.modelRef,
      provider: record.providerId,
    }),
  );
  if (isRefusal(resolved)) {
    return {
      kind: "unavailable",
      retryable: false,
      reason: `${CHILD_PROVIDER_UNAVAILABLE}: ${record.modelRef} on provider ${record.providerId} — ${resolved.detail}`,
    };
  }
  if (resolved.row.providerId !== record.providerId) {
    return {
      kind: "unavailable",
      retryable: false,
      reason: `${CHILD_PROVIDER_UNAVAILABLE}: this child is recorded on provider ${record.providerId} (${record.modelRef}) and its recorded model now resolves to ${resolved.row.providerId} (${resolved.row.key}); a resumed child re-resolves under its OWN recorded model and provider and the resolved provider id must equal the recorded one (WS-10, Phase 6.6 amendment)`,
    };
  }
  if (resolved.family !== record.family) {
    return {
      kind: "unavailable",
      retryable: false,
      reason: `${CHILD_PROVIDER_UNAVAILABLE}: this child is recorded in the ${record.family} family and its recorded model now resolves into ${resolved.family}; never a substitution, never a different family (WS-13c §4)`,
    };
  }
  return { kind: "resumed", selection: record };
}
