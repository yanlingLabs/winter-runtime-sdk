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
| WS17-1 | unproven | Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases` | Real model-emitted `SendMessage` through the TS alias reaches `mcp__winter__send_message` with native args and returns the visible result. | — |
| WS17-2 | unproven | Lane B (handlers), with Lane A's alias table | `ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behavior without Tool Search. | — |
| WS17-3 | unproven | Lane A (aliases + deny floor, WS-14 §7) | `disallowedTools` + permission floor cover harness-internal/direct paths aliases miss. | — |
| WS17-4 | unproven | Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake) | Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake, zero visibility into `~/.claude`. | — |
| WS17-5 | unproven | Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route) | Official parent resume after restart restores completed children for native SendMessage resume. | — |
| WS17-7 | unproven | Lane B (the messaging router, WS-15 §6.2–6.3 / WS-10 §11–§13) | Messaging: addressing, ambiguity/staleness, dedupe, queue bounds, TTL, retries, crash windows, loop prevention, reply routing, `notify_when_idle`. | — |
| WS17-8 | unproven | Lane C (store wiring, WS-05 §6/§7) | Shared filesystem `SessionStore` + pinned dialect: Claude→Winter, Winter→Claude, and both round-trips at every advertised level. | — |
| WS17-11 | unproven | Lane C (store wiring) | Delete/rebuild of the disposable `sessions/index.db` preserves runtime mappings, backend IDs, cursors. | — |
| WS17-12 | unproven | Lane B (the inbound policy and the mailbox, WS-10 §13) | Documented message-size, 50-accepted/100-held queues, 5-minute dialog expiry, 12-hour idle subscription, permission-class behavior; inert `@` mentions retained. | — |
| WS17-13 | **proven** (router-scoped — see the note) | the spine (the packing and source gates), with this file's lockfile-integrity check | No verbatim all-rights-reserved artifacts in the Winter distribution; ephemeral CI fetch only. | Scoped to the ROUTER's own distribution: the artifact exists only in gitignored `node_modules`, is pinned by lockfile integrity (the plan's Global Constraints), and is rejected by the pack scan if it ever reaches a tarball. WS-02 §6's checksum-verified ephemeral FETCH is the SDK repository's own harness gate and stays there. |
| WS17-14 | unproven | Lane A (builtin-path containment, WS-14 §8) | Native + aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and arbitrary file/shell paths cannot create `CLAUDE.md`, `.claude/`, or `~/.claude/plans` under strict policy. | — |
| WS17-15 | unproven | Lane C (temp continuity and the barrier) with Lane A (the supervised proxy) | Canonical memory + the D18 temp layout, cross-engine temp continuity, vendor temp roots reported honestly, supervised pre-cleanup reconciliation, default-spawn `mirror_error` handoff refusal, entire-adapter projection, `$bunfs` extraction avoided or tested. | — |
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

### WS17-13

- `test/gates/release-gates.test.ts` — `nothing tracked is the pinned package, its bundle, or a vendored copy`
- `test/gates/scripts.test.ts` — `an embedded Anthropic artifact is rejected, by directory name and by file name`
- `test/gates/scripts.test.ts` — `rule 7: the OPTIONAL peer named in a REACHABLE declaration is rejected -- and only there`
- `test/conformance/rows.test.ts` — `row 13's other half — the pinned artifact is fetched by integrity hash into a gitignored tree`

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

- **WS17-1** — Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases`
- **WS17-2** — Lane B (handlers), with Lane A's alias table
- **WS17-3** — Lane A (aliases + deny floor, WS-14 §7)
- **WS17-4** — Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake)
- **WS17-5** — Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route)
- **WS17-7** — Lane B (the messaging router, WS-15 §6.2–6.3 / WS-10 §11–§13)
- **WS17-8** — Lane C (store wiring, WS-05 §6/§7)
- **WS17-11** — Lane C (store wiring)
- **WS17-12** — Lane B (the inbound policy and the mailbox, WS-10 §13)
- **WS17-14** — Lane A (builtin-path containment, WS-14 §8)
- **WS17-15** — Lane C (temp continuity and the barrier) with Lane A (the supervised proxy)
