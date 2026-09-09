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
import { validateToField } from "@yanlinglabs/winter-agent-sdk/messaging";
import type { DeliveryOutcome } from "@yanlinglabs/winter-agent-sdk/messaging";

import { callerAddressOf, type GlobalMessagingHandle } from "./router.ts";

/** WS-10 §10.1's pinned bounds. `to` is validated by the subpath's own `validateToField`. */
export const SEND_MESSAGE_SUMMARY_MAX = 200;

/** The native `SendMessage` arguments (WS-10 §10.1), after validation. */
export interface NativeSendMessageArgs {
  to: string;
  message: string;
  summary?: string;
  notify_when_idle?: boolean;
}

/** The native `ListAgents` arguments (WS-10 §10.2). Both fields are reserved in the pinned build. */
export interface NativeListAgentsArgs {
  channel?: string;
  q?: string;
}

export type NativeArgsResult<T> = { ok: true; args: T } | { ok: false; reason: string };

const SEND_MESSAGE_FIELDS = new Set(["to", "message", "summary", "notify_when_idle"]);
const LIST_AGENTS_FIELDS = new Set(["channel", "q"]);

/**
 * Accept the native `SendMessage` arguments EXACTLY.
 *
 * `to`'s own rules (required, ≤300 chars, no newline, never the `"*"` broadcast) come from the
 * subpath's `validateToField` rather than from a second copy here — the Winter branch's tool surface
 * validates with the same function, so "both runtime branches MUST present this exact model-facing
 * schema" (WS-10 §10.1) is true by construction rather than by review.
 */
export function acceptNativeSendMessageArgs(input: unknown): NativeArgsResult<NativeSendMessageArgs> {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "expected an object of SendMessage arguments" };
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !SEND_MESSAGE_FIELDS.has(key));
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };
  const to = record["to"];
  const validated = validateToField(to);
  if (!validated.ok) return { ok: false, reason: validated.message };
  const message = record["message"];
  if (typeof message !== "string") return { ok: false, reason: "`message` is required and must be a string (an empty string is a pure idle subscription)" };
  const summary = record["summary"];
  if (summary !== undefined && (typeof summary !== "string" || summary.length > SEND_MESSAGE_SUMMARY_MAX)) {
    return { ok: false, reason: `\`summary\` must be a string of at most ${SEND_MESSAGE_SUMMARY_MAX} characters` };
  }
  const notify = record["notify_when_idle"];
  if (notify !== undefined && typeof notify !== "boolean") return { ok: false, reason: "`notify_when_idle` must be a boolean" };
  return {
    ok: true,
    args: {
      to: to as string,
      message,
      ...(summary === undefined ? {} : { summary: summary as string }),
      ...(notify === undefined ? {} : { notify_when_idle: notify }),
    },
  };
}

/** The same treatment for `ListAgents`: two reserved optional fields, both ≤256 chars, nothing else. */
export function acceptNativeListAgentsArgs(input: unknown): NativeArgsResult<NativeListAgentsArgs> {
  if (input === undefined || input === null) return { ok: true, args: {} };
  if (typeof input !== "object") return { ok: false, reason: "expected an object of ListAgents arguments" };
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !LIST_AGENTS_FIELDS.has(key));
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };
  for (const field of ["channel", "q"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > 256)) return { ok: false, reason: `\`${field}\` must be a string of at most 256 characters` };
  }
  return {
    ok: true,
    args: {
      ...(typeof record["channel"] === "string" ? { channel: record["channel"] } : {}),
      ...(typeof record["q"] === "string" ? { q: record["q"] } : {}),
    },
  };
}

/** The MCP result shape both branches return — structurally the descriptor's own (WS-14 §11). */
export interface MessagingToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type MessagingToolHandler = (args: unknown) => Promise<MessagingToolResult>;

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
    async sendMessage(rawArgs) {
      const accepted = acceptNativeSendMessageArgs(rawArgs);
      if (!accepted.ok) return text(accepted.reason, true);
      const who = identity();
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
