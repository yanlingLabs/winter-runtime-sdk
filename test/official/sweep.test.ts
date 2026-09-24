// §8's POST-HOC SWEEP (review r2, NEW-3), at unit level: what it finds, what it removes, and — the
// property that makes deletion safe — what it leaves alone.
//
// The live half is in `runtime-containment.test.ts`, where a real `Bash` call builds the vendor's name
// out of fragments the pre-hoc scan cannot read.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("Touch 4 (F3): claude's own `.cc-writes` staging is runtime bookkeeping, never a breach", () => {
  // claude 2.1.250 (`ensureAtomicWriteStagingDirs`, `QWn`; the name `kF` = ".cc-writes") creates
  // `<cwd>/.claude/.cc-writes/` and `<home>/.claude/.cc-writes/` (mode 0700) before EVERY sandboxed Bash
  // call. The sweep saw a new `<cwd>/.claude`, removed it and ENDED THE TURN: the model never saw the
  // Bash output and no follow-up request was made.
  const stage = (root: string): void => {
    mkdirSync(join(root, ".claude", ".cc-writes"), { recursive: true, mode: 0o700 });
  };

  test("a NEW `<cwd>/.claude` holding only `.cc-writes` (with or without staged files in it): the turn goes on, no breach, and the folder is removed", async () => {
    const cwd = workspace();
    const breaches: ContainmentBreach[] = [];
    const sweep = createContainmentSweep({ cwd, onBreach: (breach) => breaches.push(breach) });
    await pre(sweep, "bash-1");
    stage(cwd);
    expect(await post(sweep, "bash-1")).toEqual({});
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    // …and again on the next call, with a staged file inside (claude re-creates the folder every call).
    await pre(sweep, "bash-2");
    stage(cwd);
    writeFileSync(join(cwd, ".claude", ".cc-writes", "staged-1"), "x");
    expect(await post(sweep, "bash-2")).toEqual({});
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(breaches).toEqual([]);
    expect(sweep.breaches).toEqual([]);
  });

  test("the same under the home: a NEW `<home>/.claude` holding only `.cc-writes` is bookkeeping", async () => {
    const cwd = workspace();
    const home = workspace();
    const sweep = createContainmentSweep({ cwd, home });
    await pre(sweep, "bash-home");
    stage(home);
    expect(await post(sweep, "bash-home")).toEqual({});
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(sweep.breaches).toEqual([]);
  });

  test("`.cc-writes` BESIDE anything else is still a breach — a model-written `<cwd>/.claude/settings.json` ends the turn and nothing survives", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    await pre(sweep, "bash-3");
    stage(cwd);
    writeFileSync(join(cwd, ".claude", "settings.json"), "{}");
    const output = await post(sweep, "bash-3");
    expect(output["continue"]).toBe(false);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
    expect(sweep.breaches).toHaveLength(1);
  });

  test("only the vendor's own shape counts: a FILE named `.cc-writes`, a `.cc-writes` one level deeper, or a symlinked `.claude`/`.cc-writes` is a breach", async () => {
    for (const plant of [
      (cwd: string) => {
        mkdirSync(join(cwd, ".claude"), { recursive: true });
        writeFileSync(join(cwd, ".claude", ".cc-writes"), "not a directory");
      },
      (cwd: string) => {
        mkdirSync(join(cwd, ".claude", "x", ".cc-writes"), { recursive: true });
      },
      (cwd: string) => {
        mkdirSync(join(cwd, "elsewhere", ".cc-writes"), { recursive: true });
        symlinkSync(join(cwd, "elsewhere"), join(cwd, ".claude"));
      },
      (cwd: string) => {
        mkdirSync(join(cwd, "real-staging"), { recursive: true });
        mkdirSync(join(cwd, ".claude"), { recursive: true });
        symlinkSync(join(cwd, "real-staging"), join(cwd, ".claude", ".cc-writes"));
      },
    ]) {
      const cwd = workspace();
      const sweep = createContainmentSweep({ cwd });
      await pre(sweep, "odd");
      plant(cwd);
      expect((await post(sweep, "odd"))["continue"]).toBe(false);
      expect(sweep.breaches).toHaveLength(1);
    }
  });

  test("Touch 5: claude stages under its CURRENT cwd too — after the model's `cd sub`, a new `<cwd>/sub/.claude` holding only `.cc-writes` is bookkeeping (any depth under the cwd walk)", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    await pre(sweep, "after-cd");
    stage(cwd);
    stage(join(cwd, "sub"));
    expect(await post(sweep, "after-cd")).toEqual({});
    expect([existsSync(join(cwd, ".claude")), existsSync(join(cwd, "sub", ".claude"))]).toEqual([false, false]);
    expect(sweep.breaches).toEqual([]);
  });

  test("Touch 5: claude stages under the PROJECT ROOT too — with the cwd below it, a new `<root>/.claude` holding only `.cc-writes` above the cwd is removed; a pre-existing one, or one with other content, is left alone (outside the sweep's scope)", async () => {
    const root = workspace();
    const cwd = join(root, "pkg", "app");
    mkdirSync(cwd, { recursive: true });
    const sweep = createContainmentSweep({ cwd });
    await pre(sweep, "root-staging");
    stage(root);
    stage(cwd);
    expect(await post(sweep, "root-staging")).toEqual({});
    expect([existsSync(join(root, ".claude")), existsSync(join(cwd, ".claude"))]).toEqual([false, false]);
    // Above the cwd the sweep only ever cleans claude's own staging: other content there is not its to judge.
    await pre(sweep, "root-other");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".claude", "notes.md"), "x");
    expect(await post(sweep, "root-other")).toEqual({});
    expect(existsSync(join(root, ".claude", "notes.md"))).toBe(true);
    expect(sweep.breaches).toEqual([]);
  });

  test("the home is checked at its TOP level only — never walked (it is the user's real home in production)", async () => {
    const cwd = workspace();
    const home = workspace();
    const sweep = createContainmentSweep({ cwd, home });
    await pre(sweep, "deep");
    mkdirSync(join(home, "projects", "other", ".claude"), { recursive: true });
    expect(await post(sweep, "deep")).toEqual({});
    expect(existsSync(join(home, "projects", "other", ".claude"))).toBe(true);
    // …while a new top-level `<home>/.claude` with real content is still row 14's breach.
    await pre(sweep, "top");
    mkdirSync(join(home, ".claude", "plans"), { recursive: true });
    expect((await post(sweep, "top"))["continue"]).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });
});
