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

**Reproduce:** `bun test test/store/materialized-resume.test.ts` (the harness, its honesty in both
directions, and the doors), or call `createMaterializedResumeDecorator(context, { shared }).probe()`,
which is what produced the table below.

---

## Verdict

# **The PREFERRED door is CLOSED. The FALLBACK door is what ships today.**

Not because a probe failed — **no probe leg failed** — but because three of the four probes name the
**pinned official runtime**, and this run had no bed to drive it in. An unexercised leg is recorded as
*not proven*, and a probe with an unproven leg is not a pass. `MaterializedResumeDecorator.door`
therefore reports `"fallback"`, the handoff barrier stages an undecorated copy and appends one
**explicitly labeled** entry to the canonical file, and nothing in this package claims the canonical
file stays byte-pure across a Claude leg.

That is the outcome WS-17 §8 itself anticipates: *"failing (b) demotes that leg to the barrier-append
fallback, it does not block release."*

## The table

| Probe | Verdict | Legs that ran | Legs that did not |
| --- | --- | --- | --- |
| **(a)** neighbour-file survival | **not proven** | `load`, `append`, `forced compaction`, `store import/export round-trip` — all **PASS**: the sidecar's bytes are identical after each, no sidecar record ever surfaces as a transcript entry, and an export/import into a second session creates **no** sidecar at the destination | `fresh-process resume` (needs the pin) |
| **(b)** no-wash-back | **not proven** | `reconciliation from a decorated copy` — **PASS**: canonical past bytes unchanged; the decoration never reaches the store; the turn written *after* the decoration lands **re-parented** onto the canonical chain | `mirror from a decorated copy` (needs the pin) |
| **(c)** sidecar-present round-trip | **not proven** | `claude→winter→claude` and `winter→claude→winter` — both **PASS**: the Claude legs' lines are byte-identical in the final file, the parent chain is unbroken, the sidecar is populated and the producer record names the last producer. **Both legs are produced by the STORE, not by the pinned runtime** | `the Claude legs on the pinned runtime` — the same two round trips with the bed producing every Claude leg (needs the pin) |
| **(d)** crash pairs | **PASS** | `record without entry is collectable`, `entry without record degrades, never corrupts` — the orphan record is classified collectable with the transcript untouched; the unanchored entry is classified degraded rather than dropped and the transcript still loads with its chain intact | — |

`crash-pairs` is entirely a property of the store and the write-ahead ordering, which is why it is the
one probe that can be fully answered without the vendor's runtime.

## What "needs the pin" means, and how to close it

`probe()` takes an optional `PinnedRuntimeProbeLegs` collaborator with one method,
`freshProcessResume({ home, stagingRoot, key, shared })`: start the pinned official runtime on a
store-backed resume from `stagingRoot`, with `shared.store` attached as `Options.sessionStore`, and
return when the generation ends. Lane A's `test/official/support.ts` is exactly that bed — it resolves
the platform package through the official package's own `require`, asserts the version equals the pin,
and runs a session against a `127.0.0.1` fake in 1–3 s. **This lane did not have it in-tree** (Lane A
had not merged when Lane C ran), so the three legs were left unexercised rather than simulated.

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

A future run with the real bed replaces the table above. The verdict line is the only thing a reader
should have to check: it says which door is open, and the door in the code is computed from the same
report, so the two cannot disagree.
