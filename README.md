# winter-runtime-sdk

One door over two agent runtimes. A host that wants both the Winter Agent SDK and the official
Claude Agent SDK talks to this package as a single SDK: the same `query()`, the same `Options`, the
same closed `SDKMessage` union — plus runtime-selection inputs.

Decision record: WS-00 D19 (2026-09-05). Boundaries that do not move:

- `@yanlinglabs/winter-agent-sdk` stands alone for Winter-only hosts and never learns this package
  or the official runtime exists.
- This package is a selector and an adapter, never a translation layer: Options and the message
  stream pass through verbatim. It owns runtime selection (the D13 rule), the official-SDK adapter
  (Options template, spool env, supervised spawn proxy, mirror errors, tool aliases and deny floor,
  builtin-path containment, Winter MCP plugin registration), shared session-store wiring, the
  cross-runtime handoff barrier with the materialized-resume decoration doors, and the runtime
  directory plus cross-runtime messaging router.
- **It owns NO TOOL** (the user's tool-ownership ruling, R-8-1). The default tools — `SendMessage`,
  `ListAgents`, `ReadNotifications`, `advisor` — are DECLARED once in
  `@yanlinglabs/winter-agent-sdk/tools` and BOUND here, under the official runtime's own built-in
  names; the capability tools (computer, browser, office) are the HOST's, handed over as MCP servers
  and forwarded to both legs unchanged. This package re-exports no tool surface of its own.
- The host vendors all three packages directly (`winter-runtime-sdk`, `winter-agent-sdk`,
  `claude-agent-sdk`); this package declares the two SDKs as peer dependencies and receives their
  module instances by injection, so a host that never creates a Claude session never loads the
  official runtime and no SDK is ever instantiated twice.
- A `brand` profile flows through unchanged (Winter defaults); Claude Code's own literals stay fixed.

Status: Phase 7b landed all four lanes and routed the door; `0.0.2` was the Phase-8b prerequisite
release. The spine (the package scaffold, the contract re-export, the `createRuntimeSdk` constructor
with its version matrix, the seams, the test harness and CI) and the four lanes behind those seams —
the official-SDK adapter, the runtime directory and messaging router, the store wiring and handoff
barrier, and runtime selection — are on `main`, with WS-17's eighteen router-owned rows proven and
cited in `docs/conformance-rows.md`. See `docs/architecture.md` for the ownership map, the pinned
interfaces and how this package consumes the Winter SDK.

## Run home (WS-21)

**Unreleased (0.0.12).** Both agent runtimes read ONE shared home, `<home>/sdk`, in the official
runtime's config-dir formats with the brand's names. Neither reads it directly: before every
generation a per-run folder is built, `<home>/cache/runs/<runId>`, and the child is pointed at it.
This section is the contract a host builds against (Contract A); `src/run-home/types.ts` is its source.

**The exports** (package root):

```ts
type RunMode = "code" | "dispatch" | "chat";
type RunLeg = "winter" | "official";
interface RunHomeInput {
  home: string;                          // the daemon's home; the shared home is sdkHomeOf(home)
  mode: RunMode;
  dispatchChild: boolean;                // a code-mode dispatch child: output style skipped
  leg: RunLeg;
  cwd: string;
  trustedProjectRoot: string | null;     // repoRootFor(cwd) when trusted, else null; at $HOME or above it, no
                                         // project item, instruction, settings tier or project MCP file is read
                                         // (the local MCP scope in <home>/sdk/.winter.json still applies)
  gitRoot: string | null;                // the canonical git root (the local settings tier)
  mcpDisabled: readonly string[];
  reservedMcpServerNames: readonly string[];
  memoryDir: string;                     // the auto-memory directory for this incarnation
  brand?: RunHomeBrand;                  // optional; absent = the Winter SDK's own profile
}
interface RunHomeReport { skippedLinks; externalUserLinks; droppedMcpServers; unconditionalRules; droppedImports;
  skippedAgents;                         // an agent the runtime's own YAML parse cannot read (or no Bun.YAML): never copied
  droppedRules }                         // { rule, tier, reason }: an ALLOW re-anchored under an anchor holding `?` (it would widen)
interface RunHome { runId; dir; sdkHome; input; effectiveSettings; report; dispose(): Promise<void> }
const RUN_HOME_CONTRACT_VERSION = 1;
const RUN_HOME_PERSISTENT_ENTRIES = ["file-history", "tasks", "teams", "agent-memory", "workflows"];
function sdkHomeOf(home: string): string;                                  // join(home, "sdk")
function buildRunHome(input: RunHomeInput): Promise<RunHome>;
function fsRootAnchored(absPath: string): string;                          // "/" + absPath ("//Users/x")
function protectedPathRules(sdkHome: string, trustedProjectRoot: string | null, brand?,
  /** @deprecated ignored */ walk?: { cwd: string; userHome?: string }): string[];
                                         // project item dirs at ANY depth: //<root>/**/.winter/<kind>/**, every path part escaped
function escapeRulePath(path: string): string;                             // `[` `]` `*` `\` backslash-escaped for a rule pattern ("[wip]" → "\[wip\]"); `?` stays raw (measured). Both legs read this grammar (the Winter runtime since SV-6); the router escapes every path it writes into a rule, on both legs
type RunHomeOutcome = "safe" | "quarantined" | "pending";
interface RecoveryTranscriptOutcome {
  projectKey: string; sessionId: string; subpath?: string;             // subpath: "subagents/agent-<id>"
  outcome: "clean" | "appended" | "canonical-ahead" | "quarantined";
  appended: number; reason?: string;                                   // reason: why it was quarantined
  artifacts?: { copied: number; identical: number; quarantined: string[] }; // on a session's own entry: its session dir's other files
}
interface RecoveryReport {
  outcome: "clean" | "appended" | "quarantined";                       // quarantined > appended > clean (an artifact conflict counts)
  transcripts: RecoveryTranscriptOutcome[];
  quarantine?: string;                                                 // <home>/cache/quarantine/<ts>-<root name>
  artifacts?: { copied: number; identical: number; quarantined: string[]; skipped: string[] }; // all carried files, totalled
}
type RunHomeFor = (ctx: { sessionId: string; leg: RunLeg; cwd: string; mode: RunMode }) => Promise<RunHome>;
class RunHomeError extends RuntimeSdkError { code: RunHomeErrorCode }    // forwarded as data.code
function reconcileLocalWriteRoot(root, { shared }): Promise<ReconcileReport>; // the one reconcile (read-only for hosts)
```

**The attach points.**

| | |
|---|---|
| `createRuntimeSdk({ requireRunHome: true })` | Opt-in, and that is the feature detection: without it an existing host is served unchanged. With it, a generation with no `runtime.runHome` is refused `run_home_required` on BOTH overloads, synchronously, before either leg is touched. |
| `createRuntimeSdk({ runHomeFor })` | The host's builder for the router's OWN cold-resume path (messaging delivery to an exited Winter session). Absent with `requireRunHome`, that path answers a typed non-retryable `unavailable`. |
| `query({ prompt, options: { ...options, runtime: { runHome } } })` | The Winter overload (still typed `Query`). The host awaits `buildRunHome` in `optionsFor` and passes the result. |
| `query({ prompt, options: { ...options, runtime: { selection, official, runHome } } })` | The official overload. The host awaits `buildRunHome` in the official session's `open()`. |
| `sdk.runHomeOutcome(runId)` | `safe` → the host may `runHome.dispose()`; `quarantined` → its working copy was copied to `<home>/cache/quarantine/`; `pending` → still running (or unknown). Dispose only on `safe`. A `query()` that THROWS synchronously (every run-home refusal does) opened no incarnation and records nothing — the host disposes that run home on the throw, not on the outcome. |
| `sdk.reconcileRootForRecovery(root): Promise<RecoveryReport>` | The recovery door for a recorded root (a crashed run folder or staging root) or a pre-WS-21 spool root (Migration C's `runtimes/claude-config`), judged PER TRANSCRIPT: `clean` (level); `appended` (the canonical file was behind; the tail is appended); `canonical-ahead` (the working copy is a prefix of a canonical history that moved on — a resume through staging, a continuation on the other leg — so nothing is appended and nothing is lost); `quarantined` (unprovable: that transcript's file alone is copied to `report.quarantine`, nothing of it is appended). **Session artifacts** — every non-transcript file claude keeps under `projects/<key>/<sid>/` (large tool outputs in `tool-results/`, a workflow's saved script and run record under `workflows/`, subagent `*.meta.json`) and any per-project file beside the session dirs — are carried into `<sdk>/projects/` at the same relative path, by this door and by the exit reconcile alike (a run folder or a `claude-resume-*` staging root): copied when absent, left when byte-identical, **never overwritten** (a differing destination quarantines the working copy's file), never through a link on either side. A session's repair flag is cleared when every one of its transcripts came back level — `canonical-ahead` included, without asking whether a live writer holds the session, so **the host runs it to completion before any session with a recovered key opens** (the daemon does, at boot); the router keeps no live-session registry to check it against. The host never calls `reconcileLocalWriteRoot` itself. |

**What applying a run home does** (the router, synchronously, before the pass-through / the launch):

| | Winter leg | official leg |
|---|---|---|
| checks | built by `buildRunHome` and not disposed (`run_home_foreign`); built for this leg (`run_home_leg_mismatch`), this cwd (`run_home_cwd_mismatch`), this brand (`run_home_brand_mismatch`) and this router's store (`run_home_store_mismatch`) | the same |
| config dir | `env.<PREFIX>HOME = runHome.dir` | `CLAUDE_CONFIG_DIR = runHome.dir` (fresh); `<dir>/.absent` then the linked staging dir (resume, §3.6) |
| router-set env | `<PREFIX>STORE_HOME = <home>/sdk`, `<PREFIX>PLUGIN_CACHE_DIR = <home>/sdk/plugins`, `<PREFIX>PROVIDER_MANAGED_BY_HOST = 1`, `<PREFIX>DISABLE_CRON = 1` (laid over the caller's env) | `CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = 1`, `CLAUDE_CODE_DISABLE_CRON = 1` — branch-owned, refused from `configuredExtras` |
| options the run home decides | `plugins`, `skills`, `agents`, `outputStyle`, `brand` are refused from the caller (`run_home_option_refused`); so are the router-set variables in `env` (`router_owned_variable`) | the same options refused; a policy's `agents` is refused beside a run home and never forwarded |
| setting sources | `["user"]`; a caller's `project`/`local` is refused (`setting_sources_refused`) | `["user"]`; the invariants refuse anything else, and `["user"]` without a run home; the spawn proxy re-checks the final argv |
| MCP | the run folder's `.winter.json` | `strictMcpConfig: false` (and `true` is refused on a run home) |
| memory | `autoMemory: { directory: memoryDir, enabled }` | flag layer: `autoMemoryDirectory = memoryDir`, `autoMemoryEnabled` from the effective settings |
| flag layer | — | `plansDirectory`, and `permissions.ask` = `protectedPathRules(...)` (the sdk home's item dirs and instructions file, and the trusted project's item dirs at any depth under the root — `//<root>/**/.winter/<kind>/**`, measured to fire on the pin — in both spellings) appended to the host's own (a host `permissions.deny` survives) |
| plugins | from the run home's `enabledPlugins` | the same; `Options.plugins` and `OptionsTemplatePolicy.plugins` are gone, and a `plugins` key is refused on every launch |
| outcome | `pending` while the returned `Query` runs; `safe` once it settles (done, `return()`/`throw()`, a rejection, or disposal) — no working copy, but the child reads the run folder while it runs | `pending` until the exit reconcile |

**Every router consumer of the home, decided** (plan r2 I3). `handoff.winterHome` stays the daemon's
home; a router created with `requireRunHome` (which must name it) roots its store at
`sdkHomeOf(winterHome)`, exposed as `SharedStoreIdentity.storeHome`.

| consumer | decision |
|---|---|
| `store/wiring.ts` — `createSharedSessionStore` / `lazySharedSessionStore` | the concrete store is rooted at `storeHome` (`<home>/sdk`); `identity.winterHome` stays the daemon home |
| `store/handoff-barrier.ts` — the lease root | kept at `<home>/runtimes/handoff-leases` (`homeOf()`) |
| `store/handoff-barrier.ts` — step 5's validation, step 8's canonical path, the sidecar report | `storeHomeOf()` = `identity.storeHome` |
| `store/materialized-resume.ts` — the decorator's canonical path | `identity.storeHome` |
| `door.ts` — the provider-state sidecar, the default memory dir | `identity.storeHome` |
| `door.ts` — the spool (`officialSpoolRoot(home)`) | pre-WS-21 profile only; a fresh generation on a run home runs in its run folder, and naming `runtime.official.spool` beside a run home is refused |
| `messaging/winter-adapter.ts` — the cold resume | awaits the host's `runHomeFor` first and applies the result with the same check-and-apply as `query()`; without `runHomeFor` under `requireRunHome` it answers a non-retryable `unavailable`; the router disposes that run home when the resume ends |
| the peer's `resolveWinterHome()` fallback | never used under `requireRunHome` (the home must be explicit — the agent SDK's WS-21 default moves to `~/.winter/sdk`, so `sdkHomeOf` of it would double up) |

**What `0.0.11` changes** (a security fix: the official leg no longer loads the session's
own project directory as a plugin; no peer floor change, no devDependency change):

> **Behaviour change for hosts.** After this bump the official leg loads **no** project
> `<projectDirName>/{skills,agents,commands}` (nor that directory's hooks) at all. It keeps loading
> none until the host passes a trust-gated `OptionsTemplatePolicy.plugins` list. The follow-up is the
> host's: decide which plugin directories a session trusts, and name them. **Treat every file in a
> named directory as code, skill files included.** A "skills-only" directory narrows what loads but
> sanitises nothing (see the "a skill file is code" row). Exposing a project's skills, or anyone's, is the same
> trust decision as exposing its hooks.

| | |
|---|---|
| the router names no plugin of its own | `buildOfficialOptions` used to hard-code `plugins: [{ type: "local", path: "<cwd>/<projectDirName>", skipMcpDiscovery: true }]`, with no trust decision anywhere and no field a host could use to replace it. The pinned runtime loads a local plugin directory as code: its `hooks/hooks.json` runs by default, and its skills, agents and commands load with it. So a Code session opened on any cloned repository ran that repository's hook commands on the first prompt. Measured on 0.3.250: a `UserPromptSubmit`/`SessionStart` command hook in the project directory ran, and its skills loaded as `<projectDirName>:<name>`, which a bare `Skill(<name>)` deny rule does not match. The entry is gone. With no host policy, the built options carry no `plugins` key and the session loads no plugin at all. |
| `OptionsTemplatePolicy.plugins` | The host's list, forwarded to `Options.plugins` in the same order with every field unchanged. `buildOfficialOptions` copies the list and each entry, so a later mutation of the host's array cannot change what launches. `launch()` given hand-built options validates them but forwards the caller's own array. Absent stays absent, like `agents`. Per-query policy (`RouterOfficialInput.options`) replaces the deployment-wide list (`RouterOfficialPolicy.options`) and does not merge with it. This is the same precedence every other template field has. The runtime loads everything a plugin root holds: `hooks/hooks.json`, skills, agents, commands, output styles, `.lsp.json` language servers (processes it spawns), and a plugin `settings.json` whose `agent` key can replace the main agent. Only the host can decide which directories get that trust. |
| what the runtime names a host's plugin (measured) | A directory with no `.claude-plugin/plugin.json` is accepted and named after its basename. With a manifest, its `name` is used. Skills qualify as `<plugin name>:<skill directory name>`: a SKILL.md frontmatter `name:` that differs does not rename the skill. They appear in `init.skills` and `init.slash_commands` under those names. |
| a skill file is code (measured, `runtime-plugins.test.ts` 3c) | A view holding ONLY `skills/x/SKILL.md` is not inert. Its SKILL.md had `allowed-tools: Bash(/usr/bin/touch:*)` and an inline `` !`cmd` ``. The inline shell ran when the model invoked the skill, although the broker approved only the `Skill` call: the broker was never asked about Bash, and PreToolUse hooks never saw it. The skill's frontmatter `hooks` (`PostToolUse`) command also ran. Its `allowed-tools` stayed granted, so the model's later matching Bash call ran without the broker being asked. A user-typed `/<plugin>:<skill>` ran the shell with no approval at all. |
| `assertOptionsInvariants` validates every entry | Every entry is checked on every launch, including hand-built options passed to `launch()`. The rules: `type: "local"` only (the pin's one type); `path` absolute (a relative root resolves against the project); no `..` segment; no NUL byte; `skipMcpDiscovery: true` required (also by the policy's type). The last one keeps WS-14 §11: the host owns every MCP server, and a plugin's own MCP configuration is a server nobody registered. The path may never be the session's working directory, its `<projectDirName>` or `.claude` in it. That rule catches the 0.0.10 path in disguise (trailing slash, `/./`, `//`, and on darwin/win32 a case variant). It is compared after normalizing, and it is lexical: symlinks are not resolved. Paths merely under the working directory are allowed, because a `$HOME` session legitimately names `~/<projectDirName>/cache/…`. The check needs the project directory's name and a working directory: `buildOfficialOptions` and the adapter's launch pass them through the new optional `OptionsInvariantContext`, and a `plugins` list with no known working directory is refused. A refusal is an `OfficialConfigurationError` with `option: "plugins"`. |
| `appendSystemPromptFile` must be absolute | The runtime resolves a relative `append-system-prompt-file` against the session's working directory, i.e. the project. A relative (or non-string) value is now refused with `option: "extraArgs"`. |
| `OfficialPluginConfig` | A new seam type exported from the root: the pin's `SdkPluginConfig`, structurally. `OfficialOptions.plugins` is narrowed from `unknown` to `OfficialPluginConfig[]`, and `official-shapes-conformance.test.ts` pins both directions and the one-member `type` union. |
| the other project-controlled surfaces, re-measured | These stay shut, measured against a hostile project in `test/official/runtime-plugins.test.ts`: `CLAUDE.md` (at the root, nested, and `.claude/CLAUDE.md`), `.claude/rules/*.md` (unconditional, `paths:`-conditional, nested), `.claude/settings.json` hooks, `.claude/{skills,agents,commands}` and a `.mcp.json` stdio server. They stay shut even after the model Reads a file that would pull the nested and conditional ones in. A control that launches the pin directly with `settingSources: ["project"]` loads every one of them. `settingSources: []` and `strictMcpConfig: true` already refused them. The plugin entry was the only project-controlled input left. |

**What `0.0.10` changes** (a LIVE permission-mode change reaches the official child; no peer floor
change, no devDependency change):

| | |
|---|---|
| `OfficialQuery.setPermissionMode(mode)` | The seam named exactly two of the pin's `Query` members, so a host holding an official session had no typed way to change its permission mode — and `Options.permissionMode` is fixed for the whole generation. A Code session switched from `accept-edits` to `ask` therefore went on auto-approving every edit INSIDE the child, with no approval card and no trace, until the session's next incarnation; a switch into or out of `plan` did nothing at all. The pinned 0.3.250 has always declared `setPermissionMode(mode: PermissionMode): Promise<void>` ("only available in streaming input mode" — a control request on the same streaming stdin `interrupt()` uses, so it applies to the turn that is RUNNING), and the Winter leg has always used it: this is parity, not a new capability. It is now on the seam's `OfficialQuery`, on `OfficialSessionHandle`, and — as a NAMED member, not a trapped one — on the handle the door returns. |
| `OfficialPermissionMode` moved to `src/seams/official-sdk-shapes.ts` | It is a structural mirror of a vendor union, which is that file's whole job, and the seam's `OfficialQuery` now names it. `src/official/callbacks.ts` re-exports it, so every import site and the published name under `src/index.ts` are unchanged. Still FIVE members where the pin's `PermissionMode` has six: `auto` is deliberately absent, because the pin's own `setMcpPermissionModeOverride` doc states an override "applies only when the session mode would already auto-allow (bypassPermissions/auto)" — `auto` is an auto-allowing mode, the same class as the one this branch already refuses for shadowing `canUseTool`. `official-shapes-conformance.test.ts` pins both the subset direction and the absence, so widening it is a deliberate edit rather than a drift. |
| `assertPermissionModeAllowed` — one rule, two doors | `bypassPermissions` was refused inside `assertOptionsInvariants`, on the launch path only. A live setter is a SECOND way to reach a mode, one that never passes through the options template, so the refusal is now an exported function that both call: the same `OfficialConfigurationError { option: "permissionMode" }` with the same sentence, raised BEFORE the control request is sent and before the lazy spawn — a refused mode never reaches the child and never costs a host a child process. A live switch can therefore never land on a mode a launch would have refused. Anything the CHILD itself refuses rejects with the child's own failure, unwrapped, so a host can tell the two apart. |
| `ApprovalBridgeOptions.mode` accepts a function | `createApprovalBridge` short-circuits `dontAsk` to ALLOW without consulting the host's broker, and it captured the mode once, at spawn. With a live setter that becomes a hole of its own: a session spawned `dontAsk` and switched to `default` starts receiving `canUseTool` requests from the child, and a bridge frozen at `dontAsk` would auto-approve every one of them without the broker ever seeing a call. The door now passes `() => currentMode` and assigns `currentMode` only AFTER the child has accepted the switch, so the bridge and the child can never disagree — a failed switch leaves both describing the mode the child is actually in. A bare literal is still accepted, for `buildOfficialOptions`'s own fail-closed default and for every existing caller. |
| the door handle's edges, unchanged in shape from `interrupt()` | CLOSED handle → `RuntimeLaunchInputError` ("there is no session to act on"); NOT YET SPAWNED → the lazy launch happens and then the mode is set (deliberately not a silent no-op: `Options.permissionMode` is already fixed by then, so answering "fine" would be the lie this change removes); ENDED generation → the vendor's own rejection passes through unwrapped. |

**What `0.0.9` changes** (subagent-definition parity on the official leg; devDependency:
`@yanlinglabs/winter-agent-sdk ^0.0.16`, no peer floor change):

| | |
|---|---|
| `OptionsTemplatePolicy.agents` | The daemon now owns subagent definitions and must hand the SAME set to both runtime legs. The Winter leg already takes them through `Options.agents`; this leg had no door for them at all — `buildOfficialOptions` assembles `OfficialOptions` field by field, so a stray `agents` key on the policy was silently dropped rather than forwarded. The new field is typed `Readonly<Record<string, unknown>>` (the strictest of this policy's own untyped-passthrough fields, `mcpServers`/`settings`) rather than against either SDK's own `AgentDefinition` — the value crosses to the official runtime's own pinned `Options.agents?: Record<string, AgentDefinition>` unread and unchanged, exactly like `mcpServers`, and accepting it never forces this package's peer floor upward. Absent stays absent: an omitted `agents` key, never an empty object, because "the host declared none" and "the host said nothing" are different official-leg agent surfaces. |
| `src/testing/peers.ts`'s fake `Query` gained `supportedAgents` | The devDependency bump to `^0.0.16` is what pulls in `Query.supportedAgents(): Promise<AgentInfo[]>` (spawn-surface parity, landed in the SDK's own 0.0.15) as a REQUIRED interface member; `scriptedQuery`'s literal is fixed the same way every other undriven `Query` method on this fake already is — `unsupported("supportedAgents")`, so a test can never mistake "nothing scripted this" for "the answer is zero agents". No router BEHAVIOUR reads `supportedAgents` anywhere; the peer floor (`peerDependencies`, `SUPPORTED.winterAgentSdk`, both still `>=0.0.13 <0.1.0`) is untouched because nothing here needs a Winter peer newer than that to run correctly — only the TYPES this package tests against moved. |

**What `0.0.8` changes** (WS-20 — provider-qualified model tags; peer floor:
`@yanlinglabs/winter-agent-sdk >=0.0.13 <0.1.0`):

| | |
|---|---|
| `requested.model` is now a tag, always (`bare-model-id`) | A bare model id (no `/`) is refused typed (`bare-model-id`) before any row is even resolved — `resolveModel`'s other spelling ("or a canonical model id") is gone: the provider-qualified catalog row key (`"<providerId>/<modelId>"`) is the only shape it accepts, so two providers serving the same raw id never resolve to "pick one". |
| the tag alone pins the provider (`provider-mismatch`) | `resolveModel` now carries the matched row's own `providerId` through to `candidatesFor`, so a tag with no `requested.provider` field lands on exactly its own row — never the first row the listing happens to order — even when a sibling provider serves the same canonical model and both are credentialed. A request naming both a tag and a `provider` field that disagree is refused typed (`provider-mismatch`) rather than resolved by picking one side silently. |
| `console/<id>` derives `authFamily: "console-profile"` | The catalog's new `console` provider IS the Anthropic Console arm: `candidatesFor` overrides any row with `providerId === "console"` to `console-profile` regardless of its credential ref's storage kind, and `console-profile` is now a member of `OFFICIAL_SERVED_AUTH_FAMILIES` (served unconditionally, no protocol gate) — a `console/*` row routes to the official runtime on its own. Admission is unchanged: a `console` row with no configured credential ref anywhere is still excluded before the override ever runs. |

**What `0.0.7` changes** (DEFECT 3 — a blocking product defect Norma's hermetic e2e found; no peer
floor change):

| | |
|---|---|
| a failed winter -> official handoff releases the SDK writer lease it took, not just the router's own bookkeeping | For the confirm-first direction (winter -> official: `destination.confirmInit` runs before anything commits), step 6 acquires the SDK's own `WinterCompatibilitySessionStore` session writer lease before staging the pending-handoff marker. When `confirmInit` refused (or any later step failed), `unwind()` cleared the router's own `pendingHandoff` marker and staged copy but never released that lease — and the daemon process holding it never exits, so the lease was never stale. Every later attempt to re-spawn the Winter source for the same backend session id found its own lease held by a live, foreign pid and refused outright. Measured directly against the real `winter` binary (v0.0.11): this reproduces `ResumeTargetError: session <id> is in use by another live process (pid <n>)`, surfaced by the SDK wrapper as `CLIConnectionError: runtime exited before init` — the reported symptom, byte for byte. `unwind()` now releases the writer lease on any path that does not end with a confirmed claude-agent destination (in-process; never needs it released for anyone else to use it); the same gap in the M1 pending-revert refusal at step 6 is closed too. |

**What `0.0.6` changes** (Phase 10b fix wave 2 — three bugs an Opus whole-branch review found in
`0.0.5`'s handoff barrier, plus a re-review's own MAJOR/MINOR/cosmetic micro-round; no peer floor
change):

| | |
|---|---|
| `reviewSwitch` reads the LIVE source, not the stale directory record (CRITICAL C1) | The directory's persisted `RuntimeSelection` moves only on a cross-runtime handoff; a same-runtime model change or the engine's own fallback/interrupt switch never touches it, so `computeSwitchReview`'s `from` could silently name a model several turns behind the one that actually produced the session's last reply — under- or over-stating loss, and letting a switch BACK to the stale recorded model slip past the same-profile skip with no prompt. The switch's source is now the live tip's own identity: the last assistant entry's sidecar `kind:"origin"` record when Winter wrote one, else the official leg's own `message.model`, else (only when the lineage has no assistant entry at all) the persisted selection. |
| the revert takeover retries, and a failed revert is never `resumed` (MAJOR M1) | For a winter destination whose `confirmInit` fails, taking the writer lease back to revert the write-ahead record to the source now retries with the same bounded backoff (5×200ms, `HandoffBarrierDeps.leaseRetryDelayMs`) step 6 already uses for the identical race the other direction. A revert that still fails is reported `HandoffOutcome` **`{ kind: "blocked", reason: "revert-pending" }`** — a host with an exhaustive `switch` on `blocked.reason` needs a case for it — never `resumed`: the old bug's single attempt threw past the outer catch, which read `resumed` off `committed` alone regardless of whether the revert landed. The still-owed append is recorded in a new **`<sessionId>.pending-revert.json`** file beside the handoff lease, under `runtimes/handoff-leases/<projectKey>/` — router-owned, not the host's directory schema, and self-clearing: `plan()`/any load retries the append once the lease frees up, and deletes the file the instant it lands, AND `execute()`'s own step 6 reconciles one for the same session (with the writer lease it just took) before staging a brand-new handoff over it — otherwise a later `loadEntry` could apply the stale note and silently undo a handoff that had since succeeded. A retention or `doctor`-style pass over `runtimes/handoff-leases/` should treat this file as transient, self-healing state, not an error to report. |
| `reviewSwitch` is read-only (MINOR m3) | `reviewSwitch` now runs on every `setModel`, including while a winter child holds the lease. It went through `loadEntry`, which can append a `pendingHandoff:null` repair for crash residue; with the lease held elsewhere that append threw, and every model change prompted generically, even Sonnet ↔ Opus. `reviewSwitch`/`computeSwitchReview` now read the directory through the bare, repair-free lookup; the repair stays exactly where `plan()`/`execute()` already own it. |
| an error-residue or off-catalog tip no longer defeats the same-family skip (MAJOR, re-review) | A failed Claude call writes an `isApiErrorMessage:true` assistant entry with a synthetic `model:"<synthetic>"`; read as the live tip, its unknown identity broke the same-family skip right after an error. `findLiveTipAssistant` now walks PAST that residue (and any `isApiErrorMessage:true` entry) to the real reply underneath, exactly as the SDK reader already does for W18-13(c). Separately, a REAL but off-catalog id (a dated snapshot like `claude-opus-5-20260301`, a Bedrock ARN like `us.anthropic.claude-opus-5-v1:0`) is no longer handed to the review as if it had resolved: new root-adjacent `catalogKnowsModel` (`default-endpoint-resolver.ts`) checks `ProviderRegistry.resolve()` directly rather than inspecting a `ContinuityEndpoint`'s shape (unreliable — a real row and an unresolved fallback can look identical). An id the catalog does not recognise falls back to the persisted selection when it already names the official leg, or keeps `family:"claude"` intact otherwise. |
| a late revert restores only `producerRuntime` (MINOR, re-review) | The revert record used to spread the WHOLE step-6 snapshot; applied late (after a retry, or via the pending-revert note), it folded a stale `projectionCursor`/`compatibilityLevel`/`sourceGenerationCompleted`/`handoffAt` — and a stale `health:"clean"` that could hide a real `repair-required` — back over newer values. It now carries only `{ type, producerRuntime: <source>, pendingHandoff: null }`, the same narrow-fold shape `unwind()`'s own marker-clear already uses. |
| a pending-revert note write failure is logged and named (MINOR, re-review) | `writePendingRevert` failing used to be silently best-effort, which could reintroduce the original bug through a second path (no note → the next load "repairs" toward the destination). The outcome is still `blocked: revert-pending` (no new `HandoffOutcome` shape), but a write failure is now logged once (names and error class only) and folded into the returned `detail`, so a host can tell "this will self-converge" apart from "this needs manual reconciliation". |

**What `0.0.5` changes** (Phase 10b — cross-family same-session parity; peer floor:
`@yanlinglabs/winter-agent-sdk >=0.0.10 <0.1.0`; two NEW required peers, `@yanlinglabs/winter-provider-catalog`
and `@yanlinglabs/winter-provider-runtime`, both `>=0.0.10 <0.1.0`):

| | |
|---|---|
| requested-target review (W18-4) | `plan(session, to, { requested })` reviews a FRESH selection the caller already decided for a family-crossing model change, instead of the persisted one, unmerged with anything from the source's own credential/provider. `HandoffPlan.requested` carries it through to `confirmInit`. |
| the no-credential refusal (W18-3) | `SelectionRefusal.reason` gains `"no-credential"` (widened to `string` beyond the pinned members) and an optional `alternatives: SelectionAlternative[]` — every catalog door able to serve a Claude row, configured or not (Anthropic API key, Console, Bedrock, Vertex, the claude.ai subscription only when `claudeOauthApproved`, and any other provider's declared auth view), so a host's hint is built FROM the refusal rather than a hardcoded list. |
| Claude-shape compaction, validated (W18-12) | `validateCompaction` (step 5) now recognises Claude's own camelCase `compactMetadata.preservedMessages.{anchorUuid,uuids}` alongside the legacy snake-case shape — officially-compacted sessions could not hand off at all before this. |
| summarized thinking display (W18-17) | Every official launch's `extraArgs` now carries `"thinking-display": "summarized"` (merged with `appendSystemPromptFile`'s own entry), asking Claude for its summarized thinking without touching the thinking type or budget the leg derives. |
| the winter-destination write-ahead (W18-5) | For a winter destination, the producer record commits and `SharedSessionStore.releaseLease` runs BEFORE `confirmInit` — the daemon's pid writes nothing to the canonical transcript once the winter child holds the lease. A confirm that fails takes the lease back over and reverts the record to the source. winter → official gets a bounded (5×200ms, `HandoffBarrierDeps.leaseRetryDelayMs`) writer-lease retry, because the exiting winter child's own process exit is asynchronous relative to `owner.close()` returning. |
| the Claude-ready store and the resume door (W18-8, W18-14) | New `official/claude-ready-store.ts`'s `claudeReadyStore(store, deps)` wraps `sessionStore.load()` with `toClaudeReady(...)` — appends and every other member pass through untouched, and the canonical file is never written by a load. The official leg's own resume-vs-fresh decision now lives HERE, not with the caller: it opens with `resume` (no `sessionId`) whenever the canonical transcript already has a conversational entry for the named backend id, and with `sessionId` (no `resume`) for a genuinely empty one. |
| `reviewSwitch` (W18-20) | `HandoffBarrier.reviewSwitch(session, requested)` — the one pre-flight loss review for every family-crossing change, same-leg or cross-runtime. Reads the canonical transcript and provider-state sidecar through the shared store, resolves both endpoints, and returns `@yanlinglabs/winter-provider-runtime`'s `reviewModelSwitch(...)`. `HandoffPlan.review` embeds the same classification whenever the plan's selection is servable. |
| the DEFAULT endpoint resolver (fix round 1, CRITICAL) | New root export `defaultEndpointResolver()`: a registry built from the compiled catalog (`@yanlinglabs/winter-provider-catalog`'s `loadCatalog()`, no network, no credentials) via `createRegistry`/`createEndpointResolver` — never `endpointFromOrigin` alone, which reported `readableState: "none"` for every model and silently over-warned a lossless exposed-reasoning transfer. `HandoffBarrierDeps.resolveEndpoint`/the official leg's own `resolveEndpoint` fall back to it; a host's own injected resolver always wins. |
| root exports | `defaultEndpointResolver`, `SelectionAlternative` (type), `hasConversationalEntry`/`providerStateSidecarPath`/`readProviderStateSidecar`, `claudeReadyStore`/`ClaudeReadyStoreDeps`/`ProviderStateRecord` (from `./official`, re-exported), `HandoffBarrierDeps.resolveEndpoint`/`.reviewSwitchBudgetChars`/`.leaseRetryDelayMs`. |

**What `0.0.3` changes** (P8c-13 — the official-leg HOST SURFACE, so a host can bridge its own
approval broker and materialize MCP servers; no peer floor change):

| | |
|---|---|
| root exports | `createApprovalBridge`/`isOurApprovalBridge` (+ `ApprovalBroker`/`ApprovalRequest`/`ApprovalBridgeOptions`/`DecisionSource`/`OfficialPermissionMode`/`OfficialApprovalBridge`), `materializeOfficialMcpServer`/`officialMcpServers`/`winterMcpServerDescriptor`/`canonicalToolNames`/`OFFICIAL_MATERIALIZATION_DROPS` (+ their descriptor/schema types), `minimalOsEnvironmentFrom`/`buildOfficialChildEnv` (+ env-policy types), the containment/auth/options-template types, `containmentDispositions`/`officialDisallowedTools`, `officialBranchLabel`/`OFFICIAL_DISCLOSURES`, and `renderAttributedTurn` — all previously reachable only through `./official/index.ts`, a test-only import site. `buildOfficialOptions` uses `policy.canUseTool` verbatim and `assertOptionsInvariants` refuses anything not built by `createApprovalBridge`, so without this a host's every official-leg tool call was denied by the fail-closed default. The spawn-proxy/adapter internals (`createSupervisedSpawnProxy`, `createOfficialAdapter`, …) stay OUT — their declaration graph pulls Node-only types into a consumer that never asked for them; the door reaches the adapter through the seam, not through a root import. |
| `./testing` subpath | `createFakeKeychain`, `withHermeticHomes`, `withTempDir`, `createFakeClaudePeer`, `createFakeWinterPeer`, `HERMETIC_TRAFFIC_OPT_OUTS`, `officialCaptureEnv` — a NARROW barrel (`src/testing/host.ts`) that resolves neither `@yanlinglabs/winter-conformance` nor `@yanlinglabs/winter-provider-conformance`, so a host writing its own approval-bridge/MCP fixtures does not have to install either. The loopback fakes (`anthropicFake`, `openaiResponsesFake`, `requestsTo`, `withLoopbackFake`) and the golden-trace tooling stay on the internal, unpublished `./index.ts` barrel this repository's own tests use by relative path — a dynamic `import()` fixes their RUNTIME load without the peer, but not their TYPES, which still name it. |
| root exports (types only) | `HandoffParticipants`, `HandoffSourceOwner`, `HandoffDestinationRuntime`, `HandoffResumeTarget`, `HandoffStepReport`, `HandoffOwnerHealth`, `HandoffEligibilityLike`, `DetailedHandoffOutcome`, `HandoffBarrierDeps`, `HandoffSelection`, and `MaterializedResumeDecoratorHandle` (`HandoffBarrierDeps.decorator`'s type) — the data shapes a host actually renders a handoff plan/outcome from, not just `HandoffBarrier`/`HandoffOutcome`/`HandoffPlan` (already reachable via the seams). Pure interfaces: none pulls a `node:*` specifier into the declaration graph. |

**What `0.0.2` changed** (peer floor: `@yanlinglabs/winter-agent-sdk >=0.0.3 <0.1.0`):

| | |
|---|---|
| `peerVersions` | A host DECLARES its peers' versions — the only door inside a compiled binary, where `require.resolve` cannot see out of the bundle to read a manifest. |
| `capabilities` + `toInputShape` | The host's own MCP servers, forwarded to BOTH legs: by reference into the Winter leg's `Options.mcpServers`, and registered into the official runtime from the same declaration. One declaration, two registrations, identical canonical names. |
| `advisor` | The standing server carries Winter's four default tools, `advisor` among them, bound under the official runtime's built-in names (measured: the pin honours an alias key that is not one of its own built-ins — `docs/probes/advisor-alias.md`). `advisor` supplies the REVIEWER; the tool is always registered. |
| no tool ownership | `src/native-args.ts` and the router's messaging handlers are gone: the definitions, schemas, acceptors, handler factories and the advisor all come from `@yanlinglabs/winter-agent-sdk/tools`, and this package re-exports none of them. |

---

## The door: `query()` over both runtimes

`RuntimeSdk.query()` routes by the session's DECIDED `RuntimeSelection`, and each leg returns its own
runtime's handle untouched.

```ts
// The host owns the capability tools and hands them over as MCP SERVERS; the router forwards the same
// servers to BOTH legs and rewrites nothing else (R-8-1). `toInputShape` is the one line of glue the
// official branch needs — its in-process server constructor takes schemas in its own validator's shape,
// and this package deliberately depends on no validator.
const sdk = createRuntimeSdk({
  peers,
  keychain,
  vendoredOfficialRuntime,
  capabilities: [computerServer, browserServer, officeServer],   // your own `{ type: "sdk", name, tools, instance }`
  toInputShape: (schema) => jsonSchemaToZodRawShape(schema),     // one line, over the validator you already have
});

// The Winter leg: exactly what it always was. No runtime input, so nothing is decided and nothing
// is stripped — the caller's own `options` object is forwarded by reference (with no `capabilities`
// configured, by IDENTITY; with them, a copy whose every other member is still your own object, plus
// your servers under `mcpServers`).
for await (const message of sdk.query({ prompt: "hello" })) { /* SdkMessage */ }

// The official leg: a `claude-agent` selection, plus what only a host can answer.
const query = sdk.query({
  prompt: turns,                                  // string, or an AsyncIterable<string>
  options: {
    cwd: "/work/repo",
    provider: { providerId: "anthropic", authRef: { kind: "keychain", account: "anthropic:default" } },
    runtime: {
      selection,                                  // the session's PERSISTED choice (D13)
      official: {
        sessionId: "s-42",                        // its directory row is `session:s-42`
        base: minimalOsEnvironmentFrom(process.env),
        // OPTIONAL SINCE 0.0.2: the router materializes the standing server and your capability
        // servers itself. This stays as the escape hatch, and its reach is exactly one key: an entry
        // under the BRAND's own standing-server name replaces the router's (that key reaches no other
        // leg, so overriding it diverges from nothing); an entry naming a forwarded CAPABILITY is a
        // typed refusal on BOTH legs, because that name is on both and a silent override would leave
        // the two branches running different tools under one canonical name.
        // mcpServers: officialMcpServers({ /* … */ }),
      },
    },
  },
});
```

**What the host passes, and why the Winter leg needs none of it.** A `winter-agent` session is served
in-process by an SDK that already reads everything it needs from `Options`. A `claude-agent` session is
a supervised CHILD PROCESS with a durable row of its own, so the door needs three things `Options` has
no field for: the **session id** its directory row is addressed by (WS-14 §6 rule 2's record is written
onto that address, and the messaging registry attaches under it), the **minimal OS environment**
(WS-14 §3's child env is a REPLACEMENT built from an allowlist — nothing inherits, so nothing is read
from `process.env` by this package, and a `base` without `HOME` is **refused**, because the runtime
resolves `os.homedir()` through the OS user database when it is missing and `CLAUDE_CONFIG_DIR` cannot
scope that), and the **vendored runtime path** (§5.1: never the user's
installed binary; give it once as `createRuntimeSdk({ vendoredOfficialRuntime })` or per query as
`options.pathToClaudeCodeExecutable`). Everything else has a default that is either derived from the
brand or read from the pinned contract you already fill in: credentials come from
`options.provider.authRef` through your own `KeychainSeam`, the spool from the resolved Winter home,
the session store from the one shared instance both branches use.

**What `SessionKey` a door-opened session has.** `sdk.handoff(session, to)` and every store-facing API
take a `SessionKey`, and both halves of it are chosen by the door rather than by you: `projectKey` is
the transcript project key the door set on the child (see "the transcript key" below) and `sessionId`
is the **backend uuid the vendor allocated**, not `runtime.official.sessionId`. The door records that
uuid on the session's directory row as `backendSessionId` the moment the runtime reports it at
`system/init`, so
`sdk.handoff({ projectKey, sessionId: (await sdk.directory.get("session:s-42"))!.backendSessionId! }, "winter-agent")`
is the route. WS-15 §6.2's cold resume of an exited official session reads the same field.

**The transcript key** (R-7b-13). The official child is given
`CLAUDE_CODE_PROJECT_DIR_NAME`, and it defaults to the Winter SDK's own
`transcriptProjectKey(options.cwd)` — read off the peer you injected, never re-derived — so both
branches write under one project directory for one working directory, and the auto-memory directory
(WS-14 §2's ONE shared directory) derives from the same key. It is also the `projectKey` half of the
`SessionKey` above. **The pinned runtime validates that variable against `^[A-Za-z0-9_-]{1,64}$` and
silently substitutes its own cwd-derived name when it does not match**, so the door refuses a key it
would reject — including its own default — rather than letting the row, the environment and the memory
directory name a transcript that is somewhere else. Two consequences for a host: a deep working
directory (a sanitized path over 64 characters) needs an explicit short `runtime.official.projectKey`,
and the vendor's own fallback key is built from the **realpath** of `cwd` (`/private/var/…` on macOS)
while `transcriptProjectKey` takes the path as given — so pass the key explicitly rather than relying
on either default when the two could differ.

**What the persisted selection means.** `runtime.selection` is "what this session's record says", so a
selection that DISAGREES with the record is a request to change runtime — and D13 answers that with
the certified handoff (`sdk.handoff(session, to)`) or a visible fork, never by serving the new runtime
on the old transcript. The door refuses with `RuntimeHandoffRequiredError`: in-process on both legs
(pass `runtime.sessionId` so it can hold you to it) and, on the official leg, against the DURABLE
directory row before a credential is read or a child spawns. On a session with no record yet, the
decided selection is PERSISTED at creation, by the door.

**What each leg returns.** The Winter peer's `Query` on one side and the official SDK's own `Query` on
the other — verbatim, both of them. They are different types (the Winter handle carries `messaging`
and `listModelFamilies`; the official one carries a dozen members this package deliberately never
names on its published surface), so `query()` is overloaded: a call with **no** `options.runtime` can
only reach the Winter leg and is typed `Query`, and a call that passes one is typed
`Query | OfficialQuery`. `isOfficialQuery(handle)` narrows it. On the official leg the launch happens
at the FIRST PULL — the same lazy spawn the vendor's own `query()` performs — because WS-14 §12's
"credentials are fetched at spawn" is asynchronous and `query()` returns a handle rather than a
promise for one; `close()` before the first pull starts nothing at all.

**A live session's input stream is how messages reach it.** R-7b-4: delivery into a live session of
either runtime is a push into that session's input stream. Pass an `AsyncIterable<string>` prompt and
the door owns that stream — your turns and the router's deliveries interleave in order, with your own
backpressure preserved — and the session is attached to `sdk.messaging` as a live receiver. Pass a
**string** prompt and the vendor runs one turn and exits: the session is still recorded in the
directory, but there is nothing to push into, so it is not attached and delivery to it answers
`unavailable` rather than pretending.

**A session's END is recorded too**, and it changes what a delivery gets. When the message stream
completes (or `close()` runs) the door detaches the handle, closes the stream and records the row
`exited` — `unavailable` on a stream that ended in a fault. So a streaming session whose input has
ended answers **`unavailable` (non-retryable)** exactly like a string-prompted one, never
`delivery_uncertain`: "the write may have landed" is not an honest answer for a session where nothing
can land. `sdk.messaging.listReachable` stops listing a session at the same moment (WS-10 §10.2: a
listing does not enumerate exited transcripts), and a launch that refuses synchronously leaves no row
at all.

**The official branch disables the runtime's remote feature configuration by default** (R-7b-11).
Every official child gets `TRAFFIC_OPT_OUT_VARIABLES` — the four names are exported, so read them
rather than trusting this sentence. Measured on the pin, same binary and same options: 25 advertised
tools with the fetch, 21 without; `DesignSync`, `Monitor`, `PushNotification` and Anthropic's own
API-side `advisor_20260301:advisor` appear only when a CDN answers — that one is the vendor's server
tool, orthogonal to what follows. A tool surface that moves with no version moving is not a pinned
artifact, so this is on unless you say otherwise: `remoteConfig: "allow"` (per query on
`runtime.official`, or deployment-wide on `createRuntimeSdk({ official: { env: { … } } })`) opts back
in, and the choice is recorded on the session's directory row as `RuntimeDirectoryEntry.remoteConfig`.

**Winter's own `advisor` is registered on the official branch too (R-8-1), backing Anthropic's rather
than being refused.** WS-14 §11's standing MCP server used to throw if a capability list named
`advisor` — each branch was meant to have its own, unrelated advisor. The user's tool-ownership ruling
reverses that: `mcp__<brand>__advisor` is reachable on the official branch exactly like
`send_message`/`list_agents`, independent of whether the CDN-gated API-side one above is present that
session. `docs/probes/d29-advisor.md` §6 has the full reversal and what it does and does not change.

**The materialized-resume PREFERRED door is open for the pinned runtime, by measurement** (R-7b-12).
WS-17 §8's four probes pass against 0.3.250 on darwin-arm64 and linux-x64, so a handle over that peer
decorates the materialized copy and leaves the canonical file byte-pure; any other version — or no
official peer — gets the always-available FALLBACK door (one labelled entry appended after the
destination confirms). The verdict is data (`materializedResumeReportForPin`), keyed by version and
re-derived in CI against the real artifact, so a pin bump is a reviewed event rather than an inherited
answer. A host that measured its own pin passes `handoff: { decorationReport }` and wins.

---

## What a host needs to know before wiring this

Each of these is behaviour you cannot discover from the type signatures, and each has a test behind
it. They are stated here because a host that learns them from an incident learns them expensively.

**Inbound messaging to an official session is FAIL-CLOSED until you wire a permission class.** WS-10
§13 decides delivery from the sender's and receiver's permission classes, and the official runtime
exposes no way to read its own. So `official.permissionClass` — passed as
`createRuntimeSdk({ messaging: { messaging: { official: { permissionClass } } } })` — is the ONLY way
that class is ever known, and without it **every message to every official session is HELD**, never
delivered. The hold is *default-kind*: it is released the moment the class becomes knowable, and it
expires under §13's five-minute dialog window. Two things follow that you should design for: **the
expiry sweep is LAZY** — a held message's receipt is rewritten to `refused` when something next
addresses that receiver, not on a timer of its own, so between the fifth minute and the next send the
receipt still reads `held`; and **a hook that throws is an answer, not a crash** — it falls through to
`unknown`, which holds.

**Session-name leases are global by construction.** A display name that has been used is remembered
after the object is gone, so addressing it earns "that referred to something that has gone" rather
than "no such agent" (WS-10 §11 rule 5). Rule 5 governs children within their owning conversation;
sessions are global. Nothing forgets by itself: `RuntimeDirectoryOptions.retention` is where you set
how long a released lease and a receipted delivery record survive, and **absent means forever**,
because forgetting a lease changes what a model is told about a name it can no longer reach.

**The containment floor is a scan, not a sandbox.** The pre-hoc permission floor refuses any call
whose ARGUMENTS name a forbidden target (`CLAUDE.md`, `.claude/`, `~/.claude/plans`), case-folded and
NFKC-normalized for path fields and quote-stripped for command text. **Shell-escape and constructed
name spellings are caught POST-HOC**, by a sweep registered on `PostToolUse`, `PostToolUseFailure`
and `PostToolBatch` that snapshots the forbidden names under the session's cwd and the child's HOME,
removes what APPEARED under its roots during the call, records a typed breach and ends the turn — its
diff is TIME-BASED rather than causal, so under the child's HOME a vendor home created by something
else during a long call is removed and attributed to that call (narrow: an existing one is in every
baseline and is never touched). The sweep walks both
roots to a bounded depth (6 by default) around every filesystem-touching call, so **it costs a walk
per call**: on a large tree that is the dominant cost of the floor, and an incremental/fs-events
design is the follow-up. It sees the synchronously-visible effects of the call it brackets; a
background write that lands later is caught opportunistically by the next swept call.

**A host `PreToolUse` hook that answers `allow` makes 0.3.250 skip `canUseTool` for that call.** The
floor runs first and any deny wins, so containment is unaffected — but your broker will not see that
call, which matters if you were counting on it for audit.

**The extras door is a positive allowlist with two closed escape hatches.** `configuredExtras` admits
only names the pinned artifact's own environment registry declares AND that an independent rule
classifies as non-credential; anything auth-shaped is refused with a sentence naming why, and a
deployment that has REVIEWED a specific credential-shaped variable names it in
`reviewedCredentialShapedExtras` — one name at a time, never a wildcard.

A second class is refused **by name**, and the set is exported so you can read it rather than trust a
description: `EXECUTION_INDIRECTION_ENV_NAMES` and `EXECUTION_INDIRECTION_ENV_PREFIXES`
(`src/official/`). It is the **pinned artifact's own scrub list** — the environment the runtime strips
before running its policy helper, so the definition of "changes how the child executes code" is the
vendor's rather than ours — plus that runtime's own doors: `CLAUDE_CODE_SHELL` (the Bash tool's
shell), `CLAUDE_ENV_FILE` (sourced into every Bash call), the settings paths and plugin directories
(settings carry `hooks`, `apiKeyHelper` and `env`; plugins are code), the package-manager config files,
and the binary paths it executes. Whole prefixes are refused where a closed list cannot work:
`LD_*`, `DYLD_*`, `BASH_FUNC_*`, `PYTHON*`, `PERL5*`, `RUBY*`, `LUA_*`, `DOTNET_*`, `COR*`,
`APPDOMAIN_MANAGER_*` and **all of `GIT_*`** (git reads `GIT_CONFIG_*` for a `credential.helper` and
runs `GIT_SSH_COMMAND`, `GIT_EXTERNAL_DIFF` and `GIT_ASKPASS`).

Neither of the other two rules can see this class: these names are not credential-SHAPED, and the
pinned registry legitimately declares many of them, because the runtime really does read them — which
is why "the registry declares it" cannot be the whole test. Two of them were measured on the pin doing
exactly what the class describes before they were refused (a planted `CLAUDE_CODE_SHELL` ran as the
Bash tool's shell 114 times in one session; a planted `CLAUDE_ENV_FILE` was sourced into every Bash
call — `BASH_ENV` by another door). The reviewed door for this class is `reviewedExecutionExtras`,
again one name at a time, and a drift gate fails the suite when a pin bump adds a registry name of
this shape that nothing has classified.

**The approval bridge is fail-closed when no broker is configured.** A host MUST supply a broker: with
none, every call that reaches the bridge is denied. That is deliberate — the alternative is a session
that approves its own tool calls — and it means "I did not wire a broker yet" behaves like "deny", not
like "allow".

**`interrupt()` stops the turn.** On a streaming turn it ends the generation by throwing, which is
what a projector (Phase 8) must expect: an interrupted session's stream terminates with an error
rather than a result.

**A handoff will not check that the destination can serve the session unless you give it a catalog.**
`HandoffPlan.selection` reports `unreviewed` by default, because only the host holds the model catalog
and the credential map. Passing `createRuntimeSdk({ handoff: { selectionInputFor } })` turns it on:
`plan()` then asks the selector whether the RECORDED row is still servable and whether the destination
branch can serve it, and a plan that cannot be served carries a typed refusal instead — `execute()`
offers the lossy fork before the lease is taken, rather than after the drain and the staged copy.

**A handoff can deliberately leak one staging directory.** If the destination confirms init and the
producer record then fails to write, or if the destination throws while starting against the copy it
was handed, the `claude-resume-<uuid>` staging root SURVIVES — the destination may be reading it, and
deleting a live child's `CLAUDE_CONFIG_DIR` is worse than leaving a directory behind. It is locatable
at `outcome.target.stagingRoot` and belongs to your retention pass.

**Compiled hosts must declare their peers' versions.** The version matrix's second probe
(`resolved-manifest`) resolves a peer's `package.json` by walking up from `createRequire(...).resolve()`
— which cannot see outside a compiled binary's own bundle (`file:///$bunfs/...`). A host that
self-spawns its own compiled artifact and whose injected peer exports no version identity of its own
has nothing left for the matrix to read, and construction refuses. `createRuntimeSdk({ peerVersions:
{ winterAgentSdk, claudeAgentSdk } })` is the door: supply both from your own vendored
`VERSIONS.json`, stamped at your own build time (WS-02 §7.1). A declared version is checked FIRST —
it wins even over a peer that exports its own identity — and still has to satisfy the same
range/exact-pin checks as either probe; it changes how the identity was discovered, not what counts
as supported. A host that runs uncompiled (plain `bun`/`node`, source or an ordinary install) never
needs this field.

**"Exactly one runtime owns a session" is a convention here, not a mechanism.** The barrier moves
ownership only after the destination confirms, and the transcript's producer record is authoritative —
but the store's writer lease is re-entrant per pid and this router hosts both branches in one process,
so a determined host can still write from the source after a handoff. A real guard needs a
writer-lease generation the SDK store does not have; it is on the SDK's list.
