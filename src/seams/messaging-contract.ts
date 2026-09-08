// THE MESSAGING SHAPES — a TEMPORARY home with a single, mechanical exit (R-7b-4, Task 0).
//
// D19b moves the messaging contract, the resolution rules, the inbound policy, the mailbox, the idle
// subscriptions and the router core OUT of the private Winter runtime and INTO the SDK package as the
// subpath `@yanlinglabs/winter-agent-sdk/messaging`. That move is Phase 7b's Task 0, running in
// PARALLEL with this spine in the SDK repository — so on the day this file was written the subpath
// did not exist and nothing here could import it.
//
// WHAT THIS FILE IS, THEN: the same declarations, copied VERBATIM from the module Task 0 moves
// (`packages/runtime/src/messaging/adapter.ts` at winter-agent-sdk main 224f750), so that the swap is
// type-identical. TypeScript compares interfaces structurally; two identical declarations are
// mutually assignable, so a lane that writes against these names today keeps compiling when the body
// of this file becomes:
//
//     export type { RuntimeAddress, RuntimeObjectKind, ListedRuntimeObject, DeliveryOutcome,
//                   GlobalAgentMessage, RuntimeMessagingAdapter } from "@yanlinglabs/winter-agent-sdk/messaging";
//
// THAT FLIP IS THE ONLY EDIT THIS FILE EVER NEEDS, and it belongs to Lane B (the messaging lane) as
// its first commit once Task 0's `v0.0.2` pin lands. It lives under `src/seams/` — spine-owned, one
// import site for every lane — precisely so the flip happens once instead of in six files.
//
// NO LOGIC LIVES HERE, deliberately: not `serializeRuntimeAddress`, not the outcome constructors, not
// the caps. Duplicated TYPES converge on one declaration by assignability; duplicated BEHAVIOUR
// diverges silently. Lane B imports every function from the subpath when it lands.
import type { RuntimeKind } from "../selection/runtime-selection.ts";

export type { RuntimeKind };

/** WS-10 §11 (messaging companion §4). */
export type RuntimeObjectKind = "session" | "agent";

/** WS-10 §11's addressing record. `winterSessionId` is the product id (`s_<hex>`, WS-01 §4). */
export interface RuntimeAddress {
  objectKind: RuntimeObjectKind;
  runtimeKind: RuntimeKind;
  winterSessionId: string;
  /** Absent only while "starting". */
  backendSessionId?: string;
  parentWinterSessionId?: string;
  childId?: string;
}

/**
 * WS-10 §11's opaque serialization: `session:<winterSessionId>` / `agent:<parent>:<childId>`.
 *
 * Runtime kind and backend ids live in the directory record, never trusted from user or model text.
 */
export type SerializedRuntimeAddress = string;

/** WS-10 §10.2's listing element. */
export interface ListedRuntimeObject {
  address: SerializedRuntimeAddress;
  name?: string;
  objectKind: RuntimeObjectKind;
  runtimeKind: RuntimeKind;
  status: "starting" | "running" | "idle" | "exited" | "unavailable" | "archived";
  mode: string;
  cwd?: string;
  capabilities: { message: boolean; resume: boolean; notifyWhenIdle: boolean; reply: boolean };
}

/** WS-15 §6.2 / WS-10 §12's outcome union, verbatim — ten arms, no eleventh. */
export type DeliveryOutcome =
  | { status: "delivered"; messageId: string }
  | { status: "queued"; messageId: string }
  | { status: "resumed_and_delivered"; messageId: string }
  | { status: "held"; messageId: string; reason: string }
  | { status: "subscribed"; messageId: string }
  | { status: "delivery_uncertain"; messageId: string; deliveryMayHaveOccurred: true; reason: string }
  | { status: "refused"; messageId: string; reason: string }
  | { status: "ambiguous"; messageId: string; candidates: ListedRuntimeObject[] }
  | { status: "not_found"; messageId: string; reason: string }
  | { status: "unavailable"; messageId: string; retryable: boolean; reason: string };

/** WS-10 §13's inbound classes. */
export type PermissionClassLabel = "prompts" | "bypasses" | "unknown";

/**
 * The fully-resolved, ADDRESSED envelope a router constructs once a target has been selected —
 * never the model-facing `SendMessage` input schema (WS-10 §10.1 owns that).
 */
export interface GlobalAgentMessage {
  messageId: string;
  from: RuntimeAddress;
  fromGeneration: number;
  to: RuntimeAddress;
  toGeneration: number;
  body: string;
  summary?: string;
  notifyWhenIdle: boolean;
  createdAt: number;
  expiresAt: number;
  hopCount: number;
  originToolCallId?: string;
  senderPermissionClass: PermissionClassLabel;
}

/**
 * WS-10 §15's runtime adapter contract, verbatim.
 *
 * Lane B implements TWO of these — Winter (a live session's `Query.messaging` facet plus an
 * input-stream push; an exited one via cold resume) and official (input-stream push; children through
 * the alias handlers on the Winter MCP server) — and composes them with the subpath's router core.
 * Adapters perform owner-specific operations ONLY: canonical addresses, inbox state, name leases and
 * delivery records are the router's.
 */
export interface RuntimeMessagingAdapter {
  listReachable(scope: { parent?: RuntimeAddress }): Promise<ListedRuntimeObject[]>;
  steerChild(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>;
  resumeChild(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>;
  deliverToSession(addr: RuntimeAddress, msg: GlobalAgentMessage): Promise<DeliveryOutcome>;
  subscribeIdle(addr: RuntimeAddress, req: { messageId: string }): Promise<DeliveryOutcome>;
  senderPermissionClass(addr: RuntimeAddress): Promise<PermissionClassLabel>;
}
