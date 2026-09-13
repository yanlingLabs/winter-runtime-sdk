// WS-18 W18-20 — P10b-6 fix round 1, CRITICAL — THE DEFAULT PATH (no injected `resolveEndpoint`).
//
// `test/store/review-switch.test.ts` proves `reviewSwitch` end to end, but every one of its cases
// injects `fixtureResolveEndpoint` — so the DEFAULT path (what a host gets if it never wires
// `HandoffBarrierDeps.resolveEndpoint`) had ZERO coverage. Measured before this fix: with no injected
// resolver, DeepSeek->GLM with a `{material:"exposed",complete:true}` sidecar record came back
// `{prompt:true, lossClass:"warned-lossy"}` instead of `lossless-portable` — `endpointFromOrigin`
// alone reports `readableState:"none"` for every model, breaking R-10b-2/W18-21 on exactly the row
// they protect. This file drives the SAME five rows with NO `resolveEndpoint` override at all,
// against REAL rows from the compiled catalog (`@yanlinglabs/winter-provider-catalog`'s
// `loadCatalog()` — the same data `defaultEndpointResolver()` builds its registry from).
//
// THE CATALOG ROWS USED, measured directly (see the fix commit's report for the full survey):
//   - DeepSeek: `deepseek/deepseek-reasoner` — `readableState: "full-exposed"` (declared, official-doc).
//   - GLM: `zai/glm-5` — the catalog carries NO reasoning evidence for GLM at all today (`reasoning:
//     null` on every zai/* row), so this is the closest real row; `readableState` resolves to "none"
//     for it. That does NOT affect this test: `classifySwitch`'s "lossless-portable" class is a fact
//     about the SOURCE's complete exposure, never about the target's own readable state — confirmed
//     empirically (see the fix report) before relying on it here.
//   - GPT: `openai/gpt-5.6-luna`. Claude: `anthropic/claude-opus-5` (readableState "summary" in the
//     real catalog) / `anthropic/claude-sonnet-5` for the same-family row.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "bun:test";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { WINTER_BRAND, envName } from "@yanlinglabs/winter-agent-sdk";

import { createHandoffBarrier, providerStateSidecarPath, resolveEngineTempLayout, type HandoffBarrierDeps } from "../../src/store/index.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { withStoreBed, type StoreBed } from "./support.ts";

const NOW = "2026-09-13T12:00:00.000Z";

const DEEPSEEK = { providerId: "deepseek", modelRef: "deepseek/deepseek-reasoner", family: "deepseek" };
const GLM = { providerId: "zai", modelRef: "zai/glm-5", family: "glm" };
const GPT = { providerId: "openai", modelRef: "openai/gpt-5.6-luna", family: "gpt" };
const CLAUDE_OPUS = { providerId: "anthropic", modelRef: "anthropic/claude-opus-5", family: "claude" };
const CLAUDE_SONNET = { providerId: "anthropic", modelRef: "anthropic/claude-sonnet-5", family: "claude" };

function selection(row: { providerId: string; modelRef: string; family: string }, over: Partial<RuntimeSelection> = {}): RuntimeSelection {
  return {
    runtimeKind: row.family === "claude" ? "claude-agent" : "winter-agent",
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

function turn(key: SessionKey, parent: string | null, assistantText: string): { entries: SessionStoreEntry[]; assistantUuid: string } {
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();
  const base = (uuid: string, p: string | null) => ({ uuid, parentUuid: p, sessionId: key.sessionId, timestamp: NOW, cwd: "/review-switch-default", version: "0.0.0", isSidechain: false });
  return {
    assistantUuid,
    entries: [
      { type: "user", ...base(userUuid, parent), message: { role: "user", content: "go" } },
      { type: "assistant", ...base(assistantUuid, userUuid), message: { id: `msg_${assistantUuid}`, type: "message", role: "assistant", content: [{ type: "text", text: assistantText }] } },
    ],
  };
}

function writeSummary(home: string, key: SessionKey, anchorUuid: string, row: { providerId: string; modelRef: string; family: string }, payload: { text: string; material?: "exposed"; complete?: boolean }): void {
  const path = providerStateSidecarPath(home, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = { type: "provider_state", uuid: randomUUID(), timestamp: NOW, sessionId: key.sessionId, anchorUuid, provider: row.providerId, model: row.modelRef, family: row.family, itemIndex: 0, kind: "summary", payload };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function barrierFor(bed: StoreBed, deps: Partial<HandoffBarrierDeps> = {}): ReturnType<typeof createHandoffBarrier> {
  // DELIBERATELY NO `resolveEndpoint` HERE — this is the whole point of this file.
  const full: HandoffBarrierDeps = {
    shared: bed.shared,
    winterHome: bed.home,
    tempLayoutFor: () => {
      mkdirSync(bed.tempBase, { recursive: true });
      return resolveEngineTempLayout({ brand: WINTER_BRAND, tempProjectKey: bed.key.projectKey, backendUuid: bed.key.sessionId, uid: 4242, env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase } });
    },
    ...deps,
  };
  return createHandoffBarrier(bed.context, full);
}

describe("WS-18 W18-20 fix round 1 — reviewSwitch's DEFAULT path (no injected resolveEndpoint), real catalog rows", () => {
  test("DeepSeek (complete exposed, deepseek/deepseek-reasoner) -> GLM (zai/glm-5): silent, lossless-portable", async () => {
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

  test("GPT (summary records, openai/gpt-5.6-luna) -> Claude (anthropic/claude-opus-5): prompt", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "gpt's reasoning summary");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, GPT, { text: "gpt's reasoning summary" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
    });
  });

  test("Claude (anthropic/claude-opus-5, signed thinking carried as summary) -> DeepSeek: prompt", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }) });
      const t = turn(bed.key, null, "claude's summarized thinking");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, CLAUDE_OPUS, { text: "claude's summarized thinking" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(DEEPSEEK));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
    });
  });

  test("Sonnet -> Opus: skipped same-family, never prompt", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selection(CLAUDE_SONNET, { runtimeKind: "claude-agent" }) });
      const t = turn(bed.key, null, "sonnet reply");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBe("same-family");
      expect(review.classification).toBeUndefined();
    });
  });
});
