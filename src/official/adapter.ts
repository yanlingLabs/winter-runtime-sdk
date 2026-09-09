// WS-14 §1–§13: THE OFFICIAL-SDK ADAPTER, assembled.
//
// Every module beside this one owns one section; this one owns the composition and the two things
// composition makes possible: a LAUNCH that cannot start without its invariants, and a SESSION whose
// `configDir` is the value the child actually got rather than the value we asked for.
//
// THE ONE ORDERING SUBTLETY WORTH STATING. The pinned runtime spawns LAZILY — `query()` returns a
// handle and the child starts when the stream is first pulled. So at the moment `launch()` returns,
// nothing has spawned and §1's authoritative value does not exist yet. `OfficialSession.configDir` is
// therefore an ACCESSOR: it reports the observed root once the proxy has one and the configured value
// before that, and `whenObserved()` is the await for anything that needs the real one. The DURABLE
// half of §6 rule 2 is unaffected — it is written inside the proxy, before the process is returned,
// which is where the spec puts it.
//
// WIRING: `createOfficialAdapter(context)` is a drop-in for the spine's `stubOfficialAdapter(context)`
// in `src/sdk.ts`. That one-line replacement is a SPINE edit (a lane may not touch `src/sdk.ts`), and
// the Lane A report carries it as the exact diff.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import type { SeamContextWithDirectory } from "../seams/context.ts";
import type { OfficialAdapter, OfficialLaunchPlan, OfficialLaunchProfile, OfficialResumePlan, OfficialSession, OptionsTemplateInput } from "../seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialSpawnClaudeCodeProcess, OfficialSpawnOptions, OfficialSpawnedProcess } from "../seams/official-sdk-shapes.ts";
import type { PermissionResult } from "@yanlinglabs/winter-agent-sdk";

import { officialBranchLabel } from "./branding.ts";
import { createApprovalBridge, createContainmentHooks, isOurApprovalBridge, type OfficialApprovalBridge, type OfficialPermissionMode } from "./callbacks.ts";
import { resolveSavedApprovalDisposition, type ContainmentPolicy } from "./containment.ts";
import { createContainmentSweep, type ContainmentBreach, type ContainmentSweep } from "./sweep.ts";
import { mergeHooks } from "./options-template.ts";
import { buildOfficialChildEnv, type OfficialEnvInput, type OfficialEnvPolicy } from "./env-allowlist.ts";
import { OfficialConfigurationError, OfficialInvalidResumeError } from "./errors.ts";
// NEW-13: the row this adapter's default sink writes is shown to a model, so its address must be one
// the model can send to. Both the parser and the refusal are shared with the directory's own door.
import { parseRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";
import { UnaddressableEntryError } from "../errors.ts";
import { assertOptionsInvariants, buildOfficialOptions, type OptionsTemplatePolicy } from "./options-template.ts";
import type { OfficialContainmentBreachError } from "./errors.ts";
import { classifyLocalWriteRoot } from "./spool.ts";
import {
  createSupervisedSpawnProxy,
  directoryRecordSink,
  prepareDefaultSpawn,
  type SpawnChild,
  type SpawnObservation,
  type SpawnRecordSink,
  type SupervisedSpawnProxy,
  type TranscriptReconcile,
} from "./spawn-proxy.ts";
import type { OfficialBranchError } from "./errors.ts";

/** Everything the adapter needs that is neither a seam nor a per-launch value. */
export interface OfficialAdapterPolicy {
  /** Per-launch template policy: an object, or a function of the template input. */
  options?: OptionsTemplatePolicy | ((input: OptionsTemplateInput) => OptionsTemplatePolicy);
  env?: OfficialEnvPolicy;
  /** Where §6 rule 2's record goes. Default: nowhere durable, and `launch` says so if it matters. */
  sink?: SpawnRecordSink;
  /** §6 rule 3's collaborator (the store lane's). Default: a no-op that still runs at the right moment. */
  reconcile?: TranscriptReconcile;
  /** §6 rule 5. Default: `undefined` → cleanup is treated as verified (an in-memory sink has nothing to verify). */
  verifyCleanup?: (observation: SpawnObservation) => Promise<boolean> | boolean;
  /** Injected for tests; production uses Node's own spawn with the brand's process label as argv0. */
  spawnChild?: SpawnChild;
  onCrash?: (error: OfficialBranchError) => void;
  /** §8's post-hoc sweep found a vendor-named path a call created (review r2, NEW-3). */
  onContainmentBreach?: (breach: ContainmentBreach, error: OfficialContainmentBreachError) => void;
  /** §8's dispositions, threaded into the floor this adapter installs on every launch. */
  containment?: ContainmentPolicy;
  /** The session's permission mode, for the bridge the adapter installs when the caller supplied none. */
  permissionMode?: OfficialPermissionMode;
  now?: () => Date;
}

/** A live official generation, plus the two handles the seam's shape cannot carry. */
export interface OfficialSessionHandle extends OfficialSession {
  /** Resolves with the OBSERVED root once the child has spawned (§1's authoritative value). */
  whenObserved(): Promise<string>;
  /** WS-14 §9: stops the foreground turn, preserving background agents (`perTaskStopAffordance`). */
  interrupt(): Promise<unknown>;
  /** The generation's proxy — its stderr tail, its record, its exit gate. */
  readonly supervisor: SupervisedSpawnProxy;
  /** §8's post-hoc sweep findings for this session (review r2, NEW-3). Empty is the normal case. */
  readonly containmentBreaches: readonly ContainmentBreach[];
}

export interface OfficialAdapterHandle extends OfficialAdapter {
  launch(plan: OfficialLaunchPlan): OfficialSessionHandle;
  resume(plan: OfficialResumePlan): OfficialSessionHandle;
  /**
   * The seam's `buildChildEnv`, widened to the input the env builder actually accepts.
   *
   * `OfficialEnvInput` extends the spine's `EnvInput` with §3's two per-session vendor variables
   * (the transcript project key and the shared temp root), which the seam does not name. Method
   * parameters are bivariant, so this stays assignable to the seam while letting a caller that HAS
   * those values pass them without a cast.
   */
  buildChildEnv(input: OfficialEnvInput): Record<string, string>;
  /** Prepares the default child starter. Idempotent; a test injecting `spawnChild` never needs it. */
  ready(): Promise<void>;
}

/** §5's health facts a handoff decision is made from. */
export interface OfficialSessionHealth {
  /** WS-14 §6: "any session advertising cross-runtime handoff MUST launch through this proxy from its FIRST generation". */
  launchedThroughProxy: boolean;
  /** §1's recorded active local-write root, as observed. Absent for a default-spawn session. */
  recordedLocalWriteRoot?: string;
  /** §5: `mirror_error` sets `repair-required` and blocks handoff until the store is reconciled. */
  transcriptHealth: "ok" | "repair-required";
}

export type HandoffEligibility = { eligible: true } | { eligible: false; reason: "default-spawn-mirror-error" | "repair-required" | "no-recorded-root"; detail: string };

/**
 * §5's handoff refusals, as one decision (WS-17 row 15's "default-spawn `mirror_error` handoff
 * refusal").
 *
 * THE DEFAULT-SPAWN CASE IS THE INTERESTING ONE and it is a REFUSAL, not a fallback: "a resumed
 * default-spawn session with `mirror_error` keeps the official owner or stays `repair-required`;
 * SCANNING TEMP DIRECTORIES BY RECENCY IS FORBIDDEN". A session that did not launch through the proxy
 * has no recorded root, and the only other way to find its `claude-resume-*` staging directory is to
 * guess by mtime — which is how a reconciler ends up merging a DIFFERENT session's transcript into
 * this one. There is no safe answer, so the answer is no.
 */
export function officialHandoffEligibility(health: OfficialSessionHealth): HandoffEligibility {
  if (health.transcriptHealth === "repair-required" && !health.launchedThroughProxy) {
    return {
      eligible: false,
      reason: "default-spawn-mirror-error",
      detail:
        "this session was launched with the default spawner, so its active local-write root was never recorded; after a mirror error the only way to find it would be to scan temp directories by recency, which is forbidden — the session keeps its current owner",
    };
  }
  if (health.transcriptHealth === "repair-required" && health.recordedLocalWriteRoot === undefined) {
    return { eligible: false, reason: "no-recorded-root", detail: "the mirror is unhealthy and no local-write root is recorded to reconcile the canonical store against" };
  }
  if (health.transcriptHealth === "repair-required") {
    return { eligible: false, reason: "repair-required", detail: `the canonical store must be reconciled against ${health.recordedLocalWriteRoot} before this session can change runtime` };
  }
  return { eligible: true };
}

/** Builds the adapter. `context` is the spine's one seam context — see `src/seams/context.ts`. */
export function createOfficialAdapter(context: SeamContextWithDirectory, policy: OfficialAdapterPolicy = {}): OfficialAdapterHandle {
  const brand: BrandProfile = context.brand;
  const branchLabel = officialBranchLabel(brand);
  // Pay the child-starter resolution at construction rather than at the first spawn. Nothing depends
  // on it any more (review r1, M3: the hook resolves synchronously on first use), so a rejection here
  // would be noise — the first spawn reports the real failure with its own typed class.
  void prepareDefaultSpawn().catch(() => undefined);

  /**
   * §6 rule 2's DEFAULT SINK — the spine's own directory store, addressed by the launch (review r1, M3).
   *
   * The first version defaulted to `{ record: () => undefined }`, so `createOfficialAdapter(context)`
   * — the exact call the owed spine wiring makes — recorded nothing durable at all, and the doc
   * comment's promise that "launch says so if it matters" was not implemented. The address now
   * travels on the plan, so the default is the real store, and a host that wants its own record
   * passes `policy.sink` as before.
   */
  const sinkFor = (plan: OfficialLaunchPlan): SpawnRecordSink => {
    if (policy.sink !== undefined) return policy.sink;
    // THE ROW THIS SINK WRITES IS SHOWN TO A MODEL, so its address has to be one the model can send
    // to (review r4, NEW-13). The first version derived `parsed` by putting the whole address string
    // into `winterSessionId`, which produced a row `ListAgents` advertised and all three of Lane B's
    // resolution doors refused — a listing entry with no reachable object behind it. The seam types
    // this field `SerializedRuntimeAddress` and calls it canonical, but that alias is `= string`, so
    // the guard has to be here (and Lane B's `record()` now refuses the same shape from any writer).
    const parsed = parseRuntimeAddress(plan.address);
    if (parsed === undefined) throw new UnaddressableEntryError(plan.address);
    return directoryRecordSink({
      store: context.directoryStore,
      address: plan.address,
      seed: () => ({
        address: plan.address,
        parsed,
        runtimeKind: "claude-agent",
        objectKind: "session",
        // WS-14's own preamble: "every claude-agent session is a child process", Code mode only.
        transport: "claude-handle",
        status: "running",
        mode: "code",
        generation: 1,
        selection: plan.selection,
        // R-7b-11: WHICH of the pin's two tool surfaces this session ran with, on the row itself —
        // otherwise the only evidence is four variables in a child environment nobody keeps.
        remoteConfig: plan.remoteConfig ?? "deny",
        capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
        updatedAt: new Date().toISOString(),
        ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
      }),
    });
  };

  /**
   * WHICH SESSION A CONFIG DIR BELONGS TO — the map the DISPATCHER path needs (fix-wave concern 3).
   *
   * `launch()`/`resume()` know both halves; the dispatcher knows only the root it observed. A launch
   * records the pair here so a host that follows §2's template — `buildOptions({ spawnProxy:
   * adapter.spawnProxy })` and then the vendor's own `query()` — still gets §6 rule 2's durable record
   * instead of the silent no-op it used to get.
   *
   * ONLY ROOTS THAT ARE UNIQUE PER GENERATION GO IN (review r1, M-1). §1's `fresh-spool` root is ONE
   * DIRECTORY PER HOME, shared by every fresh session, so a map keyed by it answers "whichever session
   * launched last" — which is the recency guess WS-14 §5 forbids, wearing this map as a hat. Measured
   * on the head before this: two launches under the spool, then a bare dispatch of a THIRD session,
   * recorded the third session's pid on the second session's row. A `claude-resume-<uuid>` staging root
   * is unique per generation, so it is the only kind that can be attributed this way; a spool root has
   * to be attributed by the directory, or refused.
   *
   * PRUNED WHEN THE GENERATION SETTLES, so a long-lived adapter's map does not grow by one entry per
   * launch for ever.
   */
  const sinkByRoot = new Map<string, SpawnRecordSink>();

  /**
   * §6 rule 2's record on the DISPATCHER path: the directory sink when the root can be attributed to
   * exactly one session, a TYPED REFUSAL when it cannot.
   *
   * A REFUSAL AND NOT A NO-OP, because the failure a no-op produces is the worst kind this branch has:
   * a session whose `claude-resume-<uuid>` staging root is never written down, which after a crash can
   * only be found by scanning temp directories by recency — the thing `officialHandoffEligibility`
   * refuses to do, for the reason it gives. Better to fail at the spawn, where the host can pass
   * `policy.sink` or use `launch()`, than to discover it during a handoff.
   *
   * THE RESOLUTION IS ASYNC AND THE DISPATCHER IS NOT, so it happens inside `record()`: `launch()`'s
   * own map first, then the directory's rows by `configDir`, and only when exactly one row matches —
   * two sessions under one root is precisely the ambiguity a recency scan would resolve by guessing.
   */
  const dispatcherSink = (): SpawnRecordSink => {
    const resolve = async (observedRoot: string): Promise<SpawnRecordSink> => {
      // THE LAUNCH'S OWN SINK, not merely its address — it carries the SEED, so a dispatch under a
      // root whose session has no directory row yet still records rather than failing on the
      // "no entry and no seed" branch a launch would never have hit.
      //
      // …AND ONLY FOR A ROOT THAT NAMES ONE GENERATION (M-1). A shared spool root skips the map
      // entirely and must be attributed by the directory or refused, because "the most recent launch
      // under the spool" is a guess about which session this spawn belongs to.
      const known = classifyLocalWriteRoot(observedRoot).kind === "sdk-resume-staging" ? sinkByRoot.get(observedRoot) : undefined;
      if (known !== undefined) return known;
      const matches = (await context.directoryStore.load()).filter((entry) => entry.configDir === observedRoot);
      if (matches.length === 1) return directoryRecordSink({ store: context.directoryStore, address: (matches[0] as { address: string }).address });
      throw new OfficialConfigurationError({
        option: "spawnProxy",
        reason:
          matches.length === 0
            ? `this spawn came through the bare dispatcher and its config dir (${observedRoot}) belongs to no session this adapter launched and to no directory row, so §6 rule 2's record has no address to be written under; launch through launch()/resume() (which carry the address on the plan) or pass policy.sink`
            : `its config dir (${observedRoot}) matches ${matches.length} directory rows, so the record cannot be attributed to one session — and attributing it by recency is the guess WS-14 §5 forbids`,
        branchLabel,
      });
    };
    return {
      async record(observation) {
        await (await resolve(observation.root.configDir)).record(observation);
      },
      async clear(observation) {
        await (await resolve(observation.root.configDir)).clear?.(observation);
      },
    };
  };

  const makeProxy = (profile: OfficialLaunchProfile, configuredConfigDir: string, sink: SpawnRecordSink): SupervisedSpawnProxy =>
    createSupervisedSpawnProxy({
      brand,
      profile,
      configuredConfigDir,
      sink,
      ...(policy.reconcile === undefined ? {} : { reconcile: policy.reconcile }),
      ...(policy.verifyCleanup === undefined ? {} : { verifyCleanup: policy.verifyCleanup }),
      ...(policy.spawnChild === undefined ? {} : { spawnChild: policy.spawnChild }),
      ...(policy.onCrash === undefined ? {} : { onCrash: policy.onCrash }),
      ...(policy.now === undefined ? {} : { now: policy.now }),
    });

  /**
   * The seam's single `spawnProxy`.
   *
   * A DISPATCHER, because the seam is one function and a supervisor is per GENERATION. The supported
   * path is `launch()`/`resume()`, which bind a fresh supervisor into the options they hand the
   * runtime; this dispatcher exists for a host that builds its own options with
   * `OptionsTemplateInput.spawnProxy` and calls the vendor `query()` itself. It classifies the profile
   * from the observed root and treats that root as its own configured value — self-consistent by
   * construction, which is the most it can honestly claim without a launch to attribute the spawn to.
   */
  const dispatcher: OfficialSpawnClaudeCodeProcess = (spawnOptions: OfficialSpawnOptions): OfficialSpawnedProcess => {
    const observed = spawnOptions.env["CLAUDE_CONFIG_DIR"];
    if (observed === undefined || observed.length === 0) {
      throw new OfficialConfigurationError({ option: "env.CLAUDE_CONFIG_DIR", reason: "a spawn with no config dir has no recoverable transcript root (WS-14 §1/§6)", branchLabel });
    }
    const classified = classifyLocalWriteRoot(observed);
    // NEVER `{ record: () => undefined }` ANY MORE (fix-wave concern 3). The default read as "the
    // record is on" and on this one path it was off — for exactly the host that followed the
    // documented template. It is now the directory sink, or a refusal that says which door to use.
    lastDispatched = makeProxy(classified.profile, observed, policy.sink ?? dispatcherSink());
    return lastDispatched.spawn(spawnOptions);
  };
  let lastDispatched: SupervisedSpawnProxy | undefined;

  const optionsPolicyFor = (input: OptionsTemplateInput): OptionsTemplatePolicy => (typeof policy.options === "function" ? policy.options(input) : (policy.options ?? {}));

  /** Every session's sweep, kept so the handle can report what it caught (review r2, NEW-3). */
  const sweeps = new WeakMap<object, ContainmentSweep>();

  /**
   * Installs §8's two layers onto the options a caller handed us, merging rather than replacing.
   *
   * THE PRE-HOC LAYER is the containment hook plus the approval bridge; THE POST-HOC LAYER is the
   * sweep, which needs this session's own roots (`cwd`, and `HOME` as the child was given it) and is
   * therefore per-launch rather than per-adapter.
   */
  const installFloor = (plan: OfficialLaunchPlan): OfficialOptions => {
    const containment: ContainmentPolicy = { projectDirName: brand.projectDirName, ...(policy.containment ?? {}) };
    // THE ADAPTER'S OWN POLICY IS VALIDATED ON EVERY LAUNCH, whichever bridge the caller brought (review
    // r4, NEW-19). `redirect` was a typed refusal only on the route where this adapter happened to
    // construct the bridge, and a silent `disable` when the caller's bridge was one this package made.
    resolveSavedApprovalDisposition(containment, branchLabel);
    const home = (plan.options.env ?? {})["HOME"];
    const sweep = createContainmentSweep({
      cwd: plan.cwd,
      ...(home === undefined ? {} : { home }),
      branchLabel,
      onBreach: (breach, error) => policy.onContainmentBreach?.(breach, error),
    });
    // THE FLOOR IS MERGED ON EVERY LAUNCH, UNCONDITIONALLY (review r4, NEW-18). Fix r3 skipped it when
    // the caller's PreToolUse hooks already carried `CONTAINMENT_FLOOR_MARK`, to spare a second copy —
    // and the mark is a `Symbol.for` key on an exported symbol, so the token that PROVED the floor was
    // installed became the token that REMOVED it. Measured on the real runtime: a no-op host hook
    // stamped with it replaced §8's floor, `EnterWorktree` and `Task(isolation:"worktree")` created
    // `<cwd>/.claude` (swept post-hoc, the turn ended) and left a dangling `.git/worktrees/…` entry the
    // sweep cannot see. And no forgery was needed: a GENUINE floor built by `buildOfficialOptions` under
    // a looser template policy carries the TEMPLATE's dispositions, so skipping the merge made this
    // adapter's own `policy.containment` inert for every caller of the supported path.
    //
    // So provenance is the wrong test here — a floor built with a different policy is a different floor —
    // and the only hook that applies THIS adapter's policy is the one it builds itself, on every launch.
    // A second copy is a pure decision the runtime evaluates beside the first (measured: every matcher
    // runs, and any deny wins), which is what "install-if-omitted, merge never replace" (review r2,
    // NEW-1) always meant. Identity is asked where it is the right question: `assertOptionsInvariants`
    // recognises a floor by `WeakSet` membership, never by the mark.
    const floorHooks = createContainmentHooks({ brand, containment }) as Record<string, unknown[]>;
    const merged = mergeHooks(mergeHooks(floorHooks, sweep.hooks as unknown), plan.options.hooks);
    const existing = plan.options.canUseTool;
    // A CALLER'S OWN CALLBACK IS WRAPPED, NEVER DROPPED: it becomes the broker behind our bridge, so
    // the floor runs first and their decision still decides everything the floor allows. `null` — the
    // transport escape §10 forbids on this bridge — becomes a typed deny rather than an indefinite
    // wait.
    // IDENTITY, NOT A FORGEABLE MARK (review r3, NEW-11). `APPROVAL_BRIDGE_MARK` is exported and a
    // `Symbol.for` key, so any caller can stamp it — and a stamped always-allow callback was measured
    // being taken verbatim, which skipped the saved-approval strip and wrote the vendor's settings
    // file. A bridge this package MADE is recognised by identity; anything else is wrapped.
    const canUseTool = isOurApprovalBridge(existing)
      ? (existing as OfficialApprovalBridge)
      : createApprovalBridge({
          brand,
          mode: policy.permissionMode ?? "default",
          containment,
          broker: async (request) => {
            if (typeof existing !== "function") {
              return {
                behavior: "deny",
                message: `no approval broker is configured for this session, so ${request.toolName} cannot be approved; this branch owns permissions and a host must bridge its broker into canUseTool (WS-14 §10)`,
                toolUseID: request.toolUseID,
              };
            }
            const answer = await (existing as (toolName: string, input: Record<string, unknown>, options: unknown) => Promise<PermissionResult | null>)(request.toolName, request.input, request);
            return answer ?? { behavior: "deny", message: "the host callback returned no decision; this bridge never uses the `null` transport escape (WS-14 §10)", toolUseID: request.toolUseID };
          },
        });
    const options: OfficialOptions = { ...plan.options, hooks: merged, canUseTool };
    sweeps.set(options, sweep);
    return options;
  };

  const start = (plan: OfficialLaunchPlan, resume: { resume: string; forkSession?: boolean } | undefined): OfficialSessionHandle => {
    const claude = context.peers.claude;
    if (claude === undefined) {
      throw new OfficialConfigurationError({
        option: "peers.claude",
        reason: "this session selected the official runtime, but no official SDK module was injected; a runtime that is not present is a typed refusal rather than a silent fallback (D13/D19a)",
        branchLabel,
      });
    }
    // REVIEW r2, NEW-1 — THE FLOOR IS INSTALLED HERE, on the caller's options, before anything is
    // asserted about them. "Merge, never replace": the host's own hooks and its own broker survive,
    // ours run first, and the sweep's snapshot pair rides along. Then the invariants check that the
    // result really carries both — by IDENTITY, not by a stampable mark (review r4, NEW-18) — so an
    // options object that arrived without them is fixed and an object that cannot be fixed is refused,
    // rather than launching uncontained.
    const withFloor = installFloor(plan);
    assertOptionsInvariants(withFloor, branchLabel);
    if (resume !== undefined && resume.resume.length === 0) {
      throw new OfficialInvalidResumeError({ reason: "a resume needs the backend session id it is resuming", branchLabel });
    }
    if (resume === undefined && plan.options.resume !== undefined) {
      throw new OfficialInvalidResumeError({ reason: "these options carry a `resume` id but the launch is a fresh generation; use resume() so the record and the profile agree", branchLabel });
    }

    // ONE SUPERVISOR PER GENERATION, bound into the options this generation is started with. A copy,
    // because the caller's plan is theirs — and the ONLY field changed is the spawn hook.
    const launchSink = sinkFor(plan);
    const supervisor = makeProxy(plan.profile, plan.configDir, launchSink);
    // The pair this launch knows and the dispatcher does not: the CONFIGURED root and, once the
    // wrapper hands the child a different one (§1 profile 2), the OBSERVED root — each registered only
    // when it names ONE generation (M-1), which a `claude-resume-<uuid>` staging root does and the
    // shared spool does not.
    const registered: string[] = [];
    const registerRoot = (root: string): void => {
      if (classifyLocalWriteRoot(root).kind !== "sdk-resume-staging") return;
      sinkByRoot.set(root, launchSink);
      registered.push(root);
    };
    registerRoot(plan.configDir);
    void supervisor.whenRecorded().then(
      () => {
        const observed = supervisor.observation?.root.configDir;
        if (observed !== undefined) registerRoot(observed);
      },
      () => undefined,
    );
    // The generation is over: its roots name nothing any more, and the vendor deletes a staging root
    // on the exit it observes.
    void supervisor.whenSettled().then(
      () => {
        for (const root of registered.splice(0)) sinkByRoot.delete(root);
      },
      () => undefined,
    );
    const options: OfficialOptions = {
      ...withFloor,
      ...(resume === undefined ? {} : { resume: resume.resume, ...(resume.forkSession === undefined ? {} : { forkSession: resume.forkSession }) }),
      spawnClaudeCodeProcess: supervisor.spawn,
    };

    const query = claude.query({ prompt: plan.prompt, options }) as OfficialQuery;
    return makeSession({ query, supervisor, plan, sweep: sweeps.get(withFloor) });
  };

  const makeSession = (args: { query: OfficialQuery; supervisor: SupervisedSpawnProxy; plan: OfficialLaunchPlan; sweep: ContainmentSweep | undefined }): OfficialSessionHandle => ({
    query: args.query,
    // §1/§6: the OBSERVED value once there is one; before the lazy spawn, the value this generation
    // is configured with — and never a value from some other generation.
    get configDir() {
      return args.supervisor.observation?.root.configDir ?? args.plan.configDir;
    },
    profile: args.plan.profile,
    selection: args.plan.selection,
    remoteConfig: args.plan.remoteConfig ?? "deny",
    supervisor: args.supervisor,
    get containmentBreaches() {
      return args.sweep?.breaches ?? [];
    },
    async whenObserved() {
      await args.supervisor.whenRecorded();
      const observed = args.supervisor.observation?.root.configDir;
      /* c8 ignore next */
      if (observed === undefined) throw new OfficialConfigurationError({ option: "env.CLAUDE_CONFIG_DIR", reason: "the generation settled without an observed root", branchLabel });
      return observed;
    },
    interrupt: () => args.query.interrupt(),
  });

  return {
    spawnProxy: dispatcher,
    ready: prepareDefaultSpawn,
    buildOptions: (input: OptionsTemplateInput) => buildOfficialOptions(input, optionsPolicyFor(input)),
    buildChildEnv: (input: OfficialEnvInput) => buildOfficialChildEnv(input, policy.env ?? {}),
    launch: (plan: OfficialLaunchPlan) => start(plan, undefined),
    resume: (plan: OfficialResumePlan) => start(plan, { resume: plan.resume, ...(plan.forkSession === undefined ? {} : { forkSession: plan.forkSession }) }),
    /** The supervisor of the most recent spawn that went through the dispatcher rather than a launch. */
    get lastDispatchedSupervisor(): SupervisedSpawnProxy | undefined {
      return lastDispatched;
    },
  } as OfficialAdapterHandle & { lastDispatchedSupervisor: SupervisedSpawnProxy | undefined };
}
