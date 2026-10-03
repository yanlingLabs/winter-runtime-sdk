// A recorded input -> output corpus for the runtime-compatible frontmatter reading: 18 named shapes, then
// 2000 generated markdown files -- BOMs, CRLF, `----`/`--- x`/`---name` openers, closers mid-line or
// missing, tab indentation, loose values the first YAML pass rejects, inline lists, quotes, comments,
// typed scalars and raw random text. Each row holds what `parseClaudeFrontmatter` (frontmatter, body,
// matched, error), `claudeFrontmatterSplit` (head, body) and `strictFrontmatterBlock` answered when the
// corpus was recorded (`null` = absent).
//
// Encoding: an object is `{"$obj": {...}}` (so a `__proto__` key survives as data), `undefined` is
// `{"$undefined": true}`, non-finite numbers and -0 are `{"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}`.
// The answers (the error texts especially) depend on Bun's YAML parser; recorded under Bun 1.3.14.
import { expect, test } from "bun:test";
import { claudeFrontmatterSplit, parseClaudeFrontmatter, strictFrontmatterBlock } from "../../src/run-home/claude-frontmatter.ts";
import corpus from "./__corpus__/claude-frontmatter.json";

function decode(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decode);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o["$undefined"] === true) return undefined;
    if (typeof o["$num"] === "string") return o["$num"] === "-0" ? -0 : Number(o["$num"]);
    if (typeof o["$date"] === "string") return new Date(o["$date"]);
    const inner = o["$obj"] as Record<string, unknown>;
    return Object.fromEntries(Object.keys(inner).map((key) => [key, decode(inner[key])]));
  }
  return v;
}

interface Row {
  text: string;
  frontmatter: unknown;
  body: string;
  matched: boolean;
  error: string | null;
  head: string;
  splitBody: string;
  strict: string | null;
}

test("the recorded corpus reads exactly as recorded", () => {
  const rows = corpus as Row[];
  expect(rows.length).toBe(2018);
  const mismatches = rows.filter((row) => {
    const p = parseClaudeFrontmatter(row.text)!;
    const split = claudeFrontmatterSplit(row.text);
    return (
      p.body !== row.body ||
      p.matched !== row.matched ||
      (p.error ?? null) !== row.error ||
      !Bun.deepEquals(p.frontmatter, decode(row.frontmatter), true) ||
      split.head !== row.head ||
      split.body !== row.splitBody ||
      (strictFrontmatterBlock(row.text) ?? null) !== row.strict
    );
  });
  expect(mismatches.map((row) => row.text)).toEqual([]);
});
