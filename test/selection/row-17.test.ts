// WS-17 §8 ROW 17 — "two identical raw model IDs behind different providers keep distinct
// provider-qualified identity/credentials/continuation/resume routes."
//
// THE SUBJECT IS REAL, not a contrived fixture: the generated catalog ships `claude-opus-5` as SIX
// rows behind six providers (`anthropic/claude-opus-5`, `kie/claude-opus-5`,
// `agentrouter/claude-opus-5`, …) — one canonical model id, one family, six different backends with
// six different credentials and, as it happens, two different WIRE DIALECTS. Three of them are in the
// fixture listing.
//
// FOUR CLAIMS, ONE PER PART OF THE ROW, and the fourth is the one that would actually hurt a user:
// a session recorded against one provider must never continue on another just because that other one
// still has a credential. The whole reason `RuntimeSelection.modelRef` is the PROVIDER-QUALIFIED
// catalog key rather than the raw model id is that a raw id cannot distinguish these rows at all —
// two sessions would persist byte-identical records and any resume would be a coin toss.
import { describe, expect, test } from "bun:test";

import { CHILD_PROVIDER_UNAVAILABLE, resumeChildSelection, selectChildRuntime } from "../../src/selection/child-runtime.ts";
import { isSelectionRefusal } from "../../src/selection/runtime-selection.ts";
import type { RuntimeSelection, SelectionInput } from "../../src/selection/runtime-selection.ts";
import { ruleIdOf, selectRuntime } from "../../src/selection/select-runtime.ts";
import { claudeFamily, credentials, listing, NOW, VERSIONS } from "./fixtures.ts";

/** The one canonical id three providers in the fixture all serve. */
const RAW_ID = "claude-opus-5";

function on(provider: string, over: Partial<SelectionInput> = {}): RuntimeSelection {
  const result = selectRuntime({
    mode: "code",
    requested: { model: RAW_ID, provider },
    families: listing("claude"),
    credentials: credentials([provider]),
    hasClaudePeer: true,
    claudeOauthApproved: false,
    versions: VERSIONS,
    now: NOW,
    ...over,
  });
  if (isSelectionRefusal(result)) throw new Error(`expected a selection on ${provider}, got ${result.reason} — ${result.detail}`);
  return result;
}

describe("WS-17 row 17 — one raw model id, three providers", () => {
  test("row 17 — the fixture really is one raw model id behind several providers", () => {
    const model = claudeFamily.models.find((entry) => entry.canonicalModelId === RAW_ID);
    if (model === undefined) throw new Error("fixture: the row-17 model is missing");
    expect(model.rows.length).toBeGreaterThanOrEqual(3);
    expect(new Set(model.rows.map((r) => r.providerId)).size).toBe(model.rows.length);
    // Every row's key is provider-qualified; none of them IS the raw id.
    for (const r of model.rows) {
      expect(r.key).toContain(RAW_ID);
      expect(r.key).not.toBe(RAW_ID);
      expect(r.key.startsWith(`${r.providerId}/`)).toBe(true);
    }
  });

  test("row 17 identity — two selections of the same raw id keep distinct provider-qualified identities", () => {
    const vendor = on("anthropic");
    const reseller = on("kie");
    const other = on("agentrouter");

    // Same family, same underlying model, three DIFFERENT identities.
    expect(vendor.family).toBe(reseller.family);
    expect(vendor.family).toBe("claude");
    expect(new Set([vendor.providerId, reseller.providerId, other.providerId]).size).toBe(3);
    expect(new Set([vendor.modelRef, reseller.modelRef, other.modelRef]).size).toBe(3);
    // The raw id is never what gets persisted as the identity.
    for (const selection of [vendor, reseller, other]) expect(selection.modelRef).not.toBe(RAW_ID);
  });

  test("row 17 credentials — each row is admitted by ITS OWN provider's credential ref, never a sibling's", () => {
    // Only the reseller has a credential: the vendor's row is not selectable at all, even though the
    // raw model id is present in the listing and one of its rows is perfectly servable.
    const onlyReseller = selectRuntime({
      mode: "code",
      requested: { model: RAW_ID, provider: "anthropic" },
      families: listing("claude"),
      credentials: credentials(["kie"]),
      hasClaudePeer: true,
      claudeOauthApproved: false,
      now: NOW,
    });
    expect(isSelectionRefusal(onlyReseller)).toBe(true);
    if (!isSelectionRefusal(onlyReseller)) throw new Error("unreachable");
    expect(onlyReseller.reason).toBe("slot-unservable");

    // And the auth view a selection records is its own provider's, not the family's.
    expect(on("anthropic").authFamily).toBe("api-key");
    expect(on("bedrock", { requested: { model: "claude-haiku-4.5", provider: "bedrock" }, credentials: credentials(["bedrock"]) }).authFamily).toBe("cloud-credential-chain");
  });

  test("row 17 continuation — the same raw id routes to DIFFERENT runtimes depending on the provider", () => {
    // This is the sharpest form of "distinct routes": identical model, identical family, identical
    // mode — and the runtime the session will live on differs, because the backend differs.
    const vendor = on("anthropic");
    const reseller = on("kie");
    expect(vendor.runtimeKind).toBe("claude-agent");
    expect(ruleIdOf(vendor)).toBe("D13-2");
    expect(reseller.runtimeKind).toBe("winter-agent");
    expect(ruleIdOf(reseller)).toBe("D13-3-endpoint");
  });

  test("row 17 resume — a record on one provider never resumes onto its twin behind another provider", () => {
    const recorded = on("kie");
    const context = {
      mode: "code" as const,
      families: listing("claude"),
      // The recorded provider's credential is gone; its TWIN's is present.
      credentials: credentials(["anthropic"]),
      hasClaudePeer: true,
      claudeOauthApproved: false,
      versions: VERSIONS,
      now: NOW,
    };
    const outcome = resumeChildSelection(recorded, context);
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain(CHILD_PROVIDER_UNAVAILABLE);
    expect(outcome.reason).toContain("kie");

    // With its own credential back, the same record resumes — onto itself, unchanged.
    const restored = resumeChildSelection(recorded, { ...context, credentials: credentials(["anthropic", "kie"]) });
    expect(restored.kind).toBe("resumed");
    if (restored.kind !== "resumed") throw new Error("unreachable");
    expect(restored.selection).toBe(recorded);
    expect(restored.selection.providerId).toBe("kie");
    expect(restored.selection.modelRef).toBe("kie/claude-opus-5");
  });

  test("row 17 — two children on the same raw id under one parent stay two distinct records", () => {
    const parent = on("anthropic");
    const childContext = {
      mode: "code" as const,
      families: listing("claude"),
      credentials: credentials(["anthropic", "kie"]),
      hasClaudePeer: true,
      claudeOauthApproved: false,
      versions: VERSIONS,
      now: NOW,
    };
    const viaVendor = selectChildRuntime(parent, { ...childContext, model: RAW_ID, provider: "anthropic" });
    const viaReseller = selectChildRuntime(parent, { ...childContext, model: RAW_ID, provider: "kie" });
    if (isSelectionRefusal(viaVendor) || isSelectionRefusal(viaReseller)) throw new Error("unreachable");
    expect(viaVendor.modelRef).not.toBe(viaReseller.modelRef);
    expect(viaVendor.providerId).not.toBe(viaReseller.providerId);
    // …and they even land on different runtimes, so the directory has two genuinely different objects.
    expect(viaVendor.runtimeKind).toBe("claude-agent");
    expect(viaReseller.runtimeKind).toBe("winter-agent");
  });
});
