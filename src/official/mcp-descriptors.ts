// WS-14 §11: THE PRODUCT'S MCP SERVER, REGISTERED INTO THE OFFICIAL BRANCH — identically (D7).
//
// "The Winter MCP server is registered identically into BOTH SDK branches: `send_message`/
// `list_agents` handlers (§7) plus the browser, computer and office capability plugins, all under
// canonical names with identical description, schema, annotations, permission identity and result
// shape on both branches."
//
// AND IT DOES NOT CARRY AN ADVISOR. WS-14's advisor amendment (authority WS-06 D29): "the server
// registered into the official branch carries the messaging handlers and the capability plugins; it
// does NOT carry an advisor. On the official branch the model's `advisor` is Anthropic's API-side
// server tool (parameterless), Claude-family and Anthropic-chosen; Winter neither proxies nor
// replaces it (a host cannot bare-name a tool there and `toolAliases` cannot intercept a server
// tool)." `assertNoAdvisor` below is that rule as a refusal, and a test plants an advisor descriptor
// to prove the refusal fires.
//
// TWO LAYERS, AND THE SPLIT IS DELIBERATE:
//
//   DESCRIPTORS (this module's data) are RUNTIME-AGNOSTIC — name, description, JSON-Schema input,
//   annotations, exposure, permission identity, handler. They are what "identically into both
//   branches" means: one declaration, two registrations.
//
//   MATERIALIZATION (this module's function) turns them into whatever the OFFICIAL runtime's own
//   in-process server constructor wants. That constructor takes schemas in a validator library's own
//   shape, and this package deliberately depends on no validator: adding one to the router would put
//   a runtime dependency in a package whose entire design is "two injected peers and nothing else".
//   So the conversion is INJECTED (`toInputShape`) alongside the module, and the host — which already
//   has the official SDK and therefore its peer validator — supplies it in one line. The Lane A
//   report carries the worked example.
import { mcpToolName, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import { NATIVE_LIST_AGENTS_OUTPUT_SCHEMA, NATIVE_LIST_AGENTS_SCHEMA, NATIVE_SEND_MESSAGE_SCHEMA } from "./aliases.ts";
import { OfficialMcpError } from "./errors.ts";

/** A JSON-Schema object, in the subset the descriptors use. */
export interface JsonSchemaObject {
  type: "object";
  properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  required?: readonly string[];
}

/** What a handler answers with — the MCP content shape, identical on both branches. */
export interface WinterMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * A tool handler, and the vendor's own second argument (item 15).
 *
 * `extra` IS FORWARDED, NOT DROPPED — but what it CARRIES is a measurement, not an assumption. The
 * carry that produced this change asked for it so the official branch could derive WS-10 §12's retry
 * key (the (session, tool-call id) pair a retry must allocate the SAME message id from), and the
 * whole-branch review was right to say that must be checked first: the in-process server's `extra` is
 * the MCP REQUEST CONTEXT — the JSON-RPC request id and `_meta` — which is not the model's
 * `tool_use_id`. `test/official/runtime-aliases.test.ts` records what the pinned runtime actually
 * puts there; see that test and this module's own note below for the answer.
 *
 * Forwarding it is worth doing either way: it is the only channel the vendor gives a tool for request
 * context, dropping it is unrecoverable at the handler, and a handler that does not want it simply
 * declares one parameter.
 */
export type WinterMcpHandler = (args: unknown, extra?: unknown) => Promise<WinterMcpToolResult>;

/** One tool on the standing server. Everything a branch needs to register it, and nothing branch-specific. */
export interface WinterMcpToolDescriptor {
  /** The bare tool name (`send_message`); the canonical name is derived from it and the brand. */
  tool: string;
  description: string;
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  annotations?: Readonly<Record<string, unknown>>;
  /** WS-09 §10's exposure map. The canonical twins of aliased built-ins are deferred (§7). */
  exposure: "eager" | "deferred" | "hidden";
  /** The permission identity both branches must agree on (WS-07). */
  permissionClass: string;
  handler: WinterMcpHandler;
}

/** The standing server, as one descriptor. `name` is the brand's, so `mcp__<name>__<tool>` follows. */
export interface WinterMcpServerDescriptor {
  name: string;
  version: string;
  tools: readonly WinterMcpToolDescriptor[];
}

/** The two messaging handlers §7's aliases resolve to. Their implementations are the router's. */
export interface MessagingHandlers {
  sendMessage: WinterMcpHandler;
  listAgents: WinterMcpHandler;
}

/**
 * The messaging tools, with the NATIVE schemas mirrored (§7: "handlers MUST accept the native
 * argument schemas exactly").
 *
 * `deferred` on both: they are the canonical twins of aliased built-ins, and §7 wants the model to
 * see one `SendMessage`, not two.
 */
export function messagingToolDescriptors(handlers: MessagingHandlers): readonly WinterMcpToolDescriptor[] {
  return [
    {
      tool: "send_message",
      description:
        "Resolves `to` against the child registry, teammates and the live peer registry; steers a running child, resumes an addressable completed/stopped child, wakes an idle live peer, queues for a running peer; never cold-resumes an arbitrary exited transcript.",
      inputSchema: NATIVE_SEND_MESSAGE_SCHEMA as unknown as JsonSchemaObject,
      exposure: "deferred",
      permissionClass: "messaging",
      handler: handlers.sendMessage,
    },
    {
      tool: "list_agents",
      description: "Names/refs, activity/status and addressing identity for children, teammates and eligible live peers; never an enumeration of exited transcripts.",
      inputSchema: NATIVE_LIST_AGENTS_SCHEMA as unknown as JsonSchemaObject,
      outputSchema: NATIVE_LIST_AGENTS_OUTPUT_SCHEMA as unknown as JsonSchemaObject,
      exposure: "deferred",
      permissionClass: "messaging",
      handler: handlers.listAgents,
    },
  ];
}

/**
 * §11's refusal: no advisor on this server, on this branch.
 *
 * Thrown rather than filtered. A silent filter would leave a host believing its advisor was
 * registered and wondering why the model never calls it; the whole point of D29's split is that each
 * branch's advisor has a DIFFERENT backing, and a host that tried to register one here has a
 * misunderstanding worth surfacing.
 */
export function assertNoAdvisor(tools: readonly WinterMcpToolDescriptor[], branchLabel: string): void {
  const advisor = tools.find((tool) => tool.tool === "advisor" || tool.tool.endsWith("_advisor"));
  if (advisor !== undefined) {
    throw new OfficialMcpError({
      server: "the standing server",
      reason:
        "this branch's `advisor` is the provider's own API-side server tool: a host cannot bare-name a tool there and `toolAliases` cannot intercept a server tool, so registering one here would advertise a second, unreachable advisor (WS-14 §11 / WS-06 D29)",
      branchLabel,
    });
  }
}

/**
 * Builds the standing server descriptor for a session.
 *
 * The capability plugins (browser, computer, office) are passed IN rather than declared here: WS-06
 * owns their exact names and schemas, and a copy of them in the router would be a second declaration
 * to drift. What the router owns is that they are registered under the same canonical names, with the
 * same identity, on both branches — which is what `canonicalToolNames` below makes checkable.
 */
export function winterMcpServerDescriptor(args: {
  brand: Pick<BrandProfile, "mcpServerName">;
  messaging: MessagingHandlers;
  capabilities?: readonly WinterMcpToolDescriptor[];
  version?: string;
  branchLabel: string;
}): WinterMcpServerDescriptor {
  const tools = [...messagingToolDescriptors(args.messaging), ...(args.capabilities ?? [])];
  assertNoAdvisor(tools, args.branchLabel);
  return { name: args.brand.mcpServerName, version: args.version ?? "1.0.0", tools };
}

/** The canonical names a descriptor registers — the identity both branches must agree on. */
export function canonicalToolNames(descriptor: WinterMcpServerDescriptor, brand: Pick<BrandProfile, "mcpServerName">): readonly string[] {
  return descriptor.tools.map((tool) => mcpToolName(brand, tool.tool));
}

// --------------------------------------------------------------------------------------------------
// Materialization into the official branch.
// --------------------------------------------------------------------------------------------------

/** The subset of the injected official module this needs. Duck-typed: the seam declares only `query`. */
export interface OfficialMcpModule {
  createSdkMcpServer?: (options: { name: string; version?: string; tools?: unknown[]; instructions?: string }) => unknown;
  tool?: (name: string, description: string, inputSchema: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>, extras?: unknown) => unknown;
}

/**
 * Converts a JSON-Schema object into whatever the official in-process server constructor expects.
 *
 * INJECTED, NOT IMPLEMENTED HERE — see this module's header. A host writes it once against the
 * validator it already has as the official SDK's peer.
 */
export type InputShapeFactory = (schema: JsonSchemaObject) => unknown;

/**
 * Registers the standing server into the official branch, returning the `mcpServers` entry.
 *
 * A MISSING CONSTRUCTOR IS A TYPED FAILURE. An injected module without `createSdkMcpServer` is a
 * module this branch cannot register a server into at all, and continuing would produce a session
 * whose aliases resolve to a tool that does not exist — the model's `SendMessage` would fail at the
 * one moment it matters (WS-17 rows 1–2).
 */
export function materializeOfficialMcpServer(args: {
  descriptor: WinterMcpServerDescriptor;
  module: OfficialMcpModule;
  toInputShape: InputShapeFactory;
  branchLabel: string;
}): unknown {
  const { createSdkMcpServer, tool } = args.module;
  if (typeof createSdkMcpServer !== "function" || typeof tool !== "function") {
    throw new OfficialMcpError({
      server: args.descriptor.name,
      reason: "the injected official SDK module exposes no in-process MCP server constructor, so the standing server cannot be registered and every aliased built-in would resolve to a missing tool",
      branchLabel: args.branchLabel,
    });
  }
  // WHAT THE VENDOR'S CONSTRUCTOR CANNOT CARRY (review r1, n3), disclosed rather than left looking
  // authoritative on the descriptor: `outputSchema` and `exposure` have no parameter on the
  // in-process server's tool registration, so on THIS branch the output shape is unvalidated and the
  // canonical twins' deferral is the runtime's own decision (which, measured, it does not implement —
  // see `aliases.ts`'s note). §11's "identical schema and result shape on both branches" therefore
  // holds for the INPUT schema, the description, the annotations and the handler; the two dropped
  // fields are a vendor limitation with the same standing as §7's Tool-Search finding.
  const tools = args.descriptor.tools.map((descriptor) =>
    tool(
      descriptor.tool,
      descriptor.description,
      args.toInputShape(descriptor.inputSchema),
      // THE VENDOR'S `extra` REACHES THE HANDLER (item 15). Whether anything in it is usable as a
      // §12 retry key is measured in `runtime-aliases.test.ts` rather than assumed here.
      async (rawArgs: unknown, extra: unknown) => descriptor.handler(rawArgs, extra),
      descriptor.annotations === undefined ? undefined : { annotations: descriptor.annotations },
    ),
  );
  return createSdkMcpServer({ name: args.descriptor.name, version: args.descriptor.version, tools });
}

/** `Options.mcpServers` for this branch: one entry, keyed by the brand's own server name. */
/** The descriptor fields the official branch's registration cannot carry (review r1, n3). */
export const OFFICIAL_MATERIALIZATION_DROPS: readonly string[] = ["outputSchema", "exposure"];

export function officialMcpServers(args: { descriptor: WinterMcpServerDescriptor; module: OfficialMcpModule; toInputShape: InputShapeFactory; branchLabel: string }): Record<string, unknown> {
  return { [args.descriptor.name]: materializeOfficialMcpServer(args) };
}
