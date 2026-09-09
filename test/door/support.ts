// THE DOOR'S OWN BED: the whole handle, the real pinned runtime, one loopback endpoint.
//
// WHY IT IS NOT `test/joint/support.ts`. That bed proves Lane A's runtime against Lane B's router by
// calling the two lanes' factories directly — which is exactly right for the join it was written for,
// and is exactly what a test of the DOOR must not do: the door's whole subject is whether
// `createRuntimeSdk(...).query(...)` composes those lanes correctly, so anything this bed assembles by
// hand is a piece of the answer it was supposed to measure. Here the only call is `sdk.query()`.
//
// WHAT IS REAL: the pinned 0.3.250 binary, the router's own handle, Lane C's shared session store on a
// throwaway home, Lane B's directory and messaging router, Lane A's Options template / env allowlist /
// spool profile / supervised spawn. The doubles are the ENDPOINT (a loopback fake — WS-17 row 1's own
// condition), the Winter PEER (its session runtime lives in the other repository), and the keychain
// (an in-memory seam, which is the hard rule of this phase).
//
// HERMETIC IN THE FULL SENSE: `HOME` and `CLAUDE_CONFIG_DIR` are `mkdtemp` roots, a decoy vendor home
// is planted under `HOME`, and R-7b-11's four traffic opt-outs are set by the PRODUCTION env builder —
// this bed passes no policy at all, which is the point.
import { WinterCompatibilitySessionStore, transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";

import { createRuntimeSdk, type RouterOfficialPolicy, type RuntimeSdk, type RuntimeSdkPeers } from "../../src/index.ts";
import type { RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createInMemoryRuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import { officialMcpServers, winterMcpServerDescriptor } from "../../src/official/mcp-descriptors.ts";
import { createMessagingToolHandlers } from "../../src/messaging/index.ts";
import { hermeticSession, officialRuntimeBed, scriptedLoopback, type HermeticSession, type LoopbackRecord, type ScriptedTurn } from "../official/support.ts";
import { declaredClasses } from "../messaging/support.ts";

export const DOOR_TIMEOUT = 180_000;

/** The credential ref the bed's keychain answers for. Its material never leaves the child env. */
export const DOOR_CREDENTIAL = { kind: "keychain", account: "loopback:door", service: "com.example.door" } as const;

/**
 * A `custom` auth family, deliberately.
 *
 * The loopback endpoint needs `ANTHROPIC_BASE_URL` beside the key, and §12's family tables put that
 * variable in the `console-oauth` set — so an `api-key` session that also set a base URL would be
 * refused by the auth validator, correctly. `custom` is the one family whose set is open, which is
 * what a loopback deployment IS. The derived families are unit-tested against
 * `officialCredentialPlan` instead, where no endpoint is involved.
 */
export const doorSelection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "loopback/claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the door bed",
  decidedAt: new Date(0).toISOString(),
};

export interface DoorBed {
  sdk: RuntimeSdk;
  session: HermeticSession;
  directoryStore: RuntimeDirectoryStore;
  /** Everything the loopback endpoint was asked for and answered. */
  record: LoopbackRecord;
  /** The address the official session is launched under. */
  address: string;
  sessionId: string;
  /** The transcript project key the door sets — half of the `SessionKey` a handoff takes (I-2/M-2). */
  projectKey: string;
  /** The options a `sdk.query()` needs for the official leg, ready to spread. */
  officialOptions(over?: { sessionId?: string; withMessagingTools?: boolean }): Record<string, unknown>;
  /** A SECOND handle over the same peers/home, with extra constructor options (a deployment policy). */
  sdkWith(extra: { official?: RouterOfficialPolicy }): RuntimeSdk;
}

export interface DoorBedOptions {
  turns: readonly ScriptedTurn[];
  sessionId?: string;
  /** Share one directory store across two beds (a restart, a second session). */
  directoryStore?: RuntimeDirectoryStore;
  /** Reuse an earlier bed's directories, so a resume really resumes. */
  reuse?: HermeticSession;
}

/**
 * A Winter peer carrying the concrete store.
 *
 * WS-05 §6's "the identical package/version" is a statement about the INJECTED instance, and Lane C's
 * lazy resolver reads `WinterCompatibilitySessionStore` off the peer. `resolveWinterHome` throws on
 * purpose: this bed always names its home, and a test that stopped doing so must fail loudly rather
 * than reach the developer's real one.
 */
function doorPeers(claude: RuntimeSdkPeers["claude"]): RuntimeSdkPeers {
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

/** Builds the handle and runs `fn` against it; the loopback fake is closed whatever the body does. */
export async function withDoorBed<T>(options: DoorBedOptions, fn: (bed: DoorBed) => Promise<T>): Promise<T> {
  const runtime = officialRuntimeBed();
  /* c8 ignore next */
  if (runtime === undefined) throw new Error("unreachable: the door suite is skipped without a bed");
  const sessionId = options.sessionId ?? "door-1";
  // COMPACT, so the DEFAULT transcript key (the Winter SDK's own `transcriptProjectKey(cwd)`) fits the
  // pinned runtime's 64-character rule and every door test exercises the default a host gets.
  const session = options.reuse ?? hermeticSession(`door-${sessionId}`, { compact: true });
  const { routes, record } = scriptedLoopback(options.turns);

  return withLoopbackFake({ routes }, async (fake) => {
    const directoryStore = options.directoryStore ?? createInMemoryRuntimeDirectoryStore();
    const declared = declaredClasses();
    const build = (extra: { official?: RouterOfficialPolicy } = {}): RuntimeSdk =>
      createRuntimeSdk({
        peers: doorPeers(runtime.module),
        keychain: createFakeKeychain([{ ref: DOOR_CREDENTIAL, material: "sk-ant-loopback" }]),
        directoryStore,
        vendoredOfficialRuntime: runtime.executable,
        // ONE HOME for the shared store, the spool and every seam that resolves through the context.
        handoff: { winterHome: session.brandHome },
        messaging: { messaging: { winter: { permissionClass: declared.winter.permissionClass }, official: { permissionClass: declared.official.permissionClass } } },
        ...(extra.official === undefined ? {} : { official: extra.official }),
      });
    const sdk = build();

    const bed: DoorBed = {
      sdk,
      sdkWith: build,
      session,
      directoryStore,
      record,
      sessionId,
      projectKey: transcriptProjectKey(session.cwd),
      address: `session:${sessionId}`,
      officialOptions(over = {}) {
        const id = over.sessionId ?? sessionId;
        const messagingTools = over.withMessagingTools !== true ? undefined : createMessagingToolHandlers(sdk.messaging, { sessionId: id });
        const descriptor =
          messagingTools === undefined
            ? undefined
            : winterMcpServerDescriptor({ brand: sdk.brand, branchLabel: "winter-claude-agent", messaging: { sendMessage: messagingTools.sendMessage, listAgents: messagingTools.listAgents } });
        return {
          cwd: session.cwd,
          canUseTool: async (_name: string, input: Record<string, unknown>) => ({ behavior: "allow", updatedInput: input }),
          provider: { providerId: "loopback", authRef: DOOR_CREDENTIAL, connection: { baseUrl: fake.url.replace(/\/$/, "") } },
          runtime: {
            selection: doorSelection,
            official: {
              sessionId: id,
              // The `custom` family names its own variables (see `doorSelection`).
              credentials: [{ variable: "ANTHROPIC_API_KEY", ref: DOOR_CREDENTIAL }],
              connectionEnv: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, "") },
              base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              ...(descriptor === undefined
                ? {}
                : { mcpServers: officialMcpServers({ descriptor, module: runtime.mcpModule, toInputShape: runtime.toInputShape, branchLabel: "winter-claude-agent" }) }),
            },
          },
        };
      },
    };
    return fn(bed);
  });
}

/** Drains a query and returns the messages, in order. */
export async function drain(query: AsyncIterable<unknown>): Promise<Array<{ type: string; subtype?: string }>> {
  const messages: Array<{ type: string; subtype?: string }> = [];
  for await (const message of query) messages.push(message as { type: string; subtype?: string });
  return messages;
}
