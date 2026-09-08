// WS-15 §6.2–6.4 (D19b's relocation): THE CROSS-RUNTIME MESSAGING SEAM. Lane B implements it in
// `src/messaging/**`, composing the SDK subpath's router core (R-7b-4) with two adapters.
//
// TWO DOORS, and the difference matters:
//   * `send()` takes the model-facing shape (a `to` STRING that still has to be resolved) and runs
//     the whole pipeline: resolution (WS-10 §11) → inbound policy (WS-15 §6.3, "in the router BEFORE
//     any adapter delivery") → the adapter. This is the door the aliased send-message tool on the
//     Winter MCP server reaches (WS-14 §7's `toolAliases`; the tool's own name is brand-derived and
//     is never spelled outside the brand module).
//   * `deliver()` takes an already-addressed envelope. This is the internal door: a held message
//     being released after a restart, a reply being routed back.
// Both answer with the same ten-arm `DeliveryOutcome`. WS-10 §12: a crash between invoking and
// recording is `delivery_uncertain` — "the system MUST NOT advertise exactly-once or unconditional
// effectively-once delivery across both runtimes".
import type { DeliveryOutcome, GlobalAgentMessage, ListedRuntimeObject, PermissionClassLabel, RuntimeAddress, RuntimeKind, RuntimeMessagingAdapter } from "./messaging-contract.ts";

/** WS-10 §10.1's model-facing send, after the tool layer has validated `to` (≤300 chars, no newline, `"*"` forbidden). */
export interface SendMessageRequest {
  from: RuntimeAddress;
  /** The raw target string as the model wrote it. Resolution is the directory's job, never the caller's. */
  to: string;
  body: string;
  summary?: string;
  notifyWhenIdle?: boolean;
  /** The tool call this send came from — WS-10 §12 derives the message id from (sender, tool call). */
  originToolCallId?: string;
}

/** WS-15 §6.2. Lane B implements; the spine pins the signature. */
export interface GlobalMessaging {
  /** WS-10 §10.2: what this sender can reach right now. Never enumerates exited transcripts on disk. */
  listReachable(scope: { from: RuntimeAddress }): Promise<ListedRuntimeObject[]>;
  send(request: SendMessageRequest): Promise<DeliveryOutcome>;
  deliver(message: GlobalAgentMessage): Promise<DeliveryOutcome>;
  /** WS-10 §14's 12-hour idle subscription. */
  notifyWhenIdle(target: RuntimeAddress, request: { from: RuntimeAddress; messageId: string }): Promise<DeliveryOutcome>;
  /** WS-10 §13's inbound class for a given object, as the policy matrix reads it. */
  senderPermissionClass(address: RuntimeAddress): Promise<PermissionClassLabel>;
  /** One adapter per runtime kind; registering the same kind twice replaces it. */
  registerAdapter(kind: RuntimeKind, adapter: RuntimeMessagingAdapter): void;
}
