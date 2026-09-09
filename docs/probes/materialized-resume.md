# Materialized-resume probes — is WS-13 §8.2's PREFERRED door open on this pin?

**Ruling:** the Phase 7b plan's Task 4 ("PREFERRED (decorations in the materialized copy, canonical
byte-pure) implemented behind the four probes — enabled only when all four pass on this pin, the result
recorded here"), executing R-7b-3.

**Obligation, verbatim (WS-17 §8, row 129):** *"Before any `agent-state` or `full-filesystem`
compatibility claim for non-Claude providers, the pinned Claude runtime MUST pass: **(a) neighbor-file
survival** — `<sessionId>.provider-state.jsonl` beside the transcript is left byte-untouched (never
deleted, rewritten, or imported) through load, append, fresh-process resume, forced compaction, and
store import/export round-trips; **(b) no-wash-back** — a decorated materialized resume copy (WS-13
§8.2's PREFERRED Claude-leg door) never causes mirror/reconciliation to rewrite canonical past entries;
failing (b) demotes that leg to the barrier-append fallback, it does not block release; **(c)
sidecar-present round-trip** — Claude→Winter→Claude and Winter→Claude→Winter with a populated sidecar
leave the Claude legs byte-unaffected and ordering intact; **(d) crash pairs** — the write-ahead sidecar
ordering recovers per WS-05 (record-without-entry collected; entry-without-record degrades warned, never
corrupts)."* (Probe **(e)**, five-path unknown-field survival, is explicitly OPTIONAL and "not required
for release"; it is not implemented and not claimed.)

**Probed:** 2026-09-09, Lane C, `darwin-arm64`, macOS 26.6.1, Bun 1.3.14, against
`@yanlinglabs/winter-agent-sdk@0.0.2`'s `WinterCompatibilitySessionStore` on `mkdtemp` homes.
**Re-probed after review round 1** (the (c) row below described work the code did not do — see "What
changed in fix round 1").

**RE-PROBED WITH THE PINNED RUNTIME, 2026-09-09 (P7b fix wave, items 11 + 23; corrected in round 2).**
Lane A's bed is now in the same tree, so the three legs that name the pinned official runtime have
RUN. Round 1 read (c)'s failure wrongly and blamed the runtime; round 2 measured the two causes, both
on the PROBE's side, fixed them, and re-ran: **all four probes now pass against the pinned artifact,
and `probe()` reports `door: "preferred"`.** See "The pinned run" below for both rounds.

**Reproduce:** `bun test test/store/materialized-resume.test.ts` (the harness, its honesty in both
directions, and the doors), or call `createMaterializedResumeDecorator(context, { shared }).probe()`,
which is what produced the table below.

---

## Verdict

# **PREFERRED is MEASURED OPEN on this pin, and SHIPS for this pin.**

Two statements, and keeping them apart is still the whole point — they now agree, and they agree
because someone joined them deliberately rather than because either moved on its own:

* **Measured:** all four of WS-17 §8's probes pass against the pinned 0.3.250 — every pinned leg
  exercised, on `darwin-arm64` and on `linux-x64` in CI — and `probe()` returns `door: "preferred"`.
  Nothing is unexercised, nothing is simulated, no leg is a hardcoded pass.
* **Shipped (Task 6b, under R-7b-12):** the verdict above is recorded per official-runtime version in
  `src/store/pinned-probes.ts`, `createRuntimeSdk` reads it from the INJECTED peer's own version, and
  the barrier's own decorator is the one that receives it — so one store, one decoration registry and
  one door stay structural. A handle over `0.3.250` therefore decorates the materialized copy and
  leaves the canonical file byte-pure. **Any other version, and a host with no official peer, still
  gets FALLBACK** — the always-available door, which stages an undecorated copy and appends one
  explicitly labeled entry after the destination confirms.

`createMaterializedResumeDecorator` itself is unchanged: it still reports `"fallback"` until it is
GIVEN a report or told to probe. The door is opened in exactly one place, by version, from this
record — and a host that measured its own pin on its own platform overrides it with
`createRuntimeSdk({ handoff: { decorationReport } })`.

**The record is re-derived, not trusted.** `test/joint/materialized-resume-probes.test.ts` now runs the
four probes against the real artifact and compares its own verdict to the one recorded here; a pin
whose mirror re-sends what it read, or whose runtime re-anchors a resumed chain, fails the suite rather
than opening a door that step 5 would then refuse. A pin BUMP fails it too, because an unrecorded
version has no report to match — which is the point: a bump is a reviewed compatibility event.

Round 1 of the fix wave recorded a different verdict — "CLOSED … no probe leg failed … this run had
no bed" — which was true when written and is superseded twice over: the bed arrived (items 11/23),
and probe (c)'s subsequent failure turned out to be the probe's own (round 2, NEW-F). Both earlier
readings are withdrawn.

## The pinned run (2026-09-09, the fix wave)

`test/joint/materialized-resume-probes.test.ts` drives `probe()` with `pinnedRuntimeProbeLegs()` —
Lane A's real bed, hermetic (F-1's four traffic opt-outs), one real 0.3.250 process per leg, resuming
from the staging root with the shared store attached as `Options.sessionStore`.

| Probe | Verdict WITH the pinned runtime | What the pinned leg measured |
| --- | --- | --- |
| **(a)** neighbour-file survival | **PASS** | `fresh-process resume`: the resume added **6 entries** to the store and the sidecar's bytes were **identical** afterwards |
| **(b)** no-wash-back | **PASS** | `mirror from a decorated copy`: a real resume FROM the decorated copy mirrored 6 entries; the canonical prefix was intact and the decoration **never** appeared in the store. This is the probe WS-17 §8 makes the PREFERRED door conditional on, and the vendor's mirror does **not** re-send the entries it read |
| **(c)** sidecar-present round-trip | **PASS** (round 2; FAILED in round 1 for two probe-side reasons — below) | `the Claude legs on the pinned runtime`, both orders: the Claude legs' lines byte-identical in the final file, the parent chain reachable, the sidecar populated, and the producer record naming the last producer |
| **(d)** crash pairs | **PASS** | (no pinned leg — entirely a store property) |

**Door: `preferred` — four measured passes on this pin.** Nothing here is unexercised, nothing is
simulated, and no leg is a hardcoded pass.

**Four FIXTURE defects had to be fixed to get here, and every one of them had been producing a result
that read like a verdict about the runtime.** Round 1 found two: the probe transcripts carried no
`message` field, so the pinned runtime refused every resume outright (`undefined is not an object
(evaluating 'e.message.content')`), and a round trip STARTING on the Claude leg was handed an empty
staging copy, which the runtime reports as `No conversation found with session ID`. Round 2 found the
two behind (c)'s failure, both measured rather than read:

1. **The Claude-first seed never reached the canonical store.** It was written into the staging COPY
   only. The mirror sends what the runtime WRITES, not what it READ — that is probe (b), and it
   passes — so the canonical file began with an entry chaining to a parent the store had never
   received. In a real handoff the copy IS a copy of the canonical file, so this dangling parent
   cannot occur in production: it was an artefact of "a round trip that starts on the Claude leg".
   The seed is now appended through `shared.store.append` **before** the copy is taken.
2. **`orderIntact` demanded line-ADJACENT chaining**, which the dialect never promised. The pinned
   runtime interleaves uuid-less bookkeeping entries (`queue-operation`, `last-prompt`, `mode`) into
   the shared store, and a producer's first entry chains to the last CHAIN entry rather than the last
   LINE. The store-produced legs passed only because they write chain entries alone. The rule is now
   the BARRIER's own (`validateChain`): a `parentUuid` must appear EARLIER, entries without a uuid are
   skipped — the dialect's actual rule, and the one step 5 enforces before any handoff.

**The runtime does NOT re-anchor what it writes.** Round 1's record said it did; measured, it chains
its first new entry to the last chain entry of the copy it resumed, which is exactly right. That
sentence is withdrawn.

**What `door: "preferred"` does and does not change.** It is the value `probe()` returns from a
measured run. **The shipped default is unchanged and is still `fallback`**: `createMaterializedResumeDecorator`
reports `fallback` until it is given a report or told to probe, and the handoff barrier builds it with
neither — so a host gets the barrier-append FALLBACK unless it deliberately supplies this report or
runs the probes on its own pin and platform. That is the design (the door follows a MEASUREMENT, and a
measurement taken on someone else's machine is not this host's), and it means opening the door in
production is a deliberate act with a name, not a side effect of this file changing.

**Owed (controller):** a ruling on whether the router should ship this report as the default for the
pinned 0.3.250 — WS-13 §8.2 permits PREFERRED on four measured passes, and there are now four, on
darwin-arm64 and (as of this branch's CI) linux-x64. Until that ruling, the FALLBACK door ships and
the canonical file gets one explicitly labelled entry at the barrier.

## The table (the earlier, bedless run — kept for the contrast)

| Probe | Verdict | Legs that ran | Legs that did not |
| --- | --- | --- | --- |
| **(a)** neighbour-file survival | **not proven** | `load`, `append`, `forced compaction`, `store import/export round-trip` — all **PASS**: the sidecar's bytes are identical after each, no sidecar record ever surfaces as a transcript entry, and an export/import into a second session creates **no** sidecar at the destination | `fresh-process resume` (needs the pin) |
| **(b)** no-wash-back | **not proven** | `reconciliation from a decorated copy` — **PASS**: canonical past bytes unchanged; the decoration never reaches the store; the turn written *after* the decoration lands **re-parented** onto the canonical chain | `mirror from a decorated copy` (needs the pin) |
| **(c)** sidecar-present round-trip | **not proven** | `claude→winter→claude` and `winter→claude→winter` — both **PASS**: the Claude legs' lines are byte-identical in the final file, the parent chain is unbroken, the sidecar is populated and the producer record names the last producer. **Both legs are produced by the STORE, not by the pinned runtime** | `the Claude legs on the pinned runtime` — the same two round trips with the bed producing every Claude leg (needs the pin) |
| **(d)** crash pairs | **PASS** | `record without entry is collectable`, `entry without record degrades, never corrupts` — the orphan record is classified collectable with the transcript untouched; the unanchored entry is classified degraded rather than dropped and the transcript still loads with its chain intact | — |

`crash-pairs` is entirely a property of the store and the write-ahead ordering, which is why it is the
one probe that can be fully answered without the vendor's runtime.

## What "needs the pin" means, and how to close it

**CLOSED, in the fix wave** — `test/joint/probe-legs.ts` is the collaborator, and the run above is the
result. The paragraphs below describe what was owed and are kept because they say what each leg
measures.

`probe()` takes an optional `PinnedRuntimeProbeLegs` collaborator with one method,
`freshProcessResume({ home, stagingRoot, key, shared })`: start the pinned official runtime on a
store-backed resume from `stagingRoot`, with `shared.store` attached as `Options.sessionStore`, and
return when the generation ends. Lane A's `test/official/support.ts` is exactly that bed — it resolves
the platform package through the official package's own `require`, asserts the version equals the pin,
and runs a session against a `127.0.0.1` fake in 1–3 s. **This lane did not have it in-tree** (Lane A
had not merged when Lane C ran), so the three legs were left unexercised rather than simulated — until
the fix wave, when it did.

With the bed supplied, the three legs measure exactly:

1. **(a)** the sidecar's bytes after the pinned runtime has loaded, appended to and resumed the session;
2. **(b)** whether the vendor's own dual-write mirror re-sends the entries it READ (the decoration among
   them) rather than only the ones it wrote — the one thing the router cannot determine by inspection;
3. **(c)** the same two round trips with a Claude leg produced by the real runtime.

Two of the tests in `test/store/materialized-resume.test.ts` already drive the harness through a
stand-in bed: one watches the door OPEN when every leg passes, and one supplies a bed that rewrites the
neighbour file and watches probe (a) FAIL. So the harness is proven to be watching before the real bed
is ever plugged in.

## What is implemented behind the closed door

The PREFERRED path is written, tested and inert — the door is the only thing keeping it shut:

* `decorate()` copies the canonical transcript into the staging root byte-for-byte, appends the labeled
  note **to the copy**, and reports `canonicalUntouched` as a MEASUREMENT (the canonical file's bytes
  read before and after the call), not as an assertion;
* the note is an ordinary `user` entry with exactly the dialect's own fields — the closed-corpus rule
  (WS-05 §13) binds the copy too, because the vendor's parser reads it — and its visible text carries a
  `[handoff: …]` label so it can never read as an ordinary message;
* every decoration's uuid is recorded in the shared store's **decoration registry**, and every write to
  the canonical store passes one gate that drops copy-only entries and **re-parents** their children.
  Without that gate the byte-pure file would acquire either the decoration (through reconciliation's
  suffix append) or an entry whose parent is unreachable in it — which WS-05 §12 step 5 would then
  refuse on the *next* handoff. This is the mechanism probe (b) measures rather than a hope that the
  vendor happens to behave.

## What changed in fix round 1

Review round 1 found that probe (c)'s pinned leg was a **hardcoded `passed: true`** whose evidence
string described a re-run that never happened — the bed was not called at all — and that this record
repeated the claim. Three things changed, and the verdict did not:

1. **Every pinned leg goes through one helper.** No bed → `unexercised`. A bed that **throws** → a
   FAILED LEG with the error as its evidence, not an aborted probe run. A bed that returns **without
   producing an entry** → `unexercised` as well, because a leg that measured nothing is not a pass.
   That last rule is what actually gates the door: a no-op bed used to open it.
2. **Probe (c)'s pinned leg re-runs both round trips for real**, with `freshProcessResume` producing
   every `claude-agent` leg, and derives its verdict from the same byte-and-order assertions the
   store-side legs use.
3. **This record says which producer wrote each leg.** The store-side rows of (c) are the STORE's
   round trips, not the runtime's, and the table now says so.

## Two things a future run with the real bed should watch for

* **The store has no uuid-idempotent append.** `WinterCompatibilitySessionStore.append` writes what it
  is given: re-sending two already-stored entries stores them twice. So if the pinned runtime's
  dual-write mirror re-sends what it READ rather than only what it wrote, the canonical file gains
  duplicate uuids — and step 5's uuid-uniqueness check would then refuse the session's *next* handoff.
  That is the concrete failure mode probe (b)'s pinned leg is protecting against, and it is why the
  leg is worth running rather than assuming.
* **The router's own gate does not depend on the answer.** The decoration registry drops copy-only
  entries and re-parents their children on every write to the canonical store, so reconciliation is
  safe either way. What the pinned leg measures is the vendor's behaviour, not the router's.

## Re-running this record

A future run replaces the tables above; `bun test test/joint/materialized-resume-probes.test.ts` is the
run, and it now also CHECKS this record against itself (see the verdict). Read the verdict as TWO
lines, not one — what was measured, and what ships — because they are still computed from different
things: the measurement is this file's, and the shipped door is `materializedResumeReportForPin(<the
injected peer's version>)`, overridable by a host's own `decorationReport`. They agree for `0.3.250`
and must not be assumed to agree for anything else.

**What would make a future run FAIL, and can now be seen:** probe (b)'s pinned leg counts duplicate
uuids in the canonical store after a resume from the decorated copy, and probe (c) applies BOTH of the
barrier's step-5 clauses (parent reachability AND uuid uniqueness). A pin whose dual-write mirror
re-sent the entries it read would leave a second copy of an existing uuid — which the prefix check
cannot see, and which step 5 refuses the next handoff on. Measured on 0.3.250: `duplicate uuids=0`.
