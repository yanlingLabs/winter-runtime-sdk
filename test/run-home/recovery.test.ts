// WS-21 §3.8: recovery after a crash — `sdk.reconcileRootForRecovery(root)` recomputes the claude-ready
// copy the root was staged from, proves the canonical file a prefix of the working copy (or quarantines),
// and appends the tail through the router's own store.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";
import { toClaudeReady } from "@yanlinglabs/winter-provider-runtime";

import { createRuntimeSdk, runtimeSdkInternals, type RuntimeSdkPeers } from "../../src/index.ts";
import { defaultEndpointResolver } from "../../src/default-endpoint-resolver.ts";
import { createSharedSessionStore, type SharedSessionStore } from "../../src/store/wiring.ts";
import { reconcileRootForRecovery, recoveryOutcomeOf } from "../../src/run-home/exit.ts";
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

describe("minors round: the recovery door's own branches", () => {
  /** A router-less recovery input over a fresh shared store, with a resolver that can be made to fail. */
  function recoveryBed(resolverThrows: boolean) {
    const bed = runHomeBed();
    const { peer } = createFakeWinterPeer();
    const peers = { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"] };
    const shared = createSharedSessionStore({ peers, winterHome: bed.home, storeHome: bed.sdk, policy: { batchWindowMs: 1 } });
    const resolver = defaultEndpointResolver();
    const input = {
      shared,
      home: bed.home,
      storeHome: bed.sdk,
      resolveEndpoint: resolverThrows
        ? () => {
            throw new Error("no endpoint for the claude target");
          }
        : resolver,
    };
    return { bed, shared, input };
  }

  test("item 3: with NO fold at all (the claude target cannot be resolved), a raw-prefix copy is still canonical-ahead and an equal copy clean — the raw branch needs no fold; an appendable tail, which does, is quarantined", async () => {
    const { bed, shared, input } = recoveryBed(true);
    const keyOf = (n: number): SessionKey => ({ projectKey: KEY.projectKey, sessionId: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}` });
    const [ahead, equal, tail] = [keyOf(1), keyOf(2), keyOf(3)];
    const turns = (key: SessionKey, count: number): SessionStoreEntry[] => {
      const out: SessionStoreEntry[] = [];
      for (let i = 0; i < count; i += 1) out.push({ ...user(`turn ${i}`, i === 0 ? null : String(out[i - 1]!["uuid"])), sessionId: key.sessionId });
      return out;
    };
    const entries = { ahead: turns(ahead, 3), equal: turns(equal, 2), tail: turns(tail, 2) };
    await shared.store.append(ahead, entries.ahead);
    await shared.store.append(equal, entries.equal);
    await shared.store.append(tail, entries.tail.slice(0, 1));
    await shared.settle();
    const root = join(bed.root, "crashed-root");
    const write = (key: SessionKey, lines: SessionStoreEntry[]): void => {
      const dir = join(root, "projects", key.projectKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${key.sessionId}.jsonl`), lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    };
    write(ahead, entries.ahead.slice(0, 2));
    write(equal, entries.equal);
    write(tail, entries.tail);
    const report = await reconcileRootForRecovery(root, input);
    const byId = new Map(report.transcripts.map((transcript) => [transcript.sessionId, transcript]));
    expect(byId.get(ahead.sessionId)?.outcome).toBe("canonical-ahead");
    expect(byId.get(equal.sessionId)?.outcome).toBe("clean");
    expect(byId.get(tail.sessionId)).toMatchObject({ outcome: "quarantined", appended: 0 });
    expect(byId.get(tail.sessionId)?.reason).toContain("cannot be recomputed");
  });

  test("item 4: the quarantine reason says 'after appending' only when an append happened — a store that accepts the append and writes nothing", async () => {
    const bed = runHomeBed();
    const swallowing = { on: false };
    class SwallowingStore extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (swallowing.on) return; // "succeeds", lands nothing
        return super.append(key, entries);
      }
    }
    const { sdk, shared } = router(bed, true, SwallowingStore);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle(KEY);
    swallowing.on = true;
    const tail = user("q2 the store swallows", String(first["uuid"]));
    const report = await sdk.reconcileRootForRecovery(stagingWith(bed, [JSON.stringify(first), JSON.stringify(tail)]));
    expect(report.transcripts).toHaveLength(1);
    expect(report.transcripts[0]).toMatchObject({ outcome: "quarantined", appended: 0 });
    expect(report.transcripts[0]!.reason).toContain("after appending 1");
  });

  test("item 4: the mapping names the comparison's own reason when no append was attempted", () => {
    const key: SessionKey = { projectKey: KEY.projectKey, sessionId: KEY.sessionId };
    const diverged = recoveryOutcomeOf({ key, localPath: "/x", comparison: { kind: "diverged", atLine: 2, reason: "line 2 of the canonical transcript is not the record the local-write root has at that position" }, appended: 0 });
    expect(diverged).toMatchObject({ outcome: "quarantined", appended: 0, reason: "line 2 of the canonical transcript is not the record the local-write root has at that position" });
    const attempted = recoveryOutcomeOf({ key, localPath: "/x", comparison: { kind: "canonical-behind", lines: 1, missing: [] }, appended: 0, attempted: 3 });
    expect(attempted.reason).toContain("after appending 3");
  });

  test("item 6: a quarantined SUBAGENT transcript keeps its session's repair flag while the session's own transcript is level", async () => {
    const bed = runHomeBed();
    const failing = { on: false };
    class FlakyStore extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (failing.on) throw new Error("the disk said no");
        return super.append(key, entries);
      }
    }
    const { sdk, shared } = router(bed, true, FlakyStore);
    const main = [user("main q1", null)];
    const subKey: SessionKey = { ...KEY, subpath: "subagents/agent-a1b2c3" };
    const sub = [user("sub q1", null)];
    await shared.store.append(KEY, main);
    await shared.store.append(subKey, sub);
    await shared.settle();
    failing.on = true;
    await shared.store.append(KEY, [user("a batch that never lands", null)]);
    await shared.settle(KEY);
    expect(shared.health(KEY).transcriptHealth).toBe("repair-required");
    failing.on = false;
    const root = stagingWith(bed, main.map((entry) => JSON.stringify(entry)));
    const subDir = join(root, "projects", KEY.projectKey, KEY.sessionId, "subagents");
    mkdirSync(subDir, { recursive: true });
    const orphan = user("a line only the crashed subagent copy has", null);
    writeFileSync(join(subDir, "agent-a1b2c3.jsonl"), `${JSON.stringify(orphan)}\n`);
    const report = await sdk.reconcileRootForRecovery(root);
    const main_ = report.transcripts.find((transcript) => transcript.subpath === undefined);
    const sub_ = report.transcripts.find((transcript) => transcript.subpath === subKey.subpath);
    expect(main_?.outcome).toBe("clean");
    expect(sub_).toMatchObject({ outcome: "quarantined", subpath: "subagents/agent-a1b2c3" });
    expect(shared.health(KEY).transcriptHealth).toBe("repair-required");
  });
});

describe("session artifacts on the recovery door", () => {
  test("a crashed root's tool results and workflow files are carried back and reported per transcript; a conflicting one is quarantined, never overwritten", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle(KEY);
    const root = stagingWith(bed, [JSON.stringify(first)]);
    const session = join(root, "projects", KEY.projectKey, KEY.sessionId);
    const put = (path: string, content: string): void => {
      mkdirSync(join(session, path, ".."), { recursive: true });
      writeFileSync(join(session, path), content);
    };
    put("tool-results/r1.txt", "a large output\n");
    put("workflows/wf_9.json", "{\"runId\":\"wf_9\"}\n");
    put("tool-results/r2.txt", "the working copy's\n");
    const storeSession = join(bed.sdk, "projects", KEY.projectKey, KEY.sessionId);
    mkdirSync(join(storeSession, "tool-results"), { recursive: true });
    writeFileSync(join(storeSession, "tool-results", "r2.txt"), "the store's own\n");
    const report = await sdk.reconcileRootForRecovery(root);
    expect(report.transcripts).toHaveLength(1);
    expect(report.transcripts[0]).toMatchObject({ outcome: "clean", artifacts: { copied: 2, identical: 0, quarantined: [`${KEY.projectKey}/${KEY.sessionId}/tool-results/r2.txt`] } });
    expect(report.outcome).toBe("quarantined");
    expect(readFileSync(join(storeSession, "tool-results", "r1.txt"), "utf8")).toBe("a large output\n");
    expect(readFileSync(join(storeSession, "workflows", "wf_9.json"), "utf8")).toBe("{\"runId\":\"wf_9\"}\n");
    expect(readFileSync(join(storeSession, "tool-results", "r2.txt"), "utf8")).toBe("the store's own\n");
    expect(readFileSync(join(report.quarantine!, "projects", KEY.projectKey, KEY.sessionId, "tool-results", "r2.txt"), "utf8")).toBe("the working copy's\n");
  });
});

// WS-23 (fix round 1, minor 5): the exit reconcile's cases, ported to the recovery door. The exit hook
// went with the official leg, but `carryBackSessionArtifacts` and `repairTranscriptMetadata` still run
// here for an upgrading host's leftover working copies, so the same three guarantees are pinned on the
// door that still calls them.
describe("the exit reconcile's guarantees, on the recovery door (ported from the retired exit hook)", () => {
  const sub = (key: SessionKey, count: number, parent: string | null = null): SessionStoreEntry[] => {
    const out: SessionStoreEntry[] = [];
    let at = parent;
    for (let i = 0; i < count; i += 1) {
      const entry = { ...user(`sub ${i}`, at), sessionId: key.sessionId, isSidechain: true, agentId: "w1" } as SessionStoreEntry;
      out.push(entry);
      at = String(entry["uuid"]);
    }
    return out;
  };
  const inSession = (root: string, relative: string): string => join(root, "projects", KEY.projectKey, KEY.sessionId, relative);
  const put = (path: string, content: string): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };

  test("a link in the working copy is never followed, and nothing is written through a link in the store", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle(KEY);
    const root = stagingWith(bed, [JSON.stringify(first)]);
    put(inSession(root, "tool-results/b1.txt"), "a large tool output\n");
    put(inSession(root, "workflows/wf_1.json"), "{\"runId\":\"wf_1\"}\n");
    const secret = join(bed.root, "outside-secret.txt");
    writeFileSync(secret, "never copied\n");
    symlinkSync(secret, inSession(root, "tool-results/evil.txt"));
    // The STORE side: the session's `workflows/` is a link to somewhere else.
    const elsewhere = join(bed.root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(inSession(bed.sdk, ""), { recursive: true });
    symlinkSync(elsewhere, inSession(bed.sdk, "workflows"));
    const report = await sdk.reconcileRootForRecovery(root);
    expect(existsSync(inSession(bed.sdk, "tool-results/evil.txt"))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(inSession(bed.sdk, "tool-results/b1.txt"), "utf8")).toBe("a large tool output\n");
    expect(report.outcome).toBe("quarantined");
  });

  test("a file the STORE owns is never written from the working copy — not a .meta.json, a summary, a lock, a tail-quarantine, a temp or a sidecar", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle();
    const root = stagingWith(bed, [JSON.stringify(first)]);
    put(inSession(root, "subagents/agent-a1.meta.json"), `${JSON.stringify({ agentType: "general-purpose", description: "a sub" })}\n`);
    const planted = [`../${KEY.sessionId}.summary.json`, `../${KEY.sessionId}.lock`, `../${KEY.sessionId}.jsonl.tail-quarantine`, "subagents/agent-a1.jsonl.tmp-1-2-x", "x.provider-state.jsonl"];
    for (const relative of planted) put(inSession(root, relative), "planted\n");
    await sdk.reconcileRootForRecovery(root);
    expect(existsSync(inSession(bed.sdk, "subagents/agent-a1.meta.json"))).toBe(false);
    for (const relative of planted) {
      const target = inSession(bed.sdk, relative);
      expect([relative, existsSync(target) && readFileSync(target, "utf8") === "planted\n"]).toEqual([relative, false]);
    }
    expect((await shared.store.load(KEY))?.filter((entry) => entry["type"] !== "agent_metadata")).toHaveLength(1);
  });

  test("a NESTED workflow-subagent transcript (subagents/workflows/<run>/agent-*.jsonl) is reconciled through the store, never copied as a file", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    await shared.store.append(KEY, [first]);
    await shared.settle();
    const nestedKey: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_1/agent-w1" };
    const nested = sub(nestedKey, 2);
    const root = stagingWith(bed, [JSON.stringify(first)]);
    // Spelled with a space after each `{`: a RAW copy would keep it, an append through the store re-serializes.
    put(inSession(root, "subagents/workflows/wf_1/agent-w1.jsonl"), nested.map((entry) => `${JSON.stringify(entry).replace(/^\{/, "{ ")}\n`).join(""));
    const report = await sdk.reconcileRootForRecovery(root);
    expect(report.outcome).not.toBe("quarantined");
    const loaded = ((await shared.store.load(nestedKey)) ?? []).filter((entry) => entry["type"] !== "agent_metadata");
    expect(loaded.map((entry) => entry["uuid"])).toEqual(nested.map((entry) => entry["uuid"]));
    expect(readFileSync(inSession(bed.sdk, "subagents/workflows/wf_1/agent-w1.jsonl"), "utf8")).not.toContain('{ "');
  });
});

describe("review N-1 on the recovery door: journals are proved byte for byte, never through the fold", () => {
  test("a behind run journal is appended, a prefix one is canonical-ahead, a departed session journal is quarantined, and an unrecognised .jsonl is reported skipped", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const line = (n: number): SessionStoreEntry => ({ type: "started", key: `v2:${n}`, agentId: `a${n}` });
    const behind: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_1/journal" };
    const ahead: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_2/journal" };
    const world: SessionKey = { ...KEY, subpath: "world" };
    // The world journal's lines carry no `type` (measured in the pinned binary: `{k:"put"|"settled"|"retracted",addr,…}`).
    const worldLine = (topic: string): SessionStoreEntry => ({ k: "put", addr: 0, fact: { topic } }) as unknown as SessionStoreEntry;
    await shared.store.append(KEY, [first]);
    await shared.store.append(behind, [line(1)]);
    await shared.store.append(ahead, [line(1), line(2)]);
    await shared.store.append(world, [worldLine("canonical")]);
    await shared.settle();
    const root = stagingWith(bed, [JSON.stringify(first)]);
    const session = join(root, "projects", KEY.projectKey, KEY.sessionId);
    const put = (path: string, lines: unknown[]): void => {
      mkdirSync(join(session, path, ".."), { recursive: true });
      writeFileSync(join(session, path), lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    };
    put("subagents/workflows/wf_1/journal.jsonl", [line(1), line(2)]);
    put("subagents/workflows/wf_2/journal.jsonl", [line(1)]);
    put("world.jsonl", [worldLine("working copy")]);
    put("odd.jsonl", [{ a: 1 }]);
    const report = await sdk.reconcileRootForRecovery(root);
    const bySubpath = new Map(report.transcripts.map((transcript) => [transcript.subpath ?? "", transcript]));
    expect(bySubpath.get("")?.outcome).toBe("clean");
    expect(bySubpath.get(behind.subpath!)).toMatchObject({ outcome: "appended", appended: 1 });
    expect(bySubpath.get(ahead.subpath!)?.outcome).toBe("canonical-ahead");
    expect(bySubpath.get("world")?.outcome).toBe("quarantined");
    expect(report.outcome).toBe("quarantined");
    expect(await shared.store.load(behind)).toEqual([line(1), line(2)]);
    expect(await shared.store.load(world)).toEqual([worldLine("canonical")]);
    expect(report.artifacts?.skipped).toEqual([`${KEY.projectKey}/${KEY.sessionId}/odd.jsonl`]);
  });

  test("a journal needs no fold: with the claude target unresolvable, a behind run journal is still appended (a transcript's tail is quarantined there)", async () => {
    const bed = runHomeBed();
    const { peer } = createFakeWinterPeer();
    const peers = { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"] };
    const shared = createSharedSessionStore({ peers, winterHome: bed.home, storeHome: bed.sdk, policy: { batchWindowMs: 1 } });
    const input = {
      shared,
      home: bed.home,
      storeHome: bed.sdk,
      resolveEndpoint: () => {
        throw new Error("no endpoint for the claude target");
      },
    };
    const first = user("q1", null);
    const journalKey: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_1/journal" };
    const lines: SessionStoreEntry[] = [{ type: "started", key: "v2:1", agentId: "a1" }, { type: "result", key: "v2:1", agentId: "a1", result: "sub done" }];
    await shared.store.append(KEY, [first]);
    await shared.store.append(journalKey, lines.slice(0, 1));
    await shared.settle();
    const root = stagingWith(bed, [JSON.stringify(first)]);
    const journal = join(root, "projects", KEY.projectKey, KEY.sessionId, "subagents", "workflows", "wf_1", "journal.jsonl");
    mkdirSync(join(journal, ".."), { recursive: true });
    writeFileSync(journal, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    const report = await reconcileRootForRecovery(root, input);
    expect(report.transcripts.find((transcript) => transcript.subpath === journalKey.subpath)).toMatchObject({ outcome: "appended", appended: 1 });
    expect(report.outcome).toBe("appended");
    expect(await shared.store.load(journalKey)).toEqual(lines);
  });
});

describe("final round on the recovery door: `.meta.json` repaired for level transcripts only", () => {
  test("a behind journal's metadata is appended and counted; a quarantined journal's metadata is not, and is reported skipped", async () => {
    const bed = runHomeBed();
    const { sdk, shared } = router(bed);
    const first = user("q1", null);
    const good: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_1/journal" };
    const bad: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_2/journal" };
    const line = (n: number): SessionStoreEntry => ({ type: "started", key: `v2:${n}`, agentId: `a${n}` });
    await shared.store.append(KEY, [first]);
    await shared.store.append(good, [line(1)]);
    await shared.store.append(bad, [line(9)]);
    await shared.settle();
    const root = stagingWith(bed, [JSON.stringify(first)]);
    const session = join(root, "projects", KEY.projectKey, KEY.sessionId);
    const put = (path: string, text: string): void => {
      mkdirSync(join(session, path, ".."), { recursive: true });
      writeFileSync(join(session, path), text);
    };
    put("subagents/workflows/wf_1/journal.jsonl", `${JSON.stringify(line(1))}\n${JSON.stringify(line(2))}\n`);
    put("subagents/workflows/wf_1/journal.meta.json", JSON.stringify({ agentType: "workflow" }));
    put("subagents/workflows/wf_2/journal.jsonl", `${JSON.stringify(line(1))}\n`);
    put("subagents/workflows/wf_2/journal.meta.json", JSON.stringify({ agentType: "departed" }));
    const report = await sdk.reconcileRootForRecovery(root);
    expect(report.transcripts.find((transcript) => transcript.subpath === bad.subpath)?.outcome).toBe("quarantined");
    expect(report.artifacts?.metadataRepaired).toBe(1);
    expect(report.artifacts?.skipped).toEqual([`${KEY.projectKey}/${KEY.sessionId}/subagents/workflows/wf_2/journal.meta.json`]);
    expect(((await shared.store.load(good)) ?? []).filter((entry) => entry["type"] === "agent_metadata")).toEqual([{ type: "agent_metadata", agentType: "workflow" }]);
    expect(((await shared.store.load(bad)) ?? []).filter((entry) => entry["type"] === "agent_metadata")).toEqual([]);
  });
});
