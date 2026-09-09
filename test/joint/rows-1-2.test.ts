// WS-17 ROWS 1 AND 2, WHOLE-ROW — the halves each lane proved separately, joined.
//
// Row 1 is "native `SendMessage` aliased to the canonical MCP tool, delivered, with the outcome the
// model sees"; row 2 is the same for `ListAgents` plus the canonical duplicates' visibility. Lane A
// proved the ALIAS reaches a handler (with a recording double as the handler); Lane B proved the
// HANDLER routes and delivers (with a scripted caller as the model). Neither could prove the join,
// and the join is where a schema mismatch, a caller-identity mistake or an outcome-rendering
// difference would live.
//
// THE ONE THING THIS BED STILL DOUBLES is the WINTER target session, and it is not a shortcut: the
// Winter session runtime lives in the other repository, so a live one cannot exist here. What stands
// in for it is the same `AttachedWinterSession` writer a host registers, which is the actual seam.
import { afterAll, describe, expect, test } from "bun:test";
import { WINTER_BRAND, mcpToolName } from "@yanlinglabs/winter-agent-sdk";

import { officialToolAliases } from "../../src/official/aliases.ts";
import { advertisedToolNames, cleanupHermetic, officialRuntimeBed, toolResults } from "../official/support.ts";
import { JOINT_TIMEOUT, runJointSession } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("WS-17 rows 1-2, WHOLE-ROW: the model's own SendMessage through the real router", () => {
  afterAll(cleanupHermetic);

  test(
    "row 1 — a model-emitted SendMessage is delivered by the REAL router, and the router's typed outcome is what the model sees",
    async () => {
      const result = await runJointSession({
        turns: [{ toolUses: [{ id: "toolu_joint1", name: "SendMessage", input: { to: "reviewer", message: "ping from the model", summary: "a ping" } }] }, { text: "sent" }],
        peers: [{ id: "peer", displayName: "reviewer" }],
      });

      // THE FULL PATH RAN: the model emitted the NATIVE name, the runtime's own alias resolved it to
      // the canonical MCP tool, and Lane B's handler answered — which is only observable at the far
      // end, in what the target session was handed.
      expect(result.pushed).toHaveLength(1);
      expect(result.pushed[0]).toContain('<agent-message from="session:joint"');
      expect(result.pushed[0]).toContain("ping from the model");
      expect(result.pushed[0]).toContain("<summary>a ping</summary>");
      // WS-10 §13's class travels with it, from the DECLARED class of a real official sender.
      expect(result.pushed[0]).toContain('sender-permission-class="prompts"');

      const row1 = toolResults(result.record).find((entry) => entry.tool_use_id === "toolu_joint1");
      expect(JSON.stringify(row1?.content)).toContain("delivered");
      expect(row1?.is_error).toBeUndefined();

      // ITEM 15, PROVEN AT THE JOIN: the caller was bound with NO tool-use id (that is how the
      // official branch registers it), so a message id carrying the model's own id can only have come
      // from the vendor's `extra`. This is WS-10 §12's retry key, present on this branch for real.
      expect(JSON.stringify(row1?.content)).toContain("msg:joint:toolu_joint1");

      // …and nothing but the loopback fake was reached.
      expect(new Set(result.record.paths)).toEqual(new Set(["/api/hello", "/v1/messages"]));
      expect(result.messages.at(-1)?.type).toBe("result");
    },
    JOINT_TIMEOUT,
  );

  test(
    "row 1 — a refusal is rendered as a classified failure the model can act on, not as a crash",
    async () => {
      // The other half of "the outcome the model sees": an unresolvable target. The row is about the
      // outcome being CLASSIFIED and model-facing, which only the join can show.
      const result = await runJointSession({
        turns: [{ toolUses: [{ id: "toolu_joint_miss", name: "SendMessage", input: { to: "nobody-by-that-name", message: "hello?" } }] }, { text: "acknowledged" }],
        peers: [{ id: "peer", displayName: "reviewer" }],
      });
      const row = toolResults(result.record).find((entry) => entry.tool_use_id === "toolu_joint_miss");
      expect(row?.is_error).toBe(true);
      expect(JSON.stringify(row?.content)).toContain("not_found");
      // Nothing was delivered anywhere.
      expect(result.pushed).toHaveLength(0);
      // The session still completed: a classified failure is an answer, not a broken turn.
      expect(result.messages.at(-1)?.type).toBe("result");
    },
    JOINT_TIMEOUT,
  );

  test(
    "row 2 — a model-emitted ListAgents renders the REAL directory, and both canonical twins are advertised",
    async () => {
      const result = await runJointSession({
        turns: [{ toolUses: [{ id: "toolu_joint2", name: "ListAgents", input: {} }] }, { text: "listed" }],
        peers: [{ id: "peer", displayName: "reviewer" }],
      });

      const row2 = toolResults(result.record).find((entry) => entry.tool_use_id === "toolu_joint2");
      const listing = JSON.stringify(row2?.content);
      // NEW-13's rule at the join: the row the model is SHOWN is one it can address — a canonical
      // address, which the directory's door now refuses anything else at.
      expect(listing).toContain("reviewer (session:peer)");
      expect(listing).toContain("[session/winter-agent]");
      // …and the caller is NOT in its own listing (`listReachable` drops the sender's own row), which
      // is what "reachable FROM here" means and is why the reviewer's earlier plant — taken before
      // NEW-13 — showed a second, unaddressable row where this one shows none.
      expect(listing).not.toContain("session:joint");

      const advertised = advertisedToolNames(result.record);
      // Both the native name and the canonical twin are on the wire — WS-17 row 2's own measurement,
      // and the reason §7 says the deferral is the runtime's decision rather than ours.
      expect(advertised).toContain("SendMessage");
      expect(advertised).toContain("ListAgents");
      expect(advertised).toContain(mcpToolName(WINTER_BRAND, "send_message"));
      expect(advertised).toContain(mcpToolName(WINTER_BRAND, "list_agents"));
      // The alias map the runtime was handed is the BRAND's own, never a literal.
      expect(officialToolAliases(WINTER_BRAND)).toEqual({
        SendMessage: mcpToolName(WINTER_BRAND, "send_message"),
        ListAgents: mcpToolName(WINTER_BRAND, "list_agents"),
      });
    },
    JOINT_TIMEOUT,
  );

  test(
    "the REVERSE direction — a peer's message reaches the live official session's own row, through the router",
    async () => {
      // Row 1's other direction. The official branch has no messaging surface of any kind (its `Query`
      // declares none), so the mechanism is an input-stream push into a handle a host attaches — and
      // what this proves is that the ROUTER picks that path for a real official row, with the real
      // session live, rather than refusing or guessing.
      const delivered: string[] = [];
      const result = await runJointSession({
        turns: [{ text: "ok" }],
        peers: [{ id: "peer", displayName: "reviewer" }],
        during: async ({ messaging }) => {
          messaging.attachOfficialSession("session:joint", {
            status: () => "idle",
            push: (text: string) => {
              delivered.push(text);
            },
          });
          const outcome = await messaging.send({
            from: { objectKind: "session", runtimeKind: "winter-agent", winterSessionId: "peer" },
            to: "session:joint",
            body: "a reply from the Winter side",
            originToolCallId: "toolu_reverse",
          });
          // NOT HELD: the official receiver's class is declared, which is the only way it can be known
          // on this branch (F-3 gave that hook a constructor door; here it is the bed's own).
          expect(outcome.status).not.toBe("held");
        },
      });

      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('<agent-message from="session:peer"');
      expect(delivered[0]).toContain("a reply from the Winter side");
      expect(result.messages.at(-1)?.type).toBe("result");
    },
    JOINT_TIMEOUT,
  );
});
