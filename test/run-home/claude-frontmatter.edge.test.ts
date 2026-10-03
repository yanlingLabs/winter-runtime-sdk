// Edge cases of the runtime-compatible frontmatter reading: the split (`claudeFrontmatterSplit`), the
// parse with its one quote-and-detab retry (`parseClaudeFrontmatter`), the strict split
// (`strictFrontmatterBlock`) and the round-trip proof (`serializeClaudeFrontmatter`). Every expectation
// is the current behaviour, recorded.
import { describe, expect, test } from "bun:test";
import { claudeFrontmatterSplit, parseClaudeFrontmatter, serializeClaudeFrontmatter, strictFrontmatterBlock } from "../../src/run-home/claude-frontmatter.ts";

const parse = (text: string) => parseClaudeFrontmatter(text)!;
const fm = (block: string) => parse(`---\n${block}\n---\nbody`).frontmatter;

describe("parseClaudeFrontmatter: the split and the result shape", () => {
  test("no fence: matched false, body is the text as given (a leading BOM kept)", () => {
    expect(parse("just text")).toEqual({ frontmatter: {}, body: "just text", matched: false });
    expect(parse("\uFEFFno fence")).toEqual({ frontmatter: {}, body: "\uFEFFno fence", matched: false });
    expect(parse("\uFEFF\uFEFF---\nname: x\n---\nbody")).toEqual({ frontmatter: {}, body: "\uFEFF\uFEFF---\nname: x\n---\nbody", matched: false });
  });

  test("one leading BOM is ignored for the fence and is not part of the body", () => {
    expect(parse("\uFEFF---\nname: x\n---\nbody")).toEqual({ frontmatter: { name: "x" }, body: "body", matched: true });
  });

  test("`----` and `---name` are not opening fences", () => {
    expect(parse("----\nname: x\n---\nbody").matched).toBe(false);
    expect(parse("---name: x\n---\nbody").matched).toBe(false);
  });

  test("the block ends at the first `---` anywhere, and whitespace after it (blank lines too) is consumed", () => {
    expect(parse("---\nname: a---b\n---\nbody")).toEqual({ frontmatter: { name: "a" }, body: "b\n---\nbody", matched: true });
    expect(parse("---\nname: x\n---\n\n\nbody")).toEqual({ frontmatter: { name: "x" }, body: "body", matched: true });
  });

  test("an empty block or a non-mapping document is matched and reads as {} with no error", () => {
    expect(parse("---\n---\n")).toEqual({ frontmatter: {}, body: "", matched: true });
    expect(parse("---\n- a\n---\nb")).toEqual({ frontmatter: {}, body: "b", matched: true });
  });

  test("a block neither attempt can parse: {} plus the second attempt's error message", () => {
    expect(parse("---\nname: x\nnot valid !!\n---\nbody")).toEqual({ frontmatter: {}, body: "body", matched: true, error: "YAML Parse error: Unexpected token" });
  });

  test("the retry rescues a loose value and a tab after a bare CR", () => {
    expect(fm("name: x\ndescription: Use when: foo")).toEqual({ name: "x", description: "Use when: foo" });
    expect(fm("k: v\r\tw")).toEqual({ k: "v w" });
    expect(fm("k: a: b\nm: v\u2028\tw")).toEqual({ k: "a: b", m: "v\u2028  w" });
  });

  test("the retry leaves CR-terminated lines and digit-bearing keys unquoted", () => {
    expect(parse("---\r\nname: x\r\ndescription: Use when: foo\r\n---\r\nbody").frontmatter).toEqual({});
    expect(fm("key1: a: b")).toEqual({});
  });

  test("the retry keeps an already-valid inline list and escapes quotes and backslashes in what it quotes", () => {
    expect(fm('description: Use when: foo\ntools: ["Bash(git add, commit)", Read]')).toEqual({ description: "Use when: foo", tools: ["Bash(git add, commit)", "Read"] });
    expect(fm('name: a: "b" \\ c')).toEqual({ name: 'a: "b" \\ c' });
  });

  test("the retry skips a value already wrapped in matching quotes: a double-quoted `a: b` keeps its content", () => {
    const result = parse('---\nk: "a: b"\nname: x: y\n---\n');
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toEqual({ k: "a: b", name: "x: y" });
  });

  test("the retry skips a value already wrapped in matching quotes: a single-quoted `a: b` keeps its content", () => {
    const result = parse("---\nk: 'a: b'\nname: x: y\n---\n");
    expect(result.error).toBeUndefined();
    expect(result.frontmatter).toEqual({ k: "a: b", name: "x: y" });
  });
});

describe("claudeFrontmatterSplit", () => {
  test("head is everything read as the frontmatter block, the BOM and the consumed whitespace included", () => {
    expect(claudeFrontmatterSplit("\uFEFF---\nname: x\n---\nbody")).toEqual({ head: "\uFEFF---\nname: x\n---\n", body: "body" });
    expect(claudeFrontmatterSplit("---\nname: x\n---\n\n\nbody")).toEqual({ head: "---\nname: x\n---\n\n\n", body: "body" });
    expect(claudeFrontmatterSplit("---\nname: a---b\n---\nbody")).toEqual({ head: "---\nname: a---", body: "b\n---\nbody" });
  });

  test("no block: empty head, the text as given", () => {
    expect(claudeFrontmatterSplit("just text")).toEqual({ head: "", body: "just text" });
    expect(claudeFrontmatterSplit("\uFEFF\uFEFF---\nx\n---\n")).toEqual({ head: "", body: "\uFEFF\uFEFF---\nx\n---\n" });
  });

  test("the split needs no parse: an unparseable block still splits", () => {
    expect(claudeFrontmatterSplit("---\nname: x\nnot valid !!\n---\nbody")).toEqual({ head: "---\nname: x\nnot valid !!\n---\n", body: "body" });
  });
});

describe("strictFrontmatterBlock (the close on a line of its own)", () => {
  test("a fence line may carry trailing spaces/tabs and CRLF; the line break before the close is not part of the block", () => {
    expect(strictFrontmatterBlock("---\na: 1\n---\nbody")).toBe("a: 1");
    expect(strictFrontmatterBlock("---  \t\r\na: 1\r\n---\t \r\nbody")).toBe("a: 1");
    expect(strictFrontmatterBlock("---\na\r\n---")).toBe("a");
    expect(strictFrontmatterBlock("---\na: 1\n---")).toBe("a: 1");
  });

  test("a `---` that is not alone on its line does not close; the first real close does", () => {
    expect(strictFrontmatterBlock("---\na: 1---\n---\nb")).toBe("a: 1---");
    expect(strictFrontmatterBlock("---\na\n ---\n---\n")).toBe("a\n ---");
    expect(strictFrontmatterBlock("---\na\n---x\n---\n")).toBe("a\n---x");
    expect(strictFrontmatterBlock("---\na\n----\nb")).toBeUndefined();
  });

  test("an empty block needs its own empty line; no BOM is skipped; the opener must end its line", () => {
    expect(strictFrontmatterBlock("---\n---\nb")).toBeUndefined();
    expect(strictFrontmatterBlock("---\n\n---\nb")).toBe("");
    expect(strictFrontmatterBlock("---\n---")).toBeUndefined();
    expect(strictFrontmatterBlock("\uFEFF---\na\n---\n")).toBeUndefined();
    expect(strictFrontmatterBlock("---a\n---\n")).toBeUndefined();
  });
});

describe("serializeClaudeFrontmatter", () => {
  test("writes `---\\n<yaml>\\n---\\n<body>` when the runtime reads it back identically", () => {
    expect(serializeClaudeFrontmatter({}, "body\n")).toBe("---\n{}\n---\nbody\n");
    expect(serializeClaudeFrontmatter({ a: 1 }, "body\n")).toBe("---\na: 1\n---\nbody\n");
    expect(serializeClaudeFrontmatter({ t: "\t" }, "body\n")).toBe('---\nt: "\\t"\n---\nbody\n');
  });

  test("refuses (undefined) anything the lenient split would cut short", () => {
    expect(serializeClaudeFrontmatter({ a: "x\n---\ny" }, "body\n")).toBeUndefined();
    expect(serializeClaudeFrontmatter({ d: "a---b" }, "body\n")).toBeUndefined();
    expect(serializeClaudeFrontmatter({ "---": 1 }, "body\n")).toBeUndefined();
  });
});
