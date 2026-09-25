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
// WS-23: ONE RUNTIME. The official runtime is retired, so the table never picks `claude-agent`: a
// Claude model routes to the Winter runtime (`R-7b-1-no-peer` in Code mode on a backend the official
// branch used to serve, the D13 row-3 ids otherwise), and a Claude OAuth credential — which never
// routes to Winter (D28) — is a typed refusal. `hasClaudePeer`/`claudeOauthApproved` are accepted and
// ignored. The retired rule ids (`D13-1`, `D13-2`) stay in `SELECTION_RULES` so a record a host
// persisted under one still reads back through `ruleIdOf`.
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
  SelectionAlternative,
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
 * D14's ship gate, as the shipped default. WS-23: nothing reads the gate any more (a Claude OAuth
 * credential is refused whatever it says); the constant stays exported for a host that still names it.
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
export const OFFICIAL_SERVED_AUTH_FAMILIES: readonly SelectionAuthFamily[] = ["api-key", "console-oauth", "console-profile", "cloud-credential-chain", "claude-oauth"];

// --- the rules, by id -----------------------------------------------------------------------------

/**
 * Every branch this selector can take, with the sentence a host renders.
 *
 * IDS RATHER THAN PROSE MATCHING. `RuntimeSelection.reason` is `"<id>: <text>"`, so a test asserts on
 * `D13-1` while a user reads the sentence, and rewording the sentence never breaks a test (nor does
 * a test pin prose a product person should be free to improve).
 */
export const SELECTION_RULES = {
  // RETIRED (WS-23): never decided any more; kept so a record persisted under either reads back.
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

/**
 * WS-13c §4 step 1 + step 2: the rows for a canonical id, filtered to what this session can serve.
 *
 * `tagProviderId` (REVIEW FIX, post-L2.1): the provider `resolveModel` read off the matched row's own
 * key, when the request named a tag. It pins the candidate set exactly the way an explicit
 * `requested.provider` does — the tag's prefix IS a provider pin, whether or not the request repeats
 * it in the `provider` field — but `requested.provider`, when present, wins (callers that mismatch the
 * two are refused earlier, in `resolveCandidateRows`, before this function ever runs).
 */
function candidatesFor(listing: ModelFamilyListing, familyId: string, canonicalModelId: string, input: SelectionInput | ChildLikeInput, tagProviderId?: string): SelectionCandidate[] {
  const family = familyById(listing, familyId);
  const model: ModelEntry | undefined = family?.models.find((entry) => entry.canonicalModelId === canonicalModelId);
  if (model === undefined) return [];
  const out: SelectionCandidate[] = [];
  const pinned = input.requested.provider ?? tagProviderId;
  for (const row of model.rows) {
    // A pinned provider narrows the candidate set; it never widens it and never substitutes.
    if (pinned !== undefined && row.providerId !== pinned) continue;
    // The catalog's own unservable statuses (WS-13c §4 step 1, `isSlotServableRow`).
    if (row.status === "blocked" || row.status === "deprecated") continue;
    // "we know there is none" excludes; "unknown" does not — a configured credential ref is the
    // admission test, and an unprobed provider with a ref is exactly the row a host wants offered.
    if (row.servable === "absent") continue;
    const declaredAuth = providerAuthView(row.providerId, input.credentials);
    // WS-13c §4 step 2: "filter by configured credential ref". No ref, no candidate — and never an
    // environment scan to find one (WS-14, Execution amendments — Phase 6).
    if (declaredAuth === undefined) continue;
    // WS-20: the `console` catalog provider IS the Anthropic Console arm — its auth family is the
    // provider's identity, never a credential-ref guess (`authFamilyFromRefKind` cannot spell
    // `console-profile`, by the same rule that keeps every other OAuth family undiscoverable). A
    // configured ref still admits the row; only the auth family it reports is overridden.
    const auth: ProviderAuthView = row.providerId === "console" ? { ...declaredAuth, authFamily: "console-profile" } : declaredAuth;
    out.push({ family: familyId, canonicalModelId, row, auth });
  }
  return out;
}

/**
 * WS-13c §4 step 1 ONLY — the rows for a canonical id that are not blocked, deprecated or KNOWN
 * absent, with NO credential filter. This is `candidatesFor`'s first half in isolation, kept as its
 * own function because W18-3's alternatives need exactly this list and nothing `candidatesFor` builds
 * from it (a `SelectionCandidate` needs an `auth` view, which is precisely the thing a row without a
 * credential does not have).
 */
function uncredentialedRowsFor(listing: ModelFamilyListing, familyId: string, canonicalModelId: string): ModelRow[] {
  const family = familyById(listing, familyId);
  const model: ModelEntry | undefined = family?.models.find((entry) => entry.canonicalModelId === canonicalModelId);
  if (model === undefined) return [];
  return model.rows.filter((row) => row.status !== "blocked" && row.status !== "deprecated" && row.servable !== "absent");
}

/** A short human label for a well-known Claude-serving provider id, never invented for an unknown one. */
function labelForProvider(providerId: string): string {
  switch (providerId) {
    case "bedrock":
      return "Amazon Bedrock";
    case "vertex":
      return "Google Vertex AI";
    case "openrouter":
      return "OpenRouter";
    default:
      return providerId;
  }
}

/**
 * W18-3's `alternatives`: every catalog row able to serve the requested canonical Claude model,
 * WHETHER OR NOT it is configured, grouped by provider and auth kind.
 *
 * ANTHROPIC IS THREE DOORS BEHIND ONE ROW (D13/D14/P10a), which a per-row auth view cannot express —
 * the catalog names one `anthropic` row for the model, and this package already owns the vocabulary
 * for its three auth kinds (`api-key`, `console-profile`, `claude-oauth`), so it is the one provider
 * this function names by id rather than by declared auth view. WS-23: two of them — the claude.ai
 * subscription door (a Claude OAuth credential) served only the retired official runtime and is never
 * listed.
 *
 * BEDROCK AND VERTEX ARE NAMED THE SAME WAY, for the same reason: WS-14 §12's own table is what makes
 * them `cloud-credential-chain` (`officialServesBackend`'s own comment names them as exactly that
 * table's rows), and that fact does not depend on whether THIS host happens to have one configured —
 * unlike a reseller row, there is nothing else it could mean.
 *
 * EVERY OTHER PROVIDER is named from `input.credentials.authByProvider`'s DECLARED view when a host
 * supplies one for it — NEVER used to decide whether the row is a candidate (that admission stays
 * `candidatesFor`'s `byProvider`-gated business); here it is read only for its label-worthy content.
 * Absent that, the auth kind is reported `"unknown"` rather than guessed: a host that wants a named
 * auth kind on the hint declares it, and this function never invents a credential shape a row might
 * not use.
 */
function claudeAlternatives(rows: readonly ModelRow[], input: Pick<SelectionInput, "credentials">): SelectionAlternative[] {
  const out: SelectionAlternative[] = [];
  const seen = new Set<string>();
  const push = (entry: SelectionAlternative): void => {
    const key = `${entry.providerId}/${entry.authKind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };
  for (const row of rows) {
    if (row.providerId === "anthropic") {
      push({ providerId: "anthropic", authKind: "api-key", label: "Anthropic API key" });
      push({ providerId: "anthropic", authKind: "console-profile", label: "Anthropic Console login" });
      continue;
    }
    if (row.providerId === "bedrock" || row.providerId === "vertex") {
      push({ providerId: row.providerId, authKind: "cloud-credential-chain", label: labelForProvider(row.providerId) });
      continue;
    }
    const declared = input.credentials.authByProvider?.[row.providerId];
    push({ providerId: row.providerId, authKind: declared?.authFamily ?? "unknown", label: labelForProvider(row.providerId) });
  }
  return out;
}

/**
 * W18-3: a Claude-family request with catalog rows but NO credentialed one among them is refused
 * `reason: "no-credential"`, with `alternatives` naming every door — never the generic
 * `slot-unservable` a host would have to parse prose to distinguish from "this model does not exist".
 *
 * `uncredentialed.length === 0` (every row for this model is blocked/deprecated/absent, or the model
 * simply has none) is NOT this case — that is still `slot-unservable`, because there is no door to
 * offer at all, which is a different fact from "doors exist and none is configured".
 */
function claudeNoCredentialRefusal(subject: string, uncredentialed: readonly ModelRow[], input: SelectionInput): SelectionRefusal | undefined {
  if (uncredentialed.length === 0) return undefined;
  const pinned = input.requested.provider === undefined ? "" : ` pinned to the provider ${JSON.stringify(input.requested.provider)} and`;
  return {
    refused: true,
    reason: "no-credential",
    detail: `${subject} is${pinned} served by ${uncredentialed.length === 1 ? "a row" : "rows"} with no configured credential ref: add one of the doors this refusal lists`,
    alternatives: claudeAlternatives(uncredentialed, input),
  };
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

/**
 * A catalog row key — a provider-qualified tag, WS-20's only spelling — resolved to the family that
 * owns it AND the provider of the one row the tag names.
 *
 * REVIEW FIX (post-L2.1): the tag alone must pin the provider. A caller that names
 * `"kie/claude-opus-5"` with no `requested.provider` must land on `kie`'s row, never on whichever row
 * the listing happens to order first — `providerId` here is what lets `resolveCandidateRows` narrow
 * `candidatesFor` to that one row even when the request's own `provider` field is absent.
 */
function resolveModel(listing: ModelFamilyListing, model: string): { familyId: string; canonicalModelId: string; providerId: string } | SelectionRefusal {
  // WS-20: `requested.model` is a provider-qualified tag ("<providerId>/<modelId>") or nothing at all.
  // A bare id (no `/`) is refused here, before any row is even looked at — never resolved by guessing
  // a provider, and never silently matched against a canonical id (WS-13c §5's OTHER spelling, which
  // this phase removes: two providers serving the same raw id must not resolve to "pick one").
  if (!model.includes("/")) {
    return refuse("bare-model-id", `${JSON.stringify(model)} is a bare model id; WS-20 requires a provider-qualified tag "<providerId>/<modelId>"`);
  }
  const hits: Array<{ familyId: string; canonicalModelId: string; providerId: string }> = [];
  for (const family of listing.families) {
    for (const entry of family.models) {
      const matched = entry.rows.find((row) => row.key === model);
      if (matched !== undefined) {
        hits.push({ familyId: family.id, canonicalModelId: entry.canonicalModelId, providerId: matched.providerId });
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
 * deterministic order (the listing's own row order; WS-20: a request always names its provider, so
 * order is never a tie-break). This package re-sorts nothing: the listing is produced by the code that
 * owns those rules, and a second ordering here would be a second answer.
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
  // REVIEW FIX (post-L2.1): a request naming BOTH a tag and a provider must agree with itself — the
  // tag's own prefix already IS the provider pin, so a `provider` field naming something else is a
  // self-contradicting request, never resolved by picking one side silently.
  if (input.requested.provider !== undefined && input.requested.provider !== resolved.providerId) {
    return refuse(
      "provider-mismatch",
      `the request's provider field (${JSON.stringify(input.requested.provider)}) names a different provider than its model tag's prefix (${JSON.stringify(input.requested.model)} names ${JSON.stringify(resolved.providerId)})`,
    );
  }
  const candidates = candidatesFor(input.families, resolved.familyId, resolved.canonicalModelId, input, resolved.providerId);
  const [first, ...rest] = candidates;
  if (first === undefined) {
    const subject = `the model ${JSON.stringify(input.requested.model)} (${resolved.familyId}/${resolved.canonicalModelId})`;
    // W18-3: a Claude row with catalog rows but none credentialed gets the structured refusal, not the
    // generic prose — but only when the pin (if any) admits it: a provider pinned to a row that is not
    // even in the catalog is still the generic "no such row" refusal.
    if (resolved.familyId === CLAUDE_FAMILY_ID) {
      const uncredentialed = uncredentialedRowsFor(input.families, resolved.familyId, resolved.canonicalModelId).filter(
        (row) => input.requested.provider === undefined || row.providerId === input.requested.provider,
      );
      const noCredential = claudeNoCredentialRefusal(subject, uncredentialed, input);
      if (noCredential !== undefined) return noCredential;
    }
    return refuse("slot-unservable", unservableDetail(subject, input));
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
    const subject = `the slot ${JSON.stringify(input.requested.slot)} (${resolved.familyId}/${resolved.canonicalModelId})`;
    if (resolved.familyId === CLAUDE_FAMILY_ID) {
      const uncredentialed = uncredentialedRowsFor(listing, resolved.familyId, resolved.canonicalModelId).filter(
        (row) => input.requested.provider === undefined || row.providerId === input.requested.provider,
      );
      const noCredential = claudeNoCredentialRefusal(subject, uncredentialed, input);
      if (noCredential !== undefined) return noCredential;
    }
    return refuse("slot-unservable", unservableDetail(subject, input));
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

function record(
  kind: "winter-agent",
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
    sdkVersion: input.versions?.winterSdkVersion ?? UNKNOWN_VERSION,
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

  // D13 ROW 1 — Claude OAuth. It "never routes to winter" (WS-13c §0, D28), and the official runtime
  // it "always" routed to is retired (WS-23), so every Claude OAuth candidate is a refusal — never a
  // fallback onto some other runtime or credential.
  if (authFamily === "claude-oauth") {
    if (candidate.family !== CLAUDE_FAMILY_ID) {
      return refuse("slot-unservable", `the row ${candidate.row.key} is in the ${candidate.family} family but its provider's configured credential is a Claude OAuth credential, which serves no other family`);
    }
    return refuse("runtime-unavailable", `${candidate.row.key} is configured with a Claude OAuth credential, which only the official Claude runtime could use — that runtime is retired (WS-23) and a Claude OAuth credential never routes to the Winter runtime (D28); configure an API key, a Console login, a cloud credential chain or a gateway credential for this provider`);
  }

  if (candidate.family === CLAUDE_FAMILY_ID) {
    // D4/D13 row 3: Dispatch and Chat are Winter-only, in-daemon — categorically, before any
    // question about the backend. Every other auth family CAN run on Winter, so this is a route.
    if (input.mode !== "code") return record("winter-agent", "D13-3-mode", candidate, input);
    if (!officialServesBackend(candidate.row.providerId, candidate.auth)) {
      return record("winter-agent", "D13-3-endpoint", candidate, input);
    }
    // The backend is one the official branch used to serve and the mode allowed it — and no router
    // holds that runtime any more (WS-23). R-7b-1: "else the Winter runtime through WS-13c §4's order".
    return record("winter-agent", "R-7b-1-no-peer", candidate, input);
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
  return { winterSdkVersion: report.winterAgentSdk.packageVersion };
}
