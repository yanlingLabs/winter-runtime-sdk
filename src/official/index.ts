// The official-SDK adapter (WS-14 §1–§15), as one import site.
//
// NOT RE-EXPORTED FROM `src/index.ts`, and that is deliberate rather than an omission: the package's
// public barrel is spine-owned, and the router's own door (`createRuntimeSdk`) reaches this adapter
// through the seam rather than through a name a consumer imports. What a HOST needs from here is the
// seam's `OfficialAdapter`, which `src/index.ts` already exports; what a TEST needs is this file.
export { createOfficialAdapter, officialHandoffEligibility } from "./adapter.ts";
export type { HandoffEligibility, OfficialAdapterHandle, OfficialAdapterPolicy, OfficialSessionHandle, OfficialSessionHealth } from "./adapter.ts";

export {
  ALIASED_BUILTINS,
  CANONICAL_DUPLICATE_EXPOSURE,
  aliasDenyNames,
  NATIVE_LIST_AGENTS_OUTPUT_SCHEMA,
  NATIVE_LIST_AGENTS_SCHEMA,
  NATIVE_SEND_MESSAGE_SCHEMA,
  acceptNativeListAgentsArgs,
  acceptNativeSendMessageArgs,
  aliasTargetFor,
  officialToolAliases,
} from "./aliases.ts";
export type { AliasedBuiltin, NativeArgsResult, NativeListAgentsArgs, NativeSendMessageArgs } from "./aliases.ts";

export { ALL_AUTH_VARIABLES, AUTH_FAMILY_VARIABLES, NEVER_INJECTED_AUTH_VARIABLES, allowedAuthVariables, authVariableSetKey, fetchAuthCredentials, validateAuthEnvironment } from "./auth.ts";
export type { AuthCredentialPlan, AuthFamily, AuthVariableSetKey, ClaudeOauthGate } from "./auth.ts";

export { OFFICIAL_DISCLOSURES, officialBranchLabel } from "./branding.ts";
export type { OfficialDisclosure } from "./branding.ts";

export { APPROVAL_BRIDGE_MARK, CONTAINMENT_FLOOR_MARK, carriesMark, createApprovalBridge, createContainmentHooks, createFirstResponseWins, revalidateResumedDecision } from "./callbacks.ts";
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

export { FORBIDDEN_TARGETS, VENDOR_HOME_SEGMENT_RE, containmentDecisionFor, containmentDispositions, containmentPaths, officialDisallowedTools, targetsForbiddenPath } from "./containment.ts";
export type { ContainmentDecision, ContainmentDisposition, ContainmentPaths, ContainmentPolicy, SavedApprovalDisposition } from "./containment.ts";

export {
  MINIMAL_OS_VARIABLES,
  sanitizePathListValue,
  MINIMAL_OS_VARIABLE_PREFIXES,
  OFFICIAL_RUNTIME_VARIABLES,
  PINNED_OFFICIAL_RUNTIME,
  PROXY_AND_TELEMETRY_PREFIXES,
  PROXY_AND_TELEMETRY_VARIABLES,
  assertNoForbiddenChildVariables,
  buildOfficialChildEnv,
  minimalOsEnvironmentFrom,
  officialEnvAllowlistNames,
  officialEnvAllowlistSnapshot,
} from "./env-allowlist.ts";
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

export { OFFICIAL_MATERIALIZATION_DROPS, assertNoAdvisor, canonicalToolNames, materializeOfficialMcpServer, messagingToolDescriptors, officialMcpServers, winterMcpServerDescriptor } from "./mcp-descriptors.ts";
export type { InputShapeFactory, JsonSchemaObject, MessagingHandlers, OfficialMcpModule, WinterMcpHandler, WinterMcpServerDescriptor, WinterMcpToolDescriptor, WinterMcpToolResult } from "./mcp-descriptors.ts";

export { AUTO_MEMORY_LOAD_CAP, DEFAULT_EXCLUDE_DYNAMIC_SECTIONS, PINNED_SYSTEM_PROMPT_PRESET, assertOptionsInvariants, brandedFlagSettings, buildOfficialOptions, captureOptions, mergeHooks } from "./options-template.ts";
export type { OptionsTemplatePolicy } from "./options-template.ts";

export { RESUME_STAGING_PREFIX, SPOOL_SEGMENTS, classifyLocalWriteRoot, isResumeStagingRoot, officialSpoolRoot, resumeStagingRoot, validateObservedConfigDir, vendorTempRootReport } from "./spool.ts";
export type { LocalWriteRootKind, ObservedLocalWriteRoot, VendorTempRootReport } from "./spool.ts";

export { createSupervisedSpawnProxy, directoryRecordSink, prepareDefaultSpawn } from "./spawn-proxy.ts";
export type { ProcessIdentity, SpawnChild, SpawnObservation, SpawnRecordSink, SpawnedChildProcess, SupervisedSpawnProxy, SupervisedSpawnProxyOptions, TranscriptReconcile } from "./spawn-proxy.ts";

export { SWEPT_TARGETS, SWEPT_TOOLS, createContainmentSweep, forbiddenArtifactsUnder } from "./sweep.ts";
export type { ContainmentBreach, ContainmentSweep, ContainmentSweepOptions } from "./sweep.ts";

export { CANCELLATION_MAPPINGS, DEFAULT_SESSION_QUOTAS, cancellationMappingFor, crashClassOf, interruptionFor, isProcessCrash, revalidateProcessIdentity } from "./supervision.ts";
export type { CancellationGesture, CancellationMapping } from "./supervision.ts";
