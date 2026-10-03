// A recorded input -> output corpus for `normalizeMcpServerName`: 2000 generated server names -- dots,
// spaces, slashes, colons, runs of `_`, non-ASCII and astral characters, NUL, with and without the
// `claude.ai ` prefix (and near-misses of it) -- with the normalised form recorded for each.
import { expect, test } from "bun:test";
import { normalizeMcpServerName } from "../../src/run-home/mcp.ts";
import corpus from "./__corpus__/mcp-server-name.json";

test("the recorded corpus normalises exactly as recorded", () => {
  const rows = corpus as Array<{ name: string; expected: string }>;
  expect(rows.length).toBe(2000);
  expect(rows.filter((row) => normalizeMcpServerName(row.name) !== row.expected)).toEqual([]);
});
