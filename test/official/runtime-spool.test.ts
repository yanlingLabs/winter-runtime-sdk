// WS-17 ROW 4 and the ADAPTER HALF OF ROW 15, against the REAL pinned runtime.
//
// Row 4  — "Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle
//           wake, zero visibility into `~/.claude`." The delivery/hold/idle half is the messaging
//           lane's; what is proven here is the ISOLATION and the ZERO VISIBILITY.
// Row 15 — the adapter's three legs: vendor temp roots reported honestly, supervised PRE-CLEANUP
//           reconciliation, and the default-spawn `mirror_error` handoff refusal (that last one is a
//           decision function, proven in `adapter.test.ts`; the first two are only observable live).
//
// The store here is the REAL `WinterCompatibilitySessionStore`, because §1's second launch profile
// only exists when the wrapper materializes a transcript out of a store — `claude-resume-<uuid>` is
// not something a test can ask for, it is something the runtime does, and this is the configuration
// that makes it do it.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINTER_BRAND, WinterCompatibilitySessionStore, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import { stubRuntimeDirectory } from "../../src/seams/stubs.ts";
import type { RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { directoryRecordSink, type SpawnObservation } from "../../src/official/spawn-proxy.ts";
import { vendorTempRootReport } from "../../src/official/spool.ts";
import { isResumeStagingRoot } from "../../src/vendor-paths.ts";
import { cleanupHermetic, decoyUntouched, hermeticSession, officialRuntimeBed, scriptedLoopback, treeOf, type HermeticSession, type ScriptedTurn } from "./support.ts";

const bed = officialRuntimeBed();
const describeRuntime = bed === undefined ? describe.skip : describe;
const TIMEOUT = 180_000;

const selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the spool bed",
  decidedAt: new Date(0).toISOString(),
};

const entryFor = (address: string): RuntimeDirectoryEntry => ({
  address,
  parsed: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: address },
  runtimeKind: "claude-agent",
  objectKind: "session",
  transport: "claude-handle",
  status: "running",
  mode: "code",
  generation: 1,
  selection,
  capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
  updatedAt: new Date(0).toISOString(),
});

interface SpoolRun {
  sessionId: string | undefined;
  observedConfigDir: string;
  spoolTree: string[];
  storeTree: string[];
  reconciled: Array<{ configDir: string; existedAtReconcile: boolean }>;
  recordedEntry: RuntimeDirectoryEntry | undefined;
}

/** One session under a shared spool, with the real store and the real supervised proxy. */
async function runSpoolSession(args: {
  session: HermeticSession;
  store: SessionStore;
  winterHome: string;
  projectKey: string;
  address: string;
  turns?: readonly ScriptedTurn[];
  resume?: string;
  forkSession?: boolean;
  sharedTempRoot?: string;
}): Promise<SpoolRun> {
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the suite is skipped without a bed");
  const { routes } = scriptedLoopback(args.turns ?? [{ text: "ok" }]);
  const reconciled: Array<{ configDir: string; existedAtReconcile: boolean }> = [];
  const directoryStore = createInMemoryRuntimeDirectoryStore();
  await directoryStore.upsert(entryFor(args.address));
  let sessionId: string | undefined;

  await withLoopbackFake({ routes }, async (fake) => {
    const base = { peers: { winter: createFakeWinterPeer().peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };
    const context: SeamContextWithDirectory = { ...base, directory: stubRuntimeDirectory(base) };
    const adapter = createOfficialAdapter(context, {
      sink: directoryRecordSink({ store: directoryStore, address: args.address }),
      // §6 RULE 3's COLLABORATOR, and the assertion row 15 is about: the recorded root must still be
      // on disk when reconciliation runs, because the wrapper deletes `claude-resume-*` on observing
      // the exit. If the proxy forwarded the exit first, this would record `false`.
      reconcile: ({ observation }: { observation: SpawnObservation }) => {
        reconciled.push({ configDir: observation.root.configDir, existedAtReconcile: existsSync(observation.root.configDir) });
      },
      verifyCleanup: ({ root }: SpawnObservation) => !existsSync(root.configDir),
    });
    await adapter.ready();

    const profile = args.resume === undefined ? ("fresh-spool" as const) : ("store-backed-resume" as const);
    const env = adapter.buildChildEnv({
      selection,
      configDir: args.session.spool,
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
      base: { HOME: args.session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      projectKey: args.projectKey,
      ...(args.sharedTempRoot === undefined ? {} : { sharedTempRoot: args.sharedTempRoot }),
    });
    const options = adapter.buildOptions({
      mode: "code",
      selection,
      cwd: args.session.cwd,
      sessionStore: args.store,
      autoMemoryDirectory: join(args.winterHome, "projects", args.projectKey, "memory"),
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: bed.executable,
      spawnProxy: adapter.spawnProxy,
      profile,
      configDir: args.session.spool,
    });
    const plan = { address: args.address, selection, prompt: `hello from ${args.projectKey}`, cwd: args.session.cwd, profile, configDir: args.session.spool, options: { ...options, env } };
    const live =
      args.resume === undefined ? adapter.launch(plan) : adapter.resume({ ...plan, resume: args.resume, ...(args.forkSession === undefined ? {} : { forkSession: args.forkSession }) });
    for await (const message of live.query) {
      const typed = message as { type: string; subtype?: string; session_id?: string };
      if (typed.type === "system" && typed.subtype === "init") sessionId = typed.session_id;
    }
    await live.supervisor.whenSettled();
  });

  const recorded = (await directoryStore.load()).find((entry) => entry.address === args.address);
  return {
    sessionId,
    observedConfigDir: reconciled[0]?.configDir ?? "",
    spoolTree: treeOf(args.session.spool),
    storeTree: treeOf(args.winterHome),
    reconciled,
    recordedEntry: recorded,
  };
}

describeRuntime("WS-17 row 4 + row 15 — the spool, the staging root and the vendor temp", () => {
  afterAll(cleanupHermetic);

  test(
    "row 4: two sessions under ONE spool stay isolated, and neither can see the vendor home",
    async () => {
      const session = hermeticSession("spool-two");
      const winterHome = join(session.brandHome);
      const store = new WinterCompatibilitySessionStore({ winterHome });

      const first = await runSpoolSession({ session, store, winterHome, projectKey: "project-alpha", address: "session:alpha" });
      const second = await runSpoolSession({ session, store, winterHome, projectKey: "project-beta", address: "session:beta" });

      // Two generations, two backend ids.
      expect(first.sessionId).toBeDefined();
      expect(second.sessionId).toBeDefined();
      expect(first.sessionId).not.toBe(second.sessionId);

      // ISOLATED DISCOVERY: each session's transcript lives under its OWN project key, in the shared
      // spool and in the canonical store alike, so neither's `projects/<key>` listing contains the
      // other's id.
      const alphaSpool = first.spoolTree.filter((path) => path.includes("project-alpha"));
      const betaSpool = second.spoolTree.filter((path) => path.includes("project-beta"));
      expect(alphaSpool.length).toBeGreaterThan(0);
      expect(betaSpool.length).toBeGreaterThan(0);
      expect(alphaSpool.some((path) => path.includes(second.sessionId ?? "?"))).toBe(false);
      expect(betaSpool.some((path) => path.includes(first.sessionId ?? "?"))).toBe(false);

      // The canonical store carries both, each under its own project key (WS-05 §6's layout).
      const canonical = treeOf(winterHome).filter((path) => path.endsWith(".jsonl"));
      expect(canonical.some((path) => path.includes("project-alpha") && path.includes(first.sessionId ?? "?"))).toBe(true);
      expect(canonical.some((path) => path.includes("project-beta") && path.includes(second.sessionId ?? "?"))).toBe(true);

      // ZERO VISIBILITY INTO THE VENDOR HOME: the decoy planted under `HOME` is exactly as planted.
      expect(decoyUntouched(session)).toBe(true);
      expect(readdirSync(join(session.home, ".claude"))).toEqual(["decoy.json"]);
    },
    TIMEOUT,
  );

  test(
    "§1 profile 2 + §6 rules 2/3: a store-backed resume is observed as a staging root, and reconciliation runs BEFORE cleanup",
    async () => {
      const session = hermeticSession("spool-resume");
      const winterHome = join(session.brandHome);
      const store = new WinterCompatibilitySessionStore({ winterHome });

      const first = await runSpoolSession({ session, store, winterHome, projectKey: "project-resume", address: "session:resume" });
      expect(first.sessionId).toBeDefined();
      // A fresh generation is spool-resident, and the record says so.
      expect(first.observedConfigDir).toBe(session.spool);
      expect(first.reconciled[0]?.existedAtReconcile).toBe(true);

      const resumed = await runSpoolSession({
        session,
        store,
        winterHome,
        projectKey: "project-resume",
        address: "session:resume",
        ...(first.sessionId === undefined ? {} : { resume: first.sessionId }),
      });

      // §1's SECOND PROFILE, observed rather than configured: the wrapper materialized the transcript
      // into its own staging root and the proxy is the only thing that ever saw the path.
      expect(isResumeStagingRoot(resumed.observedConfigDir)).toBe(true);
      expect(resumed.observedConfigDir).not.toBe(session.spool);

      // §6 RULE 3: when reconciliation ran, the staging root was STILL THERE. The wrapper deletes it
      // on observing the exit, so this assertion is the whole point of delaying the exit event.
      expect(resumed.reconciled).toHaveLength(1);
      expect(resumed.reconciled[0]?.existedAtReconcile).toBe(true);

      // §6 RULE 5: the root was cleared from the durable record only after cleanup was verified —
      // and by then the wrapper had removed it.
      expect(existsSync(resumed.observedConfigDir)).toBe(false);
      expect(resumed.recordedEntry?.configDir).toBeUndefined();
      expect(resumed.recordedEntry?.processIdentity).toBeUndefined();
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "§5.1: a FORK is a new backend record — it never inherits the source's identity",
    async () => {
      const session = hermeticSession("spool-fork");
      const winterHome = join(session.brandHome);
      const store = new WinterCompatibilitySessionStore({ winterHome });

      const source = await runSpoolSession({ session, store, winterHome, projectKey: "project-fork", address: "session:fork-source" });
      expect(source.sessionId).toBeDefined();
      const forked = await runSpoolSession({
        session,
        store,
        winterHome,
        projectKey: "project-fork",
        address: "session:fork-child",
        ...(source.sessionId === undefined ? {} : { resume: source.sessionId }),
        forkSession: true,
      });

      // "The resulting new backend UUID registers as a NEW record; a fork never inherits the source's
      // handoff certification" — so the two ids differ and BOTH transcripts exist.
      expect(forked.sessionId).toBeDefined();
      expect(forked.sessionId).not.toBe(source.sessionId);
      const canonical = treeOf(winterHome).filter((path) => path.endsWith(".jsonl"));
      expect(canonical.some((path) => path.includes(source.sessionId ?? "?"))).toBe(true);
      expect(canonical.some((path) => path.includes(forked.sessionId ?? "?"))).toBe(true);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "row 15: the vendor temp root is what we configured PLUS the engine's own segment, reported honestly",
    async () => {
      const session = hermeticSession("spool-temp");
      const winterHome = join(session.brandHome);
      const store = new WinterCompatibilitySessionStore({ winterHome });
      const sharedTempRoot = mkdtempSync(join(tmpdir(), "winter-rt-shared-temp-"));

      await runSpoolSession({ session, store, winterHome, projectKey: "project-temp", address: "session:temp", sharedTempRoot });

      // The engine appended its own vendor-named segment under the root we configured — exactly what
      // `vendorTempRootReport` tells a host it will do, and the reason the report exists.
      const report = vendorTempRootReport({ sharedTempRoot, uid: typeof process.getuid === "function" ? process.getuid() : 0 });
      const created = readdirSync(sharedTempRoot);
      expect(created.length).toBeGreaterThan(0);
      expect(created.some((entry) => entry.startsWith("claude-"))).toBe(true);
      expect(report.engineComputed.startsWith(`${sharedTempRoot}/claude-`)).toBe(true);
      expect(report.configured).toBe(sharedTempRoot);
      expect(decoyUntouched(session)).toBe(true);
    },
    TIMEOUT,
  );
});
