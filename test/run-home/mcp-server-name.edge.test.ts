// Edge cases of `normalizeMcpServerName`: the form of an MCP server name that tool names are spelled from.
import { describe, expect, test } from "bun:test";
import { normalizeMcpServerName } from "../../src/run-home/mcp.ts";

describe("normalizeMcpServerName", () => {
  test("letters, digits, _ and - are kept; an empty name stays empty", () => {
    expect(normalizeMcpServerName("ok_name-1")).toBe("ok_name-1");
    expect(normalizeMcpServerName("")).toBe("");
  });

  test("every other character becomes one `_`, and runs are NOT collapsed for an ordinary name", () => {
    expect(normalizeMcpServerName("a..b")).toBe("a__b");
    expect(normalizeMcpServerName("winter..browser")).toBe("winter__browser");
    expect(normalizeMcpServerName("a b/c")).toBe("a_b_c");
    expect(normalizeMcpServerName(" claude.ai x")).toBe("_claude_ai_x");
  });

  test("replacement is per UTF-16 code unit: a non-ASCII letter is one `_`, an astral emoji is two", () => {
    expect(normalizeMcpServerName("é")).toBe("_");
    expect(normalizeMcpServerName("😀")).toBe("__");
  });

  test("a name starting with exactly `claude.ai ` (with the space) also collapses runs of `_` and trims one at each end", () => {
    expect(normalizeMcpServerName("claude.ai  My Server!")).toBe("claude_ai_My_Server");
    expect(normalizeMcpServerName("claude.ai __x__")).toBe("claude_ai_x");
    expect(normalizeMcpServerName("claude.ai a___b")).toBe("claude_ai_a_b");
    expect(normalizeMcpServerName("claude.ai ")).toBe("claude_ai");
    expect(normalizeMcpServerName("claude.ai _")).toBe("claude_ai");
  });

  test("the `claude.ai ` prefix is case-sensitive and needs its space", () => {
    expect(normalizeMcpServerName("claude.ai")).toBe("claude_ai");
    expect(normalizeMcpServerName("claude.ai..x")).toBe("claude_ai__x");
    expect(normalizeMcpServerName("Claude.ai  x")).toBe("Claude_ai__x");
  });
});
