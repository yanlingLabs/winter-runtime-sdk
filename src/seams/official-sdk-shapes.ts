// THE OPTIONAL PEER'S SHAPES, DECLARED STRUCTURALLY — so this package's PUBLISHED declarations never
// force a consumer to install a peer that is optional (review r1, M7).
//
// THE PROBLEM THIS SOLVES. `@anthropic-ai/claude-agent-sdk` is an OPTIONAL peer: a Winter-only host
// never installs it and never loads it. But a `.d.ts` that names a module specifier makes the
// type-checker resolve it, and a consumer type-checking without `skipLibCheck` then sees
// `error TS2307: Cannot find module '@anthropic-ai/claude-agent-sdk'` coming out of OUR package —
// for a dependency we told them was optional. Before this file, two reachable declarations named it:
// `RuntimeSdkPeers.claude?: typeof import(…)` and the official-adapter seam's `import type`.
//
// THE SHAPE OF THE FIX. Everything the PUBLIC surface needs is declared here, structurally, from the
// members WS-14 actually pins — never a copy of Anthropic's declaration file (WS-02 §2: the repo must
// contain no Anthropic artifact; these are independently authored interfaces describing a public API
// surface, exactly as the Winter SDK's own `SpawnedRuntimeProcess` is "shape-compatible with the
// pinned spawnClaudeCodeProcess hook" and says so).
//
// FIDELITY IS NOT LOST, IT IS MOVED INTO A TEST. `test/spine/official-shapes-conformance.test.ts`
// asserts, at type level, that the REAL pinned 0.3.250 declarations are assignable to every shape
// below. That test imports the optional peer (a dev dependency here) and is never published, so the
// drift gate is as strong as an `import type` while the published surface stays free of it. If
// Anthropic's shape moves under a version bump, the conformance test fails — which is the reviewed
// compatibility event WS-02 §6.1 requires anyway.
//
// THE RULE FOR LANE A. `src/official/**` MAY `import type` from the optional peer for its own
// internals — those declarations are emitted but unreachable from `dist/index.d.ts`, so a consumer's
// type-checker never loads them. What must not happen is one of those types reaching an EXPORTED
// member of `src/index.ts`. `scripts/release-pack.ts` walks the declaration graph reachable from the
// package's `types` entry and fails the pack if the peer is named anywhere in it, so this rule is a
// gate rather than a convention.

/**
 * One message in a streaming prompt handed to the official runtime.
 *
 * An open record on purpose: the router never reads a field of one. The real `SDKUserMessage` is a
 * type alias of an object literal, so it carries an implicit index signature and is assignable here.
 */
export type OfficialUserMessage = { readonly [key: string]: unknown };

/**
 * The official runtime's query handle, reduced to what the router's own surface touches: the message
 * stream (passed through verbatim — the router never re-shapes it) and WS-14 §9's interrupt.
 */
export interface OfficialQuery extends AsyncIterable<unknown> {
  /**
   * WS-14 §9: stops the foreground turn while preserving background agents/workflows.
   *
   * `Promise<unknown>` and not `Promise<void>`: the pinned 0.3.250 resolves an interrupt RESPONSE
   * (`Promise<SDKControlInterruptResponse | undefined>`), which the conformance test caught the first
   * time it ran. The router never reads it, so the seam names it `unknown` rather than re-declaring a
   * response shape it has no use for.
   */
  interrupt(): Promise<unknown>;
}

/** WS-14 §6's spawn options — the ONE member the spec makes load-bearing is `env`. */
export interface OfficialSpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  /**
   * The child environment the official runtime is about to use. WS-14 §1/§6: "the host MUST treat the
   * value observed in `SpawnOptions.env.CLAUDE_CONFIG_DIR` as authoritative for the generation, not
   * the value it configured", and it must be durably recorded BEFORE the process is returned.
   */
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/**
 * The process handle the official runtime expects back.
 *
 * `stdin`/`stdout` are the runtime's own Node stream types and are deliberately NOT re-declared: a
 * hand-written structural stand-in for `Writable`/`Readable` would be both wrong and unnecessary.
 * Lane A holds the precise types inside `src/official/**`, where the optional peer may be imported.
 */
export interface OfficialSpawnedProcess {
  stdin: unknown;
  stdout: unknown;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: string): boolean;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

/** WS-14 §6 / D12: the supervised spawn proxy, in the shape the official runtime's own option takes. */
export type OfficialSpawnClaudeCodeProcess = (options: OfficialSpawnOptions) => OfficialSpawnedProcess;

/**
 * The official runtime's `Options`, carrying WS-14 §2's normative fields by name and everything else
 * through the index signature.
 *
 * THE INDEX SIGNATURE IS THE POINT: the router pins the fields the SPEC pins and stays out of the way
 * of the ~200 it does not. Lane A builds one of these; nothing ever assigns Anthropic's own `Options`
 * INTO the router (the injected module is typed by `OfficialSdkModule` below), so this type is the
 * contract on both sides of the seam.
 */
export interface OfficialOptions {
  [key: string]: unknown;
  /**
   * WS-14 §2: `[]` — the official branch reads no real settings file at any tier.
   *
   * NARROWED TO THE RUNTIME'S OWN THREE VALUES (review r2, NEW-2). `string[]` was WIDER than the
   * runtime accepts, at a field the spec pins normatively: nothing stopped a lane writing
   * `settingSources: ["flag"]`, the compiler was happy and the runtime would not have been. The union
   * is independently authored (three ordinary words), not an Anthropic artifact, and
   * `official-shapes-conformance.test.ts` now pins BOTH directions on it.
   */
  settingSources?: Array<"user" | "project" | "local">;
  /** WS-14 §2: `{ type: "local", path: "<cwd>/<projectDir>", skipMcpDiscovery: true }`. */
  plugins?: unknown;
  /** WS-14 §2: `{ preset: "claude_code" }` — a Claude-mirroring literal, fixed (WS-01 §5 / D16). */
  systemPrompt?: unknown;
  plansDirectory?: string;
  /** WS-14 §2: `true`, with the ONE shared `autoMemoryDirectory` — identical for both branches. */
  autoMemoryEnabled?: boolean;
  autoMemoryDirectory?: string;
  strictMcpConfig?: boolean;
  /** WS-05 §6 / WS-14 §5: the shared filesystem store instance. Typed `unknown` here because the two SDKs' store types are each other's business; Lane A passes the Winter store through. */
  sessionStore?: unknown;
  /** WS-14 §7: `SendMessage` / `ListAgents` redirected onto the Winter MCP server's handlers. */
  toolAliases?: Record<string, string>;
  /** WS-14 §6: the supervised proxy. */
  spawnClaudeCodeProcess?: OfficialSpawnClaudeCodeProcess;
  /** WS-14 §5.1: the VENDORED runtime — never the user's installed binary. */
  pathToClaudeCodeExecutable?: string;
  cwd?: string;
  /**
   * WS-14 §3: a REPLACEMENT built from an allowlist; nothing is inherited.
   *
   * The value type carries `| undefined` because the pinned runtime's own does — measured by the
   * conformance test, which refused `Record<string, string>`.
   */
  env?: Record<string, string | undefined>;
  resume?: string;
  forkSession?: boolean;
  /** WS-14 §5.1: MUST NOT be combined with `sessionStore`. */
  persistSession?: boolean;
  /** WS-14 §5.1: MUST NOT be set at all. */
  enableFileCheckpointing?: boolean;
}

/**
 * The injected official-SDK module, reduced to what the router calls on it.
 *
 * A structural interface rather than `typeof import("@anthropic-ai/claude-agent-sdk")` — see this
 * file's header. **This is a documented departure from the plan's pinned `RuntimeSdkPeers`**, forced
 * by the same optionality the plan itself declares: a `typeof import(…)` of an OPTIONAL peer is a
 * required resolution.
 *
 * GROWING IT IS A SPINE EDIT: a lane that needs another member of the injected module (Lane A will
 * want the MCP-server constructor for WS-14 §11) adds it here, and the conformance test proves the
 * real module still satisfies it.
 */
export interface OfficialSdkModule {
  query(params: { prompt: string | AsyncIterable<OfficialUserMessage>; options?: OfficialOptions }): OfficialQuery;
}
