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
import type { BrandProfile, CredentialRef, Options, ProviderSelection, Query } from "@yanlinglabs/winter-agent-sdk";
import { buildSessionAddress, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";

import { RuntimeHandoffRequiredError, RuntimeLaunchInputError } from "./errors.ts";
import type { GlobalMessagingHandle } from "./messaging/router.ts";
import type { OfficialAdapterHandle, OfficialAdapterPolicy } from "./official/adapter.ts";
import { officialBranchLabel } from "./official/branding.ts";
import { createApprovalBridge, type OfficialApprovalBridge, type OfficialPermissionMode } from "./official/callbacks.ts";
import { buildOfficialChildEnv } from "./official/env-allowlist.ts";
import { fetchAuthCredentials, authVariableSetKey, type AuthCredentialPlan } from "./official/auth.ts";
import { buildOfficialOptions, type OptionsTemplatePolicy } from "./official/options-template.ts";
import { officialSpoolRoot } from "./official/spool.ts";
import type { RuntimeDirectory } from "./seams/directory.ts";
import type { RuntimeDirectoryEntry } from "./seams/directory-store.ts";
import type { OfficialLaunchPlan, OfficialLaunchProfile, OfficialSession, RemoteConfigPolicy } from "./seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialUserMessage } from "./seams/official-sdk-shapes.ts";
import type { RuntimeSelection } from "./selection/runtime-selection.ts";
import type { SharedSessionStore } from "./store/wiring.ts";
import { resumeStagingRoot } from "./vendor-paths.ts";

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
   * Secret variables for families whose mapping this module cannot derive — a cloud credential chain,
   * or a `custom` family, whose set is open by design (WS-14 §12).
   *
   * Each entry is a NAME and a REF, never material: the read happens at spawn, through the host's own
   * `KeychainSeam`, and nothing here holds the answer.
   */
  credentials?: readonly AuthCredentialPlan[];
  /**
   * NON-SECRET family variables: a gateway's `ANTHROPIC_BASE_URL`, a region, a project.
   *
   * Separate from `credentials` because they are not secrets and must not travel through a keychain
   * read — and because §12's gateway caveat ("set the full credential pair or neither") is checked
   * across both halves by the auth validator, whichever side each variable came from.
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
  /** §11's servers, already materialized by the host (`officialMcpServers`). */
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

/** The collaborators the leg composes. Built once by `createRuntimeSdk`; not part of any public shape. */
export interface OfficialLegDeps {
  brand: BrandProfile;
  official: OfficialAdapterHandle;
  directory: RuntimeDirectory;
  messaging: GlobalMessagingHandle;
  keychain: { read(ref: CredentialRef): Promise<string | undefined> };
  /** Lane C's ONE shared store, resolved on first use (the identity also carries the winter home). */
  shared: () => SharedSessionStore;
  /** WS-14 §5.1's vendored runtime, from the constructor. A per-query `Options` value wins over it. */
  vendoredOfficialRuntime?: string;
  /** The adapter's own policy, so a host's `env`/`containment` choices reach the door's own builders. */
  policy?: OfficialAdapterPolicy;
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
 * two families that inject nothing inject nothing. A cloud credential chain and a `custom` family name
 * their own variables, because their sets are the host's: a chain's variables depend on which of
 * Bedrock's or Vertex's several auth modes the deployment uses, and `custom` is open by definition.
 */
export function officialCredentialPlan(args: {
  selection: RuntimeSelection;
  provider: ProviderSelection | undefined;
  explicit: readonly AuthCredentialPlan[] | undefined;
}): readonly AuthCredentialPlan[] {
  if (args.explicit !== undefined) return args.explicit;
  const family = authVariableSetKey(args.selection);
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

/** Non-secret connection variables a family sets, from the contract's own `ProviderConnectionConfig`. */
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
}

/**
 * Opens the official leg, synchronously, returning the vendor's `Query` through a handle that defers
 * the launch to the first pull (see this module's header, note 1).
 */
export function openOfficialLeg(deps: OfficialLegDeps, request: OfficialLegRequest): OfficialQuery {
  const branchLabel = officialBranchLabel(deps.brand);
  const address = serializeRuntimeAddress(buildSessionAddress(request.input.sessionId));
  // OWNED ONLY WHEN THE CALLER GAVE US A STREAM TO OWN (header note 3).
  const stream = typeof request.prompt === "string" ? undefined : createOfficialInputStream();
  let detach: (() => void) | undefined;

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
      throw new RuntimeHandoffRequiredError({ from: existing.runtimeKind, to: "claude-agent", address });
    }
    const shared = deps.shared();
    const home = shared.identity.winterHome;
    const resume = request.options.resume;
    const profile: OfficialLaunchProfile = resume === undefined ? "fresh-spool" : "store-backed-resume";
    const configDir = resume === undefined ? (request.input.spool ?? officialSpoolRoot(home)) : (request.input.stagingRoot ?? resumeStagingRoot(resume));
    const cwd = request.options.cwd;
    if (cwd === undefined || cwd.length === 0) {
      throw new RuntimeLaunchInputError({ field: "options.cwd", reason: "the official branch's containment floor, its plugin root and its post-hoc sweep are all anchored on this session's working directory (WS-14 §8)" });
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
    const env = buildOfficialChildEnv(
      {
        selection: request.selection,
        configDir,
        brand: deps.brand,
        credentials,
        ...(request.input.base === undefined ? {} : { base: request.input.base }),
        projectKey: request.input.projectKey ?? request.input.sessionId,
        ...(request.input.sharedTempRoot === undefined ? {} : { sharedTempRoot: request.input.sharedTempRoot }),
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
            mode: (request.options.permissionMode ?? "default") as OfficialPermissionMode,
            ...(deps.policy?.containment === undefined ? {} : { containment: deps.policy.containment }),
            broker: async (approval) => {
              const answer = await hostBroker(approval.toolName, approval.input, approval as never);
              return answer ?? { behavior: "deny", message: "the host callback returned no decision; this bridge never uses the `null` transport escape (WS-14 §10)", toolUseID: approval.toolUseID };
            },
          });

    const templatePolicy: OptionsTemplatePolicy = {
      ...(request.input.options ?? {}),
      ...(typeof deps.policy?.options === "function" ? {} : (deps.policy?.options ?? {})),
      advertisesHandoff: request.input.advertisesHandoff ?? true,
      env,
      ...(request.input.mcpServers === undefined ? {} : { mcpServers: request.input.mcpServers }),
      ...(bridge === undefined ? {} : { canUseTool: bridge }),
      ...(request.options.permissionMode === undefined ? {} : { permissionMode: request.options.permissionMode as OfficialPermissionMode }),
      ...(request.options.sessionId === undefined ? {} : { sessionId: request.options.sessionId }),
      ...(resume === undefined ? {} : { resume }),
      ...(request.options.forkSession === undefined ? {} : { forkSession: request.options.forkSession }),
      ...(request.options.disallowedTools === undefined ? {} : { additionalDisallowedTools: request.options.disallowedTools }),
      ...(deps.policy?.containment === undefined ? {} : { containment: deps.policy.containment }),
    };
    const officialOptions: OfficialOptions = buildOfficialOptions(
      {
        // D4/D28: the official runtime serves CODE only — every other mode is refused by the selector
        // before a selection with `runtimeKind: "claude-agent"` can exist (`mode-forbids-runtime`), so
        // this is the one reachable value rather than a default that hides a choice.
        mode: "code",
        selection: request.selection,
        cwd,
        sessionStore: shared.store,
        autoMemoryDirectory: request.input.autoMemoryDirectory ?? `${home}/projects/${request.input.projectKey ?? request.input.sessionId}/memory`,
        brand: deps.brand,
        pathToClaudeCodeExecutable: executable,
        spawnProxy: deps.official.spawnProxy,
        profile,
        configDir,
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
    };

    // THE ROW EXISTS BEFORE THE CHILD DOES. The record sink writes `configDir`/`processIdentity` at the
    // spawn, which is later and might never happen; the row is this session's IDENTITY and its
    // PERSISTED SELECTION (D13), and a host asking `messaging.listReachable()` between the launch and
    // the first message must not be told the session does not exist. `record()` merges rather than
    // replaces, so the sink's later write lands on top of this one.
    await deps.directory.record(directoryRowFor({ address, selection: request.selection, cwd, input: request.input, remoteConfig }));

    // THE PUMP STARTS WITH THE LAUNCH, NOT WITH THE CALL. `query()` promises the Winter leg that a
    // caller's iterable is "never drained on the way past"; the official leg must drain it (the vendor
    // takes its own message shape), but not one element earlier than the session that consumes it.
    if (stream !== undefined) pumpCallerPrompt(request.prompt as AsyncIterable<string>, stream);
    const session: OfficialSession = resume === undefined ? deps.official.launch(plan) : deps.official.resume({ ...plan, resume, ...(request.options.forkSession === undefined ? {} : { forkSession: request.options.forkSession }) });

    // ATTACHED ONLY WHEN THERE IS SOMETHING TO PUSH INTO (header note 3). A handle whose `push` could
    // only ever fail would make every delivery `delivery_uncertain` — "the write may have landed" —
    // for a session where nothing could possibly land.
    if (stream !== undefined) {
      detach = deps.messaging.attachOfficialSession(address, {
        push: (text) => stream.push(text),
      });
    }
    return session.query;
  };

  return deferredOfficialQuery(start, () => {
    detach?.();
    stream?.close();
  });
}

/** The launch's own directory row: identity, persisted selection (D13), and R-7b-11's recorded choice. */
function directoryRowFor(args: { address: string; selection: RuntimeSelection; cwd: string; input: RouterOfficialInput; remoteConfig: RemoteConfigPolicy }): RuntimeDirectoryEntry {
  return {
    address: args.address,
    parsed: buildSessionAddress(args.input.sessionId),
    runtimeKind: "claude-agent",
    objectKind: "session",
    // WS-14's own preamble: "every claude-agent session is a child process".
    transport: "claude-handle",
    status: "running",
    mode: "code",
    generation: 1,
    selection: args.selection,
    remoteConfig: args.remoteConfig,
    cwd: args.cwd,
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
export function pumpCallerPrompt(prompt: AsyncIterable<string>, stream: OfficialInputStream): void {
  void (async () => {
    try {
      for await (const text of prompt) await stream.push(text);
    } catch {
      /* the caller's own iterable failed; the session ends with the input it received */
    } finally {
      stream.close();
    }
  })();
}

/**
 * The handle: the vendor's `Query`, once there is one.
 *
 * WHY A `Proxy` AND NOT A HAND-WRITTEN FACADE. The pinned `Query` has twenty-six members and this
 * package deliberately names two of them (`seams/official-sdk-shapes.ts`: the vendor's types never
 * reach this package's published declarations, so a Winter-only host can type-check without installing
 * the optional peer). A facade would therefore have to either import those types — breaking that rule
 * — or silently drop every member it did not know about, which is exactly "the contract loses a
 * member". Forwarding by trap loses nothing, including members added by a future pin.
 *
 * THE THREE NAMES THAT ARE NOT FORWARDED are `then`, `catch` and `finally`: a handle that answered
 * `then` with a function would be treated as a promise by `await` and by every combinator, so
 * `await sdk.query(...)` would hang or resolve to something that is not the query. Symbols other than
 * `Symbol.asyncIterator` are not forwarded either — a launch triggered by a `Symbol.toPrimitive` or an
 * inspector's probe would be a session started by a debugger.
 */
function deferredOfficialQuery(start: () => Promise<OfficialQuery>, onClose: () => void): OfficialQuery {
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
      for await (const message of query) yield message;
    },
    interrupt: async () => (await ready()).interrupt(),
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
      if (typeof prop === "symbol" || prop === "then" || prop === "catch" || prop === "finally") return undefined;
      return (...args: unknown[]): Promise<unknown> => ready().then((query) => (query as unknown as Record<string, (...rest: unknown[]) => unknown>)[prop]?.(...args));
    },
  });
  OFFICIAL_HANDLES.add(handle);
  return handle;
}
