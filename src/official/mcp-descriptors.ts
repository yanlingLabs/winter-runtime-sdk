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
import {
  WINTER_DEFAULT_TOOL_DEFINITIONS,
  createAdvisorToolHandler,
  createMessagingToolHandlers,
  type AdvisorToolDeps,
  type JsonSchemaObject,
  type MessagingToolPort,
  type WinterToolCaller,
  type WinterToolDefinition,
  type WinterToolHandler,
} from "@yanlinglabs/winter-agent-sdk/tools";

import { OfficialMcpError } from "./errors.ts";
import { RuntimeLaunchInputError } from "../errors.ts";

/**
 * ONE `JsonSchemaObject`, AND IT IS THE SDK'S (interim review I-3).
 *
 * The router used to declare its own — `properties` required, no `additionalProperties` — and every
 * composition of an SDK schema into a descriptor went through `as unknown as JsonSchemaObject`. Two
 * types for one contract is how the two copies of the native schemas drifted in the first place
 * (barrel-exports.test.ts's own header), so the type travels with the definitions it describes.
 */
export type { JsonSchemaObject };

/** What a handler answers with — the MCP content shape, identical on both branches. */
export interface WinterMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * A tool handler, and the vendor's own second argument (item 15).
 *
 * `extra` IS FORWARDED, NOT DROPPED, and what it carries is measured rather than assumed: on 0.3.250
 * `extra._meta["claudecode/toolUseId"]` is the id the model emitted, which is the half of WS-10 §12's
 * retry key the official branch could not otherwise have. The SDK's `toolUseIdFromExtra` reads it (and
 * falls back to the bound caller's id), so the router forwards the argument and decides nothing.
 */
export type WinterMcpHandler = (args: unknown, extra?: unknown) => Promise<WinterMcpToolResult>;

/**
 * One tool on the standing server — the ROUTER'S OWN COMPOSITION TYPE, and nothing more (R-8-1).
 *
 * It is a `WinterToolDefinition` (the SDK's: bare name, description, schemas, annotations, permission
 * class) plus the two things only a HOST can supply: the handler that runs it and how this branch
 * exposes it. The router declares no tool of its own — every field but those two is read off the
 * definition the SDK owns.
 */
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

/**
 * The SDK's host-neutral `{ text, isError? }` as the MCP content shape this branch registers.
 *
 * THE WHOLE ADAPTATION IS THESE FOUR LINES (ruling P-4). The SDK handler answers in the shape both
 * hosts share; each host wraps it in its own runtime's result type, and a host that re-shaped the
 * TEXT would be the second implementation the relocation exists to delete.
 */
function mcpResult(handler: WinterToolHandler): WinterMcpHandler {
  return async (args, extra) => {
    const result = await handler(args, extra);
    return { content: [{ type: "text" as const, text: result.text }], ...(result.isError === undefined ? {} : { isError: result.isError }) };
  };
}

/** The SDK's definition, plus the handler and the exposure this branch supplies. */
function descriptorFor(definition: WinterToolDefinition, handler: WinterToolHandler): WinterMcpToolDescriptor {
  return {
    tool: definition.toolName,
    description: definition.description,
    inputSchema: definition.inputSchema,
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.annotations === undefined ? {} : { annotations: definition.annotations }),
    // DEFERRED, for the same reason the two messaging twins always were (§7): each of the four is the
    // canonical twin of a name the model already sees as a built-in through `toolAliases`, and §7
    // wants one `SendMessage`, not two. (The pin does not implement deferral for MCP tools — measured,
    // `aliases.ts` — so this is an intent the branch records, not an enforcement it gets.)
    exposure: "deferred",
    permissionClass: definition.permissionClass,
    handler: mcpResult(handler),
  };
}

/**
 * THE STANDING SERVER, COMPOSED FROM THE SDK'S DEFINITIONS AND THE SDK'S HANDLER FACTORIES (R-8-1).
 *
 * THE ROUTER OWNS NO TOOL. It used to declare `send_message` and `list_agents` here — their
 * descriptions, their native schemas, their acceptors — beside a second copy of the same declarations
 * inside the Winter runtime, and the two had already drifted on what `to` may contain and on what an
 * over-long `summary` does. `@yanlinglabs/winter-agent-sdk/tools` is now the single declaration, and
 * this function is what BINDS it: `WINTER_DEFAULT_TOOL_DEFINITIONS` × the SDK's handler factories,
 * under the brand's server name.
 *
 * THE PORT IS PASSED STRAIGHT THROUGH (ruling P-3). `GlobalMessagingHandle` satisfies
 * `MessagingToolPort` structurally — `sendDetailed`, `listReachable({from})`, `readNotifications(id)`
 * — so the router needs no adapter of its own and `messagingToolPortFromRuntimeDeps` (which adapts the
 * RUNTIME's deps) is never used here.
 *
 * THE ADVISOR IS ALWAYS REGISTERED (interim review I-5). The Winter runtime always advertises
 * `advisor`; gating the official branch's copy on a host option would make the two legs' advertised
 * sets differ by a setting that changes nothing on the other leg. `advisor.resolveReviewer` supplies
 * the reviewer — its default answers `undefined`, which is WS-06 §4's ordinary tool error, not a throw.
 */
export function winterMcpServerDescriptor(args: {
  brand: Pick<BrandProfile, "mcpServerName">;
  port: MessagingToolPort;
  caller: WinterToolCaller | (() => WinterToolCaller);
  advisor: Omit<AdvisorToolDeps, "resolveReviewer"> & Partial<Pick<AdvisorToolDeps, "resolveReviewer">>;
  capabilities?: readonly WinterMcpToolDescriptor[];
  version?: string;
}): WinterMcpServerDescriptor {
  const messaging = createMessagingToolHandlers(args.port, args.caller);
  const advisor = createAdvisorToolHandler({
    transcriptSource: args.advisor.transcriptSource,
    resolveReviewer: args.advisor.resolveReviewer ?? (() => undefined),
    ...(args.advisor.maxChars === undefined ? {} : { maxChars: args.advisor.maxChars }),
  });
  const handlers: Record<string, WinterToolHandler> = {
    send_message: messaging.sendMessage,
    list_agents: messaging.listAgents,
    read_notifications: messaging.readNotifications,
    advisor,
  };
  const tools = WINTER_DEFAULT_TOOL_DEFINITIONS.map((definition) => {
    const handler = handlers[definition.toolName];
    /* c8 ignore next */
    if (handler === undefined) throw new OfficialMcpError({ server: args.brand.mcpServerName, reason: `the SDK declares a default tool this branch has no handler for: \`${definition.toolName}\``, branchLabel: "winter-claude-agent" });
    return descriptorFor(definition, handler);
  });
  return { name: args.brand.mcpServerName, version: args.version ?? "1.0.0", tools: [...tools, ...(args.capabilities ?? [])] };
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
      // NO `extra` SLOT (M-12). `WinterMcpServerInstance.callTool(name, args)` takes arguments only, so
      // the vendor's second handler argument — where 0.3.250 puts the model's `tool_use_id` — has
      // nowhere to go on a capability tool. The daemon's own tools therefore get no §12 retry key on
      // this branch; the standing server's do, because the SDK's handlers take `extra`.
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

/**
 * The ONE refusal both legs raise when a caller's own `mcpServers` key names a forwarded capability.
 *
 * IT IS SHARED BECAUSE THE TWO LEGS MUST SAY THE SAME THING (review r1). The Winter leg refuses in
 * `forwardableOptions`, the official leg before its launch; the same mistake producing a typed error
 * on one leg and a silent per-key override on the other would leave the two branches advertising
 * different tools under one name, with nothing to read about it. Two copies of this sentence is how
 * that starts being true again, so there is one.
 */
export function capabilityNameCollisionError(args: { field: string; name: string }): RuntimeLaunchInputError {
  return new RuntimeLaunchInputError({
    field: args.field,
    reason: `\`${args.name}\` is the name of a capability server this handle forwards, and the caller's own \`mcpServers\` already carries it — one of the two would silently not be registered, and the other leg would still have the capability, so the door refuses rather than choose for you`,
  });
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
 *
 * WHAT IT KEEPS AND WHAT IT DROPS (M-3), disclosed rather than left to be discovered: `type`,
 * `properties`, `required` and `additionalProperties` travel; every OTHER JSON-Schema keyword a
 * daemon's tool may carry (`$defs`, `oneOf`, `format`, per-property `pattern` beyond what the host's
 * own `toInputShape` reads…) reaches the official branch only insofar as the host's bridge reads it
 * off the property objects, which pass through untouched. `OFFICIAL_MATERIALIZATION_DROPS` names the
 * descriptor-level fields; this is the schema-level statement of the same limitation.
 */
function capabilityInputSchema(raw: Record<string, unknown>, server: string, tool: string): JsonSchemaObject {
  const properties = raw["properties"];
  if (raw["type"] !== "object" || (properties !== undefined && (typeof properties !== "object" || properties === null))) {
    throw new RuntimeLaunchInputError({
      field: "capabilities",
      reason: `the capability tool \`${tool}\` on \`${server}\` declares an input schema that is not a JSON-Schema object, and the official branch's in-process registration has no conversion for anything else`,
    });
  }
  const required = raw["required"];
  const additionalProperties = raw["additionalProperties"];
  return {
    type: "object",
    ...(properties === undefined ? {} : { properties: properties as Record<string, unknown> }),
    ...(Array.isArray(required) ? { required: required.map(String) } : {}),
    ...(typeof additionalProperties === "boolean" ? { additionalProperties } : {}),
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

/** The descriptor fields the official branch's registration cannot carry (review r1, n3). */
export const OFFICIAL_MATERIALIZATION_DROPS: readonly string[] = ["outputSchema", "exposure"];

export function officialMcpServers(args: { descriptor: WinterMcpServerDescriptor; module: OfficialMcpModule; toInputShape: InputShapeFactory; branchLabel: string }): Record<string, unknown> {
  return { [args.descriptor.name]: materializeOfficialMcpServer(args) };
}
