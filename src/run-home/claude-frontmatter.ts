// THE OFFICIAL RUNTIME'S FRONTMATTER READING, reproduced so both runtimes read a copied file alike.
//
// An agent definition's `permissionMode` and `memory` must be removed or rewritten BEFORE either runtime
// reads the copy (spec §3.3, F19c). A line editor cannot do that: the runtime parses YAML, and YAML has
// many spellings of one key/value — a quoted key, a duplicate key (the last wins), a flow mapping, a
// `<<:` merge, an alias, a tag (`!!str project`), a block scalar, a value on the next line, a leading
// BOM, CRLF line ends. So the builder parses EXACTLY as the runtime does and rewrites from the parsed
// object, never from the text: one leading BOM ignored, the `---` split, a YAML parse with one
// quote-and-detab retry, and anything that is not a plain object read as `{}`.
//
// `Bun.YAML` is the runtime's own parser. Where it is absent (a Node host), nothing here can promise the
// runtime's reading, so the callers treat every frontmatter as unparseable and skip the item (reported).

interface BunYaml {
  parse(text: string): unknown;
  stringify(value: unknown, replacer: null, indent: number): string;
}

/** The runtime's YAML (Bun's), or `undefined` when this process is not Bun. */
export function bunYaml(): BunYaml | undefined {
  const yaml = (globalThis as { Bun?: { YAML?: BunYaml } }).Bun?.YAML;
  return yaml !== undefined && typeof yaml.parse === "function" && typeof yaml.stringify === "function" ? yaml : undefined;
}

export interface ClaudeFrontmatter {
  /** What the runtime reads as the frontmatter (`{}` when absent or unparseable). */
  frontmatter: Record<string, unknown>;
  /** The body after the frontmatter (the whole text when there is none). */
  body: string;
  /** Whether the text HAS a frontmatter block by the runtime's own split. */
  matched: boolean;
  /** Set when the block matched and failed to parse both ways (the runtime then reads `{}`). */
  error?: string;
}

/**
 * The runtime's frontmatter SPLIT alone — no YAML needed: `head` is everything the runtime reads as the
 * frontmatter block (a leading BOM included), `body` is what it reads as content. With no block, `head` is
 * empty and `body` is the text as given. The body is exactly what the runtime scans for `@imports`, and
 * the Winter SDK's rule loader splits the same way.
 */
export function claudeFrontmatterSplit(text: string): { head: string; body: string } {
  const fence = locateFence(text);
  if (fence === undefined) return { head: "", body: text };
  return { head: text.slice(0, fence.bodyStart), body: text.slice(fence.bodyStart) };
}

/** The runtime's reading of a markdown file's frontmatter. `undefined` when no YAML parser is available. */
export function parseClaudeFrontmatter(text: string): ClaudeFrontmatter | undefined {
  const yaml = bunYaml();
  if (yaml === undefined) return undefined;
  const fence = locateFence(text);
  if (fence === undefined) return { frontmatter: {}, body: text, matched: false };
  const body = text.slice(fence.bodyStart);
  const block = text.slice(fence.blockStart, fence.blockEnd);

  let parsed: unknown;
  try {
    parsed = yaml.parse(block);
  } catch {
    // Only a failed first parse earns the repaired retry.
    try {
      parsed = yaml.parse(expandLeadingTabs(quoteLooseScalars(block, yaml)));
    } catch (retryError) {
      return { frontmatter: {}, body, matched: true, error: retryError instanceof Error ? retryError.message : String(retryError) };
    }
  }
  return { frontmatter: asPlainRecord(parsed), body, matched: true };
}

/** The block the strict split captures (its close on a line of its own), or `undefined` when it does not match. */
export function strictFrontmatterBlock(text: string): string | undefined {
  // Opener on a line of its own (trailing blanks allowed), the shortest block, then a closing `---`
  // that is followed only by blanks up to a line break or the end of the text.
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return match === null ? undefined : match[1];
}

/** Offsets into the ORIGINAL text of the lenient split: where the block starts/ends and where the body starts. */
interface FenceOffsets {
  blockStart: number;
  blockEnd: number;
  bodyStart: number;
}

const SPACE_LIKE = /\s/;

function endOfWhitespaceRun(text: string, from: number): number {
  let at = from;
  while (at < text.length && SPACE_LIKE.test(text.charAt(at))) at++;
  return at;
}

/**
 * The lenient split. One leading U+FEFF is stepped over; then `---` must start the text and be followed by
 * whitespace containing an LF. The block begins after the last LF of that whitespace and ends at the next
 * `---` anywhere; that `---` and every whitespace character after it form the closer.
 */
function locateFence(text: string): FenceOffsets | undefined {
  const origin = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.slice(origin, origin + 3) !== "---") return undefined;
  const openerRunEnd = endOfWhitespaceRun(text, origin + 3);
  let lastLineFeed = -1;
  for (let at = origin + 3; at < openerRunEnd; at++) if (text.charAt(at) === "\n") lastLineFeed = at;
  if (lastLineFeed === -1) return undefined;
  const blockStart = lastLineFeed + 1;
  const blockEnd = text.indexOf("---", blockStart);
  if (blockEnd === -1) return undefined;
  return { blockStart, blockEnd, bodyStart: endOfWhitespaceRun(text, blockEnd + 3) };
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const LOOSE_KEY_LINE = /^([A-Za-z_-]+):(\s+)/;
const BREAKS_INSIDE_LINE = /[\r\u2028\u2029]/;
const FLOW_OR_TAG_CHARS = /[{}[\]*&#!|>%@`]/;

/**
 * The repair before the retry: a column-0 `key: value` line whose value holds a YAML indicator character
 * (or a colon-space) is rewritten as `key: "value"` with backslashes and double quotes escaped, unless the
 * value is a valid flow list or is already wrapped in matching quotes. Lines are split on LF alone, so a
 * line still carrying a CR (or any other line break) is left alone.
 */
function quoteLooseScalars(block: string, yaml: BunYaml): string {
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const head = LOOSE_KEY_LINE.exec(line);
    if (head === null) continue;
    const value = line.slice(head[0].length);
    if (value === "" || BREAKS_INSIDE_LINE.test(value)) continue;
    if (value.startsWith("[") && value.endsWith("]") && parsesAsList(value, yaml)) continue;
    const first = value.charAt(0);
    if ((first === '"' || first === "'") && value.endsWith(first)) continue;
    if (!FLOW_OR_TAG_CHARS.test(value) && !value.includes(": ")) continue;
    const escaped = value.split("\\").join("\\\\").split('"').join('\\"');
    lines[index] = `${head[1]}: "${escaped}"`;
  }
  return lines.join("\n");
}

function parsesAsList(value: string, yaml: BunYaml): boolean {
  try {
    return Array.isArray(yaml.parse(value));
  } catch {
    return false;
  }
}

/** Every leading run of tabs (at the text start or after LF, CR, U+2028, U+2029) becomes two spaces per tab. */
function expandLeadingTabs(text: string): string {
  return text.replace(/^\t+/gm, (run) => " ".repeat(run.length * 2));
}

/** A stable deep-equality over parsed YAML values (plain data). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Date) return `D${value.toISOString()}`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Writes `frontmatter` + `body` as one markdown file and PROVES the runtime reads it back as exactly
 * that object and body — by its own split, by the strict split, and by its own parse. `undefined` when
 * the proof fails (the caller skips the item rather than hand a runtime a file it would read differently).
 */
export function serializeClaudeFrontmatter(frontmatter: Record<string, unknown>, body: string): string | undefined {
  const yaml = bunYaml();
  if (yaml === undefined) return undefined;
  let block: string;
  try {
    block = yaml.stringify(frontmatter, null, 2);
  } catch {
    return undefined;
  }
  const text = `---\n${block}\n---\n${body}`;
  const back = parseClaudeFrontmatter(text);
  if (back === undefined || !back.matched || back.error !== undefined || back.body !== body || canonical(back.frontmatter) !== canonical(frontmatter)) return undefined;
  if (strictFrontmatterBlock(text) !== block) return undefined;
  return text;
}
