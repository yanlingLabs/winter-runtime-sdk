// WS-18 W18-8 / P10b-6 R7 — THE RESUME-VS-FRESH DECISION LIVES IN THE DOOR, NOT THE CALLER.
//
// `door.ts`'s `start()` no longer trusts `options.resume` to mean "resume": it reads the canonical
// transcript for whatever backend id the caller named (`options.resume` or `options.sessionId`) and
// opens with `resume` (no `sessionId`) when it already holds at least one conversational entry, else
// `sessionId` (no `resume`) for a genuinely empty one. Verified against the pinned runtime, over the
// loopback fake `test/door/support.ts` already wires every door test through.
import { afterAll, describe, expect, test } from "bun:test";
import type { SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { runtimeSdkInternals } from "../../src/index.ts";
import { classifyLocalWriteRoot } from "../../src/official/index.ts";
import { cleanupHermetic, officialRuntimeBed } from "../official/support.ts";
import { DOOR_TIMEOUT, withDoorBed, type DoorBed } from "./support.ts";

/**
 * Drains the query, but reads the directory row's `configDir` the INSTANT `system/init` lands —
 * before the generation ends and the spawn proxy CLEARS it from the row (measured in `test/joint/
 * rows-4-5.test.ts`: "the sink writes configDir/processIdentity at the spawn and the proxy clears
 * them at the exit ... a completed session's row carries neither"). Reading it after `drain()` would
 * therefore always see `undefined`, regardless of which profile the door actually opened with.
 */
async function drainCapturingConfigDir(bed: DoorBed, query: AsyncIterable<unknown>): Promise<{ messages: Array<{ type: string; subtype?: string }>; configDir: string | undefined }> {
  const messages: Array<{ type: string; subtype?: string }> = [];
  let configDir: string | undefined;
  for await (const raw of query) {
    const message = raw as { type: string; subtype?: string };
    messages.push(message);
    if (configDir === undefined && message.type === "system" && message.subtype === "init") {
      const row = (await bed.directoryStore.load()).find((candidate) => candidate.address === bed.address);
      configDir = row?.configDir;
    }
  }
  return { messages, configDir };
}

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("WS-18 W18-8 — the door's own resume-vs-fresh decision", () => {
  afterAll(cleanupHermetic);

  test(
    "a backend id whose canonical transcript already has a conversational entry: the door opens with resume, no sessionId",
    async () => {
      const BACKEND_ID = "00000000-0000-4000-8000-0000000ad700";
      const MARKER = "R7 door-decision resume marker";
      await withDoorBed({ turns: [{ text: "continuing" }], sessionId: "door-resume-decision-a" }, async (bed) => {
        const shared = (runtimeSdkInternals(bed.sdk)?.barrier as unknown as { shared: { store: SessionStore } } | undefined)?.shared;
        expect(shared).toBeDefined();
        await shared!.store.append(
          { projectKey: bed.projectKey, sessionId: BACKEND_ID },
          [
            {
              type: "user",
              uuid: "11111111-0000-4000-8000-0000000ad700",
              parentUuid: null,
              sessionId: BACKEND_ID,
              timestamp: new Date(0).toISOString(),
              cwd: bed.session.cwd,
              version: "0.0.0",
              isSidechain: false,
              message: { role: "user", content: MARKER },
            },
          ],
        );

        const options = bed.officialOptions() as Record<string, unknown>;
        options["sessionId"] = BACKEND_ID;
        const { messages, configDir } = await drainCapturingConfigDir(bed, bed.sdk.query({ prompt: "continue please", options }));

        // RESUMED: the same id comes back, and the seeded turn reached the request.
        const init = messages.find((m) => m.type === "system" && m.subtype === "init") as { session_id?: unknown } | undefined;
        expect(init?.session_id).toBe(BACKEND_ID);
        const mainRequest = bed.record.requests.find((body) => JSON.stringify(body["messages"] ?? []).includes(MARKER));
        expect(mainRequest).toBeDefined();

        // AND THE OBSERVED ROOT CLASSIFIES AS A RESUME STAGING ROOT — not the fresh-spool default.
        expect(configDir).toBeDefined();
        expect(classifyLocalWriteRoot(configDir!).kind).toBe("sdk-resume-staging");
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "a backend id with NO canonical transcript: the door opens with sessionId, fresh-spool — never resume",
    async () => {
      const BACKEND_ID = "00000000-0000-4000-8000-0000000ad701";
      await withDoorBed({ turns: [{ text: "fresh reply" }], sessionId: "door-resume-decision-b" }, async (bed) => {
        // NOTHING planted for this id: the canonical transcript for it does not exist at all.
        const options = bed.officialOptions() as Record<string, unknown>;
        options["sessionId"] = BACKEND_ID;
        const { messages, configDir } = await drainCapturingConfigDir(bed, bed.sdk.query({ prompt: "hello", options }));

        const init = messages.find((m) => m.type === "system" && m.subtype === "init") as { session_id?: unknown } | undefined;
        expect(init?.session_id).toBe(BACKEND_ID);

        expect(configDir).toBeDefined();
        expect(classifyLocalWriteRoot(configDir!).kind).toBe("official-spool");
      });
    },
    DOOR_TIMEOUT,
  );
});
