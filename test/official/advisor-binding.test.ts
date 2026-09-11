// R-8-1(3)(b) — WINTER'S ADVISOR, BOUND UNDER CLAUDE'S OWN NAME, OVER THIS SESSION'S OWN TRANSCRIPT.
//
// The ruling says Winter's default tools are pulled by the ROUTER and bound under the official
// runtime's built-in names, `advisor` among them. Three things have to be true at once for that to be
// more than a registration, and only a live session can show them together:
//
//   1. the standing server's advisor is ADVERTISED to the model, under the canonical name the alias
//      resolves to (`mcp__<brand>__advisor`);
//   2. what it reviews is THIS SESSION'S transcript — read by `SessionKey` from the ONE shared store
//      both branches write, not a fresh read of somebody's home directory;
//   3. what the model is handed back is WS-06 §4's shape, `{ advice, model }`, produced by the
//      reviewer the HOST resolved (reviewer resolution is the runtime's provider-layer concern, D30 —
//      the router never picks a model).
//
// THE KEY IS PINNED BY PLANTING. The session's store key is `{ projectKey, sessionId: <backend id> }`,
// and the backend id is the vendor's to allocate — which is why the source is lazy (interim review
// I-1). This test fixes it instead: `options.sessionId` tells the runtime which id to use, the
// transcript is planted under exactly that key BEFORE the query, and the reviewer's own input is what
// proves the advisor read it. A key that was off by either half would hand the reviewer an empty
// transcript, and the planted line is unmistakable.
//
// MIRROR LAG IS NOT MEASURED HERE, DELIBERATELY. The official branch's own entries reach the shared
// store in ~100 ms batches, so an advisor called mid-turn sees the transcript up to the last landed
// batch. That is the shipped behaviour; pinning a race would make this test a stopwatch.
import { afterAll, describe, expect, test } from "bun:test";
import { mcpToolName, type SessionStore } from "@yanlinglabs/winter-agent-sdk";

import { runtimeSdkInternals } from "../../src/index.ts";
import { cleanupHermetic, officialRuntimeBed, toolResults } from "../official/support.ts";
import { DOOR_TIMEOUT, drain, withDoorBed } from "../door/support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

/** A uuid the vendor will accept as the session's own id, so the store key is known before the launch. */
const BACKEND_SESSION_ID = "00000000-0000-4000-8000-0000000ad510";
const PLANTED = "PLANTED: the session's own transcript, and nobody else's";

describeRuntime("R-8-1(3) — the standing advisor, through the door, against the pinned runtime", () => {
  afterAll(cleanupHermetic);

  test(
    "it is advertised, it reviews THIS session's transcript by SessionKey, and the model gets { advice, model }",
    async () => {
      await withDoorBed(
        { turns: [{ toolUses: [{ id: "toolu_advisor_binding", name: "advisor", input: {} }] }, { text: "advised" }], sessionId: "advisor-binding" },
        async (bed) => {
          const seen: Array<{ role: string; content: string }> = [];
          const sdk = bed.sdkWith({
            advisor: {
              // THE HOST RESOLVES THE REVIEWER (D30). The router has no provider layer and never picks
              // a model; a fake one here is the whole of what a host supplies.
              resolveReviewer: () => ({
                provider: {
                  generate: async (input: { messages: ReadonlyArray<{ role: string; content: string }> }) => {
                    seen.push(...input.messages);
                    return { kind: "text", text: "the reviewer's answer" };
                  },
                },
                model: "reviewer-model",
              }),
            },
          });

          // THE PLANT, under the exact key the advisor must derive: this session's project key and the
          // backend id the runtime is about to be told to use.
          // Through the internals, and cast: the SEAM type (`HandoffBarrier`) declares only the three
          // handoff doors, while the concrete barrier is what owns Lane C's one shared store — the same
          // object `door.ts` reaches through `deps.shared()`. A test that built its own store would be
          // planting into a different file and proving nothing.
          const shared = (runtimeSdkInternals(sdk)?.barrier as unknown as { shared: { store: SessionStore } } | undefined)?.shared;
          expect(shared).toBeDefined();
          await shared!.store.append({ projectKey: bed.projectKey, sessionId: BACKEND_SESSION_ID }, [
            { type: "user", message: { content: [{ type: "text", text: PLANTED }] } },
          ]);

          const options = bed.officialOptions() as Record<string, unknown>;
          options["sessionId"] = BACKEND_SESSION_ID;
          const messages = await drain(sdk.query({ prompt: "review this", options }));

          // (1) ADVERTISED, under the canonical name the bare `advisor` alias resolves to.
          const init = messages.find((message) => message.type === "system" && message.subtype === "init") as { tools?: unknown[] } | undefined;
          expect((init?.tools ?? []).map(String)).toContain(mcpToolName(bed.sdk.brand, "advisor"));

          // (2) IT READ THIS SESSION'S TRANSCRIPT — the planted line reached the reviewer, so both
          //     halves of the `SessionKey` were right.
          expect(seen.some((message) => message.content.includes(PLANTED))).toBe(true);

          // (3) …and the model was handed WS-06 §4's own shape, from the host's reviewer.
          const row = toolResults(bed.record).find((entry) => entry.tool_use_id === "toolu_advisor_binding");
          expect(row?.is_error).toBeUndefined();
          const payload = JSON.parse(String((row?.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? "{}")) as Record<string, unknown>;
          expect(payload).toEqual({ advice: "the reviewer's answer", model: "reviewer-model" });
          expect(messages.at(-1)?.type).toBe("result");
        },
      );
    },
    DOOR_TIMEOUT,
  );
});
