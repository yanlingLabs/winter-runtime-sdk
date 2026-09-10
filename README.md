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
- The host vendors all three packages directly (`winter-runtime-sdk`, `winter-agent-sdk`,
  `claude-agent-sdk`); this package declares the two SDKs as peer dependencies and receives their
  module instances by injection, so a host that never creates a Claude session never loads the
  official runtime and no SDK is ever instantiated twice.
- A `brand` profile flows through unchanged (Winter defaults); Claude Code's own literals stay fixed.

Status: Phase 7b, all four lanes landed and the door routed. The spine (the package scaffold, the
contract re-export, the `createRuntimeSdk` constructor with its version matrix, the seams, the test
harness and CI) and the four lanes behind those seams — the official-SDK adapter, the runtime
directory and messaging router, the store wiring and handoff barrier, and runtime selection — are on
`main`, with WS-17's eighteen router-owned rows proven and cited in `docs/conformance-rows.md`. See
`docs/architecture.md` for the ownership map, the pinned interfaces and how this package consumes the
Winter SDK before its first publish.

---

## The door: `query()` over both runtimes

`RuntimeSdk.query()` routes by the session's DECIDED `RuntimeSelection`, and each leg returns its own
runtime's handle untouched.

```ts
// The Winter leg: exactly what it always was. No runtime input, so nothing is decided and nothing
// is stripped — the caller's own `options` object is forwarded by reference.
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
        mcpServers: officialMcpServers({ /* … */ }),
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
