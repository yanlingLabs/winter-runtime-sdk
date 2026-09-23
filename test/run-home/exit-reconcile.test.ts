// WS-21 §3.8: the exit reconcile — inside the proxy's gate, through the router's own store, on the
// config-dir ROOT; clean/appended is safe, "nothing found" after mirrored frames is quarantined, a
// diverged copy is quarantined with its files kept; and a late mirror flush never doubles a record.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { WINTER_BRAND, WinterCompatibilitySessionStore, type SessionKey, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import type { RunHomeOutcome } from "../../src/index.ts";
import { runHomeExitReconciler } from "../../src/run-home/exit.ts";
import { createSupervisedSpawnProxy } from "../../src/official/spawn-proxy.ts";
import { createSharedSessionStore, type SharedSessionStore } from "../../src/store/wiring.ts";
import { createFakeWinterPeer } from "../../src/testing/index.ts";
import type { RuntimeSdkPeers } from "../../src/index.ts";
import { RESUME_STAGING_PREFIX } from "../../src/vendor-paths.ts";
import { cleanupRunHomeBeds, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const KEY: SessionKey = { projectKey: "-ws21-exit", sessionId: "22222222-3333-4444-8555-666666666666" };

function sharedFor(sdkHome: string): SharedSessionStore {
  const { peer } = createFakeWinterPeer();
  const peers = { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"] };
  return createSharedSessionStore({ peers, winterHome: join(sdkHome, ".."), storeHome: sdkHome, policy: { batchWindowMs: 1 } });
}

function chain(count: number, from: string | null = null): SessionStoreEntry[] {
  const out: SessionStoreEntry[] = [];
  let parent = from;
  for (let i = 0; i < count; i += 1) {
    const uuid = randomUUID();
    out.push({ type: "user", uuid, parentUuid: parent, sessionId: KEY.sessionId, timestamp: new Date(0).toISOString(), cwd: "/w", version: "0", isSidechain: false, message: { role: "user", content: `line ${i}` } });
    parent = uuid;
  }
  return out;
}

/** A working copy under `<root>/projects/<key>/<id>.jsonl`. */
function workingCopy(root: string, entries: SessionStoreEntry[]): string {
  const dir = join(root, "projects", KEY.projectKey);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${KEY.sessionId}.jsonl`);
  writeFileSync(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  return path;
}

const canonicalLines = (sdkHome: string): string[] => {
  const path = join(sdkHome, "projects", KEY.projectKey, `${KEY.sessionId}.jsonl`);
  return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n").filter((line) => line.length > 0) : [];
};

function hook(args: { shared: SharedSessionStore; home: string; mirrored?: number; outcomes: Map<string, RunHomeOutcome> }) {
  return runHomeExitReconciler({ shared: args.shared, runId: "run-1", home: args.home, mirrored: () => args.mirrored ?? 0, record: (runId, outcome) => void args.outcomes.set(runId, outcome) });
}

const exit = { code: 0, signal: null };

describe("the exit reconcile", () => {
  test("a fresh generation with an unmirrored tail: appended through the store → safe", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(4);
    await shared.store.append(KEY, entries.slice(0, 2)); // the mirror got the first two
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, entries); // claude wrote all four locally
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 2, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(canonicalLines(bed.sdk).map((line) => (JSON.parse(line) as { uuid: string }).uuid)).toEqual(entries.map((entry) => String(entry["uuid"])));
  });

  test("a clean copy is safe and appends nothing", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(3);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, entries);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 3, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(canonicalLines(bed.sdk)).toHaveLength(3);
  });

  test("a resume: the STAGING ROOT is reconciled (the hook sees the working copy before the wrapper deletes it)", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(3);
    await shared.store.append(KEY, entries.slice(0, 1));
    await shared.settle(KEY);
    const staging = join(bed.root, `${RESUME_STAGING_PREFIX}00000000-0000-4000-8000-000000000777`);
    workingCopy(staging, entries);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 0, outcomes })({ observation: { root: { configDir: staging } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(canonicalLines(bed.sdk)).toHaveLength(3);
  });

  test("no working copy at all after mirrored frames is UNKNOWN, never clean → quarantined", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    mkdirSync(join(runFolder, "projects"), { recursive: true });
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 5, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("quarantined");
    expect(readdirSync(join(bed.home, "cache", "quarantine")).some((name) => name.endsWith("-run-1"))).toBe(true);
  });

  test("no working copy and nothing mirrored: the generation never wrote → safe", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    mkdirSync(join(runFolder, "projects"), { recursive: true });
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 0, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
  });

  test("a diverged copy is quarantined, and its files are kept under cache/quarantine", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    await shared.store.append(KEY, chain(2));
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    const local = workingCopy(runFolder, chain(3)); // a different history
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 2, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("quarantined");
    const quarantine = join(bed.home, "cache", "quarantine");
    const [dir] = readdirSync(quarantine).filter((name) => name.endsWith("-run-1"));
    expect(dir).toBeDefined();
    expect(readFileSync(join(quarantine, dir!, "projects", KEY.projectKey, `${KEY.sessionId}.jsonl`), "utf8")).toBe(readFileSync(local, "utf8"));
  });

  test("a late mirror flush after the reconcile appended the tail does not double a record", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(4);
    await shared.store.append(KEY, entries.slice(0, 2));
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, entries);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 2, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    // The wrapper's final batch arrives after the exit was revealed.
    await shared.store.append(KEY, entries.slice(2));
    await shared.settle(KEY);
    const uuids = canonicalLines(bed.sdk).map((line) => (JSON.parse(line) as { uuid: string }).uuid);
    expect(uuids).toEqual(entries.map((entry) => String(entry["uuid"])));
  });
});

describe("fix round 1, I3: a failed mirror batch is repaired by the exit reconcile, not quarantined", () => {
  test("the batch fails (append-failed), the reconcile appends the whole working copy, the outcome is safe", async () => {
    const bed = runHomeBed();
    const failing = { on: false };
    class FlakyStore extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (failing.on) throw new Error("the disk said no");
        return super.append(key, entries);
      }
    }
    const { peer } = createFakeWinterPeer();
    const peers = { winter: { ...peer, WinterCompatibilitySessionStore: FlakyStore } as unknown as RuntimeSdkPeers["winter"] };
    const shared = createSharedSessionStore({ peers, winterHome: bed.home, storeHome: bed.sdk, policy: { batchWindowMs: 1, backoffMs: 1 } });
    const entries = chain(3);
    failing.on = true;
    await shared.store.append(KEY, entries); // the wrapper's mirror batch — every attempt fails
    await shared.settle(KEY);
    expect(shared.health(KEY).transcriptHealth).toBe("repair-required");
    expect(shared.health(KEY).errors.at(-1)?.cause).toBe("append-failed");
    failing.on = false;
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, entries); // claude's own local copy has all three
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 3, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(canonicalLines(bed.sdk).map((line) => (JSON.parse(line) as { uuid: string }).uuid)).toEqual(entries.map((entry) => String(entry["uuid"])));
    expect(shared.health(KEY).transcriptHealth).toBe("ok");
  });
});

describe("the hook inside the proxy's gate", () => {
  test("the outcome is recorded BEFORE the SDK can observe the exit", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    mkdirSync(join(runFolder, "projects"), { recursive: true });
    const outcomes = new Map<string, RunHomeOutcome>();
    const seenAtExit: Array<RunHomeOutcome | undefined> = [];
    const stdout = new PassThrough();
    const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const child = {
      pid: 777,
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      kill: () => true,
      on(event: string, listener: (code: number | null, signal: NodeJS.Signals | null) => void) {
        if (event === "exit") exits.push(listener);
        return this;
      },
    };
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: runFolder,
      runHome: { dir: runFolder },
      sink: { record: () => undefined },
      reconcile: hook({ shared, home: bed.home, mirrored: 0, outcomes }),
      spawnChild: () => child as never,
    });
    const handle = proxy.spawn({ command: "/vendored/claude", args: ["--setting-sources=user"], cwd: "/w", env: { CLAUDE_CONFIG_DIR: runFolder }, signal: new AbortController().signal }) as unknown as {
      on(event: "exit", listener: () => void): void;
    };
    handle.on("exit", () => seenAtExit.push(outcomes.get("run-1")));
    await proxy.whenRecorded();
    stdout.end();
    for (const listener of exits) listener(0, null);
    await proxy.whenSettled();
    expect(seenAtExit).toEqual(["safe"]);
  });
});

describe("minors round, item 6: the exit reconcile (no judge) clears repair flags PER SESSION", () => {
  test("a root with one level session and one diverged session: the root is quarantined, the level session's flag is cleared, the diverged one's stays", async () => {
    const bed = runHomeBed();
    const failing = { on: false };
    class FlakyStore extends WinterCompatibilitySessionStore {
      override async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
        if (failing.on) throw new Error("the disk said no");
        return super.append(key, entries);
      }
    }
    const { peer } = createFakeWinterPeer();
    const peers = { winter: { ...peer, WinterCompatibilitySessionStore: FlakyStore } as unknown as RuntimeSdkPeers["winter"] };
    const shared = createSharedSessionStore({ peers, winterHome: bed.home, storeHome: bed.sdk, policy: { batchWindowMs: 1, backoffMs: 1 } });
    const level: SessionKey = { projectKey: KEY.projectKey, sessionId: "aaaaaaaa-0000-4000-8000-00000000000a" };
    const diverged: SessionKey = { projectKey: KEY.projectKey, sessionId: "bbbbbbbb-0000-4000-8000-00000000000b" };
    const forKey = (key: SessionKey, entries: SessionStoreEntry[]): SessionStoreEntry[] => entries.map((entry) => ({ ...entry, sessionId: key.sessionId }));
    const levelEntries = forKey(level, chain(3));
    const divergedEntries = forKey(diverged, chain(2));
    await shared.store.append(level, levelEntries.slice(0, 2));
    await shared.store.append(diverged, divergedEntries);
    await shared.settle();
    failing.on = true;
    for (const key of [level, diverged]) {
      await shared.store.append(key, forKey(key, chain(1)));
      await shared.settle(key);
      expect(shared.health(key).transcriptHealth).toBe("repair-required");
    }
    failing.on = false;
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    const write = (key: SessionKey, entries: SessionStoreEntry[]): void => {
      const dir = join(runFolder, "projects", key.projectKey);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${key.sessionId}.jsonl`), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    };
    write(level, levelEntries); // an appendable tail
    write(diverged, [divergedEntries[0]!, forKey(diverged, chain(1, String(divergedEntries[0]!["uuid"])))[0]!]); // a line the canonical file never had
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 5, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("quarantined");
    expect(shared.health(level).transcriptHealth).toBe("ok");
    expect(shared.health(diverged).transcriptHealth).toBe("repair-required");
  });
});

describe("session artifacts: every non-transcript file under projects/<key>/ is carried back into the shared store", () => {
  /** A working copy with the transcript level and the artifact set claude 2.1.250 was measured writing. */
  function workingCopyWithArtifacts(root: string, entries: SessionStoreEntry[]): Record<string, string> {
    workingCopy(root, entries);
    const session = join(root, "projects", KEY.projectKey, KEY.sessionId);
    const files: Record<string, string> = {
      [`${KEY.sessionId}/tool-results/b1.txt`]: "a large tool output\n",
      [`${KEY.sessionId}/workflows/scripts/sv-flow-wf_1.js`]: "export const meta = { name: \"sv-flow\", description: \"d\" };\n",
      [`${KEY.sessionId}/workflows/wf_1.json`]: "{\"runId\":\"wf_1\"}\n",
      "notes-beside-the-sessions.md": "a per-project file\n",
    };
    for (const [path, content] of Object.entries(files)) {
      const full = join(root, "projects", KEY.projectKey, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    // A subagent TRANSCRIPT is the reconcile's, not an artifact.
    mkdirSync(join(session, "subagents"), { recursive: true });
    writeFileSync(join(session, "subagents", "agent-a1.jsonl"), "");
    return files;
  }
  const inStore = (sdk: string, path: string): string => join(sdk, "projects", KEY.projectKey, path);

  test("the exit reconcile carries tool results, workflow scripts and run records and per-project files; the outcome is safe", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(2);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    const files = workingCopyWithArtifacts(runFolder, entries);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 2, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    for (const [path, content] of Object.entries(files)) expect([path, readFileSync(inStore(bed.sdk, path), "utf8")]).toEqual([path, content]);
    // The transcripts were NOT copied as files: the canonical transcript is the store's own.
    expect(existsSync(inStore(bed.sdk, `${KEY.sessionId}/subagents/agent-a1.jsonl`))).toBe(false);
  });

  test("a DIFFERENT destination is never overwritten — the working copy's file is quarantined and the outcome says so; an identical one is fine", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(1);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopyWithArtifacts(runFolder, entries);
    mkdirSync(inStore(bed.sdk, `${KEY.sessionId}/tool-results`), { recursive: true });
    writeFileSync(inStore(bed.sdk, `${KEY.sessionId}/tool-results/b1.txt`), "the store's own, different\n");
    mkdirSync(inStore(bed.sdk, `${KEY.sessionId}/workflows`), { recursive: true });
    writeFileSync(inStore(bed.sdk, `${KEY.sessionId}/workflows/wf_1.json`), "{\"runId\":\"wf_1\"}\n"); // identical
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("quarantined");
    expect(readFileSync(inStore(bed.sdk, `${KEY.sessionId}/tool-results/b1.txt`), "utf8")).toBe("the store's own, different\n");
    const quarantine = join(bed.home, "cache", "quarantine");
    const [dir] = readdirSync(quarantine);
    expect(readFileSync(join(quarantine, dir!, "projects", KEY.projectKey, KEY.sessionId, "tool-results", "b1.txt"), "utf8")).toBe("a large tool output\n");
    // Everything else still landed.
    expect(existsSync(inStore(bed.sdk, `${KEY.sessionId}/workflows/scripts/sv-flow-wf_1.js`))).toBe(true);
  });

  test("a link in the working copy is never followed, and nothing is written through a link in the store", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(1);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopyWithArtifacts(runFolder, entries);
    const secret = join(bed.root, "outside-secret.txt");
    writeFileSync(secret, "never copied\n");
    symlinkSync(secret, join(runFolder, "projects", KEY.projectKey, KEY.sessionId, "tool-results", "evil.txt"));
    // The STORE side: the session's `workflows/` is a link to somewhere else.
    const elsewhere = join(bed.root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(inStore(bed.sdk, KEY.sessionId), { recursive: true });
    symlinkSync(elsewhere, inStore(bed.sdk, `${KEY.sessionId}/workflows`));
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(existsSync(inStore(bed.sdk, `${KEY.sessionId}/tool-results/evil.txt`))).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(outcomes.get("run-1")).toBe("quarantined");
    expect(existsSync(inStore(bed.sdk, `${KEY.sessionId}/tool-results/b1.txt`))).toBe(true);
  });

  test("the staged-resume root (claude-resume-*) is carried back the same way", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(1);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const staging = join(bed.root, `${RESUME_STAGING_PREFIX}${KEY.sessionId}`);
    const files = workingCopyWithArtifacts(staging, entries);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: staging } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    for (const path of Object.keys(files)) expect([path, existsSync(inStore(bed.sdk, path))]).toEqual([path, true]);
  });
});

describe("review I-1: the carry-back never writes a file the STORE owns, and nested subagent transcripts are reconciled", () => {
  const subKey: SessionKey = { ...KEY, subpath: "subagents/agent-a1" };
  const nestedKey: SessionKey = { ...KEY, subpath: "subagents/workflows/wf_1/agent-w1" };
  const subEntries = (key: SessionKey, count: number): SessionStoreEntry[] => chain(count).map((entry) => ({ ...entry, sessionId: key.sessionId, isSidechain: true, agentId: "a1" }));
  const meta = (withType: boolean): Record<string, unknown> => ({ ...(withType ? { type: "agent_metadata" } : {}), agentType: "general-purpose", description: "a sub" });
  const writeLocal = (root: string, relative: string, content: string): void => {
    const full = join(root, "projects", KEY.projectKey, KEY.sessionId, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  };
  const inStore = (sdk: string, relative: string): string => join(sdk, "projects", KEY.projectKey, KEY.sessionId, relative);

  test("the mirror already wrote the subagent's .meta.json (WITH `type`); claude's local copy (without it) never conflicts — the exit ends safe and the store's file is untouched", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const main = chain(1);
    const sub = subEntries(subKey, 2);
    await shared.store.append(KEY, main);
    await shared.store.append(subKey, [...sub, meta(true) as SessionStoreEntry]);
    await shared.settle();
    const storeMeta = readFileSync(inStore(bed.sdk, "subagents/agent-a1.meta.json"), "utf8");
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, main);
    writeLocal(runFolder, "subagents/agent-a1.jsonl", sub.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    writeLocal(runFolder, "subagents/agent-a1.meta.json", `${JSON.stringify(meta(false))}\n`);
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 3, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(readFileSync(inStore(bed.sdk, "subagents/agent-a1.meta.json"), "utf8")).toBe(storeMeta);
  });

  test("with NO .meta.json in the store, claude's is still never copied into that slot (load() would read it back as a record); nor any other store-owned name", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const main = chain(1);
    await shared.store.append(KEY, main);
    await shared.settle();
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, main);
    writeLocal(runFolder, "subagents/agent-a1.meta.json", `${JSON.stringify(meta(false))}\n`);
    const planted = [`../${KEY.sessionId}.summary.json`, `../${KEY.sessionId}.lock`, `../${KEY.sessionId}.jsonl.tail-quarantine`, "subagents/agent-a1.jsonl.tmp-1-2-x", "x.provider-state.jsonl"];
    for (const relative of planted) writeLocal(runFolder, relative, "planted\n");
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    expect(existsSync(inStore(bed.sdk, "subagents/agent-a1.meta.json"))).toBe(false);
    // The store keeps its OWN summary and lock beside the transcript; what matters is that none of them is the planted copy.
    for (const relative of planted) {
      const target = inStore(bed.sdk, relative);
      expect([relative, existsSync(target) && readFileSync(target, "utf8") === "planted\n"]).toEqual([relative, false]);
    }
    expect((await shared.store.load(KEY))?.filter((entry) => entry["type"] !== "agent_metadata")).toHaveLength(1);
  });

  test("a NESTED workflow-subagent transcript (subagents/workflows/<run>/agent-*.jsonl) is reconciled through the store, never copied as a file", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const main = chain(1);
    await shared.store.append(KEY, main);
    await shared.settle();
    const nested = subEntries(nestedKey, 2);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, main);
    // Spelled with a space after each `{`: a RAW copy would keep it, an append through the store re-serializes.
    writeLocal(runFolder, "subagents/workflows/wf_1/agent-w1.jsonl", nested.map((entry) => `${JSON.stringify(entry).replace(/^\{/, "{ ")}\n`).join(""));
    const outcomes = new Map<string, RunHomeOutcome>();
    await hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: runFolder } }, exit });
    expect(outcomes.get("run-1")).toBe("safe");
    const loaded = ((await shared.store.load(nestedKey)) ?? []).filter((entry) => entry["type"] !== "agent_metadata");
    expect(loaded.map((entry) => entry["uuid"])).toEqual(nested.map((entry) => entry["uuid"]));
    expect(readFileSync(inStore(bed.sdk, "subagents/workflows/wf_1/agent-w1.jsonl"), "utf8")).not.toContain('{ "');
  });
});

describe("review minor: the exit hook never throws", () => {
  test("a diverged working copy whose quarantine cannot be written (a linked cache) leaves the outcome PENDING — the folder is the only copy — logs why, and the hook resolves", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(2);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, [entries[0]!, ...chain(1, String(entries[0]!["uuid"]))]); // diverged at line 2
    // `<home>/cache` becomes a LINK after the run folder exists: the quarantine refuses to write through it.
    const realCache = join(bed.root, "real-cache");
    Bun.spawnSync(["mv", join(bed.home, "cache"), realCache]);
    symlinkSync(realCache, join(bed.home, "cache"));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    const outcomes = new Map<string, RunHomeOutcome>();
    try {
      await expect(hook({ shared, home: bed.home, mirrored: 2, outcomes })({ observation: { root: { configDir: runFolder } }, exit })).resolves.toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(outcomes.has("run-1")).toBe(false);
    expect(warnings.some((line) => line.includes("run-1") && line.includes("pending"))).toBe(true);
  });

  test("an artifact conflict whose quarantine cannot be written leaves the outcome pending too", async () => {
    const bed = runHomeBed();
    const shared = sharedFor(bed.sdk);
    const entries = chain(1);
    await shared.store.append(KEY, entries);
    await shared.settle(KEY);
    const runFolder = join(bed.home, "cache", "runs", "run-1");
    workingCopy(runFolder, entries);
    const local = join(runFolder, "projects", KEY.projectKey, KEY.sessionId, "tool-results", "r.txt");
    mkdirSync(join(local, ".."), { recursive: true });
    writeFileSync(local, "working\n");
    const store = join(bed.sdk, "projects", KEY.projectKey, KEY.sessionId, "tool-results", "r.txt");
    mkdirSync(join(store, ".."), { recursive: true });
    writeFileSync(store, "store\n");
    const realCache = join(bed.root, "real-cache");
    Bun.spawnSync(["mv", join(bed.home, "cache"), realCache]);
    symlinkSync(realCache, join(bed.home, "cache"));
    const original = console.warn;
    console.warn = () => undefined;
    const outcomes = new Map<string, RunHomeOutcome>();
    try {
      await expect(hook({ shared, home: bed.home, mirrored: 1, outcomes })({ observation: { root: { configDir: runFolder } }, exit })).resolves.toBeUndefined();
    } finally {
      console.warn = original;
    }
    expect(outcomes.has("run-1")).toBe(false);
    expect(readFileSync(store, "utf8")).toBe("store\n");
  });
});
