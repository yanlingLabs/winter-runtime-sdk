// THE D13/D28 TABLE, ONE NAMED TEST PER BRANCH.
//
// The plan's Task 5 requires "every branch of the D13 table a named test", and `test/conformance/
// rows.test.ts` cites these titles by name — so a renamed test here fails the citation gate rather
// than quietly leaving a WS-17 row unproven.
//
// HERMETIC BY CONSTRUCTION: `selectRuntime` is pure. No server, no temp directory, no clock (every
// test passes `now`), no credential material anywhere in the fixtures.
import { describe, expect, test } from "bun:test";

import {
  authFamilyFromRefKind,
  D14_CLAUDE_OAUTH_APPROVED_DEFAULT,
  officialServesBackend,
  OFFICIAL_SERVED_AUTH_FAMILIES,
  reviewPersistedSelection,
  ruleIdOf,
  selectionVersionsFrom,
  selectRuntime,
  speaksAnthropicProtocol,
  UNKNOWN_VERSION,
} from "../../src/selection/select-runtime.ts";
import { isSelectionRefusal, SelectionRefusedError } from "../../src/selection/runtime-selection.ts";
import { createRuntimeSdk } from "../../src/sdk.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { RuntimeSelection, SelectionAuthFamily, SelectionInput, SelectionRefusal } from "../../src/selection/runtime-selection.ts";
import { claudeFamily, credentials, gptFamily, listing, NOW, PROVIDER_VIEWS, row, VERSIONS } from "./fixtures.ts";

/** A Code-mode session on the Claude family with an Anthropic API key — and the retired `hasClaudePeer: true`, which must change nothing (WS-23). */
function input(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    mode: "code",
    requested: { slot: "opus" },
    families: listing("claude"),
    credentials: credentials(["anthropic"]),
    hasClaudePeer: true,
    claudeOauthApproved: false,
    versions: VERSIONS,
    now: NOW,
    ...over,
  };
}

function selected(over: Partial<SelectionInput> = {}): RuntimeSelection {
  const result = selectRuntime(input(over));
  if (isSelectionRefusal(result)) throw new Error(`expected a selection, got a refusal: ${result.reason} — ${result.detail}`);
  return result;
}

function refused(over: Partial<SelectionInput> = {}): SelectionRefusal {
  const result = selectRuntime(input(over));
  if (!isSelectionRefusal(result)) throw new Error(`expected a refusal, got ${result.runtimeKind} (${result.modelRef})`);
  return result;
}

const oauth = { anthropic: { authFamily: "claude-oauth" as const, protocols: ["anthropic-messages"] } };
const consoleOauth = { anthropic: { authFamily: "console-oauth" as const, protocols: ["anthropic-messages"] } };

// WS-23: ONE RUNTIME. D13's two official rows are retired with the official runtime — a Claude OAuth
// credential is refused (it never routes to Winter, D28), and every row that used to go to the
// official runtime now selects Winter under R-7b-1, whatever the retired `hasClaudePeer`/
// `claudeOauthApproved` inputs say.
describe("D13 row 1 — Claude OAuth, retired with the official runtime (WS-23)", () => {
  test("a Claude OAuth credential is refused runtime-unavailable, approved or not, peer or not — never downgraded to Winter", () => {
    for (const claudeOauthApproved of [true, false]) {
      for (const hasClaudePeer of [true, false]) {
        const refusal = refused({ credentials: credentials(["anthropic"], oauth), claudeOauthApproved, hasClaudePeer });
        expect([claudeOauthApproved, hasClaudePeer, refusal.reason]).toEqual([claudeOauthApproved, hasClaudePeer, "runtime-unavailable"]);
        expect(refusal.detail).toContain("retired");
        expect(refusal.detail).toContain("D28");
      }
    }
  });

  test("…and in Dispatch and Chat too", () => {
    for (const mode of ["dispatch", "chat"] as const) {
      expect(refused({ mode, credentials: credentials(["anthropic"], oauth), claudeOauthApproved: true }).reason).toBe("runtime-unavailable");
    }
  });

  test("a Claude OAuth credential cannot serve a non-Claude family", () => {
    const refusal = refused({
      requested: { slot: "astra" },
      families: listing("gpt"),
      credentials: credentials(["openai"], { openai: { authFamily: "claude-oauth", protocols: ["openai-responses"] } }),
      claudeOauthApproved: true,
    });
    expect(refusal.reason).toBe("slot-unservable");
  });

  test("the D14 constant is still exported, and still closed", () => {
    expect(D14_CLAUDE_OAUTH_APPROVED_DEFAULT).toBe(false);
  });
});

describe("D13 row 2 — retired: the rows that went to the official runtime select Winter (WS-23)", () => {
  test("a Claude-family model on an Anthropic-protocol backend in Code mode selects Winter (R-7b-1), even with `hasClaudePeer: true`", () => {
    const selection = selected();
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.providerId).toBe("anthropic");
    expect(selection.modelRef).toBe("anthropic/claude-opus-5");
    expect(selection.family).toBe("claude");
    expect(selection.authFamily).toBe("api-key");
    expect(ruleIdOf(selection)).toBe("R-7b-1-no-peer");
  });

  test("a Console OAuth bearer on the Anthropic-dialect backend selects Winter", () => {
    const selection = selected({ credentials: credentials(["anthropic"], consoleOauth) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.authFamily).toBe("console-oauth");
    expect(ruleIdOf(selection)).toBe("R-7b-1-no-peer");
  });

  test("a cloud credential chain selects Winter too — the dialect distinction now only names the rule", () => {
    const selection = selected({ requested: { slot: "haiku", provider: "bedrock" }, credentials: credentials(["bedrock"]) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.authFamily).toBe("cloud-credential-chain");
    expect(speaksAnthropicProtocol("bedrock", PROVIDER_VIEWS["bedrock"]!)).toBe(false);
    expect(officialServesBackend("bedrock", PROVIDER_VIEWS["bedrock"]!)).toBe(true);
  });

  test("the retired rule ids still read back from a persisted record", () => {
    const legacy: RuntimeSelection = { ...selected(), runtimeKind: "claude-agent", reason: "D13-2: persisted before WS-23" };
    expect(ruleIdOf(legacy)).toBe("D13-2");
  });
});

describe("D13 row 3 — the Winter runtime", () => {
  test("D13 row 3 — the same Claude model through a non-Anthropic-protocol endpoint routes to Winter", () => {
    const selection = selected({ requested: { slot: "opus", provider: "kie" }, credentials: credentials(["kie"]) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.providerId).toBe("kie");
    expect(selection.family).toBe("claude");
    expect(ruleIdOf(selection)).toBe("D13-3-endpoint");
  });

  test("D13 row 3 — a console-OAuth credential on a non-Anthropic-dialect backend routes to Winter", () => {
    // The protocol gate applies to `console-oauth` exactly as it does to `api-key`: a token-priced
    // bearer does not make an OpenAI-shaped reseller an Anthropic-protocol backend.
    const selection = selected({
      requested: { slot: "opus", provider: "kie" },
      credentials: credentials(["kie"], { kie: { authFamily: "console-oauth", protocols: ["openai-chat-completions"] } }),
    });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.authFamily).toBe("console-oauth");
    expect(ruleIdOf(selection)).toBe("D13-3-endpoint");
  });

  test("D13 row 3 — a console-OAuth Code session in Dispatch or Chat still runs on Winter", () => {
    for (const mode of ["dispatch", "chat"] as const) {
      const selection = selected({ mode, credentials: credentials(["anthropic"], consoleOauth) });
      expect(selection.runtimeKind).toBe("winter-agent");
      expect(selection.authFamily).toBe("console-oauth");
      expect(ruleIdOf(selection)).toBe("D13-3-mode");
    }
  });

  test("D13 row 3 — Dispatch and Chat run on Winter even on the Anthropic-protocol backend", () => {
    for (const mode of ["dispatch", "chat"] as const) {
      const selection = selected({ mode });
      expect(selection.runtimeKind).toBe("winter-agent");
      expect(ruleIdOf(selection)).toBe("D13-3-mode");
    }
  });
});

describe("D28 and R-7b-1's fallback leg", () => {
  test("D28 — a gpt-family slot routes to Winter even with an official peer present", () => {
    const selection = selected({ requested: { slot: "astra" }, families: listing("gpt"), credentials: credentials(["openai"]) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.family).toBe("gpt");
    expect(ruleIdOf(selection)).toBe("D28");
  });

  test("R-7b-1 — with no official peer a Claude-family Code session falls back to Winter's own order", () => {
    const selection = selected({ hasClaudePeer: false });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.providerId).toBe("anthropic");
    expect(ruleIdOf(selection)).toBe("R-7b-1-no-peer");
  });
});

describe("the persisted choice", () => {
  test("the persisted selection wins and is returned by identity, never re-decided", () => {
    const persisted: RuntimeSelection = {
      runtimeKind: "winter-agent",
      providerId: "kie",
      modelRef: "kie/claude-opus-5",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.0.2",
      reason: "recorded at session creation",
      decidedAt: "2026-09-01T00:00:00.000Z",
    };
    // Everything about the fresh inputs says "anthropic" — and the persisted record still comes back,
    // as the SAME OBJECT.
    const result = selectRuntime(input({ persisted }));
    expect(result).toBe(persisted);
  });

  test("a persisted selection that no longer matches a fresh decision is reported as handoff-required, not rewritten", () => {
    const persisted: RuntimeSelection = {
      runtimeKind: "winter-agent",
      providerId: "kie",
      modelRef: "kie/claude-opus-5",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.0.2",
      reason: "recorded at session creation",
      decidedAt: "2026-09-01T00:00:00.000Z",
    };
    const review = reviewPersistedSelection({ ...input(), persisted });
    expect(review.kind).toBe("handoff-required");
    if (review.kind !== "handoff-required") throw new Error("unreachable");
    expect(review.persisted).toBe(persisted);
    expect(review.fresh.runtimeKind).toBe("winter-agent");
    // WS-23: the runtime is the same (Winter) — only the row differs.
    expect(review.changed).toEqual(["providerId", "modelRef"]);
    expect(review.detail).toContain("never a silent rewrite");
  });

  test("a persisted selection the table still agrees with is reported unchanged", () => {
    const persisted = selected();
    const review = reviewPersistedSelection({ ...input(), persisted });
    expect(review.kind).toBe("unchanged");
    if (review.kind !== "unchanged") throw new Error("unreachable");
    expect(review.selection).toBe(persisted);
  });

  test("a persisted selection whose row is gone reviews as fresh-refused and still stands", () => {
    const persisted = selected();
    const review = reviewPersistedSelection({ ...input({ credentials: credentials([]) }), persisted });
    expect(review.kind).toBe("fresh-refused");
    if (review.kind !== "fresh-refused") throw new Error("unreachable");
    expect(review.persisted).toBe(persisted);
    // WS-18 W18-3 (P10b): a Claude row with catalog rows but none credentialed is now the structured
    // `no-credential` refusal, not the generic `slot-unservable` prose.
    expect(review.refusal.reason).toBe("no-credential");
  });
});

describe("WS-13c §4 resolution and its typed refusals", () => {
  test("a slot with no configured credential ref anywhere is refused no-credential, never a substitution", () => {
    const refusal = refused({ credentials: credentials([]) });
    expect(refusal.reason).toBe("no-credential");
    expect(refusal.detail).toContain("no configured credential ref");
  });

  test("a pinned provider narrows the candidate rows and never widens them", () => {
    // `agentrouter` has the row but no credential; the pin must refuse rather than fall to anthropic.
    const refusal = refused({ requested: { slot: "opus", provider: "agentrouter" }, credentials: credentials(["anthropic"]) });
    expect(refusal.reason).toBe("no-credential");
    expect(refusal.detail).toContain("agentrouter");
  });

  test("an unknown slot name refuses with the name it could not find", () => {
    const refusal = refused({ requested: { slot: "nonesuch" } });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.detail).toContain("nonesuch");
  });

  test("a slot name offered by two non-active families is ambiguous and the router refuses to choose", () => {
    const twinA = { ...claudeFamily, id: "twin-a", slots: [{ name: "shared", canonicalModelId: "claude-opus-5", description: "d", reason: "r" }] };
    const twinB = { ...gptFamily, id: "twin-b", slots: [{ name: "shared", canonicalModelId: "gpt-6-astra", description: "d", reason: "r" }] };
    const refusal = refused({ requested: { slot: "shared" }, families: listing(undefined, [twinA, twinB]) });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.detail).toContain("twin-a/shared");
    expect(refusal.detail).toContain("twin-b/shared");
  });

  test("D25's reserved slot names reach the claude family from a non-Claude active set", () => {
    const selection = selected({ requested: { slot: "sonnet" }, families: listing("gpt"), credentials: credentials(["anthropic"]) });
    expect(selection.family).toBe("claude");
    expect(selection.modelRef).toBe("anthropic/claude-sonnet-5");
  });

  test("a slot unique to one non-active family resolves to that family", () => {
    const selection = selected({ requested: { slot: "flash" }, families: listing("claude"), credentials: credentials(["google"]) });
    expect(selection.family).toBe("gemini");
    expect(selection.runtimeKind).toBe("winter-agent");
  });

  test("with nothing requested the session's active slot set decides, in the listing's own order", () => {
    const selection = selected({ requested: {} });
    // `fable` is the first active slot, so it wins over `opus` — the listing's order IS the order.
    expect(selection.modelRef).toBe("anthropic/claude-fable-5-1");
  });

  test("with nothing requested and no active slot set the selector refuses rather than guessing", () => {
    const refusal = refused({ requested: {}, families: listing(undefined) });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.detail).toContain("active slot set");
  });

  test("blocked, deprecated and known-unservable rows are filtered out of the candidate set", () => {
    const dead = {
      ...claudeFamily,
      models: [
        {
          canonicalModelId: "claude-opus-5",
          displayName: "Opus 5",
          rows: [
            row("anthropic/claude-opus-5", "anthropic", { status: "blocked" }),
            row("kie/claude-opus-5", "kie", { status: "deprecated" }),
            row("agentrouter/claude-opus-5", "agentrouter", { servable: "absent" }),
          ],
        },
      ],
    };
    const refusal = refused({ families: listing(undefined, [dead]), credentials: credentials(["anthropic", "kie", "agentrouter"]) });
    expect(refusal.reason).toBe("slot-unservable");
  });

  test("a servable:unknown row with a configured credential ref is still a candidate", () => {
    const unprobed = {
      ...claudeFamily,
      models: [{ canonicalModelId: "claude-opus-5", displayName: "Opus 5", rows: [row("anthropic/claude-opus-5", "anthropic", { servable: "unknown" })] }],
    };
    const selection = selected({ families: listing(undefined, [unprobed]) });
    expect(selection.modelRef).toBe("anthropic/claude-opus-5");
  });
});

describe("the structural rules", () => {
  test("no branch reads a raw model id — renaming every model id leaves the decision unchanged", () => {
    // The catalog's family ids stay; every canonical id and every row key becomes an opaque token. If
    // any branch matched on a model-id substring (WS-13 §9's explicit prohibition), the runtime would
    // move. Only `modelRef` — an identity, not a decision — is allowed to differ.
    const opaque = {
      ...claudeFamily,
      slots: [{ name: "opus", canonicalModelId: "zz-9-plural-z-alpha", description: "d", reason: "r" }],
      models: [{ canonicalModelId: "zz-9-plural-z-alpha", displayName: "opaque", rows: [row("anthropic/zz-9-plural-z-alpha", "anthropic")] }],
    };
    const baseline = selected();
    const renamed = selected({ families: listing(undefined, [opaque]) });
    expect(renamed.runtimeKind).toBe(baseline.runtimeKind);
    expect(renamed.family).toBe(baseline.family);
    expect(renamed.authFamily).toBe(baseline.authFamily);
    expect(ruleIdOf(renamed)).toBe(ruleIdOf(baseline));
    expect(renamed.modelRef).not.toBe(baseline.modelRef);
  });

  test("an OAuth family is never inferred from a credential ref kind — only ever declared", () => {
    for (const kind of ["keychain", "env", "inline", "file", "aws-default-chain", "none"] as const) {
      const family = authFamilyFromRefKind(kind);
      expect(family).not.toBe("claude-oauth");
      expect(family).not.toBe("console-oauth");
    }
    expect(authFamilyFromRefKind("aws-default-chain")).toBe("cloud-credential-chain");
    expect(authFamilyFromRefKind("none")).toBe("local-none");
    expect(authFamilyFromRefKind("file")).toBe("custom");
  });

  test("an undeclared provider is not treated as an Anthropic-protocol backend", () => {
    // Only `byProvider` — no `authByProvider` at all. The ref kind says `keychain`, which derives
    // `api-key`; the provider is unknown to the fallback list, so the backend is not official-served.
    const selection = selected({
      requested: { slot: "opus", provider: "kie" },
      credentials: { byProvider: { kie: "keychain" } },
    });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.authFamily).toBe("api-key");
    expect(ruleIdOf(selection)).toBe("D13-3-endpoint");
  });

  test("the undeclared-provider fallback still recognises the vendor's own provider id", () => {
    const selection = selected({ credentials: { byProvider: { anthropic: "keychain" } } });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(ruleIdOf(selection)).toBe("R-7b-1-no-peer");
  });

  test("every produced record names the rule that fired and carries an ISO decidedAt", () => {
    const selection = selected();
    expect(selection.reason.startsWith("R-7b-1-no-peer:")).toBe(true);
    expect(selection.reason.length).toBeGreaterThan("R-7b-1-no-peer:".length + 20);
    expect(selection.decidedAt).toBe(NOW);
    const { now: _now, ...withoutNow } = input();
    const unstamped = selectRuntime(withoutNow);
    if (isSelectionRefusal(unstamped)) throw new Error("unreachable");
    expect(Number.isNaN(Date.parse(unstamped.decidedAt))).toBe(false);
  });

  test("the record stamps the Winter SDK's version (the only runtime, WS-23), and unknown when none was given", () => {
    expect(selected().sdkVersion).toBe("0.0.2");
    expect(selected({ hasClaudePeer: false }).sdkVersion).toBe("0.0.2");
    expect(selected().engineVersion).toBe("2.1.250");
    const { versions: _versions, ...withoutVersions } = input();
    const bare = selectRuntime(withoutVersions);
    if (isSelectionRefusal(bare)) throw new Error("unreachable");
    expect(bare.sdkVersion).toBe(UNKNOWN_VERSION);
    expect("engineVersion" in bare).toBe(false);
  });

  test("the handle's selectRuntime throws the refusal that the function returns", () => {
    // The plan pins two signatures that disagree: the module function returns
    // `RuntimeSelection | SelectionRefusal`, the `RuntimeSdk` METHOD returns `RuntimeSelection` alone.
    // `SelectionRefusedError` is the reconciliation, and this is the test that it carries the refusal
    // verbatim rather than collapsing it into a message.
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain: createFakeKeychain() });
    const refusing = input({ credentials: credentials([]) });
    expect(() => sdk.selectRuntime(refusing)).toThrow(SelectionRefusedError);
    try {
      sdk.selectRuntime(refusing);
    } catch (error) {
      expect(error).toBeInstanceOf(SelectionRefusedError);
      expect((error as SelectionRefusedError).refusal).toEqual(refused({ credentials: credentials([]) }));
    }
    // …and the accepted path returns the record itself.
    expect(sdk.selectRuntime(input({ hasClaudePeer: false })).runtimeKind).toBe("winter-agent");
  });

  test("officialServesBackend agrees with OFFICIAL_SERVED_AUTH_FAMILIES for every auth family", () => {
    // M2: the served set has ONE home, and this is the test that keeps the predicate derived from it.
    // Anthropic-dialect and OpenAI-dialect views for each family, so the protocol gate is visible.
    const families: SelectionAuthFamily[] = ["api-key", "console-oauth", "cloud-credential-chain", "claude-oauth", "local-none", "custom"];
    for (const authFamily of families) {
      const anthropicDialect = { authFamily, protocols: ["anthropic-messages"] };
      const otherDialect = { authFamily, protocols: ["openai-chat-completions"] };
      const inSet = OFFICIAL_SERVED_AUTH_FAMILIES.includes(authFamily);
      expect({ authFamily, served: officialServesBackend("anthropic", anthropicDialect) }).toEqual({ authFamily, served: inSet });
      // Outside the set nothing is served at any dialect; inside it, only the two bearer families are
      // protocol-gated.
      const gated = authFamily === "api-key" || authFamily === "console-oauth";
      expect({ authFamily, served: officialServesBackend("kie", otherDialect) }).toEqual({ authFamily, served: inSet && !gated });
    }
    expect([...OFFICIAL_SERVED_AUTH_FAMILIES]).toEqual(["api-key", "console-oauth", "console-profile", "cloud-credential-chain", "claude-oauth"]);
  });

  test("ruleIdOf never returns an inherited property name for an untrusted persisted reason", () => {
    // M3: `in` walked the prototype chain, so a record off a host's durable store whose `reason` began
    // `toString:` came back as a SelectionRuleId. `Object.hasOwn` is the fix.
    const withReason = (reason: string): RuntimeSelection => ({ ...selected(), reason });
    for (const reason of ["toString: not a rule", "constructor: not a rule", "valueOf: nope", "hasOwnProperty: no", "unknown-id: x", "no-colon-at-all"]) {
      expect({ reason, id: ruleIdOf(withReason(reason)) }).toEqual({ reason, id: undefined });
    }
    expect(ruleIdOf(withReason("D13-2: real"))).toBe("D13-2");
  });

  test("selectionVersionsFrom carries the Winter peer's identity out of the constructor's matrix report", () => {
    const versions = selectionVersionsFrom({
      winterAgentSdk: { packageName: "w", packageVersion: "0.0.3", source: "peer-export", supported: ">=0.0.21 <0.1.0", protocolVersion: "1.0" },
      supported: { winterAgentSdk: ">=0.0.21 <0.1.0" },
      supportedProtocolVersions: ["1.0"],
      checkedAt: NOW,
    });
    expect(versions).toEqual({ winterSdkVersion: "0.0.3" });
  });
});

describe("WS-20 tags", () => {
  test("a bare model id is refused with reason bare-model-id", () => {
    const result = selectRuntime(input({ requested: { model: "gpt-5.6-terra" } }));
    expect(result).toMatchObject({ refused: true, reason: "bare-model-id" });
  });

  test("a tag resolves to exactly its own row even when a sibling provider serves the same model", () => {
    // `claude-opus-5` is one canonical id behind three provider rows in the fixture (row 17's own
    // point) — the TAG ALONE (no `provider` field) must land on `kie`'s row, never `anthropic`'s, even
    // though `anthropic` comes first in listing order and both are credentialed. REVIEW FIX: the tag's
    // own prefix pins the provider; a caller no longer has to repeat it in `requested.provider`.
    const result = selectRuntime(
      input({
        requested: { model: "kie/claude-opus-5" },
        credentials: credentials(["anthropic", "kie"]),
      }),
    );
    expect(result).toMatchObject({ modelRef: "kie/claude-opus-5", providerId: "kie" });
  });

  test("a request whose provider field disagrees with its model tag's prefix is refused provider-mismatch", () => {
    const result = selectRuntime(
      input({
        requested: { model: "kie/claude-opus-5", provider: "anthropic" },
        credentials: credentials(["anthropic", "kie"]),
      }),
    );
    expect(result).toMatchObject({ refused: true, reason: "provider-mismatch" });
  });

  // The `console` catalog provider is not part of the shared fixture, so these two tests build their
  // own family (a `claude-sonnet-5` row behind `console`) rather than editing `fixtures.ts`.
  const consoleFamily = {
    ...claudeFamily,
    models: claudeFamily.models.map((entry) =>
      entry.canonicalModelId === "claude-sonnet-5" ? { ...entry, rows: [...entry.rows, row("console/claude-sonnet-5", "console")] } : entry,
    ),
  };

  test("a console/<id> tag derives authFamily console-profile and selects the Winter runtime (WS-23)", () => {
    const result = selectRuntime(
      input({
        requested: { model: "console/claude-sonnet-5", provider: "console" },
        families: listing("claude", [consoleFamily, gptFamily]),
        // No declared `authByProvider` view for `console` — the ref kind alone is `custom`
        // (`authFamilyFromRefKind("file")`), and the override to `console-profile` must still fire.
        credentials: { byProvider: { console: "file" } },
      }),
    );
    expect(result).toMatchObject({ providerId: "console", authFamily: "console-profile", runtimeKind: "winter-agent" });
  });

  test("a console/<id> row with no console credential ref is not admitted — 'no ref, no candidate' still holds", () => {
    // The catalog provider override in `candidatesFor` fires only AFTER a declared auth view is found
    // (`providerAuthView` returning `undefined` still excludes the row before the override ever runs) —
    // WS-20 widens WHICH auth family a console row reports, never WHETHER it needs a configured ref.
    const result = selectRuntime(
      input({
        requested: { model: "console/claude-sonnet-5", provider: "console" },
        families: listing("claude", [consoleFamily, gptFamily]),
        credentials: credentials([]),
      }),
    );
    expect(isSelectionRefusal(result)).toBe(true);
  });
});
