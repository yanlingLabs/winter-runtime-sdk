# `@yanlinglabs/winter-runtime-sdk` — conformance rows

> GENERATED from `test/conformance/rows.test.ts`. Do not edit by hand — change the table there and
> re-run `WINTER_ROWS_WRITE=1 bun test test/conformance/rows.test.ts`. Every citation below is
> machine-verified by that test: the cited file is read and the cited test title searched for, so a
> renamed test fails the suite rather than leaving this page claiming a proof that no longer exists.

WS-17 §8's closing line is why this page exists: **no release may claim drop-in compatibility while a
router-owned row is unproven.** Rows 6, 9, 10, 16 and 18 are excluded by WS-17 §8 itself.

## WS-17 §8 — the router's proof rows

| Row | Status | Owner | Obligation | Scope / note |
| --- | --- | --- | --- | --- |
| WS17-1 | retired (WS-23) | Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases` | Real model-emitted `SendMessage` through the TS alias reaches `mcp__winter__send_message` with native args and returns the visible result. | RETIRED (WS-23, the official runtime is gone): its subject was the official branch's TS alias onto the router's handlers; the Winter runtime's own `SendMessage` reaches its own tools, and `messaging/handlers.test.ts` still pins the retry. |
| WS17-2 | retired (WS-23) | Lane B (handlers), with Lane A's alias table | `ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behavior without Tool Search. | RETIRED (WS-23, the official runtime is gone): `ListAgents` aliasing and the canonical MCP duplicate were the official branch's. |
| WS17-3 | retired (WS-23) | Lane A (aliases + deny floor, WS-14 §7) | `disallowedTools` + permission floor cover harness-internal/direct paths aliases miss. | RETIRED (WS-23, the official runtime is gone): the alias-vs-deny-floor gap was the official branch's. |
| WS17-4 | retired (WS-23) | Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake) | Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake, zero visibility into `~/.claude`. | RETIRED (WS-23, the official runtime is gone): two official sessions under the spool — there is no official session any more. |
| WS17-5 | retired (WS-23) | Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route) | Official parent resume after restart restores completed children for native SendMessage resume. | RETIRED (WS-23, the official runtime is gone): an official parent's resume — there is no official session any more. |
| WS17-7 | **proven** | Lane B (the messaging router, WS-15 §6.2–6.3 / WS-10 §11–§13) | Messaging: addressing, ambiguity/staleness, dedupe, queue bounds, TTL, retries, crash windows, loop prevention, reply routing, `notify_when_idle`. | Ten clauses, ten named proofs. The crash-window clause is the one worth reading twice: the envelope and the CLAIM are persisted before the adapter is invoked, so a crash between them is recoverable as `delivery_uncertain` rather than as silence. |
| WS17-8 | retired (WS-23) | Lane C (store wiring, WS-05 §6/§7) | Shared filesystem `SessionStore` + pinned dialect: Claude→Winter, Winter→Claude, and both round-trips at every advertised level. | RETIRED (WS-23, the official runtime is gone): the Claude→Winter / Winter→Claude transfer through the shared store was the handoff barrier's; a session the official runtime wrote now resumes on the Winter runtime in place (the daemon's adoption, WS-23 R2). |
| WS17-11 | **proven** | Lane C (store wiring) | Delete/rebuild of the disposable `sessions/index.db` preserves runtime mappings, backend IDs, cursors. | Proven the structural way: the data survives a delete/rebuild BECAUSE none of it lives in the index, and a source scan pins that the store lane never reads it. (WS-23: the half that drove a handoff through the barrier went with the barrier.) |
| WS17-12 | **proven** | Lane B (the inbound policy and the mailbox, WS-10 §13) | Documented message-size, 50-accepted/100-held queues, 5-minute dialog expiry, 12-hour idle subscription, permission-class behavior; inert `@` mentions retained. | The expiry clause carries one interim behaviour a host must know and the README states: the sweep is LAZY — a held message's receipt is rewritten to `refused` when something next addresses that receiver, not on a timer of its own. |
| WS17-13 | **proven** (router-scoped — see the note) | the spine (the packing and source gates), with this file's lockfile-integrity check | No verbatim all-rights-reserved artifacts in the Winter distribution; ephemeral CI fetch only. | Scoped to the ROUTER's own distribution: the pack scan rejects the artifact if it ever reaches a tarball. WS-23: the official runtime is retired, so this repository no longer fetches it at all (no dependency, no lockfile entry). WS-02 §6's checksum-verified ephemeral FETCH is the SDK repository's own harness gate and stays there. |
| WS17-14 | retired (WS-23) | Lane A (builtin-path containment, WS-14 §8) | Native + aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and arbitrary file/shell paths cannot create `CLAUDE.md`, `.claude/`, or `~/.claude/plans` under strict policy. | RETIRED (WS-23, the official runtime is gone): the builtin-path containment it proved was the official runtime's; the Winter runtime's own containment is the host's and the SDK's. |
| WS17-15 | retired (WS-23) | Lane C (temp continuity and the barrier) with Lane A (the supervised proxy) | Canonical memory + the D18 temp layout, cross-engine temp continuity, vendor temp roots reported honestly, supervised pre-cleanup reconciliation, default-spawn `mirror_error` handoff refusal, entire-adapter projection, `$bunfs` extraction avoided or tested. | RETIRED (WS-23, the official runtime is gone): temp continuity across engines, the staging roots and the pre-cleanup reconcile were the official runtime's and the barrier's. |
| WS17-17 | **proven** | Lane D | Two identical raw model IDs behind different providers keep distinct provider-qualified identity/credentials/continuation/resume routes. | The fixture mirrors the generated catalog, where `claude-opus-5` really is six rows behind six providers. |

## Phase 7b rulings discharged (not WS-17 rows)

| Ruling | Status | Owner | Obligation | Scope / note |
| --- | --- | --- | --- | --- |
| D13/D28 | **proven** | Lane D | The runtime-selection table (WS-23: one runtime): Claude OAuth → refused, never Winter (D28); every other Claude row, every family and all Dispatch/Chat → Winter; never a raw model-ID substring; the persisted selection wins. | — |
| D14 gate | **proven** | Lane D | The Claude OAuth ship gate is closed by default, and a closed gate refuses rather than falling back to the Winter runtime. (WS-23: stronger now — a Claude OAuth credential is refused whatever the gate says, in every mode.) | — |
| R-7b-1 | **proven** | Lane D (the selection half; the delivery half is Lane B's) | A child runs on the runtime its OWN slot's family selects, independent of the parent's; the child's selection is persisted with the child, resume follows the child's record, and a cross-runtime pair talks only through the RuntimeDirectory. | — |
| WS13c-SM1/2/3 | **proven** | Lane D (selection level; the `DeliveryOutcome` half is Lane B's) | A parent switching family leaves its child's record untouched (both directions), and a child whose provider credential is gone refuses with `child-provider-unavailable` while the parent's turn continues. | — |
| R-7b-8 | retired (WS-23) | Lane D | The D29 probe: whether the pinned official runtime exposes an advisor server tool in an SDK session, and under which condition, measured against the pinned artifact through the loopback capture and recorded. | RETIRED (WS-23, the official runtime is gone): the D29 probe measured the pinned official runtime. |

## Citations

### WS17-7

- `test/messaging/directory.test.ts` — `rule 4 — ambiguity RETURNS CANDIDATES rather than choosing, and the candidates are directory rows`
- `test/messaging/directory.test.ts` — `rule 5 — a name whose only holder is gone is STALE, not not-found (the lease outlives the row)`
- `test/messaging/router.test.ts` — `a retry of the same (sender, tool-call) pair returns the STORED outcome and starts no second turn`
- `test/messaging/router.test.ts` — `the dedupe survives a RESTART, because the id is derived rather than counted`
- `test/messaging/router.test.ts` — `the envelope and its resolved generation are persisted, and the delivery is CLAIMED, before the adapter runs`
- `test/messaging/router.test.ts` — `an adapter that THROWS is delivery_uncertain, and the record keeps the claim`
- `test/messaging/router.test.ts` — `an identical rapid repeat is suppressed with a VISIBLE outcome, and allowed again after the window`
- `test/messaging/router.test.ts` — `a reply chain is stopped at MAX_HOP_COUNT — the bound is machinery, not documentation`
- `test/messaging/router.test.ts` — `the subscription SURVIVES A RESTART — a new router over the same store still fires it`
- `test/messaging/recovery.test.ts` — `step 5 turns every claimed-but-unreceipted delivery into delivery_uncertain, and redelivers nothing`

### WS17-11

- `test/store/wiring.test.ts` — `the router never reads the product index: its name appears nowhere in this lane's source`

### WS17-12

- `test/messaging/router.test.ts` — `a body over MAX_GLOBAL_MESSAGE_SIZE is refused before anything is resolved`
- `test/messaging/policy.test.ts` — `a DELIVERED message (an idle receiver, one turn started) frees its slot; a QUEUED one does not`
- `test/messaging/policy.test.ts` — `the held cap survives a RESTART — the in-memory box is rehydrated from the durable store`
- `test/messaging/policy.test.ts` — `a DEFAULT-class hold expires after five minutes; an EXPLICIT hold never does`
- `test/messaging/router.test.ts` — `a subscription past its 12-hour expiry fires nothing and is swept`
- `test/messaging/policy.test.ts` — `prompts receiver x BYPASSES sender holds, visibly, with the envelope kept durably`
- `test/messaging/policy.test.ts` — ``@` mentions and slash-command text survive the router's own rendering byte-identically`

### WS17-13

- `test/gates/release-gates.test.ts` — `nothing tracked is the pinned package, its bundle, or a vendored copy`
- `test/gates/scripts.test.ts` — `an embedded Anthropic artifact is rejected, by directory name and by file name`
- `test/gates/scripts.test.ts` — `rule 7: the OPTIONAL peer named in a REACHABLE declaration is rejected -- and only there`
- `test/conformance/rows.test.ts` — `row 13's other half — WS-23: no Anthropic artifact is fetched at all any more`

### WS17-17

- `test/selection/row-17.test.ts` — `row 17 — the fixture really is one raw model id behind several providers`
- `test/selection/row-17.test.ts` — `row 17 identity — two selections of the same raw id keep distinct provider-qualified identities`
- `test/selection/row-17.test.ts` — `row 17 credentials — each row is admitted by ITS OWN provider's credential ref, never a sibling's`
- `test/selection/row-17.test.ts` — `row 17 continuation — the same raw id is decided by DIFFERENT rules depending on the provider`
- `test/selection/row-17.test.ts` — `row 17 resume — a record on one provider never resumes onto its twin behind another provider`
- `test/selection/row-17.test.ts` — `row 17 — two children on the same raw id under one parent stay two distinct records`

### D13/D28

- `test/selection/select-runtime.test.ts` — `a Claude OAuth credential is refused runtime-unavailable, approved or not, peer or not — never downgraded to Winter`
- `test/selection/select-runtime.test.ts` — `a Claude-family model on an Anthropic-protocol backend in Code mode selects Winter (R-7b-1), even with `hasClaudePeer: true``
- `test/selection/select-runtime.test.ts` — `a Console OAuth bearer on the Anthropic-dialect backend selects Winter`
- `test/selection/select-runtime.test.ts` — `a cloud credential chain selects Winter too — the dialect distinction now only names the rule`
- `test/selection/select-runtime.test.ts` — `officialServesBackend agrees with OFFICIAL_SERVED_AUTH_FAMILIES for every auth family`
- `test/selection/select-runtime.test.ts` — `D13 row 3 — the same Claude model through a non-Anthropic-protocol endpoint routes to Winter`
- `test/selection/select-runtime.test.ts` — `D13 row 3 — Dispatch and Chat run on Winter even on the Anthropic-protocol backend`
- `test/selection/select-runtime.test.ts` — `D28 — a gpt-family slot routes to Winter even with an official peer present`
- `test/selection/select-runtime.test.ts` — `no branch reads a raw model id — renaming every model id leaves the decision unchanged`
- `test/selection/select-runtime.test.ts` — `the persisted selection wins and is returned by identity, never re-decided`
- `test/selection/select-runtime.test.ts` — `a persisted selection that no longer matches a fresh decision is reported as handoff-required, not rewritten`

### D14 gate

- `test/selection/select-runtime.test.ts` — `the D14 constant is still exported, and still closed`
- `test/selection/select-runtime.test.ts` — `a Claude OAuth credential is refused runtime-unavailable, approved or not, peer or not — never downgraded to Winter`
- `test/selection/select-runtime.test.ts` — `…and in Dispatch and Chat too`

### R-7b-1

- `test/selection/child-runtime.test.ts` — `R-7b-1 — the same child under two different parents produces the identical record`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a Claude-family child of a gpt parent runs on the Winter runtime (WS-23: once the official runtime)`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a gpt-family child of a Claude parent runs on the Winter runtime`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a cross-family pair is NOT cross-runtime any more (WS-23): it stays on the in-runtime channel`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume never re-decides the runtime, even when the table would now differ`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume succeeds on a recorded row that is not its provider's first row`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume refuses when the recorded ROW is unservable though its provider still serves the model`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume refuses when the recorded row has moved into another family`

### WS13c-SM1/2/3

- `test/selection/child-runtime.test.ts` — `WS13c-SM1 — a gpt parent's sonnet child is unchanged when the parent switches to claude`
- `test/selection/child-runtime.test.ts` — `WS13c-SM2 — a claude parent's gpt child is unchanged when the parent switches to gpt`
- `test/selection/child-runtime.test.ts` — `WS13c-SM3 — a child whose credential is gone refuses with child-provider-unavailable and is not retryable`

## Retired (WS-23)

The official `claude` runtime is no longer served by this package; these rows were about it.

- **WS17-1** — RETIRED (WS-23, the official runtime is gone): its subject was the official branch's TS alias onto the router's handlers; the Winter runtime's own `SendMessage` reaches its own tools, and `messaging/handlers.test.ts` still pins the retry.
- **WS17-2** — RETIRED (WS-23, the official runtime is gone): `ListAgents` aliasing and the canonical MCP duplicate were the official branch's.
- **WS17-3** — RETIRED (WS-23, the official runtime is gone): the alias-vs-deny-floor gap was the official branch's.
- **WS17-4** — RETIRED (WS-23, the official runtime is gone): two official sessions under the spool — there is no official session any more.
- **WS17-5** — RETIRED (WS-23, the official runtime is gone): an official parent's resume — there is no official session any more.
- **WS17-8** — RETIRED (WS-23, the official runtime is gone): the Claude→Winter / Winter→Claude transfer through the shared store was the handoff barrier's; a session the official runtime wrote now resumes on the Winter runtime in place (the daemon's adoption, WS-23 R2).
- **WS17-14** — RETIRED (WS-23, the official runtime is gone): the builtin-path containment it proved was the official runtime's; the Winter runtime's own containment is the host's and the SDK's.
- **WS17-15** — RETIRED (WS-23, the official runtime is gone): temp continuity across engines, the staging roots and the pre-cleanup reconcile were the official runtime's and the barrier's.
- **R-7b-8** — RETIRED (WS-23, the official runtime is gone): the D29 probe measured the pinned official runtime.

## Still unproven

None — every row above carries at least one machine-verified citation.
