// THE OFFICIAL LEG OF THE ONE DOOR (Task 6b) — everything `RuntimeSdk.query()` needs to serve a
// `claude-agent` selection, in one place, so `src/sdk.ts` keeps its one line per leg.
//
// WHAT THIS MODULE IS NOT: a translation layer. Nothing here re-shapes a message, renames an option,
// or invents a value. It COMPOSES what four lanes already built — Lane D's decided selection, Lane A's
// Options template / env allowlist / spool profile / supervised launch, Lane C's one shared session
// store, Lane B's directory row and messaging registry — and hands the result back as the official
// SDK's own `Query`.
//
// THE FIVE THINGS WORTH READING BEFORE THE CODE:
//
//   1. THE LAUNCH IS DEFERRED TO THE FIRST PULL, and that is the vendor's own semantics rather than a
//      wrapper's convenience. The pinned runtime already spawns lazily ("`query()` returns a handle
//      and the child starts when the stream is first pulled" — `official/adapter.ts`'s own header), so
//      a session that is never iterated has never started on either design. What the deferral buys is
//      the one genuinely asynchronous prerequisite this branch has: WS-14 §12's "credentials are
//      fetched AT SPAWN" is a `KeychainSeam.read`, which returns a promise, and `query()` returns a
//      `Query` rather than a promise for one. Doing the read at the first pull is the only ordering in
//      which both sentences stay true.
//   2. THE HANDLE FORWARDS EVERY MEMBER OF THE VENDOR'S `Query`, not a chosen few. `close()` is
//      synchronous (and cancels a launch that has not happened); everything else resolves the launch
//      and calls through, so a member this package has never heard of still works. Two guards make
//      that safe: `then`/`catch`/`finally` are never forwarded (a handle that looked thenable would be
//      swallowed by any `await`), and a `close()` before the first pull means nothing ever spawns.
//   3. THE PROMPT IS THE SESSION'S INPUT STREAM. R-7b-4: "top-level delivery into a LIVE session of
//      either runtime is a push into that session's input stream (both `query()`s accept an
//      async-iterable prompt)". A string prompt has no such stream — the vendor runs one turn and
//      exits — so a string-prompted session is RECORDED in the directory but not ATTACHED as a live
//      receiver, and delivery to it is the honest `unavailable` rather than a push into nothing. An
//      async-iterable prompt is pumped into a stream this module owns, and `push()` writes into the
//      same stream, in order, with the caller's own backpressure preserved.
//   4. CREDENTIALS COME FROM `Options.provider`, which the host already fills for the Winter leg.
//      `ProviderSelection.authRef` + `.connection` is the pinned contract's own credential surface, so
//      the official leg reads the same field rather than growing a second one. Only the families whose
//      variable mapping is unambiguous are derived here; a cloud chain or a `custom` family names its
//      own variables, because only the host knows them.
//   5. NOTHING HERE CACHES A CREDENTIAL. `fetchAuthCredentials` returns material to one caller, this
//      module puts it in the child environment, and the object is dropped when the launch returns.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { BrandProfile, CredentialRef, Options, ProviderSelection, Query } from "@yanlinglabs/winter-agent-sdk";
import { buildChildAddress, buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";

import { RuntimeHandoffRequiredError, RuntimeLaunchInputError } from "./errors.ts";
import type { GlobalMessagingHandle } from "./messaging/router.ts";
import { transcriptSourceForSessionKey, type ReviewerResolver, type TranscriptEntry, type TranscriptSource, type WinterToolCaller } from "@yanlinglabs/winter-agent-sdk/tools";
import type { ContainmentPolicy } from "./official/containment.ts";
import { officialBranchLabel } from "./official/branding.ts";
import { createApprovalBridge, type OfficialApprovalBridge, type OfficialPermissionMode } from "./official/callbacks.ts";
import { buildOfficialChildEnv, type OfficialEnvPolicy } from "./official/env-allowlist.ts";
import { fetchAuthCredentials, authVariableSetKey, type AuthCredentialPlan } from "./official/auth.ts";
import { assertPermissionModeAllowed, buildOfficialOptions, RUN_HOME_ABSENT_SEGMENT, type OptionsTemplatePolicy } from "./official/options-template.ts";
import { capabilityNameCollisionError, officialMcpServers, winterMcpServerDescriptor, type InputShapeFactory, type OfficialMcpModule, type WinterMcpServerDescriptor } from "./official/mcp-descriptors.ts";
import { officialSpoolRoot } from "./official/spool.ts";
import type { RuntimeDirectory } from "./seams/directory.ts";
import type { RuntimeDirectoryEntry } from "./seams/directory-store.ts";
import type { RuntimeAddress } from "./seams/messaging-contract.ts";
import type { OfficialAdapter, OfficialLaunchPlan, OfficialLaunchProfile, OfficialSession, RemoteConfigPolicy } from "./seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialUserMessage } from "./seams/official-sdk-shapes.ts";
import type { RuntimeKind, RuntimeSelection } from "./selection/runtime-selection.ts";
import { claudeReadyStore } from "./official/claude-ready-store.ts";
import type { ContinuityEndpoint } from "@yanlinglabs/winter-provider-runtime";
import type { MessageOrigin } from "@yanlinglabs/winter-provider-runtime";
import { defaultEndpointResolver } from "./default-endpoint-resolver.ts";
import { hasConversationalEntry, readProviderStateSidecar } from "./store/materialized-resume.ts";
import type { SharedSessionStore } from "./store/wiring.ts";
import { resumeStagingRoot } from "./vendor-paths.ts";
import { protectedPathRules, runHomeBrandOf, type RunHome, type RunHomeOutcome } from "./run-home/types.ts";
import { runHomeExitReconciler } from "./run-home/exit.ts";
import { RunHomeError } from "./run-home/errors.ts";
import { runHomeAutoMemoryEnabled } from "./run-home/apply.ts";
import type { OfficialRunHomeBinding } from "./seams/official-adapter.ts";

/**
 * What the door returns.
 *
 * A UNION, BECAUSE THE TWO LEGS RETURN THEIR OWN RUNTIME'S HANDLE AND NEITHER IS THE OTHER. The Winter
 * `Query` carries `messaging` and `listModelFamilies`, which the pinned official `Query` does not have
 * and this package will not fake; the official one carries a dozen members the router deliberately
 * does not name (it never imports the vendor's types onto its published surface — see
 * `seams/official-sdk-shapes.ts`). Collapsing them into one type would mean either a wrapper that
 * translates — the one thing D19b says this package must not be — or a declared type that lies.
 *
 * A HOST PAYS NOTHING FOR THIS UNLESS IT ASKS FOR IT: `query()` is overloaded so that a call with no
 * runtime input is typed `Query`, which is sound because the official leg is reachable ONLY through a
 * runtime input. A host that passes one knows which runtime it selected and narrows accordingly.
 */
export type RouterQuery = Query | OfficialQuery;

/** True for a handle THIS package opened on the official leg. Registry-based: nothing is sniffed. */
export function isOfficialQuery(value: RouterQuery): value is OfficialQuery {
  return OFFICIAL_HANDLES.has(value as object);
}

const OFFICIAL_HANDLES = new WeakSet<object>();

/**
 * The official leg's host-owned inputs, carried on `RouterOptions.runtime.official`.
 *
 * EVERY FIELD IS SOMETHING ONLY THE HOST KNOWS. The router will not guess a session id (the directory
 * row's identity), invent an auto-memory directory (WS-14 §2's ONE shared directory is a host-wide
 * decision), or resolve a vendored runtime path (§5.1: "never the user's installed binary" is only
 * enforceable if the host names the copy it vendored).
 */
export interface RouterOfficialInput {
  /**
   * This session's Winter session id. Its directory address is `session:<id>`.
   *
   * REQUIRED, and it is the one field with no plausible default: §6 rule 2's durable record is written
   * onto this address, the messaging registry attaches under it, and a listed object that no model can
   * send to is worse than no listing at all (`UnaddressableEntryError`'s own note).
   */
  sessionId: string;
  /**
   * R-7b-1: this session is a CHILD of `parentSessionId`, on its own runtime.
   *
   * "A child runs on the runtime its OWN slot's family selects at spawn time, independent of the
   * parent's runtime" — so a `claude`-family child of a Winter parent is not a native subagent inside
   * another official process, it is an official session in its own right, addressed as
   * `agent:<parent>:<sessionId>` with `transport: "claude-handle"`. That transport is the field WS-15
   * §6.1 uses to tell the two apart, and Lane B's official adapter branches on it: a `claude-handle`
   * child is delivered to DIRECTLY, a `claude-child` only through its owning parent.
   *
   * Absent = a top-level session, addressed `session:<sessionId>`.
   */
  parentSessionId?: string;
  /**
   * Secret variables for families whose mapping this module cannot derive — a cloud credential chain,
   * or a `custom` family, whose set is open by design (WS-14 §12).
   *
   * Each entry is a NAME and a REF, never material: the read happens at spawn, through the host's own
   * `KeychainSeam`, and nothing here holds the answer.
   */
  credentials?: readonly AuthCredentialPlan[];
  /**
   * NON-SECRET family variables: a gateway's `ANTHROPIC_BASE_URL`, a region, a project, or (router
   * 0.0.4, C1) a `console-profile` session's `ANTHROPIC_PROFILE` name and `ANTHROPIC_CONFIG_DIR` path.
   *
   * Separate from `credentials` because they are not secrets and must not travel through a keychain
   * read — and because §12's gateway caveat ("set the full credential pair or neither") is checked
   * across both halves by the auth validator, whichever side each variable came from. The same shape
   * applies to `console-profile`'s pairing rule: set both names here or neither.
   */
  connectionEnv?: Readonly<Record<string, string>>;
  /** §3's minimal OS set. Build it with `minimalOsEnvironmentFrom(process.env)` at the host's call site. */
  base?: Readonly<Record<string, string>>;
  /** §2's ONE shared auto-memory directory, identical for both branches. */
  autoMemoryDirectory?: string;
  /** §3's `CLAUDE_CODE_PROJECT_DIR_NAME` — Winter's stable transcript key. Defaults to `sessionId`. */
  projectKey?: string;
  /** §3's `CLAUDE_CODE_TMPDIR` — the shared per-user temp root the host derives from the brand. */
  sharedTempRoot?: string;
  /**
   * §11's servers, already materialized by the host (`officialMcpServers`) — THE ESCAPE HATCH, AND
   * EXACTLY HOW FAR IT REACHES (review r1).
   *
   * Since R-8 the router materializes the standing server and the constructor's capability servers
   * itself (`RuntimeSdkOptions.capabilities` + `toInputShape`), so most hosts never fill this in.
   *
   *   * THE STANDING-SERVER KEY (`brand.mcpServerName`): THE HOST WINS. A host that built its own
   *     standing server means that server, and the router replacing it would be the translation layer
   *     this package is not — the same precedence `remoteConfig` (`:148-149`) and `options` (`:153`)
   *     have. It is also a key the OTHER leg never receives from the router, so one branch overriding
   *     it diverges from nothing.
   *   * A FORWARDED CAPABILITY'S NAME: REFUSED, with the same `RuntimeLaunchInputError` the Winter leg
   *     raises for the identical collision, before any runtime is launched. `capabilities` are
   *     forwarded to BOTH legs, so a per-key override here would leave this branch running the host's
   *     server and the Winter branch running the daemon's under one name — two different tools, one
   *     canonical name, no error anywhere.
   */
  mcpServers?: Readonly<Record<string, unknown>>;
  /** §1 profile 2's staging root. Defaults to the vendor's own `<tmpdir>/claude-resume-<resume id>`. */
  stagingRoot?: string;
  /** §1 profile 1's spool. Defaults to `<winter home>/runtimes/official-agent-spool`. */
  spool?: string;
  /**
   * §5: `"eager"` mirroring for a session that advertises cross-runtime handoff. DEFAULT TRUE here,
   * because a session the ROUTER created is one `sdk.handoff()` can be called on by construction.
   */
  advertisesHandoff?: boolean;
  /** R-7b-11: `"allow"` lets this session's child fetch the runtime's remote feature configuration. */
  remoteConfig?: RemoteConfigPolicy;
  /** The display name this session answers to in `ListAgents`. */
  displayName?: string;
  /** Extra template policy the host has already checked against the runtime's own schema. */
  options?: Omit<OptionsTemplatePolicy, "env" | "mcpServers" | "resume" | "forkSession" | "sessionId">;
}

/**
 * The official branch's deployment-wide policy, as a host sets it on `createRuntimeSdk`.
 *
 * A SUBSET OF `OfficialAdapterPolicy`, DECLARED HERE RATHER THAN REFERENCED, and the reason is the
 * published-declaration rule this package already lives by (`seams/official-sdk-shapes.ts`'s header):
 * naming `OfficialAdapterPolicy` on an exported member pulls `official/adapter.d.ts` — and with it
 * `spawn-proxy.d.ts`, whose child-process shape is written in Node's own types — into the declaration
 * graph a CONSUMER type-checks, and a consumer without `@types/node` then fails to compile this
 * package. The installed-tarball smoke is the gate that says so.
 *
 * WHAT IS LEFT OUT IS THE SUPERVISED-SPAWN INJECTION POINTS (`sink`, `reconcile`, `verifyCleanup`,
 * `spawnChild`), and leaving them out is right on its own terms: the router DEFAULTS the record sink
 * to the directory row addressed by the launch, which is the answer §6 rule 2 wants, and a host that
 * genuinely needs to replace the spawn machinery builds its own adapter and reaches it through
 * `runtimeSdkInternals`.
 */
export interface RouterOfficialPolicy {
  /** §3's child-environment policy: declared extras, host prefixes, the two reviewed hatches, `remoteConfig`. */
  env?: OfficialEnvPolicy;
  /** §8's dispositions, threaded into the floor every launch installs. */
  containment?: ContainmentPolicy;
  /** The permission mode the bridge is built with when a query supplies no broker. */
  permissionMode?: OfficialPermissionMode;
  /** §2's template policy every official session in this deployment starts from. */
  options?: OptionsTemplatePolicy;
}

/**
 * The canonical address this leg's session is recorded under — `session:<id>`, or R-7b-1's
 * `agent:<parent>:<id>` for a cross-runtime child.
 *
 * EXPORTED because the door is not the only party that needs it: `query()`'s in-process ledger is
 * keyed by ADDRESS rather than by the bare session id (review r1, L-3), since a top-level Winter
 * session `x` and a claude child `x` of some parent are different objects that would otherwise share
 * one slot and refuse each other as `handoff-required`.
 */
export function officialLegAddress(input: Pick<RouterOfficialInput, "sessionId" | "parentSessionId">): string {
  return serializeRuntimeAddress(input.parentSessionId === undefined ? buildSessionAddress(input.sessionId) : buildChildAddress(input.parentSessionId, input.sessionId));
}

/** The same key for a session named on either leg — the Winter leg has no parent to name. */
export function sessionLedgerKey(sessionId: string): string {
  return serializeRuntimeAddress(buildSessionAddress(sessionId));
}

/** The collaborators the leg composes. Built once by `createRuntimeSdk`; not part of any public shape. */
export interface OfficialLegDeps {
  brand: BrandProfile;
  official: OfficialAdapter;
  directory: RuntimeDirectory;
  messaging: GlobalMessagingHandle;
  keychain: { read(ref: CredentialRef): Promise<string | undefined> };
  /** Lane C's ONE shared store, resolved on first use (the identity also carries the winter home). */
  shared: () => SharedSessionStore;
  /**
   * R-7b-13: the Winter SDK's OWN transcript project key for a working directory.
   *
   * INJECTED FROM THE PEER, NEVER RE-DERIVED. WS-14 §3 calls `CLAUDE_CODE_PROJECT_DIR_NAME` "Winter's
   * stable transcript key" and §2 wants ONE shared auto-memory directory "identical for both
   * branches" — which is only true if the official leg writes under the key the WINTER leg writes
   * under. The SDK exports `transcriptProjectKey(cwd)`; re-implementing its sanitizer here would give
   * two branches two keys for one cwd the first time either changed.
   */
  transcriptProjectKey: (cwd: string) => string;
  /** WS-14 §5.1's vendored runtime, from the constructor. A per-query `Options` value wins over it. */
  vendoredOfficialRuntime?: string;
  /**
   * The daemon's capability servers, as DESCRIPTORS (R-8 / R-8-1).
   *
   * DESCRIPTORS RATHER THAN THE WINTER INSTANCES, because this branch does not consume a server — it
   * REGISTERS one, through its own runtime's in-process constructor. `createRuntimeSdk` reads the
   * host's declaration once (`capabilityServerDescriptors`) and the leg materializes it per session,
   * beside the standing server it builds from `messaging`.
   *
   * PER SERVER, UNDER ITS OWN NAME, so `mcp__<server>__<tool>` is the same canonical name on both legs
   * — which is the whole of WS-14 §11's "registered identically into BOTH branches".
   */
  capabilities?: readonly WinterMcpServerDescriptor[];
  /**
   * The host's JSON-Schema → validator-shape bridge (`RuntimeSdkOptions.toInputShape`).
   *
   * IT IS WHAT SWITCHES THE ROUTER-BUILT SERVERS ON. With it, this leg registers the standing server
   * (the messaging tools) and every capability server itself, and a host stops hand-materializing.
   * Without it and WITH capabilities configured, the leg REFUSES: a session whose capability tools
   * exist on the Winter branch and silently not on this one is the divergence §11 exists to prevent.
   */
  toInputShape?: InputShapeFactory;
  /**
   * The injected official peer, duck-typed to §11's surface (`createSdkMcpServer`/`tool`).
   *
   * THE SAME OBJECT `peers.claude` ALREADY IS — the seam declares only `query`, because that is all
   * the launch path needs, and this is the one other member of it this package uses. A module without
   * the constructor is `OfficialMcpError`, thrown where the server would have been built.
   */
  mcpModule?: OfficialMcpModule;
  /**
   * What the host supplies for the STANDING ADVISOR — the reviewer, never the tool (interim review I-5).
   *
   * The advisor is registered on this branch whether or not a host fills this in, because the Winter
   * runtime always advertises `advisor` and two legs whose advertised sets differ by a host option is
   * exactly the divergence WS-14 §11 forbids. What this supplies is the REVIEWER: absent, the default
   * resolver answers `undefined`, which is WS-06 §4's ordinary tool error ("no reviewer configured"),
   * not a throw and not a missing tool.
   */
  advisor?: { resolveReviewer?: ReviewerResolver; maxChars?: number };
  /** The adapter's own policy, so a host's `env`/`containment` choices reach the door's own builders. */
  policy?: RouterOfficialPolicy;
  /**
   * WS-18 W18-14/W18-20 (P10b): turns a stamped `MessageOrigin` into full endpoint facts — normally
   * `createEndpointResolver(registry)` over the host's own (credentialed, live-discovery-aware)
   * catalog registry. Absent means `defaultEndpointResolver()` (`default-endpoint-resolver.ts`, fix
   * round 1 CRITICAL) — a registry built from the COMPILED catalog alone, no credentials, no network:
   * the bare `endpointFromOrigin` fallback reports `readableState: "none"` for every model, which is
   * a false "no reasoning to lose" for a family the catalog actually documents.
   */
  resolveEndpoint?: (origin: MessageOrigin) => ContinuityEndpoint;
  /**
   * "A leg opened on this runtime" — the door's in-process ledger, told only when it is true
   * (review r1, I-1).
   *
   * CALLED AFTER THE LAUNCH RETURNS, never before. `query()` used to write the ledger the moment it
   * DECIDED, which poisoned it on every path that then refused: a claude-agent selection with no
   * `runtime.official` threw, and the session's own correct Winter runtime was refused ever after with
   * `from=claude-agent`. Worse on the restart path — the durable row says `winter-agent`, the official
   * leg is correctly refused by the row, and the honest follow-up (a Winter query) was then refused by
   * a ledger that contradicted the row the door had just read. The session was wedged on both legs and
   * `sdk.handoff()` could not move it, because it had never been where the ledger claimed.
   *
   * It is also called with the ROW's runtime when the durable check refuses, so the ledger learns the
   * truth it just read rather than keeping a guess.
   */
  onOpened?: (runtimeKind: RuntimeKind) => void;
  /**
   * WS-21 §3.8: where this handle's `runHomeOutcome` reads from. The leg records `pending` at launch,
   * then `safe`/`quarantined` from the generation's exit reconcile — or `safe` for a generation that
   * ended without a child ever having been spawned (nothing was written, nothing can be lost).
   */
  recordRunHomeOutcome?: (runId: string, outcome: RunHomeOutcome) => void;
}

// --------------------------------------------------------------------------------------------------
// The input stream: R-7b-4's "push into that session's input stream", as one small object.
// --------------------------------------------------------------------------------------------------

/** A turn stream with backpressure: `push` resolves when the consumer has taken the turn. */
export interface OfficialInputStream extends AsyncIterable<string> {
  push(text: string): Promise<void>;
  close(): void;
  readonly closed: boolean;
}

/**
 * A single-slot handoff between producers and the runtime.
 *
 * BACKPRESSURE IS THE POINT, not a refinement. The alternative — an unbounded queue drained eagerly
 * from the caller's own iterable — would buffer a whole conversation in memory and, worse, would drain
 * a caller's generator at a rate the runtime never asked for, so a host streaming from a UI would see
 * its turns consumed before the model was ready for them. Here nothing moves until the runtime pulls.
 *
 * A PUSH AFTER `close()` IS A TYPED REJECTION rather than a silent drop: the messaging adapter turns a
 * throw into `delivery_uncertain`, and "the session's input ended" is at least an answer the sender's
 * ledger can record.
 */
/**
 * WS-21 §7.3 (d): `/loop` IS NOT A WINTER SURFACE. The pinned runtime's `/loop` reads the repository's
 * own `.claude/loop.md` whatever the setting sources are (F19d), so the official prompt path refuses the
 * command — TYPED (`loop_refused`), never by dropping the turn in silence.
 */
export function isLoopCommand(text: string): boolean {
  return /^\s*\/loop(?:\s|$)/.test(text);
}

function loopRefused(): RunHomeError {
  return new RunHomeError("loop_refused", "`/loop` is not available on the official leg: the runtime would read the repository's own `.claude/loop.md`, which this branch never reads (WS-21 §7.3)");
}

export function createOfficialInputStream(): OfficialInputStream {
  const waiting: Array<(result: IteratorResult<string>) => void> = [];
  const pending: Array<{ text: string; taken: () => void }> = [];
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    push(text) {
      if (closed) return Promise.reject(new RuntimeLaunchInputError({ field: "push", reason: "this session's input stream has ended, so there is nothing to push into" }));
      // Refused BEFORE it is queued: the session goes on, and the host renders the typed refusal.
      if (isLoopCommand(text)) return Promise.reject(loopRefused());
      const consumer = waiting.shift();
      if (consumer !== undefined) {
        consumer({ value: text, done: false });
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => pending.push({ text, taken: resolve }));
    },
    close() {
      closed = true;
      for (const consumer of waiting.splice(0)) consumer({ value: undefined, done: true } as IteratorResult<string>);
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          // PENDING BEFORE CLOSED, always: a close that raced a push must not swallow the push.
          const item = pending.shift();
          if (item !== undefined) {
            item.taken();
            return Promise.resolve({ value: item.text, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true } as IteratorResult<string>);
          return new Promise((resolve) => waiting.push(resolve));
        },
      };
    },
  };
}

/**
 * One turn, in the shape the official runtime's streaming input takes.
 *
 * The vendor's `SDKUserMessage` is `{ type: "user"; message: MessageParam; parent_tool_use_id }` — a
 * public Messages-API user message plus two envelope fields. `parent_tool_use_id: null` says this turn
 * belongs to the session itself rather than to a tool call, which is what a top-level push is.
 */
export function officialUserTurn(text: string, sessionId: string): OfficialUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: sessionId };
}

// --------------------------------------------------------------------------------------------------
// Credentials: WS-14 §12, from the contract's own `Options.provider`.
// --------------------------------------------------------------------------------------------------

/**
 * Which variable each of this session's credentials fills, and where it lives.
 *
 * DERIVED ONLY WHERE THE MAPPING IS UNAMBIGUOUS. `api-key` is one variable; `console-oauth` is a
 * bearer token whose endpoint is non-secret and travels in `connectionEnv` (§12's "gateway configs
 * MUST set the full credential pair" is then checked by the auth validator, across both halves). The
 * three families that inject nothing (`claude-oauth`, `local-none`, and router 0.0.4's
 * `console-profile` — its `ANTHROPIC_PROFILE`/`ANTHROPIC_CONFIG_DIR` pair are non-secret and travel in
 * `connectionEnv` exactly like `console-oauth`'s base URL, never through a keychain-backed plan)
 * inject nothing. A cloud credential chain and a `custom` family name their own variables, because
 * their sets are the host's: a chain's variables depend on which of Bedrock's or Vertex's several auth
 * modes the deployment uses, and `custom` is open by definition.
 */
export function officialCredentialPlan(args: {
  selection: RuntimeSelection;
  provider: ProviderSelection | undefined;
  explicit: readonly AuthCredentialPlan[] | undefined;
}): readonly AuthCredentialPlan[] {
  const family = authVariableSetKey(args.selection);
  // router 0.0.4, C1: NEVER derived from `provider.authRef`, even when it resolves to material, and
  // never from an `explicit` plan either — the profile store at `ANTHROPIC_CONFIG_DIR` already owns
  // the token, so a plan entry here would mean fetching a keychain secret this family has no use for.
  // (The pair itself is non-secret and travels through `connectionEnv`, checked just below.)
  if (family === "console-profile") return [];
  if (args.explicit !== undefined) return args.explicit;
  if (family === "claude-oauth" || family === "local-none") return [];
  const ref = args.provider?.authRef;
  if (family === "bedrock" || family === "vertex" || family === "custom") {
    throw new RuntimeLaunchInputError({
      field: "runtime.official.credentials",
      reason: `the ${args.selection.authFamily} family's variable set is the host's (a cloud chain's variables depend on which auth mode the deployment uses, and \`custom\` is open by design), so the door will not guess it — name each variable and its credential ref`,
    });
  }
  if (ref === undefined || ref.kind === "none") {
    throw new RuntimeLaunchInputError({
      field: "options.provider.authRef",
      reason: `this session's ${args.selection.authFamily} family needs one credential and the pinned contract's own credential surface carries none; launching without it falls through the runtime's precedence order to whatever the spool holds (WS-14 §12)`,
    });
  }
  return family === "console-oauth" ? [{ variable: "ANTHROPIC_AUTH_TOKEN", ref }] : [{ variable: "ANTHROPIC_API_KEY", ref }];
}

/**
 * Non-secret connection variables a family sets, from the contract's own `ProviderConnectionConfig`
 * plus whatever the host names in `RouterOfficialInput.connectionEnv`.
 *
 * ROUTER 0.0.4, C1: `console-profile`'s `ANTHROPIC_PROFILE` and `ANTHROPIC_CONFIG_DIR` have no
 * counterpart on `ProviderConnectionConfig` (that shape carries only `baseUrl`, a pinned contract type
 * this package does not extend) and are non-secret by the same reasoning `ANTHROPIC_BASE_URL` is, so a
 * host sets them the identical way — `connectionEnv: { ANTHROPIC_PROFILE, ANTHROPIC_CONFIG_DIR }` —
 * and they ride through `explicit` here unchanged, exactly like any other family's non-secret pair.
 * No family-specific derivation is needed for them the way `console-oauth`'s base URL gets one below,
 * because the host already has both values in hand (a profile name, a directory it manages) and there
 * is no `ProviderSelection` field to read them from instead.
 */
export function officialConnectionEnv(args: { selection: RuntimeSelection; provider: ProviderSelection | undefined; explicit: Readonly<Record<string, string>> | undefined }): Record<string, string> {
  const explicit = { ...(args.explicit ?? {}) };
  // §12's gateway caveat, from the field the host already fills: a bearer family's endpoint is part of
  // its set, so the pair is complete or the validator refuses it.
  const baseUrl = args.provider?.connection?.baseUrl;
  if (authVariableSetKey(args.selection) === "console-oauth" && baseUrl !== undefined && explicit["ANTHROPIC_BASE_URL"] === undefined) explicit["ANTHROPIC_BASE_URL"] = baseUrl;
  return explicit;
}

// --------------------------------------------------------------------------------------------------
// The leg.
// --------------------------------------------------------------------------------------------------

export interface OfficialLegRequest {
  prompt: string | AsyncIterable<string>;
  options: Options;
  input: RouterOfficialInput;
  selection: RuntimeSelection;
  /**
   * WS-21: the run home this generation runs on, already checked by the door's caller
   * (`assertRunHomeApplicable`). Absent = the pre-WS-21 profile (the spool, no setting source).
   */
  runHome?: RunHome;
}

/** The official leg's view of a run home: what the template, the launch and the proxy need. */
export function officialRunHomeBinding(runHome: RunHome): OfficialRunHomeBinding {
  return {
    runId: runHome.runId,
    dir: runHome.dir,
    sdkHome: runHome.sdkHome,
    home: runHome.input.home,
    trustedProjectRoot: runHome.input.trustedProjectRoot,
    memoryDir: runHome.input.memoryDir,
    autoMemoryEnabled: runHomeAutoMemoryEnabled(runHome),
    ...(isPlainRecord(runHome.effectiveSettings["skillOverrides"]) ? { skillOverrides: runHome.effectiveSettings["skillOverrides"] } : {}),
    protectedAsk: protectedAskRulesFor(runHome),
  };
}

/** Spec §7.2's ask rules for the given and the real spelling of the shared home and the trusted root. */
function protectedAskRulesFor(runHome: RunHome): string[] {
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const brand = runHomeBrandOf(runHome.input);
  const root = runHome.input.trustedProjectRoot;
  const rules = [...protectedPathRules(runHome.sdkHome, root, brand), ...protectedPathRules(real(runHome.sdkHome), root === null ? null : real(root), brand)];
  return [...new Set(rules)];
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * §11's `mcpServers` for this session, built by the ROUTER rather than by the host (R-8 / R-8-1).
 *
 * ONE STANDING SERVER PLUS ONE PER CAPABILITY SERVER. The standing server carries the messaging tools
 * §7's aliases resolve to, bound to THIS session's caller identity — which is why it is built per leg
 * rather than once at construction. Each capability server is registered under its own name, so the
 * canonical name a model sees is the same on both legs.
 *
 * THE BRIDGE IS THE SWITCH, and its absence with capabilities configured is a typed refusal (see
 * `OfficialLegDeps.toInputShape`). With neither, this returns `undefined` and the leg behaves exactly
 * as it did before R-8: `RouterOfficialInput.mcpServers` is the only route, and a host that was
 * hand-materializing keeps working unchanged.
 */
function officialCapabilityServers(
  deps: OfficialLegDeps,
  args: { caller: WinterToolCaller; transcriptSource: TranscriptSource; branchLabel: string; hostOwned: Readonly<Record<string, unknown>> | undefined },
): Record<string, unknown> | undefined {
  if (deps.toInputShape === undefined) {
    if (deps.capabilities === undefined) return undefined;
    throw new RuntimeLaunchInputError({
      leg: "official",
      field: "toInputShape",
      reason:
        "this handle was constructed with `capabilities` but no JSON-Schema → validator-shape bridge, and the official runtime registers in-process servers only through its own validator's shape — so those tools would exist on the Winter leg and silently not on this one (WS-14 §11)",
    });
  }
  // THE ESCAPE HATCH REACHES THE STANDING SERVER AND STOPS THERE (review r1). Checked before the
  // module, the handlers and the registration, because it is a statement about the host's own input.
  for (const name of Object.keys(args.hostOwned ?? {})) {
    if ((deps.capabilities ?? []).some((descriptor) => descriptor.name === name)) throw capabilityNameCollisionError({ field: "runtime.official.mcpServers", name });
  }
  const toInputShape = deps.toInputShape;
  const module = deps.mcpModule;
  if (module === undefined) {
    throw new RuntimeLaunchInputError({
      leg: "official",
      field: "peers.claude",
      reason: "the official leg cannot register the standing server without the official SDK module the servers are registered into",
    });
  }
  // THE PORT IS THE ROUTER'S OWN HANDLE, PASSED STRAIGHT IN (ruling P-3). `GlobalMessagingHandle`
  // satisfies the SDK's `MessagingToolPort` structurally, so there is no adapter here to drift.
  const standing = winterMcpServerDescriptor({
    brand: deps.brand,
    port: deps.messaging,
    caller: args.caller,
    advisor: { transcriptSource: args.transcriptSource, ...(deps.advisor?.resolveReviewer === undefined ? {} : { resolveReviewer: deps.advisor.resolveReviewer }), ...(deps.advisor?.maxChars === undefined ? {} : { maxChars: deps.advisor.maxChars }) },
  });
  const servers: Record<string, unknown> = {};
  for (const descriptor of [standing, ...(deps.capabilities ?? [])]) {
    Object.assign(servers, officialMcpServers({ descriptor, module, toInputShape, branchLabel: args.branchLabel }));
  }
  return servers;
}

/**
 * Opens the official leg, synchronously, returning the vendor's `Query` through a handle that defers
 * the launch to the first pull (see this module's header, note 1).
 */
export function openOfficialLeg(deps: OfficialLegDeps, request: OfficialLegRequest): OfficialQuery {
  const branchLabel = officialBranchLabel(deps.brand);
  // WS-21 §7.3 (d): a one-shot `/loop` prompt is refused synchronously, before anything exists. A
  // streamed one is refused by the input stream's `push` (see `createOfficialInputStream`).
  if (typeof request.prompt === "string" && isLoopCommand(request.prompt)) throw loopRefused();
  // BEFORE ANYTHING ELSE HAPPENS. This is an input refusal, and an input refusal that arrived after a
  // directory row, a credential read or a child process would be a refusal the host pays for.
  // THE CALLER IS THE ADDRESS THE ROW WAS RECORDED UNDER (interim review C-1). A door-opened CHILD is
  // `agent:<parent>:<child>`, and binding its messaging tools to the bare `session:<child>` made three
  // things wrong at once: `sendDetailed` resolved in the WRONG conversation (the caller's owning
  // session became the child rather than its parent), `senderPermissionClass` found no row and fell to
  // `"unknown"` so WS-10 §13's class floor judged a phantom sender, and the delivered
  // `<agent-message from="session:<child>">` named an address every reply answers `not_found` for.
  // `callerAddress` over this pair yields exactly `officialLegAddress`'s address.
  // THE SESSION'S ADDRESS, HOISTED ABOVE THE CLOSURES THAT READ IT (RD review r1). The lazy transcript
  // source below reads the directory row by this address; declaring it after that closure was correct
  // at run time (the read happens per call) and misleading to read.
  const address = officialLegAddress(request.input);

  /**
   * THE ADVISOR'S TRANSCRIPT, READ LAZILY — because its key is not knowable yet (interim review I-1).
   *
   * `transcriptSourceForSessionKey` takes a `SessionKey` up front, and this session's key is
   * `{ projectKey, sessionId: backendSessionId }` where the BACKEND id is allocated by the vendor and
   * arrives with the first `system/init` frame — after this function runs, and after the standing
   * server carrying the advisor has already been registered. A source built here with whatever id
   * existed at open time would read the wrong transcript, or none, for the whole session.
   *
   * So the source is the interface's one method and nothing else: every call re-reads the session's
   * own directory row for the id the runtime reported, then delegates to the SDK's reader over the ONE
   * shared store. Before the first init frame it answers `[]` — an advisor called in the first
   * milliseconds of a session has nothing to review, which is the honest answer rather than a throw.
   *
   * MIRROR LAG IS REAL AND ACCEPTED: the official branch's entries land in the shared store in ~100 ms
   * batches, so the advisor sees the transcript up to the last landed batch.
   */
  const advisorTranscriptSource = (): TranscriptSource => ({
    async getEntries(): Promise<TranscriptEntry[]> {
      const cwd = request.options.cwd;
      const projectKey = request.input.projectKey ?? (cwd === undefined || cwd.length === 0 ? undefined : deps.transcriptProjectKey(cwd));
      if (projectKey === undefined) return [];
      const row = await deps.directory.get(address);
      const sessionId = row?.backendSessionId ?? request.options.sessionId;
      if (sessionId === undefined || sessionId.length === 0) return [];
      return transcriptSourceForSessionKey({ projectKey, sessionId }, { store: deps.shared().store }).getEntries();
    },
  });

  const messagingCaller: WinterToolCaller = request.input.parentSessionId === undefined ? { sessionId: request.input.sessionId } : { sessionId: request.input.parentSessionId, agentId: request.input.sessionId };
  const routerBuiltMcpServers = officialCapabilityServers(deps, { caller: messagingCaller, transcriptSource: advisorTranscriptSource(), branchLabel, hostOwned: request.input.mcpServers });
  const parsed = request.input.parentSessionId === undefined ? buildSessionAddress(request.input.sessionId) : buildChildAddress(request.input.parentSessionId, request.input.sessionId);
  // OWNED ONLY WHEN THE CALLER GAVE US A STREAM TO OWN (header note 3).
  const stream = typeof request.prompt === "string" ? undefined : createOfficialInputStream();
  let detach: (() => void) | undefined;
  /** The launched generation, once `launch()`/`resume()` returned it (WS-21: its proxy knows whether a child ever spawned). */
  let launched: OfficialSession | undefined;
  let sawInit = false;
  let live = false;
  let ended = false;
  /**
   * THE SESSION'S PERMISSION MODE, LIVE (0.0.10).
   *
   * `request.options.permissionMode` is the mode this session is SPAWNED with, and before this it was
   * also the only mode it could ever have: the child's own `Options.permissionMode` is fixed for the
   * generation, and the approval bridge below captured the same literal once. `Query.setPermissionMode`
   * changes the first; this variable is what changes the second, and the two move together — it is
   * assigned only AFTER the child has accepted the control request (`deferredOfficialQuery`'s `adopt`),
   * so a refused switch leaves the bridge describing the mode the child is actually in.
   *
   * WHY THE BRIDGE CARES AT ALL: `createApprovalBridge`'s step 2 short-circuits `dontAsk` to allow
   * WITHOUT consulting the host's broker. A session spawned `dontAsk` and switched live to `default`
   * starts receiving `canUseTool` requests from the child — and a bridge frozen at `dontAsk` would
   * auto-approve every one of them, which is the exact hole this whole change exists to close, one
   * layer further in.
   */
  let currentMode: OfficialPermissionMode = (request.options.permissionMode ?? "default") as OfficialPermissionMode;

  /**
   * THE SESSION'S END, RECORDED (review r1, I-3).
   *
   * The door recorded a session's BIRTH and never its end, and three things followed from the one gap:
   * the row stayed `running` for ever, so `listReachable` enumerated a finished session — which WS-10
   * §10.2 forbids ("does NOT enumerate exited transcripts"); the messaging attachment outlived the
   * stream, so a delivery to a session whose input had ended came back `delivery_uncertain` ("the
   * write may have landed") for a session where nothing could possibly land, and the stale handle
   * blocked the honest `resumeExited`/`unavailable` path behind it; and a launch that threw after the
   * row was written left a phantom row with no session behind it.
   *
   * IDEMPOTENT, because it is reached from three directions — the iterator completing, the iterator
   * throwing, and `close()` — and a session ends once.
   */
  const markEnded = async (status: "exited" | "unavailable"): Promise<void> => {
    if (ended) return;
    ended = true;
    // WS-21 §3.8: a run-home generation whose child was never spawned has no working copy and no exit
    // reconcile will ever run for it — so it is safe, now. One that did spawn is recorded by its
    // reconcile, inside the proxy's gate, before this end was revealed.
    const neverSpawned = launched === undefined || (launched as { supervisor?: { observation?: unknown } }).supervisor?.observation === undefined;
    if (request.runHome !== undefined && neverSpawned) deps.recordRunHomeOutcome?.(request.runHome.runId, "safe");
    live = false;
    detach?.();
    detach = undefined;
    stream?.close();
    const current = await deps.directory.get(address);
    if (current === undefined) return;
    await deps.directory.record({ ...current, status, updatedAt: new Date().toISOString() });
  };

  /**
   * THE BACKEND SESSION ID, THE MOMENT THE RUNTIME REPORTS IT (review r1, I-2).
   *
   * THE VENDOR ALLOCATES IT, NOT US. `system/init.session_id` is the identity the pinned runtime keys
   * its own transcript by and the one WS-15 §6.2 resumes an exited official session BY — so a row
   * without it is a session that cannot be handed off (`HandoffPlanError: … not in the runtime
   * directory`, because `findEntry` has nothing to match) and cannot be cold-resumed
   * (`unavailable: … has no backend session id`, even for a host that wired `resumeExited`). Which
   * made `RuntimeHandoffRequiredError`'s own remedy — "use `sdk.handoff(session, …)`" — name a route
   * that failed for every session this door opened.
   *
   * ONCE, ON THE FIRST `init`, and through `directory.record()` so the merge keeps the two fields the
   * spawn proxy owns (`configDir`, `processIdentity`) rather than replacing the row from a stale copy.
   */
  const noteFrame = async (message: unknown): Promise<void> => {
    if (sawInit) return;
    const frame = message as { type?: unknown; subtype?: unknown; session_id?: unknown };
    if (frame.type !== "system" || frame.subtype !== "init") return;
    sawInit = true;
    const backendSessionId = frame.session_id;
    if (typeof backendSessionId !== "string" || backendSessionId.length === 0) return;
    const current = await deps.directory.get(address);
    if (current === undefined || current.backendSessionId === backendSessionId) return;
    await deps.directory.record({ ...current, backendSessionId, updatedAt: new Date().toISOString() });
  };

  const start = async (): Promise<OfficialQuery> => {
    // D13, AGAINST THE DURABLE RECORD — before a credential is read, before a child exists.
    //
    // The row is the persisted answer to "which runtime wrote this transcript", and it survives the
    // process that wrote it, which is exactly what the door's in-process ledger cannot do. A row that
    // says `winter-agent` means this session's transcript was produced by the other runtime, in the
    // other dialect: continuing it here would be D13's silent rewrite, and it would be irreversible by
    // the time anyone noticed.
    const existing = await deps.directory.get(address);
    if (existing !== undefined && existing.runtimeKind !== "claude-agent") {
      // THE LEDGER LEARNS WHAT THE ROW SAYS (I-1). Without this the next query for this session — on
      // the runtime the row actually names — met a ledger that still held the refused answer.
      deps.onOpened?.(existing.runtimeKind);
      throw new RuntimeHandoffRequiredError({ from: existing.runtimeKind, to: "claude-agent", address });
    }
    const shared = deps.shared();
    const home = shared.identity.winterHome;
    // WS-21: every CANONICAL path — the provider-state sidecar, the default memory dir — is under the
    // store's own root (`<home>/sdk` on the WS-21 layout); `home` itself is left for the pre-WS-21 spool.
    const storeHome = shared.identity.storeHome ?? home;
    const runHome = request.runHome;
    const runHomeBinding = runHome === undefined ? undefined : officialRunHomeBinding(runHome);
    if (runHome !== undefined && request.input.stagingRoot !== undefined) {
      throw new RuntimeLaunchInputError({
        leg: "official",
        field: "runtime.official.stagingRoot",
        reason: "a run home replaces the configured staging placeholder: a resume is configured on `<run folder>/.absent`, which is unpredictable and never created, so the wrapper stages nothing but the transcript (WS-21 §3.6)",
      });
    }
    if (runHome !== undefined && request.input.spool !== undefined) {
      throw new RuntimeLaunchInputError({
        leg: "official",
        field: "runtime.official.spool",
        reason: "a run home replaces the spool: a fresh generation's config dir is its run folder (WS-21 §3.1), so naming a spool as well would describe a directory the child never uses",
      });
    }
    const cwd = request.options.cwd;
    if (cwd === undefined || cwd.length === 0) {
      throw new RuntimeLaunchInputError({ field: "options.cwd", reason: "the official branch's containment floor and its post-hoc sweep are both anchored on this session's working directory (WS-14 §8)" });
    }
    // R-7b-13: the WINTER leg's own key for this cwd, computed HERE (not only at its later use site)
    // because the resume decision below needs it too — both branches must look the canonical store up
    // under the identical key they will write it under.
    const projectKey = request.input.projectKey ?? deps.transcriptProjectKey(cwd);
    // WS-18 W18-8 (P10b-4): THE RESUME-VS-FRESH DECISION LIVES HERE, not with the caller. The caller
    // still just names the backend id this generation should use or continue — `options.resume` is
    // honoured verbatim for a caller that already knows it wants resume semantics, and the common case,
    // `options.sessionId`, is exactly the id a prior generation (a handoff destination, or an official
    // session simply reopened after a restart) would have reported. Either way, this door decides for
    // ITSELF whether that id already has a conversation on disk — never trusting the caller's choice of
    // field name to mean "fresh" or "resume": a caller that has forgotten whether this id was ever used
    // must still land on the correct profile.
    const requestedBackendId = request.options.resume ?? request.options.sessionId;
    const hasConversation =
      requestedBackendId === undefined || requestedBackendId.length === 0
        ? false
        : hasConversationalEntry(await shared.store.load({ projectKey, sessionId: requestedBackendId }));
    const resume = hasConversation ? requestedBackendId : undefined;
    // A FRESH id is `sessionId` only when the caller named one AND the store has nothing for it yet — a
    // request naming NEITHER field still means "let the vendor allocate one", which stays `undefined`.
    const freshSessionId = resume === undefined ? requestedBackendId : undefined;
    const profile: OfficialLaunchProfile = resume === undefined ? "fresh-spool" : "store-backed-resume";
    // WS-21: a fresh generation on a run home runs IN its run folder, and a resume is CONFIGURED on the
    // unpredictable placeholder inside it (§3.6: never created, under the daemon's write-fenced cache,
    // so the wrapper's staging step finds nothing to copy — the predictable `<tmp>/claude-resume-<id>`
    // placeholder this replaces could be planted, F11). The pre-WS-21 profile keeps the spool and that
    // placeholder.
    const configDir =
      resume === undefined
        ? runHome !== undefined
          ? runHome.dir
          : (request.input.spool ?? officialSpoolRoot(home))
        : runHome !== undefined
          ? join(runHome.dir, RUN_HOME_ABSENT_SEGMENT)
          : (request.input.stagingRoot ?? resumeStagingRoot(resume));
    // §3's child env is a REPLACEMENT, and a replacement without `HOME` is not one (review r1's nit).
    // The runtime derives paths from `os.homedir()`, whose OS-level fallback is the user database —
    // invisible to `CLAUDE_CONFIG_DIR` scoping, and on a developer machine it is the real vendor home
    // this branch exists to be isolated from. A refusal is safer than a README sentence.
    if (request.input.base?.["HOME"] === undefined || request.input.base["HOME"].length === 0) {
      throw new RuntimeLaunchInputError({
        field: "runtime.official.base.HOME",
        reason:
          "WS-14 §3's child environment is a REPLACEMENT built from an allowlist, and a child without HOME resolves `os.homedir()` through the OS user database — which `CLAUDE_CONFIG_DIR` cannot scope and which on a developer machine is the vendor home this branch is isolated from. Build it with `minimalOsEnvironmentFrom(process.env)`",
      });
    }
    const executable = request.options.pathToClaudeCodeExecutable ?? deps.vendoredOfficialRuntime;
    if (executable === undefined || executable.length === 0) {
      throw new RuntimeLaunchInputError({
        field: "vendoredOfficialRuntime",
        reason: "WS-14 §5.1 launches the copy the HOST vendored, never the user's installed binary — so the path is named explicitly or the launch does not happen",
      });
    }

    // §12: FETCHED AT SPAWN, HELD BY NOBODY. `credentials` leaves this scope inside the child
    // environment and is referenced nowhere else.
    const credentials = {
      ...(await fetchAuthCredentials({
        plan: officialCredentialPlan({ selection: request.selection, provider: request.options.provider, explicit: request.input.credentials }),
        keychain: deps.keychain,
        branchLabel,
      })),
      ...officialConnectionEnv({ selection: request.selection, provider: request.options.provider, explicit: request.input.connectionEnv }),
    };
    const remoteConfig: RemoteConfigPolicy = request.input.remoteConfig ?? deps.policy?.env?.remoteConfig ?? "deny";
    // `projectKey` was already computed above, for the resume decision — R-7b-13's key is one
    // computation per cwd, not two: both branches write under one project directory and share one
    // auto-memory directory, and the session id (the old default) is a PER-SESSION key, which put
    // every session in a directory of its own and made the `projectKey` half of the `SessionKey` a
    // host must pass to `sdk.handoff()` something nothing documented.
    const env = buildOfficialChildEnv(
      {
        selection: request.selection,
        configDir,
        brand: deps.brand,
        credentials,
        ...(request.input.base === undefined ? {} : { base: request.input.base }),
        projectKey,
        ...(request.input.sharedTempRoot === undefined ? {} : { sharedTempRoot: request.input.sharedTempRoot }),
        ...(runHome === undefined ? {} : { runHome: { sdkHome: runHome.sdkHome } }),
      },
      { ...(deps.policy?.env ?? {}), remoteConfig },
    );

    // WS-14 §10: a host's own broker becomes the BROKER BEHIND our bridge, never the bridge itself —
    // the containment floor decides first, and their answer decides everything the floor allows.
    const hostBroker = request.options.canUseTool;
    const bridge: OfficialApprovalBridge | undefined =
      hostBroker === undefined
        ? undefined
        : createApprovalBridge({
            brand: deps.brand,
            // READ PER DECISION, never captured (see `currentMode`): a live `setPermissionMode` moved it.
            mode: () => currentMode,
            ...(deps.policy?.containment === undefined ? {} : { containment: deps.policy.containment }),
            broker: async (approval) => {
              const answer = await hostBroker(approval.toolName, approval.input, approval as never);
              return answer ?? { behavior: "deny", message: "the host callback returned no decision; this bridge never uses the `null` transport escape (WS-14 §10)", toolUseID: approval.toolUseID };
            },
          });

    const templatePolicy: OptionsTemplatePolicy = {
      // PER-QUERY WINS OVER DEPLOYMENT-WIDE (review r1, L-1), the same precedence `remoteConfig` has
      // and the README documents. The spreads used to be the other way round, so a deployment default
      // silently overrode the value a caller passed for THIS session.
      ...(deps.policy?.options ?? {}),
      ...(request.input.options ?? {}),
      advertisesHandoff: request.input.advertisesHandoff ?? true,
      env,
      // THE ROUTER'S SERVERS FIRST, THE HOST'S OVER THEM (R-8). What is left to override by the time
      // this runs is the STANDING SERVER's key alone — a host key naming a forwarded capability was
      // refused above — so the merge is the escape hatch its declaration documents, not a silent
      // divergence between the two legs. Merged rather than replaced, so a host that hand-built one
      // entry does not lose the capability servers it also configured.
      ...(routerBuiltMcpServers === undefined && request.input.mcpServers === undefined ? {} : { mcpServers: { ...routerBuiltMcpServers, ...request.input.mcpServers } }),
      ...(bridge === undefined ? {} : { canUseTool: bridge }),
      ...(request.options.permissionMode === undefined ? {} : { permissionMode: request.options.permissionMode as OfficialPermissionMode }),
      // W18-8/P10b-4: `freshSessionId`/`resume` are THIS door's own decision (above), never the raw
      // `request.options` fields — the two are never passed together (the pinned runtime refuses that
      // combination), and which one applies is exactly what the canonical-transcript check decided.
      ...(freshSessionId === undefined ? {} : { sessionId: freshSessionId }),
      ...(resume === undefined ? {} : { resume }),
      ...(request.options.forkSession === undefined ? {} : { forkSession: request.options.forkSession }),
      ...(request.options.disallowedTools === undefined ? {} : { additionalDisallowedTools: request.options.disallowedTools }),
      ...(deps.policy?.containment === undefined ? {} : { containment: deps.policy.containment }),
    };
    // WS-18 W18-14 (P10b): the official leg's `sessionStore.load()` returns the CLAUDE-READY copy, not
    // the canonical entries verbatim — appends still land on the real store, byte-identical, and the
    // canonical file is never touched by a load. `target` is what THIS session — the destination —
    // would run this on, from its own decided selection; there is no other endpoint the official leg
    // could ever be loading for.
    const resolveEndpoint = deps.resolveEndpoint ?? defaultEndpointResolver();
    const target = resolveEndpoint({ providerId: request.selection.providerId, modelKey: request.selection.modelRef, family: request.selection.family });
    const claudeReady = claudeReadyStore(shared.store, {
      readSidecar: (key) => readProviderStateSidecar(storeHome, key),
      resolveEndpoint,
      target,
    });
    // WS-21 §3.8: how many transcript entries THIS generation mirrored — the exit reconcile's evidence
    // that "no working copy found" is a loss (unknown → quarantine) rather than a generation that never
    // wrote. Counted at the one door the wrapper's mirror writes through.
    let mirroredEntries = 0;
    const readyStore: typeof claudeReady =
      runHome === undefined
        ? claudeReady
        : {
            ...claudeReady,
            append: (key, entries) => {
              mirroredEntries += entries.length;
              return claudeReady.append(key, entries);
            },
          };
    const officialOptions: OfficialOptions = buildOfficialOptions(
      {
        // D4/D28: the official runtime serves CODE only — every other mode is refused by the selector
        // before a selection with `runtimeKind: "claude-agent"` can exist (`mode-forbids-runtime`), so
        // this is the one reachable value rather than a default that hides a choice.
        mode: "code",
        selection: request.selection,
        cwd,
        sessionStore: readyStore,
        // WS-21 §3.7: the run home pins the memory dir; without one, the host's or the store's default.
        autoMemoryDirectory: runHome?.input.memoryDir ?? request.input.autoMemoryDirectory ?? `${storeHome}/projects/${projectKey}/memory`,
        brand: deps.brand,
        pathToClaudeCodeExecutable: executable,
        spawnProxy: deps.official.spawnProxy,
        profile,
        configDir,
        ...(runHomeBinding === undefined ? {} : { runHome: runHomeBinding }),
      },
      templatePolicy,
    );

    const plan: OfficialLaunchPlan = {
      address,
      selection: request.selection,
      prompt: stream === undefined ? (request.prompt as string) : mapPrompt(stream, request.input.sessionId),
      options: officialOptions,
      profile,
      configDir,
      cwd,
      remoteConfig,
      ...(runHomeBinding === undefined ? {} : { runHome: runHomeBinding }),
      // WS-21 §3.8: the run home's exit reconcile, inside the proxy's gate, with the ROUTER'S OWN store.
      ...(runHome === undefined
        ? {}
        : {
            reconcile: runHomeExitReconciler({
              shared,
              runId: runHome.runId,
              home: runHome.input.home,
              mirrored: () => mirroredEntries,
              record: (runId, outcome) => deps.recordRunHomeOutcome?.(runId, outcome),
            }),
          }),
    };

    // THE ROW EXISTS BEFORE THE CHILD DOES. The record sink writes `configDir`/`processIdentity` at the
    // spawn, which is later and might never happen; the row is this session's IDENTITY and its
    // PERSISTED SELECTION (D13), and a host asking `messaging.listReachable()` between the launch and
    // the first message must not be told the session does not exist. `record()` merges rather than
    // replaces, so the sink's later write lands on top of this one.
    await deps.directory.record(
      directoryRowFor({
        address,
        parsed,
        selection: request.selection,
        cwd,
        input: request.input,
        remoteConfig,
        // WS-15 §6.1 stamps every delivery with the target GENERATION so "a stale send cannot reach a
        // replacement process". The barrier bumps it on a handoff; a plain `options.resume` is a
        // replacement process too, and used to re-write `generation: 1` over the row (review r1, L-2).
        generation: resume === undefined ? (existing?.generation ?? 1) : (existing?.generation ?? 0) + 1,
      }),
    );

    // THE PUMP STARTS WITH THE LAUNCH, NOT WITH THE CALL. `query()` promises the Winter leg that a
    // caller's iterable is "never drained on the way past"; the official leg must drain it (the vendor
    // takes its own message shape), but not one element earlier than the session that consumes it.
    if (stream !== undefined) pumpCallerPrompt(request.prompt as AsyncIterable<string>, stream, () => void markEnded("unavailable").catch(() => undefined));
    let session: OfficialSession;
    if (runHome !== undefined) deps.recordRunHomeOutcome?.(runHome.runId, "pending");
    try {
      session = resume === undefined ? deps.official.launch(plan) : deps.official.resume({ ...plan, resume, ...(request.options.forkSession === undefined ? {} : { forkSession: request.options.forkSession }) });
      launched = session;
    } catch (error) {
      // A GENERATION THAT NEVER LAUNCHED WROTE NOTHING: its run home is safe to dispose.
      if (runHome !== undefined) deps.recordRunHomeOutcome?.(runHome.runId, "safe");
      // A GENERATION THAT NEVER EXISTED LEAVES NO ROW (I-3c). The row is written before the launch on
      // purpose — a host asking `listReachable()` between the launch and the first message must not be
      // told the session does not exist — but a launch that refuses synchronously (no official peer
      // injected, an options object the invariants reject) would otherwise leave `status: "running"`
      // and a listing entry nothing is behind. A row this call created is forgotten; a row that was
      // already there (a resume) is put back exactly as it was.
      ended = true;
      stream?.close();
      if (existing === undefined) await deps.directory.forget(address);
      else await deps.directory.record(existing);
      throw error;
    }
    // THE LEG IS OPEN — now, and not one line earlier (I-1). Everything above this point can still
    // refuse, and a ledger written before a refusal is a ledger that lies about where a session lives.
    live = true;
    deps.onOpened?.("claude-agent");

    // ATTACHED ONLY WHEN THERE IS SOMETHING TO PUSH INTO (header note 3). A handle whose `push` could
    // only ever fail would make every delivery `delivery_uncertain` — "the write may have landed" —
    // for a session where nothing could possibly land.
    //
    // `status()` IS THE LIVE VIEW, and it is what makes the adapter right BEFORE the row catches up
    // (I-3): the durable row is written by an await inside `markEnded`, and between the runtime's last
    // frame and that write the registry still holds this handle. Reporting `exited` from here closes
    // that window rather than narrowing it.
    if (stream !== undefined) {
      detach = deps.messaging.attachOfficialSession(address, {
        push: (text) => stream.push(text),
        status: () => (live ? "running" : "exited"),
      });
    }
    return session.query;
  };

  return deferredOfficialQuery({
    start,
    branchLabel,
    // 0.0.10: refuse with the LAUNCH path's own rule, before the child is reached; adopt only after it
    // accepted, so the bridge's mode and the child's mode can never disagree.
    adoptPermissionMode: (mode) => {
      currentMode = mode;
    },
    onMessage: noteFrame,
    onEnd: markEnded,
    onClose: () => {
      void markEnded("exited").catch(() => undefined);
    },
  });
}

/** The launch's own directory row: identity, persisted selection (D13), and R-7b-11's recorded choice. */
function directoryRowFor(args: { address: string; parsed: RuntimeAddress; selection: RuntimeSelection; cwd: string; input: RouterOfficialInput; remoteConfig: RemoteConfigPolicy; generation: number }): RuntimeDirectoryEntry {
  return {
    address: args.address,
    parsed: args.parsed,
    runtimeKind: "claude-agent",
    objectKind: args.parsed.objectKind,
    // WS-14's own preamble: "every claude-agent session is a child process" — and R-7b-1's
    // cross-runtime CHILD is one of those in its own right, which is what `claude-handle` says (a
    // native subagent living inside another official session would be `claude-child`).
    transport: "claude-handle",
    status: "running",
    mode: "code",
    generation: args.generation,
    selection: args.selection,
    remoteConfig: args.remoteConfig,
    cwd: args.cwd,
    ...(args.input.parentSessionId === undefined ? {} : { parentAddress: serializeRuntimeAddress(buildSessionAddress(args.input.parentSessionId)) }),
    ...(args.input.displayName === undefined ? {} : { displayName: args.input.displayName }),
    capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
    updatedAt: new Date().toISOString(),
  };
}

/** Pumps the caller's turns into the session's stream, then ends it — the caller decides the session's length. */
async function* mapPrompt(stream: OfficialInputStream, sessionId: string): AsyncGenerator<OfficialUserMessage> {
  for await (const text of stream) yield officialUserTurn(text, sessionId);
}

/**
 * Starts the caller's own iterable feeding the stream, and closes the stream when it ends.
 *
 * SEPARATE FROM `mapPrompt` because the two ends have different owners: the caller's iterable decides
 * when the session's input is over, and the messaging registry writes into the same stream until it is.
 */
export function pumpCallerPrompt(prompt: AsyncIterable<string>, stream: OfficialInputStream, onFailure?: (error: unknown) => void): void {
  void (async () => {
    try {
      for await (const text of prompt) await stream.push(text);
    } catch (error) {
      // A HOST GENERATOR THAT THREW IS NOT A SESSION THAT SIMPLY ENDED (review r1's nit). Swallowing
      // it left the caller watching a normal completion for a fault of their own making; the session
      // still ends with the input it received — the vendor is mid-turn and cannot be un-asked — but the
      // END is recorded as `unavailable` rather than `exited`, so the row says a fault happened.
      onFailure?.(error);
    } finally {
      stream.close();
    }
  })();
}

/**
 * The handle: the vendor's `Query`, once there is one.
 *
 * WHY A `Proxy` AND NOT A HAND-WRITTEN FACADE. The pinned `Query` has twenty-six members and this
 * package deliberately names three of them — the iterator, `interrupt` and (since 0.0.10)
 * `setPermissionMode` (`seams/official-sdk-shapes.ts`: the vendor's types never
 * reach this package's published declarations, so a Winter-only host can type-check without installing
 * the optional peer). A facade would therefore have to either import those types — breaking that rule
 * — or silently drop every member it did not know about, which is exactly "the contract loses a
 * member". Forwarding by trap loses nothing, including members added by a future pin.
 *
 * THE NAMES THAT ARE NOT FORWARDED are the ones a RUNTIME calls on its own, without a host meaning to
 * call anything: `then`/`catch`/`finally` (a handle that answered `then` with a function would be
 * treated as a promise by `await` and by every combinator, so `await sdk.query(...)` would hang or
 * resolve to something that is not the query), and `toJSON`/`inspect`/`asymmetricMatch` (review r1,
 * M-3 — `JSON.stringify(handle)` calls `toJSON` if it is a function, so the most common debug
 * statement a host writes STARTED A SESSION: measured, one keychain read and one spawn from a
 * `console.log(JSON.stringify(query))`). Symbols other than `Symbol.asyncIterator` are not forwarded
 * either — a launch triggered by a `Symbol.toPrimitive` or an inspector's probe would be a session
 * started by a debugger, which is this rule in its original form.
 */
interface DeferredQueryHooks {
  start: () => Promise<OfficialQuery>;
  /** For the refusal `setPermissionMode` raises — the same `OfficialConfigurationError` a launch raises. */
  branchLabel: string;
  /** Called with the new mode ONLY once the child has accepted it (0.0.10). */
  adoptPermissionMode: (mode: OfficialPermissionMode) => void;
  onClose: () => void;
  /** Called for each message BEFORE it is yielded, so a row update lands before a host acts on it. */
  onMessage?: (message: unknown) => Promise<void>;
  /** The generation ended — `"exited"` when the stream completed, `"unavailable"` when it threw. */
  onEnd?: (status: "exited" | "unavailable") => Promise<void>;
}

/** Names a RUNTIME calls on its own — never a host asking this session to do something (M-3). */
const NEVER_FORWARDED: ReadonlySet<string> = new Set(["then", "catch", "finally", "toJSON", "inspect", "asymmetricMatch"]);

function deferredOfficialQuery({ start, branchLabel, adoptPermissionMode, onClose, onMessage, onEnd }: DeferredQueryHooks): OfficialQuery {
  let started: Promise<OfficialQuery> | undefined;
  let closed = false;
  const ready = (): Promise<OfficialQuery> => {
    if (closed) return Promise.reject(new RuntimeLaunchInputError({ field: "close", reason: "this query was closed before it started, so there is no session to act on" }));
    started ??= start();
    return started;
  };
  const target: OfficialQuery & { close(): void } = {
    async *[Symbol.asyncIterator]() {
      const query = await ready();
      let faulted = false;
      try {
        for await (const message of query) {
          await onMessage?.(message);
          yield message;
        }
      } catch (error) {
        // A generation that ENDED IN A FAULT is `unavailable`, not `exited`: the two are different
        // answers to "can this be resumed", and WS-15 §6.4's restart recovery reads the difference.
        faulted = true;
        await onEnd?.("unavailable");
        throw error;
      } finally {
        // A `finally`, BECAUSE A HOST'S `break` IS NOT AN ERROR AND IS NOT THE END OF THE LOOP
        // (re-review, N-2). `for await (const m of query) { if (m.type === "result") break; }` — the
        // shape the vendor's own examples use — calls this generator's `return()`, which runs neither
        // the code after the loop nor the `catch`. So the row stayed `running`, a streaming session
        // stayed attached and listed, and a delivery into that stale handle blocked on the input
        // stream's backpressure instead of answering. `markEnded` is idempotent, so the fault arm
        // above still wins the reason.
        if (!faulted) await onEnd?.("exited");
      }
    },
    interrupt: async () => (await ready()).interrupt(),
    /**
     * WS-14 §10 (0.0.10): the live permission-mode change, as a NAMED member rather than a trapped one.
     *
     * IT HAS TO BE NAMED, for the refusal. The `get` trap below forwards any member it does not know
     * straight to the vendor's handle — so without this the launch path's own `bypassPermissions`
     * refusal would be bypassable by one method call on the handle the host already holds, and the
     * runtime would then auto-approve every tool call for the rest of the generation while this
     * branch's bridge went on claiming to decide them. The refusal runs BEFORE `ready()`, so a refused
     * call on an unstarted handle does not spawn a child in order to fail.
     *
     * THE THREE EDGES, mirroring `interrupt()` exactly (they go through the same `ready()`):
     *   * CLOSED handle → `RuntimeLaunchInputError` ("there is no session to act on"), ours;
     *   * NOT YET SPAWNED → the lazy launch happens and then the mode is set. Deliberately not a
     *     silent no-op: `Options.permissionMode` is already fixed by then, so answering "fine" while
     *     the child comes up in the old mode is the lie this change removes;
     *   * ENDED generation → the vendor's own rejection passes through unwrapped, exactly as an
     *     `interrupt()` after the last frame does. A host that wants "live only" asks its own session
     *     record, which is the only place that fact is authoritative.
     */
    setPermissionMode: async (mode: OfficialPermissionMode) => {
      assertPermissionModeAllowed(mode, branchLabel);
      await (await ready()).setPermissionMode(mode);
      adoptPermissionMode(mode);
    },
    close: () => {
      closed = true;
      onClose();
      if (started === undefined) return;
      void started.then(
        (query) => (query as { close?: () => void }).close?.(),
        () => undefined,
      );
    },
  };
  const handle = new Proxy(target, {
    get(base, prop, receiver: unknown) {
      if (prop in base) return Reflect.get(base, prop, receiver);
      if (typeof prop === "symbol" || NEVER_FORWARDED.has(prop)) return undefined;
      return (...args: unknown[]): Promise<unknown> => ready().then((query) => (query as unknown as Record<string, (...rest: unknown[]) => unknown>)[prop]?.(...args));
    },
  });
  OFFICIAL_HANDLES.add(handle);
  return handle;
}
