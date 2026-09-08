// R-7b-1 — THE CHILD-RUNTIME RULE, and WS-13c §8's three conformance scenarios at selection level.
//
// SM1/SM2/SM3 have two halves. The DELIVERY half (a real `SendMessage` reaching a live child, the
// `DeliveryOutcome` that carries a refusal back to the parent's turn) is Lane B's, over the messaging
// router. The SELECTION half is here: which runtime the child was decided onto, that the decision
// never consulted the parent, that a later parent switch leaves the child's record untouched, and
// that a child whose provider is gone refuses in the exact shape Lane B maps onto `unavailable`.
import { describe, expect, test } from "bun:test";

import { CHILD_PROVIDER_UNAVAILABLE, resumeChildSelection, selectChildRuntime, selectChildRuntimePairing } from "../../src/selection/child-runtime.ts";
import { isSelectionRefusal } from "../../src/selection/runtime-selection.ts";
import type { ChildSelectionInput, RuntimeSelection, SelectionRefusal } from "../../src/selection/runtime-selection.ts";
import { ruleIdOf, selectRuntime } from "../../src/selection/select-runtime.ts";
import { claudeFamily, credentials, listing, NOW, row, VERSIONS } from "./fixtures.ts";

const ALL_PROVIDERS = ["anthropic", "bedrock", "kie", "agentrouter", "openai", "azure-openai", "google", "vertex"];

function childOf(over: Partial<ChildSelectionInput> = {}): ChildSelectionInput {
  return {
    slot: "sonnet",
    mode: "code",
    families: listing("claude"),
    credentials: credentials(ALL_PROVIDERS),
    hasClaudePeer: true,
    claudeOauthApproved: false,
    versions: VERSIONS,
    now: NOW,
    ...over,
  };
}

function must(result: RuntimeSelection | SelectionRefusal): RuntimeSelection {
  if (isSelectionRefusal(result)) throw new Error(`expected a selection, got ${result.reason} — ${result.detail}`);
  return result;
}

/** A parent decided the ordinary way, so no test invents a record by hand. */
function parentOn(family: "claude" | "gpt", hasClaudePeer = true): RuntimeSelection {
  return must(
    selectRuntime({
      mode: "code",
      requested: { slot: family === "claude" ? "opus" : "astra" },
      families: listing(family),
      credentials: credentials(ALL_PROVIDERS),
      hasClaudePeer,
      claudeOauthApproved: false,
      versions: VERSIONS,
      now: NOW,
    }),
  );
}

describe("R-7b-1 — the child's own family decides", () => {
  test("R-7b-1 — the same child under two different parents produces the identical record", () => {
    const winterParent = parentOn("gpt");
    const officialParent = parentOn("claude");
    expect(winterParent.runtimeKind).toBe("winter-agent");
    expect(officialParent.runtimeKind).toBe("claude-agent");
    const underWinter = must(selectChildRuntime(winterParent, childOf()));
    const underOfficial = must(selectChildRuntime(officialParent, childOf()));
    expect(underWinter).toEqual(underOfficial);
  });

  test("R-7b-1 — a Claude-family child of a Winter parent runs on the official runtime", () => {
    const child = must(selectChildRuntime(parentOn("gpt"), childOf()));
    expect(child.runtimeKind).toBe("claude-agent");
    expect(child.family).toBe("claude");
    expect(child.modelRef).toBe("anthropic/claude-sonnet-5");
    expect(ruleIdOf(child)).toBe("D13-2");
  });

  test("R-7b-1 — a gpt-family child of an official parent runs on the Winter runtime", () => {
    const child = must(selectChildRuntime(parentOn("claude"), childOf({ slot: "astra", families: listing("gpt") })));
    expect(child.runtimeKind).toBe("winter-agent");
    expect(child.family).toBe("gpt");
    expect(ruleIdOf(child)).toBe("D28");
  });

  test("R-7b-1 — the child's mode is its own: a Claude slot in a dispatch child stays on Winter", () => {
    const child = must(selectChildRuntime(parentOn("claude"), childOf({ mode: "dispatch" })));
    expect(child.runtimeKind).toBe("winter-agent");
    expect(ruleIdOf(child)).toBe("D13-3-mode");
  });

  test("R-7b-1 — a child may name a model or a provider instead of a slot", () => {
    const { slot: _slot, ...noSlot } = childOf();
    const byModel = must(selectChildRuntime(parentOn("gpt"), { ...noSlot, model: "claude-opus-5" }));
    expect(byModel.modelRef).toBe("anthropic/claude-opus-5");
    const pinned = must(selectChildRuntime(parentOn("gpt"), childOf({ slot: "opus", provider: "kie" })));
    expect(pinned.providerId).toBe("kie");
    expect(pinned.runtimeKind).toBe("winter-agent");
  });

  test("R-7b-1 — a child gets the same typed refusals a top-level session gets", () => {
    const refusal = selectChildRuntime(parentOn("claude"), childOf({ credentials: credentials([]) }));
    expect(isSelectionRefusal(refusal)).toBe(true);
    if (!isSelectionRefusal(refusal)) throw new Error("unreachable");
    expect(refusal.reason).toBe("slot-unservable");
  });

  test("R-7b-1 — the child's record stamps the SDK version of the runtime the child chose", () => {
    expect(must(selectChildRuntime(parentOn("gpt"), childOf())).sdkVersion).toBe("0.3.250");
    expect(must(selectChildRuntime(parentOn("claude"), childOf({ slot: "astra", families: listing("gpt") }))).sdkVersion).toBe("0.0.2");
  });
});

describe("R-7b-1 — the cross-runtime pair talks through the directory", () => {
  test("R-7b-1 — a cross-runtime parent/child pair is flagged for the directory channel", () => {
    const pairing = selectChildRuntimePairing(parentOn("gpt"), childOf());
    if (isSelectionRefusal(pairing)) throw new Error("unreachable");
    expect(pairing.parentRuntime).toBe("winter-agent");
    expect(pairing.child.runtimeKind).toBe("claude-agent");
    expect(pairing.crossRuntime).toBe(true);
    expect(pairing.channel).toBe("directory");
  });

  test("R-7b-1 — a same-runtime pair stays on the in-runtime channel", () => {
    const pairing = selectChildRuntimePairing(parentOn("claude"), childOf());
    if (isSelectionRefusal(pairing)) throw new Error("unreachable");
    expect(pairing.crossRuntime).toBe(false);
    expect(pairing.channel).toBe("in-runtime");
  });

  test("R-7b-1 — the pairing carries the refusal through instead of inventing a channel", () => {
    const pairing = selectChildRuntimePairing(parentOn("claude"), childOf({ credentials: credentials([]) }));
    expect(isSelectionRefusal(pairing)).toBe(true);
  });
});

describe("WS-13c §8 — resume follows the child's own record", () => {
  const resumeContext = (over: Partial<ChildSelectionInput> = {}) => {
    const { slot: _slot, model: _model, provider: _provider, ...context } = childOf(over);
    return context;
  };

  test("WS13c-SM1 — a gpt parent's sonnet child is unchanged when the parent switches to claude", () => {
    const parent = parentOn("gpt");
    const child = must(selectChildRuntime(parent, childOf()));
    expect(child.runtimeKind).toBe("claude-agent");

    // The parent switches family. That is a NEW parent decision (the certified handoff or a visible
    // fork); it says nothing about the child.
    const switched = parentOn("claude");
    expect(switched.runtimeKind).toBe("claude-agent");

    const resumed = resumeChildSelection(child, resumeContext());
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") throw new Error("unreachable");
    expect(resumed.selection).toBe(child);
    expect(resumed.selection.providerId).toBe("anthropic");
    expect(resumed.selection.modelRef).toBe("anthropic/claude-sonnet-5");
  });

  test("WS13c-SM2 — a claude parent's gpt child is unchanged when the parent switches to gpt", () => {
    const parent = parentOn("claude");
    const child = must(selectChildRuntime(parent, childOf({ slot: "astra", families: listing("gpt") })));
    expect(child.runtimeKind).toBe("winter-agent");
    expect(child.providerId).toBe("openai");

    const switched = parentOn("gpt");
    expect(switched.runtimeKind).toBe("winter-agent");

    const resumed = resumeChildSelection(child, resumeContext({ families: listing("gpt") }));
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") throw new Error("unreachable");
    expect(resumed.selection).toBe(child);
  });

  test("WS13c-SM3 — a child whose credential is gone refuses with child-provider-unavailable and is not retryable", () => {
    const parent = parentOn("gpt");
    const child = must(selectChildRuntime(parent, childOf()));
    // The child's provider loses its configured credential ref; the parent's own provider keeps its.
    const outcome = resumeChildSelection(child, resumeContext({ credentials: credentials(["openai"]) }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason.startsWith(`${CHILD_PROVIDER_UNAVAILABLE}:`)).toBe(true);
    // The parent's turn continues on its own record — nothing about the child's refusal touches it.
    expect(selectRuntime({ ...resumeContext({ families: listing("gpt") }), requested: {}, persisted: parent })).toBe(parent);
  });

  test("WS-13c §8 — a resumed child whose recorded model now resolves elsewhere is unavailable, never substituted", () => {
    const child = must(selectChildRuntime(parentOn("gpt"), childOf({ slot: "opus", provider: "kie" })));
    expect(child.providerId).toBe("kie");
    // The recorded row key still resolves, but only `agentrouter` has a credential now. A resume must
    // NOT silently move the child there.
    const outcome = resumeChildSelection(child, resumeContext({ credentials: credentials(["agentrouter"]) }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.reason).toContain("kie");
    expect(outcome.reason).toContain(CHILD_PROVIDER_UNAVAILABLE);
  });

  test("WS-13c §8 — a resume succeeds on a recorded row that is not its provider's first row", () => {
    // One provider, TWO rows for one canonical model — the shape the pinned resolution alone cannot
    // distinguish. The child is recorded on the SECOND row, and the resume must accept it: comparing
    // against the first candidate (what this function used to do) would refuse a perfectly live child.
    const twoRows = {
      ...claudeFamily,
      models: [
        {
          canonicalModelId: "claude-opus-5",
          displayName: "Opus 5",
          rows: [row("anthropic/claude-opus-5", "anthropic"), row("anthropic/claude-opus-5-20260301", "anthropic")],
        },
      ],
    };
    const record: RuntimeSelection = {
      runtimeKind: "claude-agent",
      providerId: "anthropic",
      modelRef: "anthropic/claude-opus-5-20260301",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.3.250",
      reason: "recorded at spawn",
      decidedAt: NOW,
    };
    const outcome = resumeChildSelection(record, resumeContext({ families: listing(undefined, [twoRows]) }));
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.selection).toBe(record);
  });

  test("WS-13c §8 — a resume refuses when the recorded ROW is unservable though its provider still serves the model", () => {
    // The dated row was deprecated in a catalog regeneration; the provider still serves the model
    // through its sibling row. Continuing there would be a substitution the child never ran on — and
    // it is the case the provider pin cannot catch, because the pin is satisfied by the sibling.
    const rowGone = {
      ...claudeFamily,
      models: [
        {
          canonicalModelId: "claude-opus-5",
          displayName: "Opus 5",
          rows: [row("anthropic/claude-opus-5", "anthropic"), row("anthropic/claude-opus-5-20260301", "anthropic", { status: "deprecated" })],
        },
      ],
    };
    const record: RuntimeSelection = {
      runtimeKind: "claude-agent",
      providerId: "anthropic",
      modelRef: "anthropic/claude-opus-5-20260301",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.3.250",
      reason: "recorded at spawn",
      decidedAt: NOW,
    };
    const outcome = resumeChildSelection(record, resumeContext({ families: listing(undefined, [rowGone]) }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain(CHILD_PROVIDER_UNAVAILABLE);
    expect(outcome.reason).toContain("anthropic/claude-opus-5-20260301");
    expect(outcome.reason).toContain("no longer among the servable rows");
  });

  test("WS-13c §8 — a resume refuses when the recorded row has moved into another family", () => {
    // A row key that changed families across a regeneration: "never a substitution, never a different
    // family" (WS-13c §4), so the child is unavailable rather than quietly continued.
    const moved = {
      ...claudeFamily,
      id: "other",
      displayName: "other",
      slots: [],
      models: [{ canonicalModelId: "claude-opus-5", displayName: "Opus 5", rows: [row("anthropic/claude-opus-5", "anthropic")] }],
    };
    const record: RuntimeSelection = {
      runtimeKind: "claude-agent",
      providerId: "anthropic",
      modelRef: "anthropic/claude-opus-5",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.3.250",
      reason: "recorded at spawn",
      decidedAt: NOW,
    };
    const outcome = resumeChildSelection(record, resumeContext({ families: listing(undefined, [moved]) }));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") throw new Error("unreachable");
    expect(outcome.retryable).toBe(false);
    expect(outcome.reason).toContain("now resolves into other");
    expect(outcome.reason).toContain("never a different family");
  });

  test("WS-13c §8 — a resume never re-decides the runtime, even when the table would now differ", () => {
    // A child recorded on Winter, resumed in a session that now holds the official peer: the record
    // wins, and the runtime does not move under a live child.
    const child = must(selectChildRuntime(parentOn("gpt", false), childOf({ hasClaudePeer: false })));
    expect(child.runtimeKind).toBe("winter-agent");
    expect(ruleIdOf(child)).toBe("R-7b-1-no-peer");
    const outcome = resumeChildSelection(child, resumeContext({ hasClaudePeer: true }));
    expect(outcome.kind).toBe("resumed");
    if (outcome.kind !== "resumed") throw new Error("unreachable");
    expect(outcome.selection.runtimeKind).toBe("winter-agent");
    expect(outcome.selection).toBe(child);
  });
});
