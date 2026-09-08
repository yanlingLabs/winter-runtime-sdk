// The seams, as one import site.
//
// SPINE-OWNED (P7b Task 1). Every lane implements behind these signatures and none of them edits this
// directory: a change here is a NEEDS_CONTEXT with the exact diff, because four lanes are compiling
// against it at the same time. The one file with a scheduled edit is `messaging-contract.ts`, whose
// header names the flip and who makes it.
export type { SeamContext, SeamContextWithDirectory } from "./context.ts";
export type { RuntimeDirectory, DirectoryResolution, DirectoryResolutionContext, RuntimeDirectoryRecovery, RuntimeDirectoryRecoveryStep } from "./directory.ts";
export type {
  CursorStore,
  DeliveryRecord,
  DeliveryRecordStore,
  HeldMessageRecord,
  IdleSubscriptionRecord,
  IdleSubscriptionStore,
  MailboxStore,
  NameLeaseRecord,
  NameLeaseStore,
  RuntimeDirectoryEntry,
  RuntimeDirectoryStore,
  RuntimeTransport,
} from "./directory-store.ts";
export { createInMemoryRuntimeDirectoryStore } from "./directory-store.ts";
export type { GlobalMessaging, SendMessageRequest } from "./global-messaging.ts";
export type { HandoffBarrier, HandoffOutcome, HandoffPlan, HandoffStep, HandoffStepNumber } from "./handoff.ts";
export type { KeychainSeam } from "./keychain.ts";
export type {
  MaterializedResumeDecorator,
  MaterializedResumeDoor,
  MaterializedResumeInput,
  MaterializedResumeProbeId,
  MaterializedResumeProbeReport,
  MaterializedResumeProbeResult,
  MaterializedResumeResult,
} from "./materialized-resume.ts";
export type {
  DeliveryOutcome,
  GlobalAgentMessage,
  ListedRuntimeObject,
  PermissionClassLabel,
  RuntimeAddress,
  RuntimeMessagingAdapter,
  RuntimeObjectKind,
  SerializedRuntimeAddress,
} from "./messaging-contract.ts";
export type {
  OfficialSdkModule,
  OfficialSpawnOptions,
  OfficialSpawnedProcess,
} from "./official-sdk-shapes.ts";
export type {
  EnvInput,
  OfficialAdapter,
  OfficialLaunchPlan,
  OfficialLaunchProfile,
  OfficialOptions,
  OfficialQuery,
  OfficialResumePlan,
  OfficialSession,
  OfficialSpawnClaudeCodeProcess,
  OfficialUserMessage,
  OptionsTemplateInput,
} from "./official-adapter.ts";
