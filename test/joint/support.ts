// THE JOINT BED: Lane A's real pinned runtime, Lane B's real router, one session.
//
// WHY THIS FILE EXISTS AND WHY IT IS NOT IN EITHER LANE'S DIRECTORY. Every lane proved its own half
// against a double of its neighbour — Lane A's alias tests used RECORDING handlers, Lane B's router
// tests used a fake official session — and the whole-branch review's first cross-cutting shape is
// exactly that: "each lane's proof is genuine for the lane and stops at the lane's edge". A joint bed
// belongs to neither lane, so it lives in neither lane's directory.
//
// WHAT IS REAL HERE, END TO END: a model emitted by the pinned 0.3.250 binary → its own
// `toolAliases` → the canonical MCP tool on the in-process server Lane A materializes → Lane B's
// `createMessagingToolHandlers` → Lane B's router, over Lane B's real directory → the target's own
// writer. The only doubles left are the ENDPOINT (a loopback fake — WS-17 row 1's own condition) and
// the WINTER target session, which cannot be a live Winter runtime in this repository because the
// Winter SDK's own session runtime is the other repository's.
//
// HERMETIC IN THE FULL SENSE (whole-branch F-1): the adapter is built with `hermeticEnvPolicy()`, so
// the child sets the runtime's four traffic opt-outs and its advertised tool inventory is the
// artifact's own rather than whatever a feature-flag CDN answered this minute.
import { WINTER_BRAND, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer, withLoopbackFake } from "../../src/testing/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import { createOfficialAdapter } from "../../src/official/index.ts";
import { directoryRecordSink } from "../../src/official/spawn-proxy.ts";
import { createApprovalBridge } from "../../src/official/callbacks.ts";
import { officialMcpServers, winterMcpServerDescriptor } from "../../src/official/mcp-descriptors.ts";
import { createMessagingToolHandlers, createRuntimeMessaging } from "../../src/messaging/index.ts";
import type { GlobalMessagingHandle, RuntimeDirectoryHandle } from "../../src/messaging/index.ts";
import { hermeticEnvPolicy, hermeticSession, officialRuntimeBed, scriptedLoopback, type LoopbackRecord, type ScriptedTurn } from "../official/support.ts";
import { declaredClasses, sessionEntry, winterWriterHandle } from "../messaging/support.ts";

export const JOINT_TIMEOUT = 180_000;

export const jointSelection: RuntimeSelection = {
  runtimeKind: "claude-agent",
  providerId: "loopback",
  modelRef: "claude-sonnet-4-5",
  family: "claude",
  authFamily: "custom",
  sdkVersion: "0.0.2",
  reason: "the joint bed",
  decidedAt: new Date(0).toISOString(),
};

/** A `SessionStore` that stores nothing: this bed's subject is messaging, not the transcript. */
export class PassthroughStore {
  async append(): Promise<void> {}
  async load(): Promise<never[]> {
    return [];
  }
  async listSubkeys(): Promise<never[]> {
    return [];
  }
}

export interface JointResult {
  messages: Array<{ type: string; subtype?: string }>;
  record: LoopbackRecord;
  /** Everything the WINTER target session was actually handed. */
  pushed: string[];
  directory: RuntimeDirectoryHandle;
  messaging: GlobalMessagingHandle;
  store: RuntimeDirectoryStore;
  /** The address the official session was launched under. */
  address: string;
  configDir: string;
  /** The root the child was OBSERVED to get, or undefined if the proxy never saw a spawn. */
  observedRoot: string | undefined;
}

export interface JointSessionOptions {
  turns: readonly ScriptedTurn[];
  /** The official session's own address; canonical, because a listed object must be addressable. */
  officialId?: string;
  /** Extra directory rows to record before the session starts. */
  peers?: ReadonlyArray<{ id: string; displayName?: string }>;
  /** Run against the live session while its query is being drained. */
  during?: (live: { messaging: GlobalMessagingHandle; directory: RuntimeDirectoryHandle }) => Promise<void>;
  /** Share one directory store across sessions (row 4's two-session isolation). */
  store?: RuntimeDirectoryStore;
  /**
   * Override the DECLARED permission classes.
   *
   * The bed declares both by default, because most joint tests are about delivery and an undeclared
   * class would make every one of them measure the D2 hold instead. A test whose subject IS the hold
   * passes `{ official: undefined }` and gets the fail-closed behaviour with a real runtime as the
   * sender.
   */
  classes?: { winter?: (() => "prompts") | undefined; official?: (() => "prompts") | undefined };
}

/**
 * One official session, driven for real, with Lane B's router behind its messaging tools.
 *
 * THE HANDLER'S CALLER IS BOUND WITHOUT A TOOL-USE ID, deliberately: that is exactly how the official
 * branch registers it (the caller is bound once at registration and cannot know the id of any
 * individual call), and it is what makes this bed prove item 15 — the per-call id has to come from
 * the vendor's own `extra`, or the §12 retry key is not there at all.
 */
export async function runJointSession(options: JointSessionOptions): Promise<JointResult> {
  const bed = officialRuntimeBed();
  /* c8 ignore next */
  if (bed === undefined) throw new Error("unreachable: the joint suite is skipped without a bed");
  const officialId = options.officialId ?? "joint";
  const session = hermeticSession(`joint-${officialId}`);
  const { routes, record } = scriptedLoopback(options.turns);
  const messages: Array<{ type: string; subtype?: string }> = [];

  return withLoopbackFake({ routes }, async (fake) => {
    const directoryStore = options.store ?? createInMemoryRuntimeDirectoryStore();
    const { peer } = createFakeWinterPeer();
    const base = { peers: { winter: peer, claude: bed.module }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore };

    // ---- LANE B, FOR REAL ---------------------------------------------------------------------------
    const now = () => 1_000_000;
    const address = `session:${officialId}`;
    const declared = declaredClasses();
    const classes = {
      winter: options.classes !== undefined && "winter" in options.classes ? options.classes.winter : declared.winter.permissionClass,
      official: options.classes !== undefined && "official" in options.classes ? options.classes.official : declared.official.permissionClass,
    };
    const { directory, messaging } = createRuntimeMessaging(base, {
      directory: { now },
      messaging: {
        now,
        ...(classes.winter === undefined ? {} : { winter: { permissionClass: classes.winter } }),
        ...(classes.official === undefined ? {} : { official: { permissionClass: classes.official } }),
      },
    });
    await directory.record(sessionEntry(officialId, { runtimeKind: "claude-agent" }));
    const targets = new Map<string, ReturnType<typeof winterWriterHandle>>();
    for (const peerRow of options.peers ?? []) {
      await directory.record(sessionEntry(peerRow.id, peerRow.displayName === undefined ? {} : { displayName: peerRow.displayName }));
      const writer = winterWriterHandle(() => "idle");
      targets.set(peerRow.id, writer);
      messaging.attachWinterSession(`session:${peerRow.id}`, writer.handle);
    }
    const handlers = createMessagingToolHandlers(messaging, { sessionId: officialId });
    // -------------------------------------------------------------------------------------------------

    const context: SeamContextWithDirectory = { ...base, directory };
    // THE RECORD SINK IS EXPLICIT, and that is a finding rather than a preference. `buildOptions`
    // takes `spawnProxy: adapter.spawnProxy` — the DISPATCHER, for a host that builds its own options
    // — and the dispatcher's sink is `policy.sink ?? a no-op`, so the adapter's DEFAULT directory sink
    // (the one `createOfficialAdapter(context)` installs) never runs on that path. `launch()` binds
    // its own supervisor with the default sink, but the options already carry the dispatcher, so the
    // dispatcher is what spawns. Lane A's own `runtime-spool.test.ts` passes the sink explicitly for
    // the same reason; this bed does too, so §6 rule 2's record is written on the path a host that
    // follows the template actually takes.
    const adapter = createOfficialAdapter(context, {
      ...hermeticEnvPolicy(),
      sink: directoryRecordSink({ store: directoryStore, address }),
    });
    await adapter.ready();

    const descriptor = winterMcpServerDescriptor({
      brand: WINTER_BRAND,
      branchLabel: "winter-claude-agent",
      messaging: { sendMessage: handlers.sendMessage, listAgents: handlers.listAgents },
    });

    const options_ = adapter.buildOptions({
      mode: "code" as const,
      selection: jointSelection,
      cwd: session.cwd,
      sessionStore: new PassthroughStore() as unknown as SessionStore,
      autoMemoryDirectory: `${session.brandHome}/projects/${officialId}/memory`,
      brand: WINTER_BRAND,
      pathToClaudeCodeExecutable: bed.executable,
      spawnProxy: adapter.spawnProxy,
      profile: "fresh-spool" as const,
      configDir: session.spool,
    });
    const env = adapter.buildChildEnv({
      selection: jointSelection,
      configDir: session.spool,
      brand: WINTER_BRAND,
      credentials: { ANTHROPIC_BASE_URL: fake.url.replace(/\/$/, ""), ANTHROPIC_API_KEY: "sk-ant-loopback" },
      base: { HOME: session.home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
    });
    const live = adapter.launch({
      address,
      selection: jointSelection,
      prompt: "do the thing",
      cwd: session.cwd,
      profile: "fresh-spool",
      configDir: session.spool,
      options: {
        ...options_,
        env,
        mcpServers: officialMcpServers({ descriptor, module: bed.mcpModule, toInputShape: bed.toInputShape, branchLabel: "winter-claude-agent" }),
        canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
      },
    });
    if (options.during !== undefined) await options.during({ messaging, directory });
    for await (const message of live.query) messages.push(message as { type: string; subtype?: string });
    const pushed = [...targets.values()].flatMap((writer) => writer.pushed);
    return { messages, record, pushed, directory, messaging, store: directoryStore, address, configDir: live.configDir, observedRoot: live.supervisor.observation?.root.configDir };
  });
}
