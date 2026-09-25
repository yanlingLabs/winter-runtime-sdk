// WS-21 §3.1, §3.4.4, §3.5, §3.7: applying a run home.
//
// The router lays the run home's env, `settingSources: ["user"]` and the memory pin over the caller's
// options, synchronously, and refuses a run home that is foreign, disposed, another cwd, another brand
// or another store. WS-23: the official leg's half of this file (its template's run-home profile, env
// builder, invariants and spawn-proxy check) went with the official runtime; a run home is never built
// for that leg any more (`buildRunHome` refuses it typed).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { WINTER_BRAND, WinterCompatibilitySessionStore, resolveBrand, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { buildRunHome, createRuntimeSdk, protectedPathRules, RunHomeError, type RunHome, type RuntimeSdkPeers } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";
import { declaredClasses, sessionAddress, sessionEntry } from "../messaging/support.ts";

afterAll(cleanupRunHomeBeds);

const keychain = createFakeKeychain([{ ref: { kind: "keychain", account: "loopback", service: "com.example.apply" }, material: "sk-apply" }]);

/** A Winter peer with the concrete store, whose home resolution throws: this bed always names its home. */
function storePeer(): { peer: RuntimeSdkPeers["winter"]; calls: ReturnType<typeof createFakeWinterPeer>["calls"] } {
  const { peer, calls } = createFakeWinterPeer();
  return {
    peer: {
      ...peer,
      WinterCompatibilitySessionStore,
      resolveWinterHome: () => {
        throw new Error("a hermetic test must never resolve the real Winter home");
      },
    } as unknown as RuntimeSdkPeers["winter"],
    calls,
  };
}

function winterRouter(bed: RunHomeBed, extra: { requireRunHome?: boolean } = {}) {
  const { peer, calls } = storePeer();
  const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, requireRunHome: extra.requireRunHome ?? true, handoff: { winterHome: bed.home } });
  return { sdk, calls };
}

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof RunHomeError) return error.code;
    throw error;
  }
  return "accepted";
};

describe("the Winter leg", () => {
  test("the run home's env, the user source and the memory pin reach the peer; the caller's own env survives beneath them", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    sdk.query({ prompt: "hi", options: { cwd: bed.cwd, model: "m", env: { KEEP: "yes" }, settingSources: [], runtime: { runHome } } });
    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!.options as Record<string, unknown>;
    expect("runtime" in forwarded).toBe(false);
    expect(forwarded["model"]).toBe("m");
    expect(forwarded["settingSources"]).toEqual(["user"]);
    expect(forwarded["env"]).toEqual({
      KEEP: "yes",
      WINTER_HOME: runHome.dir,
      WINTER_STORE_HOME: bed.sdk,
      WINTER_PLUGIN_CACHE_DIR: join(bed.sdk, "plugins"),
      WINTER_PROVIDER_MANAGED_BY_HOST: "1",
      WINTER_DISABLE_CRON: "1",
    });
    expect(forwarded["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: true });
  });

  test("fix round 1, M6: a Winter run home is `pending` while its incarnation runs, `safe` only once the query ends", async () => {
    const bed = runHomeBed();
    // Drained to its end.
    {
      const runHome = await buildRunHome(inputFor(bed));
      const { sdk } = winterRouter(bed);
      const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("pending");
      const first = await query.next();
      expect(first.done).toBe(false);
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("pending");
      for await (const _ of query) void _;
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("safe");
    }
    // Ended early by its consumer (a `break` is a `return()`).
    {
      const runHome = await buildRunHome(inputFor(bed));
      const { sdk } = winterRouter(bed);
      const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      for await (const _ of query) break;
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("safe");
    }
    // Ended by the runtime's failure.
    {
      const runHome = await buildRunHome(inputFor(bed));
      const { peer } = createFakeWinterPeer({
        query: () => {
          const failing = (async function* () {
            yield* [];
            throw new Error("unexpected process death");
          })();
          return Object.assign(failing, { interrupt: async () => undefined }) as unknown as ReturnType<RuntimeSdkPeers["winter"]["query"]>;
        },
      });
      const sdk = createRuntimeSdk({ peers: { winter: { ...peer, WinterCompatibilitySessionStore } as unknown as RuntimeSdkPeers["winter"] }, keychain, requireRunHome: true, handoff: { winterHome: bed.home } });
      const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("pending");
      await expect(query.next()).rejects.toThrow("unexpected process death");
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("safe");
    }
    // Disposed (`await using`).
    {
      const runHome = await buildRunHome(inputFor(bed));
      const { sdk } = winterRouter(bed);
      const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      await query[Symbol.asyncDispose]();
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("safe");
    }
    // Never iterated: still running as far as anyone can tell, so still `pending` — the host must not dispose.
    {
      const runHome = await buildRunHome(inputFor(bed));
      const { sdk } = winterRouter(bed);
      const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("pending");
      // The observed query is still the peer's Query: its own members reach the peer's.
      await expect(query.interrupt()).rejects.toThrow("Query.interrupt() is not scripted");
      expect(typeof query.messaging.deliver).toBe("function");
      expect(query[Symbol.asyncIterator]()).toBe(query);
      expect(sdk.runHomeOutcome(runHome.runId)).toBe("pending");
    }
  });

  test("without a run home the peer's own Query object is returned untouched", () => {
    const bed = runHomeBed();
    const { peer } = createFakeWinterPeer();
    let returned: unknown;
    const wrapped = { ...peer, WinterCompatibilitySessionStore, query: (args: Parameters<RuntimeSdkPeers["winter"]["query"]>[0]) => (returned = peer.query(args)) } as unknown as RuntimeSdkPeers["winter"];
    const sdk = createRuntimeSdk({ peers: { winter: wrapped }, keychain });
    const query = sdk.query({ prompt: "hi", options: { cwd: bed.cwd } });
    expect(query).toBe(returned as typeof query);
  });

  test("chat and dispatch: native auto-memory is off (the daemon keeps its `_assistant` injection)", async () => {
    for (const mode of ["chat", "dispatch"] as const) {
      const bed = runHomeBed();
      const runHome = await buildRunHome(inputFor(bed, { mode }));
      const { sdk, calls } = winterRouter(bed);
      sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
      expect((calls[0]!.options as Record<string, unknown>)["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: false });
    }
  });

  test("a code run home's `autoMemoryEnabled: false` in sdk/settings.json reaches the pin", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "settings.json"), JSON.stringify({ autoMemoryEnabled: false }));
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } });
    expect((calls[0]!.options as Record<string, unknown>)["autoMemory"]).toEqual({ directory: runHome.input.memoryDir, enabled: false });
  });

  test("the refusals: project/local sources, the other leg, another cwd, a foreign or disposed run home, another store, another brand", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, settingSources: ["project"], runtime: { runHome } } }))).toBe("setting_sources_refused");
    // A variable only the router sets, from the caller — refused, never silently overwritten (any case).
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, env: { WINTER_HOME: "/caller/home" }, runtime: { runHome } } }))).toBe("router_owned_variable");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, env: { winter_store_home: "/x" }, runtime: { runHome } } }))).toBe("router_owned_variable");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, settingSources: ["user", "local"], runtime: { runHome } } }))).toBe("setting_sources_refused");

    // WS-23: a run home for the retired official leg cannot even be built.
    await expect(buildRunHome(inputFor(bed, { leg: "official" as "winter" }))).rejects.toThrow(/official leg is retired/);

    mkdirSync(join(bed.root, "other"), { recursive: true });
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: join(bed.root, "other"), runtime: { runHome } } }))).toBe("run_home_cwd_mismatch");
    expect(refusal(() => sdk.query({ prompt: "hi", options: { runtime: { runHome } } }))).toBe("run_home_cwd_mismatch");

    const forged = { ...runHome } as RunHome;
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: forged } } }))).toBe("run_home_foreign");
    const disposed = await buildRunHome(inputFor(bed));
    await disposed.dispose();
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: disposed } } }))).toBe("run_home_foreign");

    const elsewhere = runHomeBed();
    const otherHome = await buildRunHome(inputFor(elsewhere, { cwd: bed.cwd }));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: otherHome } } }))).toBe("run_home_store_mismatch");

    const acme = resolveBrand({ homeDirName: ".acme", projectDirName: ".acme", instructionsFile: "ACME.md", envPrefix: "ACME_", mcpServerName: "acme" });
    if (!acme.ok) throw new Error(acme.reason);
    const branded = await buildRunHome(inputFor(bed, { brand: acme.brand }));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome: branded } } }))).toBe("run_home_brand_mismatch");

    expect(calls).toHaveLength(0);
  });

  test("fix round 1, M1: the options a run home decides are refused from the caller — plugins, skills, agents, outputStyle, brand", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed);
    const decided: Array<[string, Record<string, unknown>]> = [
      ["plugins", { plugins: [{ type: "local", path: "/x" }] }],
      ["skills", { skills: ["x"] }],
      ["agents", { agents: { x: { description: "x", prompt: "x", permissionMode: "bypassPermissions" } } }],
      ["outputStyle", { outputStyle: "terse" }],
      ["brand", { brand: { envPrefix: "OTHER_" } }],
    ];
    for (const [label, extra] of decided) {
      expect([label, refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, ...extra, runtime: { runHome } } as never }))]).toEqual([label, "run_home_option_refused"]);
    }
    // Host policy stays the host's.
    sdk.query({ prompt: "hi", options: { cwd: bed.cwd, trustedWorkspace: true, plansDirectory: "/plans", runtime: { runHome } } as never });
    expect(calls).toHaveLength(1);
  });

  test("a router created without `requireRunHome` cannot apply one: its store is on the pre-WS-21 layout", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    const { sdk, calls } = winterRouter(bed, { requireRunHome: false });
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: bed.cwd, runtime: { runHome } } }))).toBe("run_home_store_mismatch");
    expect(calls).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------
// The router's OWN Winter query: the messaging cold resume (spec §3.1 — `runHomeFor`).
// ------------------------------------------------------------------------------------------------

describe("the cold resume runs on a run home too", () => {
  const world = (bed: RunHomeBed, runHomeFor?: Parameters<typeof createRuntimeSdk>[0]["runHomeFor"]) => {
    const { peer, calls } = storePeer();
    const declared = declaredClasses();
    const sdk = createRuntimeSdk({
      peers: { winter: peer },
      keychain,
      requireRunHome: true,
      handoff: { winterHome: bed.home },
      ...(runHomeFor === undefined ? {} : { runHomeFor }),
      messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass } } },
    });
    return { sdk, calls };
  };

  test("with no `runHomeFor`, an exited Winter session is non-retryably unavailable and nothing is opened", async () => {
    const bed = runHomeBed();
    const { sdk, calls } = world(bed);
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: bed.cwd });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("unavailable");
    expect((outcome as { retryable?: boolean }).retryable).toBe(false);
    expect(JSON.stringify(outcome)).toContain("run_home_for_missing");
    expect(calls).toHaveLength(0);
  });

  test("with `runHomeFor`, the resume is opened on the host-built folder, applied as `query()` applies it, then disposed and recorded safe", async () => {
    const bed = runHomeBed();
    const built: RunHome[] = [];
    const asked: unknown[] = [];
    const { sdk, calls } = world(bed, async (ctx) => {
      asked.push(ctx);
      const runHome = await buildRunHome(inputFor(bed, { cwd: ctx.cwd, leg: ctx.leg, mode: ctx.mode }));
      built.push(runHome);
      return runHome;
    });
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: bed.cwd });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(asked).toEqual([{ sessionId: "gone", leg: "winter", cwd: bed.cwd, mode: "code" }]);
    expect(calls).toHaveLength(1);
    const forwarded = calls[0]!.options as Record<string, unknown>;
    expect(forwarded["resume"]).toBe("backend-9");
    expect(forwarded["settingSources"]).toEqual(["user"]);
    expect((forwarded["env"] as Record<string, string>)["WINTER_HOME"]).toBe(built[0]!.dir);
    expect(existsSync(built[0]!.dir)).toBe(false);
    expect(sdk.runHomeOutcome(built[0]!.runId)).toBe("safe");
  });
});

describe("the cwd check compares CANONICAL forms (L3 round 4: the daemon's cold resume passes a realpath'd cwd)", () => {
  const world = (bed: RunHomeBed, runHomeFor: NonNullable<Parameters<typeof createRuntimeSdk>[0]["runHomeFor"]>) => {
    const { peer, calls } = storePeer();
    const declared = declaredClasses();
    const sdk = createRuntimeSdk({
      peers: { winter: peer },
      keychain,
      requireRunHome: true,
      handoff: { winterHome: bed.home },
      runHomeFor,
      messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass } } },
    });
    return { sdk, calls };
  };

  test("a row recorded under a SYMLINKED spelling resumes on a run home built for the canonical cwd", async () => {
    const bed = runHomeBed();
    const link = join(bed.root, "linked-work");
    symlinkSync(bed.cwd, link);
    const { sdk, calls } = world(bed, async (ctx) => buildRunHome(inputFor(bed, { cwd: realpathSync(ctx.cwd), leg: ctx.leg, mode: ctx.mode })));
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: link });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(calls).toHaveLength(1);
  });

  test("a row recorded under the `/var` spelling of a `/private/var` directory resumes too (macOS)", async () => {
    const bed = runHomeBed();
    if (!bed.cwd.startsWith("/private/var/")) {
      // eslint-disable-next-line no-console
      console.warn("[apply] the /var spelling case needs a /private/var temp root (macOS); skipped here");
      return;
    }
    const varSpelling = bed.cwd.slice("/private".length);
    expect(realpathSync(varSpelling)).toBe(bed.cwd);
    const { sdk, calls } = world(bed, async (ctx) => buildRunHome(inputFor(bed, { cwd: realpathSync(ctx.cwd), leg: ctx.leg, mode: ctx.mode })));
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: varSpelling });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("resumed_and_delivered");
    expect(calls).toHaveLength(1);
  });

  test("a GENUINELY different directory still refuses `run_home_cwd_mismatch` — on the cold resume and on `query()`", async () => {
    const bed = runHomeBed();
    const other = join(bed.root, "other-work");
    mkdirSync(other, { recursive: true });
    const { sdk, calls } = world(bed, async (ctx) => buildRunHome(inputFor(bed, { cwd: other, leg: ctx.leg, mode: ctx.mode })));
    await sdk.directory.record(sessionEntry("sender"));
    await sdk.directory.record({ ...sessionEntry("gone", { status: "exited", backendSessionId: "backend-9" }), cwd: bed.cwd });
    const outcome = await sdk.messaging.send({ from: sessionAddress("sender"), to: "session:gone", body: "wake up", originToolCallId: "t1" });
    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).toContain("run_home_cwd_mismatch");
    expect(calls).toHaveLength(0);
    // `query()`: the symlinked spelling of the SAME directory is accepted; another directory is not.
    const link = join(bed.root, "linked-work");
    symlinkSync(bed.cwd, link);
    const runHome = await buildRunHome(inputFor(bed));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: link, runtime: { runHome } } }))).toBe("accepted");
    const second = await buildRunHome(inputFor(bed));
    expect(refusal(() => sdk.query({ prompt: "hi", options: { cwd: other, runtime: { runHome: second } } }))).toBe("run_home_cwd_mismatch");
  });
});
