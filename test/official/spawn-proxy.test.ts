// WS-14 §6's six MUSTs, held to account one at a time, against a FAKE child.
//
// A fake child rather than the real runtime, deliberately: every rule in §6 is about ORDERING — what
// is recorded before what is returned, what is forwarded after what has completed — and ordering is
// exactly the thing a real 200 MB binary makes unobservable. `test/official/runtime-*.test.ts` drives
// the real one; this file proves the mechanics.
//
// THE ASSERTION THIS FILE EXISTS FOR is "the exit gate covers the PROPERTIES, not only the event":
// the pinned runtime's `waitForExit` reads `process.exitCode === 0` and returns without waiting, so a
// proxy that held the event while forwarding the code would let the SDK delete the staging root with
// reconciliation still running. The gated-properties test plants exactly that.
import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import type { RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import type { OfficialSpawnOptions } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { OfficialConfigurationError, type OfficialBranchError } from "../../src/official/errors.ts";
import { createSupervisedSpawnProxy, directoryRecordSink, type SpawnObservation, type SpawnedChildProcess } from "../../src/official/spawn-proxy.ts";
import { revalidateProcessIdentity } from "../../src/official/supervision.ts";

const SPOOL = "/home/.acme/runtimes/official-agent-spool";
const SECRET = "sk-ant-the-one-credential";

/** A controllable stand-in for the child: the test decides when it writes, exits and closes stdout. */
function fakeChild(over: { pid?: number | undefined } = {}): SpawnedChildProcess & {
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  emitError(error: Error): void;
  writeStdout(text: string): void;
  endStdout(): void;
  writeStderr(text: string): void;
  killed: string[];
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errors: Array<(error: Error) => void> = [];
  const killed: string[] = [];
  return {
    pid: "pid" in over ? over.pid : 4711,
    stdin,
    stdout,
    stderr,
    killed,
    kill(signal?: string) {
      killed.push(signal ?? "SIGTERM");
      return true;
    },
    on(event: "exit" | "error", listener: never) {
      if (event === "exit") exits.push(listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void);
      else errors.push(listener as unknown as (error: Error) => void);
      return this;
    },
    emitExit(code, signal = null) {
      for (const listener of exits) listener(code, signal);
    },
    emitError(error) {
      for (const listener of errors) listener(error);
    },
    writeStdout(text) {
      stdout.write(text);
    },
    endStdout() {
      stdout.end();
    },
    writeStderr(text) {
      stderr.write(text);
    },
  };
}

const spawnOptions = (over: Partial<OfficialSpawnOptions> = {}): OfficialSpawnOptions => ({
  command: "/vendored/claude",
  args: ["--print"],
  cwd: "/work",
  env: { CLAUDE_CONFIG_DIR: SPOOL, ANTHROPIC_API_KEY: SECRET, PATH: "/usr/bin" },
  signal: new AbortController().signal,
  ...over,
});

/**
 * A MACROTASK wait, not a microtask drain.
 *
 * Stream `data`/`end` events are delivered on the event loop, so `await Promise.resolve()` returns
 * before a single byte has moved — a distinction that made three of these tests pass for the wrong
 * reason on the first run (they saw "nothing yet" both before AND after the gate opened).
 */
const tick = async (times = 2): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("WS-14 §6 — the supervised spawn proxy", () => {
  test("rule 1: the child is labelled with the PRODUCT's own process label (argv0), never renamed binary", () => {
    const seen: Array<{ argv0: string; command: string }> = [];
    const child = fakeChild();
    const proxy = createSupervisedSpawnProxy({
      brand: { processLabel: "acme", envPrefix: "ACME_" },
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      spawnChild: (opts) => {
        seen.push({ argv0: opts.argv0, command: opts.command });
        return child;
      },
    });
    proxy.spawn(spawnOptions());
    expect(seen).toEqual([{ argv0: "acme", command: "/vendored/claude" }]);
  });

  test("rule 2: the OBSERVED config dir is validated and recorded, and a bad one fails the spawn", () => {
    const records: SpawnObservation[] = [];
    const make = (profile: "fresh-spool" | "store-backed-resume") =>
      createSupervisedSpawnProxy({
        brand: WINTER_BRAND,
        profile,
        configuredConfigDir: SPOOL,
        sink: { record: (o) => void records.push(o) },
        spawnChild: () => fakeChild(),
      });
    const proxy = make("fresh-spool");
    proxy.spawn(spawnOptions());
    expect(records).toHaveLength(1);
    expect(records[0]?.root).toEqual({ configDir: SPOOL, kind: "official-spool", profile: "fresh-spool" });
    expect(records[0]?.processIdentity.pid).toBe(4711);
    expect(Date.parse(records[0]?.processIdentity.startedAt ?? "")).not.toBeNaN();

    // A resume generation records the WRAPPER's staging root, which is the only way to learn it.
    const resume = make("store-backed-resume");
    resume.spawn(spawnOptions({ env: { CLAUDE_CONFIG_DIR: "/tmp/claude-resume-9f2", ANTHROPIC_API_KEY: SECRET } }));
    expect(records[1]?.root.kind).toBe("sdk-resume-staging");

    // And a spawn with no config dir never happens at all.
    expect(() => make("fresh-spool").spawn(spawnOptions({ env: { ANTHROPIC_API_KEY: SECRET } }))).toThrow(OfficialConfigurationError);
  });

  test("rule 2: NOTHING is observable on stdout until the record has settled", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const child = fakeChild();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => gate },
      spawnChild: () => child,
    });
    const process_ = proxy.spawn(spawnOptions());
    const chunks: string[] = [];
    (process_.stdout as PassThrough).on("data", (c: Buffer) => chunks.push(String(c)));

    child.writeStdout('{"type":"system"}\n');
    await tick();
    expect(chunks).toEqual([]); // the record has not settled: the SDK has seen nothing

    release();
    await proxy.whenRecorded();
    await tick();
    expect(chunks.join("")).toContain('"type":"system"');
  });

  test("rule 2: a record that FAILS ends the generation instead of continuing unrecorded", async () => {
    const child = fakeChild();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: {
        record: () => Promise.reject(new Error("the durable store is unavailable")),
      },
      spawnChild: () => child,
    });
    const process_ = proxy.spawn(spawnOptions());
    const errors: Error[] = [];
    process_.on("error", (e) => errors.push(e));
    (process_.stdout as PassThrough).on("error", () => undefined);
    await expect(proxy.whenRecorded()).rejects.toThrow("the durable store is unavailable");
    await tick();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(errors.map((e) => e.message)).toEqual(["the durable store is unavailable"]);
  });

  test("rule 3: the exit is forwarded ONLY after reconciliation — and the PROPERTIES are gated too", async () => {
    const child = fakeChild();
    const order: string[] = [];
    let releaseReconcile: () => void = () => undefined;
    const reconcileGate = new Promise<void>((resolve) => {
      releaseReconcile = resolve;
    });
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "store-backed-resume",
      configuredConfigDir: SPOOL,
      sink: { record: () => void order.push("record"), clear: () => void order.push("clear") },
      reconcile: async ({ observation, exit }) => {
        order.push(`reconcile:${observation.root.kind}:${String(exit.code)}`);
        await reconcileGate;
      },
      spawnChild: () => child,
    });
    const process_ = proxy.spawn(spawnOptions({ env: { CLAUDE_CONFIG_DIR: "/tmp/claude-resume-77" } }));
    const exits: Array<[number | null, string | null]> = [];
    process_.on("exit", (code, signal) => {
      order.push("exit-forwarded");
      exits.push([code, signal]);
    });
    await proxy.whenRecorded();

    child.emitExit(0);
    child.endStdout();
    await tick();

    // THE FAST PATH THE PINNED RUNTIME ACTUALLY TAKES: `exitCode === 0` would end the wait here.
    expect(process_.exitCode).toBeNull();
    expect(process_.killed).toBe(false);
    expect(exits).toEqual([]);
    expect(order).toEqual(["record", "reconcile:sdk-resume-staging:0"]);

    releaseReconcile();
    await proxy.whenSettled();
    expect(process_.exitCode).toBe(0);
    expect(exits).toEqual([[0, null]]);
    expect(order).toEqual(["record", "reconcile:sdk-resume-staging:0", "clear", "exit-forwarded"]);
  });

  test("rule 4: the observation retains no credential, and neither does the durable record", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const selection: RuntimeSelection = {
      runtimeKind: "claude-agent",
      providerId: "anthropic",
      modelRef: "claude-sonnet-4-5",
      family: "claude",
      authFamily: "api-key",
      sdkVersion: "0.0.2",
      reason: "fixture",
      decidedAt: new Date(0).toISOString(),
    };
    const entry: RuntimeDirectoryEntry = {
      address: "session:abc",
      parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: "abc" },
      runtimeKind: "claude-agent",
      objectKind: "session",
      transport: "claude-handle",
      status: "running",
      mode: "code",
      generation: 1,
      selection,
      capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
      updatedAt: new Date(0).toISOString(),
    };
    await store.upsert(entry);
    const child = fakeChild();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: directoryRecordSink({ store, address: entry.address }),
      verifyCleanup: () => true,
      spawnChild: () => child,
    });
    const process_ = proxy.spawn(spawnOptions());
    await proxy.whenRecorded();

    const recorded = (await store.load())[0];
    expect(recorded?.configDir).toBe(SPOOL);
    expect(recorded?.processIdentity).toEqual({ pid: 4711, startedAt: proxy.observation?.processIdentity.startedAt ?? "" });
    // The credential is nowhere: not on the observation, not in the entry, not on the handle.
    expect(JSON.stringify(proxy.observation)).not.toContain(SECRET);
    expect(JSON.stringify(recorded)).not.toContain(SECRET);
    expect(JSON.stringify(Object.keys(process_))).not.toContain(SECRET);

    // rule 5: the record is CLEARED only after verified cleanup.
    child.emitExit(0);
    child.endStdout();
    await proxy.whenSettled();
    const cleared = (await store.load())[0];
    expect("configDir" in (cleared ?? {})).toBe(false);
    expect("processIdentity" in (cleared ?? {})).toBe(false);
  });

  test("rule 5: an UNVERIFIED cleanup keeps the recorded root", async () => {
    const store = createInMemoryRuntimeDirectoryStore();
    const entry: RuntimeDirectoryEntry = {
      address: "session:keeps",
      parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: "keeps" },
      runtimeKind: "claude-agent",
      objectKind: "session",
      transport: "claude-handle",
      status: "running",
      mode: "code",
      generation: 1,
      selection: {
        runtimeKind: "claude-agent",
        providerId: "anthropic",
        modelRef: "m",
        family: "claude",
        authFamily: "api-key",
        sdkVersion: "0.0.2",
        reason: "fixture",
        decidedAt: new Date(0).toISOString(),
      },
      capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
      updatedAt: new Date(0).toISOString(),
    };
    await store.upsert(entry);
    const child = fakeChild();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "store-backed-resume",
      configuredConfigDir: SPOOL,
      sink: directoryRecordSink({ store, address: entry.address }),
      verifyCleanup: () => false, // the staging root is still on disk
      spawnChild: () => child,
    });
    proxy.spawn(spawnOptions({ env: { CLAUDE_CONFIG_DIR: "/tmp/claude-resume-still-there" } }));
    await proxy.whenRecorded();
    child.emitExit(1);
    child.endStdout();
    await proxy.whenSettled();
    expect((await store.load())[0]?.configDir).toBe("/tmp/claude-resume-still-there");
  });

  test("rule 6: stderr is drained continuously and a nonzero exit is a TYPED crash class", async () => {
    const child = fakeChild();
    const crashes: OfficialBranchError[] = [];
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      onCrash: (error) => crashes.push(error),
      spawnChild: () => child,
      stderrTailBytes: 32,
    });
    proxy.spawn(spawnOptions());
    await proxy.whenRecorded();
    child.writeStderr("a".repeat(64));
    child.writeStderr("TAIL");
    await tick();
    expect(proxy.stderrTail.length).toBe(32);
    expect(proxy.stderrTail.endsWith("TAIL")).toBe(true);

    child.emitExit(2, "SIGABRT" as NodeJS.Signals);
    child.endStdout();
    await proxy.whenSettled();
    expect(crashes.map((c) => [c.code, c.crashClass])).toEqual([["official_nonzero_exit", "nonzero-exit"]]);
    expect((crashes[0] as { stderrTail?: string }).stderrTail?.endsWith("TAIL")).toBe(true);
  });

  test("rule 6: an ENOENT on spawn is the executable-not-found class, not a generic connection error", async () => {
    const child = fakeChild();
    const crashes: OfficialBranchError[] = [];
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      onCrash: (error) => crashes.push(error),
      spawnChild: () => child,
    });
    proxy.spawn(spawnOptions());
    const enoent = Object.assign(new Error("spawn /vendored/claude ENOENT"), { code: "ENOENT" });
    child.emitError(enoent);
    expect(crashes.map((c) => [c.code, c.crashClass])).toEqual([["official_executable_not_found", "executable-not-found"]]);
    child.emitError(new Error("pipe closed"));
    expect(crashes[1]?.code).toBe("official_connection_failure");
  });

  test("rule 6: the abort signal is forwarded to the child", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      spawnChild: () => child,
    });
    proxy.spawn(spawnOptions({ signal: controller.signal }));
    controller.abort();
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  test("review r1, M4: a record that HANGS ends the generation on a deadline", async () => {
    const child = fakeChild();
    const crashes: OfficialBranchError[] = [];
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      // The plant: a sink that neither resolves nor rejects. Before the fix the child stayed alive,
      // silent and unobservable forever — no bytes, no exit, no error.
      sink: { record: () => new Promise<void>(() => undefined) },
      onCrash: (error) => crashes.push(error),
      spawnChild: () => child,
      recordTimeoutMs: 25,
    });
    const process_ = proxy.spawn(spawnOptions());
    (process_.stdout as PassThrough).on("error", () => undefined);
    await expect(proxy.whenRecorded()).rejects.toThrow(/did not settle within 25ms/);
    await tick();
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  test("review r1, M4: an exit whose stdout never closes forwards on a grace timer, typed", async () => {
    const child = fakeChild();
    const crashes: OfficialBranchError[] = [];
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      onCrash: (error) => crashes.push(error),
      spawnChild: () => child,
      stdoutGraceMs: 20,
    });
    const process_ = proxy.spawn(spawnOptions());
    const exits: Array<[number | null, string | null]> = [];
    process_.on("exit", (code, signal) => exits.push([code, signal]));
    await proxy.whenRecorded();

    // The child exits; its stdout is NEVER ended (a surviving grandchild holds the pipe).
    child.emitExit(0);
    await tick();
    // Before the fix: the gate required both, so this stayed empty forever.
    await proxy.whenSettled();
    expect(exits).toEqual([[0, null]]);
    expect(crashes.map((crash) => [crash.code, crash.crashClass])).toContainEqual(["official_stdout_unterminated", "stdout-unterminated"]);
    expect(process_.exitCode).toBe(0);
  });

  test("review r1, M4: a signal that is ALREADY aborted still kills the child", () => {
    const child = fakeChild();
    const controller = new AbortController();
    controller.abort();
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      spawnChild: () => child,
    });
    proxy.spawn(spawnOptions({ signal: controller.signal }));
    expect(child.killed).toEqual(["SIGTERM"]);
  });

  test("§9: identity is the PAIR — a recycled pid with a different start time does not revalidate", () => {
    const recorded = { pid: 4711, startedAt: "2026-09-08T10:00:00.000Z" };
    expect(revalidateProcessIdentity(recorded, { ...recorded })).toBe(true);
    expect(revalidateProcessIdentity(recorded, { pid: 4711, startedAt: "2026-09-08T11:00:00.000Z" })).toBe(false);
    expect(revalidateProcessIdentity(recorded, undefined)).toBe(false);
    expect(revalidateProcessIdentity(undefined, recorded)).toBe(false);
  });

  test("review r2, NEW-5: every throw out of the hook still SETTLES, and records nothing", async () => {
    const records: SpawnObservation[] = [];
    const make = (over: { spawnChild?: () => SpawnedChildProcess; profile?: "fresh-spool" | "store-backed-resume" } = {}) =>
      createSupervisedSpawnProxy({
        brand: WINTER_BRAND,
        profile: over.profile ?? "fresh-spool",
        configuredConfigDir: SPOOL,
        sink: { record: (o) => void records.push(o) },
        spawnChild: over.spawnChild ?? (() => fakeChild()),
      });

    // (a) the observed config dir is refused — the generation never starts.
    const a = make();
    expect(() => a.spawn(spawnOptions({ env: {} }))).toThrow(OfficialConfigurationError);
    await Promise.race([a.whenSettled(), new Promise<void>((_r, reject) => setTimeout(() => reject(new Error("whenSettled() never resolved")), 500))]);
    await expect(a.whenRecorded()).rejects.toThrow();

    // (b) a child with no pid.
    const b = make({ spawnChild: () => fakeChild({ pid: undefined }) });
    expect(() => b.spawn(spawnOptions())).toThrow(/pid/);
    await Promise.race([b.whenSettled(), new Promise<void>((_r, reject) => setTimeout(() => reject(new Error("whenSettled() never resolved")), 500))]);

    // (c) a child with no stdout pipe — and THIS one used to record first, leaving a durable root and
    //     a process identity for a generation that never ran, with no exit to ever clear them.
    const noStdout = (): SpawnedChildProcess => ({ ...fakeChild(), stdout: null });
    const c = make({ spawnChild: noStdout });
    expect(() => c.spawn(spawnOptions())).toThrow(/stdout pipe/);
    await Promise.race([c.whenSettled(), new Promise<void>((_r, reject) => setTimeout(() => reject(new Error("whenSettled() never resolved")), 500))]);
    expect(records).toEqual([]);
  });

  test("a child that starts without a pid can be neither supervised nor identified", () => {
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "fresh-spool",
      configuredConfigDir: SPOOL,
      sink: { record: () => undefined },
      spawnChild: () => fakeChild({ pid: undefined }),
    });
    expect(() => proxy.spawn(spawnOptions())).toThrow(/pid/);
  });
});
