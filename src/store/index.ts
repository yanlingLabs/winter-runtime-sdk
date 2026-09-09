// Lane C's one import site (P7b Task 4).
//
// The PACKAGE's barrel is `src/index.ts` and it is spine-owned; what it already exports is the SEAM —
// `HandoffBarrier`, `HandoffOutcome`, `MaterializedResumeDecorator` and their vocabulary — which is
// what a HOST programs against. This file is what a TEST (and the spine's own wiring, in one line per
// seam) needs: the factories behind those seams and the store-side vocabulary that has no seam of its
// own, because nothing outside this package was ever given one.
export {
  assertOneSharedStore,
  assertStoreCompatibleOptions,
  BlindStoreImportError,
  createDecorationRegistry,
  createSharedSessionStore,
  DEFAULT_MIRROR_POLICY,
  SharedStoreOptionsError,
  SharedStoreUnavailableError,
  stripDecorations,
} from "./wiring.ts";
export type {
  CanonicalSessionStore,
  CanonicalSessionStoreConstructor,
  DecorationRegistry,
  MirrorErrorRecord,
  MirrorPolicy,
  SessionMirrorHealth,
  SettleReport,
  SharedSessionStore,
  SharedStoreIdentity,
  StoreBearingOptions,
  StripDecorationsResult,
  TranscriptHealth,
} from "./wiring.ts";

export {
  canonicalTranscriptPath,
  compareTranscriptTail,
  createTranscriptReconciler,
  guardedImportSessionToStore,
  isFile,
  isTranscriptPath,
  localTranscriptPath,
  reconcileLocalWriteRoot,
  scanLocalWriteRoot,
  TranscriptReconcileError,
} from "./reconcile.ts";
export type { LocalTranscript, ReconcileReport, TailComparison, TranscriptReconcileHook, TranscriptReconciler, TranscriptReconcileOutcome } from "./reconcile.ts";

export {
  materializeTempContinuity,
  resolveEngineTempLayout,
  sessionTempDirFor,
  tempContinuityDisclosure,
  tempContinuityModeFor,
  TempContinuityError,
  VENDOR_ENGINE_DIR_PREFIX,
} from "./temp-continuity.ts";
export type { EngineTempLayout, EngineTempLayoutInput, TempContinuityDisclosure, TempContinuityInput, TempContinuityResult } from "./temp-continuity.ts";

export {
  classifyCrashPairs,
  createMaterializedResumeDecorator,
  HANDOFF_ENTRY_LABEL,
  materializedTranscriptPath,
  MaterializedResumeError,
  PROVIDER_STATE_SUFFIX,
  RESUME_STAGING_PREFIX,
  resumeStagingRoot,
} from "./materialized-resume.ts";
export type {
  CrashPairClassification,
  MaterializedResumeDecoratorHandle,
  MaterializedResumeDeps,
  MaterializedResumeProbeDetail,
  MaterializedResumeProbeLeg,
  PinnedRuntimeProbeLegs,
} from "./materialized-resume.ts";

export { acquireHandoffLease, createHandoffBarrier, HANDOFF_STEPS, HandoffLeaseError, HandoffPlanError, releaseHandoffLease, validateSessionTranscript } from "./handoff-barrier.ts";
export type {
  CompatibilityLevel,
  DetailedHandoffOutcome,
  HandoffBarrierDeps,
  HandoffBarrierHandle,
  HandoffDestinationRuntime,
  HandoffEligibilityLike,
  HandoffOwnerHealth,
  HandoffParticipants,
  HandoffResumeTarget,
  HandoffSourceOwner,
  HandoffStepReport,
  TranscriptValidation,
} from "./handoff-barrier.ts";
