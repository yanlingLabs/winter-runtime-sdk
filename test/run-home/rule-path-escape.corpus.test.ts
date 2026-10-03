// A recorded input -> output corpus for `escapeRulePath`: 2000 generated path-like strings dense in
// backslashes, brackets, parens, `| + ^ $ * ?`, leading `!`/`#`, trailing ASCII and Unicode whitespace,
// non-ASCII text and NUL, with the rule-content spelling recorded for each.
import { expect, test } from "bun:test";
import { escapeRulePath } from "../../src/run-home/types.ts";
import corpus from "./__corpus__/rule-path-escape.json";

test("the recorded corpus escapes exactly as recorded", () => {
  const rows = corpus as Array<{ path: string; expected: string }>;
  expect(rows.length).toBe(2000);
  expect(rows.filter((row) => escapeRulePath(row.path) !== row.expected)).toEqual([]);
});
