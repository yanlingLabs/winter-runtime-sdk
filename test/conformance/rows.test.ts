// THE ROUTER'S WS-17 §8 PROOF ROWS, AS CITATION ROWS (R-7b-7).
//
// R-7b-7: "the router's proof rows (1–5, 7, 8, 11–15, 17) are flipped only by a named test each; the
// close-out publishes the row table with citations (the SDK repo's citation-test pattern)." This is
// that table, and it is a TEST rather than a document because the difference between the two is
// whether a citation can rot. Every `{ file, testName }` below is machine-verified: the file is read
// and the test title genuinely searched for, so renaming a cited test fails HERE rather than leaving a
// document quietly claiming a proof that no longer exists.
//
// WS-17 §8's own closing line is the reason the table exists at all: "No release may claim drop-in
// compatibility while a router-owned row is unproven." A row this lane did not prove is therefore
// listed `unproven` WITH THE LANE THAT OWNS IT — never omitted, never softened. The close-out (Task 6)
// flips them as the lanes land, by adding citations here.
//
// `docs/conformance-rows.md` IS GENERATED FROM THIS TABLE and checked in. The last test compares the
// checked-in file against the rendering; `WINTER_ROWS_WRITE=1 bun test test/conformance/rows.test.ts`
// rewrites it. So the document cannot drift from the citations, and the citations cannot drift from
// the tests.
//
// HERMETIC: this file reads source files under the repository and writes nothing unless that env
// variable is set. It stands up no server and starts no runtime.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Citation {
  /** Relative to THIS file (`test/conformance/`). */
  file: string;
  /** A test title, verbatim, or a heading in a cited document. */
  testName: string;
}

export interface RouterRow {
  /** `WS17-<n>`, so a row id and a WS-17 row number never disagree. */
  id: string;
  /** WS-17 §8's own text for the row. */
  bullet: string;
  status: "proven" | "unproven";
  /** Which lane's landing flips this row (or which one already did). */
  owner: string;
  citations?: Citation[];
  /** Context a reader of the table needs — rendered IN the table, not only under the citations. */
  note?: string;
  /**
   * Set when this row's claim is NARROWER than WS-17's own sentence, so the status cell says so.
   *
   * Only WS17-13 carries it: its bullet says "the Winter distribution" and "ephemeral CI fetch only",
   * and what the router proves is its OWN distribution plus a `--frozen-lockfile` install into a
   * gitignored tree. Every other note is context, not a narrower claim, and labelling those "scoped"
   * would make the word mean nothing.
   */
  scoped?: true;
}

const SELECTION = "../selection";
const GATES = "../gates";
const OFFICIAL = "../official";
const MESSAGING = "../messaging";
const STORE = "../store";
// The bed that belongs to neither lane (fix wave, item 14). A row whose two halves were proven
// against each other's DOUBLES is cited here as well as to each lane, because the join is the row.
const JOINT = "../joint";

/**
 * The thirteen rows R-7b-7 names. Rows 6, 9, 10, 16 and 18 are excluded by WS-17 §8 itself (they are
 * the daemon's, the capability matrix's, the upgrade corpus's, the standalone-launch case's and the
 * cross-suite gate's), so their absence here is the spec's, not this table's.
 */
export const ROUTER_ROWS: RouterRow[] = [
  {
    id: "WS17-1",
    bullet: "Real model-emitted `SendMessage` through the TS alias reaches `mcp__winter__send_message` with native args and returns the visible result.",
    status: "proven",
    owner: "Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases`",
    citations: [
      { file: `${JOINT}/rows-1-2.test.ts`, testName: "row 1 — a model-emitted SendMessage is delivered by the REAL router, and the router's typed outcome is what the model sees" },
      { file: `${JOINT}/rows-1-2.test.ts`, testName: "row 1 — a refusal is rendered as a classified failure the model can act on, not as a crash" },
      { file: `${JOINT}/rows-1-2.test.ts`, testName: "the REVERSE direction — a peer's message reaches the live official session's own row, through the router" },
      { file: `${OFFICIAL}/runtime-aliases.test.ts`, testName: "row 1: a model-emitted `SendMessage` reaches the canonical handler with NATIVE args, and its result is what the model sees" },
      { file: `${MESSAGING}/handlers.test.ts`, testName: "a retry with the SAME vendor tool-use id returns the stored outcome, not a second delivery" },
    ],
    note:
      "PROVEN WHOLE-ROW IN THE FIX WAVE (item 14). Each lane's half was already green against a DOUBLE of the other — Lane A's alias test used a recording handler, Lane B's router tests used a scripted caller — and the row is the join. `test/joint/` drives one real 0.3.250 process through its own `toolAliases` into Lane B's real handler and router, and the delivered frame, the class, the summary and the typed outcome are read at the far end. The joint run also established what no report knew: the WS-10 §12 retry key survives the whole path, because the caller is bound with NO tool-use id and the message id still carries the model's own (item 15).",
  },
  {
    id: "WS17-2",
    bullet: "`ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behavior without Tool Search.",
    status: "proven",
    owner: "Lane B (handlers), with Lane A's alias table",
    citations: [
      { file: `${JOINT}/rows-1-2.test.ts`, testName: "row 2 — a model-emitted ListAgents renders the REAL directory, and both canonical twins are advertised" },
      { file: `${OFFICIAL}/runtime-aliases.test.ts`, testName: "row 2: `ListAgents` aliases the same way, and the advertised set records what 0.3.250 actually does" },
      { file: `${OFFICIAL}/aliases-containment.test.ts`, testName: "the canonical duplicates are DEFERRED rather than hidden — they stay addressable by name" },
    ],
    note:
      "The visibility half is RECORDED, not asserted-as-wished: with no Tool Search active the pinned runtime advertises the native name AND the canonical twin, so `deferred` is this package's intent and the runtime's own decision is what the test writes down. Re-measured under the hermetic child env (F-1), where the advertised set is the artifact's own 21 names rather than 25 including three remotely-flagged tools.",
  },
  {
    id: "WS17-3",
    bullet: "`disallowedTools` + permission floor cover harness-internal/direct paths aliases miss.",
    status: "proven",
    owner: "Lane A (aliases + deny floor, WS-14 §7)",
    citations: [
      { file: `${OFFICIAL}/runtime-aliases.test.ts`, testName: "row 3: the paths the alias does not cover — the canonical name direct, and where a deny rule must be spelled" },
      { file: `${OFFICIAL}/aliases-containment.test.ts`, testName: "the floor is a PATH rule, so it covers tools no disposition anticipated" },
    ],
    note:
      "The measurement behind it: denying only the built-in leaves the alias resolving and the handler RUNNING, because the deny check happens after alias resolution. `aliasDenyNames` is the door that stops a host tripping over it, and row 3 is why it exists.",
  },
  {
    id: "WS17-4",
    bullet: "Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake, zero visibility into `~/.claude`.",
    status: "proven",
    owner: "Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake)",
    citations: [
      { file: `${OFFICIAL}/runtime-spool.test.ts`, testName: "row 4: two sessions under ONE spool stay isolated, and neither can see the vendor home" },
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "DISCOVERY is isolated: each sees the other session and its OWN children, never the other's" },
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "DELIVERY between the two lands in the receiver's own handle, attributed to the sender" },
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "HOLD and REFUSE are the receiver's, and neither delivers anything" },
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "IDLE WAKE: an idle official session starts one turn (`delivered`), a running one queues" },
      { file: `${JOINT}/rows-4-5.test.ts`, testName: "two live official sessions get DIFFERENT config dirs, each under its own spool" },
      { file: `${JOINT}/rows-4-5.test.ts`, testName: "a model in one official session DISCOVERS and ADDRESSES the other, and the delivery lands in it" },
      { file: `${JOINT}/rows-4-5.test.ts`, testName: "a receiver whose permission class cannot be known is HELD, not delivered — fail-closed, with the real runtime as the sender" },
      { file: `${JOINT}/rows-4-5.test.ts`, testName: "notify_when_idle against an OFFICIAL target refuses the whole call — measured, because this branch has no idle signal" },
    ],
    note:
      "Both halves are now measured against two REAL 0.3.250 processes over one shared directory (item 14) — run SEQUENTIALLY, each with its own spool, which is what the isolation assertion compares; not one lane's real runtime beside the other lane's double. The `idle wake` clause resolves to WS-10 §14's WHOLE-CALL REFUSAL on this branch — the pinned SDK's `Query` exposes no session-status surface, so an adapter without a reliable idle signal must refuse rather than subscribe. That is a measurement about the artifact, not a gap in the row.",
  },
  {
    id: "WS17-5",
    bullet: "Official parent resume after restart restores completed children for native SendMessage resume.",
    status: "proven",
    owner: "Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route)",
    citations: [
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "recovery keeps the completed children, and a native SendMessage to one routes through the resumed parent" },
      { file: `${MESSAGING}/official-pair.test.ts`, testName: "before the parent is resumed, the same send is retryably unavailable rather than not-found" },
      { file: `${JOINT}/rows-4-5.test.ts`, testName: "generation two is a real `resume()` of generation one's backend session, and the completed children are addressable through it" },
    ],
    note:
      "The joint half is a REAL `resume()` (round 2, NEW-B): generation one's `system/init` session id and its own spool are handed to `adapter.resume()`, the second generation reports the SAME backend session id and the same observed root, and a native SendMessage to a completed child is asserted `delivered`/`queued` with the frame arriving in the resumed parent's stream. The earlier version launched two fresh sessions and closed on `not.toBe(\"not_found\")`, which `unavailable` and `held` also satisfy.",
  },
  {
    id: "WS17-7",
    bullet: "Messaging: addressing, ambiguity/staleness, dedupe, queue bounds, TTL, retries, crash windows, loop prevention, reply routing, `notify_when_idle`.",
    status: "proven",
    owner: "Lane B (the messaging router, WS-15 §6.2–6.3 / WS-10 §11–§13)",
    citations: [
      { file: `${MESSAGING}/directory.test.ts`, testName: "rule 4 — ambiguity RETURNS CANDIDATES rather than choosing, and the candidates are directory rows" },
      { file: `${MESSAGING}/directory.test.ts`, testName: "rule 5 — a name whose only holder is gone is STALE, not not-found (the lease outlives the row)" },
      { file: `${MESSAGING}/router.test.ts`, testName: "a retry of the same (sender, tool-call) pair returns the STORED outcome and starts no second turn" },
      { file: `${MESSAGING}/router.test.ts`, testName: "the dedupe survives a RESTART, because the id is derived rather than counted" },
      { file: `${MESSAGING}/router.test.ts`, testName: "the envelope and its resolved generation are persisted, and the delivery is CLAIMED, before the adapter runs" },
      { file: `${MESSAGING}/router.test.ts`, testName: "an adapter that THROWS is delivery_uncertain, and the record keeps the claim" },
      { file: `${MESSAGING}/router.test.ts`, testName: "an identical rapid repeat is suppressed with a VISIBLE outcome, and allowed again after the window" },
      { file: `${MESSAGING}/router.test.ts`, testName: "a reply chain is stopped at MAX_HOP_COUNT — the bound is machinery, not documentation" },
      { file: `${MESSAGING}/router.test.ts`, testName: "the subscription SURVIVES A RESTART — a new router over the same store still fires it" },
      { file: `${MESSAGING}/recovery.test.ts`, testName: "step 5 turns every claimed-but-unreceipted delivery into delivery_uncertain, and redelivers nothing" },
    ],
    note: "Ten clauses, ten named proofs. The crash-window clause is the one worth reading twice: the envelope and the CLAIM are persisted before the adapter is invoked, so a crash between them is recoverable as `delivery_uncertain` rather than as silence.",
  },
  {
    id: "WS17-8",
    bullet: "Shared filesystem `SessionStore` + pinned dialect: Claude→Winter, Winter→Claude, and both round-trips at every advertised level.",
    status: "proven",
    owner: "Lane C (store wiring, WS-05 §6/§7)",
    citations: [
      { file: `${STORE}/rows.test.ts`, testName: "Claude -> Winter, Winter -> Claude and both round trips at level" },
      { file: `${STORE}/rows.test.ts`, testName: "the subagent level round-trips too: a subkey survives both directions" },
    ],
    scoped: true,
    note:
      "SCOPED, and the scope is what this row's own tests cover: both legs are produced by the SHARED STORE over the pinned dialect, at every advertised level, over real `mkdtemp` homes. A Claude leg written by the PINNED RUNTIME is covered next door rather than here — `docs/probes/materialized-resume.md`'s probe (c) drives both round-trip orders with the real artifact producing every Claude leg, and as of round 2 it PASSES (its round-1 failure was two probe-side defects: a seed that never reached the canonical store, and a line-adjacency rule stricter than the dialect and than the barrier's own step 5). All four probes now pass measured, so `probe()` reports `preferred`; the SHIPPED default is still `fallback`, because the door follows a measurement a host takes on its own pin. No `agent-state` or `full-filesystem` compatibility claim rests on this row.",
  },
  {
    id: "WS17-11",
    bullet: "Delete/rebuild of the disposable `sessions/index.db` preserves runtime mappings, backend IDs, cursors.",
    status: "proven",
    owner: "Lane C (store wiring)",
    citations: [
      { file: `${STORE}/rows.test.ts`, testName: "runtime mappings, backend ids and cursors all survive, because none of them live there" },
      { file: `${STORE}/rows.test.ts`, testName: "the router never reads the product index: its name appears nowhere in this lane's source" },
    ],
    note: "Proven the strong way and the structural way: the data survives a delete/rebuild BECAUSE none of it lives in the index, and a source scan pins that the router never reads the index at all.",
  },
  {
    id: "WS17-12",
    bullet: "Documented message-size, 50-accepted/100-held queues, 5-minute dialog expiry, 12-hour idle subscription, permission-class behavior; inert `@` mentions retained.",
    status: "proven",
    owner: "Lane B (the inbound policy and the mailbox, WS-10 §13)",
    citations: [
      { file: `${MESSAGING}/router.test.ts`, testName: "a body over MAX_GLOBAL_MESSAGE_SIZE is refused before anything is resolved" },
      { file: `${MESSAGING}/policy.test.ts`, testName: "a DELIVERED message (an idle receiver, one turn started) frees its slot; a QUEUED one does not" },
      { file: `${MESSAGING}/policy.test.ts`, testName: "the held cap survives a RESTART — the in-memory box is rehydrated from the durable store" },
      { file: `${MESSAGING}/policy.test.ts`, testName: "a DEFAULT-class hold expires after five minutes; an EXPLICIT hold never does" },
      { file: `${MESSAGING}/router.test.ts`, testName: "a subscription past its 12-hour expiry fires nothing and is swept" },
      { file: `${MESSAGING}/policy.test.ts`, testName: "prompts receiver x BYPASSES sender holds, visibly, with the envelope kept durably" },
      { file: `${MESSAGING}/policy.test.ts`, testName: "`@` mentions and slash-command text survive the router's own rendering byte-identically" },
    ],
    note: "The expiry clause carries one interim behaviour a host must know and the README states: the sweep is LAZY — a held message's receipt is rewritten to `refused` when something next addresses that receiver, not on a timer of its own.",
  },
  {
    id: "WS17-13",
    bullet: "No verbatim all-rights-reserved artifacts in the Winter distribution; ephemeral CI fetch only.",
    status: "proven",
    scoped: true,
    owner: "the spine (the packing and source gates), with this file's lockfile-integrity check",
    citations: [
      { file: `${GATES}/release-gates.test.ts`, testName: "nothing tracked is the pinned package, its bundle, or a vendored copy" },
      { file: `${GATES}/scripts.test.ts`, testName: "an embedded Anthropic artifact is rejected, by directory name and by file name" },
      { file: `${GATES}/scripts.test.ts`, testName: "rule 7: the OPTIONAL peer named in a REACHABLE declaration is rejected -- and only there" },
      { file: "./rows.test.ts", testName: "row 13's other half — the pinned artifact is fetched by integrity hash into a gitignored tree" },
    ],
    note: "Scoped to the ROUTER's own distribution: the artifact exists only in gitignored `node_modules`, is pinned by lockfile integrity (the plan's Global Constraints), and is rejected by the pack scan if it ever reaches a tarball. WS-02 §6's checksum-verified ephemeral FETCH is the SDK repository's own harness gate and stays there.",
  },
  {
    id: "WS17-14",
    bullet: "Native + aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and arbitrary file/shell paths cannot create `CLAUDE.md`, `.claude/`, or `~/.claude/plans` under strict policy.",
    status: "proven",
    owner: "Lane A (builtin-path containment, WS-14 §8)",
    citations: [
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "the native writers: every §8 row is EXERCISED, and the tally says which containment stopped it" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "arbitrary file and shell paths: an approving broker does not lift the floor" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "review r2, NEW-3: a command that BUILDS the name is caught post-hoc — swept, reported, and the call blocked" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "review r3, NEW-9: a command whose side effect precedes a FAILURE is swept too" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "review r3, NEW-11: the saved-approval path, for real — the durable update is stripped and no vendor settings file appears" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "review r4, NEW-18 (a): a host hook stamped with the exported floor mark does not REPLACE the floor — the floor is recognised by identity" },
      { file: `${OFFICIAL}/runtime-containment.test.ts`, testName: "the whole session's writes stay inside the spool, the cwd and the product home" },
    ],
    note: "Two layers, and the scope is exact. PRE-HOC: the permission floor refuses any call whose arguments name a forbidden target — path fields (case-folded, NFKC), command text (un-normalized, quote-stripped), and the §8 writers with no path argument at all — installed by `launch()` itself on EVERY launch — merged ahead of the caller's own hooks and never replaced by one of them (the floor is recognised by IDENTITY: a hook merely stamped with the exported floor mark is not the floor, and a genuine floor built under a looser template policy does not stand in for the adapter's own) — and required by `assertOptionsInvariants` by that same identity, not merely offered by the options builder. POST-HOC: a sweep registered on PostToolUse, PostToolUseFailure and PostToolBatch snapshots the forbidden names under the session's cwd AND the child's HOME, to a bounded depth (6 by default), around every filesystem-touching call; it removes what APPEARED under its roots during the call, records a typed containment breach, and ends the turn. SCOPE, stated rather than implied: shell-escape and constructed-name spellings are caught POST-HOC by the sweep, never pre-hoc; the sweep sees the SYNCHRONOUSLY-VISIBLE effects of the call it brackets (a background write that lands later is caught opportunistically by the next swept call), and its diff is TIME-BASED rather than causal — under the child's HOME that means a vendor home created by something else during a long call is removed and attributed to that call, which is narrow (an existing one is in every baseline and is never touched) but is what the wording says; it does not look outside cwd and HOME, nor below its depth bound; and the TURN ends only for a call that SUCCEEDS — for a failing call the guarantee is that the artifact does not survive it.",
  },
  {
    id: "WS17-15",
    bullet: "Canonical memory + the D18 temp layout, cross-engine temp continuity, vendor temp roots reported honestly, supervised pre-cleanup reconciliation, default-spawn `mirror_error` handoff refusal, entire-adapter projection, `$bunfs` extraction avoided or tested.",
    status: "proven",
    owner: "Lane C (temp continuity and the barrier) with Lane A (the supervised proxy)",
    scoped: true,
    citations: [
      { file: `${STORE}/rows.test.ts`, testName: "the temp home stabilizes in the vendor engine dir across a full round trip" },
      { file: `${STORE}/rows.test.ts`, testName: "the vendor temp roots are reported honestly, including the one a copy left behind" },
      { file: `${STORE}/rows.test.ts`, testName: "supervised PRE-CLEANUP reconciliation: the entries are in the store before the staging root is deleted" },
      { file: `${STORE}/rows.test.ts`, testName: "a DEFAULT-SPAWN session with a mirror error is refused, never reconciled by guesswork" },
      { file: `${OFFICIAL}/runtime-spool.test.ts`, testName: "row 15: the vendor temp root is what we configured PLUS the engine's own segment, reported honestly" },
      { file: `${OFFICIAL}/runtime-spool.test.ts`, testName: "§1 profile 2 + §6 rules 2/3: a store-backed resume is observed as a staging root, and reconciliation runs BEFORE cleanup" },
    ],
    note:
      "SCOPED: six of the row's seven clauses are proven, four of them against the pinned runtime. The seventh — `$bunfs` extraction avoided or tested — is NOT claimed here: it is a property of how a HOST packages this package (a single-file Bun executable extracting its own embedded runtime), and nothing in this repository builds one. A row that counted it would be counting somebody else's build. The `entire-adapter projection` clause is likewise the projector's (Phase 8, WS-15 §4), and what this row proves for it is the durable half — the roots and records a projector reads.",
  },
  {
    id: "WS17-17",
    bullet: "Two identical raw model IDs behind different providers keep distinct provider-qualified identity/credentials/continuation/resume routes.",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 — the fixture really is one raw model id behind several providers" },
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 identity — two selections of the same raw id keep distinct provider-qualified identities" },
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 credentials — each row is admitted by ITS OWN provider's credential ref, never a sibling's" },
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 continuation — the same raw id routes to DIFFERENT runtimes depending on the provider" },
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 resume — a record on one provider never resumes onto its twin behind another provider" },
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 — two children on the same raw id under one parent stay two distinct records" },
    ],
    note: "The fixture mirrors the generated catalog, where `claude-opus-5` really is six rows behind six providers.",
  },
];

/**
 * The Phase 7b RULINGS this lane discharges, which are obligations of the plan rather than rows of
 * WS-17 §8 — so they are cited here beside the rows instead of being invisible to the close-out.
 */
export const RULING_ROWS: RouterRow[] = [
  {
    id: "D13/D28",
    bullet: "The runtime-selection table: Claude OAuth → official always (D14-gated); a Claude-family model on a backend the official branch serves in Code mode → official; Claude through other endpoints and all Dispatch/Chat → Winter; never a raw model-ID substring; the persisted selection wins.",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 1 — a Claude OAuth credential routes to the official runtime, always" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 2 — a Claude-family model on an Anthropic-protocol backend in Code mode routes to the official runtime" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 2 — a Console OAuth bearer on the Anthropic-dialect backend routes to the official runtime" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 2 — a cloud credential chain is a backend the official branch serves, dialect notwithstanding" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "officialServesBackend agrees with OFFICIAL_SERVED_AUTH_FAMILIES for every auth family" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 3 — the same Claude model through a non-Anthropic-protocol endpoint routes to Winter" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 3 — Dispatch and Chat run on Winter even on the Anthropic-protocol backend" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D28 — a gpt-family slot routes to Winter even with an official peer present" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "no branch reads a raw model id — renaming every model id leaves the decision unchanged" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "the persisted selection wins and is returned by identity, never re-decided" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a persisted selection that no longer matches a fresh decision is reported as handoff-required, not rewritten" },
    ],
  },
  {
    id: "D14 gate",
    bullet: "The Claude OAuth ship gate is closed by default, and a closed gate refuses rather than falling back to the Winter runtime.",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "the D14 ship gate ships closed — the shipped default flag refuses a Claude OAuth session" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 1 — Claude OAuth with the D14 ship gate closed is refused, never downgraded to Winter" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 1 — Claude OAuth outside Code mode is refused: Code-only even after D14 approval" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "D13 row 1 — Claude OAuth with no official peer is refused, because it never routes to Winter" },
    ],
  },
  {
    id: "R-7b-1",
    bullet: "A child runs on the runtime its OWN slot's family selects, independent of the parent's; the child's selection is persisted with the child, resume follows the child's record, and a cross-runtime pair talks only through the RuntimeDirectory.",
    status: "proven",
    owner: "Lane D (the selection half; the delivery half is Lane B's)",
    citations: [
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — the same child under two different parents produces the identical record" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a Claude-family child of a Winter parent runs on the official runtime" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a gpt-family child of an official parent runs on the Winter runtime" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a cross-runtime parent/child pair is flagged for the directory channel" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS-13c §8 — a resume never re-decides the runtime, even when the table would now differ" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS-13c §8 — a resume succeeds on a recorded row that is not its provider's first row" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS-13c §8 — a resume refuses when the recorded ROW is unservable though its provider still serves the model" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS-13c §8 — a resume refuses when the recorded row has moved into another family" },
    ],
  },
  {
    id: "WS13c-SM1/2/3",
    bullet: "A parent switching family leaves its child's record untouched (both directions), and a child whose provider credential is gone refuses with `child-provider-unavailable` while the parent's turn continues.",
    status: "proven",
    owner: "Lane D (selection level; the `DeliveryOutcome` half is Lane B's)",
    citations: [
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS13c-SM1 — a gpt parent's sonnet child is unchanged when the parent switches to claude" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS13c-SM2 — a claude parent's gpt child is unchanged when the parent switches to gpt" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "WS13c-SM3 — a child whose credential is gone refuses with child-provider-unavailable and is not retryable" },
    ],
  },
  {
    id: "R-7b-8",
    bullet: "The D29 probe: whether the pinned official runtime exposes an advisor server tool in an SDK session, and under which condition, measured against the pinned artifact through the loopback capture and recorded.",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/d29-advisor-probe.test.ts`, testName: "the probe drove the PINNED artifact, over loopback only, and printed its inventories" },
      { file: `${SELECTION}/d29-advisor-probe.test.ts`, testName: "D29 — no condition puts an advisor tool in the session's advertised tool inventory" },
      { file: `${SELECTION}/d29-advisor-probe.test.ts`, testName: "D29 — configuring an advisor model puts NOTHING advisor-shaped on the wire (the pinned artifact, alone)" },
      { file: `${SELECTION}/d29-advisor-probe.test.ts`, testName: "D29 — no advisor appears in ANY hermetic condition, on the wire or in the inventory" },
      { file: `${SELECTION}/d29-advisor-probe.test.ts`, testName: "the remote-configuration leg, when it is explicitly enabled, shows what the CDN adds" },
      { file: "../../docs/probes/d29-advisor.md", testName: "## 3. Verdict" },
    ],
    note:
      "REWRITTEN IN THE FIX WAVE (whole-branch F-1). The first version's citations pointed at tests asserting that `settings.advisorModel` put an advisor on the wire; that was the pinned artifact PLUS its remote feature configuration, and it went red whenever the CDN fetch timed out. With the runtime's four traffic opt-outs set, no condition puts an advisor anywhere — it is a remotely-flagged capability, not a property of the pin. D29's split is unaffected either way (nothing client-side to alias under either condition). One labelled non-hermetic leg survives behind `WINTER_D29_ALLOW_REMOTE_CONFIG=1` and is evidence for nothing. The probe skips with a printed reason where the pinned runtime cannot start, so the citation is to the tests AND to the record they produce.",
  },
];

const ALL_ROWS = [...ROUTER_ROWS, ...RULING_ROWS];

function readCited(relPath: string): string {
  return readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
}

/** A citation's file, as a path from the repository root — what a reader of the document needs. */
function repoRelative(citationFile: string): string {
  const root = new URL("../../", import.meta.url).pathname;
  return decodeURIComponent(new URL(citationFile, import.meta.url).pathname.slice(root.length));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + 1;
  }
}

/**
 * A row's status cell.
 *
 * A row whose claim is NARROWER than WS-17's own sentence says so in the STATUS, not only in a note
 * three sections further down — review r1's M4: WS17-13's bullet says "the Winter distribution" and
 * "ephemeral CI fetch only", while the router's evidence is its own distribution plus a
 * `--frozen-lockfile` install into a gitignored tree. A close-out reading the table must see the
 * scope where the claim is. Notes that are context rather than a narrower claim ride the table's own
 * note column instead (also M4), and leave the status word alone.
 */
function statusCell(row: RouterRow): string {
  if (row.status !== "proven") return "unproven";
  return row.scoped === true ? "**proven** (router-scoped — see the note)" : "**proven**";
}

/** The checked-in document, rendered from the table above. */
export function renderRowsDocument(): string {
  const lines: string[] = [];
  lines.push("# `@yanlinglabs/winter-runtime-sdk` — conformance rows");
  lines.push("");
  lines.push("> GENERATED from `test/conformance/rows.test.ts`. Do not edit by hand — change the table there and");
  lines.push("> re-run `WINTER_ROWS_WRITE=1 bun test test/conformance/rows.test.ts`. Every citation below is");
  lines.push("> machine-verified by that test: the cited file is read and the cited test title searched for, so a");
  lines.push("> renamed test fails the suite rather than leaving this page claiming a proof that no longer exists.");
  lines.push("");
  lines.push("WS-17 §8's closing line is why this page exists: **no release may claim drop-in compatibility while a");
  lines.push("router-owned row is unproven.** Rows 6, 9, 10, 16 and 18 are excluded by WS-17 §8 itself.");
  lines.push("");
  lines.push("## WS-17 §8 — the router's proof rows");
  lines.push("");
  lines.push("| Row | Status | Owner | Obligation | Scope / note |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of ROUTER_ROWS) {
    lines.push(`| ${row.id} | ${statusCell(row)} | ${row.owner} | ${row.bullet} | ${row.note ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Phase 7b rulings discharged (not WS-17 rows)");
  lines.push("");
  lines.push("| Ruling | Status | Owner | Obligation | Scope / note |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const row of RULING_ROWS) {
    lines.push(`| ${row.id} | ${statusCell(row)} | ${row.owner} | ${row.bullet} | ${row.note ?? "—"} |`);
  }
  lines.push("");
  lines.push("## Citations");
  lines.push("");
  for (const row of ALL_ROWS) {
    if (row.citations === undefined || row.citations.length === 0) continue;
    lines.push(`### ${row.id}`);
    lines.push("");
    for (const citation of row.citations) {
      lines.push(`- \`${repoRelative(citation.file)}\` — \`${citation.testName}\``);
    }
    lines.push("");
  }
  const unproven = ALL_ROWS.filter((row) => row.status === "unproven");
  lines.push("## Still unproven");
  lines.push("");
  if (unproven.length === 0) lines.push("None — every row above carries at least one machine-verified citation.");
  else for (const row of unproven) lines.push(`- **${row.id}** — ${row.owner}`);
  lines.push("");
  return lines.join("\n");
}

const DOC_PATH = fileURLToPath(new URL("../../docs/conformance-rows.md", import.meta.url));

describe("WS-17 §8 — the router's conformance rows", () => {
  test("every row is proven with citations or unproven with the lane that owns it", () => {
    for (const row of ALL_ROWS) {
      if (row.status === "proven") {
        expect(row.citations?.length ?? 0, `${row.id}: a proven row must carry at least one citation`).toBeGreaterThan(0);
      } else {
        expect(row.owner.length, `${row.id}: an unproven row must name the lane that owns it`).toBeGreaterThan(6);
        expect(row.citations, `${row.id}: an unproven row must not carry citations`).toBeUndefined();
      }
    }
  });

  test("every citation's file exists and genuinely contains the cited title — a renamed test fails HERE", () => {
    for (const row of ALL_ROWS) {
      for (const citation of row.citations ?? []) {
        // Self-citation loophole guard: a row citing THIS file has its own `testName` literal sitting
        // in the table above, which a plain `includes` would satisfy even if the real test were gone.
        const required = citation.file === "./rows.test.ts" ? 2 : 1;
        const occurrences = countOccurrences(readCited(citation.file), citation.testName);
        expect(occurrences >= required, `${row.id}: ${citation.file} does not contain ${required} occurrence(s) of "${citation.testName}" (found ${occurrences})`).toBe(true);
      }
    }
  });

  test("every citation is specific enough to be a tripwire, and every cited file is a test or the probe record", () => {
    for (const row of ALL_ROWS) {
      for (const citation of row.citations ?? []) {
        expect(citation.testName.length, `${row.id}: "${citation.testName}" is too short to discriminate`).toBeGreaterThanOrEqual(13);
        expect(citation.file.endsWith(".test.ts") || citation.file.endsWith(".md"), `${row.id}: ${citation.file} is not a test file or a record`).toBe(true);
      }
    }
  });

  test("the row set is exactly R-7b-7's — 1-5, 7, 8, 11-15, 17 — with unique ids", () => {
    const numbers = ROUTER_ROWS.map((row) => Number(row.id.replace("WS17-", "")));
    expect(numbers).toEqual([1, 2, 3, 4, 5, 7, 8, 11, 12, 13, 14, 15, 17]);
    const ids = ALL_ROWS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("row 13's other half — the pinned artifact is fetched by integrity hash into a gitignored tree", () => {
    // The router's distribution never contains the artifact (the gates cited on row 13 prove that).
    // This is the other clause: the copy that DOES exist locally is pinned by a lockfile integrity
    // hash rather than fetched loosely, and the tree it lands in is gitignored.
    const lock = readCited("../../pnpm-lock.yaml");
    const pinned = lock.match(/'@anthropic-ai\/claude-agent-sdk@0\.3\.250':\s*\n\s*resolution: \{integrity: sha512-[A-Za-z0-9+/=]+==\}/);
    expect(pinned, "the pinned official SDK must carry a lockfile integrity hash").not.toBeNull();
    expect(readCited("../../.gitignore")).toContain("node_modules");
    expect(readCited("../../.github/workflows/ci.yml")).toContain("pnpm install --frozen-lockfile");
  });

  test("docs/conformance-rows.md is the rendering of this table (regenerate with WINTER_ROWS_WRITE=1)", () => {
    const rendered = renderRowsDocument();
    if (process.env["WINTER_ROWS_WRITE"] === "1") {
      writeFileSync(DOC_PATH, rendered);
      return;
    }
    expect(existsSync(DOC_PATH), "docs/conformance-rows.md is missing — regenerate it with WINTER_ROWS_WRITE=1").toBe(true);
    expect(readFileSync(DOC_PATH, "utf8")).toBe(rendered);
  });

  test("a scoped row says so in its status, and only a scoped row does", () => {
    const rendered = renderRowsDocument();
    for (const row of ALL_ROWS) {
      const line = rendered.split("\n").find((candidate) => candidate.startsWith(`| ${row.id} |`));
      expect(line, `${row.id} has no row in the rendered table`).toBeDefined();
      expect(line?.includes("router-scoped"), `${row.id}: only a row flagged \`scoped\` may say so`).toBe(row.scoped === true);
      // M4: every note reaches the table itself, not only the citations section.
      if (row.note !== undefined) expect(line).toContain(row.note);
    }
  });

  test("summary — how many rows this branch has flipped (informational)", () => {
    const proven = ALL_ROWS.filter((row) => row.status === "proven");
    console.log(`[rows] ${proven.length}/${ALL_ROWS.length} proven: ${proven.map((row) => row.id).join(", ")}`);
    console.log(`[rows] still unproven: ${ALL_ROWS.filter((row) => row.status === "unproven").map((row) => `${row.id} (${row.owner})`).join("; ")}`);
    expect(proven.length + ALL_ROWS.filter((row) => row.status === "unproven").length).toBe(ALL_ROWS.length);
  });
});
