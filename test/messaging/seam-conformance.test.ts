// THE SPINE'S PROMISE, KEPT FROM THIS LANE'S OWN DIRECTORY (review r1, n4).
//
// The spine's promise to four parallel lanes is "your signature will not move"; the promise back is
// "nothing pretends to work". `test/spine/seams.test.ts` holds the second half for the STUBS, and it
// is spine-owned — the brief's grant to this lane is its own `NotImplementedYet("lane-b")` assertion
// and nothing more, so the block that used to live there (a whole added test, importing this lane's
// modules into a spine file) has moved here. `test/spine/seams.test.ts` is now byte-identical to
// `main`, which is what the phase's disjoint-file rule is for.
//
// WHAT IT PROVES, and why it is worth a file: that `createRuntimeMessaging(context)` produces a
// `RuntimeDirectory` and a `GlobalMessaging` assignable to the PINNED interfaces over the exact
// `SeamContextWithDirectory` the spine hands its stub factories — so the wiring diff still open
// against `src/sdk.ts` is mechanical rather than hopeful — and that with nothing attached the answers
// are honest (an empty listing, an `unknown` class, a `not_found` delivery) rather than throws.
import { describe, expect, test } from "bun:test";

import { createRuntimeMessaging } from "../../src/messaging/index.ts";
import type { SeamContextWithDirectory } from "../../src/seams/context.ts";
import type { RuntimeDirectory } from "../../src/seams/directory.ts";
import type { GlobalMessaging } from "../../src/seams/global-messaging.ts";
import { createBed, sessionAddress, sessionEntry } from "./support.ts";

describe("Lane B's factories satisfy the spine's seams", () => {
  test("the real factories answer over the spine's own context, and answer honestly when nothing is attached", async () => {
    const bed = createBed();
    const { directory, messaging } = createRuntimeMessaging(bed.context, { directory: { now: bed.clock.now }, messaging: { now: bed.clock.now } });

    // The seam types, structurally: assigning the concrete handles to the pinned interfaces is exactly
    // what the pending one-line wiring in `src/sdk.ts` will do.
    const asDirectory: RuntimeDirectory = directory;
    const asMessaging: GlobalMessaging = messaging;
    const context: SeamContextWithDirectory = { ...bed.context, directory: asDirectory };
    expect(context.directory).toBe(asDirectory);

    await asDirectory.record(sessionEntry("x"));
    expect((await asDirectory.list()).map((row) => row.address)).toEqual(["session:x"]);
    expect((await asDirectory.get("session:x"))?.runtimeKind).toBe("winter-agent");
    expect((await asDirectory.resolve("session:x", { from: sessionAddress("y") })).kind).toBe("resolved");
    expect((await asDirectory.recover()).steps.length).toBe(7);

    expect(await asMessaging.listReachable({ from: sessionAddress("x") })).toEqual([]);
    expect(await asMessaging.senderPermissionClass(sessionAddress("x"))).toBe("unknown");
    const outcome = await asMessaging.send({ from: sessionAddress("x"), to: "nobody", body: "hi", originToolCallId: "t1" });
    expect(outcome.status).toBe("not_found");
    await asDirectory.forget("session:x");
  });

  test("n1: the seam survives DESTRUCTURING — a host may write `const { record } = sdk.directory`", async () => {
    // `RuntimeDirectory` is published as `RuntimeSdk.directory`, so this is an ordinary thing for a
    // host to write. It threw, because `record` reached its collaborator through `this`.
    const bed = createBed();
    const { directory } = createRuntimeMessaging(bed.context, { directory: { now: bed.clock.now }, messaging: { now: bed.clock.now } });
    const { record, forget, get, list, resolve, recover } = directory;

    await record(sessionEntry("x", { displayName: "solo" }));
    expect((await get("session:x"))?.displayName).toBe("solo");
    expect((await list()).length).toBe(1);
    expect((await resolve("solo", { from: sessionAddress("y") })).kind).toBe("resolved");
    expect((await recover()).steps.length).toBe(7);
    await forget("session:x");
    expect(await get("session:x")).toBeUndefined();
  });
});
