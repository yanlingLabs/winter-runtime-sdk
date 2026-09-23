// A LINE-PRESERVING YAML FRONTMATTER EDITOR — just enough for the run home's two rewrites (an agent's
// `permissionMode`/`memory`, a rule's `paths:`), and deliberately no more.
//
// NOT A YAML PARSER, on purpose. A parse-and-reserialize round trip would reformat the whole block —
// quoting, comments, key order, a multi-line description — and the run home's promise is that an item
// reaches the runtime exactly as its author wrote it, minus the named edits. So the block is kept as
// lines, a top-level key is a line matching `^<key>:` at column 0, and its value is that line's tail
// plus any following INDENTED lines (a YAML block sequence or mapping belongs to the key above it).
// Everything else passes through byte for byte.

export interface FrontmatterDocument {
  /** The lines between the opening and closing `---`, without their line terminators. */
  lines: string[];
  /** Everything after the closing `---` line, verbatim (its leading newline included). */
  body: string;
  /** The terminator the file uses, so the rewrite keeps it. */
  newline: "\n" | "\r\n";
}

/** Splits a markdown file into frontmatter lines and body; `undefined` when it has no frontmatter. */
export function splitFrontmatter(text: string): FrontmatterDocument | undefined {
  const newline: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const all = text.split(newline);
  if (all[0]?.trimEnd() !== "---") return undefined;
  const end = all.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end < 0) return undefined;
  return { lines: all.slice(1, end), body: all.slice(end + 1).join(newline), newline };
}

export function joinFrontmatter(doc: FrontmatterDocument): string {
  return ["---", ...doc.lines, "---", doc.body].join(doc.newline);
}

const topLevelKey = (line: string): string | undefined => /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line)?.[1];
const isContinuation = (line: string): boolean => line.length === 0 || /^[\s]/.test(line) || line.trimStart().startsWith("#");

/** The index range `[start, end)` a top-level key occupies, including its indented continuation. */
export function keyRange(lines: readonly string[], key: string): [number, number] | undefined {
  const start = lines.findIndex((line) => topLevelKey(line) === key);
  if (start < 0) return undefined;
  let end = start + 1;
  // Trailing blank or comment lines belong to nobody; only INDENTED lines are this key's.
  while (end < lines.length && isContinuation(lines[end]!) && /^\s/.test(lines[end]!)) end += 1;
  return [start, end];
}

/** The scalar on a key's own line, unquoted; `undefined` when absent or when the value is a block. */
export function scalarOf(lines: readonly string[], key: string): string | undefined {
  const range = keyRange(lines, key);
  if (range === undefined) return undefined;
  const raw = lines[range[0]]!.slice(lines[range[0]]!.indexOf(":") + 1).replace(/\s+#.*$/, "").trim();
  if (raw.length === 0) return undefined;
  return unquote(raw);
}

export function unquote(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
  return raw;
}

/** Removes a top-level key and its continuation lines. */
export function removeKey(lines: string[], key: string): boolean {
  const range = keyRange(lines, key);
  if (range === undefined) return false;
  lines.splice(range[0], range[1] - range[0]);
  return true;
}

/** Replaces a top-level key (and its continuation) with the given lines. */
export function replaceKey(lines: string[], key: string, replacement: readonly string[]): boolean {
  const range = keyRange(lines, key);
  if (range === undefined) return false;
  lines.splice(range[0], range[1] - range[0], ...replacement);
  return true;
}

/**
 * A key's value as a list of strings: an inline `[a, "b"]` flow sequence, a block sequence of `- item`
 * lines, or a single scalar (claude accepts a bare string for `paths`). `undefined` when absent.
 */
export function listOf(lines: readonly string[], key: string): string[] | undefined {
  const range = keyRange(lines, key);
  if (range === undefined) return undefined;
  const head = lines[range[0]]!.slice(lines[range[0]]!.indexOf(":") + 1).replace(/\s+#.*$/, "").trim();
  if (head.startsWith("[")) {
    const inner = head.replace(/^\[/, "").replace(/\]$/, "");
    return inner
      .split(",")
      .map((item) => unquote(item.trim()))
      .filter((item) => item.length > 0);
  }
  if (head.length > 0) {
    // A comma-separated scalar is claude's own shorthand for several globs.
    return unquote(head)
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  const items: string[] = [];
  for (const line of lines.slice(range[0] + 1, range[1])) {
    const match = /^\s*-\s*(.*)$/.exec(line);
    if (match !== null && match[1]!.trim().length > 0) items.push(unquote(match[1]!.replace(/\s+#.*$/, "").trim()));
  }
  return items;
}
