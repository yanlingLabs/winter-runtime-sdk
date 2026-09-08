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
  reviewPersistedSelection,
  ruleIdOf,
  selectionVersionsFrom,
  selectRuntime,
  speaksAnthropicProtocol,
  UNKNOWN_VERSION,
} from "../../src/selection/select-runtime.ts";
import { isSelectionRefusal } from "../../src/selection/runtime-selection.ts";
import type { RuntimeSelection, SelectionInput, SelectionRefusal } from "../../src/selection/runtime-selection.ts";
import { claudeFamily, credentials, gptFamily, listing, NOW, PROVIDER_VIEWS, row, VERSIONS } from "./fixtures.ts";

/** A Code-mode session on the Claude family with an Anthropic API key and an official peer present. */
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

describe("D13 row 1 — Claude OAuth", () => {
  test("D13 row 1 — a Claude OAuth credential routes to the official runtime, always", () => {
    const selection = selected({ credentials: credentials(["anthropic"], oauth), claudeOauthApproved: true });
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.authFamily).toBe("claude-oauth");
    expect(ruleIdOf(selection)).toBe("D13-1");
  });

  test("D13 row 1 — Claude OAuth with the D14 ship gate closed is refused, never downgraded to Winter", () => {
    const refusal = refused({ credentials: credentials(["anthropic"], oauth), claudeOauthApproved: false });
    expect(refusal.reason).toBe("claude-oauth-not-approved");
    expect(refusal.detail).toContain("ship-gated");
  });

  test("D13 row 1 — Claude OAuth outside Code mode is refused: Code-only even after D14 approval", () => {
    for (const mode of ["dispatch", "chat"] as const) {
      const refusal = refused({ mode, credentials: credentials(["anthropic"], oauth), claudeOauthApproved: true });
      expect(refusal.reason).toBe("mode-forbids-runtime");
      expect(refusal.detail).toContain(mode);
    }
  });

  test("D13 row 1 — Claude OAuth with no official peer is refused, because it never routes to Winter", () => {
    const refusal = refused({ credentials: credentials(["anthropic"], oauth), claudeOauthApproved: true, hasClaudePeer: false });
    expect(refusal.reason).toBe("runtime-unavailable");
  });

  test("D13 row 1 — a Claude OAuth credential cannot serve a non-Claude family", () => {
    const refusal = refused({
      requested: { slot: "astra" },
      families: listing("gpt"),
      credentials: credentials(["openai"], { openai: { authFamily: "claude-oauth", protocols: ["openai-responses"] } }),
      claudeOauthApproved: true,
    });
    expect(refusal.reason).toBe("slot-unservable");
  });

  test("the D14 ship gate ships closed — the shipped default flag refuses a Claude OAuth session", () => {
    expect(D14_CLAUDE_OAUTH_APPROVED_DEFAULT).toBe(false);
    const refusal = refused({ credentials: credentials(["anthropic"], oauth), claudeOauthApproved: D14_CLAUDE_OAUTH_APPROVED_DEFAULT });
    expect(refusal.reason).toBe("claude-oauth-not-approved");
  });
});

describe("D13 row 2 — the official runtime", () => {
  test("D13 row 2 — a Claude-family model on an Anthropic-protocol backend in Code mode routes to the official runtime", () => {
    const selection = selected();
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.providerId).toBe("anthropic");
    expect(selection.modelRef).toBe("anthropic/claude-opus-5");
    expect(selection.family).toBe("claude");
    expect(selection.authFamily).toBe("api-key");
    expect(ruleIdOf(selection)).toBe("D13-2");
  });

  test("D13 row 2 — a cloud credential chain is a backend the official branch serves, dialect notwithstanding", () => {
    // Bedrock's catalog dialect is `bedrock-converse`, NOT the Anthropic one — it reaches the official
    // branch through WS-14 §12's auth table, which is the distinction this test pins.
    const selection = selected({ requested: { slot: "haiku", provider: "bedrock" }, credentials: credentials(["bedrock"]) });
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.authFamily).toBe("cloud-credential-chain");
    expect(speaksAnthropicProtocol("bedrock", PROVIDER_VIEWS["bedrock"]!)).toBe(false);
    expect(officialServesBackend("bedrock", PROVIDER_VIEWS["bedrock"]!)).toBe(true);
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

  test("D13 row 3 — a console-OAuth Anthropic credential is not a family the official branch serves", () => {
    const selection = selected({ credentials: credentials(["anthropic"], { anthropic: { authFamily: "console-oauth", protocols: ["anthropic-messages"] } }) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(ruleIdOf(selection)).toBe("D13-3-endpoint");
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
    // Everything about the fresh inputs says "official runtime, anthropic" — and the persisted record
    // still comes back, as the SAME OBJECT.
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
    expect(review.fresh.runtimeKind).toBe("claude-agent");
    expect(review.changed).toEqual(["runtimeKind", "providerId", "modelRef"]);
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
    expect(review.refusal.reason).toBe("slot-unservable");
  });
});

describe("WS-13c §4 resolution and its typed refusals", () => {
  test("a slot with no configured credential ref anywhere is slot-unservable, never a substitution", () => {
    const refusal = refused({ credentials: credentials([]) });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.detail).toContain("no configured credential ref");
  });

  test("a pinned provider narrows the candidate rows and never widens them", () => {
    // `agentrouter` has the row but no credential; the pin must refuse rather than fall to anthropic.
    const refusal = refused({ requested: { slot: "opus", provider: "agentrouter" }, credentials: credentials(["anthropic"]) });
    expect(refusal.reason).toBe("slot-unservable");
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
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(ruleIdOf(selection)).toBe("D13-2");
  });

  test("every produced record names the rule that fired and carries an ISO decidedAt", () => {
    const selection = selected();
    expect(selection.reason.startsWith("D13-2:")).toBe(true);
    expect(selection.reason.length).toBeGreaterThan("D13-2:".length + 20);
    expect(selection.decidedAt).toBe(NOW);
    const { now: _now, ...withoutNow } = input();
    const unstamped = selectRuntime(withoutNow);
    if (isSelectionRefusal(unstamped)) throw new Error("unreachable");
    expect(Number.isNaN(Date.parse(unstamped.decidedAt))).toBe(false);
  });

  test("the record stamps the SDK version of the runtime it chose, and unknown when none was given", () => {
    expect(selected().sdkVersion).toBe("0.3.250");
    expect(selected({ hasClaudePeer: false }).sdkVersion).toBe("0.0.2");
    expect(selected().engineVersion).toBe("2.1.250");
    const { versions: _versions, ...withoutVersions } = input();
    const bare = selectRuntime(withoutVersions);
    if (isSelectionRefusal(bare)) throw new Error("unreachable");
    expect(bare.sdkVersion).toBe(UNKNOWN_VERSION);
    expect("engineVersion" in bare).toBe(false);
  });

  test("selectionVersionsFrom carries both peer identities out of the constructor's matrix report", () => {
    const versions = selectionVersionsFrom({
      winterAgentSdk: { packageName: "w", packageVersion: "0.0.2", source: "peer-export", supported: ">=0.0.2 <0.1.0", protocolVersion: "1.0" },
      claudeAgentSdk: { packageName: "c", packageVersion: "0.3.250", source: "peer-export", supported: "0.3.250" },
      supported: { winterAgentSdk: ">=0.0.2 <0.1.0", claudeAgentSdk: "0.3.250" },
      supportedProtocolVersions: ["1.0"],
      checkedAt: NOW,
    });
    expect(versions).toEqual({ winterSdkVersion: "0.0.2", claudeSdkVersion: "0.3.250" });
  });
});
