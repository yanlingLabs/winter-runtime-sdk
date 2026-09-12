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
// `src/testing/` is NOT exported. It wires `@yanlinglabs/winter-conformance` and
// `@yanlinglabs/winter-provider-conformance` — DEV dependencies — into `bun test`; a published
// subpath for it would name imports a consumer never installed, and the installed-tarball smoke
// (which walks every declared `exports` entry) would fail on it. Tests reach it by relative path.
export * from "@yanlinglabs/winter-agent-sdk";

// --- the constructor, the handle, the door ---------------------------------------------------------
export { createRuntimeSdk, forwardableOptions, runtimeSdkInternals, ROUTER_ONLY_OPTION_KEYS } from "./sdk.ts";
export type { RouterOnlyOptionKey, RouterOptions, RouterRuntimeInput, RuntimeSdk, RuntimeSdkInternals, RuntimeSdkOptions, RuntimeSdkPeers } from "./sdk.ts";

// --- D19a: the version matrix ----------------------------------------------------------------------
export { assertVersionMatrix, parseVersion, readExportedVersion, readResolvedManifestVersion, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS, VERSION_EXPORT_NAMES } from "./version-matrix.ts";
export type { PeerVersionIdentity, PeerVersionSource, VersionMatrixReport } from "./version-matrix.ts";

// --- D13/D28: selection and its persisted choice ---------------------------------------------------
export { isSelectionRefusal, selectChildRuntime, selectRuntime, SelectionRefusedError } from "./selection/runtime-selection.ts";
export type { ChildSelectionInput, CredentialPresence, RuntimeKind, RuntimeSelection, SelectionInput, SelectionRefusal } from "./selection/runtime-selection.ts";
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
// R-7b-12: the pin's own materialized-resume verdict, so a host can read WHY its handoffs decorate.
export { MATERIALIZED_RESUME_PROBE_REPORTS, materializedResumeReportForPin } from "./store/pinned-probes.ts";
// The README tells a host to READ this set rather than trust a description of it (round 3, NEW-H), so
// it has to be reachable from the package a host installs — not only from the official lane's barrel.
export { EXECUTION_INDIRECTION_ENV_NAMES, EXECUTION_INDIRECTION_ENV_PREFIXES, isExecutionIndirectionVariable } from "./official/env-allowlist.ts";
// R-7b-11's four, for the same reason: the README says the router disables the runtime's remote
// feature configuration by default, and a host should be able to READ the set rather than trust prose.
export { TRAFFIC_OPT_OUT_VARIABLES, TRAFFIC_OPT_OUT_VARIABLE_NAMES } from "./official/env-allowlist.ts";
// THE TOOL SURFACE IS NOT HERE (ruling P-7, R-8-1). The native schemas, their bounds, their
// acceptors, the handler factories and the advisor all live in `@yanlinglabs/winter-agent-sdk/tools`
// — one declaration for both hosts — and this package re-exports none of them: the router owns no
// tool, so it publishes no tool surface. A host that needs them imports the SDK it already depends on.

// --- the seams (interfaces the four lanes implement behind) ----------------------------------------
export * from "./seams/index.ts";

// --- typed errors ----------------------------------------------------------------------------------
export { NotImplementedYet, RuntimeHandoffRequiredError, RuntimeLaunchInputError, RuntimeSdkDisposedError, RuntimeSdkError, RuntimeSdkVersionError, UnaddressableEntryError } from "./errors.ts";
// --- the door's official leg (Task 6b) -------------------------------------------------------------
export { createOfficialInputStream, isOfficialQuery, officialCredentialPlan, officialConnectionEnv, officialUserTurn } from "./door.ts";
export type { OfficialInputStream, RouterOfficialInput, RouterOfficialPolicy, RouterQuery } from "./door.ts";
export type { LaneId } from "./errors.ts";

// --- P8c-13: the official-leg HOST SURFACE ----------------------------------------------------------
//
// Norma (the host) bridges its own approval broker into `canUseTool` and materializes MCP servers
// from the router's descriptors; before this cut, neither was reachable from the package root.
// `buildOfficialOptions` uses `policy.canUseTool` verbatim and `assertOptionsInvariants` refuses
// anything not built by `createApprovalBridge` — so a host needs THAT constructor, not a hand-rolled
// substitute. These are re-exports of `./official/*` names that are already the seam's own contract
// (`RouterOfficialPolicy` above already types with several of them); this block is what makes them
// importable without reaching into `./official/index.ts`, which is a TEST import site, not a host one.
//
// DELIBERATELY NOT HERE: the spawn-proxy/adapter internals (`createSupervisedSpawnProxy`,
// `createOfficialAdapter`, `ProcessIdentity`, `SpawnChild`, …). Their declaration graph pulls
// `node:stream`/`node:module` types into a consumer that only wants the approval bridge and the MCP
// materializer; the installed-tarball smoke's runtime import of "." would still pass either way (Node
// erases types), but a host's own `tsc` run over the root barrel would carry Node-only types it never
// asked for. The door (`createRuntimeSdk`) reaches the adapter through the seam, not through a name a
// consumer imports — see `./official/index.ts`'s own header.
export { createApprovalBridge, isOurApprovalBridge } from "./official/callbacks.ts";
export type { ApprovalBroker, ApprovalRequest, ApprovalBridgeOptions, DecisionSource, OfficialPermissionMode, OfficialApprovalBridge } from "./official/callbacks.ts";

export { materializeOfficialMcpServer, officialMcpServers, winterMcpServerDescriptor, canonicalToolNames, OFFICIAL_MATERIALIZATION_DROPS } from "./official/mcp-descriptors.ts";
export type { OfficialMcpModule, InputShapeFactory, JsonSchemaObject, WinterMcpServerDescriptor, WinterMcpToolDescriptor, WinterMcpHandler, WinterMcpToolResult } from "./official/mcp-descriptors.ts";

export { minimalOsEnvironmentFrom, buildOfficialChildEnv } from "./official/env-allowlist.ts";
export type { OfficialEnvPolicy, OfficialEnvInput, EnvAllowlistSnapshot } from "./official/env-allowlist.ts";

export type { OptionsTemplatePolicy } from "./official/options-template.ts";
export type { ContainmentPolicy, ContainmentDisposition } from "./official/containment.ts";
export type { AuthCredentialPlan, AuthFamily, ClaudeOauthGate } from "./official/auth.ts";

export { containmentDispositions, officialDisallowedTools } from "./official/containment.ts";

export { officialBranchLabel, OFFICIAL_DISCLOSURES } from "./official/branding.ts";

// R-7b's attributed-turn renderer for inbound messages (WS-15 §6): already the messaging lane's own
// export (`./messaging/index.ts`), re-exported here so a host reads it off the package root rather
// than a lane barrel it should not otherwise need.
export { renderAttributedTurn } from "./messaging/index.ts";

// --- WS-15 §6.1–6.4: the directory and the cross-runtime messaging router (Lane B; the three doors a host needs + their vocabulary) ---
export { createRuntimeMessaging, createAttachedSessionRegistry } from "./messaging/index.ts";
export type {
  AttachedOfficialSession, AttachedSession, AttachedSessionRegistry, AttachedWinterSession,
  DirectorySnapshot, GlobalMessagingHandle, GlobalMessagingOptions, ReplyRequest, RouterMessagingAdapter,
  RuntimeDirectoryHandle, RuntimeDirectoryOptions, RuntimeDirectoryRecoveryHooks,
} from "./messaging/index.ts";

// --- P8c-13 fix round 2: the HANDOFF PARTICIPANT types (types only) --------------------------------
//
// `createHandoffBarrier`/`HandoffBarrierHandle` were already reachable from root via `./seams/index.ts`
// (`HandoffBarrier`/`HandoffOutcome`/`HandoffPlan`/`HandoffStep`/`HandoffStepNumber`), but the DATA
// shapes a host actually renders a plan/outcome FROM — who owns the session today, what the destination
// would run, what step 8 hands the destination, per-step results, the eligibility check, the detailed
// outcome, and the barrier's own construction deps — were not: `src/store/index.ts` exports all of
// them, but nothing in `src/index.ts` ever imported that lane barrel. Named directly off the files that
// DECLARE them (`./store/handoff-barrier.ts`, `./seams/handoff.ts`, `./store/materialized-resume.ts`)
// rather than through `./store/index.ts`, matching how the rest of this barrel reaches into a lane —
// confirmed pure data: none of the three files' EMITTED declarations names a `node:*` specifier (the
// value-level `node:fs`/`node:crypto` imports their implementations use never appear in the .d.ts,
// since nothing exported here has a node-typed member).
export type {
  DetailedHandoffOutcome, HandoffBarrierDeps, HandoffDestinationRuntime, HandoffEligibilityLike,
  HandoffOwnerHealth, HandoffParticipants, HandoffResumeTarget, HandoffSourceOwner, HandoffStepReport,
} from "./store/handoff-barrier.ts";
export type { HandoffSelection } from "./seams/handoff.ts";
// `HandoffBarrierDeps.decorator` is typed with this — a host building `HandoffBarrierDeps` needs the
// name to type it, not only the barrier's own construction path.
export type { MaterializedResumeDecoratorHandle } from "./store/materialized-resume.ts";
