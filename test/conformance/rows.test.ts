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
  /**
   * `retired` (WS-23): the row's subject was the official `claude` runtime, which this package no
   * longer serves — kept in the table with the reason, never silently dropped.
   */
  status: "proven" | "unproven" | "retired";
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
const MESSAGING = "../messaging";
const STORE = "../store";

/**
 * The thirteen rows R-7b-7 names. Rows 6, 9, 10, 16 and 18 are excluded by WS-17 §8 itself (they are
 * the daemon's, the capability matrix's, the upgrade corpus's, the standalone-launch case's and the
 * cross-suite gate's), so their absence here is the spec's, not this table's.
 */
export const ROUTER_ROWS: RouterRow[] = [
  {
    id: "WS17-1",
    bullet: "Real model-emitted `SendMessage` through the TS alias reaches `mcp__winter__send_message` with native args and returns the visible result.",
    status: "retired",
    owner: "Lane B (the handlers the official branch's aliases reach), with Lane A's `toolAliases`",
    note: "RETIRED (WS-23, the official runtime is gone): its subject was the official branch's TS alias onto the router's handlers; the Winter runtime's own `SendMessage` reaches its own tools, and `messaging/handlers.test.ts` still pins the retry.",
  },
  {
    id: "WS17-2",
    bullet: "`ListAgents` aliasing; canonical MCP duplicate deferred/hidden visibility; behavior without Tool Search.",
    status: "retired",
    owner: "Lane B (handlers), with Lane A's alias table",
    note: "RETIRED (WS-23, the official runtime is gone): `ListAgents` aliasing and the canonical MCP duplicate were the official branch's.",
  },
  {
    id: "WS17-3",
    bullet: "`disallowedTools` + permission floor cover harness-internal/direct paths aliases miss.",
    status: "retired",
    owner: "Lane A (aliases + deny floor, WS-14 §7)",
    note: "RETIRED (WS-23, the official runtime is gone): the alias-vs-deny-floor gap was the official branch's.",
  },
  {
    id: "WS17-4",
    bullet: "Two official sessions under the spool: isolated discovery, delivery, hold/refuse, idle wake, zero visibility into `~/.claude`.",
    status: "retired",
    owner: "Lane A (spool isolation, WS-14 §1) with Lane B (delivery, hold/refuse, idle wake)",
    note: "RETIRED (WS-23, the official runtime is gone): two official sessions under the spool — there is no official session any more.",
  },
  {
    id: "WS17-5",
    bullet: "Official parent resume after restart restores completed children for native SendMessage resume.",
    status: "retired",
    owner: "Lane A (parent-restart child restoration, WS-14 §15) with Lane B (the resume route)",
    note: "RETIRED (WS-23, the official runtime is gone): an official parent's resume — there is no official session any more.",
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
    status: "retired",
    owner: "Lane C (store wiring, WS-05 §6/§7)",
    note: "RETIRED (WS-23, the official runtime is gone): the Claude→Winter / Winter→Claude transfer through the shared store was the handoff barrier's; a session the official runtime wrote now resumes on the Winter runtime in place (the daemon's adoption, WS-23 R2).",
  },
  {
    id: "WS17-11",
    bullet: "Delete/rebuild of the disposable `sessions/index.db` preserves runtime mappings, backend IDs, cursors.",
    status: "proven",
    owner: "Lane C (store wiring)",
    citations: [
      { file: `${STORE}/wiring.test.ts`, testName: "the router never reads the product index: its name appears nowhere in this lane's source" },
    ],
    note: "Proven the structural way: the data survives a delete/rebuild BECAUSE none of it lives in the index, and a source scan pins that the store lane never reads it. (WS-23: the half that drove a handoff through the barrier went with the barrier.)",
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
      { file: "./rows.test.ts", testName: "row 13's other half — WS-23: no Anthropic artifact is fetched at all any more" },
    ],
    note: "Scoped to the ROUTER's own distribution: the pack scan rejects the artifact if it ever reaches a tarball. WS-23: the official runtime is retired, so this repository no longer fetches it at all (no dependency, no lockfile entry). WS-02 §6's checksum-verified ephemeral FETCH is the SDK repository's own harness gate and stays there.",
  },
  {
    id: "WS17-14",
    bullet: "Native + aliased Agent/worktree, durable Cron, workflow, saved-approval, plan-mode, and arbitrary file/shell paths cannot create `CLAUDE.md`, `.claude/`, or `~/.claude/plans` under strict policy.",
    status: "retired",
    owner: "Lane A (builtin-path containment, WS-14 §8)",
    note: "RETIRED (WS-23, the official runtime is gone): the builtin-path containment it proved was the official runtime's; the Winter runtime's own containment is the host's and the SDK's.",
  },
  {
    id: "WS17-15",
    bullet: "Canonical memory + the D18 temp layout, cross-engine temp continuity, vendor temp roots reported honestly, supervised pre-cleanup reconciliation, default-spawn `mirror_error` handoff refusal, entire-adapter projection, `$bunfs` extraction avoided or tested.",
    status: "retired",
    owner: "Lane C (temp continuity and the barrier) with Lane A (the supervised proxy)",
    note: "RETIRED (WS-23, the official runtime is gone): temp continuity across engines, the staging roots and the pre-cleanup reconcile were the official runtime's and the barrier's.",
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
      { file: `${SELECTION}/row-17.test.ts`, testName: "row 17 continuation — the same raw id is decided by DIFFERENT rules depending on the provider" },
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
    bullet: "The runtime-selection table (WS-23: one runtime): Claude OAuth → refused, never Winter (D28); every other Claude row, every family and all Dispatch/Chat → Winter; never a raw model-ID substring; the persisted selection wins.",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a Claude OAuth credential is refused runtime-unavailable, approved or not, peer or not — never downgraded to Winter" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a Claude-family model on an Anthropic-protocol backend in Code mode selects Winter (R-7b-1), even with `hasClaudePeer: true`" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a Console OAuth bearer on the Anthropic-dialect backend selects Winter" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a cloud credential chain selects Winter too — the dialect distinction now only names the rule" },
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
    bullet: "The Claude OAuth ship gate is closed by default, and a closed gate refuses rather than falling back to the Winter runtime. (WS-23: stronger now — a Claude OAuth credential is refused whatever the gate says, in every mode.)",
    status: "proven",
    owner: "Lane D",
    citations: [
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "the D14 constant is still exported, and still closed" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "a Claude OAuth credential is refused runtime-unavailable, approved or not, peer or not — never downgraded to Winter" },
      { file: `${SELECTION}/select-runtime.test.ts`, testName: "…and in Dispatch and Chat too" },
    ],
  },
  {
    id: "R-7b-1",
    bullet: "A child runs on the runtime its OWN slot's family selects, independent of the parent's; the child's selection is persisted with the child, resume follows the child's record, and a cross-runtime pair talks only through the RuntimeDirectory.",
    status: "proven",
    owner: "Lane D (the selection half; the delivery half is Lane B's)",
    citations: [
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — the same child under two different parents produces the identical record" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a Claude-family child of a gpt parent runs on the Winter runtime (WS-23: once the official runtime)" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a gpt-family child of a Claude parent runs on the Winter runtime" },
      { file: `${SELECTION}/child-runtime.test.ts`, testName: "R-7b-1 — a cross-family pair is NOT cross-runtime any more (WS-23): it stays on the in-runtime channel" },
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
    status: "retired",
    owner: "Lane D",
    note: "RETIRED (WS-23, the official runtime is gone): the D29 probe measured the pinned official runtime.",
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
  if (row.status === "retired") return "retired (WS-23)";
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
  const retired = ALL_ROWS.filter((row) => row.status === "retired");
  if (retired.length > 0) {
    lines.push("## Retired (WS-23)");
    lines.push("");
    lines.push("The official `claude` runtime is no longer served by this package; these rows were about it.");
    lines.push("");
    for (const row of retired) lines.push(`- **${row.id}** — ${row.note ?? ""}`);
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
  test("every row is proven with citations, unproven with the lane that owns it, or retired with the reason", () => {
    for (const row of ALL_ROWS) {
      if (row.status === "proven") {
        expect(row.citations?.length ?? 0, `${row.id}: a proven row must carry at least one citation`).toBeGreaterThan(0);
      } else if (row.status === "retired") {
        expect(row.note?.startsWith("RETIRED (WS-23"), `${row.id}: a retired row must say why`).toBe(true);
        expect(row.citations, `${row.id}: a retired row carries no citations`).toBeUndefined();
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

  test("row 13's other half — WS-23: no Anthropic artifact is fetched at all any more", () => {
    // The router's distribution never contained the artifact (the gates cited on row 13 prove that).
    // The other clause used to be that the copy fetched for tests was pinned by a lockfile integrity
    // hash into a gitignored tree; with the official runtime retired, nothing fetches it.
    const lock = readCited("../../pnpm-lock.yaml");
    expect(lock.includes("@anthropic-ai/claude-agent-sdk"), "the lockfile must not name the official SDK").toBe(false);
    expect(readCited("../../package.json")).not.toContain("@anthropic-ai/claude-agent-sdk");
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
    expect(proven.length + ALL_ROWS.filter((row) => row.status !== "proven").length).toBe(ALL_ROWS.length);
  });
});
