// THE DIST DETERMINISM GATE (R1) — proves `build({ root })` is a pure function of its source tree,
// not of where it happens to run.
//
// WHY THIS MATTERS BEYOND "the build works": `scripts/release-pack.ts` packs whatever `dist/` holds
// at pack time and prints ITS tarball's own sha256 for the release note (see that script's header —
// that hash is provenance, never a gate). Nothing before this file proved that two builds from the
// SAME source produce the SAME bytes: a build step that embedded a timestamp, a random chunk-naming
// seed, or an absolute path leaking from `--outdir` would pass every other test in this repository
// and still make two consumers of the "same" published version hold different files.
//
// TWO FRESH TEMP ROOTS, each a buildable copy of this package (manifest + tsconfigs + `src/`,
// `node_modules` SYMLINKED rather than copied -- 280MB is not this gate's concern and a symlink
// resolves through it identically): `build()` reads its entry plan and its declaration emit relative
// to `root`, so two isolated roots is what actually exercises "no dependency on incidental state",
// not two calls into the one checkout's own `dist/`.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { build } from "../../scripts/build-packages.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A buildable copy of this package in a fresh directory. Removed by the caller, in a `finally`. */
function makeBuildRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `winter-rt-dist-determinism-${label}-`));
  for (const file of ["package.json", "tsconfig.base.json", "tsconfig.build.json"]) {
    cpSync(join(REPO_ROOT, file), join(root, file));
  }
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  // A symlink, not a copy: module resolution walks through it exactly as it would through the real
  // directory, and two 280MB copies would make this gate the slowest thing `bun test test/gates` runs.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"));
  return root;
}

/** Every file under `dir`, recursively, as `{ relativePath: sha256 }`. */
function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relative);
      } else {
        out[relative] = createHash("sha256").update(readFileSync(full)).digest("hex");
      }
    }
  };
  walk(dir, "");
  return out;
}

describe("dist determinism (R1)", () => {
  test("two builds from two fresh roots produce byte-identical dist trees", async () => {
    const rootA = makeBuildRoot("a");
    const rootB = makeBuildRoot("b");
    try {
      await build({ root: rootA });
      await build({ root: rootB });
      const hashesA = hashTree(join(rootA, "dist"));
      const hashesB = hashTree(join(rootB, "dist"));
      // Not vacuous: the emit actually produced a non-trivial tree (the JS entry, its split chunks,
      // and the declaration tree), so an empty `dist/` in both roots could never pass this by accident.
      expect(Object.keys(hashesA).length).toBeGreaterThan(10);
      expect(hashesA).toEqual(hashesB);

      // NO ORPHAN `.d.ts` IN `dist/testing` (0.0.3 fix round). `tsconfig.build.json`'s `include` is
      // `src/**/*.ts`, which would otherwise match `./fakes.ts`/`./conformance.ts`/`./index.ts`
      // directly and emit a declaration for each even though NEITHER published entry (`src/index.ts`,
      // `src/testing/host.ts`) imports them -- a `.d.ts` with no matching `.js`, naming an optional
      // conformance peer no consumer of `./testing` need ever install. Reusing `rootA`'s already-built
      // tree rather than building a third root keeps this assertion free.
      expect(readdirSync(join(rootA, "dist", "testing")).sort()).toEqual(["capture-env.d.ts", "hermetic.d.ts", "host.d.ts", "host.js", "peers.d.ts"]);
    } finally {
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  }, 60_000);

  test("the emitted `dist/index.js` carries no minification artefacts", async () => {
    const root = makeBuildRoot("readable");
    try {
      await build({ root });
      const distIndex = readFileSync(join(root, "dist", "index.js"), "utf8");
      // Bun's bundler injects a `// <source path>` comment per module boundary when NOT minifying;
      // `--minify` strips them along with the whitespace below. Both signals, not one, so a future
      // change to the comment format alone cannot make this pass for the wrong reason.
      expect(distIndex).toContain("// src/index.ts");
      expect(distIndex.split("\n").length).toBeGreaterThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("the build script's own `bun build` argv carries no `--minify`", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "build-packages.ts"), "utf8");
    const buildCommandLine = source.split("\n").find((line) => line.includes('"bun", "build"'));
    expect(buildCommandLine, "no `bun build` argv line found in build-packages.ts").toBeDefined();
    expect(buildCommandLine).not.toContain("--minify");
    // And nowhere else in the file, so a `--minify` added on a later, differently-shaped line is
    // still caught.
    expect(source).not.toContain("--minify");
  });
});
