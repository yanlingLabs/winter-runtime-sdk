// THE BRAND SWEEP GATE, ported from the SDK repository (D19; WS-03's Phase 7a amendment: "A sweep
// gate (a test) keeps every raw brand literal out of non-test source except the brand module").
//
// WHY THE ROUTER NEEDS IT TOO. `Options.brand` is worth exactly as much as the number of places that
// actually READ it, and this package is one of the places a brand has to survive: WS-14 §2's Options
// template, §3's child environment, the store paths, the spool root. A profile threaded through nine
// call sites while a tenth keeps a literal does not fail anything, does not look wrong in a diff, and
// produces a reuser whose sessions write half their state into somebody else's product's directory.
// The only way to know the sweep is complete is to make an incomplete sweep fail.
//
// ONE DIFFERENCE FROM THE SDK REPOSITORY'S COPY, and it is a simplification: THERE ARE NO EXCEPTIONS
// HERE. Over there, `packages/sdk/src/brand.ts` is the single module allowed to spell Winter's own
// names, and a baseline list named the files that already carried a literal when the gate landed.
// This package has no brand module (it re-exports the SDK's `BrandProfile`/`WINTER_BRAND`/
// `resolveBrand`) and no history, so it starts at zero: the baseline is empty, a test asserts it is
// empty, and every lane inherits a tree with nothing to sweep.
//
// A RAW OCCURRENCE INCLUDES COMMENTS, deliberately. A comment naming a product path is a statement
// about a path that is no longer necessarily that path, and it is exactly the kind of stale prose
// that teaches the next reader the wrong invariant. Rewording one is cheap; a gate that permitted
// them would have to parse TypeScript to know the difference. (Two literals in this repository were
// found by this gate on the day it landed — a comment naming an MCP tool and a path segment in the
// smoke script — and both were reworded rather than exempted.)
//
// CLAUDE-MIRRORING LITERALS ARE NEVER MATCHED (WS-01 §5, D16/D19): `CLAUDE_CONFIG_DIR`,
// `claude-resume-<uuid>`, `preset: "claude_code"`, `.claude-plugin`, `com.anthropic.claude-code`.
// They are the official runtime's own names; rebranding them would be a lie, not a personalisation.
// No rule matches them, so nothing has to be exempted for them.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The router's two source trees. */
const SCAN_ROOTS = ["src", "scripts"] as const;

/**
 * Rules 1-8: a raw occurrence anywhere in the file, comments included.
 *
 * Each is named, so a failure says WHICH brand surface leaked rather than dumping a regex at the
 * reader. The quote/backtick anchors on the first three are what keep `.winterfoo`, an English
 * sentence containing the word winter, or a WINTER.mdx filename out of the net.
 */
const RAW_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "home/project/plugin dot-dir (brand.homeDirName / projectDirName / pluginManifestDir)", re: /["'`]\.winter[-"'`/]/ },
  { name: "instructions file (brand.instructionsFile)", re: /["'`]WINTER\.md["'`]/ },
  { name: "preset name (brand.presetName)", re: /["'`]winter_code["'`]/ },
  { name: "MCP tool name (mcpToolName(brand, ...))", re: /mcp__winter__/ },
  { name: "keychain service (brand.keychainService)", re: /com\.winter\./ },
  { name: "shared temp root, spelled as a path (brand.tempRootName)", re: /\/private\/tmp\/winter-/ },
  { name: "codex originator (brand.codexOriginator)", re: /originator:\s*["']winter["']/ },
  { name: "product token in an identity string (userAgent(brand, ...))", re: /["'`]winter-agent-sdk\// },
  { name: "temp-root or product token, interpolated or slashless (brand.tempRootName / brand.packageName)", re: /["'`]winter-\$\{|["'`]winter-agent-sdk["'`]/ },
  // Rule 10 is filled in below, once the suffix list exists.
  { name: "product env name spelled literally (envName(brand, ...))", re: null as unknown as RegExp },
];

/**
 * Rule 9's closed suffix list: WS-01 §2.5's PRODUCT-facing environment variables, and nothing else.
 *
 * A product env name is brand-derived, so reading one at MODULE LOAD is the specific bug this rule
 * exists for: the brand arrives with the host's own configuration, long after import time, so a
 * module-level read bakes Winter's prefix in for a reuser and can never be corrected. The same read
 * inside a function is fine. Harness variables are ABSENT from this list on purpose — they are never
 * brand-derived, so a module-level read of one is not a bug.
 */
const PRODUCT_ENV_SUFFIXES = [
  "HOME",
  "TMPDIR",
  "PROJECT_DIR_NAME",
  "SUBAGENT_MODEL",
  "MAX_SUBAGENT_SPAWN_DEPTH",
  "MAX_CONCURRENT_SUBAGENTS",
  "DISABLE_BACKGROUND_TASKS",
  "MAX_RETRIES",
  "RETRY_WATCHDOG",
  "ASYNC_AGENT_STALL_TIMEOUT_MS",
  "ENABLE_STREAM_WATCHDOG",
  "STREAM_IDLE_TIMEOUT_MS",
  "SKIP_PROMPT_HISTORY",
  "ENABLE_TELEMETRY",
  "ENHANCED_TELEMETRY_BETA",
  "PROFILE",
] as const;
const TOP_LEVEL_ENV_RE = new RegExp(`process\\.env\\.WINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`, "g");
/** Rule 10: a product env name spelled as a PROPERTY or a STRING KEY, on any receiver. */
const LITERAL_ENV_NAME_RE = new RegExp(`(?:\\.|\\[\\s*["'\`])WINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`);
(RAW_RULES as Array<{ name: string; re: RegExp }>)[RAW_RULES.length - 1]!.re = LITERAL_ENV_NAME_RE;

/**
 * Rules 2b and 10b: a brand-owned name spelled INSIDE A STRING LITERAL.
 *
 * The raw rules are anchored on a QUOTE, which is what keeps an English sentence out of the net — and
 * is exactly why the survivors of the SDK repository's whole-branch review were invisible: the token
 * sat in the MIDDLE of a sentence that is itself a string (model-facing prose, a host-facing remedy).
 * So these two are matched only where `inString` is set: a COMMENT naming the instructions file is
 * prose about the mechanism, while the same token inside a string is text that LEAVES THE PROCESS.
 */
const IN_STRING_RULES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "rule 2b: the instructions file named inside a STRING (brand.instructionsFile)", re: new RegExp("\\bWINTER\\.md\\b", "g") },
  { name: "rule 10b: a product env name spelled bare inside a STRING (envName(brand, ...))", re: new RegExp(`\\bWINTER_(?:${PRODUCT_ENV_SUFFIXES.join("|")})\\b`, "g") },
];

// ================================================================================================
// The scanner rule 9 needs: enclosing-function depth, with strings/comments/templates/regexes
// discounted. Ported verbatim from the SDK repository, including its two ambiguity heuristics.
// ================================================================================================

export interface ScanMask {
  /** How many enclosing FUNCTION BODIES each index sits inside; `0` means module-load position. */
  functionDepths: Int32Array;
  /** Whether each index is REAL CODE — not inside a string, template, comment or regex literal. */
  inCode: Uint8Array;
  /** Whether each index is inside a STRING LITERAL (single, double or template) — never a comment. */
  inString: Uint8Array;
}

export function computeScanMask(src: string): ScanMask {
  const functionDepths = new Int32Array(src.length);
  const inCode = new Uint8Array(src.length);
  const inString = new Uint8Array(src.length);
  type State = "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex";
  type BraceKind = "fn" | "other" | "tmpl";
  let state: State = "code";
  let functionDepth = 0;
  const braceStack: BraceKind[] = [];
  const prevSigAt = new Int32Array(src.length).fill(-1);
  const matchingOpenParen = new Map<number, number>();
  const parenStack: number[] = [];
  let prevSigIdx = -1;
  let prevSignificant = "";
  const regexCanFollow = (prev: string): boolean => prev === "" || "(,=:[!&|?{};+-*%~^<>\n".includes(prev);

  const wordEndingAt = (idx: number): string => {
    if (idx < 0) return "";
    const end = idx;
    if (!/[A-Za-z0-9_$]/.test(src[end] as string)) return "";
    let begin = end;
    while (begin > 0 && /[A-Za-z0-9_$]/.test(src[begin - 1] as string)) begin--;
    return src.slice(begin, end + 1);
  };

  /** Control-flow keywords whose `(...)` is followed by a BLOCK, not a function body. */
  const CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with"]);

  const classifyBrace = (): BraceKind => {
    if (prevSignificant === ">" && prevSigIdx > 0 && src[prevSigIdx - 1] === "=") return "fn"; // `=> {`
    if (prevSignificant === ")") {
      const open = matchingOpenParen.get(prevSigIdx);
      if (open === undefined) return "other";
      const word = wordEndingAt(prevSigAt[open] ?? -1);
      if (word === "" || CONTROL_KEYWORDS.has(word)) return "other";
      return "fn";
    }
    return "other";
  };

  for (let i = 0; i < src.length; i++) {
    functionDepths[i] = functionDepth;
    prevSigAt[i] = prevSigIdx;
    inCode[i] = state === "code" ? 1 : 0;
    inString[i] = state === "sq" || state === "dq" || state === "tmpl" ? 1 : 0;
    const c = src[i] as string;
    const n = i + 1 < src.length ? (src[i + 1] as string) : "";
    switch (state) {
      case "code":
        if (c === "/" && n === "/") {
          state = "line";
          i++;
        } else if (c === "/" && n === "*") {
          state = "block";
          i++;
        } else if (c === "'") state = "sq";
        else if (c === '"') state = "dq";
        else if (c === "`") state = "tmpl";
        else if (c === "/" && regexCanFollow(prevSignificant)) state = "regex";
        else if (c === "(") parenStack.push(i);
        else if (c === ")") {
          const open = parenStack.pop();
          if (open !== undefined) matchingOpenParen.set(i, open);
        } else if (c === "{") {
          const kind = classifyBrace();
          braceStack.push(kind);
          if (kind === "fn") functionDepth++;
        } else if (c === "}") {
          const kind = braceStack.pop();
          if (kind === "tmpl") state = "tmpl";
          else if (kind === "fn") functionDepth--;
        }
        break;
      case "line":
        if (c === "\n") state = "code";
        break;
      case "block":
        if (c === "*" && n === "/") {
          state = "code";
          i++;
        }
        break;
      case "sq":
        if (c === "\\") i++;
        else if (c === "'") state = "code";
        break;
      case "dq":
        if (c === "\\") i++;
        else if (c === '"') state = "code";
        break;
      case "tmpl":
        if (c === "\\") i++;
        else if (c === "`") state = "code";
        else if (c === "$" && n === "{") {
          braceStack.push("tmpl");
          state = "code";
          i++;
        }
        break;
      case "regex":
        if (c === "\\") i++;
        else if (c === "\n") state = "code"; // an unterminated "regex" was a division after all
        else if (c === "/") state = "code";
        break;
    }
    if (state === "code" && c.trim() !== "") {
      prevSignificant = c;
      prevSigIdx = i;
    }
  }
  return { functionDepths, inCode, inString };
}

// ================================================================================================
// The sweep.
// ================================================================================================

/** A file is "test source" — and therefore out of scope — by its own filename, never by content. */
function isTestFile(path: string): boolean {
  return path.endsWith(".test.ts") || path.endsWith(".test-support.ts");
}

function collectSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !isTestFile(entry.name)) out.push(relative(REPO_ROOT, full));
    }
  };
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root));
  return out.sort();
}

export interface BrandOffence {
  file: string;
  rule: string;
  line: number;
  text: string;
}

export function scanFileForBrandLiterals(relPath: string, src: string): BrandOffence[] {
  const found: BrandOffence[] = [];
  const lines = src.split("\n");
  for (const rule of RAW_RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (rule.re.test(line)) found.push({ file: relPath, rule: rule.name, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
  const { functionDepths, inCode, inString } = computeScanMask(src);
  TOP_LEVEL_ENV_RE.lastIndex = 0;
  for (let m = TOP_LEVEL_ENV_RE.exec(src); m !== null; m = TOP_LEVEL_ENV_RE.exec(src)) {
    if (functionDepths[m.index] !== 0 || inCode[m.index] !== 1) continue;
    found.push({ file: relPath, rule: "MODULE-LOAD read of a product env name (rule 9)", line: src.slice(0, m.index).split("\n").length, text: m[0] });
  }
  for (const rule of IN_STRING_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(src); m !== null; m = rule.re.exec(src)) {
      if (inString[m.index] !== 1) continue;
      found.push({ file: relPath, rule: rule.name, line: src.slice(0, m.index).split("\n").length, text: m[0] });
    }
  }
  return found;
}

/**
 * THE BASELINE — files that carried a literal when this gate landed here.
 *
 * EMPTY, and a test below asserts it stays empty. The SDK repository's copy needed a baseline because
 * the gate arrived after the code; this one arrived with the spine, and the two literals that existed
 * on that day were reworded in the same commit rather than listed. An entry here would be a debt with
 * a name, never a permission.
 */
const BASELINE_ALLOWLIST: readonly string[] = [];

describe("the brand sweep gate", () => {
  const files = collectSourceFiles();
  const offences = files.flatMap((file) => scanFileForBrandLiterals(file, readFileSync(join(REPO_ROOT, file), "utf8")));
  const allowed = new Set(BASELINE_ALLOWLIST);

  test("no file carries a raw Winter-owned literal", () => {
    const unexpected = offences.filter((o) => !allowed.has(o.file));
    const detail = unexpected.map((o) => `  ${o.file}:${o.line}  [${o.rule}]  ${o.text}`).join("\n");
    expect(unexpected.length === 0 ? "" : `raw brand literals in non-test source (derive them from \`brand\`, or reword the comment):\n${detail}`).toBe("");
  });

  test("the baseline is EMPTY -- this repository started clean and stays clean", () => {
    expect(BASELINE_ALLOWLIST).toEqual([]);
  });

  test("the sweep is not vacuous: it scans both roots and this repository's real files", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("src/seams/official-adapter.ts");
    expect(files).toContain("scripts/smoke-installed.ts");
  });

  test("every rule fires on its own literal and not on a near miss (plants)", () => {
    const hits = (src: string): string[] => scanFileForBrandLiterals("synthetic.ts", src).map((o) => o.rule);
    expect(hits('const home = ".winter/settings.json";')).toContain("home/project/plugin dot-dir (brand.homeDirName / projectDirName / pluginManifestDir)");
    expect(hits('const dir = ".winter-plugin";')).toContain("home/project/plugin dot-dir (brand.homeDirName / projectDirName / pluginManifestDir)");
    expect(hits('const s = "wintering";')).toEqual([]);
    expect(hits('const f = "WINTER.md";')).toContain("instructions file (brand.instructionsFile)");
    expect(hits('const f = "WINTER.mdx";')).toEqual([]);
    expect(hits('const p = "winter_code";')).toContain("preset name (brand.presetName)");
    expect(hits("const t = mcp__winter__send_message;")).toContain("MCP tool name (mcpToolName(brand, ...))");
    expect(hits('const k = "com.winter.core";')).toContain("keychain service (brand.keychainService)");
    expect(hits('const r = "/private/tmp/winter-abc";')).toContain("shared temp root, spelled as a path (brand.tempRootName)");
    expect(hits('const c = { originator: "winter" };')).toContain("codex originator (brand.codexOriginator)");
    expect(hits('const ua = "winter-agent-sdk/1.0";')).toContain("product token in an identity string (userAgent(brand, ...))");
    expect(hits('const n = "winter-agent-sdk";')).toContain("temp-root or product token, interpolated or slashless (brand.tempRootName / brand.packageName)");
    expect(hits('const n = "@yanlinglabs/winter-agent-sdk";')).toEqual([]);
    expect(hits('const t = `winter-${uid}`;')).toContain("temp-root or product token, interpolated or slashless (brand.tempRootName / brand.packageName)");
    expect(hits("const h = env.WINTER_HOME;")).toContain("product env name spelled literally (envName(brand, ...))");
    expect(hits('const h = env["WINTER_TMPDIR"];')).toContain("product env name spelled literally (envName(brand, ...))");
    // A HARNESS variable is never a match, at any depth.
    expect(hits("const h = process.env.WINTER_TEST_PACK_SMOKE;")).toEqual([]);
    // CLAUDE-MIRRORING literals are not ours to rebrand -- no rule may touch them.
    expect(hits('const d = process.env.CLAUDE_CONFIG_DIR; const p = "claude_code"; const r = "claude-resume-x"; const b = "com.anthropic.claude-code";')).toEqual([]);
  });

  test("rule 9 sees a MODULE-LOAD read and not one inside a function (plants)", () => {
    const rule9 = "MODULE-LOAD read of a product env name (rule 9)";
    const hits = (src: string): string[] => scanFileForBrandLiterals("synthetic.ts", src).map((o) => o.rule);
    expect(hits("const home = process.env.WINTER_HOME;\n")).toContain(rule9);
    // A top-level OBJECT LITERAL is not a scope -- this is the read the naive depth test missed.
    expect(hits("export const DEFAULTS = { home: process.env.WINTER_HOME };\n")).toContain(rule9);
    expect(hits("export const s = `${process.env.WINTER_HOME}/x`;\n")).toContain(rule9);
    // Inside a function body it is fine (rule 10 still names the literal, so filter to rule 9).
    expect(hits("function f() {\n  return process.env.WINTER_HOME;\n}\n")).not.toContain(rule9);
    expect(hits("const f = () => {\n  return process.env.WINTER_HOME;\n};\n")).not.toContain(rule9);
    // `if (...) {` is a block, not a function body.
    expect(hits("if (x) {\n  const h = process.env.WINTER_HOME;\n}\n")).toContain(rule9);
    // A comment or a string mentioning the read is not a read.
    expect(hits("// never write process.env.WINTER_HOME at module load\n")).not.toContain(rule9);
  });

  test("rules 2b/10b fire in a STRING and not in a comment (plants)", () => {
    const inString = "rule 10b: a product env name spelled bare inside a STRING (envName(brand, ...))";
    const hits = (src: string): string[] => scanFileForBrandLiterals("synthetic.ts", src).map((o) => o.rule);
    expect(hits('throw new Error("set WINTER_HOME to a temp dir");')).toContain(inString);
    expect(hits("// set WINTER_HOME to a temp dir\n")).not.toContain(inString);
    expect(hits('const m = "read WINTER.md first";')).toContain("rule 2b: the instructions file named inside a STRING (brand.instructionsFile)");
    expect(hits("// read WINTER.md first\n")).not.toContain("rule 2b: the instructions file named inside a STRING (brand.instructionsFile)");
  });
});

// ==================================================================================================
// THE BRAND-LESS CALL-SITE GATE.
// ==================================================================================================
//
// Every survivor the SDK repository's whole-branch review found was invisible to the literal rules
// above, and all of them were the same thing: a value DERIVED FROM `WINTER_BRAND` AT MODULE LOAD, or
// a brand-taking function CALLED WITHOUT ITS BRAND (`resolveWinterHome()` with no brand — nine session
// functions addressing Winter's own store for every reuser). None of them spells a literal, so no
// literal rule can see any of them. This gate sweeps by CALL SITE instead of by token.
//
// THE ALLOWLIST IS EMPTY HERE and the assertion is the other way round from the SDK repository's: this
// package calls none of the brand-taking helpers yet, so any first use has to be justified in one
// line when a lane adds it. The scanner's own plants below are what keep an empty result honest.

interface CallSiteRule {
  name: string;
  re: RegExp;
  keep?: (src: string, index: number, match: string) => boolean;
}

/** True when the call starting at `openParenAt` has FEWER THAN TWO top-level arguments. */
function callHasBrandArgument(src: string, openParenAt: number, inCode: Uint8Array): boolean {
  let depth = 0;
  let topLevelCommas = 0;
  for (let i = openParenAt; i < src.length; i++) {
    if (inCode[i] !== 1) continue;
    const c = src[i] as string;
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && c === ",") topLevelCommas++;
  }
  return topLevelCommas >= 1;
}

const CALL_SITE_RULES: readonly CallSiteRule[] = [
  {
    name: "resolveWinterHome() called with no brand argument",
    // Not preceded by an identifier char or a dot, so `opts.resolveWinterHome()` is a different symbol.
    re: /(?<![\w.$])resolveWinterHome\(/g,
    keep: (src, index) => !callHasBrandArgument(src, index + "resolveWinterHome".length, computeScanMask(src).inCode),
  },
  { name: "envName(WINTER_BRAND, ...) -- an env name derived from the DEFAULT profile", re: /envName\(\s*WINTER_BRAND\b/g },
  { name: "WINTER_BRAND.<field> read outside the brand module", re: /(?<![\w.$])WINTER_BRAND\./g },
];

export interface CallSiteUse {
  file: string;
  line: number;
  rule: string;
}

export function scanFileForBrandlessCallSites(relPath: string, src: string): CallSiteUse[] {
  const { inCode } = computeScanMask(src);
  const out: CallSiteUse[] = [];
  for (const rule of CALL_SITE_RULES) {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(src); m !== null; m = rule.re.exec(src)) {
      if (inCode[m.index] !== 1) continue; // a comment explaining the derivation is not a use
      if (rule.keep !== undefined && !rule.keep(src, m.index, m[0])) continue;
      out.push({ file: relPath, line: src.slice(0, m.index).split("\n").length, rule: rule.name });
    }
  }
  return out;
}

/** Every legitimate brand-less site, `file:line` with a one-line rationale. Empty, for now. */
const BRANDLESS_CALL_SITE_ALLOWLIST: Readonly<Record<string, string>> = {};

describe("every brand-less call site is named and justified", () => {
  const uses = collectSourceFiles().flatMap((file) => scanFileForBrandlessCallSites(file, readFileSync(join(REPO_ROOT, file), "utf8")));

  test("no UNJUSTIFIED brand-less call site exists", () => {
    const unexpected = uses.filter((u) => BRANDLESS_CALL_SITE_ALLOWLIST[`${u.file}:${u.line}`] === undefined);
    const detail = unexpected.map((u) => `  ${u.file}:${u.line}  [${u.rule}]`).join("\n");
    expect(
      unexpected.length === 0
        ? ""
        : `brand-less call sites with no rationale (add one line to BRANDLESS_CALL_SITE_ALLOWLIST saying why this is a DEFAULT and not a missing argument, or thread the brand):\n${detail}`,
    ).toBe("");
  });

  test("the allowlist has no STALE entries -- a threaded call site must be deleted from it", () => {
    const present = new Set(uses.map((u) => `${u.file}:${u.line}`));
    expect(Object.keys(BRANDLESS_CALL_SITE_ALLOWLIST).filter((k) => !present.has(k))).toEqual([]);
  });

  test("every rationale is a real sentence", () => {
    for (const [site, why] of Object.entries(BRANDLESS_CALL_SITE_ALLOWLIST)) expect([site, why.length > 25]).toEqual([site, true]);
  });

  test("the scanner's arity test and comment filter both work (plants)", () => {
    const scan = (src: string): string[] => scanFileForBrandlessCallSites("synthetic.ts", src).map((u) => u.rule);
    const brandless = "resolveWinterHome() called with no brand argument";
    // A BRANDED call is not a use.
    expect(scan("const h = resolveWinterHome(env, brand);\n")).toEqual([]);
    expect(scan("export function resolveWinterHome(env?: E, brand?: B): string {\n  return x;\n}\n")).toEqual([]);
    // A brand-LESS one is, in both spellings.
    expect(scan("const h = resolveWinterHome();\n")).toEqual([brandless]);
    expect(scan("const h = resolveWinterHome(opts.env);\n")).toEqual([brandless]);
    // A nested call's own comma is not an argument separator.
    expect(scan("const h = resolveWinterHome(pick(a, b));\n")).toEqual([brandless]);
    // A method of the same name on an options object is a different symbol.
    expect(scan("const h = opts.resolveWinterHome();\n")).toEqual([]);
    // Comments and strings are never uses.
    expect(scan("// resolveWinterHome() and WINTER_BRAND.homeDirName are what this replaces\n")).toEqual([]);
    expect(scan('const s = "call resolveWinterHome(env, brand)";\n')).toEqual([]);
    // The other two rules fire.
    expect(scan("const n = envName(WINTER_BRAND, 'HOME');\n")).toEqual(["envName(WINTER_BRAND, ...) -- an env name derived from the DEFAULT profile"]);
    expect(scan("const d = WINTER_BRAND.homeDirName;\n")).toEqual(["WINTER_BRAND.<field> read outside the brand module"]);
    // Every rule has been shown firing at least once, which is what makes an EMPTY sweep meaningful.
    expect(new Set([...scan("resolveWinterHome();\n"), ...scan("envName(WINTER_BRAND, 'HOME');\n"), ...scan("WINTER_BRAND.homeDirName;\n")]).size).toBe(CALL_SITE_RULES.length);
  });
});
