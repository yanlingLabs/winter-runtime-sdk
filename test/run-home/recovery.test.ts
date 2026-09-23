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

function router(bed: RunHomeBed, requireRunHome = true, Store: typeof WinterCompatibilitySessionStore = WinterCompatibilitySessionStore) {
  const { peer } = createFakeWinterPeer();
  const peers = {
    winter: {
      ...peer,
      WinterCompatibilitySessionStore: Store,
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

    expect((await sdk.reconcileRootForRecovery(root)).outcome).toBe("appended");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), String(answer["uuid"]), String(tail["uuid"])]);
  });

  test("a clean root is `clean` and appends nothing", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle(KEY);
    expect((await sdk.reconcileRootForRecovery(stagingWith(bed, [JSON.stringify(first)]))).outcome).toBe("clean");
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
    expect((await sdk.reconcileRootForRecovery(root)).outcome).toBe("quarantined");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), String(second["uuid"])]);
    const quarantine = join(bed.home, "cache", "quarantine");
    expect(existsSync(quarantine)).toBe(true);
    const [dir] = readdirSync(quarantine);
    expect(existsSync(join(quarantine, dir!, "projects", KEY.projectKey, `${KEY.sessionId}.jsonl`))).toBe(true);
  });

  test("a crashed resume root whose tail starts with the barrier's staged handoff note is quarantined — the note is never washed back", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const second = user("q2", String(first["uuid"]));
    await shared.store.append(KEY, [first, second]);
    await shared.settle(KEY);
    // The shape step 8 stages: the canonical copy, then ONE trailing labeled note (copy-only under the
    // preferred door), then whatever the resumed child wrote.
    const note = user("[handoff: continued from the winter-agent runtime at 2026-09-23T00:00:00.000Z]\nthe note", String(second["uuid"]));
    const tail = user("q3 after the resume", String(note["uuid"]));
    const root = stagingWith(bed, [JSON.stringify(first), JSON.stringify(second), JSON.stringify(note), JSON.stringify(tail)]);
    expect((await sdk.reconcileRootForRecovery(root)).outcome).toBe("quarantined");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), String(second["uuid"])]);
  });

  test("a router on the pre-WS-21 layout refuses: there is no shared runtime home to recover into", async () => {
    const bed = runHomeBed();
    const { sdk } = router(bed, false);
    await expect(sdk.reconcileRootForRecovery(stagingWith(bed, []))).rejects.toThrow(/requireRunHome/);
  });
});

describe("per-transcript outcomes (I6): one unprovable transcript never quarantines the whole root", () => {
  /** A multi-session pre-WS-21 spool root (`runtimes/claude-config`), as Migration C hands it over. */
  test("a spool root with one clean, one canonical-ahead, one appendable and one diverged session: each gets its own outcome, only the diverged one is quarantined, the tail lands, the level sessions are marked", async () => {
    const bed = runHomeBed();
    const failing = { on: false };
    class FlakyStore extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (failing.on) throw new Error("the disk said no");
        return super.append(key, entries);
      }
    }
    const { sdk, shared } = router(bed, true, FlakyStore);
    const keyOf = (projectKey: string, n: number): SessionKey => ({ projectKey, sessionId: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}` });
    const clean = keyOf("-proj-a", 1);
    const ahead = keyOf("-proj-a", 2);
    const appendable = keyOf("-proj-b", 3);
    const diverged = keyOf("-proj-b", 4);
    const turn = (key: SessionKey, content: string, parent: string | null): SessionStoreEntry => ({ ...user(content, parent), sessionId: key.sessionId });
    const chainFor = (key: SessionKey, count: number): SessionStoreEntry[] => {
      const out: SessionStoreEntry[] = [];
      for (let i = 0; i < count; i += 1) out.push(turn(key, `${key.sessionId} turn ${i}`, i === 0 ? null : String(out[i - 1]!["uuid"])));
      return out;
    };
    const canonical = { clean: chainFor(clean, 2), ahead: chainFor(ahead, 3), appendable: chainFor(appendable, 1), diverged: chainFor(diverged, 2) };
    for (const [key, entries] of [[clean, canonical.clean], [ahead, canonical.ahead], [appendable, canonical.appendable], [diverged, canonical.diverged]] as const) {
      await shared.store.append(key, [...entries]);
      await shared.settle(key);
    }
    // Every session starts repair-required (a failed mirror batch), so "marked" is observable.
    failing.on = true;
    for (const key of [clean, ahead, appendable, diverged]) {
      await shared.store.append(key, [turn(key, "a batch that never lands", null)]);
      await shared.settle(key);
      expect(shared.health(key).transcriptHealth).toBe("repair-required");
    }
    failing.on = false;

    // The spool: the clean copy; the ahead copy PREDATES the canonical file's later (e.g. Winter-leg)
    // turn; the appendable copy has a tail the canonical file lacks; the diverged copy has a line the
    // canonical file never had, at a position the canonical file has another.
    const root = join(bed.home, "runtimes", "claude-config");
    const write = (key: SessionKey, entries: SessionStoreEntry[]): void => {
      const dir = join(root, "projects", key.projectKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${key.sessionId}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    };
    write(clean, canonical.clean);
    write(ahead, canonical.ahead.slice(0, 2));
    const tail = turn(appendable, "the tail the mirror never wrote", String(canonical.appendable[0]!["uuid"]));
    write(appendable, [...canonical.appendable, tail]);
    write(diverged, [canonical.diverged[0]!, turn(diverged, "a line only the spool has", String(canonical.diverged[0]!["uuid"]))]);

    const report = await sdk.reconcileRootForRecovery(root);
    const byId = new Map(report.transcripts.map((transcript) => [transcript.sessionId, transcript]));
    expect(report.transcripts).toHaveLength(4);
    expect(byId.get(clean.sessionId)).toMatchObject({ projectKey: clean.projectKey, outcome: "clean", appended: 0 });
    expect(byId.get(ahead.sessionId)).toMatchObject({ projectKey: ahead.projectKey, outcome: "canonical-ahead", appended: 0 });
    expect(byId.get(appendable.sessionId)).toMatchObject({ projectKey: appendable.projectKey, outcome: "appended", appended: 1 });
    expect(byId.get(diverged.sessionId)).toMatchObject({ projectKey: diverged.projectKey, outcome: "quarantined", appended: 0 });
    expect(typeof byId.get(diverged.sessionId)?.reason).toBe("string");
    // The root outcome summarises: something was quarantined.
    expect(report.outcome).toBe("quarantined");

    // The tail landed; the ahead and clean files are untouched; the diverged file is untouched.
    const uuidsOf = (key: SessionKey): string[] =>
      readFileSync(join(bed.sdk, "projects", key.projectKey, `${key.sessionId}.jsonl`), "utf8").trimEnd().split("\n").map((line) => (JSON.parse(line) as { uuid: string }).uuid);
    expect(uuidsOf(appendable)).toEqual([...canonical.appendable, tail].map((entry) => String(entry["uuid"])));
    expect(uuidsOf(ahead)).toEqual(canonical.ahead.map((entry) => String(entry["uuid"])));
    expect(uuidsOf(clean)).toEqual(canonical.clean.map((entry) => String(entry["uuid"])));
    expect(uuidsOf(diverged)).toEqual(canonical.diverged.map((entry) => String(entry["uuid"])));

    // ONLY the diverged transcript was quarantined — one quarantine dir, holding exactly that file.
    const quarantine = join(bed.home, "cache", "quarantine");
    const dirs = readdirSync(quarantine);
    expect(dirs).toHaveLength(1);
    expect(report.quarantine).toBe(join(quarantine, dirs[0]!));
    const quarantinedFiles = readdirSync(join(quarantine, dirs[0]!), { recursive: true }).map(String).filter((name) => name.endsWith(".jsonl"));
    expect(quarantinedFiles).toEqual([join("projects", diverged.projectKey, `${diverged.sessionId}.jsonl`)]);

    // The level sessions are marked; the quarantined one keeps its repair flag.
    for (const key of [clean, ahead, appendable]) expect([key.sessionId, shared.health(key).transcriptHealth]).toEqual([key.sessionId, "ok"]);
    expect(shared.health(diverged).transcriptHealth).toBe("repair-required");
  });

  test("canonical-ahead whose working copy is NOT a prefix (a line the canonical history moved past) is quarantined — never called nothing-to-append", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const later = [user("q2 on the Winter leg", String(first["uuid"]))];
    later.push(user("q3 on the Winter leg", String(later[0]!["uuid"])));
    await shared.store.append(KEY, [first, ...later]);
    await shared.settle(KEY);
    const orphan = user("q2 only the crashed copy has", String(first["uuid"]));
    const report = await sdk.reconcileRootForRecovery(stagingWith(bed, [JSON.stringify(first), JSON.stringify(orphan)]));
    expect(report.transcripts.map((transcript) => transcript.outcome)).toEqual(["quarantined"]);
    expect(report.outcome).toBe("quarantined");
    expect(canonicalUuids(bed)).toEqual([String(first["uuid"]), ...later.map((entry) => String(entry["uuid"]))]);
  });

  test("an empty root is `clean` with no transcripts", async () => {
    const bed = runHomeBed();
    const { sdk } = router(bed);
    const root = join(bed.root, "an-empty-root");
    mkdirSync(join(root, "projects"), { recursive: true });
    expect(await sdk.reconcileRootForRecovery(root)).toEqual({ outcome: "clean", transcripts: [] });
    expect(existsSync(join(bed.home, "cache", "quarantine"))).toBe(false);
  });
});
