// WS-18 W18-20 — P10b-6 fix round 1, CRITICAL — THE DEFAULT PATH (no injected `resolveEndpoint`).
//
// `test/store/review-switch.test.ts` proves `reviewSwitch` end to end, but every one of its cases
// injects `fixtureResolveEndpoint` — so the DEFAULT path (what a host gets if it never wires
// `SwitchReviewerDeps.resolveEndpoint` (then the barrier's own)) had ZERO coverage. Measured before this fix: with no injected
// resolver, DeepSeek->GLM with a `{material:"exposed",complete:true}` sidecar record came back
// `{prompt:true, lossClass:"warned-lossy"}` instead of `lossless-portable` — `endpointFromOrigin`
// alone reports `readableState:"none"` for every model, breaking R-10b-2/W18-21 on exactly the row
// they protect. This file drives the SAME five rows with NO `resolveEndpoint` override at all,
// against REAL rows from the compiled catalog (`@yanlinglabs/winter-provider-catalog`'s
// `loadCatalog()` — the same data `defaultEndpointResolver()` builds its registry from).
//
// THE CATALOG ROWS USED, measured directly (see the fix commit's report for the full survey).
// RE-MEASURED at `@yanlinglabs/winter-provider-catalog` 0.0.22 (router 0.0.12's floor): the upstream
// catalog renamed `deepseek/deepseek-reasoner` to `deepseek/deepseek-flash` (and added a sibling
// `deepseek/deepseek-v4-pro`) — both still declare the identical `readableState: "full-exposed"` this
// row is chosen for, so the row reference moved but the fact being tested did not.
//   - DeepSeek: `deepseek/deepseek-flash` — `readableState: "full-exposed"` (declared, official-doc).
//   - GLM: `zai/glm-5` — the catalog carries NO reasoning evidence for GLM at all today (`reasoning:
//     null` on every zai/* row), so this is the closest real row; `readableState` resolves to "none"
//     for it. That does NOT affect this test: `classifySwitch`'s "lossless-portable" class is a fact
//     about the SOURCE's complete exposure, never about the target's own readable state — confirmed
//     empirically (see the fix report) before relying on it here.
//   - GPT: `openai/gpt-5.6-luna`. Claude: `anthropic/claude-opus-5` (readableState "summary" in the
//     real catalog) / `anthropic/claude-sonnet-5` for the same-family row.
//
// WS-23 (reasoning-state, decision 9 — SDK b5a79db): a switch now prompts only over what the TARGET
// cannot represent — images or documents for a text-only model, another vendor's server-tool steps, a
// compaction the fit check will run (and an interrupted turn, which the host decides: the review reads
// a snapshot and never sees a running turn). Reasoning parked in the sidecar is not lost. The rows that
// used to prompt over reasoning keep their prompt by carrying one of those losses instead, and each has
// a CONTROL beside it proving the loss, not the family change, is what prompts. `zai/glm-5` is the
// text-only row (`inputModalities: ["text"]`, a 200k window) the media and fit cases need.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { SYSTEM_AND_TOOLS_ALLOWANCE_TOKENS } from "@yanlinglabs/winter-provider-runtime";

import { createSwitchReviewer, providerStateSidecarPath, type SwitchReviewerDeps, type SwitchReviewerHandle } from "../../src/store/index.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { withStoreBed, type StoreBed } from "./support.ts";

const NOW = "2026-09-13T12:00:00.000Z";

const DEEPSEEK = { providerId: "deepseek", modelRef: "deepseek/deepseek-flash", family: "deepseek" };
const GLM = { providerId: "zai", modelRef: "zai/glm-5", family: "glm" };
const GPT = { providerId: "openai", modelRef: "openai/gpt-5.6-luna", family: "gpt" };
const CLAUDE_OPUS = { providerId: "anthropic", modelRef: "anthropic/claude-opus-5", family: "claude" };
const CLAUDE_SONNET = { providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", family: "claude" };

function selection(row: { providerId: string; modelRef: string; family: string }, over: Partial<RuntimeSelection> = {}): RuntimeSelection {
  return {
    runtimeKind: "winter-agent",
    providerId: row.providerId,
    modelRef: row.modelRef,
    family: row.family,
    authFamily: "custom",
    sdkVersion: "0.0.2",
    reason: "fixture",
    decidedAt: NOW,
    ...over,
  };
}

/**
 * One user/assistant pair. WS-23: `over` replaces either side's content — an image in the user turn, an
 * Anthropic server-tool step in the reply, a history too large for a small window — because what the
 * target cannot represent is now the only thing that prompts.
 */
function turn(key: SessionKey, parent: string | null, assistantText: string, over: { userContent?: unknown; assistantBlocks?: unknown[] } = {}): { entries: SessionStoreEntry[]; assistantUuid: string } {
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();
  const base = (uuid: string, p: string | null) => ({ uuid, parentUuid: p, sessionId: key.sessionId, timestamp: NOW, cwd: "/review-switch-default", version: "0.0.0", isSidechain: false });
  return {
    assistantUuid,
    entries: [
      { type: "user", ...base(userUuid, parent), message: { role: "user", content: over.userContent ?? "go" } },
      { type: "assistant", ...base(assistantUuid, userUuid), message: { id: `msg_${assistantUuid}`, type: "message", role: "assistant", content: [...(over.assistantBlocks ?? []), { type: "text", text: assistantText }] } },
    ],
  };
}

/** A user turn carrying one image (a 1x1 PNG header is enough: the review counts blocks, never bytes). */
const USER_WITH_IMAGE = [{ type: "text", text: "what is in this picture?" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }];

/** One Anthropic web-search step as it sits in a Claude reply: the server-side call and its result. */
const ANTHROPIC_SERVER_TOOL_STEP = [
  { type: "server_tool_use", id: "srvtoolu_default_1", name: "web_search", input: { query: "winter release notes" } },
  { type: "web_search_tool_result", tool_use_id: "srvtoolu_default_1", content: [{ type: "web_search_result", url: "https://example.com/notes", title: "Release notes" }] },
];

function writeSummary(home: string, key: SessionKey, anchorUuid: string, row: { providerId: string; modelRef: string; family: string }, payload: { text: string; material?: "exposed"; complete?: boolean }): void {
  const path = providerStateSidecarPath(home, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = { type: "provider_state", uuid: randomUUID(), timestamp: NOW, sessionId: key.sessionId, anchorUuid, provider: row.providerId, model: row.modelRef, family: row.family, itemIndex: 0, kind: "summary", payload };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function barrierFor(bed: StoreBed, deps: Partial<SwitchReviewerDeps> = {}): SwitchReviewerHandle {
  // DELIBERATELY NO `resolveEndpoint` HERE — this is the whole point of this file.
  return createSwitchReviewer(bed.context, { shared: bed.shared, winterHome: bed.home, ...deps });
}

describe("WS-18 W18-20 fix round 1 — reviewSwitch's DEFAULT path (no injected resolveEndpoint), real catalog rows", () => {
  test("DeepSeek (complete exposed, deepseek/deepseek-flash) -> GLM (zai/glm-5): silent, lossless-portable", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(DEEPSEEK) });
      const t = turn(bed.key, null, "deepseek's full reasoning trace");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, DEEPSEEK, { text: "deepseek's full reasoning trace", material: "exposed", complete: true });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GLM));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBeUndefined();
      expect(review.classification?.lossClass).toBe("lossless-portable");
    });
  });

  test("DeepSeek (complete exposed) -> GPT: silent, lossless-portable", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(DEEPSEEK) });
      const t = turn(bed.key, null, "deepseek's full reasoning trace");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, DEEPSEEK, { text: "deepseek's full reasoning trace", material: "exposed", complete: true });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GPT));
      expect(review.prompt).toBe(false);
      expect(review.classification?.lossClass).toBe("lossless-portable");
    });
  });

  // WS-23 (reasoning-state, decision 9): this row USED to prompt — GPT's summary "could not carry" to
  // Claude. It is now the plain cross-family switch: the summary stays in the sidecar for GPT (a switch
  // back replays it) and the conversation replays as it is, so nothing the target can see is lost.
  test("GPT (summary records, openai/gpt-5.6-luna) -> Claude (anthropic/claude-opus-5): SILENT, lossless-portable (WS-23)", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "gpt's reasoning summary");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, GPT, { text: "gpt's reasoning summary" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBeUndefined();
      expect(review.classification?.lossClass).toBe("lossless-portable");
      expect(review.classification?.warnings).toEqual([]);
    });
  });

  // The S7 row's PROMPT, kept on the loss WS-23 still counts: the same GPT session, but its history
  // holds an image and the target (`zai/glm-5`, `inputModalities: ["text"]` in the real catalog) reads
  // none. The DEFAULT path must see that from the compiled catalog alone.
  test("GPT with an image in the conversation -> GLM (zai/glm-5, text-only in the real catalog): prompt, warned-lossy over the media", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "a picture of a mountain", { userContent: USER_WITH_IMAGE });
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, GPT, { text: "gpt's reasoning summary" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GLM));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
      expect(review.classification?.warnings).toHaveLength(1);
      expect(review.classification?.warnings[0]).toContain("zai/glm-5 cannot read images or documents: the 1 in this conversation");

      // CONTROL: the same history toward a model that reads images is the plain switch again.
      const toClaude = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS));
      expect(toClaude.prompt).toBe(false);
    });
  });

  // WS-23: Claude's signed thinking no longer prompts on the way out (it stays in the sidecar and is
  // spliced back on a switch to Claude). What does: Anthropic's own SERVER-tool steps, which DeepSeek
  // (an `openai`-family provider row) receives as plain text rather than as tool results (decision 8).
  test("Claude (anthropic/claude-opus-5) with an Anthropic web-search step -> DeepSeek: prompt, warned-lossy over the server-tool steps", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }) });
      const t = turn(bed.key, null, "claude's answer, from a web search", { assistantBlocks: ANTHROPIC_SERVER_TOOL_STEP });
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, CLAUDE_OPUS, { text: "claude's summarized thinking" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(DEEPSEEK));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
      expect(review.classification?.warnings).toHaveLength(1);
      expect(review.classification?.warnings[0]).toContain("2 steps of anthropic's own server-side tools");

      // CONTROL: back toward an Anthropic-family target the same steps are native — no prompt.
      const toSonnet = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_SONNET));
      expect(toSonnet.prompt).toBe(false);
    });
  });

  test("Sonnet -> Opus: skipped same-family, never prompt", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selection(CLAUDE_SONNET, { runtimeKind: "claude-agent" }) });
      const t = turn(bed.key, null, "sonnet reply");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBe("same-family");
      // WS-23: the loss matrix runs BEFORE the skip reasons now (a same-family switch can still lose
      // something the target cannot represent), so the classification is present — and empty.
      expect(review.classification?.warnings).toEqual([]);
    });
  });
});

// WS-23 (reasoning-state, decision 9): `reviewSwitch` reports the conversation's FIT on the target —
// `{fits, estimatedTokens, window}` — whenever the target's catalog row declares a window, so a host's
// confirmation can say a compaction will run. Real catalog rows, the default path.
describe("WS-23 — reviewSwitch reports {fits, estimatedTokens, window} from the real catalog row", () => {
  test("a small conversation toward Claude (anthropic/claude-opus-5, a 1M window): fits, with the estimate and the window reported", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "a short reply");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS));
      expect(review.prompt).toBe(false);
      expect(review.fits).toBe(true);
      expect(review.window).toBe(1_000_000);
      // The estimate always carries the allowance for the system prompt and tools the review cannot see.
      expect(review.estimatedTokens).toBeGreaterThanOrEqual(SYSTEM_AND_TOOLS_ALLOWANCE_TOKENS);
      expect(review.estimatedTokens).toBeLessThan(SYSTEM_AND_TOOLS_ALLOWANCE_TOKENS + 1_000);
    });
  });

  // ~700k ASCII characters is ~220k tokens by the review's own estimate: past GLM's 200k window
  // outright, so the verdict does not hang on the compaction threshold's exact value.
  test("a conversation GLM (zai/glm-5, a 200k window) cannot hold: fits:false, and the switch PROMPTS over the compaction the source will run", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "read it all", { userContent: "a".repeat(700_000) });
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GLM));
      expect(review.fits).toBe(false);
      expect(review.window).toBe(200_000);
      expect(review.estimatedTokens).toBeGreaterThan(200_000);
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
      // The SOURCE (the model being left) is the one named as paying for the summary.
      expect(review.classification?.warnings.some((w) => w.includes("so openai/gpt-5.6-luna will summarize its older part before the switch"))).toBe(true);

      // CONTROL: the same history fits Claude's 1M window, and that switch is silent.
      const toClaude = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS));
      expect(toClaude.fits).toBe(true);
      expect(toClaude.prompt).toBe(false);
    });
  });
});
