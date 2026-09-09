// WS-10 §10.1/§10.2's MODEL-FACING SCHEMAS AND THE ACCEPTORS THAT ENFORCE THEM — one definition,
// shared by both runtime branches.
//
// WHY THIS MODULE EXISTS (review r4, N13's rule, applied to the second duplicate the gate found).
// Two lanes needed the same acceptor and each wrote its own: `src/official/aliases.ts` (the alias
// target the model's NATIVE block lands in) and `src/messaging/handlers.ts` (the canonical MCP tool
// the Winter branch registers). They were near-identical — and where they differed, they differed on
// the model-visible contract: one refused a bare `"*"` and the other refused `"*"` ANYWHERE, and the
// two returned different refusal prose for the same input. WS-10 §10.1 says "both runtime branches
// MUST present this exact model-facing schema", so a second copy is not duplication to tidy up: it is
// the schema drifting between branches, in the one place a test in either lane cannot see.
//
// `to` IS VALIDATED BY THE SDK SUBPATH'S OWN `validateToField`, never by a third copy here. The
// Winter branch's tool surface validates with that function, so "the same schema on both branches"
// is true by construction rather than by review — and a change to §10.1's rules arrives with the SDK
// instead of needing to be noticed here.
//
// A REFUSAL IS DATA, NOT A THROW. The handler turns it into a `tool_result` the model reads and
// corrects from; an exception would be a crash the model never sees. And "no more" matters as much
// as "no less": an acceptor that quietly took an extra field would be a second, undocumented schema
// reachable only through the alias — precisely the "incompatible alias target" WS-14 §7 forbids.
import { validateToField } from "@yanlinglabs/winter-agent-sdk/messaging";

/** WS-10 §10.1's bounds. `to`'s own limit is the subpath's; this is the copy the SCHEMA advertises. */
export const SEND_MESSAGE_TO_MAX = 300;
export const SEND_MESSAGE_SUMMARY_MAX = 200;
/** WS-10 §10.2's bound on both reserved `ListAgents` fields. */
export const LIST_AGENTS_FIELD_MAX = 256;

export const NATIVE_SEND_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    to: { type: "string", maxLength: SEND_MESSAGE_TO_MAX, description: 'no newline, no "*" broadcast' },
    message: { type: "string", description: 'required; defaults "" for pure idle subscription' },
    summary: { type: "string", maxLength: SEND_MESSAGE_SUMMARY_MAX },
    notify_when_idle: { type: "boolean", description: "one-shot; main conversation -> same-machine session only" },
  },
  required: ["to", "message"],
} as const;

export const NATIVE_LIST_AGENTS_SCHEMA = {
  type: "object",
  properties: {
    channel: { type: "string", maxLength: LIST_AGENTS_FIELD_MAX, description: "reserved" },
    q: { type: "string", maxLength: LIST_AGENTS_FIELD_MAX, description: "reserved" },
  },
} as const;

/** WS-10 §10.2: "`ListAgents` output is EXACTLY `{ listing: string }`." */
export const NATIVE_LIST_AGENTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: { listing: { type: "string" } },
  required: ["listing"],
} as const;

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

/**
 * The accepted field sets are READ OFF THE SCHEMAS, so the advertised schema and the enforced one
 * cannot drift apart — adding a property to a schema above is the whole change.
 */
const SEND_MESSAGE_FIELDS = new Set(Object.keys(NATIVE_SEND_MESSAGE_SCHEMA.properties));
const LIST_AGENTS_FIELDS = new Set(Object.keys(NATIVE_LIST_AGENTS_SCHEMA.properties));

/** Accepts the native `SendMessage` arguments EXACTLY — no more, no less. */
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

/** The same treatment for `ListAgents`: two reserved optional fields, both capped, nothing else. */
export function acceptNativeListAgentsArgs(input: unknown): NativeArgsResult<NativeListAgentsArgs> {
  if (input === undefined || input === null) return { ok: true, args: {} };
  if (typeof input !== "object") return { ok: false, reason: "expected an object of ListAgents arguments" };
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !LIST_AGENTS_FIELDS.has(key));
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };
  for (const field of ["channel", "q"] as const) {
    const value = record[field];
    if (value !== undefined && (typeof value !== "string" || value.length > LIST_AGENTS_FIELD_MAX)) {
      return { ok: false, reason: `\`${field}\` must be a string of at most ${LIST_AGENTS_FIELD_MAX} characters` };
    }
  }
  return {
    ok: true,
    args: {
      ...(typeof record["channel"] === "string" ? { channel: record["channel"] } : {}),
      ...(typeof record["q"] === "string" ? { q: record["q"] } : {}),
    },
  };
}
