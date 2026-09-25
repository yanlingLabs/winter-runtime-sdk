// THE ONE DOOR (D19b): `createRuntimeSdk` and the `RuntimeSdk` handle.
//
// WS-23: ONE RUNTIME. This door used to route a query to one of two runtimes — the Winter Agent SDK or
// the official Claude Agent SDK (`door.ts`'s official leg) — and to move a session between them
// (`handoff()`, WS-05 §12's barrier). The official runtime is retired: every query is a Winter query,
// every model (Claude's included) runs on it, and a persisted selection naming `claude-agent` is a
// typed refusal at the door rather than a second runtime. What is left is exactly the pass-through
// below, plus the run home, the directory and messaging router, the selection contract, and the
// switch review a host asks before a model change (`runtimeSdkInternals(sdk).barrier.reviewSwitch`).
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
//      plan named the OFFICIAL SDK's type; the Winter SDK — whose contract this package re-exports
//      and whose `query` this door forwards to — takes `string | AsyncIterable<string>` and exports
//      no `SDKUserMessage` at all.
//
// Both are in the Task 1 report under "what the pinned interfaces forced me to change".
import type { BrandProfile, McpSdkServerConfigWithInstance, Options, Query } from "@yanlinglabs/winter-agent-sdk";
import type { ContinuityEndpoint, MessageOrigin } from "@yanlinglabs/winter-provider-runtime";

import { RuntimeLaunchInputError, RuntimeSdkDisposedError, RuntimeSdkError } from "./errors.ts";
import type { SeamContext, SeamContextWithDirectory } from "./seams/context.ts";
import type { GlobalMessagingHandle } from "./messaging/router.ts";
import type { KeychainSeam } from "./seams/keychain.ts";
import type { RuntimeDirectory } from "./seams/directory.ts";
import type { RuntimeDirectoryStore } from "./seams/directory-store.ts";
import { createInMemoryRuntimeDirectoryStore } from "./seams/directory-store.ts";
import { createRuntimeMessaging } from "./messaging/index.ts";
import type { GlobalMessagingOptions, RuntimeDirectoryOptions } from "./messaging/index.ts";
import { createSwitchReviewer, type SwitchReviewerHandle } from "./store/review-switch.ts";
import type { RuntimeSelection, SelectionInput } from "./selection/runtime-selection.ts";
import { isSelectionRefusal, selectRuntime as selectRuntimePure, SelectionRefusedError } from "./selection/runtime-selection.ts";
import { assertVersionMatrix, type VersionMatrixReport } from "./version-matrix.ts";
import { RunHomeError } from "./run-home/errors.ts";
import { applyWinterRunHome, assertNoRunHomeDecidedOptions, assertRunHomeApplicable, observeQueryEnd } from "./run-home/apply.ts";
import { reconcileRootForRecovery, type RecoveryReport } from "./run-home/exit.ts";
import { defaultEndpointResolver } from "./default-endpoint-resolver.ts";
import { sdkHomeOf, type RunHome, type RunHomeFor, type RunHomeOutcome } from "./run-home/types.ts";

/**
 * The injected peer.
 *
 * AN INSTANCE, not a name: a host that vendors the packages (WS-02's own model) can be certain no SDK
 * is instantiated twice. WS-23: the optional `claude` peer (the official runtime's module) is gone
 * with the official leg.
 */
export interface RuntimeSdkPeers {
  winter: typeof import("@yanlinglabs/winter-agent-sdk");
}

export interface RuntimeSdkOptions {
  peers: RuntimeSdkPeers;
  /**
   * Host-declared peer package versions (D19a/R2, WS-02 §7.1) — THE ONLY DOOR inside a compiled
   * binary. The version matrix's probe 2 (`resolved-manifest`) resolves a peer's `package.json` via
   * `createRequire(...).resolve()`, which cannot see outside a compiled binary's own bundle
   * (`file:///$bunfs/...`); a host that self-spawns its own compiled artifact and whose injected peer
   * exports no version identity of its own (probe 1) has NOTHING for the matrix to read unless it
   * declares one here, from its own vendored `VERSIONS.json`. Declaring a version wins over both
   * probes when it parses — it does not bypass the matrix's range/exact-pin checks, only replaces how
   * the identity was DISCOVERED; an unparseable declared value falls through to probe 1 rather than
   * refusing on its own. Absent, behaviour is unchanged: probes 1 and 2, in that order.
   */
  peerVersions?: { winterAgentSdk?: string };
  /** R-7b-2's seam; default = in-memory (which is also what every hermetic test uses). */
  directoryStore?: RuntimeDirectoryStore;
  /**
   * Host-provided credential reads (WS-14 §12). WS-23: the official leg — which fetched a family's
   * credential at spawn — was this seam's only reader, and the Winter runtime resolves its own
   * `Options.provider.authRef` locator. Accepted and unused, so a host that still passes one keeps
   * compiling.
   */
  keychain?: KeychainSeam;
  /**
   * Flows through to the Winter leg unchanged (D19 clause a).
   *
   * RESOLVED ONCE, at construction, through the INJECTED peer's own `resolveBrand` — so an invalid
   * profile is a typed construction refusal (`InvalidBrandError`, the Winter SDK's own class) beside
   * the version matrix's, rather than a surprise at the first query. `RuntimeSdk.brand` is the
   * result, and it is what the router's own name derivations use.
   *
   * PRECEDENCE, in one sentence: a per-query `Options.brand` wins on the Winter leg and is never
   * rewritten; this constructor profile fills in when a query supplies none; Winter's own defaults
   * fill in when neither does.
   */
  brand?: Partial<BrandProfile>;
  /**
   * The switch reviewer's collaborators — the key keeps its name from when it configured the handoff
   * barrier (WS-23 retired the barrier; `reviewSwitch` is what survives of it).
   *
   * `winterHome` here is what fills `SeamContext.winterHome`, so the reviewer, the recovery door and
   * any later seam that reads the context all resolve under the same home. `resolveEndpoint` is the
   * host's catalog-registry resolver (WS-18 W18-20); absent, `defaultEndpointResolver()`. The shared
   * store is not offered: the router builds the one store every reader goes through.
   */
  handoff?: { winterHome?: string; resolveEndpoint?: (origin: MessageOrigin) => ContinuityEndpoint };
  /**
   * WS-09 §1.3's capability servers, as the Winter SDK's own in-process shape — FORWARDED, never
   * rewritten into anything else (R-8, and the user's tool-ownership ruling R-8-1).
   *
   * THE ROUTER OWNS NO TOOL. The daemon owns the capability tools — computer, browser, office — and
   * hands them over as MCP SERVERS; this is the door they come through. The Winter leg receives each
   * entry BY REFERENCE under its own `name`, merged into `Options.mcpServers`.
   *
   * THE BRAND'S OWN SERVER NAME IS RESERVED: `brand.mcpServerName` is the standing server's key, the
   * one the messaging tools resolve through (`mcp__<mcpServerName>__<tool>`), so a capability server
   * that claimed it would shadow them. That is a typed refusal at construction, not a silent
   * overwrite. A caller key that collides with a capability name is refused at the door too.
   */
  capabilities?: readonly McpSdkServerConfigWithInstance[];
  /**
   * The directory's and the router's own options (whole-branch review, F-3) — `messaging.winter`
   * carries the Winter adapter's options (its `permissionClass`, without which a receiver's class is
   * unknown and, since D2, fails closed).
   */
  messaging?: { directory?: RuntimeDirectoryOptions; messaging?: GlobalMessagingOptions };
  /**
   * WS-21 §3.1: EVERY GENERATION CARRIES A RUN HOME, or the router refuses it (`run_home_required`).
   *
   * OPT-IN, AND THAT IS THE FEATURE DETECTION (the plan's Global Constraints). A host that has not
   * adopted WS-21 keeps its old defaults and this router serves it unchanged; the daemon sets this the
   * moment it links a router that exports `buildRunHome`, and from then on no child can run on the
   * user's real home by accident — a missing run home is a typed refusal, raised synchronously,
   * before the peer is touched.
   */
  requireRunHome?: boolean;
  /**
   * WS-21 §3.1: the host's run-home builder, for the router's OWN cold-resume path
   * (`messaging/winter-adapter.ts`), which opens a Winter query no host call site is awaiting. The
   * router awaits it before it opens that query and applies the result exactly as `query()` does.
   * Absent with `requireRunHome` set, the cold resume answers a typed non-retryable `unavailable`.
   */
  runHomeFor?: RunHomeFor;
}

/** Options members this package OWNS. Never forwarded to the peer — see `query()`. */
export const ROUTER_ONLY_OPTION_KEYS = ["runtime"] as const;
export type RouterOnlyOptionKey = (typeof ROUTER_ONLY_OPTION_KEYS)[number];

/**
 * The runtime-selection inputs the door accepts ALONGSIDE the pinned `Options` — "additive and
 * typed" (the plan's Global Constraints), and stripped before the peer sees them.
 */
export interface RouterRuntimeInput {
  /**
   * A selection already persisted for this session. WS-23: it must name `winter-agent` — the only
   * runtime this router serves; one naming the retired `claude-agent` runtime is a typed refusal
   * (`RuntimeLaunchInputError`, field `runtime.selection`) rather than a query on some other runtime.
   */
  selection?: RuntimeSelection;
  /** Everything needed to decide one when there is no persisted selection yet (same rule). */
  select?: SelectionInput;
  /**
   * This session's own id. WS-23: it keyed the in-process ledger that refused a mid-session change of
   * RUNTIME; with one runtime there is no such change, so it is accepted and unused.
   */
  sessionId?: string;
  /**
   * WS-21 §3.1: the per-run folder this generation runs on, built by `buildRunHome` and awaited by the
   * host before it calls `query()`. Applied synchronously; required when the router was created with
   * `requireRunHome: true`.
   */
  runHome?: RunHome;
}

/** `Options` plus the router's own additive input. Nothing is removed and nothing is renamed. */
export interface RouterOptions extends Options {
  runtime?: RouterRuntimeInput;
}

export interface RuntimeSdk {
  /** The resolved brand profile every Winter-owned name in this session derives from (I2). */
  readonly brand: BrandProfile;
  /**
   * The one door (D19b). See this module's header for the deviations from the plan's pinned line.
   * WS-23: it returns the Winter peer's own `Query`, always — there is no second runtime whose handle
   * it could be.
   */
  query(args: { prompt: string | AsyncIterable<string>; options?: RouterOptions }): Query;
  /** D13/D28, pure. Throws `SelectionRefusedError` on a typed refusal (see that class's own note). */
  selectRuntime(input: SelectionInput): RuntimeSelection;
  /** WS-15 §6.1. */
  directory: RuntimeDirectory;
  /**
   * WS-15 §6.2–6.4 — the HANDLE, which is the seam plus the two doors a host cannot work without.
   *
   * WIDENED, NEVER NARROWED (F-3). The plan pins `GlobalMessaging`, and `GlobalMessagingHandle`
   * extends it: every pinned member is present with its pinned signature, and what is added is
   * `attachWinterSession` — without which a host can configure a receiver's permission class and
   * still have nothing live to deliver to.
   */
  messaging: GlobalMessagingHandle;
  readonly versions: VersionMatrixReport;
  /**
   * WS-21 §3.8: what became of a run home's working copy. `safe` — nothing is left to reconcile, the
   * host may `dispose()` it; `quarantined` — it diverged from the canonical store and its `projects/`
   * was copied to `<home>/cache/quarantine/`; `pending` — the incarnation is still running, or the run
   * id is one this handle never applied.
   */
  runHomeOutcome(runId: string): RunHomeOutcome;
  /**
   * WS-21 §3.8's recovery door: reconciles a recorded local-write root left behind by a crash (or a
   * pre-WS-21 spool root, Migration C), through THIS handle's own store, after recomputing the
   * claude-ready copy the root was staged from — PER TRANSCRIPT (I6). Each transcript is `clean`
   * (level), `appended` (the canonical file was behind and is now level), `canonical-ahead` (the
   * working copy is a prefix of a canonical history that moved on: nothing to append, nothing lost) or
   * `quarantined` (unprovable: its file is copied to `<home>/cache/quarantine/`, nothing of it is
   * appended, its session keeps its repair flag). The root `outcome` is `quarantined` if any transcript
   * was, else `appended` if any was, else `clean`. A session's repair flag is cleared when every one of
   * its transcripts came back level — `canonical-ahead` included, without checking for a live writer (the
   * store facade keeps no live-session registry to check against), so a host MUST let this finish
   * before any session whose key it recovers opens. The daemon runs it at boot, before sessions open.
   */
  reconcileRootForRecovery(root: string): Promise<RecoveryReport>;
  dispose(): Promise<void>;
}

/**
 * The `runtime` a host passes when it has only a run home to say (WS-21). WS-23: kept as a name — it
 * was the Winter overload's input when the door had two; `RouterRuntimeInput` accepts it as it is.
 */
export interface WinterLegRuntimeInput {
  runHome: RunHome;
  selection?: never;
  select?: never;
}

/**
 * The collaborators a lane swaps its real implementation into.
 *
 * Not part of `RuntimeSdk` (the plan pins that surface) and not a constructor option (the plan pins
 * those too) — it is this package's own internal wiring, exported for `test/spine/*` and for the
 * lanes' own tests to reach a single seam without standing up the whole handle.
 */
export interface RuntimeSdkInternals {
  /**
   * The switch reviewer (`reviewSwitch`) and the one shared store. The name is the handoff barrier's,
   * which this was part of until WS-23 — hosts reach the review as `runtimeSdkInternals(sdk).barrier`.
   */
  barrier: SwitchReviewerHandle;
  /** The exact object every seam factory was handed — what a lane's real factory will receive. */
  context: SeamContextWithDirectory;
}

/** Reaches the internals of a handle this package built. Returns undefined for anything else. */
export function runtimeSdkInternals(sdk: RuntimeSdk): RuntimeSdkInternals | undefined {
  return (sdk as { [INTERNALS]?: RuntimeSdkInternals })[INTERNALS];
}

const INTERNALS = Symbol.for("winter-runtime-sdk.internals");

/**
 * Builds the object forwarded to a peer's `query()`.
 *
 * THE INVARIANT, IN ONE SENTENCE: **the forwarded options are the caller's options minus
 * `ROUTER_ONLY_OPTION_KEYS`, plus the brand's capability-server entries under `mcpServers`, and
 * nothing else is rewritten.**
 *
 * THE COMMON CASE FORWARDS THE CALLER'S OWN OBJECT, by reference. "Passes through verbatim" is a
 * property a test can only really check by identity, and a router that copied unconditionally would
 * be quietly deciding which of `Options`' members it knows about — the exact drift D19b's "never a
 * translation layer" rules out. A copy is made ONLY when there is something to remove or something to
 * add, because that is the only time the caller's own object would be the wrong thing to hand over;
 * every other member keeps its own value identity through the copy.
 *
 * SO R-8 DID NOT WEAKEN THE PROPERTY, IT RESTATED IT. A host that configures no capabilities is
 * unaffected — the identity return below still fires, and the test that pins it is unchanged. A host
 * that configures them gets a copy whose every member except `mcpServers` is `Object.is`-identical to
 * its own, and whose `mcpServers` is its own entries plus the capability entries, by reference.
 *
 * A CAPABILITY KEY THE CALLER ALSO USES IS A TYPED REFUSAL, never a silent overwrite in either
 * direction: one of the two servers would simply not be there, and the party who would find out is
 * the model, at the one moment the tool matters.
 */
export function forwardableOptions(options: RouterOptions, brand?: Partial<BrandProfile>, capabilityServers?: Readonly<Record<string, unknown>>): Options {
  const stripKeys = ROUTER_ONLY_OPTION_KEYS.filter((key) => key in options);
  // THE BRAND IS FILLED IN, NEVER OVERWRITTEN (I2). A per-query `Options.brand` is the host saying
  // something about THIS query and wins outright; the constructor profile is a default for the
  // queries that say nothing.
  //
  // AND ONLY WHEN THE HOST ACTUALLY CHOSE ONE. With no constructor brand the resolved profile IS
  // Winter's default, which is what the SDK would apply anyway — so injecting it would change nothing
  // except this object's identity, and the pass-through property is worth more than the symmetry.
  const injectBrand = brand !== undefined && options.brand === undefined;
  if (stripKeys.length === 0 && !injectBrand && capabilityServers === undefined) return options;
  const forwarded: Record<string, unknown> = {};
  for (const key of Object.keys(options)) {
    if ((ROUTER_ONLY_OPTION_KEYS as readonly string[]).includes(key)) continue;
    forwarded[key] = (options as Record<string, unknown>)[key];
  }
  if (injectBrand) forwarded["brand"] = brand;
  if (capabilityServers !== undefined) forwarded["mcpServers"] = mergedMcpServers(options.mcpServers, capabilityServers);
  return forwarded as Options;
}

/**
 * The caller's own `mcpServers` entries, plus the capability entries, or a refusal.
 *
 * BY REFERENCE ON BOTH SIDES: each value is the object its owner built. The caller's own record is
 * never mutated — a host that reuses one `Options` object across queries would otherwise find the
 * router's entries in it.
 */
function mergedMcpServers(callerOwned: Options["mcpServers"], capabilityServers: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (callerOwned === undefined) return capabilityServers as Record<string, unknown>;
  assertNoCapabilityCollision(callerOwned, capabilityServers);
  return { ...callerOwned, ...capabilityServers };
}

/**
 * The collision rule, as ONE function the door runs before it forwards anything (interim review I-6):
 * a caller entry that shadows a capability name is a typed refusal, never a silent overwrite in
 * either direction — one of the two servers would simply not be there, and the party who would find
 * out is the model.
 */
function assertNoCapabilityCollision(callerOwned: Options["mcpServers"], capabilityServers: Readonly<Record<string, unknown>>): void {
  if (callerOwned === undefined) return;
  for (const name of Object.keys(capabilityServers)) {
    if (name in callerOwned) {
      throw new RuntimeLaunchInputError({
        field: "mcpServers",
        reason: `\`${name}\` is the name of a capability server this handle forwards, and the caller's own \`mcpServers\` already carries it — one of the two would silently not be registered, so the door refuses rather than choose for you`,
      });
    }
  }
}

/**
 * The Winter leg's `mcpServers` record, keyed by each capability server's own name.
 *
 * TWO REFUSALS, BOTH AT CONSTRUCTION. Two servers under one name is a host that has lost track of
 * which one is registered; a server under `brand.mcpServerName` is a host claiming the STANDING
 * server's key — the one `mcp__<mcpServerName>__<tool>` resolves through, which the messaging tools
 * are registered under — which would shadow them.
 */
function capabilityServerRecord(capabilities: readonly McpSdkServerConfigWithInstance[] | undefined, brand: BrandProfile): Record<string, McpSdkServerConfigWithInstance> | undefined {
  if (capabilities === undefined || capabilities.length === 0) return undefined;
  const record: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const server of capabilities) {
    if (server.name === brand.mcpServerName) {
      throw new RuntimeLaunchInputError({
        field: "capabilities",
        reason: `\`${server.name}\` is the brand's own standing-server name, which the messaging tools are registered under — a capability server may not claim it (WS-09 §1.3)`,
      });
    }
    if (server.name in record) {
      throw new RuntimeLaunchInputError({ field: "capabilities", reason: `two capability servers are named \`${server.name}\`, so one of them would never be registered` });
    }
    record[server.name] = server;
  }
  return record;
}

/**
 * Constructs the router. Throws `RuntimeSdkVersionError` on a version-matrix miss (D19a).
 *
 * THE MATRIX IS ASSERTED FIRST, before a single seam is built, so a refusal costs nothing and says
 * only what it is about.
 */
export function createRuntimeSdk(opts: RuntimeSdkOptions): RuntimeSdk {
  const versions = assertVersionMatrix(opts.peers, opts.peerVersions);
  // THE BRAND, RESOLVED ONCE, THROUGH THE INJECTED PEER (I2). A host that vendored its own copy of the
  // Winter SDK gets ITS validation and ITS `InvalidBrandError`. `resolveBrand` returns a result rather
  // than throwing, and this is the caller that turns a refusal into a throw — at construction.
  const resolved = opts.peers.winter.resolveBrand(opts.brand);
  if (!resolved.ok) throw new opts.peers.winter.InvalidBrandError(resolved.reason);
  const brand = resolved.brand;
  // WS-21: A RUN-HOME ROUTER NAMES ITS HOME. Its store is rooted at `sdkHomeOf(home)` — the shared
  // runtime home — and a store resolved from the peer's own default instead would be a guess about
  // which home that is. Refused at construction, where it costs nothing.
  if (opts.requireRunHome === true && (opts.handoff?.winterHome === undefined || opts.handoff.winterHome.length === 0)) {
    throw new RuntimeLaunchInputError({
      field: "handoff.winterHome",
      reason: "a router created with `requireRunHome: true` roots its session store at the shared runtime home under the daemon's home, so the home must be named explicitly (WS-21 §3.1)",
    });
  }
  const storeHome = opts.requireRunHome === true && opts.handoff?.winterHome !== undefined ? sdkHomeOf(opts.handoff.winterHome) : undefined;
  const directoryStore = opts.directoryStore ?? createInMemoryRuntimeDirectoryStore();
  // THE CAPABILITY SERVERS, BUILT ONCE (R-8): the record is the object every query forwards — value
  // identity across queries is part of what "the same servers" means, and a malformed declaration is
  // a construction refusal rather than a first-query surprise.
  const capabilityServers = capabilityServerRecord(opts.capabilities, brand);

  // ONE CONTEXT, BUILT ONCE, HANDED TO EVERY SEAM FACTORY. The directory is built FIRST, because the
  // messaging router resolves addresses through it.
  const base: SeamContext = {
    peers: opts.peers,
    ...(opts.keychain === undefined ? {} : { keychain: opts.keychain }),
    brand,
    directoryStore,
    // The reviewer's home IS the context's home (F-3): one field, so the store the reviewer resolves
    // and the store any later seam resolves through the context cannot end up being two.
    ...(opts.handoff?.winterHome === undefined ? {} : { winterHome: opts.handoff.winterHome }),
    // WS-21: the store's root, for every seam that resolves the shared store through the context.
    ...(storeHome === undefined ? {} : { storeHome }),
  };
  // WS-21 §3.8: every run home this handle applied, by run id. Absent = `pending`. Built BEFORE the
  // messaging router, because the router's own cold resume records into it too.
  const runHomeOutcomes = new Map<string, RunHomeOutcome>();
  // The directory and the messaging router come from ONE factory (the directory's child view delivers
  // through the router while the router resolves through the directory — a circularity closed by a
  // late binding inside `createRuntimeMessaging`).
  const { directory, messaging } = createRuntimeMessaging(base, opts.messaging ?? {}, {
    winterRunHomes: {
      require: opts.requireRunHome === true,
      ...(opts.runHomeFor === undefined ? {} : { runHomeFor: opts.runHomeFor }),
      apply: (options, runHome) => {
        assertRunHomeApplicable(runHome, { leg: "winter", cwd: options.cwd, brand, storeHome });
        return applyWinterRunHome(options, runHome, brand);
      },
      record: (runId, outcome) => {
        runHomeOutcomes.set(runId, outcome);
      },
    },
  });
  const context: SeamContextWithDirectory = { ...base, directory };
  // THE SWITCH REVIEWER, over the ONE shared store the recovery door also writes through.
  const reviewer = createSwitchReviewer(context, opts.handoff?.resolveEndpoint === undefined ? {} : { resolveEndpoint: opts.handoff.resolveEndpoint });
  const internals: RuntimeSdkInternals = { barrier: reviewer, context };

  let disposed = false;
  const assertLive = (method: string): void => {
    if (disposed) throw new RuntimeSdkDisposedError(method);
  };

  const decide = (input: SelectionInput): RuntimeSelection => {
    const result = selectRuntimePure(input);
    if (isSelectionRefusal(result)) throw new SelectionRefusedError(result);
    return result;
  };

  const queryImpl = (args: { prompt: string | AsyncIterable<string>; options?: RouterOptions }): Query => {
    assertLive("query");
    const options = args.options ?? {};
    const runtime = options.runtime;
    // WS-21 §3.1: NO GENERATION WITHOUT A RUN HOME, refused before anything else — before the
    // selection is read, before a child exists.
    const runHome = runtime?.runHome;
    if (opts.requireRunHome === true && runHome === undefined) {
      throw new RunHomeError(
        "run_home_required",
        "this router was created with `requireRunHome: true`, so every generation must carry the per-run folder the host built for it (`runtime.runHome`, from `buildRunHome`) — without one the child would read the user's real home (WS-21 §3.1)",
      );
    }
    // Before anything is forwarded (I-6): the caller's own `mcpServers` against the capability names.
    if (capabilityServers !== undefined) assertNoCapabilityCollision(options.mcpServers, capabilityServers);
    // WS-23: ONE RUNTIME. A persisted selection wins and is never re-decided (D13); `select` is decided
    // only when there is none. Either way it must name the runtime this router serves — a selection on
    // the retired official runtime is refused typed, never quietly served here on its transcript.
    const decided = runtime === undefined ? undefined : (runtime.selection ?? (runtime.select === undefined ? undefined : decide(runtime.select)));
    if (decided !== undefined && decided.runtimeKind !== "winter-agent") {
      throw new RuntimeLaunchInputError({
        field: "runtime.selection",
        reason: `the selection names the ${decided.runtimeKind} runtime, which this router no longer serves — the official Claude runtime is retired and every model runs on the Winter runtime (WS-23); decide the session onto \`winter-agent\``,
      });
    }
    if (runHome !== undefined) {
      assertRunHomeApplicable(runHome, { leg: "winter", cwd: options.cwd, brand, storeHome });
      // FIX ROUND 1, M1: the options a run home decides are not the caller's.
      assertNoRunHomeDecidedOptions(options);
    }
    // WS-21 §3.1: the run home's env, setting source and memory pin, laid over the caller's options
    // before the pass-through — synchronously, so nothing reaches the peer without them.
    const winterOptions = runHome === undefined ? options : applyWinterRunHome(options, runHome, brand);
    const winterQuery = opts.peers.winter.query({ prompt: args.prompt, options: forwardableOptions(winterOptions, opts.brand === undefined ? undefined : brand, capabilityServers) });
    if (runHome === undefined) return winterQuery;
    // WS-21 §3.8 (fix round 1, M6): `pending` while the incarnation runs, `safe` only when it ENDS.
    // The Winter child writes the canonical store directly (its `projects/` is a link to it), so there
    // is no working copy to reconcile — but it reads the run folder for as long as it runs, and a
    // host disposes on `safe`, so `safe` must wait for the query to settle.
    const runId = runHome.runId;
    runHomeOutcomes.set(runId, "pending");
    return observeQueryEnd(winterQuery, () => {
      runHomeOutcomes.set(runId, "safe");
    });
  };

  const sdk: RuntimeSdk & { [INTERNALS]: RuntimeSdkInternals } = {
    [INTERNALS]: internals,
    versions,
    brand,
    directory,
    messaging,
    query: queryImpl,
    selectRuntime(input) {
      assertLive("selectRuntime");
      return decide(input);
    },
    runHomeOutcome(runId) {
      return runHomeOutcomes.get(runId) ?? "pending";
    },
    async reconcileRootForRecovery(root) {
      assertLive("reconcileRootForRecovery");
      // THE ROUTER'S OWN STORE, and the daemon's home for the quarantine (spec §3.8). A router on the
      // pre-WS-21 layout has no shared runtime home to recover into, so it refuses rather than guess.
      const home = opts.handoff?.winterHome;
      if (storeHome === undefined || home === undefined) {
        throw new RuntimeSdkError("winter-runtime-sdk: reconcileRootForRecovery needs a router created with `requireRunHome` and an explicit `handoff.winterHome` — the recovered transcript belongs in the shared runtime home under it (WS-21 §3.8)");
      }
      return reconcileRootForRecovery(root, {
        shared: reviewer.shared,
        home,
        storeHome,
        resolveEndpoint: opts.handoff?.resolveEndpoint ?? defaultEndpointResolver(),
      });
    },
    async dispose() {
      // IDEMPOTENT. A host that disposes twice (a shutdown path plus a signal handler) must not get
      // a second, different failure out of the one method whose whole job is to end cleanly.
      disposed = true;
    },
  };
  return sdk;
}
