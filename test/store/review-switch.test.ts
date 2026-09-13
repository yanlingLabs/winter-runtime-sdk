// WS-18 W18-20 / P10b-6 R8 — `reviewSwitch` AND `plan().review`: THE S7 TABLE, END TO END THROUGH
// THE STORE.
//
// `reviewSwitch(session, requested)` reads the session's persisted (FROM) selection off the
// directory, the canonical transcript and the provider-state sidecar off the shared store — never
// rewriting either — resolves both endpoints, and returns `reviewModelSwitch(...)`. Because the
// hermetic peer carries no catalog registry, `resolveEndpoint` is INJECTED here with the exact
// `readableState`/family facts the S7 table's own rows depend on (matching what the real catalog
// would report for these families) — this is the "a host's own catalog registry" seam
// `createEndpointResolver` would normally fill.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ContinuityEndpoint, MessageOrigin } from "@yanlinglabs/winter-provider-runtime";
import { endpointFromOrigin } from "@yanlinglabs/winter-provider-runtime";
import type { SessionKey, SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { WINTER_BRAND, envName } from "@yanlinglabs/winter-agent-sdk";

import { createHandoffBarrier, providerStateSidecarPath, resolveEngineTempLayout, type HandoffBarrierDeps } from "../../src/store/index.ts";
import type { RuntimeSelection, SelectionInput } from "../../src/selection/runtime-selection.ts";
import { withStoreBed, type StoreBed } from "./support.ts";
import { credentials, listing, VERSIONS } from "../selection/fixtures.ts";

const NOW = "2026-09-13T12:00:00.000Z";

// --- the fixture endpoints the S7 table's rows are named against ----------------------------------
const GPT: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/gpt-5.6-luna", family: "gpt", readableState: "summary" };
const TERRA: ContinuityEndpoint = { providerId: "openai", modelKey: "openai/gpt-5.6-terra", family: "gpt", readableState: "summary" };
const CLAUDE_OPUS: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/claude-opus-5", family: "claude", readableState: "none" };
const CLAUDE_SONNET: ContinuityEndpoint = { providerId: "anthropic", modelKey: "anthropic/claude-sonnet-5", family: "claude", readableState: "none" };
const DEEPSEEK: ContinuityEndpoint = { providerId: "deepseek", modelKey: "deepseek/deepseek-r1", family: "deepseek", readableState: "full-exposed" };
const GLM: ContinuityEndpoint = { providerId: "z-ai", modelKey: "z-ai/glm-4.6", family: "glm", readableState: "full-exposed" };

const ENDPOINTS = [GPT, TERRA, CLAUDE_OPUS, CLAUDE_SONNET, DEEPSEEK, GLM];

/** The hermetic stand-in for `createEndpointResolver(registry)`: a fixed lookup table, never a live catalog. */
function fixtureResolveEndpoint(origin: MessageOrigin): ContinuityEndpoint {
  return ENDPOINTS.find((e) => e.providerId === origin.providerId && e.modelKey === origin.modelKey) ?? endpointFromOrigin(origin);
}

function selection(endpoint: ContinuityEndpoint, over: Partial<RuntimeSelection> = {}): RuntimeSelection {
  return {
    runtimeKind: endpoint.family === "claude" ? "claude-agent" : "winter-agent",
    providerId: endpoint.providerId,
    modelRef: endpoint.modelKey,
    family: endpoint.family,
    authFamily: "custom",
    sdkVersion: "0.0.2",
    reason: "fixture",
    decidedAt: NOW,
    ...over,
  };
}

/** One user/assistant pair, chained onto whatever `parent` names. Returns the assistant's own uuid. */
function turn(key: SessionKey, parent: string | null, assistantText: string): { entries: SessionStoreEntry[]; userUuid: string; assistantUuid: string } {
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();
  const base = (uuid: string, p: string | null) => ({ uuid, parentUuid: p, sessionId: key.sessionId, timestamp: NOW, cwd: "/review-switch", version: "0.0.0", isSidechain: false });
  return {
    userUuid,
    assistantUuid,
    entries: [
      { type: "user", ...base(userUuid, parent), message: { role: "user", content: "go" } },
      { type: "assistant", ...base(assistantUuid, userUuid), message: { id: `msg_${assistantUuid}`, type: "message", role: "assistant", content: [{ type: "text", text: assistantText }] } },
    ],
  };
}

/** Writes ONE `kind: "summary"` sidecar record anchored on `anchorUuid`, in the dialect the router reads. */
function writeSummary(home: string, key: SessionKey, anchorUuid: string, endpoint: ContinuityEndpoint, payload: { text: string; material?: "exposed"; complete?: boolean }): void {
  const path = providerStateSidecarPath(home, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
    type: "provider_state",
    uuid: randomUUID(),
    timestamp: NOW,
    sessionId: key.sessionId,
    anchorUuid,
    provider: endpoint.providerId,
    model: endpoint.modelKey,
    family: endpoint.family,
    itemIndex: 0,
    kind: "summary",
    payload,
  };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * Writes ONE `kind: "origin"` sidecar record anchored on `anchorUuid` — `toClaudeReady`'s step (e)
 * needs this to recognise a message as FOREIGN at all (it does not infer origin from a `summary`
 * record's own fields); `switchFactsFor` does not need it (an absent origin defaults to "belongs to
 * source"), which is why only the truncation test below writes one.
 */
function writeOrigin(home: string, key: SessionKey, anchorUuid: string, endpoint: ContinuityEndpoint): void {
  const path = providerStateSidecarPath(home, key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const record = {
    type: "provider_state",
    uuid: randomUUID(),
    timestamp: NOW,
    sessionId: key.sessionId,
    anchorUuid,
    provider: endpoint.providerId,
    model: endpoint.modelKey,
    family: endpoint.family,
    itemIndex: 0,
    kind: "origin",
    payload: null,
  };
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function barrierFor(bed: StoreBed, deps: Partial<HandoffBarrierDeps> = {}): ReturnType<typeof createHandoffBarrier> {
  const full: HandoffBarrierDeps = {
    shared: bed.shared,
    winterHome: bed.home,
    resolveEndpoint: fixtureResolveEndpoint,
    tempLayoutFor: () => {
      mkdirSync(bed.tempBase, { recursive: true });
      return resolveEngineTempLayout({ brand: WINTER_BRAND, tempProjectKey: bed.key.projectKey, backendUuid: bed.key.sessionId, uid: 4242, env: { [envName(WINTER_BRAND, "TMPDIR")]: bed.tempBase } });
    },
    ...deps,
  };
  return createHandoffBarrier(bed.context, full);
}

describe("WS-18 W18-20 — reviewSwitch, the S7 table end to end through the store", () => {
  test("GPT (summary) -> Claude: prompt, warned-lossy", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "gpt's reasoning summary");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, GPT, { text: "gpt's reasoning summary" });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
      expect(review.skipped).toBeUndefined();
    });
  });

  test("Claude (signed thinking, carried as summary) -> DeepSeek: prompt", async () => {
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

  test("DeepSeek (complete exposed) -> GLM: no prompt, lossless-portable", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(DEEPSEEK) });
      const t = turn(bed.key, null, "deepseek's full reasoning trace");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, DEEPSEEK, { text: "deepseek's full reasoning trace", material: "exposed", complete: true });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GLM));
      expect(review.prompt).toBe(false);
      expect(review.classification?.lossClass).toBe("lossless-portable");
    });
  });

  test("DeepSeek (complete exposed) -> GPT: no prompt, lossless-portable", async () => {
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

  test("DeepSeek with ONE incomplete exposed turn -> GPT: prompt", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(DEEPSEEK) });
      const t1 = turn(bed.key, null, "deepseek's complete trace");
      await bed.shared.store.append(bed.key, t1.entries);
      const t2 = turn(bed.key, t1.assistantUuid, "deepseek's incomplete trace");
      await bed.shared.store.append(bed.key, t2.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t1.assistantUuid, DEEPSEEK, { text: "deepseek's complete trace", material: "exposed", complete: true });
      // The SECOND turn's exposure is INCOMPLETE — a dropped delta, an abort, a max_tokens stop.
      writeSummary(bed.home, bed.key, t2.assistantUuid, DEEPSEEK, { text: "deepseek's incomplete trace", material: "exposed", complete: false });

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GPT));
      expect(review.prompt).toBe(true);
      expect(review.classification?.lossClass).toBe("warned-lossy");
    });
  });

  test("Sonnet -> Opus; Terra -> Luna: skipped same-family, never prompt", async () => {
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

    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(TERRA) });
      const t = turn(bed.key, null, "terra reply");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(GPT));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBe("same-family");
    });
  });

  test("GPT with ZERO assistant turns since the last boundary -> Claude: skipped no-source-turns", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      // ONE opening user entry, no reply yet — genuinely nothing to lose.
      const userUuid = randomUUID();
      await bed.shared.store.append(bed.key, [
        { type: "user", uuid: userUuid, parentUuid: null, sessionId: bed.key.sessionId, timestamp: NOW, cwd: "/review-switch", version: "0.0.0", isSidechain: false, message: { role: "user", content: "go" } },
      ]);
      await bed.shared.settle(bed.key);

      const review = await barrierFor(bed).reviewSwitch(bed.key, selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }));
      expect(review.prompt).toBe(false);
      expect(review.skipped).toBe("no-source-turns");
    });
  });

  test("truncated:true flips an otherwise-lossless exposed transfer to prompt (Claude destination — the one leg this router can measure `dropped` for)", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(DEEPSEEK) });
      const t = turn(bed.key, null, "deepseek's full reasoning trace, long enough that a tiny budget cannot keep it");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeOrigin(bed.home, bed.key, t.assistantUuid, DEEPSEEK);
      writeSummary(bed.home, bed.key, t.assistantUuid, DEEPSEEK, {
        text: "deepseek's full reasoning trace, long enough that a tiny budget cannot keep it",
        material: "exposed",
        complete: true,
      });
      const claudeRequested = selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" });

      // BASELINE: unbounded budget, nothing dropped — the same shape as the DeepSeek->GLM/GPT rows.
      const baseline = await barrierFor(bed).reviewSwitch(bed.key, claudeRequested);
      expect(baseline.prompt).toBe(false);
      expect(baseline.classification?.lossClass).toBe("lossless-portable");

      // A BUDGET TOO TINY TO CARRY EVEN ONE CHARACTER of the decoration: `dropped > 0`, which
      // `reviewModelSwitch` folds into `SwitchFacts.truncated`, which `classifySwitch` flips to lossy —
      // measured, not assumed: the baseline above is what makes this a controlled A/B rather than a
      // guess about which way the matrix would have gone anyway.
      const truncated = await barrierFor(bed, { reviewSwitchBudgetChars: 1 }).reviewSwitch(bed.key, claudeRequested);
      expect(truncated.prompt).toBe(true);
      expect(truncated.classification?.lossClass).toBe("warned-lossy");
    });
  });

  test("plan().review embeds the SAME classification for a servable, family-crossing plan", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "winter-agent", selection: selection(GPT) });
      const t = turn(bed.key, null, "gpt's reasoning summary");
      await bed.shared.store.append(bed.key, t.entries);
      await bed.shared.settle(bed.key);
      writeSummary(bed.home, bed.key, t.assistantUuid, GPT, { text: "gpt's reasoning summary" });
      const claudeRequested = selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" });

      const barrier = barrierFor(bed, { participants: { source: () => ({ runtimeKind: "winter-agent" as const, drainToIdleBoundary: () => ({ ok: true } as const), drainStream: () => ({ ok: true } as const), close: () => ({ ok: true } as const) }) } });
      const plan = await barrier.plan(bed.key, "claude-agent", { requested: claudeRequested });
      expect(plan.review).toBeDefined();
      expect(plan.review?.prompt).toBe(true);
      expect(plan.review?.classification?.lossClass).toBe("warned-lossy");

      // AND IT MATCHES `reviewSwitch` CALLED DIRECTLY — one classification, not two computed differently.
      const direct = await barrier.reviewSwitch(bed.key, claudeRequested);
      expect(plan.review).toEqual(direct);
    });
  });

  test("plan().review is ABSENT for a refused plan — nothing to review", async () => {
    await withStoreBed(async (bed) => {
      await bed.record({ runtimeKind: "claude-agent", selection: selection(CLAUDE_OPUS, { runtimeKind: "claude-agent" }) });
      const input = (): SelectionInput => ({
        mode: "code",
        requested: {},
        families: listing("claude"),
        credentials: credentials(["anthropic"]),
        hasClaudePeer: true,
        claudeOauthApproved: true,
        versions: VERSIONS,
        now: NOW,
      });
      const barrier = barrierFor(bed, {
        selectionInputFor: () => input(),
        participants: {
          source: () => ({ runtimeKind: "claude-agent" as const, drainToIdleBoundary: () => ({ ok: true } as const), drainStream: () => ({ ok: true } as const), close: () => ({ ok: true } as const) }),
        },
      });
      // A requested row whose auth family the winter destination can never serve (D28) — a genuine refusal.
      const plan = await barrier.plan(bed.key, "winter-agent", { requested: selection(CLAUDE_OPUS, { runtimeKind: "claude-agent", authFamily: "claude-oauth" }) });
      expect(plan.selection.kind).toBe("refused");
      expect(plan.review).toBeUndefined();
    });
  });
});
