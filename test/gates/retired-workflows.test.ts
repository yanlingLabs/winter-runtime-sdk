// The spent one-run workflows are RETIRED: moved out of `.github/workflows/` (GitHub runs nothing outside it) into `.github/retired-workflows/`, where the gate tests
// and the pin tests still read them as inert records (the guided compile pins hash the workflow's env; the reader gates assert its reviewed shape).
//
// Why moved and not edited to "disabled": each fired on the FIRST CREATION of a named branch (or a push to one with matching paths). Those branches now exist and are
// frozen, but deleting and recreating a name would fire a live file again, and an `if: false` edit is one revert from live. A file outside the workflows directory cannot run.
//
// Kept live: ci.yml, release.yml and the five `*-source` workflows (portable source tests on named branches; they arm and run nothing privileged).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
export const RETIRED = ["cowork-guided-packet-compile-fixture.yml", "cowork-reader-compile-fixture.yml", "cowork-reader-native-reviewed.yml"] as const;
export const LIVE = ["ci.yml", "cowork-guided-build-source.yml", "cowork-reader-abi-source.yml", "cowork-reader-build-source.yml", "cowork-reader-intake-source.yml", "cowork-reader-native-source.yml", "release.yml"] as const;
/** First-creation branches of the retired one-run workflows. All exist and are frozen. */
export const SPENT_BRANCHES = [
  "cowork/guided-packet-compile-fixture", "cowork/guided-packet-compile-fixture-2", "cowork/guided-packet-compile-fixture-3", "cowork/guided-packet-compile-fixture-4",
  "cowork/guided-packet-compile-fixture-5", "cowork/instruction-reader-compile-fixture",
] as const;

/** Pure: the violations of a listing of the live workflows directory (name -> text). */
export function violations(files: Record<string, string>): string[] {
  const found: string[] = [];
  for (const name of Object.keys(files).sort()) {
    if ((RETIRED as readonly string[]).includes(name)) found.push(`retired workflow is back: ${name}`);
    else if (!(LIVE as readonly string[]).includes(name)) found.push(`workflow is not on the allow-list: ${name}`);
    for (const branch of SPENT_BRANCHES) if (new RegExp(`${branch.replace(/[/.]/g, "\\$&")}(?![\\w-])`).test(files[name]!)) found.push(`${name} names a spent branch: ${branch}`);
  }
  return found;
}
const live = (): Record<string, string> => Object.fromEntries(readdirSync(join(ROOT, ".github/workflows")).filter((name) => /\.ya?ml$/.test(name)).map((name) => [name, readFileSync(join(ROOT, ".github/workflows", name), "utf8")]));

describe("retired workflows stay out of .github/workflows", () => {
  test("the retired files are records under .github/retired-workflows, not workflows", () => {
    for (const name of RETIRED) {
      expect(existsSync(join(ROOT, ".github/workflows", name))).toBe(false);
      expect(existsSync(join(ROOT, ".github/retired-workflows", name))).toBe(true);
    }
  });
  test("the live workflows are exactly the allow-list and name no spent branch", () => {
    expect(violations(live())).toEqual([]);
    expect(Object.keys(live()).sort()).toEqual([...LIVE].sort());
  });
  test("the pure check flags a returned file, a new workflow and a spent branch name (mutations)", () => {
    const base = live();
    expect(violations({ ...base, "cowork-guided-packet-compile-fixture.yml": "on: push" })).toEqual(["retired workflow is back: cowork-guided-packet-compile-fixture.yml"]);
    expect(violations({ ...base, "one-run.yml": "on: push" })).toEqual(["workflow is not on the allow-list: one-run.yml"]);
    expect(violations({ ...base, "ci.yml": `${base["ci.yml"]}\n# branches: [cowork/guided-packet-compile-fixture-5]` })).toEqual(["ci.yml names a spent branch: cowork/guided-packet-compile-fixture-5"]);
    expect(violations({ ...base, "ci.yml": `${base["ci.yml"]}\n# cowork/guided-packet-compile-fixture-6` })).toEqual([]);
  });
});
