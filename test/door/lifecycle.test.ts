// RE-REVIEW, N-2 — A HOST'S `break` IS AN END, AND THE ROW SAYS SO.
//
// `for await (const m of query) { if (m.type === "result") break; }` is the shape the vendor's own
// examples use, and it calls the deferred handle's generator `return()` — which ran neither the code
// after the loop nor the `catch`. So I-3(a)/(b) re-opened for exactly the idiomatic stop: the row
// stayed `running`, a streaming session stayed attached and listed, and a delivery into that stale
// handle blocked on the input stream's backpressure instead of answering. Both shapes are here
// because the re-review measured both.
import { afterAll, describe, expect, test } from "bun:test";

import { cleanupHermetic, officialRuntimeBed } from "../official/support.ts";
import { envelope, sessionEntry } from "../messaging/support.ts";
import { DOOR_TIMEOUT, withDoorBed } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("the door's official leg — ending the loop early", () => {
  afterAll(cleanupHermetic);

  test(
    "breaking out of the loop ends the session — string prompt",
    async () => {
      await withDoorBed({ turns: [{ text: "stopped early" }], sessionId: "door-break-str" }, async (bed) => {
        const from = { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "someone-else" } as const;
        for await (const message of bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }) as AsyncIterable<{ type: string }>) {
          if (message.type === "result") break;
        }
        expect((await bed.sdk.directory.get(bed.address))?.status).toBe("exited");
        expect((await bed.sdk.messaging.listReachable({ from })).find((row) => row.address === bed.address)).toBeUndefined();
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "breaking out of the loop ends the session — streaming prompt, with its input still open",
    async () => {
      await withDoorBed({ turns: [{ text: "stopped early" }], sessionId: "door-break-stream" }, async (bed) => {
        await bed.sdk.directory.record(sessionEntry("break-sender"));
        const from = { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "break-sender" } as const;
        // THE INPUT IS STILL OPEN — this generator never returns — so nothing but the `break` can end
        // the session. Before N-2 the handle stayed attached and a delivery blocked on backpressure.
        const turns = (async function* () {
          yield "start";
          await new Promise<void>(() => undefined);
        })();
        for await (const message of bed.sdk.query({ prompt: turns, options: bed.officialOptions() }) as AsyncIterable<{ type: string }>) {
          if (message.type === "result") break;
        }
        expect((await bed.sdk.directory.get(bed.address))?.status).toBe("exited");
        expect((await bed.sdk.messaging.listReachable({ from })).find((row) => row.address === bed.address)).toBeUndefined();
        // DETACHED: the delivery answers instead of blocking, and it answers honestly.
        const outcome = await bed.sdk.messaging.deliver(
          envelope({
            messageId: "after-break-1",
            from,
            to: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: bed.sessionId },
            body: "anyone home?",
            createdAt: Date.now(),
            expiresAt: Date.now() + 600_000,
          }),
        );
        expect(outcome.status).toBe("unavailable");
      });
    },
    DOOR_TIMEOUT,
  );
});
