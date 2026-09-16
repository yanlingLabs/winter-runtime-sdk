// WS-18 W18-3 / P10b-6 R3 — THE STRUCTURED NO-CREDENTIAL REFUSAL.
//
// W18-2's decision table: a Claude-family model with an Anthropic API key or a Console profile, or a
// Bedrock/Vertex cloud credential chain, runs on the official branch; one reachable only through a
// host the official SDK cannot speak to (OpenRouter, …) runs on Winter (D13 row 3, unchanged); with
// NONE of those, the router refuses `reason: "no-credential"` rather than the generic
// `slot-unservable` prose — with `alternatives` naming every door, so the daemon's hint is built FROM
// this list and never from a hardcoded provider list (W18-3).
//
// THE FIXTURE NAMES FOUR DOORS ON ONE CANONICAL MODEL (anthropic, bedrock, vertex, openrouter) because
// the shared `claudeFamily` fixture spreads its providers across several models (row 17's own point) —
// a single model with all four keeps every test in this file about ONE row set.
import { describe, expect, test } from "bun:test";
import type { ModelFamilyListing } from "@yanlinglabs/winter-agent-sdk";

import { isSelectionRefusal } from "../../src/selection/runtime-selection.ts";
import type { RuntimeSelection, SelectionAlternative, SelectionInput, SelectionRefusal } from "../../src/selection/runtime-selection.ts";
import { selectRuntime } from "../../src/selection/select-runtime.ts";
import { claudeFamily, credentials, NOW, row, VERSIONS } from "./fixtures.ts";

const FOUR_DOOR_MODEL = "claude-opus-5-four-door";

const fourDoorClaudeFamily: ModelFamilyListing["families"][number] = {
  ...claudeFamily,
  // WS-20: `requested.model` must be a provider-qualified tag, which can only ever name ONE row — this
  // fixture is deliberately about ALL FOUR doors for one canonical model, so it is reached the same way
  // any other multi-row canonical id is: a slot name, not a bare model id.
  slots: [...claudeFamily.slots, { name: "four-door", canonicalModelId: FOUR_DOOR_MODEL, description: "the four-door fixture slot", reason: "fixture: four-door" }],
  models: [
    ...claudeFamily.models,
    {
      canonicalModelId: FOUR_DOOR_MODEL,
      displayName: "Opus 5 (four-door fixture)",
      rows: [
        row("anthropic/claude-opus-5-four-door", "anthropic"),
        row("bedrock/anthropic.claude-opus-5-four-door", "bedrock"),
        row("vertex/claude-opus-5-four-door", "vertex"),
        row("openrouter/claude-opus-5-four-door", "openrouter"),
      ],
    },
  ],
};

const fourDoorListing: ModelFamilyListing = { active: undefined, families: [fourDoorClaudeFamily] };

function input(over: Partial<SelectionInput> = {}): SelectionInput {
  return {
    mode: "code",
    requested: { slot: "four-door" },
    families: fourDoorListing,
    credentials: credentials([]),
    hasClaudePeer: true,
    claudeOauthApproved: false,
    versions: VERSIONS,
    now: NOW,
    ...over,
  };
}

function refused(over: Partial<SelectionInput> = {}): SelectionRefusal {
  const result = selectRuntime(input(over));
  if (!isSelectionRefusal(result)) throw new Error(`expected a refusal, got ${result.runtimeKind} (${result.modelRef})`);
  return result;
}

function selected(over: Partial<SelectionInput> = {}): RuntimeSelection {
  const result = selectRuntime(input(over));
  if (isSelectionRefusal(result)) throw new Error(`expected a selection, got a refusal: ${result.reason} — ${result.detail}`);
  return result;
}

const key = (alt: SelectionAlternative): string => `${alt.providerId}/${alt.authKind}`;

describe("WS-18 W18-3 — the structured no-credential refusal", () => {
  test("a Claude model with no credential anywhere refuses no-credential, with every door listed", () => {
    const refusal = refused();
    expect(refusal.reason).toBe("no-credential");
    expect(refusal.alternatives).toBeDefined();
    const alternatives = refusal.alternatives ?? [];
    const keys = alternatives.map(key);
    expect(keys).toContain("anthropic/api-key");
    expect(keys).toContain("anthropic/console-profile");
    expect(keys).toContain("bedrock/cloud-credential-chain");
    expect(keys).toContain("vertex/cloud-credential-chain");
    // OpenRouter has no declared auth view in this fixture (nothing configured, nothing descriptive
    // supplied) — it is still LISTED, with an honestly unknown auth kind rather than an invented one.
    expect(alternatives.some((a) => a.providerId === "openrouter")).toBe(true);
    // The labels a host renders verbatim — literal, human names, not raw provider ids.
    const labels = alternatives.map((a) => a.label);
    expect(labels).toContain("Anthropic API key");
    expect(labels).toContain("Anthropic Console login");
    expect(labels).toContain("Amazon Bedrock");
    expect(labels).toContain("Google Vertex AI");
    expect(labels).toContain("OpenRouter");
    // NEVER the claude.ai subscription without the approval input (the next test proves the flip).
    expect(keys).not.toContain("anthropic/claude-oauth");
  });

  test("the claude.ai subscription alternative is present ONLY when the D14 approval input is true", () => {
    const closed = refused({ claudeOauthApproved: false });
    expect((closed.alternatives ?? []).some((a) => a.providerId === "anthropic" && a.authKind === "claude-oauth")).toBe(false);

    const open = refused({ claudeOauthApproved: true });
    const subscription = (open.alternatives ?? []).find((a) => a.providerId === "anthropic" && a.authKind === "claude-oauth");
    expect(subscription).toBeDefined();
    expect(subscription?.label).toContain("subscription");
  });

  test("an OpenRouter credential alone is servable — on the WINTER runtime (D13 row 3), never refused", () => {
    const selection = selected({ credentials: credentials(["openrouter"], { openrouter: { authFamily: "api-key", protocols: ["openai-chat-completions"] } }) });
    expect(selection.runtimeKind).toBe("winter-agent");
    expect(selection.providerId).toBe("openrouter");
    expect(selection.family).toBe("claude");
  });

  test("a Bedrock credential alone routes to the OFFICIAL runtime (R-10b-6, cloud-credential-chain is served unconditionally)", () => {
    const selection = selected({ credentials: credentials(["bedrock"]) });
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.providerId).toBe("bedrock");
    expect(selection.authFamily).toBe("cloud-credential-chain");
  });

  test("a Vertex credential alone routes to the OFFICIAL runtime (R-10b-6, cloud-credential-chain is served unconditionally)", () => {
    const selection = selected({ credentials: credentials(["vertex"]) });
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.providerId).toBe("vertex");
    expect(selection.authFamily).toBe("cloud-credential-chain");
  });

  test("an Anthropic API key alone routes to the OFFICIAL runtime (D13 row 2) — the ordinary case, unaffected by W18-3", () => {
    const selection = selected({ credentials: credentials(["anthropic"]) });
    expect(selection.runtimeKind).toBe("claude-agent");
    expect(selection.providerId).toBe("anthropic");
  });

  test("a model with no catalog rows at all (every row blocked) is still the generic slot-unservable — nothing to list", () => {
    const noRowsListing: ModelFamilyListing = {
      active: undefined,
      families: [
        {
          ...claudeFamily,
          models: [{ canonicalModelId: "claude-blocked-only", displayName: "Blocked only", rows: [row("anthropic/claude-blocked-only", "anthropic", { status: "blocked" })] }],
        },
      ],
    };
    const refusal = refused({ requested: { model: "anthropic/claude-blocked-only" }, families: noRowsListing });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.alternatives).toBeUndefined();
  });

  test("a non-Claude family with no credential keeps the generic slot-unservable — W18-3 is Claude-specific", () => {
    const geminiOnly: ModelFamilyListing = {
      active: undefined,
      families: [{ id: "gemini", displayName: "Gemini", vendor: "Google", slots: [], models: [{ canonicalModelId: "gemini-3-pro", displayName: "Gemini 3 Pro", rows: [row("google/gemini-3-pro", "google")] }] }],
    };
    const refusal = refused({ requested: { model: "google/gemini-3-pro" }, families: geminiOnly, credentials: credentials([]) });
    expect(refusal.reason).toBe("slot-unservable");
    expect(refusal.alternatives).toBeUndefined();
  });
});
