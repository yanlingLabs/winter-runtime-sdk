// Edge cases of `escapeRulePath`: a literal path spelled for the content of a permission rule
// (`Tool(<content>)`). Two layers: a gitignore-pattern escape, then the rule-content escape over it.
import { describe, expect, test } from "bun:test";
import { escapeRulePath } from "../../src/run-home/types.ts";

const B2 = String.raw`\\`; // what one gitignore-layer backslash becomes in the rule string

describe("escapeRulePath: per-character table", () => {
  test("an empty path stays empty", () => {
    expect(escapeRulePath("")).toBe("");
  });

  test("a backslash becomes four backslashes", () => {
    expect(escapeRulePath("\\")).toBe(String.raw`\\\\`);
    expect(escapeRulePath(String.raw`/x/a\b`)).toBe(String.raw`/x/a\\\\b`);
  });

  test("[ ] | + ^ $ * each get a doubled-backslash prefix", () => {
    for (const ch of ["[", "]", "|", "+", "^", "$", "*"]) expect(escapeRulePath(ch)).toBe(`${B2}${ch}`);
  });

  test("( and ) get a doubled backslash plus a rule-content backslash: three backslashes", () => {
    expect(escapeRulePath("(")).toBe(String.raw`\\\(`);
    expect(escapeRulePath(")")).toBe(String.raw`\\\)`);
    expect(escapeRulePath(String.raw`/p (old)/q\(y`)).toBe(String.raw`/p \\\(old\\\)/q\\\\\\\(y`);
  });

  test("? { } . and non-ASCII characters are left as written", () => {
    expect(escapeRulePath("?")).toBe("?");
    expect(escapeRulePath("{}")).toBe("{}");
    expect(escapeRulePath(".")).toBe(".");
    expect(escapeRulePath("/é/😀")).toBe("/é/😀");
  });
});

describe("escapeRulePath: leading ! and #", () => {
  test("a LEADING ! or # is prefixed with a doubled backslash", () => {
    expect(escapeRulePath("!neg")).toBe(String.raw`\\!neg`);
    expect(escapeRulePath("#h")).toBe(String.raw`\\#h`);
  });

  test("a mid-path ! or # is literal", () => {
    expect(escapeRulePath("/a!b#c")).toBe("/a!b#c");
  });

  test("a path that only starts with ! after another escape is not treated as leading (the escape comes first)", () => {
    expect(escapeRulePath(String.raw`\!x`)).toBe(String.raw`\\\\!x`);
  });

  test("a leading ! and trailing whitespace are both escaped", () => {
    expect(escapeRulePath("!x ")).toBe(String.raw`\\!x\\ `);
  });
});

describe("escapeRulePath: whitespace", () => {
  test("leading and inner whitespace is left as written", () => {
    expect(escapeRulePath(" lead")).toBe(" lead");
    expect(escapeRulePath("/x/in side/y")).toBe("/x/in side/y");
  });

  test("every TRAILING whitespace character is escaped one by one", () => {
    expect(escapeRulePath("/x/sp ")).toBe(`/x/sp${B2} `);
    expect(escapeRulePath("  ")).toBe(`${B2} ${B2} `);
    expect(escapeRulePath("/x/tab\t \t")).toBe(`/x/tab${B2}\t${B2} ${B2}\t`);
  });

  test("trailing whitespace includes newlines and Unicode spaces (NBSP, ideographic space), not only ASCII", () => {
    expect(escapeRulePath("/x/a\n")).toBe(`/x/a${B2}\n`);
    expect(escapeRulePath("/x/t ")).toBe(`/x/t${B2} `);
    expect(escapeRulePath("/a　b　")).toBe(`/a　b${B2}　`);
  });
});
