// WS-17 ROWS 4 AND 5, the real-runtime halves — two official sessions, and a parent that restarts.
//
// ROW 4 is spool isolation AND the messaging behaviour that rides on it: two official sessions under
// one product home must not share a config dir, must be able to discover and address each other
// through the directory, and must obey WS-10 §13's hold and §14's idle rule at the SAME boundary the
// hermetic tests assert — but with the real runtime on one side of it. Lane A proved the spool half
// with no router; Lane B proved the messaging half with no runtime.
//
// ROW 5 is "an official parent resumed after a restart restores its completed children". The durable
// half is the directory's; the real half is that `resume()` on the pinned artifact really does come
// back on the same backend session, and that the children recorded before the restart are still
// addressable through their owning parent afterwards.
//
// TWO REAL LAUNCHES ARE THE POINT of row 4 and they are not free: each is a real 0.3.250 process.
// They run sequentially, share ONE directory store (which is what makes them peers rather than two
// unrelated tests), and each gets its own `hermeticSession` — so "isolated" is measured against
// directories that really could have collided.
import { afterAll, describe, expect, test } from "bun:test";

import { createInMemoryRuntimeDirectoryStore } from "../../src/index.ts";
import { cleanupHermetic, officialRuntimeBed, toolResults } from "../official/support.ts";
import { childEntry, sessionEntry } from "../messaging/support.ts";
import { JOINT_TIMEOUT, runJointSession } from "./support.ts";

const describeRuntime = officialRuntimeBed() === undefined ? describe.skip : describe;

describeRuntime("WS-17 row 4, real-runtime half: two official sessions under the spool", () => {
  afterAll(cleanupHermetic);

  test(
    "two live official sessions get DIFFERENT config dirs, each under its own spool",
    async () => {
      const store = createInMemoryRuntimeDirectoryStore();
      const alpha = await runJointSession({ turns: [{ text: "alpha ok" }], officialId: "alpha", store });
      const beta = await runJointSession({ turns: [{ text: "beta ok" }], officialId: "beta", store });

      // §1's isolation, OBSERVED rather than configured: the value each child actually got, read off
      // the supervised proxy rather than off the plan (the two agree for a fresh spool, which is
      // exactly why the observed one is the assertion — `configDir` alone would pass without a spawn).
      expect(alpha.observedRoot).toBeDefined();
      expect(beta.observedRoot).toBeDefined();
      expect(alpha.observedRoot).not.toBe(beta.observedRoot);
      for (const result of [alpha, beta]) expect(result.observedRoot).toContain("runtimes/official-agent-spool");
      // Both rows are in ONE directory, which is what makes them peers rather than two unrelated runs.
      const rows = await store.load();
      expect(rows.map((row) => row.address).sort()).toEqual(["session:alpha", "session:beta"]);
      // …AND §6 RULE 2's RECORD IS LIVE-GENERATION STATE, cleared when the generation ends. Measured
      // here rather than assumed the other way round: the sink writes `configDir`/`processIdentity` at
      // the spawn and the proxy CLEARS them at the exit, so a completed session's row carries neither.
      // That is the correct shape — a dead pid and a deleted staging root are worse than no record —
      // and it is why recovery's step 2 marks a previously-live row `unavailable` rather than expecting
      // to find an identity there.
      for (const row of rows) {
        expect({ address: row.address, configDir: row.configDir, identity: row.processIdentity }).toEqual({ address: row.address, configDir: undefined, identity: undefined });
      }
    },
    JOINT_TIMEOUT,
  );

  test(
    "a model in one official session DISCOVERS and ADDRESSES the other, and the delivery lands in it",
    async () => {
      const store = createInMemoryRuntimeDirectoryStore();
      // The peer is a live-enough official row: recorded in the shared directory before the sender runs.
      await store.upsert(sessionEntry("beta", { runtimeKind: "claude-agent", displayName: "beta" }));
      const delivered: string[] = [];

      const alpha = await runJointSession({
        turns: [
          { toolUses: [{ id: "toolu_row4_list", name: "ListAgents", input: {} }] },
          { toolUses: [{ id: "toolu_row4_send", name: "SendMessage", input: { to: "beta", message: "from alpha" } }] },
          { text: "done" },
        ],
        officialId: "alpha",
        store,
        during: async ({ messaging }) => {
          messaging.attachOfficialSession("session:beta", {
            status: () => "idle",
            push: (text: string) => {
              delivered.push(text);
            },
          });
        },
      });

      // DISCOVERY: the model saw the other official session in its own listing.
      const listing = JSON.stringify(toolResults(alpha.record).find((entry) => entry.tool_use_id === "toolu_row4_list")?.content);
      expect(listing).toContain("beta (session:beta)");
      expect(listing).toContain("[session/claude-agent]");
      // DELIVERY: it crossed into the other official session's own input stream.
      const send = toolResults(alpha.record).find((entry) => entry.tool_use_id === "toolu_row4_send");
      expect(JSON.stringify(send?.content)).toContain("delivered");
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('<agent-message from="session:alpha"');
      expect(delivered[0]).toContain("from alpha");
    },
    JOINT_TIMEOUT,
  );

  test(
    "a receiver whose permission class cannot be known is HELD, not delivered — fail-closed, with the real runtime as the sender",
    async () => {
      const store = createInMemoryRuntimeDirectoryStore();
      await store.upsert(sessionEntry("unknown-class", { runtimeKind: "claude-agent", displayName: "unclassified" }));
      const delivered: string[] = [];

      const alpha = await runJointSession({
        turns: [{ toolUses: [{ id: "toolu_row4_hold", name: "SendMessage", input: { to: "unclassified", message: "are you there" } }] }, { text: "held" }],
        officialId: "alpha",
        store,
        during: async ({ messaging }) => {
          // Attached and live — so "held" is about the CLASS, not about reachability.
          messaging.attachOfficialSession("session:unknown-class", {
            status: () => "idle",
            push: (text: string) => {
              delivered.push(text);
            },
          });
        },
        classes: { official: undefined },
      });

      const held = toolResults(alpha.record).find((entry) => entry.tool_use_id === "toolu_row4_hold");
      expect(JSON.stringify(held?.content)).toContain("held");
      expect(JSON.stringify(held?.content)).toContain("class unknown");
      // D2's whole point: nothing was delivered under a guessed class.
      expect(delivered).toHaveLength(0);
    },
    JOINT_TIMEOUT,
  );

  test(
    "notify_when_idle against an OFFICIAL target refuses the whole call — measured, because this branch has no idle signal",
    async () => {
      // WS-10 §14: "adapters without a reliable idle signal MUST refuse the ENTIRE call (including any
      // attached message) so the sender can retry without the flag." The pinned SDK's `Query` exposes
      // no session-status surface, so this branch is one of those adapters — and the row wants that
      // measured against the real runtime rather than asserted about a double.
      const store = createInMemoryRuntimeDirectoryStore();
      await store.upsert(sessionEntry("beta", { runtimeKind: "claude-agent", displayName: "beta" }));
      const delivered: string[] = [];

      const alpha = await runJointSession({
        turns: [
          { toolUses: [{ id: "toolu_row4_idle", name: "SendMessage", input: { to: "beta", message: "ping me when free", notify_when_idle: true } }] },
          { text: "refused" },
        ],
        officialId: "alpha",
        store,
        during: async ({ messaging }) => {
          messaging.attachOfficialSession("session:beta", {
            status: () => "running",
            push: (text: string) => {
              delivered.push(text);
            },
          });
        },
      });

      const idle = toolResults(alpha.record).find((entry) => entry.tool_use_id === "toolu_row4_idle");
      const rendered = JSON.stringify(idle?.content);
      expect(rendered).toContain("refused");
      expect(rendered).toContain("idle");
      // THE WHOLE CALL, including the attached message: the sender can retry without the flag.
      expect(delivered).toHaveLength(0);
    },
    JOINT_TIMEOUT,
  );
});

describeRuntime("WS-17 row 5, real-runtime half: an official parent RESUMED after a restart", () => {
  afterAll(cleanupHermetic);

  test(
    "generation two is a real `resume()` of generation one's backend session, and the completed children are addressable through it",
    async () => {
      const store = createInMemoryRuntimeDirectoryStore();
      // GENERATION ONE. Its children are recorded durably as a real session's would be, `exited` —
      // this seam's word for a child that has finished, which is row 5's "completed".
      const first = await runJointSession({ turns: [{ text: "parent generation one" }], officialId: "parent", store });
      expect(first.messages.at(-1)?.type).toBe("result");
      // THE IDENTITY A RESTART HAS TO CARRY, reported by the runtime itself rather than chosen by us.
      expect(first.backendSessionId).toBeDefined();
      await store.upsert(childEntry("parent", "child-a", { runtimeKind: "claude-agent", status: "exited" }));
      await store.upsert(childEntry("parent", "child-b", { runtimeKind: "claude-agent", status: "exited" }));

      // THE RESTART: `resume()`, not a second `launch()`, into generation one's OWN spool — the
      // directory that survives a process death and holds the transcript being resumed.
      const delivered: string[] = [];
      const second = await runJointSession({
        turns: [{ toolUses: [{ id: "toolu_row5_list", name: "ListAgents", input: {} }] }, { text: "listed" }],
        officialId: "parent",
        store,
        resumeFrom: { ...first.session, backendSessionId: first.backendSessionId! },
        during: async ({ messaging }) => {
          messaging.attachOfficialSession("session:parent", {
            status: () => "idle",
            push: (text: string) => {
              delivered.push(text);
            },
          });
        },
      });

      // THE SAME BACKEND SESSION came back — the assertion that makes this a resume rather than a
      // second session that happens to share a directory row.
      expect(second.backendSessionId).toBe(first.backendSessionId);
      expect(second.observedRoot).toBe(first.observedRoot);
      expect(second.messages.at(-1)?.type).toBe("result");

      // The children are BACK, addressed through their owning parent (WS-10 §11 rule 2).
      const listing = JSON.stringify(toolResults(second.record).find((entry) => entry.tool_use_id === "toolu_row5_list")?.content);
      expect(listing).toContain("agent:parent:child-a");
      expect(listing).toContain("agent:parent:child-b");

      // …and a native SendMessage to one of them is DELIVERED through the resumed parent's own
      // stream, which is the only route a completed official child has. Asserted positively: the
      // previous version closed on `not.toBe("not_found")`, which `unavailable` and `held` satisfy too.
      const outcome = await second.messaging.send({
        from: { objectKind: "session", runtimeKind: "claude-agent", winterSessionId: "parent" },
        to: "agent:parent:child-a",
        body: "what did you find?",
        originToolCallId: "toolu_row5_child",
      });
      expect(["delivered", "queued"]).toContain(outcome.status);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain("child-a");
      expect(delivered[0]).toContain("what did you find?");
    },
    JOINT_TIMEOUT,
  );
});
