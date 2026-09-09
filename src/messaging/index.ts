// The messaging lane, as one import site — and one composite factory, because the directory and the
// router are two halves of one thing.
//
// `createRuntimeMessaging` exists for the circularity the two halves genuinely have: the directory
// renders a `ChildLike` for every child row, and the two doors that interface requires (`steer`,
// `resume`) are the ROUTER's to answer — while the router resolves every address through the
// DIRECTORY. Building them separately and wiring them afterwards is possible (both factories are
// exported), but it is the kind of two-step a caller gets wrong once and then debugs for an hour, so
// the composed door is the one the package leads with.
export { createRuntimeDirectory } from "../directory/directory.ts";
export type { DirectorySnapshot, RuntimeDirectoryHandle, RuntimeDirectoryOptions } from "../directory/directory.ts";
export type { RuntimeDirectoryRecoveryHooks } from "../directory/recovery.ts";
export { entryToChildLike, entryToListedRuntimeObject, entryToListedRuntimeObjectList, isListableFrom, isLiveStatus, isResolvableFrom, mergeAdapterOwnedFields, owningSessionIdOf, parentAddressOf, sessionAddressOf } from "../directory/entries.ts";

export { createGlobalMessaging, callerAddressOf, deriveMessageId } from "./router.ts";
export type { GlobalMessagingContext, GlobalMessagingHandle, GlobalMessagingOptions, ReplyRequest } from "./router.ts";
export { createWinterMessagingAdapter } from "./winter-adapter.ts";
export type { WinterMessagingAdapter, WinterMessagingAdapterDeps } from "./winter-adapter.ts";
export { createOfficialMessagingAdapter } from "./official-adapter.ts";
export type { OfficialMessagingAdapter, OfficialMessagingAdapterDeps } from "./official-adapter.ts";
export { createDispatchingAdapter } from "./dispatch.ts";
export type { DispatchDeps, RouterMessagingAdapter } from "./dispatch.ts";
export { createInboundPolicy } from "./inbound.ts";
export type { InboundPolicy, InboundPolicyDeps, InboundPolicyHooks, InboundVerdict } from "./inbound.ts";
export { createAttachedSessionRegistry } from "./sessions.ts";
export type { AttachedOfficialSession, AttachedSession, AttachedSessionRegistry, AttachedWinterSession, LiveSessionStatus } from "./sessions.ts";
export { renderAttributedTurn, renderOwnerQualifiedTurn, UnattributableSenderError } from "./attribution.ts";
export { acceptNativeListAgentsArgs, acceptNativeSendMessageArgs, createMessagingToolHandlers, SEND_MESSAGE_SUMMARY_MAX } from "./handlers.ts";
export type { MessagingToolCaller, MessagingToolHandler, MessagingToolHandlers, MessagingToolResult, NativeListAgentsArgs, NativeSendMessageArgs, NativeArgsResult } from "./handlers.ts";

import { createRuntimeDirectory, type RuntimeDirectoryHandle, type RuntimeDirectoryOptions } from "../directory/directory.ts";
import type { SeamContext } from "../seams/context.ts";
import { createGlobalMessaging, type GlobalMessagingHandle, type GlobalMessagingOptions } from "./router.ts";

export interface RuntimeMessaging {
  directory: RuntimeDirectoryHandle;
  messaging: GlobalMessagingHandle;
}

/**
 * The directory and the router, built together and wired to each other.
 *
 * THE ONE WIRE THAT IS EASY TO MISS: the directory's `ChildLike` view delivers through the ROUTER, so
 * a caller that used `ChildLike.steer`/`resume` (the router core never does — see `entryToChildLike`)
 * reaches the child's own runtime adapter rather than a stub. It is a late binding on purpose: the
 * router does not exist yet when the directory is constructed, so the hook closes over a variable
 * that is assigned one line later.
 */
export function createRuntimeMessaging(context: SeamContext, options: { directory?: RuntimeDirectoryOptions; messaging?: GlobalMessagingOptions } = {}): RuntimeMessaging {
  let messaging: GlobalMessagingHandle | undefined;
  const directory = createRuntimeDirectory(context, {
    ...(options.directory ?? {}),
    deliverToChild: async (entry, message) => {
      /* c8 ignore next */
      if (messaging === undefined) throw new Error("winter-runtime-sdk: the messaging router is not built yet"); // unreachable: assigned on the next line, and nothing delivers during construction
      return messaging.deliver({ ...message, to: entry.parsed, toGeneration: entry.generation });
    },
  });
  messaging = createGlobalMessaging({ ...context, directory }, options.messaging ?? {});
  return { directory, messaging };
}
