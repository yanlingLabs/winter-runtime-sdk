// THE ONE DOOR (D19b): `createRuntimeSdk` and the `RuntimeSdk` handle.
//
// "A selector + adapter, never a translation layer: the pinned `query()`/`Options`/`SDKMessage`
// contract passes through verbatim plus runtime-selection inputs." Everything in this file exists to
// keep that sentence true — which is why `query()` forwards the caller's own `options` OBJECT when
// there is nothing router-owned to remove, and why the router-owned keys are one exported constant
// rather than a condition spelled in three places.
//
// TWO DELIBERATE DEVIATIONS FROM THE PLAN'S PINNED `RuntimeSdk.query` LINE, both measured, both
// forced by the SDKs this package exists to sit over:
//
//   1. THE DOOR TAKES ONE OBJECT, not two positional arguments. The plan writes
//      `query(prompt, options?)`. BOTH SDKs take a single params object —
//      `packages/sdk/src/query.ts:385` `query(args: { prompt; options }): Query` and the official
//      `sdk.d.ts:2742` `query(_params: { prompt; options? }): Query`. A router whose door had a
//      different arity than the two doors it wraps would be a translation layer in the one place the
//      architecture says it must not be one: every host would have to rewrite its call site to adopt
//      it, and "the same `query()`" (this repository's own README) would be false.
//   2. THE STREAMING PROMPT IS `AsyncIterable<string>`, not `AsyncIterable<SDKUserMessage>`. The
//      plan names the OFFICIAL SDK's type; the Winter SDK — whose contract this package re-exports
//      and whose `query` this door forwards to today — takes `string | AsyncIterable<string>` and
//      exports no `SDKUserMessage` at all. Taking a type the required peer cannot accept would make
//      the door untypeable. Mapping a Winter prompt onto the official branch's
//      `AsyncIterable<SDKUserMessage>` is Lane A's adapter concern (`OfficialLaunchPlan.prompt`
//      already carries the official shape).
//
// Both are in the Task 1 report under "what the pinned interfaces forced me to change".
import type { Options, Query } from "@yanlinglabs/winter-agent-sdk";

import { RuntimeSdkDisposedError } from "./errors.ts";
import type { GlobalMessaging } from "./seams/global-messaging.ts";
import type { HandoffBarrier, HandoffOutcome } from "./seams/handoff.ts";
import type { KeychainSeam } from "./seams/keychain.ts";
import type { MaterializedResumeDecorator } from "./seams/materialized-resume.ts";
import type { OfficialAdapter } from "./seams/official-adapter.ts";
import type { RuntimeDirectory } from "./seams/directory.ts";
import type { RuntimeDirectoryStore } from "./seams/directory-store.ts";
import { createInMemoryRuntimeDirectoryStore } from "./seams/directory-store.ts";
import { stubGlobalMessaging, stubHandoffBarrier, stubMaterializedResumeDecorator, stubOfficialAdapter, stubRuntimeDirectory } from "./seams/stubs.ts";
import type { RuntimeKind, RuntimeSelection, SelectionInput } from "./selection/runtime-selection.ts";
import { isSelectionRefusal, selectRuntime as selectRuntimePure, SelectionRefusedError } from "./selection/runtime-selection.ts";
import type { SessionKey, BrandProfile } from "@yanlinglabs/winter-agent-sdk";
import { assertVersionMatrix, type VersionMatrixReport } from "./version-matrix.ts";

/**
 * The injected peers.
 *
 * INSTANCES, not names. The router never imports the official SDK as a value — a host that only ever
 * creates Winter sessions never loads it — and taking the Winter peer by injection too means a host
 * that vendors all three packages (WS-02's own model) can be certain no SDK is instantiated twice.
 */
export interface RuntimeSdkPeers {
  winter: typeof import("@yanlinglabs/winter-agent-sdk");
  claude?: typeof import("@anthropic-ai/claude-agent-sdk");
}

export interface RuntimeSdkOptions {
  peers: RuntimeSdkPeers;
  /** R-7b-2's seam; default = in-memory (which is also what every hermetic test uses). */
  directoryStore?: RuntimeDirectoryStore;
  /** Host-provided credential reads (WS-14 §12) — never disk, never this package's own keychain. */
  keychain: KeychainSeam;
  /** `pathToClaudeCodeExecutable` for the official branch: the host vendors it; tests use node_modules. */
  vendoredOfficialRuntime?: string;
  /** Flows through to both branches unchanged (D19 clause a). */
  brand?: Partial<BrandProfile>;
}

/** Options members this package OWNS. Never forwarded to either SDK — see `query()`. */
export const ROUTER_ONLY_OPTION_KEYS = ["runtime"] as const;
export type RouterOnlyOptionKey = (typeof ROUTER_ONLY_OPTION_KEYS)[number];

/**
 * The runtime-selection inputs the door accepts ALONGSIDE the pinned `Options` — "additive and
 * typed" (the plan's Global Constraints), and stripped before either SDK sees them.
 */
export interface RouterRuntimeInput {
  /** A selection already persisted for this session. It WINS: a change is a handoff or a visible fork. */
  selection?: RuntimeSelection;
  /** Everything needed to decide one when there is no persisted selection yet. */
  select?: SelectionInput;
}

/** `Options` plus the router's own additive input. Nothing is removed and nothing is renamed. */
export interface RouterOptions extends Options {
  runtime?: RouterRuntimeInput;
}

export interface RuntimeSdk {
  /** The one door. See this module's header for the two deviations from the plan's pinned line. */
  query(args: { prompt: string | AsyncIterable<string>; options?: RouterOptions }): Query;
  /** D13/D28, pure. Throws `SelectionRefusedError` on a typed refusal (see that class's own note). */
  selectRuntime(input: SelectionInput): RuntimeSelection;
  /** WS-15 §6.1. */
  directory: RuntimeDirectory;
  /** WS-15 §6.2–6.4. */
  messaging: GlobalMessaging;
  /** WS-05 §12's mechanics; the host renders the outcome (R-7b-3). */
  handoff(session: SessionKey, to: RuntimeKind): Promise<HandoffOutcome>;
  readonly versions: VersionMatrixReport;
  dispose(): Promise<void>;
}

/**
 * The collaborators a lane swaps its real implementation into.
 *
 * Not part of `RuntimeSdk` (the plan pins that surface) and not a constructor option (the plan pins
 * those too) — it is this package's own internal wiring, exported for `test/spine/*` and for the
 * lanes' own tests to reach a single seam without standing up the whole handle.
 */
export interface RuntimeSdkInternals {
  official: OfficialAdapter;
  barrier: HandoffBarrier;
  decorator: MaterializedResumeDecorator;
  directoryStore: RuntimeDirectoryStore;
  keychain: KeychainSeam;
  peers: RuntimeSdkPeers;
  brand?: Partial<BrandProfile>;
  vendoredOfficialRuntime?: string;
}

/** Reaches the internals of a handle this package built. Returns undefined for anything else. */
export function runtimeSdkInternals(sdk: RuntimeSdk): RuntimeSdkInternals | undefined {
  return (sdk as { [INTERNALS]?: RuntimeSdkInternals })[INTERNALS];
}

const INTERNALS = Symbol.for("winter-runtime-sdk.internals");

/**
 * Builds the object forwarded to a peer's `query()`.
 *
 * THE COMMON CASE FORWARDS THE CALLER'S OWN OBJECT, by reference. "Passes through verbatim" is a
 * property a test can only really check by identity, and a router that copied unconditionally would
 * be quietly deciding which of `Options`' members it knows about — the exact drift D19b's "never a
 * translation layer" rules out. A copy is made ONLY when a router-owned key is present, because that
 * key must not reach an SDK that would not recognise it; every other member keeps its own value
 * identity through the copy.
 */
export function forwardableOptions(options: RouterOptions): Options {
  const routerKeys = ROUTER_ONLY_OPTION_KEYS.filter((key) => key in options);
  if (routerKeys.length === 0) return options;
  const forwarded: Record<string, unknown> = {};
  for (const key of Object.keys(options)) {
    if ((ROUTER_ONLY_OPTION_KEYS as readonly string[]).includes(key)) continue;
    forwarded[key] = (options as Record<string, unknown>)[key];
  }
  return forwarded as Options;
}

/**
 * Constructs the router. Throws `RuntimeSdkVersionError` on a version-matrix miss (D19a).
 *
 * THE MATRIX IS ASSERTED FIRST, before a single seam is built, so a refusal costs nothing and says
 * only what it is about.
 */
export function createRuntimeSdk(opts: RuntimeSdkOptions): RuntimeSdk {
  const versions = assertVersionMatrix(opts.peers);
  const directoryStore = opts.directoryStore ?? createInMemoryRuntimeDirectoryStore();

  // ONE WIRING LINE PER SEAM. A lane replaces the right-hand side and nothing else in this file
  // moves; see `seams/stubs.ts`'s own header for why the indirection exists.
  const internals: RuntimeSdkInternals = {
    official: stubOfficialAdapter(),
    barrier: stubHandoffBarrier(),
    decorator: stubMaterializedResumeDecorator(),
    directoryStore,
    keychain: opts.keychain,
    peers: opts.peers,
    ...(opts.brand === undefined ? {} : { brand: opts.brand }),
    ...(opts.vendoredOfficialRuntime === undefined ? {} : { vendoredOfficialRuntime: opts.vendoredOfficialRuntime }),
  };

  let disposed = false;
  const assertLive = (method: string): void => {
    if (disposed) throw new RuntimeSdkDisposedError(method);
  };

  const sdk: RuntimeSdk & { [INTERNALS]: RuntimeSdkInternals } = {
    [INTERNALS]: internals,
    versions,
    directory: stubRuntimeDirectory(directoryStore),
    messaging: stubGlobalMessaging(),
    query(args) {
      assertLive("query");
      // ROUTES TO THE WINTER PEER FOR NOW (Task 1's own scope): Lane D's selector decides the branch
      // and Lane A's adapter serves the official one. What is already final here is the PASS-THROUGH —
      // the prompt is forwarded by reference and the options object loses nothing but this package's
      // own additive key.
      const options = args.options ?? {};
      return opts.peers.winter.query({ prompt: args.prompt, options: forwardableOptions(options) });
    },
    selectRuntime(input) {
      assertLive("selectRuntime");
      const result = selectRuntimePure(input);
      if (isSelectionRefusal(result)) throw new SelectionRefusedError(result);
      return result;
    },
    async handoff(session, to) {
      assertLive("handoff");
      const plan = await internals.barrier.plan(session, to);
      return internals.barrier.execute(plan);
    },
    async dispose() {
      // IDEMPOTENT. A host that disposes twice (a shutdown path plus a signal handler) must not get
      // a second, different failure out of the one method whose whole job is to end cleanly.
      disposed = true;
    },
  };
  return sdk;
}
