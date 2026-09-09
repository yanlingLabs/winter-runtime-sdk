// THE MESSAGING SHAPES — now a RE-EXPORT, which is the one edit this file was ever going to need.
//
// D19b moved the messaging contract, the resolution rules, the inbound policy, the mailbox, the idle
// subscriptions and the router core OUT of the private Winter runtime and INTO the SDK package as the
// subpath `@yanlinglabs/winter-agent-sdk/messaging` (R-7b-4, Phase 7b Task 0). On the day the spine
// was written that subpath did not exist, so this file carried the same declarations copied VERBATIM
// from the module Task 0 moved, with its header naming the flip and who makes it. Task 0 has landed
// (SDK `v0.0.2`, `packages/sdk/src/messaging/`), so this is that flip.
//
// WHY THE SWAP COST NO LANE A LINE: TypeScript compares interfaces structurally, and the copy was
// character-identical to the original, so every lane that wrote against these names keeps compiling
// against the same shapes — now with ONE declaration behind them instead of two that could drift.
//
// WHAT IS STILL DECLARED HERE, and why exactly one thing is: `RuntimeKind`. The router declares it in
// `src/selection/runtime-selection.ts` (D13's persisted choice is where the union is load-bearing)
// and the subpath declares its own, character-identical, copy. Re-exporting the SELECTION one keeps
// this package's `RuntimeKind` a single name with a single declaration site — a lane's
// `RuntimeSelection.runtimeKind` and a lane's `RuntimeAddress.runtimeKind` are then the same type by
// identity rather than by coincidence.
//
// NO LOGIC IS RE-EXPORTED FROM HERE, deliberately, and that is unchanged from the copy: not
// `serializeRuntimeAddress`, not the outcome constructors, not the caps. A lane imports every
// FUNCTION straight from `@yanlinglabs/winter-agent-sdk/messaging`, so there is exactly one import
// site for "the rules" and this file stays what its name says — the seam's type surface.
import type { RuntimeKind } from "../selection/runtime-selection.ts";

export type { RuntimeKind };

export type {
  /** WS-10 §11 (messaging companion §4). */
  RuntimeObjectKind,
  /** WS-10 §11's addressing record. `winterSessionId` is the product id (`s_<hex>`, WS-01 §4). */
  RuntimeAddress,
  /** WS-10 §10.2's listing element. */
  ListedRuntimeObject,
  /** WS-15 §6.2 / WS-10 §12's outcome union — ten arms, no eleventh. */
  DeliveryOutcome,
  /** WS-10 §13's inbound classes. */
  PermissionClassLabel,
  /** The fully-resolved, ADDRESSED envelope — never the model-facing `SendMessage` input schema. */
  GlobalAgentMessage,
  /** WS-10 §15's runtime adapter contract. Lane B implements two of these. */
  RuntimeMessagingAdapter,
} from "@yanlinglabs/winter-agent-sdk/messaging";

/**
 * WS-10 §11's opaque serialization: `session:<winterSessionId>` / `agent:<parent>:<childId>`.
 *
 * Runtime kind and backend ids live in the directory record, never trusted from user or model text —
 * which is why a router that parses one of these must overlay `runtimeKind` from its own entry (the
 * subpath's own barrel says so at length; `resolveTarget` does it wherever a listing row is at hand).
 *
 * DECLARED HERE rather than re-exported: the subpath types a serialized address as the bare `string`
 * on `ListedRuntimeObject.address`, and this alias is the router's name for that string — the key
 * every `RuntimeDirectoryStore` method takes.
 */
export type SerializedRuntimeAddress = string;
