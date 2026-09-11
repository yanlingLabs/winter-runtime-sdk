// The official-SDK adapter (WS-14 §1–§15), as one import site.
//
// NOT RE-EXPORTED FROM `src/index.ts`, and that is deliberate rather than an omission: the package's
// public barrel is spine-owned, and the router's own door (`createRuntimeSdk`) reaches this adapter
// through the seam rather than through a name a consumer imports. What a HOST needs from here is the
// seam's `OfficialAdapter`, which `src/index.ts` already exports; what a TEST needs is this file.
export { createOfficialAdapter, officialHandoffEligibility } from "./adapter.ts";
export type { HandoffEligibility, OfficialAdapterHandle, OfficialAdapterPolicy, OfficialSessionHandle, OfficialSessionHealth } from "./adapter.ts";

// The native schemas and their acceptors are NOT here: WS-10 §10.1/§10.2's model-facing contract has
// ONE home for both branches, `src/native-args.ts`, and the package barrel exports it once (review
// r4, N13). `aliases.ts` re-exports them so the alias contract still reads in one place.
export { ALIASED_BUILTINS, CANONICAL_DUPLICATE_EXPOSURE, aliasDenyNames, aliasTargetFor, officialToolAliases } from "./aliases.ts";
export type { AliasedBuiltin } from "./aliases.ts";

export { NON_CREDENTIAL_ENV_REGISTRY, PINNED_ENV_REGISTRY_SIZE } from "./env-registry.ts";
export { CREDENTIAL_NAME_KEYWORDS, extractEnvRegistry, isCredentialByName } from "./env-registry-rule.ts";

export { ALL_AUTH_VARIABLES, AUTH_FAMILY_VARIABLES, AUTH_SHAPED_RE, NEVER_INJECTED_AUTH_VARIABLES, allowedAuthVariables, authVariableSetKey, fetchAuthCredentials, isAuthShapedVariable, validateAuthEnvironment } from "./auth.ts";
export type { AuthCredentialPlan, AuthFamily, AuthVariableSetKey, ClaudeOauthGate } from "./auth.ts";

export { OFFICIAL_DISCLOSURES, officialBranchLabel } from "./branding.ts";
export type { OfficialDisclosure } from "./branding.ts";

export { APPROVAL_BRIDGE_MARK, CONTAINMENT_FLOOR_MARK, carriesMark, createApprovalBridge, createContainmentHooks, createFirstResponseWins, isOurApprovalBridge, isOurContainmentHook, revalidateResumedDecision } from "./callbacks.ts";
export type {
  ApprovalBroker,
  ApprovalRequest,
  ApprovalBridgeOptions,
  ContainmentHooksOptions,
  DecisionContext,
  DecisionSource,
  OfficialApprovalBridge,
  OfficialHookOutput,
  OfficialPermissionMode,
  PreToolUseHookInput,
  ResumedDecision,
} from "./callbacks.ts";

export { FORBIDDEN_TARGETS, VENDOR_HOME_SEGMENT_RE, containmentDecisionFor, containmentDispositions, containmentPaths, officialDisallowedTools, resolveSavedApprovalDisposition, targetsForbiddenPath } from "./containment.ts";
export type { ContainmentDecision, ContainmentDisposition, ContainmentPaths, ContainmentPolicy, SavedApprovalDisposition } from "./containment.ts";

export {
  MINIMAL_OS_VARIABLES,
  sanitizePathListValue,
  MINIMAL_OS_VARIABLE_PREFIXES,
  OFFICIAL_RUNTIME_VARIABLES,
  PINNED_OFFICIAL_RUNTIME,
  PROXY_AND_TELEMETRY_PREFIXES,
  PROXY_AND_TELEMETRY_VARIABLES,
  TRAFFIC_OPT_OUT_VARIABLES,
  TRAFFIC_OPT_OUT_VARIABLE_NAMES,
  assertNoForbiddenChildVariables,
  buildOfficialChildEnv,
  minimalOsEnvironmentFrom,
  officialEnvAllowlistNames,
  officialEnvAllowlistSnapshot,
} from "./env-allowlist.ts";
export { EXECUTION_INDIRECTION_ENV_NAMES, EXECUTION_INDIRECTION_ENV_PREFIXES, isExecutionIndirectionVariable } from "./env-allowlist.ts";
export type { EnvAllowlistSnapshot, OfficialEnvInput, OfficialEnvPolicy } from "./env-allowlist.ts";

export {
  OFFICIAL_ERROR_CODES,
  OfficialStdoutUnterminatedError,
  OfficialAgentResultError,
  OfficialApiError,
  OfficialBranchError,
  OfficialConfigurationError,
  OfficialConnectionError,
  OfficialExecutableNotFoundError,
  OfficialInterruptedError,
  OfficialInvalidResumeError,
  OfficialKilledError,
  OfficialMcpError,
  OfficialNonzeroExitError,
  OfficialPermissionDeniedError,
  OfficialProtocolError,
  OfficialSessionNotFoundError,
  OfficialSessionStoreError,
  OfficialToolError,
  isOfficialBranchError,
} from "./errors.ts";
export type { OfficialCrashClass, OfficialErrorCode, WinterErrorClassName } from "./errors.ts";

export { OFFICIAL_MATERIALIZATION_DROPS, canonicalToolNames, materializeOfficialMcpServer, officialMcpServers, winterMcpServerDescriptor } from "./mcp-descriptors.ts";
export type { InputShapeFactory, JsonSchemaObject, OfficialMcpModule, WinterMcpHandler, WinterMcpServerDescriptor, WinterMcpToolDescriptor, WinterMcpToolResult } from "./mcp-descriptors.ts";

export { AUTO_MEMORY_LOAD_CAP, DEFAULT_EXCLUDE_DYNAMIC_SECTIONS, PINNED_SYSTEM_PROMPT_PRESET, assertOptionsInvariants, brandedFlagSettings, buildOfficialOptions, captureOptions, mergeHooks } from "./options-template.ts";
export type { OptionsTemplatePolicy } from "./options-template.ts";

// `RESUME_STAGING_PREFIX`/`resumeStagingRoot`/`isResumeStagingRoot` are NOT here: they are the
// vendor's own vocabulary, shared with Lane C, and they live in `src/vendor-paths.ts` with one
// definition and one argument order (review r4, N13). The package barrel exports them once.
export { SPOOL_SEGMENTS, classifyLocalWriteRoot, officialSpoolRoot, validateObservedConfigDir, vendorTempRootReport } from "./spool.ts";
export type { LocalWriteRootKind, ObservedLocalWriteRoot, VendorTempRootReport } from "./spool.ts";

export { createSupervisedSpawnProxy, directoryRecordSink, prepareDefaultSpawn } from "./spawn-proxy.ts";
export type { ProcessIdentity, SpawnChild, SpawnObservation, SpawnRecordSink, SpawnedChildProcess, SupervisedSpawnProxy, SupervisedSpawnProxyOptions, TranscriptReconcile } from "./spawn-proxy.ts";

export { POST_TOOL_EVENTS, SWEPT_TARGETS, SWEPT_TOOLS, createContainmentSweep, forbiddenArtifactsUnder } from "./sweep.ts";
export type { ContainmentBreach, ContainmentSweep, ContainmentSweepOptions } from "./sweep.ts";

export { CANCELLATION_MAPPINGS, DEFAULT_SESSION_QUOTAS, cancellationMappingFor, crashClassOf, interruptionFor, isProcessCrash, revalidateProcessIdentity } from "./supervision.ts";
export type { CancellationGesture, CancellationMapping } from "./supervision.ts";
