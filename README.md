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

Status: Phase 7b, all four lanes landed. The spine (the package scaffold, the contract re-export, the
`createRuntimeSdk` constructor with its version matrix, the seams, the test harness and CI) and the
four lanes behind those seams — the official-SDK adapter, the runtime directory and messaging router,
the store wiring and handoff barrier, and runtime selection — are on `main`, with WS-17's eighteen
router-owned rows proven and cited in `docs/conformance-rows.md`. See `docs/architecture.md` for the
ownership map, the pinned interfaces and how this package consumes the Winter SDK before its first
publish.

**`query()` serves the Winter leg today.** A session whose selection names `claude-agent` is REFUSED
with a typed `RuntimeNotRoutedError` rather than quietly served on Winter — D13's "the certified
handoff or a visible fork, never a silent rewrite" applies to this door too. The official branch is
reached through `runtimeSdkInternals(sdk).official` until the door routes both runtimes.

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

**"Exactly one runtime owns a session" is a convention here, not a mechanism.** The barrier moves
ownership only after the destination confirms, and the transcript's producer record is authoritative —
but the store's writer lease is re-entrant per pid and this router hosts both branches in one process,
so a determined host can still write from the source after a handoff. A real guard needs a
writer-lease generation the SDK store does not have; it is on the SDK's list.
