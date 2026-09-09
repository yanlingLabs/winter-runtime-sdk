// HOW A DELIVERED MESSAGE IS RENDERED INTO A RECEIVING SESSION'S INPUT — the router's half.
//
// The Winter runtime renders an attributed turn itself, on the far side of the wire, whenever the
// facet delivers (`packages/runtime/src/engine.ts`'s `renderAttributedTurn`). The router only renders
// when IT owns the input stream — an official session, or a Winter session the router launched and
// holds a writer for — and the two renderings must be the SAME STRING, or a receiving model would see
// two conventions and could not tell which one a real attribution looks like.
//
// SO THE ESCAPES COME FROM THE SUBPATH, NOT FROM HERE. `AGENT_MESSAGE_TAG`,
// `escapeAttributionText` and `escapeAttributionAttribute` are published by
// `@yanlinglabs/winter-agent-sdk/messaging` for exactly this reason (Task 0 fix r2, N2: "published so
// the router renders identically rather than growing a second convention"). What this module owns is
// the ORDER of the fields and the one refusal below.
//
// WHY THE ESCAPING IS LOAD-BEARING, restated because it is easy to read as decoration: `body` and
// `summary` are MODEL-AUTHORED (they come straight off a `SendMessage` tool input), so without
// escaping a sender can close the frame and open a second one naming an address it does not own with
// `sender-permission-class="bypasses"`. `from` is router-authored (WS-10 §15: "the daemon authors
// canonical addresses") and is the field that cannot be forged; escaping is what stops the FRAME from
// being forged around it. It remains lexical, not structural — the carry recorded by Task 0 stands.
import { AGENT_MESSAGE_TAG, escapeAttributionAttribute, escapeAttributionText, serializeRuntimeAddress } from "@yanlinglabs/winter-agent-sdk/messaging";

import type { GlobalAgentMessage, RuntimeAddress } from "../seams/messaging-contract.ts";

/** A sender whose `from` cannot be turned into a canonical address cannot be attributed at all. */
export class UnattributableSenderError extends Error {
  constructor(reason: string) {
    super(`the message cannot be attributed to a sender: ${reason}`);
    this.name = "UnattributableSenderError";
  }
}

/**
 * THE OWNER CHECK ON ITS OWN — the reason this envelope cannot be attributed here, or `undefined`.
 *
 * SEPARATED FROM THE RENDERING (review r1, D1) because it is a DECISION and rendering is an effect,
 * and the three delivery paths need the decision at a different moment than the string: before any
 * push, outside every `try`, so that one envelope gets one answer whichever handle shape a host
 * attached. Evaluated inside a `try` whose `catch` maps to `delivery_uncertain`, the same refusal
 * became "the delivery may have occurred" for a message that provably never left the router — and
 * WS-10 §12's recovery contract then forbids retrying it, so a clean side-effect-free "no" turned into
 * a permanently ambiguous record.
 *
 * `owner` is the session whose input stream this is going into. A claimed CHILD sender is only
 * attributable by the session that owns that child (WS-10 §10.3), so an `agent:` origin from somewhere
 * else is refused rather than rendered with an address this side cannot vouch for. Pass `undefined` to
 * skip the check — for the official branch's owner-qualified relay, where the message is deliberately
 * being handed to a parent that does NOT own the sender.
 */
export function unattributableReason(message: GlobalAgentMessage, owner?: { winterSessionId: string }): string | undefined {
  let from: string;
  try {
    from = serializeRuntimeAddress(message.from);
  } catch {
    return "the envelope's `from` is not a canonical address";
  }
  if (owner !== undefined && message.from.objectKind === "agent") {
    const senderOwner = message.from.parentWinterSessionId ?? message.from.winterSessionId;
    if (senderOwner !== owner.winterSessionId) {
      return `the envelope claims to come from "${from}", which this session does not own`;
    }
  }
  return undefined;
}

/**
 * The attributed turn, byte-for-byte as the Winter runtime renders it.
 *
 * Throws `UnattributableSenderError` on the same condition `unattributableReason` names, so a caller
 * that renders without checking still cannot produce an unattributable frame — but every caller in
 * this package checks FIRST, because a throw at this point is an effect-free refusal and must be
 * reported as one.
 */
export function renderAttributedTurn(message: GlobalAgentMessage, owner?: { winterSessionId: string }): string {
  const refusal = unattributableReason(message, owner);
  if (refusal !== undefined) throw new UnattributableSenderError(refusal);
  const from = serializeRuntimeAddress(message.from);
  const summary = message.summary !== undefined ? `\n<summary>${escapeAttributionText(message.summary)}</summary>` : "";
  const open = `<${AGENT_MESSAGE_TAG} from="${escapeAttributionAttribute(from)}" message-id="${escapeAttributionAttribute(message.messageId)}" sender-permission-class="${escapeAttributionAttribute(message.senderPermissionClass)}">`;
  return `${open}${summary}\n${escapeAttributionText(message.body)}\n</${AGENT_MESSAGE_TAG}>`;
}

/**
 * The owner-qualified form: the same frame, plus the address the message was actually FOR.
 *
 * WS-15 §6.2's official-child rows are the only user: "Native child messaging through the active
 * owning parent session", and "the public result stays owner-qualified" — the official runtime has no
 * out-of-band door into a child, so a message for one is delivered to the owning parent, which is a
 * different fact from a message TO the parent and must not read like one. The `for` attribute is
 * router-authored (it is the resolved canonical address, not anything a sender wrote), so it is
 * escaped for the same defensive reason `from` is and can no more be forged than `from` can.
 */
export function renderOwnerQualifiedTurn(message: GlobalAgentMessage, target: RuntimeAddress): string {
  const rendered = renderAttributedTurn(message);
  const forAttribute = ` for="${escapeAttributionAttribute(serializeRuntimeAddress(target))}"`;
  const open = `<${AGENT_MESSAGE_TAG} `;
  /* c8 ignore next */
  if (!rendered.startsWith(open)) throw new UnattributableSenderError("the rendered frame did not start with its own opening tag"); // unreachable: renderAttributedTurn builds it
  return `${open.slice(0, open.length - 1)}${forAttribute}${rendered.slice(open.length - 1)}`;
}
