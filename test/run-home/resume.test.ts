// WS-21 §3.6: claude's store-backed resume on a run home.
//
//   1. the door configures the generation on `<run folder>/.absent` — unpredictable, never created;
//   2. the wrapper stages the transcript into `<tmp>/claude-resume-<uuid>/projects/` (and, because the
//      configured dir does not exist, copies nothing else);
//   3. the proxy, synchronously, refuses a staging dir that holds anything but `projects/`, links every
//      other run-folder entry in, and spawns the child on the staging dir unchanged;
//   4. the recorded root is `sdk-resume-staging`; a fresh generation's is `run-folder`.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { WINTER_BRAND, WinterCompatibilitySessionStore, type SessionStoreEntry } from "@yanlinglabs/winter-agent-sdk";

import { buildRunHome, createRuntimeSdk, RunHomeError, type RuntimeSdkPeers } from "../../src/index.ts";
import { createSupervisedSpawnProxy, type SpawnObservation } from "../../src/official/spawn-proxy.ts";
import type { OfficialOptions, OfficialQuery } from "../../src/seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { RESUME_STAGING_PREFIX } from "../../src/vendor-paths.ts";
import { cleanupRunHomeBeds, inputFor, runHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the resume bed",
  decidedAt: new Date(0).toISOString(),
};

function fakeChild() {
  return { pid: 5151, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, on: () => undefined };
}

describe("the proxy's resume step (spec §3.6)", () => {
  const stage = (root: string, extra: string[] = []): string => {
    const staging = join(root, `${RESUME_STAGING_PREFIX}00000000-0000-4000-8000-00000000abcd`);
    mkdirSync(join(staging, "projects", "k"), { recursive: true });
    writeFileSync(join(staging, "projects", "k", "s.jsonl"), "{}\n");
    for (const name of extra) writeFileSync(join(staging, name), "planted");
    return staging;
  };
  const resumeSpawn = (staging: string, runHomeDir: string) => {
    const spawned: Array<{ env: Record<string, string | undefined> }> = [];
    const recorded: SpawnObservation[] = [];
    const proxy = createSupervisedSpawnProxy({
      brand: WINTER_BRAND,
      profile: "store-backed-resume",
      configuredConfigDir: join(runHomeDir, ".absent"),
      runHome: { dir: runHomeDir },
      sink: { record: (observation) => void recorded.push(observation) },
      spawnChild: (options) => {
        spawned.push({ env: options.env });
        return fakeChild() as never;
      },
    });
    proxy.spawn({ command: "/vendored/claude", args: ["--setting-sources=user"], cwd: "/work", env: { CLAUDE_CONFIG_DIR: staging }, signal: new AbortController().signal });
    return { spawned, recorded, proxy };
  };

  test("a bare staging dir gets every run-folder entry but projects linked in, and the child runs ON the staging dir", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const staging = stage(bed.root);
    const { spawned, proxy } = resumeSpawn(staging, runHome.dir);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env["CLAUDE_CONFIG_DIR"]).toBe(staging);
    const expected = readdirSync(runHome.dir).filter((name) => name !== "projects").sort();
    expect(expected.length).toBeGreaterThan(5);
    for (const name of expected) {
      expect(lstatSync(join(staging, name)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(staging, name))).toBe(join(runHome.dir, name));
    }
    // The staged transcript is the wrapper's, untouched; the run folder's own `projects/` is not linked.
    expect(lstatSync(join(staging, "projects")).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(staging, "projects"))).toEqual(["k"]);
    // The instructions reach the child through two links: staging → run folder → ./WINTER.md.
    expect(existsSync(join(staging, "CLAUDE.md"))).toBe(true);
    expect(proxy.observation?.root.kind).toBe("sdk-resume-staging");
  });

  test("a staging dir holding anything but `projects/` is refused before a link is made or a child exists", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const staging = stage(bed.root, [".credentials.json"]);
    let caught: unknown;
    try {
      resumeSpawn(staging, runHome.dir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunHomeError);
    expect((caught as RunHomeError).code).toBe("run_home_staging_not_bare");
    expect(readdirSync(staging).sort()).toEqual([".credentials.json", "projects"]);
  });

  test("a `projects` that is a link is not a bare staging dir either", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const staging = join(bed.root, `${RESUME_STAGING_PREFIX}00000000-0000-4000-8000-00000000beef`);
    mkdirSync(staging, { recursive: true });
    const elsewhere = join(bed.root, "elsewhere");
    mkdirSync(elsewhere);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(elsewhere, join(staging, "projects"));
    expect(() => resumeSpawn(staging, runHome.dir)).toThrow(/run_home_staging_not_bare/);
  });
});

// ------------------------------------------------------------------------------------------------
// The door's half: the placeholder.
// ------------------------------------------------------------------------------------------------

function storePeer(): RuntimeSdkPeers["winter"] {
  const { peer } = createFakeWinterPeer();
  return {
    ...peer,
    WinterCompatibilitySessionStore,
    resolveWinterHome: () => {
      throw new Error("a hermetic test must never resolve the real Winter home");
    },
  } as unknown as RuntimeSdkPeers["winter"];
}

describe("the door configures a resume on the run folder's placeholder", () => {
  test("`CLAUDE_CONFIG_DIR` is `<run>/.absent`, which does not exist; the resume id is the door's decision", async () => {
    const bed = runHomeBed();
    const launched: OfficialOptions[] = [];
    const module = {
      version: "0.3.250",
      query(params: { options?: OfficialOptions }): OfficialQuery {
        launched.push(params.options as OfficialOptions);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "result", subtype: "success" };
          },
          interrupt: async () => undefined,
          setPermissionMode: async () => undefined,
        } as unknown as OfficialQuery;
      },
    };
    const ref = { kind: "keychain", account: "loopback", service: "com.example.resume" } as const;
    const sdk = createRuntimeSdk({
      peers: { winter: storePeer(), claude: module },
      keychain: createFakeKeychain([{ ref, material: "sk-resume" }]),
      vendoredOfficialRuntime: "/vendored/claude",
      requireRunHome: true,
      handoff: { winterHome: bed.home },
    });
    // A conversation already in the canonical store for this backend id (the shared runtime home's).
    const backend = "00000000-0000-4000-8000-000000000123";
    const { transcriptProjectKey } = await import("@yanlinglabs/winter-agent-sdk");
    const key = { projectKey: transcriptProjectKey(bed.cwd), sessionId: backend };
    const store = new WinterCompatibilitySessionStore({ winterHome: join(bed.home, "sdk") });
    const entry: SessionStoreEntry = { type: "user", uuid: "11111111-1111-4111-8111-111111111111", parentUuid: null, sessionId: backend, timestamp: new Date(0).toISOString(), cwd: bed.cwd, version: "0", isSidechain: false, message: { role: "user", content: "earlier" } };
    await store.append(key, [entry]);
    await store.releaseSessionLease({ projectKey: key.projectKey, sessionId: backend });

    const runHome = await buildRunHome(inputFor(bed, { leg: "official" }));
    const official = { sessionId: "s-resume", credentials: [{ variable: "ANTHROPIC_API_KEY", ref }], connectionEnv: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }, base: { HOME: bed.root, PATH: "/usr/bin" } };
    const query = sdk.query({ prompt: "again", options: { cwd: bed.cwd, sessionId: backend, runtime: { runHome, selection, official } } });
    for await (const _message of query as AsyncIterable<unknown>) void _message;
    expect(launched).toHaveLength(1);
    expect(launched[0]!.resume).toBe(backend);
    const placeholder = launched[0]!.env?.["CLAUDE_CONFIG_DIR"];
    expect(placeholder).toBe(join(runHome.dir, ".absent"));
    expect(existsSync(placeholder as string)).toBe(false);

    // Naming the old configurable staging root beside a run home is refused.
    const second = await buildRunHome(inputFor(bed, { leg: "official" }));
    const refused = sdk.query({ prompt: "again", options: { cwd: bed.cwd, sessionId: backend, runtime: { runHome: second, selection, official: { ...official, sessionId: "s-resume-2", stagingRoot: join(bed.root, "stage") } } } });
    await expect((async () => {
      for await (const _message of refused as AsyncIterable<unknown>) void _message;
    })()).rejects.toThrow(/replaces the configured staging placeholder/);
  });
});
