// WS-14 §11: THE PRODUCT'S MCP SERVER, REGISTERED INTO THE OFFICIAL BRANCH — identically (D7).
//
// "The Winter MCP server is registered identically into BOTH SDK branches: `send_message`/
// `list_agents` handlers (§7) plus the browser, computer and office capability plugins, all under
// canonical names with identical description, schema, annotations, permission identity and result
// shape on both branches."
//
// R-8-1(3) REVERSES THE OLD REFUSAL: Winter's advisor now BACKS Claude's on the official branch.
// WS-14's advisor amendment (authority WS-06 D29) used to read "the server registered into the
// official branch … does NOT carry an advisor" — on the theory that Anthropic's own API-side server
// tool (parameterless, Claude-family and Anthropic-chosen) was the only advisor that branch could
// ever have, so a Winter-native one would only advertise a second, unreachable advisor. The user's
// tool-ownership ruling (R-8-1) supersedes that: Winter's default tools, `advisor` among them, are
// PULLED BY THE ROUTER and bound under Claude's built-in names on the official branch too, so a
// `WinterMcpToolDescriptor` named `advisor` is registered like any other capability — no refusal, no
// filter. `docs/probes/d29-advisor.md` carries the measurement this reverses and records why the
// measurement itself still stands (the API-side tool's own behaviour is unchanged; only the policy
// choice of whether Winter ALSO offers one is reversed).
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
import { isWinterMcpServerInstance, mcpToolName, type BrandProfile, type McpSdkServerConfigWithInstance, type WinterMcpServerInstance } from "@yanlinglabs/winter-agent-sdk";

import { NATIVE_LIST_AGENTS_OUTPUT_SCHEMA, NATIVE_LIST_AGENTS_SCHEMA, NATIVE_SEND_MESSAGE_SCHEMA } from "./aliases.ts";
import { OfficialMcpError } from "./errors.ts";
import { RuntimeLaunchInputError } from "../errors.ts";

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
  return { name: args.brand.mcpServerName, version: args.version ?? "1.0.0", tools };
}

// --------------------------------------------------------------------------------------------------
// THE DAEMON'S OWN CAPABILITY SERVERS, READ ONCE INTO DESCRIPTORS (R-8 / R-8-1).
// --------------------------------------------------------------------------------------------------
//
// THE ROUTER OWNS NO TOOL. The user's tool-ownership ruling puts the capability tools (computer,
// browser, office) in the DAEMON, which hands them to the router as MCP servers in the Winter SDK's
// own in-process shape — `{ type: "sdk", name, tools?, instance }`. The Winter leg takes that object
// verbatim, by reference. The OFFICIAL leg cannot: its runtime registers in-process servers through
// its own constructor, over its own validator's schema shape, so the same tools have to be REGISTERED
// there rather than handed over. That is what this reads the server for — one declaration, two
// registrations, which is WS-14 §11's whole requirement.
//
// IT IS A READ, NOT A REWRITE. Every field comes from the host's own declaration: the tool's name,
// description, input schema and annotations, and a handler that calls straight back into the host's
// instance. Nothing is renamed and nothing is invented; the two fields a descriptor needs and MCP does
// not carry (`exposure`, `permissionClass`) are the two the official materialization drops or never
// reads (`OFFICIAL_MATERIALIZATION_DROPS`), so defaulting them decides nothing.
//
// WHERE THE DECLARATION COMES FROM. `McpSdkServerConfig.tools` is the declarative list, and it is
// preferred because it is synchronous and is what the host meant to publish; a server that declares
// none is asked for `listTools()` instead. The instance must satisfy the Winter SDK's OWN predicate
// either way, because `callTool` is what every derived handler ends up calling.

/** One capability server, as a descriptor the official branch can register. */
export function capabilityServerDescriptor(server: McpSdkServerConfigWithInstance, version = "1.0.0"): WinterMcpServerDescriptor {
  if (!isWinterMcpServerInstance(server.instance)) {
    throw new RuntimeLaunchInputError({
      field: "capabilities",
      reason: `the capability server \`${server.name}\` carries no in-process instance the router can call (\`listTools\`/\`callTool\`), so its tools could be forwarded to the Winter leg and never registered on the official one`,
    });
  }
  const instance: WinterMcpServerInstance = server.instance;
  const declared = server.tools ?? instance.listTools();
  const tools = declared.map((tool) => {
    const meta = (tool as { _meta?: Record<string, unknown> })._meta;
    const permissionClass = typeof meta?.["permissionClass"] === "string" ? (meta["permissionClass"] as string) : server.name;
    return {
      tool: tool.name,
      description: tool.description ?? "",
      inputSchema: capabilityInputSchema(tool.inputSchema, server.name, tool.name),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      // EAGER, and the choice costs nothing: the official registration has no parameter for exposure
      // at all (see `OFFICIAL_MATERIALIZATION_DROPS`), and the Winter leg never sees this descriptor —
      // it gets the host's own server object, with the host's own exposure.
      exposure: "eager" as const,
      permissionClass,
      handler: async (rawArgs: unknown): Promise<WinterMcpToolResult> => {
        const result = await instance.callTool(tool.name, (rawArgs ?? {}) as Record<string, unknown>);
        // THE CONTENT PASSES THROUGH. MCP content blocks are the shape both branches speak; the
        // vendor's `tool()` hands whatever the handler returns back to the model unchanged, so
        // re-shaping here would be the router deciding what a host's tool may answer.
        return { content: result.content as WinterMcpToolResult["content"], ...(result.isError === undefined ? {} : { isError: result.isError }) };
      },
    };
  });
  return { name: server.name, version, tools };
}

/** Every capability server, in the order the host declared them. */
export function capabilityServerDescriptors(servers: readonly McpSdkServerConfigWithInstance[]): readonly WinterMcpServerDescriptor[] {
  return servers.map((server) => capabilityServerDescriptor(server));
}

/**
 * The one narrowing this read performs, and it is a refusal rather than a coercion.
 *
 * `toInputShape` converts a JSON-Schema OBJECT into the official validator's raw shape; a schema that
 * is not one has no conversion, and a host that learns so at construction can fix it, while a host
 * that learns so at the first model call has a session whose tool is already advertised.
 */
function capabilityInputSchema(raw: Record<string, unknown>, server: string, tool: string): JsonSchemaObject {
  const properties = raw["properties"];
  if (raw["type"] !== "object" || typeof properties !== "object" || properties === null) {
    throw new RuntimeLaunchInputError({
      field: "capabilities",
      reason: `the capability tool \`${tool}\` on \`${server}\` declares an input schema that is not a JSON-Schema object, and the official branch's in-process registration has no conversion for anything else`,
    });
  }
  const required = raw["required"];
  return {
    type: "object",
    properties: properties as JsonSchemaObject["properties"],
    ...(Array.isArray(required) ? { required: required.map(String) } : {}),
  };
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
