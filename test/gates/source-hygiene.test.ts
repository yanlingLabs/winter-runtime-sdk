// NO RAW CONTROL BYTES IN SOURCE — a permanent gate, ported from the SDK repository's own.
//
// WHY THIS IS WORTH A GATE. A raw control byte in source is invisible in every place a human looks at
// code — an editor, a `git diff`, a review UI, a terminal, this repository's own `grep` output —
// while being fully significant to the compiler. That asymmetry is the whole hazard: the byte cannot
// be reviewed, so whatever it does is unreviewed, and a second one added later is unreviewable in
// exactly the same way. It also breaks tools that reasonably assume text: `grep` treats a file
// containing NUL as binary and prints "Binary file matches" instead of the line, which is precisely
// how two of them survived every earlier sweep of the SDK repository. A sweep fixes today's bytes;
// only a test stops the next one.
//
// SCOPE: every TRACKED `.ts` file under `src/`, `test/` and `scripts/` — test files included, because
// a control byte is exactly as invisible in a fixture as in an implementation. `git ls-files` is the
// enumerator, so "tracked" is git's own answer rather than a filesystem walk that would also sweep
// build output and anything `.gitignore`d.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** `src/**\/*.ts`, `test/**\/*.ts`, `scripts/**\/*.ts`, evaluated against git's own path list. */
const IN_SCOPE = /^(?:src|test|scripts)\/.*\.ts$/;

/**
 * The forbidden set: any byte below `0x20` that is not TAB, LF or CR.
 *
 * Those three are the only control bytes that carry meaning in a text file, and every one of them is
 * rendered by every tool that shows source. Everything else in the C0 range — NUL, the bell, the
 * escape byte that starts an ANSI sequence, a vertical tab — is invisible, and a string that needs one
 * has a four-character escape (`\u0000`, `\x1b`) that is not.
 */
function isForbidden(byte: number): boolean {
  return byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d;
}

export interface ControlByteOffence {
  file: string;
  /** 1-based, counting LF — the line a reader would jump to. */
  line: number;
  byte: string;
}

export function scanBufferForControlBytes(file: string, buf: Uint8Array): ControlByteOffence[] {
  const out: ControlByteOffence[] = [];
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i] as number;
    if (b === 0x0a) {
      line++;
      continue;
    }
    if (isForbidden(b)) out.push({ file, line, byte: `0x${b.toString(16).padStart(2, "0")}` });
  }
  return out;
}

function trackedSourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n");
  return listed.filter((path) => IN_SCOPE.test(path)).sort();
}

describe("source hygiene: no raw control bytes", () => {
  const files = trackedSourceFiles();

  test("the sweep is not vacuous — it sees this repository's own sources", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("src/index.ts");
    expect(files).toContain("scripts/build-packages.ts");
  });

  test("no tracked source file carries one", () => {
    const offences: ControlByteOffence[] = [];
    for (const file of files) offences.push(...scanBufferForControlBytes(file, readFileSync(resolve(REPO_ROOT, file))));
    const detail = offences.map((o) => `  ${o.file}:${o.line}  ${o.byte}`).join("\n");
    expect(offences.length === 0 ? "" : `raw control bytes in source (replace each with its escape, e.g. \\u0000):\n${detail}`).toBe("");
  });

  test("the scanner finds one when there IS one (plants)", () => {
    const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
    expect(scanBufferForControlBytes("x.ts", encode("const a = 1;\nconst b = 2;\n"))).toEqual([]);
    // Tab, LF and CR are allowed.
    expect(scanBufferForControlBytes("x.ts", encode("a\tb\r\nc\n"))).toEqual([]);
    // A NUL on line 2, an ESC on line 3.
    const planted = scanBufferForControlBytes("x.ts", encode("line1\nli\u0000ne2\nli\u001bne3\n"));
    expect(planted).toEqual([
      { file: "x.ts", line: 2, byte: "0x00" },
      { file: "x.ts", line: 3, byte: "0x1b" },
    ]);
  });
});
