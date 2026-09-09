// The messaging lane's test bed: in-memory everything, one clock the tests own, and doubles that
// RECORD rather than doubles that merely satisfy a type.
//
// HERMETIC BY CONSTRUCTION (Phase 7b's Global Constraints): the store is the spine's in-memory
// default, the clock is a variable, no test binds a port, opens a temp directory, reads a home
// directory or touches a keychain — there is nothing in this lane that needs one, and a bed that
// offered one would invite a test that used it.
//
// THE DOUBLES ARE RECORDERS. A facet that merely answered `delivered` would let a delivery test pass
// without anything having been delivered; every double here keeps what it was handed, so the
// assertions can be about the message that actually arrived.
import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import type { SeamContext } from "../../src/seams/context.ts";
import type { RuntimeDirectoryEntry, RuntimeDirectoryStore } from "../../src/seams/directory-store.ts";
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress, RuntimeKind } from "../../src/seams/messaging-contract.ts";
import type { RuntimeSelection } from "../../src/selection/runtime-selection.ts";
import type { AttachedOfficialSession, AttachedWinterSession, LiveSessionStatus } from "../../src/messaging/index.ts";
import { WINTER_BRAND, type SdkMessage, type SessionMessagingFacet } from "@yanlinglabs/winter-agent-sdk";
import type { MessagingIdleNoticePayload, MessagingNotificationsPage } from "@yanlinglabs/winter-agent-sdk";

export const selection = (over: Partial<RuntimeSelection> = {}): RuntimeSelection => ({
  runtimeKind: "winter-agent",
  providerId: "anthropic",
  modelRef: "anthropic/claude-sonnet-4-5",
  family: "claude",
  authFamily: "api-key",
  sdkVersion: "0.0.2",
  reason: "fixture",
  decidedAt: new Date(0).toISOString(),
  ...over,
});

export interface SessionEntryOptions {
  status?: RuntimeDirectoryEntry["status"];
  runtimeKind?: RuntimeKind;
  displayName?: string;
  generation?: number;
  mode?: string;
  backendSessionId?: string;
  capabilities?: Partial<ListedRuntimeObject["capabilities"]>;
  configDir?: string;
  processIdentity?: { pid: number; startedAt: string };
}

export function sessionEntry(id: string, options: SessionEntryOptions = {}): RuntimeDirectoryEntry {
  const runtimeKind = options.runtimeKind ?? "winter-agent";
  return {
    address: `session:${id}`,
    parsed: { objectKind: "session", runtimeKind, winterSessionId: id },
    runtimeKind,
    objectKind: "session",
    transport: runtimeKind === "winter-agent" ? "winter-session" : "claude-handle",
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    status: options.status ?? "running",
    mode: options.mode ?? "code",
    generation: options.generation ?? 1,
    selection: selection({ runtimeKind }),
    ...(options.backendSessionId === undefined ? {} : { backendSessionId: options.backendSessionId }),
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    ...(options.processIdentity === undefined ? {} : { processIdentity: options.processIdentity }),
    capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true, ...(options.capabilities ?? {}) },
    updatedAt: new Date(0).toISOString(),
  };
}

export function childEntry(parentId: string, childId: string, options: SessionEntryOptions = {}): RuntimeDirectoryEntry {
  const runtimeKind = options.runtimeKind ?? "winter-agent";
  return {
    address: `agent:${parentId}:${childId}`,
    parsed: { objectKind: "agent", runtimeKind, winterSessionId: parentId, parentWinterSessionId: parentId, childId },
    runtimeKind,
    objectKind: "agent",
    transport: runtimeKind === "winter-agent" ? "winter-thread" : "claude-child",
    ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
    status: options.status ?? "running",
    mode: options.mode ?? "code",
    generation: options.generation ?? 1,
    selection: selection({ runtimeKind }),
    parentAddress: `session:${parentId}`,
    capabilities: { message: true, resume: true, notifyWhenIdle: false, reply: true, ...(options.capabilities ?? {}) },
    updatedAt: new Date(0).toISOString(),
  };
}

export const sessionAddress = (id: string): RuntimeAddress => ({ objectKind: "session", runtimeKind: "winter-agent", winterSessionId: id });
export const childAddress = (parentId: string, childId: string): RuntimeAddress => ({ objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: parentId, parentWinterSessionId: parentId, childId });

export function envelope(over: Partial<GlobalAgentMessage> = {}): GlobalAgentMessage {
  return {
    messageId: "m-1",
    from: sessionAddress("a"),
    fromGeneration: 1,
    to: sessionAddress("b"),
    toGeneration: 1,
    body: "hello",
    notifyWhenIdle: false,
    createdAt: 0,
    expiresAt: 1_000_000_000,
    hopCount: 0,
    senderPermissionClass: "prompts",
    ...over,
  };
}

/** A clock the test moves by hand — no timers, no sleeps, no flake. */
export function createClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms) => {
      value += ms;
    },
    set: (ms) => {
      value = ms;
    },
  };
}

export interface FakeFacet {
  facet: SessionMessagingFacet;
  delivered: GlobalAgentMessage[];
  steered: Array<{ id: string; message: GlobalAgentMessage }>;
  resumed: Array<{ id: string; message: GlobalAgentMessage }>;
  subscribes: Array<{ id: string; messageId: string }>;
  /** Fire a live idle notice at every registered `onIdleNotice` handler. */
  fireIdle(payload: MessagingIdleNoticePayload): void;
  setDeliverOutcome(outcome: (message: GlobalAgentMessage) => DeliveryOutcome): void;
  setSenderClass(label: PermissionClassLabel): void;
  setChildOutcome(outcome: (id: string, message: GlobalAgentMessage) => DeliveryOutcome): void;
}

/**
 * A `Query.messaging` double.
 *
 * It answers with the same OUTCOME VOCABULARY the real facet answers with, including the rule that
 * matters most to a router: no delivery method ever rejects — every one resolves with a typed
 * `DeliveryOutcome`. A double that threw would let a test prove a `try`/`catch` rather than a policy.
 */
export function createFakeFacet(): FakeFacet {
  const delivered: GlobalAgentMessage[] = [];
  const steered: Array<{ id: string; message: GlobalAgentMessage }> = [];
  const resumed: Array<{ id: string; message: GlobalAgentMessage }> = [];
  const subscribes: Array<{ id: string; messageId: string }> = [];
  const notices: Array<(payload: MessagingIdleNoticePayload) => void> = [];
  let deliverOutcome: (message: GlobalAgentMessage) => DeliveryOutcome = (message) => ({ status: "queued", messageId: message.messageId });
  let childOutcome: (id: string, message: GlobalAgentMessage) => DeliveryOutcome = (_id, message) => ({ status: "queued", messageId: message.messageId });
  let senderClass: PermissionClassLabel = "prompts";

  const facet: SessionMessagingFacet = {
    async listReachable(): Promise<ListedRuntimeObject[]> {
      return [];
    },
    async deliver(message) {
      delivered.push(message);
      return deliverOutcome(message);
    },
    async steerChild(id, message) {
      steered.push({ id, message });
      return childOutcome(id, message);
    },
    async resumeChild(id, message) {
      resumed.push({ id, message });
      return childOutcome(id, message);
    },
    async subscribeIdle(id, opts) {
      subscribes.push({ id, messageId: opts.messageId });
      return { status: "subscribed", messageId: opts.messageId };
    },
    async senderClass(): Promise<PermissionClassLabel> {
      return senderClass;
    },
    async readNotifications(): Promise<MessagingNotificationsPage> {
      return { notifications: [], remaining: 0 };
    },
    onIdleNotice(handler) {
      notices.push(handler);
      return () => {
        const index = notices.indexOf(handler);
        if (index >= 0) notices.splice(index, 1);
      };
    },
  };

  return {
    facet,
    delivered,
    steered,
    resumed,
    subscribes,
    fireIdle(payload) {
      for (const handler of [...notices]) handler(payload);
    },
    setDeliverOutcome(outcome) {
      deliverOutcome = outcome;
    },
    setSenderClass(label) {
      senderClass = label;
    },
    setChildOutcome(outcome) {
      childOutcome = outcome;
    },
  };
}

export interface FakeOfficialSession {
  handle: AttachedOfficialSession;
  pushed: string[];
  setStatus(status: NonNullable<ReturnType<NonNullable<AttachedOfficialSession["status"]>>>): void;
  setFailure(error: Error | undefined): void;
}

export function createFakeOfficialSession(status: "running" | "idle" = "running"): FakeOfficialSession {
  const pushed: string[] = [];
  let current = status as NonNullable<ReturnType<NonNullable<AttachedOfficialSession["status"]>>>;
  let failure: Error | undefined;
  return {
    pushed,
    handle: {
      push(text) {
        if (failure !== undefined) throw failure;
        pushed.push(text);
      },
      status: () => current,
    },
    setStatus(next) {
      current = next;
    },
    setFailure(error) {
      failure = error;
    },
  };
}

/** A Winter session handle carrying a facet — the shape the router attaches. */
export function winterHandle(facet: FakeFacet, status?: () => LiveSessionStatus): AttachedWinterSession {
  return { messaging: facet.facet, ...(status === undefined ? {} : { status }) };
}

/** A Winter session handle with NO facet: the router-held input-stream writer on its own. */
export function winterWriterHandle(status?: () => LiveSessionStatus): { handle: AttachedWinterSession; pushed: string[] } {
  const pushed: string[] = [];
  return {
    pushed,
    handle: {
      push(text: string) {
        pushed.push(text);
      },
      ...(status === undefined ? {} : { status }),
    },
  };
}

export interface Bed {
  store: RuntimeDirectoryStore;
  context: SeamContext;
  clock: ReturnType<typeof createClock>;
  peerCalls: Array<{ prompt: string | AsyncIterable<string>; options: unknown }>;
}

/**
 * A context over the in-memory store and a fake Winter peer.
 *
 * `messages` is what a COLD RESUME's `query()` yields: a `result`-shaped message by default, which is
 * what makes `resumed_and_delivered` provable rather than assumed (the adapter reads the stream until
 * a turn appears). Pass `[]` for the stream that ends without one.
 */
export function createBed(options: { messages?: SdkMessage[] } = {}): Bed {
  const store = createInMemoryRuntimeDirectoryStore();
  const fake = createFakeWinterPeer(options.messages === undefined ? {} : { messages: options.messages });
  const context: SeamContext = { peers: { winter: fake.peer }, keychain: createFakeKeychain(), brand: WINTER_BRAND, directoryStore: store };
  return { store, context, clock: createClock(), peerCalls: fake.calls };
}
