// THE WS-21 REAL-RUNTIME BED: the pinned claude binary, a `requireRunHome` router, run homes built
// per generation on a throwaway home, one loopback endpoint. The door beds' shape (`test/door/support.ts`),
// with the run home as the one new input.
//
// HERMETIC: `HOME` is an `mkdtemp` root with a DECOY vendor home planted in it; the daemon home is
// `<HOME>/.winter`; the child env is the production builder's replacement env. Nothing reads or writes
// `~/.winter*`, `~/.claude*` or a real Keychain (the keychain is the in-memory seam).
import { join } from "node:path";
import { WinterCompatibilitySessionStore, transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";

import { buildRunHome, createRuntimeSdk, type RunHome, type RunHomeInput, type RuntimeSdk, type RuntimeSdkPeers } from "../../src/index.ts";
import { createInMemoryRuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import { hermeticSession, officialRuntimeBed, scriptedLoopback, type HermeticSession, type LoopbackRecord, type ScriptedTurn } from "../official/support.ts";
import { declaredClasses } from "../messaging/support.ts";

export const WS21_TIMEOUT = 180_000;

const CREDENTIAL = { kind: "keychain", account: "loopback:ws21", service: "com.example.ws21" } as const;

/** `custom`: the loopback needs `ANTHROPIC_BASE_URL` beside the key (see the door bed's own note). */
export const ws21Selection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "loopback/claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the WS-21 bed",
  decidedAt: new Date(0).toISOString(),
};

export interface Ws21Bed {
  sdk: RuntimeSdk;
  session: HermeticSession;
  /** The daemon home (`WINTER_HOME`): `<HOME>/.winter`. */
  home: string;
  /** `<home>/sdk`. */
  sdkHome: string;
  record: LoopbackRecord;
  projectKey: string;
  /** Builds an official-leg run home for this bed's cwd. */
  runHome(over?: Partial<RunHomeInput>): Promise<RunHome>;
  /** Options for an official `sdk.query()` on the given run home. */
  options(runHome: RunHome, over?: { sessionId?: string; winterSessionId?: string; permissionMode?: string; canUseTool?: unknown }): Record<string, unknown>;
}

export interface Ws21BedOptions {
  turns: readonly ScriptedTurn[];
  reuse?: HermeticSession;
  git?: boolean;
}

function peers(claude: RuntimeSdkPeers["claude"]): RuntimeSdkPeers {
  const { peer } = createFakeWinterPeer();
  return {
    winter: {
      ...peer,
      WinterCompatibilitySessionStore,
      resolveWinterHome: () => {
        throw new Error("a hermetic test must never resolve the real Winter home");
      },
    } as unknown as RuntimeSdkPeers["winter"],
    ...(claude === undefined ? {} : { claude }),
  };
}

export async function withWs21Bed<T>(options: Ws21BedOptions, fn: (bed: Ws21Bed) => Promise<T>): Promise<T> {
  const runtime = officialRuntimeBed();
  /* c8 ignore next */
  if (runtime === undefined) throw new Error("unreachable: the WS-21 real-runtime suite is skipped without a bed");
  const session = options.reuse ?? hermeticSession("ws21", { compact: true, ...(options.git === true ? { git: true } : {}) });
  const home = session.brandHome;
  const sdkHome = join(home, "sdk");
  const projectKey = transcriptProjectKey(session.cwd);
  const { routes, record } = scriptedLoopback(options.turns);
  return withLoopbackFake({ routes }, async (fake) => {
    const declared = declaredClasses();
    const sdk = createRuntimeSdk({
      peers: peers(runtime.module),
      keychain: createFakeKeychain([{ ref: CREDENTIAL, material: "sk-ant-loopback" }]),
      directoryStore: createInMemoryRuntimeDirectoryStore(),
      vendoredOfficialRuntime: runtime.executable,
      toInputShape: runtime.toInputShape,
      requireRunHome: true,
      handoff: { winterHome: home },
      messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass }, official: { permissionClass: declared.official.permissionClass } } },
    });
    const bed: Ws21Bed = {
      sdk,
      session,
      home,
      sdkHome,
      record,
      projectKey,
      runHome: (over = {}) =>
        buildRunHome({
          home,
          mode: "code",
          dispatchChild: false,
          leg: "official",
          cwd: session.cwd,
          trustedProjectRoot: null,
          gitRoot: null,
          mcpDisabled: [],
          reservedMcpServerNames: [],
          memoryDir: join(sdkHome, "projects", projectKey, "memory"),
          ...over,
        }),
      options: (runHome, over = {}) => ({
        cwd: session.cwd,
        canUseTool: over.canUseTool ?? (async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input })),
        ...(over.sessionId === undefined ? {} : { sessionId: over.sessionId }),
        ...(over.permissionMode === undefined ? {} : { permissionMode: over.permissionMode }),
        runtime: {
          runHome,
          selection: ws21Selection,
          official: {
            sessionId: over.winterSessionId ?? "s_ws21",
            credentials: [{ variable: "ANTHROPIC_API_KEY", ref: CREDENTIAL }],
            connectionEnv: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, "") },
            base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          },
        },
      }),
    };
    return fn(bed);
  });
}

/** Drains a query. */
export async function drainAll(query: unknown): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const message of query as AsyncIterable<Record<string, unknown>>) out.push(message);
  return out;
}
