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
removes exactly what the call created, records a typed breach and ends the turn. The sweep walks both
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

A second class is refused **by name**: variables that change how the child EXECUTES code or
authenticates — `BASH_ENV`, `ENV` and `CLAUDE_CODE_SHELL_PREFIX` (a file the shell sources on every
non-interactive start, or a prefix around every command), `NODE_OPTIONS` and `LD_*`/`DYLD_*` (loader
and runtime hooks), `GIT_ASKPASS`, `SSH_ASKPASS` and the credential helpers (programs the child RUNS
to obtain a credential). Neither of the other two rules can see them: they are not credential-SHAPED,
and the pinned artifact's registry legitimately declares several of them, because the runtime really
does read them — which is why "the registry declares it" cannot be the whole test. The reviewed door
for this class is `reviewedExecutionExtras`, again one name at a time.

**The approval bridge is fail-closed when no broker is configured.** A host MUST supply a broker: with
none, every call that reaches the bridge is denied. That is deliberate — the alternative is a session
that approves its own tool calls — and it means "I did not wire a broker yet" behaves like "deny", not
like "allow".

**`interrupt()` stops the turn.** On a streaming turn it ends the generation by throwing, which is
what a projector (Phase 8) must expect: an interrupted session's stream terminates with an error
rather than a result.

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
