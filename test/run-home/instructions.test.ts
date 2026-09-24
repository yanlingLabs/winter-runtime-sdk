// WS-21 §3.4.3: the generated instructions file — one `WINTER.md` both runtimes read, with a
// `CLAUDE.md` link to it; imports expanded under each file's own tier rule (F17); leftover import
// tokens neutralised; project rules' `paths:` re-expressed from the cwd.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildRunHome } from "../../src/index.ts";
import { escapeImportTokens, expandImports } from "../../src/run-home/instructions.ts";
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

describe("the neutraliser is code-blind (R.3, C1 ii): no `@` claude's lexer could read as an import survives", () => {
  // claude 2.1.250 lexes with marked (`gfm: false`) and skips only true `code`/`codespan` tokens; the
  // router's per-line code detection disagreed on these shapes, left the token raw, reported nothing,
  // and claude imported the file (MEASURED with marked 18.0.6 and claude's own `cYt`). The first three
  // are the review's; the rest are marked text tokens that START with `@` after an inline token closes
  // (a fuzz of claude's extractor over 1.1M markdown strings found them; none survive the neutraliser).
  const shapes = (secret: string): Record<string, string> => ({
    "backtick fence whose info string holds a backtick (not a fence)": `\`\`\`x\`\n@${secret}\n`,
    "tab-led fence (an indented line, not a fence)": `\t\`\`\`\n@${secret}\n\`\`\`\n`,
    "mismatched backtick runs (not a code span)": `\` @${secret} \`\`\n`,
    "after a blockquote marker": `>@${secret}\n`,
    "after strong emphasis": `**x**@${secret}\n`,
    "after an inline html tag": `a<b>@${secret}</b>\n`,
    "after an html comment": `<!-- c -->@${secret}\n`,
    "after an escaped character": `\\*@${secret}\n`,
    "after a code span": `\`c\`@${secret}\n`,
  });

  test("every measured shape, in a trusted project's instructions file: no raw `@<path>` is left, each is neutralised", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const secret = join(bed.root, "outside", "secret.md");
    put(secret, "SECRET-CONTENT\n");
    const cases = shapes(secret);
    put(join(p.root, "WINTER.md"), `${Object.values(cases).join("\n")}\n`);
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    const text = readFileSync(join(runHome.dir, "WINTER.md"), "utf8");
    expect(text).not.toContain("SECRET-CONTENT");
    for (const [label, shape] of Object.entries(cases)) {
      const neutralised = escapeImportTokens(shape);
      expect([label, neutralised.includes(`@${secret}`), neutralised.includes(`@${ZWSP}${secret}`)]).toEqual([label, false, true]);
    }
    expect(text.split(`@${secret}`).length - 1).toBe(0);
    expect(text.split(`@${ZWSP}${secret}`).length - 1).toBe(Object.keys(cases).length);
  });

  test("inside a real fenced block and a real code span too (a zero-width space there is invisible); an e-mail address and an already-neutral token are left as they are", () => {
    expect(escapeImportTokens("```\n@a.md\n```\n`@b.md`\n")).toBe(`\`\`\`\n@${ZWSP}a.md\n\`\`\`\n\`@${ZWSP}b.md\`\n`);
    expect(escapeImportTokens("mail me@example.com or a1@x.y\n")).toBe("mail me@example.com or a1@x.y\n");
    expect(escapeImportTokens(`@${ZWSP}done and @ alone and trailing @`)).toBe(`@${ZWSP}done and @ alone and trailing @`);
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

describe("project rules' imports (R.3, C1 i): a rule is read at the USER tier in the run folder, so it gets the instructions treatment", () => {
  // In `<run>/rules` a project rule is a USER-tier rule, and both runtimes follow a user rule's imports
  // anywhere (claude: `includeExternal` for the user tier; the Winter SDK expands rules under their own
  // tier, "user"). Linked verbatim, a trusted repository's `.winter/rules/x.md` could import any file on
  // the machine into every mode's context. So: expand under the PROJECT rule (inside the root only),
  // drop and report the rest, neutralise every leftover `@`, and COPY any rule that holds an `@`.
  const ruleName = "project--.winter--rules--x.md";

  test("an import outside the root is dropped, reported and neutralised; the rule is a COPY, never a link", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const secret = join(bed.root, "outside", "secret.md");
    put(secret, "SECRET-CONTENT\n");
    put(join(p.root, ".winter", "rules", "x.md"), `rule body @${secret}\n`);
    for (const mode of ["code", "chat", "dispatch"] as const) {
      const runHome = await buildRunHome(inputFor(bed, { mode, cwd: p.root, trustedProjectRoot: p.root, gitRoot: p.root }));
      const copied = join(runHome.dir, "rules", ruleName);
      expect([mode, lstatSync(copied).isSymbolicLink()]).toEqual([mode, false]);
      expect([mode, readFileSync(copied, "utf8")]).toEqual([mode, `rule body @${ZWSP}${secret}\n`]);
      expect([mode, statSync(copied).mode & 0o777]).toEqual([mode, 0o600]);
      expect([mode, runHome.report.droppedImports]).toEqual([mode, [secret]]);
    }
  });

  test("an import inside the root is expanded relative to the rule's OWN directory (in the run folder it would resolve against `<run>/rules`)", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, "docs", "guide.md"), "GUIDE-CONTENT\n");
    put(join(p.root, ".winter", "rules", "x.md"), "see @../../docs/guide.md\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.root, trustedProjectRoot: p.root, gitRoot: p.root }));
    const text = readFileSync(join(runHome.dir, "rules", ruleName), "utf8");
    expect(text).toContain("GUIDE-CONTENT");
    expect(text).not.toMatch(/(^|\s)@\.\.\/\.\.\/docs/);
    expect(runHome.report.droppedImports).toEqual([]);
  });

  test("a leftover token that would resolve against the run folder (`@../settings.json`) is neutralised", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, ".winter", "rules", "x.md"), "read @../settings.json and @../.winter.json\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.root, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(readFileSync(join(runHome.dir, "rules", ruleName), "utf8")).toBe(`read @${ZWSP}../settings.json and @${ZWSP}../.winter.json\n`);
  });

  test("a rule whose `paths:` is rewritten AND that holds an import gets both: the rewrite does not bring the raw token back", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const secret = join(bed.root, "outside", "secret.md");
    put(secret, "SECRET-CONTENT\n");
    put(join(p.root, ".winter", "rules", "x.md"), `---\npaths:\n  - "pkg/lib/**"\n---\n\nbody @${secret}\n`);
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.cwd, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(readFileSync(join(runHome.dir, "rules", ruleName), "utf8")).toBe(`---\npaths:\n  - "lib/**"\n---\n\nbody @${ZWSP}${secret}\n`);
    expect(runHome.report.droppedImports).toEqual([secret]);
  });

  test("the frontmatter is claude's own split (`fR`), which both runtimes use: a token claude reads as BODY is neutralised even where a line-based split would call it frontmatter; the real frontmatter is left as written", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    const secret = join(bed.root, "outside", "secret.md");
    put(secret, "SECRET-CONTENT\n");
    // claude's lazy `---` closes the block INSIDE `foo---bar`, so `@<secret>` is body to it.
    put(join(p.root, ".winter", "rules", "odd.md"), `---\ndescription: foo---bar\n@${secret}\n---\nbody\n`);
    put(join(p.root, ".winter", "rules", "x.md"), `---\ndescription: "mail @team"\n---\nbody @${secret}\n`);
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.root, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(readFileSync(join(runHome.dir, "rules", "project--.winter--rules--odd.md"), "utf8")).toBe(`---\ndescription: foo---bar\n@${ZWSP}${secret}\n---\nbody\n`);
    expect(readFileSync(join(runHome.dir, "rules", ruleName), "utf8")).toBe(`---\ndescription: "mail @team"\n---\nbody @${ZWSP}${secret}\n`);
  });

  test("a rule with no `@` and nothing to rewrite stays a link; a user rule is never touched", async () => {
    const bed = runHomeBed();
    const p = project(bed);
    put(join(p.root, ".winter", "rules", "x.md"), "plain rule\n");
    put(join(bed.sdk, "rules", "mine.md"), "user rule @./nope.md\n");
    const runHome = await buildRunHome(inputFor(bed, { cwd: p.root, trustedProjectRoot: p.root, gitRoot: p.root }));
    expect(lstatSync(join(runHome.dir, "rules", ruleName)).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(runHome.dir, "rules", "mine.md")).isSymbolicLink()).toBe(true);
  });
});
