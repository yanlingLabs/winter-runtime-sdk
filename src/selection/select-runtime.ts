// D13/D28 — THE RUNTIME SELECTION, as a pure function over a listing, a credential map and a mode.
//
// WHAT THIS FILE IS. `selectRuntime` is the whole of WS-13 §9's table plus WS-13c §0's D28 leg, and
// nothing else: given what the session asked for, which providers have a configured credential ref,
// which runtimes this router actually holds, and which mode the session is in, it produces the record
// that is PERSISTED AT SESSION CREATION and read on every later resume. It touches no filesystem, no
// environment, no credential material, and no clock the caller did not hand it (`SelectionInput.now`)
// — except the `decidedAt` stamp, which falls back to the wall clock when `now` is omitted.
//
// THREE PROPERTIES THE STRUCTURE ENFORCES, rather than merely intending:
//
//   1. NEVER A RAW MODEL-ID SUBSTRING (WS-13 §9). No comparison in this file looks inside a model id.
//      The family comes from `ModelFamilyListing` — the catalog's own answer, computed by the SDK's
//      `familyIdOf` from the catalog's matchers — and the branch is taken on `family` + `authFamily` +
//      the backend's wire dialect + `mode`. `requested.model` exists ONLY to resolve which row the
//      session meant, exactly as WS-13c §4 uses it; it never reaches the decision.
//   2. THE PERSISTED SELECTION WINS AND IS RETURNED BY IDENTITY. When `input.persisted` is set,
//      `selectRuntime` returns THAT OBJECT — not a copy, not a re-decision, not a merge. "Changing
//      family/runtime mid-session is the certified handoff or a visible fork, never a silent rewrite"
//      (WS-00 §2, D13), and a function that rebuilt the record would have to be trusted to rebuild it
//      identically. `reviewPersistedSelection` below is the door for asking whether a fresh decision
//      would differ — it reports `handoff-required` and still never rewrites anything.
//   3. A REFUSAL IS A VALUE, AND EVERY BRANCH HAS ONE. `SelectionRefusal` is returned, not thrown
//      (`RuntimeSdk.selectRuntime`, the method, is the one door that throws — see
//      `SelectionRefusedError`). WS-13c §4's own words: "Never a substitution; never a different
//      family." A selector that cannot serve what was asked says so; it does not quietly serve
//      something else.
//
// EVERY DECISION CARRIES A RULE ID. `RuntimeSelection.reason` is prefixed with the id of the rule that
// fired (`SELECTION_RULES`), so a host rendering "why is this session on that runtime" and a test
// asserting which branch was taken read the same token instead of substring-matching prose.
import type { CredentialRef, ModelFamilyListing } from "@yanlinglabs/winter-agent-sdk";

import type { VersionMatrixReport } from "../version-matrix.ts";
import type {
  CredentialPresence,
  ProviderAuthView,
  RuntimeSelection,
  SelectionAuthFamily,
  SelectionInput,
  SelectionRefusal,
  SelectionVersions,
} from "./runtime-selection.ts";

// --- the vocabulary this file compares against ----------------------------------------------------

/** The family id the D13 table names. The catalog's own id (WS-13c §1, `CLAUDE_FAMILY_ID`). */
export const CLAUDE_FAMILY_ID = "claude";

/** WS-13 §5's Anthropic wire dialect, as the catalog's provider descriptors spell it. */
export const ANTHROPIC_PROTOCOL = "anthropic-messages";

/**
 * The provider ids treated as Anthropic-protocol backends when the host declares no `protocols`.
 *
 * A FALLBACK, NOT A POLICY. When `CredentialPresence.authByProvider[id].protocols` is present it is
 * authoritative and this list is not consulted. It exists because the alternative — treating an
 * undeclared backend as Anthropic-protocol — would route a Claude model resold through an
 * OpenAI-shaped gateway to the official runtime, which is precisely WS-13 §9's third row inverted.
 * The conservative direction is the safe one: an undeclared, unlisted backend goes to Winter, which
 * serves every family, rather than to a runtime that speaks one wire protocol.
 *
 * ONE ENTRY, and that is not an oversight: Bedrock and Vertex reach the official branch through their
 * AUTH FAMILY (`cloud-credential-chain`, WS-14 §12's own table rows), not through this list — their
 * catalog dialects are `bedrock-converse` and `google-generate-content`, and claiming otherwise here
 * would be a false statement about the catalog.
 */
export const ANTHROPIC_PROTOCOL_PROVIDER_FALLBACK: readonly string[] = ["anthropic"];

/**
 * D25's reserved slot names, which resolve into the `claude` family from any active set (WS-13c §3's
 * acceptance order, mirrored from the catalog's `CLAUDE_RESERVED_SLOT_NAMES`).
 */
export const CLAUDE_RESERVED_SLOT_NAMES: readonly string[] = ["fable", "opus", "sonnet", "haiku"];

/**
 * D14's ship gate, as the shipped default.
 *
 * WS-14 §12: Claude OAuth is "built but publicly ship-gated pending written Anthropic approval…
 * Until approval exists, the shippable branch uses API-key/cloud/gateway auth only." A host that has
 * approval passes `claudeOauthApproved: true` deliberately; everything that does not say so gets this.
 */
export const D14_CLAUDE_OAUTH_APPROVED_DEFAULT = false;

/** What a `RuntimeSelection` records when the caller supplied no version identity for that runtime. */
export const UNKNOWN_VERSION = "unknown";

/**
 * The auth families the official branch serves (R-7b-1 as clarified 2026-09-08), before any per-rule
 * gate.
 *
 * THE ONE HOME FOR THE SET. `officialServesBackend` DERIVES from this list rather than restating it —
 * the alternative was two places to edit, and review r1's I1 was the first time that cost something
 * real (a family was added to the rule and the constant said otherwise, with nothing failing).
 */
export const OFFICIAL_SERVED_AUTH_FAMILIES: readonly SelectionAuthFamily[] = ["api-key", "console-oauth", "cloud-credential-chain", "claude-oauth"];

// --- the rules, by id -----------------------------------------------------------------------------

/**
 * Every branch this selector can take, with the sentence a host renders.
 *
 * IDS RATHER THAN PROSE MATCHING. `RuntimeSelection.reason` is `"<id>: <text>"`, so a test asserts on
 * `D13-1` while a user reads the sentence, and rewording the sentence never breaks a test (nor does
 * a test pin prose a product person should be free to improve).
 */
export const SELECTION_RULES = {
  "D13-1": "a Claude OAuth credential always routes to the official runtime (WS-13 §9, D13 row 1)",
  "D13-2": "a Claude-family model on an Anthropic-protocol backend in Code mode routes to the official runtime (WS-13 §9, D13 row 2)",
  "D13-3-endpoint": "a Claude-family model reached through a backend the official branch does not serve routes to the Winter runtime (WS-13 §9, D13 row 3)",
  "D13-3-mode": "Dispatch and Chat run in-daemon on the Winter runtime (WS-13 §9 row 3, D4)",
  "D28": "a non-Claude family routes to the Winter runtime (WS-13c §0, D28)",
  "R-7b-1-no-peer": "this router holds no official runtime, so the Claude-family slot resolves through WS-13c §4's order onto the Winter runtime (R-7b-1)",
  "persisted": "the selection persisted at session creation wins; a change is the certified handoff or a visible fork, never a silent rewrite (WS-00 §2, D13)",
} as const;

export type SelectionRuleId = keyof typeof SELECTION_RULES;

/** `"<id>: <sentence>"` — the exact string a produced record carries in `reason`. */
export function reasonFor(rule: SelectionRuleId): string {
  return `${rule}: ${SELECTION_RULES[rule]}`;
}

/**
 * The rule id a produced record was decided by, recovered from its `reason`.
 *
 * `Object.hasOwn`, NOT `in` — `in` walks the prototype chain, so a persisted record whose `reason`
 * began `toString:` would have come back as a `SelectionRuleId` and `SELECTION_RULES[id]` would have
 * handed the caller a `Function` where it expects a sentence. A `RuntimeSelection` arrives off a
 * host's durable store, so it is exactly the kind of input that must not be trusted to be one of ours.
 */
export function ruleIdOf(selection: RuntimeSelection): SelectionRuleId | undefined {
  const id = selection.reason.slice(0, selection.reason.indexOf(":"));
  return Object.hasOwn(SELECTION_RULES, id) ? (id as SelectionRuleId) : undefined;
}

// --- the listing, read the way WS-13c §4 reads it -------------------------------------------------

type FamilyEntry = ModelFamilyListing["families"][number];
type ModelEntry = FamilyEntry["models"][number];
/** One catalog row as the listing publishes it: the provider-qualified `key` is the identity (row 17). */
export type ModelRow = ModelEntry["rows"][number];

/** A row that survived WS-13c §4's filter, with the family it belongs to. */
export interface SelectionCandidate {
  family: string;
  canonicalModelId: string;
  row: ModelRow;
  auth: ProviderAuthView;
}

const refuse = (reason: SelectionRefusal["reason"], detail: string): SelectionRefusal => ({ refused: true, reason, detail });

/**
 * The auth family implied by a credential ref's STORAGE KIND, for a provider the host did not describe.
 *
 * THE ONE RULE THAT MATTERS HERE: an OAuth family is never inferred. `keychain`, `env` and `inline`
 * are where an API key lives and are also where a subscription credential could live, and guessing
 * `claude-oauth` from a keychain entry would let an ambient credential trip D14's ship gate — the
 * exact shape WS-14's Phase 6 amendment forbids ("never by ambient environment scan"). `file` is
 * genuinely undeterminable (the ref's `format` distinguishes an AWS credentials file from a raw key,
 * and the kind alone does not carry it), so it reports `custom`, which no rule routes to the official
 * runtime. Everything unknown therefore lands on Winter, which serves every family.
 */
export function authFamilyFromRefKind(kind: CredentialRef["kind"]): SelectionAuthFamily {
  switch (kind) {
    case "aws-default-chain":
      return "cloud-credential-chain";
    case "none":
      return "local-none";
    case "keychain":
    case "env":
    case "inline":
      return "api-key";
    case "file":
      return "custom";
    default:
      return "custom";
  }
}

/** The host's view of a provider, or the conservative one derived from its ref kind. */
export function providerAuthView(providerId: string, credentials: CredentialPresence): ProviderAuthView | undefined {
  const declared = credentials.authByProvider?.[providerId];
  if (declared !== undefined) return declared;
  const kind = credentials.byProvider[providerId];
  if (kind === undefined) return undefined;
  return { authFamily: authFamilyFromRefKind(kind) };
}

/** WS-13 §9's "Anthropic-protocol backend" test: the declared dialects, else the fallback list. */
export function speaksAnthropicProtocol(providerId: string, auth: ProviderAuthView): boolean {
  if (auth.protocols !== undefined) return auth.protocols.includes(ANTHROPIC_PROTOCOL);
  return ANTHROPIC_PROTOCOL_PROVIDER_FALLBACK.includes(providerId);
}

/**
 * Can the OFFICIAL branch serve this backend at all? (R-7b-1's served set, WS-14 §12's table.)
 *
 * MEMBERSHIP FIRST, THEN THE PROTOCOL GATE. A family outside `OFFICIAL_SERVED_AUTH_FAMILIES` is not
 * served, full stop; a family inside it is served either unconditionally or only on a backend that
 * speaks the Anthropic dialect, and which of the two it is follows from what the family means:
 *
 *   `claude-oauth`             — served (and gated separately, because it is D13's own row 1).
 *   `cloud-credential-chain`   — served. These are WS-14 §12's Bedrock and Vertex rows: their catalog
 *                                dialects are NOT `anthropic-messages`, and the official runtime
 *                                speaks them itself, so the auth family is the honest test there.
 *   `api-key`, `console-oauth` — served ONLY on an Anthropic-dialect backend. Both are token-priced
 *                                bearer credentials the official runtime accepts through its bearer
 *                                variable (R-7b-1 as clarified 2026-09-08), so neither is a reason to
 *                                route away from the official branch — but a Claude model resold over
 *                                an OpenAI-shaped endpoint still is, which is WS-13 §9's row 3 and the
 *                                one place the protocol test does the work.
 *
 * `console-oauth` was excluded here until review r1's I1. The reasoning had been WS-13c §6's "the
 * `anthropic` provider first (api-key or Console OAuth credential)" — but that sentence sits inside
 * §6's WINTER-ALONE paragraph, and the router leg is the next sentence ("With the runtime SDK present:
 * `claude` slots prefer the official SDK per D13"). The exclusion was never required by the spec, and
 * it contradicted D28's "anthropic models always prefer claude agent sdk".
 */
export function officialServesBackend(providerId: string, auth: ProviderAuthView): boolean {
  if (!OFFICIAL_SERVED_AUTH_FAMILIES.includes(auth.authFamily)) return false;
  if (auth.authFamily === "api-key" || auth.authFamily === "console-oauth") return speaksAnthropicProtocol(providerId, auth);
  return true;
}

function familyById(listing: ModelFamilyListing, id: string): FamilyEntry | undefined {
  return listing.families.find((family) => family.id === id);
}

/** WS-13c §4 step 1 + step 2: the rows for a canonical id, filtered to what this session can serve. */
function candidatesFor(listing: ModelFamilyListing, familyId: string, canonicalModelId: string, input: SelectionInput | ChildLikeInput): SelectionCandidate[] {
  const family = familyById(listing, familyId);
  const model: ModelEntry | undefined = family?.models.find((entry) => entry.canonicalModelId === canonicalModelId);
  if (model === undefined) return [];
  const out: SelectionCandidate[] = [];
  for (const row of model.rows) {
    // A pinned provider narrows the candidate set; it never widens it and never substitutes.
    if (input.requested.provider !== undefined && row.providerId !== input.requested.provider) continue;
    // The catalog's own unservable statuses (WS-13c §4 step 1, `isSlotServableRow`).
    if (row.status === "blocked" || row.status === "deprecated") continue;
    // "we know there is none" excludes; "unknown" does not — a configured credential ref is the
    // admission test, and an unprobed provider with a ref is exactly the row a host wants offered.
    if (row.servable === "absent") continue;
    const auth = providerAuthView(row.providerId, input.credentials);
    // WS-13c §4 step 2: "filter by configured credential ref". No ref, no candidate — and never an
    // environment scan to find one (WS-14, Execution amendments — Phase 6).
    if (auth === undefined) continue;
    out.push({ family: familyId, canonicalModelId, row, auth });
  }
  return out;
}

/** The shape both entry points share once the child's request has been normalised. */
interface ChildLikeInput {
  requested: { slot?: string; model?: string; provider?: string };
  credentials: CredentialPresence;
}

/**
 * WS-13c §3's slot-name acceptance order, read off the LISTING rather than the catalog.
 *
 * The active set first; then D25's four reserved names into the `claude` family from anywhere; then a
 * unique name across every family. Two families offering the same name and neither being active is
 * genuinely ambiguous, and "the router never chooses arbitrarily" (WS-10 §11's rule for addresses is
 * the same instinct) — it refuses with both candidates named.
 */
function resolveSlot(listing: ModelFamilyListing, slot: string): { familyId: string; canonicalModelId: string } | SelectionRefusal {
  const active = listing.active;
  if (active !== undefined) {
    const own = active.slots.find((s) => s.name === slot);
    if (own !== undefined) return { familyId: active.family, canonicalModelId: own.canonicalModelId };
  }
  if (CLAUDE_RESERVED_SLOT_NAMES.includes(slot)) {
    const claude = familyById(listing, CLAUDE_FAMILY_ID);
    const reserved = claude?.slots.find((s) => s.name === slot);
    if (claude !== undefined && reserved !== undefined) return { familyId: claude.id, canonicalModelId: reserved.canonicalModelId };
  }
  const hits: Array<{ familyId: string; canonicalModelId: string }> = [];
  for (const family of listing.families) {
    for (const candidate of family.slots) {
      if (candidate.name === slot) hits.push({ familyId: family.id, canonicalModelId: candidate.canonicalModelId });
    }
  }
  const first = hits[0];
  if (hits.length === 1 && first !== undefined) return first;
  if (hits.length > 1) {
    return refuse("slot-unservable", `the slot name ${JSON.stringify(slot)} is offered by more than one family (${hits.map((h) => `${h.familyId}/${slot}`).join(", ")}) and none of them is this session's active family; name the family's own model instead of choosing arbitrarily`);
  }
  return refuse("slot-unservable", `no family in this session's listing offers a slot named ${JSON.stringify(slot)}`);
}

/** A canonical model id or a catalog row key, resolved to the family that owns it (WS-13c §5's two spellings). */
function resolveModel(listing: ModelFamilyListing, model: string): { familyId: string; canonicalModelId: string } | SelectionRefusal {
  const hits: Array<{ familyId: string; canonicalModelId: string }> = [];
  for (const family of listing.families) {
    for (const entry of family.models) {
      if (entry.canonicalModelId === model || entry.rows.some((row) => row.key === model)) {
        hits.push({ familyId: family.id, canonicalModelId: entry.canonicalModelId });
      }
    }
  }
  const unique = new Map(hits.map((hit) => [`${hit.familyId}/${hit.canonicalModelId}`, hit]));
  const only = [...unique.values()][0];
  if (unique.size === 1 && only !== undefined) return only;
  if (unique.size > 1) {
    return refuse("slot-unservable", `${JSON.stringify(model)} resolves to more than one family in this session's listing (${[...unique.keys()].join(", ")})`);
  }
  return refuse("slot-unservable", `no model or catalog row in this session's listing matches ${JSON.stringify(model)}`);
}

const isRefusal = (value: unknown): value is SelectionRefusal => typeof value === "object" && value !== null && (value as SelectionRefusal).refused === true;

/**
 * WS-13c §4, end to end: what the session asked for → the one row it will run on.
 *
 * ORDER OF PRECEDENCE: an explicit slot, else an explicit model, else the session's active slot set —
 * whose slots are tried in the order the listing publishes them, because that order IS §4's
 * deterministic order (vendorProviders, subscription before token, `settings.preferredProviders`, then
 * `admission.tier`). This package re-sorts nothing: the listing is produced by the code that owns
 * those rules, and a second ordering here would be a second answer.
 */
/** A candidate list that is non-empty BY TYPE, so a caller never has to guard an impossible empty. */
export type NonEmptyCandidates = [SelectionCandidate, ...SelectionCandidate[]];

/**
 * EVERY candidate row for an explicitly named model or catalog row key, in the listing's own order.
 *
 * `resolveCandidate` below takes the first of these and is what a fresh decision uses. A RESUME needs
 * the whole list instead (`resumeChildSelection`): its question is not "which row would we pick now"
 * but "is the row this child is RECORDED on still servable", and those differ the moment one provider
 * serves two rows for one canonical model. Review r1's M1 is exactly that difference — the old code
 * compared against the first row and called it a provider check, which the provider pin had already
 * guaranteed.
 */
export function resolveCandidateRows(input: SelectionInput & { requested: { model: string } }): NonEmptyCandidates | SelectionRefusal {
  const resolved = resolveModel(input.families, input.requested.model);
  if (isRefusal(resolved)) return resolved;
  const candidates = candidatesFor(input.families, resolved.familyId, resolved.canonicalModelId, input);
  const [first, ...rest] = candidates;
  if (first === undefined) {
    return refuse("slot-unservable", unservableDetail(`the model ${JSON.stringify(input.requested.model)} (${resolved.familyId}/${resolved.canonicalModelId})`, input));
  }
  return [first, ...rest];
}

export function resolveCandidate(input: SelectionInput): SelectionCandidate | SelectionRefusal {
  const listing = input.families;
  if (input.requested.slot !== undefined) {
    const resolved = resolveSlot(listing, input.requested.slot);
    if (isRefusal(resolved)) return resolved;
    const candidates = candidatesFor(listing, resolved.familyId, resolved.canonicalModelId, input);
    const first = candidates[0];
    if (first !== undefined) return first;
    return refuse("slot-unservable", unservableDetail(`the slot ${JSON.stringify(input.requested.slot)} (${resolved.familyId}/${resolved.canonicalModelId})`, input));
  }
  if (input.requested.model !== undefined) {
    const rows = resolveCandidateRows({ ...input, requested: { ...input.requested, model: input.requested.model } });
    if (isRefusal(rows)) return rows;
    return rows[0];
  }
  const active = listing.active;
  if (active === undefined) {
    return refuse("slot-unservable", "this session names no slot, model or provider and its listing has no active slot set to fall back on");
  }
  for (const slot of active.slots) {
    const candidates = candidatesFor(listing, active.family, slot.canonicalModelId, input);
    const first = candidates[0];
    if (first !== undefined) return first;
  }
  return refuse("slot-unservable", unservableDetail(`this session's active slot set (${active.family}: ${active.slots.map((s) => s.name).join(", ") || "no slots"})`, input));
}

function unservableDetail(subject: string, input: SelectionInput): string {
  const pinned = input.requested.provider === undefined ? "" : ` pinned to the provider ${JSON.stringify(input.requested.provider)} and`;
  const configured = Object.keys(input.credentials.byProvider).sort();
  return `${subject} is${pinned} served by no row this session can use: every candidate row was blocked, deprecated, known-unservable, or belongs to a provider with no configured credential ref (configured: ${configured.length === 0 ? "none" : configured.join(", ")})`;
}

// --- the decision -------------------------------------------------------------------------------

function versionFor(kind: RuntimeSelection["runtimeKind"], versions: SelectionVersions | undefined): string {
  const raw = kind === "claude-agent" ? versions?.claudeSdkVersion : versions?.winterSdkVersion;
  return raw ?? UNKNOWN_VERSION;
}

function record(
  kind: RuntimeSelection["runtimeKind"],
  rule: SelectionRuleId,
  candidate: SelectionCandidate,
  input: Pick<SelectionInput, "versions" | "now">,
): RuntimeSelection {
  const engineVersion = input.versions?.engineVersion;
  return {
    runtimeKind: kind,
    providerId: candidate.row.providerId,
    // ROW 17: the PROVIDER-QUALIFIED catalog key, never the raw model id. Two rows sharing a raw id
    // behind different providers must not produce the same `modelRef`, because this field is what a
    // resume re-resolves and what a credential lookup is keyed beside.
    modelRef: candidate.row.key,
    family: candidate.family,
    authFamily: candidate.auth.authFamily,
    sdkVersion: versionFor(kind, input.versions),
    ...(engineVersion === undefined ? {} : { engineVersion }),
    reason: reasonFor(rule),
    decidedAt: input.now ?? new Date().toISOString(),
  };
}

/**
 * The D13/D28 table itself, over an already-resolved candidate.
 *
 * Exported because both entry points evaluate the SAME table — R-7b-1's "a child runs on the runtime
 * its OWN slot's family selects under D13/D28" is implemented by calling this with the child's own
 * candidate, not by a second table that would drift from this one.
 */
export function decideRuntime(candidate: SelectionCandidate, input: SelectionInput): RuntimeSelection | SelectionRefusal {
  const { authFamily } = candidate.auth;

  // D13 ROW 1 — Claude OAuth. Checked FIRST because it is unconditional in one direction and
  // impossible in the other: it "always" routes to the official SDK (WS-13 §9) and it "never routes
  // to winter" (WS-13c §0, D28). Every failure below is therefore a refusal, never a fallback.
  if (authFamily === "claude-oauth") {
    if (candidate.family !== CLAUDE_FAMILY_ID) {
      return refuse("slot-unservable", `the row ${candidate.row.key} is in the ${candidate.family} family but its provider's configured credential is a Claude OAuth credential, which serves no other family`);
    }
    // The ship gate first: WS-15 §2's mode rule is written "Claude OAuth is Code-only EVEN AFTER D14
    // approval", so approval is the earlier question.
    if (!input.claudeOauthApproved) {
      return refuse("claude-oauth-not-approved", `${candidate.row.key} would run on the official runtime under a Claude OAuth credential, which is ship-gated pending written approval (WS-14 §12, D14); configure an API key, a cloud credential chain or a gateway credential for this provider`);
    }
    if (input.mode !== "code") {
      return refuse("mode-forbids-runtime", `a Claude OAuth credential is Code-only even after D14 approval (WS-15 §2), and this session's mode is ${input.mode}; it cannot fall back to the Winter runtime, which a Claude OAuth credential never routes to (D28)`);
    }
    if (!input.hasClaudePeer) {
      return refuse("runtime-unavailable", `${candidate.row.key} must run on the official runtime under a Claude OAuth credential, and this router holds no official runtime; a Claude OAuth credential never routes to the Winter runtime (D28)`);
    }
    return record("claude-agent", "D13-1", candidate, input);
  }

  if (candidate.family === CLAUDE_FAMILY_ID) {
    // D4/D13 row 3: Dispatch and Chat are Winter-only, in-daemon — categorically, before any
    // question about the backend. Every other auth family CAN run on Winter, so this is a route.
    if (input.mode !== "code") return record("winter-agent", "D13-3-mode", candidate, input);
    if (!officialServesBackend(candidate.row.providerId, candidate.auth)) {
      return record("winter-agent", "D13-3-endpoint", candidate, input);
    }
    // The backend is one the official branch serves and the mode allows it — so the only remaining
    // question is whether this router HOLDS that runtime. R-7b-1: "else the Winter runtime through
    // WS-13c §4's order".
    if (!input.hasClaudePeer) return record("winter-agent", "R-7b-1-no-peer", candidate, input);
    return record("claude-agent", "D13-2", candidate, input);
  }

  // D28: "Opus and Sonnet route there; Astra and Luna route to Winter."
  return record("winter-agent", "D28", candidate, input);
}

/**
 * D13/D28, pure — the router's runtime selection.
 *
 * Returns the PERSISTED record untouched when there is one, otherwise the row this session resolves
 * to plus the runtime the table picks, otherwise a typed refusal.
 */
export function selectRuntime(input: SelectionInput): RuntimeSelection | SelectionRefusal {
  // THE PERSISTED SELECTION WINS, BY IDENTITY. Nothing below this line runs for a session that
  // already has one — not even to check it, because checking is `reviewPersistedSelection`'s job and
  // a checker that could rewrite is a rewriter.
  if (input.persisted !== undefined) return input.persisted;
  const candidate = resolveCandidate(input);
  if (isRefusal(candidate)) return candidate;
  return decideRuntime(candidate, input);
}

// --- the persisted choice, reviewed but never rewritten -------------------------------------------

/**
 * What a fresh decision would say about a session that already has a persisted selection.
 *
 * `unchanged` — the table still picks the same runtime, provider and model. `handoff-required` — it
 * would pick something else: WS-00 §2's D13 says that change "is the certified handoff or a visible
 * fork, never a silent rewrite", so this is reported to the host (which renders the choice, R-7b-3)
 * and the persisted record is returned untouched either way. `fresh-refused` — the session's
 * persisted selection is no longer servable at all (a credential removed, a row withdrawn); the
 * record still stands, and the refusal says why a fresh decision could not be made.
 */
export type SelectionReview =
  | { kind: "unchanged"; selection: RuntimeSelection; fresh: RuntimeSelection }
  | { kind: "handoff-required"; persisted: RuntimeSelection; fresh: RuntimeSelection; changed: Array<"runtimeKind" | "providerId" | "modelRef" | "family" | "authFamily">; detail: string }
  | { kind: "fresh-refused"; persisted: RuntimeSelection; refusal: SelectionRefusal };

/**
 * Compares a session's persisted selection against what the table would decide today.
 *
 * NEVER RETURNS A REWRITTEN RECORD. Every branch carries the persisted object itself; `fresh` is
 * offered beside it as the *proposal* a handoff (WS-05 §12) or a visible fork would realise. The
 * host, not this function, decides what to do with a `handoff-required`.
 */
export function reviewPersistedSelection(input: SelectionInput & { persisted: RuntimeSelection }): SelectionReview {
  const persisted = input.persisted;
  // The fresh decision is made WITHOUT the persisted record — otherwise `selectRuntime` would just
  // hand it back and this function would compare a record to itself.
  const { persisted: _ignored, ...rest } = input;
  const fresh = selectRuntime(rest);
  if (isRefusal(fresh)) return { kind: "fresh-refused", persisted, refusal: fresh };
  const changed: Array<"runtimeKind" | "providerId" | "modelRef" | "family" | "authFamily"> = [];
  for (const field of ["runtimeKind", "providerId", "modelRef", "family", "authFamily"] as const) {
    if (persisted[field] !== fresh[field]) changed.push(field);
  }
  if (changed.length === 0) return { kind: "unchanged", selection: persisted, fresh };
  return {
    kind: "handoff-required",
    persisted,
    fresh,
    changed,
    detail: `this session is persisted on ${persisted.runtimeKind} (${persisted.modelRef}) and a fresh decision would choose ${fresh.runtimeKind} (${fresh.modelRef}); the difference is in ${changed.join(", ")}. Changing it is the certified handoff or a visible fork, never a silent rewrite (WS-00 §2, D13)`,
  };
}

// --- convenience ---------------------------------------------------------------------------------

/**
 * The version identities the constructor already measured, in the shape a selection stamps.
 *
 * `RuntimeSdk.versions` is a `VersionMatrixReport`; `SelectionInput.versions` is what the record
 * needs. This is the one-line bridge, so a host does not hand-copy two fields and get the second one
 * wrong for the runtime it did not test.
 */
export function selectionVersionsFrom(report: VersionMatrixReport): SelectionVersions {
  const claude = report.claudeAgentSdk?.packageVersion;
  return {
    winterSdkVersion: report.winterAgentSdk.packageVersion,
    ...(claude === undefined ? {} : { claudeSdkVersion: claude }),
  };
}
