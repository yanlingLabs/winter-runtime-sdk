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
| WS17-1 | **proven** | Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases` | Real model-emitted `SendMessage` through the TS alias reaches `mcp__winter__send_message` with native args and returns the visible result. | PROVEN WHOLE-ROW IN THE FIX WAVE (item 14). Each lane's half was already green against a DOUBLE of the other — Lane A's alias test used a recording handler, Lane B's router tests used a scripted caller — and the row is the join. `test/joint/` drives one real 0.3.250 process through its own `toolAliases` into Lane B's real handler and router, and the delivered frame, the class, the summary and the typed outcome are read at the far end. The joint run also established what no report knew: the WS-10 §12 retry key survives the whole path, because the caller is bound with NO tool-use id and the message id still carries the model's own (item 15). |
| WS17-2 | **proven** | Lane B (handlers), with Lane A's alias table | `ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behavior without Tool Search. | The visibility half is RECORDED, not asserted-as-wished: with no Tool Search active the pinned runtime advertises the native name AND the canonical twin, so `deferred` is this package's intent and the runtime's own decision is what the test writes down. Re-measured under the hermetic child env (F-1), where the advertised set is the artifact's own 21 names rather than 25 including three remotely-flagged tools. |
| WS17-3 | **proven** | Lane A (aliases + deny floor, WS-14 §7) | `disallowedTools` + permission floor cover harness-internal/direct paths aliases miss. | The measurement behind it: denying only the built-in leaves the alias resolving and the handler RUNNING, because the deny check happens after alias resolution. `aliasDenyNames` is the door that stops a host tripping over it, and row 3 is why it exists. |
| WS17-4 | **proven** | Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake) | Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake, zero visibility into `~/.claude`. | Both halves are now measured against two REAL 0.3.250 processes over one shared directory (item 14) — run SEQUENTIALLY, each with its own spool, which is what the isolation assertion compares; not one lane's real runtime beside the other lane's double. The `idle wake` clause resolves to WS-10 §14's WHOLE-CALL REFUSAL on this branch — the pinned SDK's `Query` exposes no session-status surface, so an adapter without a reliable idle signal must refuse rather than subscribe. That is a measurement about the artifact, not a gap in the row. |
| WS17-5 | **proven** | Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route) | Official parent resume after restart restores completed children for native SendMessage resume. | The joint half is a REAL `resume()` (round 2, NEW-B): generation one's `system/init` session id and its own spool are handed to `adapter.resume()`, the second generation reports the SAME backend session id and the same observed root, and a native SendMessage to a completed child is asserted `delivered`/`queued` with the frame arriving in the resumed parent's stream. The earlier version launched two fresh sessions and closed on `not.toBe("not_found")`, which `unavailable` and `held` also satisfy. |
| WS17-7 | **proven** | Lane B (the messaging router, WS-15 §6.2–6.3 / WS-10 §11–§13) | Messaging: addressing, ambiguity/staleness, dedupe, queue bounds, TTL, retries, crash windows, loop prevention, reply routing, `notify_when_idle`. | Ten clauses, ten named proofs. The crash-window clause is the one worth reading twice: the envelope and the CLAIM are persisted before the adapter is invoked, so a crash between them is recoverable as `delivery_uncertain` rather than as silence. |
| WS17-8 | **proven** (router-scoped — see the note) | Lane C (store wiring, WS-05 §6/§7) | Shared filesystem `SessionStore` + pinned dialect: Claude→Winter, Winter→Claude, and both round-trips at every advertised level. | SCOPED, and the scope is the honest half of this row: both legs are produced by the SHARED STORE over the pinned dialect, at every advertised level, over real `mkdtemp` homes. What is NOT claimed is a Claude leg written by the pinned runtime — `docs/probes/materialized-resume.md` records what happened when one was tried in the fix wave (probe (c) FAILED: the parent chain does not come back unbroken), which is exactly why no `agent-state` or `full-filesystem` compatibility claim rests on this row today. |
| WS17-11 | **proven** | Lane C (store wiring) | Delete/rebuild of the disposable `sessions/index.db` preserves runtime mappings, backend IDs, cursors. | Proven the strong way and the structural way: the data survives a delete/rebuild BECAUSE none of it lives in the index, and a source scan pins that the router never reads the index at all. |
| WS17-12 | **proven** | Lane B (the inbound policy and the mailbox, WS-10 §13) | Documented message-size, 50-accepted/100-held queues, 5-minute dialog expiry, 12-hour idle subscription, permission-class behavior; inert `@` mentions retained. | The expiry clause carries one interim behaviour a host must know and the README states: the sweep is LAZY — a held message's receipt is rewritten to `refused` when something next addresses that receiver, not on a timer of its own. |
| WS17-13 | **proven** (router-scoped — see the note) | the spine (the packing and source gates), with this file's lockfile-integrity check | No verbatim all-rights-reserved artifacts in the Winter distribution; ephemeral CI fetch only. | Scoped to the ROUTER's own distribution: the artifact exists only in gitignored `node_modules`, is pinned by lockfile integrity (the plan's Global Constraints), and is rejected by the pack scan if it ever reaches a tarball. WS-02 §6's checksum-verified ephemeral FETCH is the SDK repository's own harness gate and stays there. |
| WS17-14 | **proven** | Lane A (builtin-path containment, WS-14 §8) | Native + aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and arbitrary file/shell paths cannot create `CLAUDE.md`, `.claude/`, or `~/.claude/plans` under strict policy. | Two layers, and the scope is exact. PRE-HOC: the permission floor refuses any call whose arguments name a forbidden target — path fields (case-folded, NFKC), command text (un-normalized, quote-stripped), and the §8 writers with no path argument at all — installed by `launch()` itself on EVERY launch — merged ahead of the caller's own hooks and never replaced by one of them (the floor is recognised by IDENTITY: a hook merely stamped with the exported floor mark is not the floor, and a genuine floor built under a looser template policy does not stand in for the adapter's own) — and required by `assertOptionsInvariants` by that same identity, not merely offered by the options builder. POST-HOC: a sweep registered on PostToolUse, PostToolUseFailure and PostToolBatch snapshots the forbidden names under the session's cwd AND the child's HOME, to a bounded depth (6 by default), around every filesystem-touching call; it removes what APPEARED under its roots during the call, records a typed containment breach, and ends the turn. SCOPE, stated rather than implied: shell-escape and constructed-name spellings are caught POST-HOC by the sweep, never pre-hoc; the sweep sees the SYNCHRONOUSLY-VISIBLE effects of the call it brackets (a background write that lands later is caught opportunistically by the next swept call), and its diff is TIME-BASED rather than causal — under the child's HOME that means a vendor home created by something else during a long call is removed and attributed to that call, which is narrow (an existing one is in every baseline and is never touched) but is what the wording says; it does not look outside cwd and HOME, nor below its depth bound; and the TURN ends only for a call that SUCCEEDS — for a failing call the guarantee is that the artifact does not survive it. |
| WS17-15 | **proven** (router-scoped — see the note) | Lane C (temp continuity and the barrier) with Lane A (the supervised proxy) | Canonical memory + the D18 temp layout, cross-engine temp continuity, vendor temp roots reported honestly, supervised pre-cleanup reconciliation, default-spawn `mirror_error` handoff refusal, entire-adapter projection, `$bunfs` extraction avoided or tested. | SCOPED: six of the row's seven clauses are proven, four of them against the pinned runtime. The seventh — `$bunfs` extraction avoided or tested — is NOT claimed here: it is a property of how a HOST packages this package (a single-file Bun executable extracting its own embedded runtime), and nothing in this repository builds one. A row that counted it would be counting somebody else's build. The `entire-adapter projection` clause is likewise the projector's (Phase 8, WS-15 §4), and what this row proves for it is the durable half — the roots and records a projector reads. |
| WS17-17 | **proven** | Lane D | Two identical raw model IDs behind different providers keep distinct provider-qualified identity/credentials/continuation/resume routes. | The fixture mirrors the generated catalog, where `claude-opus-5` really is six rows behind six providers. |

## Phase 7b rulings discharged (not WS-17 rows)

| Ruling | Status | Owner | Obligation | Scope / note |
| --- | --- | --- | --- | --- |
| D13/D28 | **proven** | Lane D | The runtime-selection table: Claude OAuth → official always (D14-gated); a Claude-family model on a backend the official branch serves in Code mode → official; Claude through other endpoints and all Dispatch/Chat → Winter; never a raw model-ID substring; the persisted selection wins. | — |
| D14 gate | **proven** | Lane D | The Claude OAuth ship gate is closed by default, and a closed gate refuses rather than falling back to the Winter runtime. | — |
| R-7b-1 | **proven** | Lane D (the selection half; the delivery half is Lane B's) | A child runs on the runtime its OWN slot's family selects, independent of the parent's; the child's selection is persisted with the child, resume follows the child's record, and a cross-runtime pair talks only through the RuntimeDirectory. | — |
| WS13c-SM1/2/3 | **proven** | Lane D (selection level; the `DeliveryOutcome` half is Lane B's) | A parent switching family leaves its child's record untouched (both directions), and a child whose provider credential is gone refuses with `child-provider-unavailable` while the parent's turn continues. | — |
| R-7b-8 | **proven** | Lane D | The D29 probe: whether the pinned official runtime exposes an advisor server tool in an SDK session, and under which condition, measured against the pinned artifact through the loopback capture and recorded. | REWRITTEN IN THE FIX WAVE (whole-branch F-1). The first version's citations pointed at tests asserting that `settings.advisorModel` put an advisor on the wire; that was the pinned artifact PLUS its remote feature configuration, and it went red whenever the CDN fetch timed out. With the runtime's four traffic opt-outs set, no condition puts an advisor anywhere — it is a remotely-flagged capability, not a property of the pin. D29's split is unaffected either way (nothing client-side to alias under either condition). One labelled non-hermetic leg survives behind `WINTER_D29_ALLOW_REMOTE_CONFIG=1` and is evidence for nothing. The probe skips with a printed reason where the pinned runtime cannot start, so the citation is to the tests AND to the record they produce. |

## Citations

### WS17-1

- `test/joint/rows-1-2.test.ts` — `row 1 — a model-emitted SendMessage is delivered by the REAL router, and the router's typed outcome is what the model sees`
- `test/joint/rows-1-2.test.ts` — `row 1 — a refusal is rendered as a classified failure the model can act on, not as a crash`
- `test/joint/rows-1-2.test.ts` — `the REVERSE direction — a peer's message reaches the live official session's own row, through the router`
- `test/official/runtime-aliases.test.ts` — `row 1: a model-emitted `SendMessage` reaches the canonical handler with NATIVE args, and its result is what the model sees`
- `test/messaging/handlers.test.ts` — `a retry with the SAME vendor tool-use id returns the stored outcome, not a second delivery`

### WS17-2

- `test/joint/rows-1-2.test.ts` — `row 2 — a model-emitted ListAgents renders the REAL directory, and both canonical twins are advertised`
- `test/official/runtime-aliases.test.ts` — `row 2: `ListAgents` aliases the same way, and the advertised set records what 0.3.250 actually does`
- `test/official/aliases-containment.test.ts` — `the canonical duplicates are DEFERRED rather than hidden — they stay addressable by name`

### WS17-3

- `test/official/runtime-aliases.test.ts` — `row 3: the paths the alias does not cover — the canonical name direct, and where a deny rule must be spelled`
- `test/official/aliases-containment.test.ts` — `the floor is a PATH rule, so it covers tools no disposition anticipated`

### WS17-4

- `test/official/runtime-spool.test.ts` — `row 4: two sessions under ONE spool stay isolated, and neither can see the vendor home`
- `test/messaging/official-pair.test.ts` — `DISCOVERY is isolated: each sees the other session and its OWN children, never the other's`
- `test/messaging/official-pair.test.ts` — `DELIVERY between the two lands in the receiver's own handle, attributed to the sender`
- `test/messaging/official-pair.test.ts` — `HOLD and REFUSE are the receiver's, and neither delivers anything`
- `test/messaging/official-pair.test.ts` — `IDLE WAKE: an idle official session starts one turn (`delivered`), a running one queues`
- `test/joint/rows-4-5.test.ts` — `two live official sessions get DIFFERENT config dirs, each under its own spool`
- `test/joint/rows-4-5.test.ts` — `a model in one official session DISCOVERS and ADDRESSES the other, and the delivery lands in it`
- `test/joint/rows-4-5.test.ts` — `a receiver whose permission class cannot be known is HELD, not delivered — fail-closed, with the real runtime as the sender`
- `test/joint/rows-4-5.test.ts` — `notify_when_idle against an OFFICIAL target refuses the whole call — measured, because this branch has no idle signal`

### WS17-5

- `test/messaging/official-pair.test.ts` — `recovery keeps the completed children, and a native SendMessage to one routes through the resumed parent`
- `test/messaging/official-pair.test.ts` — `before the parent is resumed, the same send is retryably unavailable rather than not-found`
- `test/joint/rows-4-5.test.ts` — `generation two is a real `resume()` of generation one's backend session, and the completed children are addressable through it`

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

### WS17-8

- `test/store/rows.test.ts` — `Claude -> Winter, Winter -> Claude and both round trips at level`
- `test/store/rows.test.ts` — `the subagent level round-trips too: a subkey survives both directions`

### WS17-11

- `test/store/rows.test.ts` — `runtime mappings, backend ids and cursors all survive, because none of them live there`
- `test/store/rows.test.ts` — `the router never reads the product index: its name appears nowhere in this lane's source`

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
- `test/conformance/rows.test.ts` — `row 13's other half — the pinned artifact is fetched by integrity hash into a gitignored tree`

### WS17-14

- `test/official/runtime-containment.test.ts` — `the native writers: every §8 row is EXERCISED, and the tally says which containment stopped it`
- `test/official/runtime-containment.test.ts` — `arbitrary file and shell paths: an approving broker does not lift the floor`
- `test/official/runtime-containment.test.ts` — `review r2, NEW-3: a command that BUILDS the name is caught post-hoc — swept, reported, and the call blocked`
- `test/official/runtime-containment.test.ts` — `review r3, NEW-9: a command whose side effect precedes a FAILURE is swept too`
- `test/official/runtime-containment.test.ts` — `review r3, NEW-11: the saved-approval path, for real — the durable update is stripped and no vendor settings file appears`
- `test/official/runtime-containment.test.ts` — `review r4, NEW-18 (a): a host hook stamped with the exported floor mark does not REPLACE the floor — the floor is recognised by identity`
- `test/official/runtime-containment.test.ts` — `the whole session's writes stay inside the spool, the cwd and the product home`

### WS17-15

- `test/store/rows.test.ts` — `the temp home stabilizes in the vendor engine dir across a full round trip`
- `test/store/rows.test.ts` — `the vendor temp roots are reported honestly, including the one a copy left behind`
- `test/store/rows.test.ts` — `supervised PRE-CLEANUP reconciliation: the entries are in the store before the staging root is deleted`
- `test/store/rows.test.ts` — `a DEFAULT-SPAWN session with a mirror error is refused, never reconciled by guesswork`
- `test/official/runtime-spool.test.ts` — `row 15: the vendor temp root is what we configured PLUS the engine's own segment, reported honestly`
- `test/official/runtime-spool.test.ts` — `§1 profile 2 + §6 rules 2/3: a store-backed resume is observed as a staging root, and reconciliation runs BEFORE cleanup`

### WS17-17

- `test/selection/row-17.test.ts` — `row 17 — the fixture really is one raw model id behind several providers`
- `test/selection/row-17.test.ts` — `row 17 identity — two selections of the same raw id keep distinct provider-qualified identities`
- `test/selection/row-17.test.ts` — `row 17 credentials — each row is admitted by ITS OWN provider's credential ref, never a sibling's`
- `test/selection/row-17.test.ts` — `row 17 continuation — the same raw id routes to DIFFERENT runtimes depending on the provider`
- `test/selection/row-17.test.ts` — `row 17 resume — a record on one provider never resumes onto its twin behind another provider`
- `test/selection/row-17.test.ts` — `row 17 — two children on the same raw id under one parent stay two distinct records`

### D13/D28

- `test/selection/select-runtime.test.ts` — `D13 row 1 — a Claude OAuth credential routes to the official runtime, always`
- `test/selection/select-runtime.test.ts` — `D13 row 2 — a Claude-family model on an Anthropic-protocol backend in Code mode routes to the official runtime`
- `test/selection/select-runtime.test.ts` — `D13 row 2 — a Console OAuth bearer on the Anthropic-dialect backend routes to the official runtime`
- `test/selection/select-runtime.test.ts` — `D13 row 2 — a cloud credential chain is a backend the official branch serves, dialect notwithstanding`
- `test/selection/select-runtime.test.ts` — `officialServesBackend agrees with OFFICIAL_SERVED_AUTH_FAMILIES for every auth family`
- `test/selection/select-runtime.test.ts` — `D13 row 3 — the same Claude model through a non-Anthropic-protocol endpoint routes to Winter`
- `test/selection/select-runtime.test.ts` — `D13 row 3 — Dispatch and Chat run on Winter even on the Anthropic-protocol backend`
- `test/selection/select-runtime.test.ts` — `D28 — a gpt-family slot routes to Winter even with an official peer present`
- `test/selection/select-runtime.test.ts` — `no branch reads a raw model id — renaming every model id leaves the decision unchanged`
- `test/selection/select-runtime.test.ts` — `the persisted selection wins and is returned by identity, never re-decided`
- `test/selection/select-runtime.test.ts` — `a persisted selection that no longer matches a fresh decision is reported as handoff-required, not rewritten`

### D14 gate

- `test/selection/select-runtime.test.ts` — `the D14 ship gate ships closed — the shipped default flag refuses a Claude OAuth session`
- `test/selection/select-runtime.test.ts` — `D13 row 1 — Claude OAuth with the D14 ship gate closed is refused, never downgraded to Winter`
- `test/selection/select-runtime.test.ts` — `D13 row 1 — Claude OAuth outside Code mode is refused: Code-only even after D14 approval`
- `test/selection/select-runtime.test.ts` — `D13 row 1 — Claude OAuth with no official peer is refused, because it never routes to Winter`

### R-7b-1

- `test/selection/child-runtime.test.ts` — `R-7b-1 — the same child under two different parents produces the identical record`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a Claude-family child of a Winter parent runs on the official runtime`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a gpt-family child of an official parent runs on the Winter runtime`
- `test/selection/child-runtime.test.ts` — `R-7b-1 — a cross-runtime parent/child pair is flagged for the directory channel`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume never re-decides the runtime, even when the table would now differ`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume succeeds on a recorded row that is not its provider's first row`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume refuses when the recorded ROW is unservable though its provider still serves the model`
- `test/selection/child-runtime.test.ts` — `WS-13c §8 — a resume refuses when the recorded row has moved into another family`

### WS13c-SM1/2/3

- `test/selection/child-runtime.test.ts` — `WS13c-SM1 — a gpt parent's sonnet child is unchanged when the parent switches to claude`
- `test/selection/child-runtime.test.ts` — `WS13c-SM2 — a claude parent's gpt child is unchanged when the parent switches to gpt`
- `test/selection/child-runtime.test.ts` — `WS13c-SM3 — a child whose credential is gone refuses with child-provider-unavailable and is not retryable`

### R-7b-8

- `test/selection/d29-advisor-probe.test.ts` — `the probe drove the PINNED artifact, over loopback only, and printed its inventories`
- `test/selection/d29-advisor-probe.test.ts` — `D29 — no condition puts an advisor tool in the session's advertised tool inventory`
- `test/selection/d29-advisor-probe.test.ts` — `D29 — configuring an advisor model puts NOTHING advisor-shaped on the wire (the pinned artifact, alone)`
- `test/selection/d29-advisor-probe.test.ts` — `D29 — no advisor appears in ANY hermetic condition, on the wire or in the inventory`
- `test/selection/d29-advisor-probe.test.ts` — `the remote-configuration leg, when it is explicitly enabled, shows what the CDN adds`
- `docs/probes/d29-advisor.md` — `## 3. Verdict`

## Still unproven

None — every row above carries at least one machine-verified citation.
