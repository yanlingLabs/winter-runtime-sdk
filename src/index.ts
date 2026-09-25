// `@yanlinglabs/winter-runtime-sdk` — the public barrel.
//
// TWO HALVES, and the first one is the contract:
//
//   1. THE WINTER SDK'S ENTIRE PUBLIC SURFACE, re-exported. `query`, `Options`, `Query`, `SdkMessage`
//      and every named variant, `SessionStore`/`WinterCompatibilitySessionStore`, `BrandProfile`/
//      `WINTER_BRAND`/`resolveBrand`, `ModelFamilyListing`, `PermissionResult`, the settings surface,
//      the hooks surface, the wire types, the error classes — all of it.
//
//      A STAR RE-EXPORT, NOT A HAND-WRITTEN LIST, and that is the whole design decision. The plan's
//      constraint is "the pinned Options/Query/SDKMessage contract loses no member and gains nothing
//      the Winter SDK does not already export". A list of 231 names would satisfy that on the day it
//      was written and would be one SDK release away from being wrong, silently, in the direction
//      nobody checks (a member that stopped being re-exported does not fail anything here — it fails
//      in a host, as a missing import, months later). `export *` makes losing a member IMPOSSIBLE,
//      and `test/spine/contract-reexport.test.ts` pins the other direction: every runtime export of
//      the Winter barrel is present here under the same name AND is the same object.
//
//      A name declared BELOW shadows a star-exported one of the same name (the ES module rule TS
//      implements), so the router's own names always win; the contract test asserts no such shadow
//      exists by accident.
//
//   2. THE ROUTER'S OWN NAMES: the constructor and its handle, the version matrix, the selection
//      contract, the seams every lane implements behind, and the typed errors.
//
// WS-23: the official leg's host surface (the door's official input, the approval bridge, the MCP
// materializer, the child-env builder, the containment and branding tables) and the handoff barrier's
// participant types are gone with the official `claude` runtime. The env-refusal sets the README tells
// a host to read stay, from their new home (`run-home/env-refusals.ts`).
//
// `src/testing/` is NOT exported. It wires `@yanlinglabs/winter-conformance` and
// `@yanlinglabs/winter-provider-conformance` — DEV dependencies — into `bun test`; a published
// subpath for it would name imports a consumer never installed, and the installed-tarball smoke
// (which walks every declared `exports` entry) would fail on it. Tests reach it by relative path.
export * from "@yanlinglabs/winter-agent-sdk";

// --- the constructor, the handle, the door ---------------------------------------------------------
export { createRuntimeSdk, forwardableOptions, runtimeSdkInternals, ROUTER_ONLY_OPTION_KEYS } from "./sdk.ts";
export type { RouterOnlyOptionKey, RouterOptions, RouterRuntimeInput, RuntimeSdk, RuntimeSdkInternals, RuntimeSdkOptions, RuntimeSdkPeers, WinterLegRuntimeInput } from "./sdk.ts";

// --- WS-21 Contract A: the run home (the daemon builds one per generation; the router applies it) ---
export { buildRunHome } from "./run-home/build.ts";
export { escapeRulePath, fsRootAnchored, protectedPathRules, PROTECTED_ITEM_DIRS, RUN_HOME_CONTRACT_VERSION, RUN_HOME_PERSISTENT_ENTRIES, sdkHomeOf } from "./run-home/types.ts";
export { escapeSandboxGlobPath } from "./run-home/settings.ts";
export type { RunHome, RunHomeBrand, RunHomeFor, RunHomeForContext, RunHomeInput, RunHomeOutcome, RunHomeReport, RunLeg, RunMode } from "./run-home/types.ts";
export type { RecoveryReport, RecoveryTranscriptOutcome } from "./run-home/exit.ts";
export { RunHomeError } from "./run-home/errors.ts";
export type { RunHomeErrorCode } from "./run-home/errors.ts";
// The ONE reconcile (spec §3.8): exported so a reader can see the function every exit and recovery
// reconcile goes through. The daemon never calls it itself — it goes through the handle's
// `runHomeOutcome`/`reconcileRootForRecovery`, which run it with the router's own live store.
export { reconcileLocalWriteRoot } from "./store/reconcile.ts";
export type { ReconcileReport, TailComparison, TranscriptReconcileOutcome } from "./store/reconcile.ts";

// --- D19a: the version matrix ----------------------------------------------------------------------
export { assertVersionMatrix, parseVersion, readExportedVersion, readResolvedManifestVersion, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS, VERSION_EXPORT_NAMES } from "./version-matrix.ts";
export type { PeerVersionIdentity, PeerVersionSource, VersionMatrixReport } from "./version-matrix.ts";

// --- D13/D28: selection and its persisted choice ---------------------------------------------------
export { isSelectionRefusal, selectChildRuntime, selectRuntime, SelectionRefusedError } from "./selection/runtime-selection.ts";
export type { ChildSelectionInput, CredentialPresence, RuntimeKind, RuntimeSelection, SelectionAlternative, SelectionInput, SelectionRefusal } from "./selection/runtime-selection.ts";
// Lane D's three doors and the vocabulary they speak (review r1 N1's trimmed set; controller-applied at merge).
export { CHILD_PROVIDER_UNAVAILABLE, resumeChildSelection, selectChildRuntimePairing } from "./selection/child-runtime.ts";
export type { ChildResumeOutcome, ChildRuntimePairing } from "./selection/child-runtime.ts";
export type { ProviderAuthView, SelectionAuthFamily, SelectionVersions } from "./selection/runtime-selection.ts";
export { D14_CLAUDE_OAUTH_APPROVED_DEFAULT, SELECTION_RULES, UNKNOWN_VERSION, reviewPersistedSelection, ruleIdOf, selectionVersionsFrom } from "./selection/select-runtime.ts";
export type { SelectionReview, SelectionRuleId } from "./selection/select-runtime.ts";

// --- the two modules NEITHER lane owns, each defined once and exported here once (review r4, N13) ---
//
// Both were written twice, in parallel trees, by lanes that could not see each other: the vendor's
// staging-root vocabulary (Lane A recognises one, Lane C stages one — with MIRRORED argument orders)
// and WS-10 §10.1/§10.2's model-facing schemas with their acceptors (Lane A's alias target, Lane B's
// canonical handler — already drifted on what `to` may contain). Neither is a lane's to own, so
// neither sits on a lane barrel; `test/spine/barrel-exports.test.ts` pins that no name is exported by
// two of them again.
export { RESUME_STAGING_PREFIX, isResumeStagingRoot, resumeStagingRoot } from "./vendor-paths.ts";
// The README tells a host to READ this set rather than trust a description of it (round 3, NEW-H), so
// it has to be reachable from the package a host installs. WS-23: a run home refuses these from a
// settings file's `env` (they moved out of the retired official lane with that job).
export { EXECUTION_INDIRECTION_ENV_NAMES, EXECUTION_INDIRECTION_ENV_PREFIXES, isExecutionIndirectionVariable } from "./run-home/env-refusals.ts";
// R-7b-11's four, for the same reason.
export { TRAFFIC_OPT_OUT_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "./run-home/env-refusals.ts";
// THE TOOL SURFACE IS NOT HERE (ruling P-7, R-8-1). The native schemas, their bounds, their
// acceptors, the handler factories and the advisor all live in `@yanlinglabs/winter-agent-sdk/tools`
// — one declaration for both hosts — and this package re-exports none of them: the router owns no
// tool, so it publishes no tool surface. A host that needs them imports the SDK it already depends on.

// --- the seams (interfaces the four lanes implement behind) ----------------------------------------
export * from "./seams/index.ts";

// --- typed errors ----------------------------------------------------------------------------------
export { NotImplementedYet, RuntimeLaunchInputError, RuntimeSdkDisposedError, RuntimeSdkError, RuntimeSdkVersionError, UnaddressableEntryError } from "./errors.ts";

// R-7b's attributed-turn renderer for inbound messages (WS-15 §6): already the messaging lane's own
// export (`./messaging/index.ts`), re-exported here so a host reads it off the package root rather
// than a lane barrel it should not otherwise need.
export { renderAttributedTurn } from "./messaging/index.ts";

// --- WS-15 §6.1–6.4: the directory and the cross-runtime messaging router (Lane B; the three doors a host needs + their vocabulary) ---
export { createRuntimeMessaging, createAttachedSessionRegistry } from "./messaging/index.ts";
export type {
  AttachedSession, AttachedSessionRegistry, AttachedWinterSession,
  DirectorySnapshot, GlobalMessagingHandle, GlobalMessagingOptions, ReplyRequest, RouterMessagingAdapter,
  RuntimeDirectoryHandle, RuntimeDirectoryOptions, RuntimeDirectoryRecoveryHooks,
} from "./messaging/index.ts";

// WS-18 W18-20 (P10b, fix round 1): the catalog-backed DEFAULT `resolveEndpoint` the switch review
// falls back to when a host injects none. Exported so a host can call it directly (e.g. to warm the
// cache, or to use the same default in its own tooling) rather than only ever reaching it as a
// fallback.
export { defaultEndpointResolver } from "./default-endpoint-resolver.ts";
// WS-23: the switch review, as a host reaches it (`runtimeSdkInternals(sdk).barrier`), and its typed
// "not in the runtime directory" refusal.
export { SwitchReviewError } from "./store/review-switch.ts";
export type { SwitchReviewerDeps, SwitchReviewerHandle } from "./store/review-switch.ts";
