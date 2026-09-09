// §8's POST-HOC SWEEP (review r2, NEW-3), at unit level: what it finds, what it removes, and — the
// property that makes deletion safe — what it leaves alone.
//
// The live half is in `runtime-containment.test.ts`, where a real `Bash` call builds the vendor's name
// out of fragments the pre-hoc scan cannot read.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { POST_TOOL_EVENTS, createContainmentSweep, forbiddenArtifactsUnder, SWEPT_TOOLS, type ContainmentBreach } from "../../src/official/sweep.ts";

const roots: string[] = [];
const workspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), "winter-rt-sweep-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const pre = (sweep: ReturnType<typeof createContainmentSweep>, toolUseId: string, toolName = "Bash"): Promise<unknown> =>
  (sweep.hooks["PreToolUse"] ?? [])[0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: toolName, tool_use_id: toolUseId });
const post = (sweep: ReturnType<typeof createContainmentSweep>, toolUseId: string, toolName = "Bash", event = "PostToolUse"): Promise<Record<string, unknown>> =>
  (sweep.hooks[event] ?? [])[0]!.hooks[0]!({ hook_event_name: event, tool_name: toolName, tool_use_id: toolUseId }) as Promise<Record<string, unknown>>;

describe("the post-hoc containment sweep", () => {
  test("finds the three forbidden names under a root, folded, and does not walk into them", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, ".Claude", "worktrees", "feature"), { recursive: true });
    writeFileSync(join(cwd, "claude.md"), "x");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "ordinary.ts"), "x");
    const found = forbiddenArtifactsUnder(cwd).map((path) => path.replace(cwd, ""));
    expect(found.sort()).toEqual(["/.Claude", "/claude.md"]);
  });

  test("removes ONLY what the call created, and reports it", async () => {
    const cwd = workspace();
    // A pre-existing one: the sweep must NOT delete a directory it did not see appear.
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "was-here-first.json"), "{}");
    const breaches: ContainmentBreach[] = [];
    const sweep = createContainmentSweep({ cwd, onBreach: (breach) => breaches.push(breach) });

    await pre(sweep, "t1");
    // …and the call creates a second one.
    writeFileSync(join(cwd, "CLAUDE.md"), "# created by the call\n");
    const output = await post(sweep, "t1");

    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude", "was-here-first.json"))).toBe(true);
    // The turn is ENDED rather than the result rewritten — measured: this runtime ignores every
    // documented PostToolUse rewrite, and `continue: false` is the one shape that changes anything.
    expect(output["continue"]).toBe(false);
    expect(output["decision"]).toBe("block");
    expect(String(output["stopReason"])).toContain("CLAUDE.md");
    expect(String(output["reason"])).toContain("CLAUDE.md");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.removed.map((path) => path.replace(cwd, ""))).toEqual(["/CLAUDE.md"]);
    expect(breaches[0]?.retained).toEqual([]);
    expect(sweep.breaches).toHaveLength(1);
  });

  test("review r3, NEW-9: a FAILING call is swept too — `PostToolUseFailure`, and the batch event", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    // The measured hole: a command with a side effect and a nonzero exit fires PostToolUseFailure and
    // no PostToolUse at all, so the baseline was taken and never consumed.
    await pre(sweep, "failing");
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "leak.txt"), "x");
    const failure = await post(sweep, "failing", "Bash", "PostToolUseFailure");
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(sweep.breaches).toHaveLength(1);
    // The turn-ending half is not honoured on this event (measured) — the removal is the guarantee.
    expect(failure["decision"]).toBe("block");

    // …and the batch event, whose input carries `tool_calls[]` rather than one id.
    await pre(sweep, "batched");
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    const batch = (await (sweep.hooks["PostToolBatch"] ?? [])[0]!.hooks[0]!({
      hook_event_name: "PostToolBatch",
      tool_calls: [{ tool_name: "Read", tool_use_id: "other" }, { tool_name: "Write", tool_use_id: "batched" }],
    })) as Record<string, unknown>;
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(batch["decision"]).toBe("block");
    expect(sweep.breaches).toHaveLength(2);
  });

  test("a call that creates nothing forbidden is invisible to it", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    await pre(sweep, "t2");
    writeFileSync(join(cwd, "notes.md"), "ordinary work");
    expect(await post(sweep, "t2")).toEqual({});
    expect(sweep.breaches).toEqual([]);
    expect(existsSync(join(cwd, "notes.md"))).toBe(true);
  });

  test("it covers HOME as well as the project — `~/.claude/plans` is one of row 14's three", async () => {
    const cwd = workspace();
    const home = workspace();
    const sweep = createContainmentSweep({ cwd, home });
    await pre(sweep, "t3");
    mkdirSync(join(home, ".claude", "plans"), { recursive: true });
    const output = await post(sweep, "t3");
    expect(output["continue"]).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("review r3, NEW-14: the walk is BOUNDED, and the bound is a knob rather than a secret", async () => {
    const cwd = workspace();
    // Depth 8 — deeper than the default bound, which is a deliberate cost trade and therefore also a
    // documented limit: "project `.claude/`" in row 14 is not only the one at the root.
    mkdirSync(join(cwd, "a/b/c/d/e/f/g/.claude"), { recursive: true });
    expect(forbiddenArtifactsUnder(cwd)).toEqual([]);
    expect(forbiddenArtifactsUnder(cwd, 0, 12).map((path) => path.replace(cwd, ""))).toEqual(["/a/b/c/d/e/f/g/.claude"]);
    // …and a sweep built with a deeper bound sees and removes it.
    const deep = createContainmentSweep({ cwd, maxDepth: 12 });
    await (deep.hooks["PreToolUse"] ?? [])[0]!.hooks[0]!({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "deep" });
    mkdirSync(join(cwd, "a/b/c/d/e/f/g/h/.claude"), { recursive: true });
    await (deep.hooks["PostToolUse"] ?? [])[0]!.hooks[0]!({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "deep" });
    expect(existsSync(join(cwd, "a/b/c/d/e/f/g/h/.claude"))).toBe(false);
  });

  test("only filesystem-touching tools are snapshotted, and an unpaired post is a no-op", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    expect(SWEPT_TOOLS).toContain("Bash");
    expect(SWEPT_TOOLS).toContain("Write");
    expect(SWEPT_TOOLS).not.toContain("Read");
    // review r3, NEW-11: §8's writer with no tool call of its own rides a WebFetch, so that call is
    // swept too. And review r3, NEW-9: every post-tool event the pinned union carries is registered.
    expect(SWEPT_TOOLS).toContain("WebFetch");
    expect([...POST_TOOL_EVENTS].sort()).toEqual(["PostToolBatch", "PostToolUse", "PostToolUseFailure"]);
    expect(Object.keys(sweep.hooks).sort()).toEqual(["PostToolBatch", "PostToolUse", "PostToolUseFailure", "PreToolUse"]);
    // A tool outside the set never takes a snapshot…
    await pre(sweep, "t4", "Read");
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    expect(await post(sweep, "t4", "Read")).toEqual({});
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    // …and a post with NO MATCHING PRE deletes nothing at all (review r3, NEW-12): with no snapshot
    // nothing is attributable to the call, and the previous behaviour — treat everything present as
    // newly created and `rmSync` it recursively — pointed an `rm -rf` at the user's real home in
    // production. The comment used to describe the safe behaviour while the assertion pinned the
    // destructive one.
    writeFileSync(join(cwd, "CLAUDE.md"), "planted, and not this call's doing");
    expect(await post(sweep, "never-seen")).toEqual({});
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    expect(sweep.breaches).toEqual([]);
  });
});
