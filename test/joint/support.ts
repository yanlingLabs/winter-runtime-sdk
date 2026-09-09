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
  /** The `system/init` session id this generation reported — what a restart must hand back. */
  backendSessionId: string | undefined;
  /** This generation's own hermetic directories, so a later generation can resume INTO them. */
  session: { home: string; spool: string; cwd: string; brandHome: string };
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
   * RESUME generation one instead of launching a fresh session (NEW-B).
   *
   * A "restart" that launches a second fresh session under a second spool proves nothing about
   * resume: it is two unrelated generations that happen to share a directory row. A real one reuses
   * the SAME spool (that is what survives a process death) and hands the runtime the backend session
   * id its first generation reported, through `adapter.resume()` — WS-14 §1's profile 2.
   */
  resumeFrom?: { spool: string; home: string; cwd: string; brandHome: string; backendSessionId: string };
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
  // A RESUME REUSES GENERATION ONE'S DIRECTORIES (NEW-B). The spool is `CLAUDE_CONFIG_DIR`, i.e. where
  // the transcript of the session being resumed actually lives; a fresh `mkdtemp` would be a different
  // machine as far as the runtime is concerned.
  const session = options.resumeFrom ?? hermeticSession(`joint-${officialId}`);
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
    // THE RECORD SINK IS EXPLICIT HERE AS A CHOICE, NOT A NECESSITY (fix-wave re-review, NEW-E). An
    // earlier version of this comment said `launch()`'s options "already carry the dispatcher, so the
    // dispatcher is what spawns" — measurably wrong: `start()` binds `spawnClaudeCodeProcess:
    // supervisor.spawn` LAST, overriding the dispatcher `buildOptions` put there, and that
    // supervisor's sink is `sinkFor(plan)`, i.e. the adapter's DEFAULT directory sink. This bed's own
    // `observedRoot` assertions read `live.supervisor.observation`, which is that supervisor.
    //
    // What IS true: the dispatcher's sink is `policy.sink ?? a no-op`, so §6 rule 2's record is
    // silently absent on exactly one path — a host that builds options with `spawnProxy:
    // adapter.spawnProxy` and calls the vendor's `query()` ITSELF. The dispatcher cannot default to
    // the directory sink because it has no plan and therefore no address. Naming the sink here keeps
    // this bed independent of that question.
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
    const launchOptions = {
      ...options_,
      env,
      mcpServers: officialMcpServers({ descriptor, module: bed.mcpModule, toInputShape: bed.toInputShape, branchLabel: "winter-claude-agent" }),
      canUseTool: createApprovalBridge({ brand: WINTER_BRAND, mode: "default", broker: async (request) => ({ behavior: "allow", updatedInput: request.input }) }),
    };
    const plan = {
      address,
      selection: jointSelection,
      prompt: "do the thing",
      cwd: session.cwd,
      profile: "fresh-spool" as const,
      configDir: session.spool,
      options: launchOptions,
    };
    // `resume()` AND NOT `launch()` when a restart is being modelled — a different door on the seam,
    // a different launch profile, and the only one that hands the runtime a backend session id.
    const live =
      options.resumeFrom === undefined ? adapter.launch(plan) : adapter.resume({ ...plan, resume: options.resumeFrom.backendSessionId });
    if (options.during !== undefined) await options.during({ messaging, directory });
    for await (const message of live.query) messages.push(message as { type: string; subtype?: string });
    const pushed = [...targets.values()].flatMap((writer) => writer.pushed);
    // The id the runtime itself reported at `system/init` — the identity a restart has to carry.
    const init = messages.find((message) => message.type === "system" && message.subtype === "init") as { session_id?: unknown } | undefined;
    const backendSessionId = typeof init?.session_id === "string" ? init.session_id : undefined;
    return {
      messages,
      record,
      pushed,
      directory,
      messaging,
      store: directoryStore,
      address,
      configDir: live.configDir,
      observedRoot: live.supervisor.observation?.root.configDir,
      backendSessionId,
      session: { home: session.home, spool: session.spool, cwd: session.cwd, brandHome: session.brandHome },
    };
  });
}
