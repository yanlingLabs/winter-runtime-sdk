// WS-14 §7's TWO HANDLERS — the ones the official branch's `toolAliases` redirect the model's native
// `SendMessage`/`ListAgents` into, and the ones the Winter branch registers under the same canonical
// names (WS-14 §11's "registered identically into BOTH SDK branches").
//
// THE ALIAS IS THE WHOLE REASON THE SCHEMAS ARE MIRRORED EXACTLY. "Aliasing does not change the
// model-visible schema": with `SendMessage` aliased, the runtime still advertises the NATIVE
// `SendMessage` schema and the model emits a native block — which arrives HERE. So "handlers MUST
// accept the native argument schemas exactly", and a handler that quietly accepted an extra field
// would be a second, undocumented schema reachable only through the alias.
//
// "NO MORE" MATTERS AS MUCH AS "NO LESS", and both are enforced below. The acceptor is deliberately
// its own function rather than a `try`/`catch` around the router: a refusal is DATA the model reads
// and corrects from, not an exception.
//
// WHAT THESE HANDLERS ARE NOT: the router. They validate, they name the caller, they render the
// outcome. Resolution, policy, the ledger and the adapters are all above/below them, once, for both
// branches — which is what makes the two branches' behaviour the same behaviour rather than the same
// intention.
import type { DeliveryOutcome } from "@yanlinglabs/winter-agent-sdk/messaging";

import { callerAddressOf, type GlobalMessagingHandle } from "./router.ts";
// ONE definition of the model-facing schemas and their acceptors, shared with the official branch's
// alias targets (review r4, N13). WS-10 §10.1 requires "this exact model-facing schema" on BOTH
// branches, and two copies is how that stops being true; see `src/native-args.ts`'s header.
import { acceptNativeListAgentsArgs, acceptNativeSendMessageArgs } from "../native-args.ts";

/** The MCP result shape both branches return — structurally the descriptor's own (WS-14 §11). */
export interface MessagingToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type MessagingToolHandler = (args: unknown, extra?: unknown) => Promise<MessagingToolResult>;

/**
 * WS-10 §12's RETRY KEY, on the official branch — and it exists, which was not known until it was
 * measured (item 15; `test/official/runtime-aliases.test.ts` is the measurement).
 *
 * §12 wants a message id derived from (sender session, TOOL-CALL id) so "a retry allocates the SAME
 * id" and returns the stored outcome instead of starting a second turn. On the Winter branch the
 * caller binds `toolUseId` at registration. On the official branch the handler is inside the vendor's
 * in-process MCP server, where the only per-call channel is the second argument the vendor passes —
 * and the reasonable expectation was that it carries MCP request context (a JSON-RPC request id,
 * `_meta`) rather than an Anthropic-API `tool_use_id`, which is one layer up.
 *
 * THE PINNED RUNTIME BRIDGES THEM. Measured on 0.3.250: `extra._meta["claudecode/toolUseId"]` is the
 * exact id the model emitted. So the official branch gets a real §12 key rather than depending on the
 * rapid-repeat guard, and the vendor's own namespaced `_meta` name is read rather than guessed at.
 *
 * A VENDOR-NAMESPACED KEY IS NEVER REBRANDED (WS-01 §5): `claudecode/toolUseId` is the vendor's name
 * for the vendor's field, exactly like `CLAUDE_CONFIG_DIR`. It is read defensively — an absent or
 * non-string value simply falls back to the bound caller's id — because a future pin may move it, and
 * losing the key must degrade to today's behaviour rather than to a crash.
 */
export const VENDOR_TOOL_USE_ID_META_KEY = "claudecode/toolUseId";

export function toolUseIdFromExtra(extra: unknown): string | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const meta = (extra as { _meta?: unknown })._meta;
  if (typeof meta !== "object" || meta === null) return undefined;
  const id = (meta as Record<string, unknown>)[VENDOR_TOOL_USE_ID_META_KEY];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export interface MessagingToolHandlers {
  sendMessage: MessagingToolHandler;
  listAgents: MessagingToolHandler;
}

/**
 * WHO IS CALLING — bound at registration, never read out of the arguments.
 *
 * The standing MCP server is materialized per session (WS-14 §11), so the caller is known when the
 * handler is built. Taking it from the ARGUMENTS instead would make the sender's identity something a
 * model could write, and every fence in this package — the owning-parent rule, the self-target
 * refusal, WS-10 §13's sender class, WS-15 §6.2's dedupe key — is keyed on it.
 *
 * `toolUseId` is the second half of WS-10 §12's retry key. It is OPTIONAL because on the official
 * branch it is not available: the in-process MCP server hands a tool handler its arguments, and the
 * router's own materialization does not forward the vendor's `extra` (which is where a request id
 * would be). A caller that cannot supply one gets no dedupe — stated at the door rather than faked
 * with a stable-looking key that would make two different messages one.
 */
export interface MessagingToolCaller {
  sessionId: string;
  agentId?: string;
  toolUseId?: string;
}

/** Outcomes that mean "this did not happen, and the model should do something else". */
const MODEL_FACING_FAILURES: ReadonlySet<DeliveryOutcome["status"]> = new Set(["refused", "ambiguous", "not_found", "unavailable"]);

function text(body: string, isError = false): MessagingToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

export function createMessagingToolHandlers(messaging: GlobalMessagingHandle, caller: MessagingToolCaller | (() => MessagingToolCaller)): MessagingToolHandlers {
  const identity = (): MessagingToolCaller => (typeof caller === "function" ? caller() : caller);

  return {
    async sendMessage(rawArgs, extra) {
      const accepted = acceptNativeSendMessageArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const bound = identity();
      // THE PER-CALL TOOL-USE ID WINS (item 15). On the official branch the caller is bound once at
      // registration and cannot know it; the vendor's `extra` carries the id of THIS call, which is
      // exactly what §12's retry key is derived from. On the Winter branch there is no `extra` and
      // the bound value is already the right one, so this is additive in both directions.
      const perCall = toolUseIdFromExtra(extra);
      const who: MessagingToolCaller = perCall === undefined ? bound : { ...bound, toolUseId: perCall };
      const from = callerAddressOf(who);
      const result = await messaging.sendDetailed({
        from,
        to: accepted.args.to,
        body: accepted.args.message,
        ...(accepted.args.summary === undefined ? {} : { summary: accepted.args.summary }),
        ...(accepted.args.notify_when_idle === undefined ? {} : { notifyWhenIdle: accepted.args.notify_when_idle }),
        ...(who.toolUseId === undefined ? {} : { originToolCallId: who.toolUseId }),
      });
      // WS-10 §10.1: the result "reports success/message and MAY include a message ID, routing/receipt
      // information … or a CLASSIFIED FAILURE" — so the typed outcome IS the result, rendered whole.
      // The supplementary `notify` fact rides beside it rather than as an eleventh outcome status,
      // which is the shape the shared core already chose for a combined call.
      const payload = result.notify === undefined ? result.outcome : { ...result.outcome, notify: result.notify };
      return text(JSON.stringify(payload), MODEL_FACING_FAILURES.has(result.outcome.status));
    },

    async listAgents(rawArgs) {
      const accepted = acceptNativeListAgentsArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const from = callerAddressOf(identity());
      const rows = await messaging.listReachable({ from });
      // WS-10 §10.2: "Output is EXACTLY `{ listing: string }`" — one string field, and nothing else.
      // The rows behind it are never enumerated as structured output here, and an exited transcript is
      // never among them: the listing view drops exited sessions by construction (`isListableFrom`).
      const listing =
        rows.length === 0
          ? "No agents or sessions are currently reachable."
          : rows.map((row) => `- ${row.name === undefined ? row.address : `${row.name} (${row.address})`} [${row.objectKind}/${row.runtimeKind}] status=${row.status} mode=${row.mode}`).join("\n");
      return text(JSON.stringify({ listing }));
    },
  };
}
