// WS-21 §3.4.3: the generated instructions file — one `WINTER.md` both runtimes read, with a
// `CLAUDE.md` link to it; imports expanded under each file's own tier rule (F17); leftover import
// tokens neutralised; project rules' `paths:` re-expressed from the cwd.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildRunHome } from "../../src/index.ts";
import { expandImports } from "../../src/run-home/instructions.ts";
import { cleanupRunHomeBeds, inputFor, put, runHomeBed, type RunHomeBed } from "./support.ts";

afterAll(cleanupRunHomeBeds);

const ZWSP = "\u200b";

function project(bed: RunHomeBed): { root: string; cwd: string } {
  const root = join(bed.root, "repo");
  const cwd = join(root, "pkg");
  mkdirSync(cwd, { recursive: true });
  return { root, cwd };
}

describe("the generated file", () => {
  test("user first, then root → cwd (WINTER.md, .winter/WINTER.md, WINTER.local.md), each under its absolute path", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "WINTER.md"), "user text\n");
    put(join(p.root, "WINTER.md"), "root text\n");
    put(join(p.root, ".winter", "WINTER.md"), "root dot text\n");
    put(join(p.root, "WINTER.local.md"), "root local text\n");
    put(join(p.cwd, "WINTER.md"), "pkg text\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const text = readFileSync(join(runHome.dir, "WINTER.md"), "utf8");
    const order = [join(bed.sdk, "WINTER.md"), join(p.root, "WINTER.md"), join(p.root, ".winter", "WINTER.md"), join(p.root, "WINTER.local.md"), join(p.cwd, "WINTER.md")];
    let cursor = -1;
    for (const path of order) {
      const at = text.indexOf(`# ${path}\n`);
      expect([path, at > cursor]).toEqual([path, true]);
      cursor = at;
    }
    for (const body of ["user text", "root text", "root dot text", "root local text", "pkg text"]) expect(text).toContain(body);
    expect(statSync(join(runHome.dir, "WINTER.md")).mode & 0o777).toBe(0o600);
  });

  test("CLAUDE.md is a relative link to ./WINTER.md", async () => {
    const bed = runHomeBed();
    put(join(bed.sdk, "WINTER.md"), "user text\n");
    const runHome = await buildRunHome(inputFor(bed));
    const link = join(runHome.dir, "CLAUDE.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("./WINTER.md");
    expect(readFileSync(link, "utf8")).toBe(readFileSync(join(runHome.dir, "WINTER.md"), "utf8"));
  });

  test("an untrusted project contributes nothing; the user file reaches every mode", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(bed.sdk, "WINTER.md"), "user text\n");
    put(join(p.root, "WINTER.md"), "root text\n");
    for (const mode of ["code", "dispatch", "chat"] as const) {
      const untrusted = readFileSync(join((await buildRunHome(inputFor(bed, { mode, cwd: p.cwd, trustedProjectRoot: null, gitRoot: p.root }))).dir, "WINTER.md"), "utf8");
      expect(untrusted).toContain("user text");
      expect(untrusted).not.toContain("root text");
      const trusted = readFileSync(join((await buildRunHome(inputFor(bed, { mode, cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }))).dir, "WINTER.md"), "utf8");
      expect(trusted).toContain("root text");
    }
  });

  test("with nothing to say, the file still exists (empty) and the link resolves", async () => {
    const bed = runHomeBed();
    const runHome = await buildRunHome(inputFor(bed));
    expect(readFileSync(join(runHome.dir, "WINTER.md"), "utf8")).toBe("");
    expect(existsSync(join(runHome.dir, "CLAUDE.md"))).toBe(true);
  });
});

describe("imports (F17's tier rule)", () => {
  test("a project import outside the root is dropped, reported, and left inert", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const secret = join(bed.root, "secret.txt");
    put(secret, "SECRET-CONTENT\n");
    put(join(p.root, "WINTER.md"), `see @${secret} please\n`);
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const text = readFileSync(join(runHome.dir, "WINTER.md"), "utf8");
    expect(text).not.toContain("SECRET-CONTENT");
    expect(text).toContain(`@${ZWSP}${secret}`);
    expect(runHome.report.droppedImports).toEqual([secret]);
  });

  test("a project import inside the root is followed", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, "docs", "guide.md"), "GUIDE-CONTENT\n");
    put(join(p.root, "WINTER.md"), "see @docs/guide.md\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(readFileSync(join(runHome.dir, "WINTER.md"), "utf8")).toContain("GUIDE-CONTENT");
  });

  test("a user import outside sdk/ is followed", async () => {
    const bed = runHomeBed();
    const shared = join(bed.root, "shared-notes.md");
    put(shared, "SHARED-NOTES\n");
    put(join(bed.sdk, "WINTER.md"), `@${shared}\n`);
    const runHome = await buildRunHome(inputFor(bed));
    expect(readFileSync(join(runHome.dir, "WINTER.md"), "utf8")).toContain("SHARED-NOTES");
    expect(runHome.report.droppedImports).toEqual([]);
  });

  test("a leftover token that would resolve against the run folder (`@settings.json`) is escaped", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, "WINTER.md"), "read @settings.json and @.winter.json\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const text = readFileSync(join(runHome.dir, "WINTER.md"), "utf8");
    expect(text).toContain(`@${ZWSP}settings.json`);
    expect(text).toContain(`@${ZWSP}.winter.json`);
    expect(text).not.toMatch(/(^|\s)@settings\.json/);
  });
});

describe("expandImports (the algorithm, directly)", () => {
  test("relative to the containing file; code spans and fences are skipped; depth is capped at 5", () => {
    const bed = runHomeBed();
    const dir = join(bed.root, "chain");
    for (let n = 0; n < 8; n += 1) put(join(dir, `f${n}.md`), n === 7 ? "END-OF-CHAIN\n" : `level ${n} @./f${n + 1}.md\n`);
    put(join(dir, "code.md"), "`@./f7.md` and\n```\n@./f7.md\n```\n");
    const deep = expandImports({ content: "@./f1.md\n", filePath: join(dir, "f0.md"), tier: "user", projectRoot: null });
    expect(deep.content).toContain("level 5");
    expect(deep.content).not.toContain("END-OF-CHAIN");
    const code = expandImports({ content: readFileSync(join(dir, "code.md"), "utf8"), filePath: join(dir, "code.md"), tier: "user", projectRoot: null });
    expect(code.content).not.toContain("END-OF-CHAIN");
  });

  test("an unresolved token stays as literal text", () => {
    const bed = runHomeBed();
    const out = expandImports({ content: "hello @./nope.md world\n", filePath: join(bed.root, "x.md"), tier: "user", projectRoot: null });
    expect(out.content).toBe("hello @./nope.md world\n");
    expect(out.dropped).toEqual([]);
  });

  test("an e-mail address is not an import", () => {
    const bed = runHomeBed();
    const out = expandImports({ content: "mail me@example.com\n", filePath: join(bed.root, "x.md"), tier: "user", projectRoot: null });
    expect(out.content).toBe("mail me@example.com\n");
  });
});

describe("project rules' `paths:` (F17: a project rule resolves from its dot-dir's parent, a user rule from the cwd)", () => {
  const rule = (paths: string[]): string => `---\npaths:\n${paths.map((p) => `  - "${p}"`).join("\n")}\n---\n\nrule body\n`;

  test("`src/**` from the root with the cwd at <root>/pkg cannot be expressed: loaded unconditionally and reported", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, ".winter", "rules", "src.md"), rule(["src/**"]));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const copied = join(runHome.dir, "rules", "project--.winter--rules--src.md");
    expect(lstatSync(copied).isSymbolicLink()).toBe(false);
    expect(readFileSync(copied, "utf8")).toBe("---\n---\n\nrule body\n");
    expect(runHome.report.unconditionalRules).toEqual([join(p.root, ".winter", "rules", "src.md")]);
  });

  test("a glob under the cwd is rewritten relative to it, and the rule stays conditional", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, ".winter", "rules", "lib.md"), rule(["pkg/lib/**", "**/*.ts", "other/**"]));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const copied = readFileSync(join(runHome.dir, "rules", "project--.winter--rules--lib.md"), "utf8");
    expect(copied).toBe('---\npaths:\n  - "lib/**"\n  - "**/*.ts"\n---\n\nrule body\n');
    expect(runHome.report.unconditionalRules).toEqual([]);
  });

  test("a rule anchored at the cwd itself needs no rewrite: it stays a link", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.cwd, ".winter", "rules", "here.md"), rule(["src/**"]));
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(lstatSync(join(runHome.dir, "rules", "project--pkg--.winter--rules--here.md")).isSymbolicLink()).toBe(true);
  });
});
