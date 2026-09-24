// THE OFFICIAL RUNTIME'S OWN FRONTMATTER PARSE, ported from the pinned binary (0.3.250), step for step.
//
// An agent definition's `permissionMode` and `memory` must be removed or rewritten BEFORE either runtime
// reads the copy (spec §3.3, F19c). A line editor cannot do that: the runtime parses YAML, and YAML has
// many spellings of one key/value — a quoted key, a duplicate key (the last wins), a flow mapping, a
// `<<:` merge, an alias, a tag (`!!str project`), a block scalar, a value on the next line, a leading
// BOM, CRLF line ends. So the builder parses EXACTLY as the runtime does and rewrites from the parsed
// object, never from the text:
//
//   1. strip one leading BOM                                   (the pin's `gE`)
//   2. match `/^---\s*\n([\s\S]*?)---\s*\n?/`                   (the pin's `fR`) — no match, no frontmatter
//   3. `Bun.YAML.parse(block)`; on a throw, quote loosely-typed values and turn leading tabs into two
//      spaces each, and parse once more                          (the pin's `kdn` and `M`)
//   4. anything that is not a plain object reads as `{}`         (the pin's `E`)
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

/** The pin's `fR`. */
const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)---\s*\n?/;
/** The pin's own STRICT split (`eSe`, used by its rewrite-hazard check): the close is a line of its own. */
const STRICT_FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;
/** The pin's `v`: a value with one of these needs quoting before it can be read as a string. */
const LOOSE_VALUE_RE = /[{}[\]*&#!|>%@`]|: /;

const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The pin's `M`: quote `key: value` lines whose value would otherwise not read as a plain string. */
function quoteLooseValues(yaml: BunYaml, block: string): string {
  const out: string[] = [];
  for (const line of block.split("\n")) {
    const match = /^([a-zA-Z_-]+):\s+(.+)$/.exec(line);
    if (match !== null) {
      const key = match[1];
      const value = match[2];
      if (!key || !value) {
        out.push(line);
        continue;
      }
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        out.push(line);
        continue;
      }
      if (value.startsWith("[") && value.endsWith("]")) {
        try {
          if (Array.isArray(yaml.parse(value))) {
            out.push(line);
            continue;
          }
        } catch {
          /* fall through, as the pin does */
        }
      }
      if (LOOSE_VALUE_RE.test(value)) {
        out.push(`${key}: "${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/** The pin's `kdn`. */
function parseBlock(yaml: BunYaml, block: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: yaml.parse(block) };
  } catch {
    try {
      const retried = quoteLooseValues(yaml, block).replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
      return { ok: true, value: yaml.parse(retried) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

const asObject = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

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
 * The pin's own frontmatter SPLIT alone (one BOM strip, then `fR`) — no YAML needed: `head` is everything
 * the runtime reads as the frontmatter block (the BOM included), `body` is what it reads as content. With
 * no block, `head` is empty and `body` is the text as given (the pin returns the original text there).
 * The body is exactly what the runtime scans for `@imports` (`jBe` lexes the split's content), and the
 * Winter SDK's rule loader splits with the same regex.
 */
export function claudeFrontmatterSplit(text: string): { head: string; body: string } {
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const match = FRONTMATTER_RE.exec(text.slice(bom));
  if (match === null) return { head: "", body: text };
  const end = bom + match[0].length;
  return { head: text.slice(0, end), body: text.slice(end) };
}

/** The runtime's reading of a markdown file's frontmatter. `undefined` when no YAML parser is available. */
export function parseClaudeFrontmatter(text: string): ClaudeFrontmatter | undefined {
  const yaml = bunYaml();
  if (yaml === undefined) return undefined;
  const stripped = stripBom(text);
  const match = FRONTMATTER_RE.exec(stripped);
  if (match === null) return { frontmatter: {}, body: text, matched: false };
  const block = match[1] ?? "";
  const body = stripped.slice(match[0].length);
  const parsed = parseBlock(yaml, block);
  if (!parsed.ok) return { frontmatter: {}, body, matched: true, error: parsed.error };
  return { frontmatter: asObject(parsed.value), body, matched: true };
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
  const strict = STRICT_FRONTMATTER_RE.exec(text);
  if (strict === null || strict[1] !== block) return undefined;
  return text;
}
