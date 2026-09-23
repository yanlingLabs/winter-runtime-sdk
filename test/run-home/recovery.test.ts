// WS-21 §3.8: recovery after a crash — `sdk.reconcileRootForRecovery(root)` recomputes the claude-ready
// copy the root was staged from, proves the canonical file a prefix of the working copy (or quarantines),
// and appends the tail through the router's own store.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady } from "@yanlinglabs/winter-provider-runtime";

import { createRuntimeSdk, runtimeSdkInternals, type RuntimeSdkPeers } from "../../src/index.ts";
import { defaultEndpointResolver } from "../../src/default-endpoint-resolver.ts";
import type { SharedSessionStore } from "../../src/store/wiring.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { RESUME_STAGING_PREFIX } from "../../src/vendor-paths.ts";
import { cleanupRunHomeBeds, runHomeBed, type RunHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const KEY: SessionKey = { projectKey: "-ws21-recovery", sessionId: "33333333-4444-4555-8666-777777777777" };

function router(bed: RunHomeBed, requireRunHome = true) {
  const { peer } = createFakeWinterPeer();
  const peers = {
    winter: {
      ...peer,
      WinterCompatibilitySessionStore,
      resolveWinterHome: () => {
        throw new Error("a hermetic test must never resolve the real Winter home");
      },
    } as unknown as RuntimeSdkPeers["winter"],
  };
  const sdk = createRuntimeSdk({ peers, keychain: createFakeKeychain(), requireRunHome, handoff: { winterHome: bed.home } });
  const shared = (runtimeSdkInternals(sdk)!.barrier as unknown as { shared: SharedSessionStore }).shared;
  return { sdk, shared };
}

const user = (content: string, parent: string | null): SessionStoreEntry => ({ type: "user", uuid: randomUUID(), parentUuid: parent, sessionId: KEY.sessionId, timestamp: new Date(0).toISOString(), cwd: "/w", version: "0", isSidechain: false, message: { role: "user", content } });

/** A foreign (non-Claude) assistant turn carrying a thinking block the claude-ready copy strips. */
const foreignAssistant = (parent: string): SessionStoreEntry => ({
  type: "assistant",
  uuid: randomUUID(),
  parentUuid: parent,
  sessionId: KEY.sessionId,
  timestamp: new Date(0).toISOString(),
  cwd: "/w",
  version: "0",
  isSidechain: false,
  message: { role: "assistant", content: [{ type: "thinking", thinking: "foreign reasoning", signature: "sig" }, { type: "text", text: "answer" }] },
});

function stagingWith(bed: RunHomeBed, lines: string[]): string {
  const root = join(bed.root, `${RESUME_STAGING_PREFIX}00000000-0000-4000-8000-${randomUUID().slice(-12)}`);
  const dir = join(root, "projects", KEY.projectKey);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${KEY.sessionId}.jsonl`), lines.map((line) => `${line}\n`).join(""));
  return root;
}

const canonicalUuids = (bed: RunHomeBed): string[] =>
  readFileSync(join(bed.sdk, "projects", KEY.projectKey, `${KEY.sessionId}.jsonl`), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => (JSON.parse(line) as { uuid: string }).uuid);

describe("reconcileRootForRecovery", () => {
  test("a crashed resume root whose staged copy is the RECOMPUTED claude-ready image of the canonical file: the tail is appended", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const answer = foreignAssistant(String(first["uuid"]));
    await shared.store.append(KEY, [first, answer]);
    await shared.settle(KEY);
    // The sidecar stamps the assistant turn with a foreign origin, so the claude-ready copy differs.
    mkdirSync(join(bed.sdk, "projects", KEY.projectKey), { recursive: true });
    const origin = { type: "provider_state", uuid: randomUUID(), timestamp: new Date(0).toISOString(), sessionId: KEY.sessionId, anchorUuid: String(answer["uuid"]), provider: "openai", model: "gpt-5", family: "gpt", itemIndex: 0, kind: "origin" as const, payload: {} };
    writeFileSync(join(bed.sdk, "projects", KEY.projectKey, `${KEY.sessionId}.provider-state.jsonl`), `${JSON.stringify(origin)}\n`);
    const resolveEndpoint = defaultEndpointResolver();
    const target = resolveEndpoint({ providerId: "anthropic", modelKey: "claude", family: "claude" } as never);
    const staged = toClaudeReady([first, answer], [origin], { target, resolveEndpoint }).entries.map((entry) => JSON.stringify(entry));
    // The staged copy really is byte-different from the canonical file (the foreign thinking is stripped).
    expect(staged[1]).not.toBe(JSON.stringify(answer));
    const tail = user("q2 written after the resume", String(answer["uuid"]));
    const root = stagingWith(bed, [...staged, JSON.stringify(tail)]);

    expect(await sdk.reconcileRootForRecovery(root)).toBe("appended");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), String(answer["uuid"]), String(tail["uuid"])]);
  });

  test("a clean root is `clean` and appends nothing", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle(KEY);
    expect(await sdk.reconcileRootForRecovery(stagingWith(bed, [JSON.stringify(first)]))).toBe("clean");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"])]);
  });

  test("a root whose canonical file is not a prefix (an entry the dead process's decoration registry knew about) is quarantined", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const second = user("q2", String(first["uuid"]));
    await shared.store.append(KEY, [first, second]);
    await shared.settle(KEY);
    const note = user("a handoff note only the copy carried", String(first["uuid"]));
    const root = stagingWith(bed, [JSON.stringify(first), JSON.stringify(note), JSON.stringify(second)]);
    expect(await sdk.reconcileRootForRecovery(root)).toBe("quarantined");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), String(second["uuid"])]);
    const quarantine = join(bed.home, "cache", "quarantine");
    expect(existsSync(quarantine)).toBe(true);
    const [dir] = readdirSync(quarantine);
    expect(existsSync(join(quarantine, dir!, "projects", KEY.projectKey, `${KEY.sessionId}.jsonl`))).toBe(true);
  });

  test("a router on the pre-WS-21 layout refuses: there is no shared runtime home to recover into", async () => {
    const bed = runHomeBed();
    const { sdk } = router(bed, false);
    await expect(sdk.reconcileRootForRecovery(stagingWith(bed, []))).rejects.toThrow(/requireRunHome/);
  });
});
