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
import type { EnvInput, OfficialAdapter, OfficialLaunchPlan, OfficialLaunchProfile, OfficialResumePlan, OfficialSession, OptionsTemplateInput } from "../seams/official-adapter.ts";
import type { OfficialOptions, OfficialQuery, OfficialSpawnClaudeCodeProcess, OfficialSpawnOptions, OfficialSpawnedProcess } from "../seams/official-sdk-shapes.ts";
import { officialBranchLabel } from "./branding.ts";
import { buildOfficialChildEnv, type OfficialEnvInput, type OfficialEnvPolicy } from "./env-allowlist.ts";
import { OfficialConfigurationError, OfficialInvalidResumeError } from "./errors.ts";
import { assertOptionsInvariants, buildOfficialOptions, type OptionsTemplatePolicy } from "./options-template.ts";
import { classifyLocalWriteRoot } from "./spool.ts";
import {
  createSupervisedSpawnProxy,
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
}

export interface OfficialAdapterHandle extends OfficialAdapter {
  launch(plan: OfficialLaunchPlan): OfficialSessionHandle;
  resume(plan: OfficialResumePlan): OfficialSessionHandle;
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
  const sink: SpawnRecordSink = policy.sink ?? { record: () => undefined };

  const makeProxy = (profile: OfficialLaunchProfile, configuredConfigDir: string): SupervisedSpawnProxy =>
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
    lastDispatched = makeProxy(classified.profile, observed);
    return lastDispatched.spawn(spawnOptions);
  };
  let lastDispatched: SupervisedSpawnProxy | undefined;

  const optionsPolicyFor = (input: OptionsTemplateInput): OptionsTemplatePolicy => (typeof policy.options === "function" ? policy.options(input) : (policy.options ?? {}));

  const start = (plan: OfficialLaunchPlan, resume: { resume: string; forkSession?: boolean } | undefined): OfficialSessionHandle => {
    const claude = context.peers.claude;
    if (claude === undefined) {
      throw new OfficialConfigurationError({
        option: "peers.claude",
        reason: "this session selected the official runtime, but no official SDK module was injected; a runtime that is not present is a typed refusal rather than a silent fallback (D13/D19a)",
        branchLabel,
      });
    }
    assertOptionsInvariants(plan.options, branchLabel);
    if (resume !== undefined && resume.resume.length === 0) {
      throw new OfficialInvalidResumeError({ reason: "a resume needs the backend session id it is resuming", branchLabel });
    }
    if (resume === undefined && plan.options.resume !== undefined) {
      throw new OfficialInvalidResumeError({ reason: "these options carry a `resume` id but the launch is a fresh generation; use resume() so the record and the profile agree", branchLabel });
    }

    // ONE SUPERVISOR PER GENERATION, bound into the options this generation is started with. A copy,
    // because the caller's plan is theirs — and the ONLY field changed is the spawn hook.
    const supervisor = makeProxy(plan.profile, plan.configDir);
    const options: OfficialOptions = {
      ...plan.options,
      ...(resume === undefined ? {} : { resume: resume.resume, ...(resume.forkSession === undefined ? {} : { forkSession: resume.forkSession }) }),
      spawnClaudeCodeProcess: supervisor.spawn,
    };

    const query = claude.query({ prompt: plan.prompt, options }) as OfficialQuery;
    return makeSession({ query, supervisor, plan });
  };

  const makeSession = (args: { query: OfficialQuery; supervisor: SupervisedSpawnProxy; plan: OfficialLaunchPlan }): OfficialSessionHandle => ({
    query: args.query,
    // §1/§6: the OBSERVED value once there is one; before the lazy spawn, the value this generation
    // is configured with — and never a value from some other generation.
    get configDir() {
      return args.supervisor.observation?.root.configDir ?? args.plan.configDir;
    },
    profile: args.plan.profile,
    selection: args.plan.selection,
    supervisor: args.supervisor,
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
    buildChildEnv: (input: EnvInput) => buildOfficialChildEnv(input as OfficialEnvInput, policy.env ?? {}),
    launch: (plan: OfficialLaunchPlan) => start(plan, undefined),
    resume: (plan: OfficialResumePlan) => start(plan, { resume: plan.resume, ...(plan.forkSession === undefined ? {} : { forkSession: plan.forkSession }) }),
    /** The supervisor of the most recent spawn that went through the dispatcher rather than a launch. */
    get lastDispatchedSupervisor(): SupervisedSpawnProxy | undefined {
      return lastDispatched;
    },
  } as OfficialAdapterHandle & { lastDispatchedSupervisor: SupervisedSpawnProxy | undefined };
}
