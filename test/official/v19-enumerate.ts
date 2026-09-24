// V19 (WS-21 §7.3): EVERY DIRECT PER-SOURCE SETTINGS READ OF THE PINNED RUNTIME, ENUMERATED LIVE.
//
// `settingSources: ["user"]` gates the runtime's DISCOVERY, not all of its reads: the pinned binary also
// reads a source's settings file directly (`<reader>("projectSettings")`), whatever the enabled sources
// are (F19b). On a WS-21 session the cwd is the user's repository, so those reads see the repository's
// own `.claude/settings.json` and `.claude/settings.local.json`. Every key read that way must be closed —
// pinned in the flag layer, neutralised by an env variable the router sets, or harmless for a stated
// reason — and a new pinned version that adds one must fail until someone has classified it.
//
// THE ENUMERATION IS THE PIN'S, NOT OURS. It runs over the binary's embedded JS (read as latin1), finds
// the minified per-source reader(s) by their CALL SHAPE — an identifier called with the literal
// `"projectSettings"` whose result is used as an object — cross-checked against `"localSettings"`, and
// collects every key read through them, in the four shapes the pinned source uses:
//
//   chained    `R("projectSettings")?.key`
//   assigned   `let t=R("projectSettings"); … t?.key`   (and `helper(t)` → the helper's `p?.key`)
//   iterated   `for(let E of["projectSettings","localSettings"]) … R(E)?.key`
//   listed     `[…, R("localSettings"), …].some((t)=>t?.key …)`
//
// A computed access (`?.[e]`) is recorded as the key `<dynamic>`.
import { readFileSync } from "node:fs";

export interface V19Read {
  reader: string;
  source: "projectSettings" | "localSettings";
  key: string;
  shape: "chained" | "assigned" | "helper" | "iterated" | "listed";
}

const IDENT = "[A-Za-z_$][\\w$]*";
/** Array methods a helper may call on what a rules reader returns — never settings keys. */
const ARRAY_METHODS: ReadonlySet<string> = new Set(["some", "every", "map", "filter", "find", "findIndex", "includes", "forEach", "reduce", "flatMap", "length", "slice", "join"]);
const SOURCES = ["projectSettings", "localSettings"] as const;

/** Every property read on `name` in `text`: `name?.key`, `name.key`, `name?.[…]`. */
function propertyReads(text: string, name: string): string[] {
  const escaped = name.replace(/\$/g, "\\$");
  const re = new RegExp(`(?<![\\w$.])${escaped}(?:\\?\\.|\\.)(\\[|${IDENT})`, "g");
  const out: string[] = [];
  for (const match of text.matchAll(re)) out.push(match[1] === "[" ? "<dynamic>" : (match[1] as string));
  return out;
}

/** The body of `function name(param){…}` nearest to `at`, brace-matched; `undefined` when not found. */
function helperBody(js: string, name: string, at: number): { param: string; body: string } | undefined {
  const escaped = name.replace(/\$/g, "\\$");
  const re = new RegExp(`function ${escaped}\\((${IDENT})\\)\\{`, "g");
  const from = Math.max(0, at - 40_000);
  let best: { index: number; param: string } | undefined;
  for (const match of js.slice(from, at + 40_000).matchAll(re)) {
    const index = from + (match.index ?? 0);
    if (best === undefined || Math.abs(index - at) < Math.abs(best.index - at)) best = { index, param: match[1] as string };
  }
  if (best === undefined) return undefined;
  const start = js.indexOf("{", best.index) + 1;
  let depth = 1;
  let end = start;
  while (end < js.length && end < start + 4000 && depth > 0) {
    const ch = js[end];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    end += 1;
  }
  return { param: best.param, body: js.slice(start, end - 1) };
}

/**
 * The regions of the binary worth scanning: every occurrence of a quoted source literal, widened. The
 * binary is ~200 MB; the reads are all within a few thousand characters of the literal they name.
 */
function sourceWindows(js: string, radius = 2500): Array<{ start: number; text: string }> {
  const spans: Array<[number, number]> = [];
  for (const literal of ['"projectSettings"', '"localSettings"']) {
    for (let at = js.indexOf(literal); at >= 0; at = js.indexOf(literal, at + literal.length)) spans.push([Math.max(0, at - radius), Math.min(js.length, at + radius)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged.map(([start, end]) => ({ start, text: js.slice(start, end) }));
}

/** The live enumeration over one JS text. */
export function enumerateV19Reads(js: string): { readers: string[]; reads: V19Read[] } {
  const windows = sourceWindows(js);
  // 1. READERS: called with a literal source, the result used as an object somewhere, and called with
  //    BOTH sources somewhere (the cross-check) — never a method call (`.push("projectSettings")`).
  const called = (source: string): Set<string> => {
    const re = new RegExp(`(?<![\\w$.])(${IDENT})\\("${source}"\\)`, "g");
    const out = new Set<string>();
    for (const window of windows) for (const match of window.text.matchAll(re)) out.add(match[1] as string);
    return out;
  };
  const project = called("projectSettings");
  const local = called("localSettings");
  const usedAsObject = (name: string): boolean => {
    const escaped = name.replace(/\$/g, "\\$");
    const chained = new RegExp(`(?<![\\w$.])${escaped}\\("(?:projectSettings|localSettings)"\\)(?:\\?\\.|\\.)[A-Za-z_$\\[]`);
    const assigned = new RegExp(`=${escaped}\\("(?:projectSettings|localSettings)"\\)`);
    return windows.some((window) => chained.test(window.text) || assigned.test(window.text));
  };
  const readers = [...project].filter((name) => local.has(name) && usedAsObject(name)).sort();
  const reads: V19Read[] = [];
  const add = (read: V19Read): void => {
    if (!reads.some((r) => r.reader === read.reader && r.source === read.source && r.key === read.key && r.shape === read.shape)) reads.push(read);
  };
  for (const window of windows) {
    const text = window.text;
    for (const reader of readers) {
      const escaped = reader.replace(/\$/g, "\\$");
      for (const source of SOURCES) {
        // chained
        for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\("${source}"\\)(?:\\?\\.|\\.)(\\[|${IDENT})`, "g"))) {
          add({ reader, source, key: match[1] === "[" ? "<dynamic>" : (match[1] as string), shape: "chained" });
        }
        // assigned (and the helpers the variable is handed to)
        for (const match of text.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})=${escaped}\\("${source}"\\)`, "g"))) {
          const variable = match[1] as string;
          const at = (match.index ?? 0) + match[0].length;
          const next = text.indexOf("function ", at);
          const scope = text.slice(at, Math.min(at + 800, next < 0 ? at + 800 : next));
          for (const key of propertyReads(scope, variable)) add({ reader, source, key, shape: "assigned" });
          for (const call of scope.matchAll(new RegExp(`(?<![\\w$.])(${IDENT})\\(${variable.replace(/\$/g, "\\$")}[,)]`, "g"))) {
            const helper = helperBody(js, call[1] as string, window.start + at);
            if (helper === undefined) continue;
            // A helper handed a reader that returns an ARRAY (a source's permission rules) calls array
            // methods on it; those are not settings keys.
            for (const key of propertyReads(helper.body, helper.param)) if (!ARRAY_METHODS.has(key)) add({ reader, source, key, shape: "helper" });
          }
        }
        // listed: the reader call inside an array literal that is then `.some((t)=>t?.key…)`
        for (const match of text.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\("${source}"\\)`, "g"))) {
          const at = match.index ?? 0;
          const tail = text.slice(at, at + 300);
          const listed = /^[^;{}]*?\]\.some\(\((\w+)\)=>/.exec(tail);
          if (listed === null) continue;
          const param = listed[1] as string;
          const body = tail.slice(listed[0].length, listed[0].length + 120);
          for (const key of propertyReads(body, param)) add({ reader, source, key, shape: "listed" });
        }
      }
      // iterated: `for(let E of[…"projectSettings"…])` then `R(E)?.key`
      for (const match of text.matchAll(/for\(let (\w+) of\[([^\]]*)\]\)/g)) {
        const list = match[2] as string;
        const sources = SOURCES.filter((source) => list.includes(`"${source}"`));
        if (sources.length === 0) continue;
        const variable = match[1] as string;
        const at = (match.index ?? 0) + match[0].length;
        const scope = text.slice(at, at + 400);
        for (const call of scope.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\(${variable}\\)(?:\\?\\.|\\.)(\\[|${IDENT})`, "g"))) {
          for (const source of sources) add({ reader, source, key: call[1] === "[" ? "<dynamic>" : (call[1] as string), shape: "iterated" });
        }
      }
    }
  }
  reads.sort((a, b) => (a.key + a.source + a.shape < b.key + b.source + b.shape ? -1 : 1));
  return { readers, reads };
}

/** The pinned binary's text, latin1 (the embedded JS is ASCII; the rest is never matched). */
export function readBinaryText(path: string): string {
  return readFileSync(path, "latin1");
}
