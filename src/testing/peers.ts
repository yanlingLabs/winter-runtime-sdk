// FAKE PEERS — the one place this package casts to a module-namespace type.
//
// `RuntimeSdkPeers.winter` is `typeof import("@yanlinglabs/winter-agent-sdk")`: a 231-export module
// namespace. Nothing a test can build satisfies that structurally, and nothing should have to — a
// test of the DOOR needs `query` and a version identity, not two hundred re-exports. So the cast
// lives here, ONCE, with this explanation, and every lane's test gets a typed fake instead.
//
// WHAT THE FAKE IS FOR, precisely: proving the router forwards. It records the exact `prompt` and
// `options` VALUES it was handed (by reference — `test/spine/query-passthrough.test.ts` asserts
// identity, not deep equality) and yields exactly the messages it was scripted with, so "the stream
// passes through verbatim" is checkable rather than assumed.
import { InvalidBrandError, resolveBrand, transcriptProjectKey } from "@yanlinglabs/winter-agent-sdk";
import type { AccountInfo, ModelFamilyListing, ModelInfo, Options, PermissionMode, Query, RewindFilesResult, SdkMessage } from "@yanlinglabs/winter-agent-sdk";

import type { RuntimeSdkPeers } from "../sdk.ts";

export interface RecordedQueryCall {
  prompt: string | AsyncIterable<string>;
  options: Options;
}

export interface FakeWinterPeer {
  /** Pass this as `peers.winter`. */
  peer: RuntimeSdkPeers["winter"];
  /** Every `query()` the router made, in order, with the values it forwarded. */
  calls: RecordedQueryCall[];
  /** The exact message objects the fake yields — for identity assertions on the stream. */
  scripted: SdkMessage[];
}

export interface FakeWinterPeerOptions {
  /**
   * The package version the fake reports as its own identity (probe step 1, `peer-export`).
   * Defaults to a version INSIDE the matrix so a test that does not care about versions constructs
   * cleanly; pass an out-of-range value to exercise the refusal.
   */
  packageVersion?: string;
  /** Defaults to the one protocol version this router is tested against. */
  protocolVersion?: string;
  /** What the returned `Query` yields, in order. Defaults to one result-shaped message. */
  messages?: SdkMessage[];
  /** Called instead of the default generator, when a test needs the Query itself to misbehave. */
  query?: (args: { prompt: string | AsyncIterable<string>; options: Options }) => Query;
}

const defaultMessage = (): SdkMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "ok",
  }) as unknown as SdkMessage;

/**
 * A `Query` over a fixed message list.
 *
 * The pinned `Query` members that a spine test never drives (`interrupt`, `setModel`, …) reject with
 * a named error rather than resolving: a fake that silently succeeded would let a test claim a path
 * works when nothing implemented it.
 */
function scriptedQuery(messages: SdkMessage[]): Query {
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new Error(`fake winter peer: Query.${name}() is not scripted`);
  };
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  const query: Query = {
    next: (...args: [] | [unknown]) => generator.next(...(args as [])),
    return: (value: unknown) => generator.return(value as never),
    throw: (error: unknown) => generator.throw(error),
    [Symbol.asyncIterator]() {
      return query;
    },
    // `AsyncGenerator` is `AsyncDisposable` on this TypeScript lib, so the pinned `Query` is too:
    // disposing the fake ends its generator, which is what `await using` would expect of the real one.
    async [Symbol.asyncDispose]() {
      await generator.return(undefined as never);
    },
    interrupt: unsupported("interrupt"),
    setModel: unsupported("setModel") as (model?: string) => Promise<void>,
    supportedModels: unsupported("supportedModels") as () => Promise<ModelInfo[]>,
    listModelFamilies: unsupported("listModelFamilies") as () => Promise<ModelFamilyListing>,
    accountInfo: unsupported("accountInfo") as () => Promise<AccountInfo>,
    rewindFiles: unsupported("rewindFiles") as (userMessageId: string, options?: { dryRun?: boolean }) => Promise<RewindFilesResult>,
    setPermissionMode: unsupported("setPermissionMode") as (mode: PermissionMode) => Promise<void>,
    // R-7b-4's per-session messaging facet, added to `Query` by the SDK's own 0.0.2 (Task 0). Every
    // member is `unsupported` for the same reason as the rest of this fake: a facet that silently
    // answered would let a test claim a messaging path works when nothing implemented it. Lane B's
    // adapters drive the REAL facet.
    messaging: {
      listReachable: unsupported("messaging.listReachable"),
      deliver: unsupported("messaging.deliver"),
      steerChild: unsupported("messaging.steerChild"),
      resumeChild: unsupported("messaging.resumeChild"),
      subscribeIdle: unsupported("messaging.subscribeIdle"),
      senderClass: unsupported("messaging.senderClass"),
      readNotifications: unsupported("messaging.readNotifications"),
      onIdleNotice: () => {
        throw new Error("fake winter peer: Query.messaging.onIdleNotice() is not scripted");
      },
    } as unknown as Query["messaging"],
  };
  return query;
}

/** A Winter peer that records what the router forwarded. See this module's header for the cast. */
export function createFakeWinterPeer(options: FakeWinterPeerOptions = {}): FakeWinterPeer {
  const calls: RecordedQueryCall[] = [];
  const scripted = options.messages ?? [defaultMessage()];
  const namespace = {
    SDK_VERSION: options.packageVersion ?? "0.0.3",
    PROTOCOL_VERSION: options.protocolVersion ?? "1.0",
    // THE REAL brand functions, not stand-ins. `createRuntimeSdk` calls `resolveBrand` and throws
    // `InvalidBrandError` THROUGH THE INJECTED PEER (so a host that vendored its own copy catches its
    // own class), and a fake that answered differently would make every brand test measure the fake.
    resolveBrand,
    InvalidBrandError,
    // THE REAL derivation too, for the same reason (R-7b-13). The door reads the transcript project
    // key off the INJECTED peer so both branches write under one project directory for one cwd; a
    // fake that answered differently — or not at all — would make every door test measure a key no
    // host will ever see.
    transcriptProjectKey,
    query: (args: { prompt: string | AsyncIterable<string>; options: Options }): Query => {
      calls.push({ prompt: args.prompt, options: args.options });
      return options.query === undefined ? scriptedQuery(scripted) : options.query(args);
    },
  };
  return { peer: namespace as unknown as RuntimeSdkPeers["winter"], calls, scripted };
}

export interface FakeClaudePeerOptions {
  /** Defaults to the exact pin in the matrix. */
  packageVersion?: string;
}

/**
 * An official peer, for matrix tests only.
 *
 * It exports a version identity ON PURPOSE: without one, the matrix's second probe would resolve the
 * REAL `@anthropic-ai/claude-agent-sdk@0.3.250` that this repository installs as a dev dependency,
 * and an "out of range" test would pass for the wrong reason.
 */
export function createFakeClaudePeer(options: FakeClaudePeerOptions = {}): NonNullable<RuntimeSdkPeers["claude"]> {
  return { version: options.packageVersion ?? "0.3.250" } as unknown as NonNullable<RuntimeSdkPeers["claude"]>;
}
