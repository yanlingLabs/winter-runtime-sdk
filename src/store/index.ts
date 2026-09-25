// Lane C's one import site (P7b Task 4).
//
// The PACKAGE's barrel is `src/index.ts` and it is spine-owned; what it exports is the SEAM a HOST
// programs against. This file is what a TEST (and the spine's own wiring) needs: the factories behind
// the seams and the store-side vocabulary that has no seam of its own.
//
// WS-23: the handoff barrier, the materialized-resume decorator, its pinned probe reports and the
// temp-continuity layer went with the official runtime they moved sessions onto; `reviewSwitch` and
// the provider-state sidecar reader are what survive of them.
export {
  assertOneSharedStore,
  lazySharedSessionStore,
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
  isJournalKey,
  isTranscriptPath,
  localTranscriptPath,
  reconcileLocalWriteRoot,
  scanLocalWriteRoot,
  TranscriptReconcileError,
} from "./reconcile.ts";
export type { LocalTranscript, ReconcileReport, TailComparison, TranscriptReconcileHook, TranscriptReconciler, TranscriptReconcileOutcome } from "./reconcile.ts";

export { HANDOFF_ENTRY_LABEL, providerStateSidecarPath, PROVIDER_STATE_SUFFIX, readProviderStateSidecar } from "./provider-state.ts";
export { createSwitchReviewer, SwitchReviewError } from "./review-switch.ts";
export type { SwitchReviewerDeps, SwitchReviewerHandle } from "./review-switch.ts";
