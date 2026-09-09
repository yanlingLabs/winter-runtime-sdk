// WS-14 §7: `toolAliases` AND THE DENY FLOOR.
//
// "`toolAliases` maps model-emitted built-in names to the product's MCP handlers": `SendMessage`
// resolves to the standing server's `send_message`, `ListAgents` to its `list_agents`. Both canonical
// names are spelled by `mcpToolName(brand, …)` and never as a literal — see the last paragraph.
//
// FOUR NORMATIVE CONSTRAINTS, and three of them are about what aliasing is NOT:
//
//   * Resolution is SINGLE-HOP and applies to name-based lookup of MODEL-EMITTED `tool_use` blocks
//     only. A harness-internal call that already holds a tool object never passes through it.
//   * Aliases are NOT A SECURITY BOUNDARY. `disallowedTools` plus the receiver-side policy floor are
//     the enforcement mechanism for the paths aliases miss — which is why `officialDisallowedTools`
//     lives beside the alias map rather than somewhere else.
//   * Aliasing does not change the MODEL-VISIBLE SCHEMA. A capture of the pinned runtime with
//     `SendMessage` aliased still advertised the NATIVE `SendMessage` schema — and also advertised the
//     MCP tool under its canonical name. So handlers MUST accept the native argument schemas EXACTLY;
//     "a different schema requires a separately named MCP tool, never an incompatible alias target".
//   * The canonical duplicates SHOULD be deferred/hidden so the model normally sees one of each.
//
// MEASURED, NOT ASSUMED (this repository's own loopback capture against 0.3.250, recorded in the Lane
// A report): with both aliases set, the live request's tool list contained `SendMessage` and
// `ListAgents` AND both server-qualified canonical twins, and a model-emitted `SendMessage` reached
// the canonical handler with `{to, message}` untouched. Both halves of the third constraint are
// therefore observed behaviour: the native schema survives, and the duplicate is really there to be
// hidden.
//
// THE TARGETS ARE BRAND-DERIVED. `mcpToolName(brand, "send_message")` is the only spelling; a literal
// would point a reuser's alias at a server they do not run.
import { mcpToolName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/** The two built-ins WS-14 §7 redirects, and the canonical tool each resolves to. */
export const ALIASED_BUILTINS = [
  { builtin: "SendMessage", tool: "send_message" },
  { builtin: "ListAgents", tool: "list_agents" },
] as const;

export type AliasedBuiltin = (typeof ALIASED_BUILTINS)[number]["builtin"];

/** §2's `toolAliases` value: `{ SendMessage: "mcp__<server>__send_message", … }`. */
export function officialToolAliases(brand: Pick<BrandProfile, "mcpServerName">): Record<string, string> {
  return Object.fromEntries(ALIASED_BUILTINS.map(({ builtin, tool }) => [builtin, mcpToolName(brand, tool)]));
}

/** The canonical name one aliased built-in resolves to (single hop — never a chain). */
export function aliasTargetFor(builtin: AliasedBuiltin, brand: Pick<BrandProfile, "mcpServerName">): string {
  const entry = ALIASED_BUILTINS.find((candidate) => candidate.builtin === builtin);
  /* c8 ignore next */
  if (entry === undefined) throw new TypeError(`not an aliased builtin: ${String(builtin)}`);
  return mcpToolName(brand, entry.tool);
}

// --------------------------------------------------------------------------------------------------
// The NATIVE argument schemas (WS-10 §10.1/§10.2), mirrored so the handler can accept them exactly.
// --------------------------------------------------------------------------------------------------
//
// INDEPENDENTLY AUTHORED, and a deliberate MIRROR of the Winter branch's own descriptors rather than
// a variant: the two branches must present "this EXACT model-facing schema" (WS-10 §10.1), and the
// alias makes that a hard requirement rather than a nicety — the model emits the native block and the
// canonical handler is what receives it.

/** WS-10 §10.1's constraints on `to`: required, ≤300 chars, no newline, and never the broadcast star. */
export const SEND_MESSAGE_TO_MAX = 300;
export const SEND_MESSAGE_SUMMARY_MAX = 200;

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
    channel: { type: "string", maxLength: 256, description: "reserved" },
    q: { type: "string", maxLength: 256, description: "reserved" },
  },
} as const;

/** WS-10 §10.2: "`ListAgents` output is EXACTLY `{ listing: string }`." */
export const NATIVE_LIST_AGENTS_OUTPUT_SCHEMA = {
  type: "object",
  properties: { listing: { type: "string" } },
  required: ["listing"],
} as const;

/** The native `SendMessage` arguments, after validation. */
export interface NativeSendMessageArgs {
  to: string;
  message: string;
  summary?: string;
  notify_when_idle?: boolean;
}

export interface NativeListAgentsArgs {
  channel?: string;
  q?: string;
}

export type NativeArgsResult<T> = { ok: true; args: T } | { ok: false; reason: string };

/**
 * Accepts the native `SendMessage` arguments EXACTLY — no more, no less.
 *
 * "No more" matters as much as "no less": an alias target that quietly accepted an extra field would
 * be a second, undocumented schema reachable only through the alias, which is precisely the
 * "incompatible alias target" §7 forbids. A refusal is DATA rather than a throw, because the handler
 * turns it into a tool_result the model can read and correct.
 */
export function acceptNativeSendMessageArgs(input: unknown): NativeArgsResult<NativeSendMessageArgs> {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "expected an object of SendMessage arguments" };
  const record = input as Record<string, unknown>;
  const known = new Set(Object.keys(NATIVE_SEND_MESSAGE_SCHEMA.properties));
  const extra = Object.keys(record).filter((key) => !known.has(key));
  if (extra.length > 0) return { ok: false, reason: `unknown argument(s): ${extra.join(", ")}` };
  const { to, message, summary, notify_when_idle: notifyWhenIdle } = record;
  if (typeof to !== "string" || to.length === 0) return { ok: false, reason: "`to` is required and must be a string" };
  if (to.length > SEND_MESSAGE_TO_MAX) return { ok: false, reason: `\`to\` must be at most ${SEND_MESSAGE_TO_MAX} characters` };
  if (to.includes("\n")) return { ok: false, reason: "`to` must not contain a newline" };
  if (to === "*") return { ok: false, reason: "broadcast is not addressable: `to` must name one recipient" };
  if (typeof message !== "string") return { ok: false, reason: "`message` is required and must be a string" };
  if (summary !== undefined && (typeof summary !== "string" || summary.length > SEND_MESSAGE_SUMMARY_MAX)) {
    return { ok: false, reason: `\`summary\` must be a string of at most ${SEND_MESSAGE_SUMMARY_MAX} characters` };
  }
  if (notifyWhenIdle !== undefined && typeof notifyWhenIdle !== "boolean") return { ok: false, reason: "`notify_when_idle` must be a boolean" };
  return {
    ok: true,
    args: {
      to,
      message,
      ...(summary === undefined ? {} : { summary }),
      ...(notifyWhenIdle === undefined ? {} : { notify_when_idle: notifyWhenIdle }),
    },
  };
}

/** The same treatment for `ListAgents`: both fields are reserved, both optional, nothing else. */
export function acceptNativeListAgentsArgs(input: unknown): NativeArgsResult<NativeListAgentsArgs> {
  if (input === undefined || input === null) return { ok: true, args: {} };
  if (typeof input !== "object") return { ok: false, reason: "expected an object of ListAgents arguments" };
  const record = input as Record<string, unknown>;
  const known = new Set(Object.keys(NATIVE_LIST_AGENTS_SCHEMA.properties));
  const extra = Object.keys(record).filter((key) => !known.has(key));
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

/**
 * How the canonical duplicates are exposed (§7's "SHOULD be deferred/hidden").
 *
 * `deferred` and not `hidden`: a hidden tool is unreachable by name, and the canonical name is
 * exactly what a HOST-INTERNAL caller (and the router's own cross-runtime path) addresses. Deferring
 * keeps it addressable while keeping it out of the default advertised set — which is the behaviour
 * the Winter branch's own canonical twin already declares at its source.
 *
 * ON THE OFFICIAL BRANCH THIS IS AN INTENT, NOT AN ENFORCEMENT, and the distinction is recorded
 * rather than papered over: the pinned runtime decides MCP-tool visibility itself, and the capture
 * above shows both duplicates advertised in a session with no Tool Search active. WS-17 row 2 asks
 * for exactly that measurement ("canonical MCP duplicate deferred/hidden visibility; behaviour
 * without Tool Search"), and `test/official/runtime-aliases.test.ts` records what 0.3.250 does rather
 * than asserting what we wish it did.
 */
export const CANONICAL_DUPLICATE_EXPOSURE = "deferred" as const;

/**
 * BOTH NAMES A DENY RULE MUST CARRY — and this is a MEASUREMENT, not a belt-and-braces habit.
 *
 * Driven against the pinned 0.3.250 runtime (`test/official/runtime-aliases.test.ts`, row 3):
 *
 *   `disallowedTools: ["SendMessage"]`                       → the model emits `SendMessage`, the
 *                                                              alias resolves, AND THE HANDLER RUNS.
 *   `disallowedTools: [<the canonical target>]`              → the call is blocked.
 *
 * So the deny check happens AFTER alias resolution, against the resolved name. A host that denied
 * only the built-in — the obvious reading of "deny `SendMessage`" — would have a deny rule that does
 * nothing at all, silently, on this branch only. §7's "aliases are NOT a security boundary" is
 * exactly this fact, and this function is how a caller stops tripping over it: one built-in in, both
 * names out.
 */
export function aliasDenyNames(builtin: AliasedBuiltin, brand: Pick<BrandProfile, "mcpServerName">): readonly string[] {
  return [builtin, aliasTargetFor(builtin, brand)];
}
