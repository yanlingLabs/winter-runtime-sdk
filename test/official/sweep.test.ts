// §8's POST-HOC SWEEP (review r2, NEW-3), at unit level: what it finds, what it removes, and — the
// property that makes deletion safe — what it leaves alone.
//
// The live half is in `runtime-containment.test.ts`, where a real `Bash` call builds the vendor's name
// out of fragments the pre-hoc scan cannot read.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createContainmentSweep, forbiddenArtifactsUnder, SWEPT_TOOLS, type ContainmentBreach } from "../../src/official/sweep.ts";

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
const post = (sweep: ReturnType<typeof createContainmentSweep>, toolUseId: string, toolName = "Bash"): Promise<Record<string, unknown>> =>
  (sweep.hooks["PostToolUse"] ?? [])[0]!.hooks[0]!({ hook_event_name: "PostToolUse", tool_name: toolName, tool_use_id: toolUseId }) as Promise<Record<string, unknown>>;

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
    expect(output["decision"]).toBe("block");
    expect(String(output["reason"])).toContain("CLAUDE.md");
    expect(breaches).toHaveLength(1);
    expect(breaches[0]?.removed.map((path) => path.replace(cwd, ""))).toEqual(["/CLAUDE.md"]);
    expect(breaches[0]?.retained).toEqual([]);
    expect(sweep.breaches).toHaveLength(1);
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
    expect(output["decision"]).toBe("block");
    expect(existsSync(join(home, ".claude"))).toBe(false);
  });

  test("only filesystem-touching tools are snapshotted, and an unpaired post is a no-op", async () => {
    const cwd = workspace();
    const sweep = createContainmentSweep({ cwd });
    expect(SWEPT_TOOLS).toContain("Bash");
    expect(SWEPT_TOOLS).toContain("Write");
    expect(SWEPT_TOOLS).not.toContain("Read");
    // A tool outside the set never takes a snapshot…
    await pre(sweep, "t4", "Read");
    writeFileSync(join(cwd, "CLAUDE.md"), "x");
    expect(await post(sweep, "t4", "Read")).toEqual({});
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(true);
    // …and a post with no matching pre treats everything present as pre-existing rather than deleting
    // a tree it never saw appear.
    expect(await post(sweep, "never-seen")).toMatchObject({ decision: "block" });
  });
});
