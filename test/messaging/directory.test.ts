// THE RUNTIME DIRECTORY: WS-15 §6.1's record and WS-10 §11's resolution order, rules 1-6.
//
// Every test here names the rule it pins, because the order is a MUST-order: rule 2 beating rule 3 is
// not an optimisation, and rule 5 refusing a name that would otherwise resolve is not a heuristic.
import { describe, expect, test } from "bun:test";

import { createRuntimeDirectory } from "../../src/messaging/index.ts";
import type { RuntimeDirectoryEntry } from "../../src/seams/directory-store.ts";
import { childEntry, createBed, sessionAddress, sessionEntry } from "./support.ts";

function directoryOver(bed: ReturnType<typeof createBed>) {
  return createRuntimeDirectory(bed.context, { now: bed.clock.now });
}

async function seed(bed: ReturnType<typeof createBed>, entries: RuntimeDirectoryEntry[]): Promise<void> {
  const directory = directoryOver(bed);
  for (const entry of entries) await directory.record(entry);
}

describe("resolution: WS-10 §11's rules, in order", () => {
  test("rule 1 — an exact canonical address wins, and the row's DECLARED runtime kind comes back with it", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("caller"));
    // A `claude-agent` row. The serialized address carries no runtime kind at all (WS-10 §11), so this
    // is the assertion that the DIRECTORY is what answers the question the adapter choice depends on.
    await directory.record(sessionEntry("official-one", { runtimeKind: "claude-agent", displayName: "reviewer" }));

    const resolved = await directory.resolve("session:official-one", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.entry.runtimeKind).toBe("claude-agent");
    expect(resolved.entry.address).toBe("session:official-one");
  });

  test("rule 1 — a canonical CHILD address of another session is not reachable at all (the owning-parent fence)", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("mine"), sessionEntry("theirs"), childEntry("theirs", "c1", { displayName: "helper" })]);
    const directory = directoryOver(bed);

    const resolved = await directory.resolve("agent:theirs:c1", { from: sessionAddress("mine") });
    expect(resolved.kind).toBe("not-found");
    if (resolved.kind !== "not-found") return;
    expect(resolved.reason).toContain("not reachable from this session");

    // …and it IS reachable from its own parent, which is what makes the refusal a fence rather than a bug.
    const own = await directory.resolve("agent:theirs:c1", { from: sessionAddress("theirs") });
    expect(own.kind).toBe("resolved");
  });

  test("rule 2 — a stable child id beats a display name, even when a peer session owns that name", async () => {
    const bed = createBed();
    // The child's ID is the string a peer session has taken as its NAME. Rule 2 says the child wins.
    await seed(bed, [sessionEntry("parent"), sessionEntry("other", { displayName: "scout" }), childEntry("parent", "scout")]);
    const directory = directoryOver(bed);

    const resolved = await directory.resolve("scout", { from: sessionAddress("parent") });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.entry.address).toBe("agent:parent:scout");
  });

  test("rule 3 — a display name resolves only when exactly one eligible object owns it", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("caller"), sessionEntry("peer", { displayName: "reviewer" })]);
    const directory = directoryOver(bed);

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.entry.address).toBe("session:peer");
  });

  test("rule 4 — ambiguity RETURNS CANDIDATES rather than choosing, and the candidates are directory rows", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("caller"), sessionEntry("peer-a", { displayName: "reviewer", mode: "dispatch" }), childEntry("caller", "c1", { displayName: "reviewer" })]);
    const directory = directoryOver(bed);

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind !== "ambiguous") return;
    expect(resolved.candidates.map((candidate) => candidate.address).sort()).toEqual(["agent:caller:c1", "session:peer-a"]);
    // The candidate carries the ENTRY's own mode, not a rendering of a `ChildLike`'s placeholder
    // permission mode — the row a caller is shown is the durable record.
    expect(resolved.candidates.find((candidate) => candidate.address === "session:peer-a")?.mode).toBe("dispatch");
  });

  test("rule 5 — a name used by more than one object is refused as STALE, even while exactly one is live", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("caller"));
    await directory.record(childEntry("caller", "c1", { displayName: "scout" }));
    // The first scout finishes and is forgotten; a second child takes the same name.
    await directory.record(childEntry("caller", "c1", { displayName: "scout", status: "exited" }));
    await directory.forget("agent:caller:c1");
    await directory.record(childEntry("caller", "c2", { displayName: "scout" }));

    const resolved = await directory.resolve("scout", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("stale-name");
    if (resolved.kind !== "stale-name") return;
    expect(resolved.reason).toContain("more than one");
    // The live one is still reachable — CANONICALLY, which is exactly what rule 5's "unless addressed
    // canonically" means.
    const canonical = await directory.resolve("agent:caller:c2", { from: sessionAddress("caller") });
    expect(canonical.kind).toBe("resolved");
  });

  test("rule 5 — a name whose only holder is gone is STALE, not not-found (the lease outlives the row)", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("caller"));
    await directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    await directory.forget("session:peer");

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("stale-name");
    if (resolved.kind !== "stale-name") return;
    expect(resolved.reason).toContain("no longer reachable");

    // A name nobody ever held is a different answer, and that difference is the whole point of
    // keeping released leases.
    const unknown = await directory.resolve("nobody", { from: sessionAddress("caller") });
    expect(unknown.kind).toBe("not-found");
  });

  test("rule 6 — a `to` that breaks WS-10 §10.1's own constraints never reaches resolution", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("caller")]);
    const directory = directoryOver(bed);
    for (const bad of ["*", "a\nb", "x".repeat(301), ""]) {
      const resolved = await directory.resolve(bad, { from: sessionAddress("caller") });
      expect(resolved.kind).toBe("not-found");
    }
  });

  test("an EXITED session resolves by address but never appears in a listing (WS-10 §10.2)", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("caller"), sessionEntry("gone", { status: "exited", displayName: "yesterday" }), childEntry("caller", "c1", { status: "exited" })]);
    const directory = directoryOver(bed);

    const resolved = await directory.resolve("session:gone", { from: sessionAddress("caller") });
    expect(resolved.kind).toBe("resolved");

    const snapshot = await directory.snapshot({ owningSessionId: "caller" });
    expect(snapshot.listable.map((row) => row.address)).not.toContain("session:gone");
    // A terminal CHILD is still listed: it is resumable through its owner, which is not the same thing
    // as "an exited transcript on disk".
    expect(snapshot.listable.map((row) => row.address)).toContain("agent:caller:c1");
    expect(snapshot.resolvable.map((row) => row.address)).toContain("session:gone");
  });

  test("an ARCHIVED session is neither listed nor resolvable", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("caller"), sessionEntry("filed", { status: "archived", displayName: "archive" })]);
    const directory = directoryOver(bed);
    expect((await directory.resolve("session:filed", { from: sessionAddress("caller") })).kind).toBe("not-found");
  });
});

describe("rule 5 is scoped to the CALLER'S CONVERSATION (review r1, M2)", () => {
  // WS-10 §11 rule 5 and WS-15 §6.1 rule 5 both say "a name previously used by a different child IN
  // THE SAME CONVERSATION". The directory-level preflight this lane adds — which exists to remember a
  // name across a restart or after a `forget()`, which the shared core cannot — was reading the whole
  // lease table, with two harms: a live unique name in ANOTHER conversation was refused, and the
  // refusal text and candidate rows carried another conversation's canonical child address to the
  // model, in a shape that told a hit from a miss.

  test("B1 — one conversation's exited child does not poison another conversation's live unique name", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(childEntry("a", "c1", { displayName: "reviewer" }));
    await directory.record(childEntry("a", "c1", { displayName: "reviewer", status: "exited" }));
    await directory.record(sessionEntry("b"));
    await directory.record(sessionEntry("r", { displayName: "reviewer" })); // B's own live, unique holder

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("b") });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.entry.address).toBe("session:r");
  });

  test("B2 — the same after the foreign child is FORGOTTEN: no refusal, and no foreign address in any answer", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(childEntry("a", "c1", { displayName: "reviewer" }));
    await directory.forget("agent:a:c1");
    await directory.record(sessionEntry("b"));

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("b") });
    // Nothing of A's is reachable OR nameable from B, so the honest answer is "no such name" — the
    // same answer a name nobody ever used gets.
    expect(resolved.kind).toBe("not-found");
    expect(JSON.stringify(resolved)).not.toContain("agent:a:c1");

    // …and A's OWN caller still gets rule 5's refusal, which is the half that must not be lost.
    const fromOwner = await directory.resolve("reviewer", { from: sessionAddress("a") });
    expect(fromOwner.kind).toBe("stale-name");
  });

  test("B4 — a LIVE foreign child's name is not an oracle: a hit and a miss are the same answer", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(childEntry("a", "c1", { displayName: "kid" })); // live, lease never released
    await directory.record(sessionEntry("b"));

    const hit = await directory.resolve("kid", { from: sessionAddress("b") });
    const miss = await directory.resolve("nosuchname", { from: sessionAddress("b") });
    expect(hit.kind).toBe("not-found");
    expect(miss.kind).toBe("not-found");
    if (hit.kind !== "not-found" || miss.kind !== "not-found") return;
    // The two answers differ only in the name the caller itself supplied — nothing about A leaks.
    expect(hit.reason.replace("kid", "NAME")).toBe(miss.reason.replace("nosuchname", "NAME"));
  });

  test("B3 (control) — reuse INSIDE one conversation is still refused as stale", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(childEntry("a", "c1", { displayName: "scout" }));
    await directory.forget("agent:a:c1");
    await directory.record(childEntry("a", "c2", { displayName: "scout" }));

    const resolved = await directory.resolve("scout", { from: sessionAddress("a") });
    expect(resolved.kind).toBe("stale-name");
    if (resolved.kind !== "stale-name") return;
    expect(resolved.reason).toContain("more than one");
  });

  test("a SESSION name stays global — a session that is gone is still remembered for every caller", async () => {
    // A top-level session's name is global by construction (every caller resolves session names from
    // the same peer set), so remembering that one is gone discloses nothing a listing would not — and
    // "that name referred to something that has since exited" is a better answer than "no such agent".
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    await directory.forget("session:peer");
    expect((await directory.resolve("reviewer", { from: sessionAddress("a") })).kind).toBe("stale-name");
  });

  test("NEW-7 — an ARCHIVED holder's address is not echoed at all: the name answers as unknown", async () => {
    // The session-lease exception rests on "remembering that a session is gone discloses nothing plain
    // resolution would not" — which is exactly untrue of an ARCHIVED session: canonical addressing
    // refuses it outright and no listing shows it, so its address would leak only through this reason.
    // The stated cost: an archived object's old name now answers "no such agent".
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(sessionEntry("filed", { displayName: "archivist" }));
    await directory.record(sessionEntry("filed", { displayName: "archivist", status: "archived" }));

    const byName = await directory.resolve("archivist", { from: sessionAddress("a") });
    expect(byName.kind).toBe("not-found");
    expect(JSON.stringify(byName)).not.toContain("session:filed");
    // …and canonical addressing already refused it, which is the answer this one now matches.
    expect((await directory.resolve("session:filed", { from: sessionAddress("a") })).kind).toBe("not-found");
  });

  test("NEW-6 — a lease whose address does not parse is dropped, never quoted back", async () => {
    // `syncLeases` always writes `entry.address`, so this is unreachable through this package — but a
    // host writing the store directly could put anything there, and the reason text reaches the model.
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await bed.store.names.claim({ name: "ghost", address: "not-an-address", generation: 1, claimedAt: "t" });

    const resolved = await directory.resolve("ghost", { from: sessionAddress("a") });
    expect(resolved.kind).toBe("not-found");
    expect(JSON.stringify(resolved)).not.toContain("not-an-address");
  });

  test("a candidate row is rendered only for a holder the caller can still address", async () => {
    // The remembered holder has been FORGOTTEN, so there is no row to render: the reason names the
    // address (the caller asked about that name, and it is the caller's own conversation) and the
    // candidate list is empty rather than carrying a row nobody can address.
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(sessionEntry("peer", { displayName: "reviewer" }));
    await directory.forget("session:peer");

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("a") });
    expect(resolved.kind).toBe("stale-name");
    if (resolved.kind !== "stale-name") return;
    expect(resolved.reason).toContain("session:peer");
    expect(resolved.candidates).toEqual([]);
  });

  test("an ambiguous answer's candidates never include a row the caller could not address", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("a"));
    await directory.record(childEntry("a", "c1", { displayName: "reviewer" }));
    await directory.record(sessionEntry("b"));
    await directory.record(sessionEntry("r1", { displayName: "reviewer" }));
    await directory.record(sessionEntry("r2", { displayName: "reviewer" }));

    const resolved = await directory.resolve("reviewer", { from: sessionAddress("b") });
    expect(resolved.kind).toBe("ambiguous");
    if (resolved.kind !== "ambiguous") return;
    expect(resolved.candidates.map((row) => row.address).sort()).toEqual(["session:r1", "session:r2"]);
  });
});

describe("record(): the row two lanes write", () => {
  test("recording a status change PRESERVES the spawn proxy's configDir and process identity", async () => {
    // THE CROSS-LANE HAZARD, pinned: Lane A's supervised spawn proxy records WS-14 §6 rule 2's
    // observed CLAUDE_CONFIG_DIR and §9's pid+start identity onto this same row THROUGH THE STORE,
    // whose `upsert` is a full replace. A host recording a status change builds its entry from what it
    // knows — never those two fields — so without the merge they would vanish, silently, and WS-15
    // §6.4 step 2 would have nothing to revalidate.
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("official", { runtimeKind: "claude-agent" }));

    // …the shape Lane A's `directoryRecordSink` writes: read-modify-write through the store.
    const existing = (await bed.store.load()).find((entry) => entry.address === "session:official");
    expect(existing).toBeDefined();
    await bed.store.upsert({ ...(existing as RuntimeDirectoryEntry), configDir: "/tmp/claude-resume-abc", processIdentity: { pid: 4242, startedAt: "2026-09-09T00:00:00.000Z" } });

    // …and now the host records a status change, knowing nothing about either field.
    await directory.record(sessionEntry("official", { runtimeKind: "claude-agent", status: "idle" }));

    const merged = await directory.get("session:official");
    expect(merged?.status).toBe("idle");
    expect(merged?.configDir).toBe("/tmp/claude-resume-abc");
    expect(merged?.processIdentity).toEqual({ pid: 4242, startedAt: "2026-09-09T00:00:00.000Z" });
  });

  test("the merge carries EXACTLY the two adapter-owned fields — a caller's own absent field still clears", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("s", { displayName: "named", backendSessionId: "b-1", configDir: "/tmp/root" }));
    await directory.record(sessionEntry("s"));

    const merged = await directory.get("session:s");
    expect(merged?.configDir).toBe("/tmp/root"); // adapter-owned: carried
    expect(merged?.displayName).toBeUndefined(); // caller-owned: cleared, so a rename is possible
    expect(merged?.backendSessionId).toBeUndefined();
  });

  test("a rule-5 clear still works: writing the row through the STORE without the field removes it", async () => {
    // Lane A's own `clear()` (WS-14 §6 rule 5, "clear the recorded root only after verified cleanup")
    // goes through the store rather than through this door, so the merge cannot make a root permanent.
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("s", { configDir: "/tmp/root" }));
    const { configDir: _dropped, ...rest } = (await directory.get("session:s")) as RuntimeDirectoryEntry;
    await bed.store.upsert(rest as RuntimeDirectoryEntry);
    expect((await directory.get("session:s"))?.configDir).toBeUndefined();
  });

  test("list(scope) narrows to one parent's children", async () => {
    const bed = createBed();
    await seed(bed, [sessionEntry("p1"), sessionEntry("p2"), childEntry("p1", "c1"), childEntry("p2", "c2")]);
    const directory = directoryOver(bed);
    expect((await directory.list({ parent: "session:p1" })).map((entry) => entry.address)).toEqual(["agent:p1:c1"]);
    expect((await directory.list()).length).toBe(4);
  });

  test("a name lease follows a rename, and the old name goes stale rather than resolving to the new object", async () => {
    const bed = createBed();
    const directory = directoryOver(bed);
    await directory.record(sessionEntry("caller"));
    await directory.record(sessionEntry("peer", { displayName: "old" }));
    await directory.record(sessionEntry("peer", { displayName: "new" }));

    expect((await directory.resolve("new", { from: sessionAddress("caller") })).kind).toBe("resolved");
    const stale = await directory.resolve("old", { from: sessionAddress("caller") });
    expect(stale.kind).toBe("stale-name");
  });
});
