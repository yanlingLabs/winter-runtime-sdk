// THE JOINT ROWS, THROUGH THE DOOR — WS-17 rows 1/2 and WS13c-SM1/SM2 with `sdk.query()` as the only
// thing that creates an official session.
//
// WHY THIS FILE EXISTS BESIDE `test/joint/`. The joint bed proved Lane A's runtime against Lane B's
// router by calling both lanes' factories itself, which was the right proof for the join it was
// written for. It says nothing about whether the DOOR wires those lanes together — and the door is
// where the wiring now lives: the record sink's address, the messaging attachment, the shared store,
// the persisted selection. If the door composed them wrongly, `test/joint/` would still be green.
//
// SM1 and SM2 are the pairs the whole `RuntimeMessagingAdapter` split exists for (R-7b-1: "a child
// runs on the runtime its OWN slot's family selects at spawn time, independent of the parent's"), and
// their official half is now a session the door opened, with the door's own attached handle behind it.
import { afterAll, describe, expect, test } from "bun:test";
import { mcpToolName } from "@yanlinglabs/winter-agent-sdk";

import { cleanupHermetic, officialRuntimeBed, toolResults } from "../official/support.ts";
import { envelope, sessionEntry, winterWriterHandle } from "../messaging/support.ts";
import { DOOR_TIMEOUT, drain, doorSelection, withDoorBed } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("WS-17 rows 1-2, through the door", () => {
  afterAll(cleanupHermetic);

  test(
    "row 1 — a model-emitted SendMessage from a door-opened session is delivered by the router",
    async () => {
      await withDoorBed({ turns: [{ toolUses: [{ id: "toolu_door1", name: "SendMessage", input: { to: "reviewer", message: "ping through the door", summary: "a ping" } }] }, { text: "sent" }], sessionId: "door-row1" }, async (bed) => {
        // The target: an ordinary Winter session a host attached, which is the real seam.
        await bed.sdk.directory.record(sessionEntry("peer", { displayName: "reviewer" }));
        const writer = winterWriterHandle(() => "idle");
        bed.sdk.messaging.attachWinterSession("session:peer", writer.handle);

        const messages = await drain(bed.sdk.query({ prompt: "do the thing", options: bed.officialOptions() }));

        // THE WHOLE PATH RAN: the model emitted the NATIVE name, the pinned runtime's own `toolAliases`
        // resolved it to the canonical MCP tool, Lane B's handler answered, and the router delivered —
        // observable only at the far end, in what the target was handed.
        expect(writer.pushed).toHaveLength(1);
        expect(writer.pushed[0]).toContain(`<agent-message from="${bed.address}"`);
        expect(writer.pushed[0]).toContain("ping through the door");
        expect(writer.pushed[0]).toContain('sender-permission-class="prompts"');

        const row = toolResults(bed.record).find((entry) => entry.tool_use_id === "toolu_door1");
        expect(JSON.stringify(row?.content)).toContain("delivered");
        expect(row?.is_error).toBeUndefined();
        expect(messages.at(-1)?.type).toBe("result");
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "row 2 — a model-emitted ListAgents renders the directory the DOOR recorded this session into",
    async () => {
      await withDoorBed({ turns: [{ toolUses: [{ id: "toolu_door2", name: "ListAgents", input: {} }] }, { text: "listed" }], sessionId: "door-row2" }, async (bed) => {
        await bed.sdk.directory.record(sessionEntry("peer-2", { displayName: "reviewer" }));
        bed.sdk.messaging.attachWinterSession("session:peer-2", winterWriterHandle(() => "idle").handle);

        await drain(bed.sdk.query({ prompt: "who is out there", options: bed.officialOptions() }));

        const row = toolResults(bed.record).find((entry) => entry.tool_use_id === "toolu_door2");
        expect(row?.is_error).toBeUndefined();
        const rendered = JSON.stringify(row?.content);
        expect(rendered).toContain("session:peer-2");
        expect(rendered).toContain("reviewer");
        // Both canonical twins are advertised beside the native names (row 2's second half).
        const request = bed.record.requests.at(-1) as { tools?: Array<{ name?: string }> } | undefined;
        const advertised = new Set((request?.tools ?? []).map((tool) => String(tool.name)));
        expect(advertised.has(mcpToolName(bed.sdk.brand, "send_message"))).toBe(true);
        expect(advertised.has(mcpToolName(bed.sdk.brand, "list_agents"))).toBe(true);
      });
    },
    DOOR_TIMEOUT,
  );
});

describeRuntime("WS13c-SM1/SM2, through the door", () => {
  afterAll(cleanupHermetic);

  test(
    "SM1 — a Winter parent's claude child is a session the DOOR opened, and a delivery reaches it",
    async () => {
      await withDoorBed({ turns: [{ text: "child alive" }], sessionId: "sonnet-child" }, async (bed) => {
        // The parent lives on the OTHER runtime; only its row exists here (its session runtime is the
        // other repository's).
        await bed.sdk.directory.record(sessionEntry("gpt-parent"));

        // THE CHILD IS OPENED THROUGH THE DOOR, on its own runtime, under its own agent address —
        // R-7b-1's "a child runs on the runtime its OWN slot's family selects, independent of the
        // parent's". A STREAMING prompt, because a delivery into a live session IS a push into its
        // input stream (R-7b-4), and only a session with a stream has one.
        const turns = createTurnGate();
        const options = bed.officialOptions() as Record<string, unknown>;
        const runtime = options["runtime"] as { official: Record<string, unknown> };
        runtime.official["parentSessionId"] = "gpt-parent";
        const query = bed.sdk.query({ prompt: turns.stream, options });

        const iterator = (query as AsyncIterable<{ type: string; subtype?: string }>)[Symbol.asyncIterator]();
        // Pull until the runtime has started and reported itself; the door attaches at the launch.
        let started = await iterator.next();
        while (!started.done && !(started.value.type === "system" && started.value.subtype === "init")) started = await iterator.next();
        expect(started.done).toBe(false);

        const childAddress = "agent:gpt-parent:sonnet-child";
        const row = await bed.sdk.directory.get(childAddress);
        expect(row?.runtimeKind).toBe("claude-agent");
        // `claude-handle`, NOT `claude-child`: it is a session in its own right, not a native subagent
        // inside another official process — the field Lane B's adapter branches on.
        expect(row?.transport).toBe("claude-handle");
        expect(row?.parentAddress).toBe("session:gpt-parent");
        expect(row?.selection.runtimeKind).toBe("claude-agent");

        // The delivery: from the Winter parent to its own claude child, routed by the CHILD's record.
        const outcome = await bed.sdk.messaging.deliver(
          envelope({
            messageId: "sm1-1",
            from: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "gpt-parent" },
            to: { objectKind: "agent", runtimeKind: "claude-agent", winterSessionId: "gpt-parent", parentWinterSessionId: "gpt-parent", childId: "sonnet-child" },
            body: "steer yourself",
            ...live(),
          }),
        );
        expect(["queued", "delivered"]).toContain(outcome.status);
        // THE PUSH REACHED THE RUNTIME'S OWN INPUT STREAM: the door's attached handle wrote into the
        // same stream the caller's prompt feeds, so the runtime asked the model again.
        turns.end();
        const rest = await drainIterator(iterator);
        expect(rest.at(-1)?.type).toBe("result");
        const asked = JSON.stringify(bed.record.requests);
        expect(asked).toContain("steer yourself");
      });
    },
    DOOR_TIMEOUT,
  );

  test(
    "SM2 — the mirror: a door-opened official parent's Winter child is reached through the child's own facet",
    async () => {
      await withDoorBed({ turns: [{ text: "parent alive" }], sessionId: "claude-parent" }, async (bed) => {
        await drain(bed.sdk.query({ prompt: "hi", options: bed.officialOptions() }));

        // The child is a WINTER object; its record is what routes it, not the parent's runtime.
        await bed.sdk.directory.record({
          address: "agent:claude-parent:winter-child",
          parsed: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "claude-parent", parentWinterSessionId: "claude-parent", childId: "winter-child" },
          runtimeKind: "winter-agent",
          objectKind: "agent",
          transport: "winter-session",
          status: "running",
          mode: "code",
          generation: 1,
          selection: { ...doorSelection, runtimeKind: "winter-agent" },
          parentAddress: bed.address,
          capabilities: { message: true, resume: true, notifyWhenIdle: true, reply: true },
          updatedAt: new Date(0).toISOString(),
        });
        const child = winterWriterHandle(() => "running");
        bed.sdk.messaging.attachWinterSession("agent:claude-parent:winter-child", child.handle);

        const outcome = await bed.sdk.messaging.deliver(
          envelope({
            messageId: "sm2-1",
            from: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: "claude-parent" },
            to: { objectKind: "agent", runtimeKind: "winter-agent", winterSessionId: "claude-parent", parentWinterSessionId: "claude-parent", childId: "winter-child" },
            body: "over to you",
            ...live(),
          }),
        );
        expect(["queued", "delivered"]).toContain(outcome.status);
        expect(child.pushed).toHaveLength(1);
        expect(child.pushed[0]).toContain("over to you");
      });
    },
    DOOR_TIMEOUT,
  );
});

/**
 * A LIVE envelope's clock.
 *
 * The messaging fixture's own `createdAt`/`expiresAt` are epoch-0 constants, which suits a bed with an
 * injected clock and expires instantly against a real one — this bed runs a real process, so it runs
 * on a real clock too. WS-10 §12 requires a FINITE ttl; ten minutes is longer than any turn here.
 */
const live = (): { createdAt: number; expiresAt: number } => ({ createdAt: Date.now(), expiresAt: Date.now() + 600_000 });

/** A prompt stream a test drives turn by turn — what a live host's input channel is. */
function createTurnGate(): { stream: AsyncIterable<string>; end(): void } {
  let release: (() => void) | undefined;
  const ended = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    stream: (async function* () {
      yield "start the session";
      await ended;
    })(),
    end: () => release?.(),
  };
}

async function drainIterator(iterator: AsyncIterator<{ type: string; subtype?: string }>): Promise<Array<{ type: string; subtype?: string }>> {
  const seen: Array<{ type: string; subtype?: string }> = [];
  for (let step = await iterator.next(); !step.done; step = await iterator.next()) seen.push(step.value);
  return seen;
}
