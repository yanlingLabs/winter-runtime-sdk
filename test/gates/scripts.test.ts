// PLANT TESTS FOR THE PIPELINE SCRIPTS.
//
// Every check in `build-packages.ts`, `release-pack.ts`, `smoke-installed.ts` and
// `check-release-version.ts` is a gate that only earns trust by having been SHOWN FAILING. A scan
// that has never rejected anything, a rewrite that quietly no-ops, a version check nobody has fed a
// mismatch — each of those passes forever and proves nothing. So each one is driven here against a
// synthetic tree or a synthetic string, in both directions.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { entriesFor, missingPeerDeclarations, peerPackageDir, rewriteDeclarationSpecifiers } from "../../scripts/build-packages.ts";
import { scanExtracted } from "../../scripts/release-pack.ts";
import { assertInstalledTreeIsDistOnly, deriveImportTargets, runtimesFor } from "../../scripts/smoke-installed.ts";
import { checkReleaseVersion, versionFromRef } from "../../scripts/check-release-version.ts";
import { withTempDir } from "../../src/testing/index.ts";

describe("build-packages", () => {
  test("the declaration rewrite touches relative `.ts` specifiers and nothing else", () => {
    expect(rewriteDeclarationSpecifiers('export { a } from "./a.ts";')).toBe('export { a } from "./a.js";');
    expect(rewriteDeclarationSpecifiers('export type { B } from "../b/c.ts";')).toBe('export type { B } from "../b/c.js";');
    expect(rewriteDeclarationSpecifiers('type X = import("./d.ts").D;')).toBe('type X = import("./d.js").D;');
    // A PACKAGE specifier is never touched -- it is not a file this package emits.
    expect(rewriteDeclarationSpecifiers('export * from "@yanlinglabs/winter-agent-sdk";')).toBe('export * from "@yanlinglabs/winter-agent-sdk";');
    // A `.ts` inside a string literal TYPE is not a specifier.
    expect(rewriteDeclarationSpecifiers('type Ext = "./x.ts";')).toBe('type Ext = "./x.ts";');
    // The rewrite is not a no-op on this package's own emitted shape.
    expect(rewriteDeclarationSpecifiers('export { createRuntimeSdk } from "./sdk.ts";')).toContain("./sdk.js");
  });

  test("the export entries are DERIVED from the manifest, including a conditional map", async () => {
    await withTempDir("entries", async (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: { ".": { types: "./dist/index.d.ts", bun: "./src/index.ts", default: "./dist/index.js" }, "./x": { bun: "./src/x/y.ts" } } }));
      expect(entriesFor(join(dir, "package.json"))).toEqual([
        { subpath: ".", sourceRelative: "src/index.ts" },
        { subpath: "./x", sourceRelative: "src/x/y.ts" },
      ]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({}));
      expect(entriesFor(join(dir, "package.json"))).toEqual([{ subpath: ".", sourceRelative: "src/index.ts" }]);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ exports: { ".": { types: "./dist/index.d.ts" } } }));
      expect(() => entriesFor(join(dir, "package.json"))).toThrow(/no source path/);
    });
  });

  test("the peer-declaration precondition resolves the real peer, and reports a missing one", () => {
    expect(peerPackageDir("@yanlinglabs/winter-agent-sdk")).toBeDefined();
    expect(peerPackageDir("@yanlinglabs/not-a-real-package")).toBeUndefined();
    // In this checkout the peer IS built, so the precondition is satisfied; the failure branch is
    // covered by the message assertion below rather than by deleting somebody else's dist.
    expect(missingPeerDeclarations()).toEqual([]);
    expect(missingPeerDeclarations("/nonexistent-root")).toHaveLength(1);
  });
});

describe("release-pack's tarball scan", () => {
  /** Builds a synthetic EXTRACTED tarball (`<root>/package/...`) and scans it. */
  async function scanSynthetic(files: Record<string, string>, manifest: unknown): Promise<string[]> {
    return withTempDir("scan", async (dir) => {
      const packageRoot = join(dir, "package");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
      for (const [path, content] of Object.entries(files)) {
        const full = join(packageRoot, path);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content);
      }
      return scanExtracted(dir, "@yanlinglabs/winter-runtime-sdk").violations;
    });
  }

  const cleanManifest = { name: "@yanlinglabs/winter-runtime-sdk", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };

  test("a clean tarball passes", async () => {
    expect(await scanSynthetic({ "dist/index.js": "export {};", "README.md": "#", "LICENSE": "MIT" }, cleanManifest)).toEqual([]);
  });

  test("an embedded Anthropic artifact is rejected, by directory name and by file name", async () => {
    expect((await scanSynthetic({ "vendor/claude-agent-sdk/sdk.d.ts": "" }, cleanManifest)).join("\n")).toContain("Anthropic artifact");
    expect((await scanSynthetic({ "dist/sdk.mjs": "" }, cleanManifest)).join("\n")).toContain("Anthropic artifact");
  });

  test("node_modules, credentials-shaped files, test files and source are each rejected", async () => {
    expect((await scanSynthetic({ "node_modules/x/index.js": "" }, cleanManifest)).join("\n")).toContain("forbidden directory");
    expect((await scanSynthetic({ "dist/.env": "" }, cleanManifest)).join("\n")).toContain("credentials-shaped");
    expect((await scanSynthetic({ "dist/aws.credentials.json": "" }, cleanManifest)).join("\n")).toContain("credentials-shaped");
    expect((await scanSynthetic({ "dist/service.pem": "" }, cleanManifest)).join("\n")).toContain("credentials-shaped");
    expect((await scanSynthetic({ "dist/index.test.ts": "" }, cleanManifest)).join("\n")).toContain("test file");
    expect((await scanSynthetic({ "src/index.ts": "" }, cleanManifest)).join("\n")).toContain("dist-only");
    // A SOURCE file whose name describes credential-handling logic is not a credential.
    expect(await scanSynthetic({ "dist/credentials.js": "" }, cleanManifest)).toEqual([]);
  });

  test("a surviving `bun` condition or a foreign manifest name is rejected", async () => {
    const withBun = { name: "@yanlinglabs/winter-runtime-sdk", exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } } };
    expect((await scanSynthetic({ "dist/index.js": "" }, withBun)).join("\n")).toContain("`bun` condition");
    const foreign = { name: "@someone-else/thing", exports: {} };
    const violations = (await scanSynthetic({ "dist/index.js": "" }, foreign)).join("\n");
    expect(violations).toContain("the packed manifest names");
    expect(violations).toContain("outside the @yanlinglabs scope");
  });
});

describe("smoke-installed", () => {
  test("`runtimesFor` reads the package's own engines, and fails CLOSED on a package with none", () => {
    expect(runtimesFor({ name: "x", engines: { node: ">=18" } })).toEqual(["node", "bun"]);
    expect(runtimesFor({ name: "x", engines: { bun: ">=1.2" } })).toEqual(["bun"]);
    expect(runtimesFor({ name: "x" })).toEqual(["node", "bun"]);
  });

  test("`deriveImportTargets` reads this package's own manifest -- never a hand-kept list", () => {
    const targets = deriveImportTargets();
    expect(targets.map((t) => t.specifier)).toEqual(["@yanlinglabs/winter-runtime-sdk"]);
    expect(targets[0]?.runtimes).toEqual(["node", "bun"]);
  });

  test("the installed-tree check finds a shipped `src/` and a surviving `bun` condition (plants)", async () => {
    await withTempDir("probe", async (dir) => {
      const pkgDir = join(dir, "node_modules", "@yanlinglabs", "winter-runtime-sdk");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { default: "./dist/index.js" } } }));
      expect(assertInstalledTreeIsDistOnly(dir, "@yanlinglabs/winter-runtime-sdk")).toEqual([]);

      mkdirSync(join(pkgDir, "src"), { recursive: true });
      expect(assertInstalledTreeIsDistOnly(dir, "@yanlinglabs/winter-runtime-sdk").join("\n")).toContain("src exists");

      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ exports: { ".": { bun: "./src/index.ts", default: "./dist/index.js" } } }));
      expect(assertInstalledTreeIsDistOnly(dir, "@yanlinglabs/winter-runtime-sdk").join("\n")).toContain("`bun` condition");

      expect(assertInstalledTreeIsDistOnly(dir, "@yanlinglabs/never-installed").join("\n")).toContain("has no package.json");
    });
  });
});

describe("check-release-version", () => {
  test("a tag ref becomes a version; anything else does not", () => {
    expect(versionFromRef("refs/tags/v0.0.1")).toBe("0.0.1");
    expect(versionFromRef("refs/heads/main")).toBeUndefined();
    expect(versionFromRef(undefined)).toBeUndefined();
  });

  test("this repository agrees with itself", () => {
    const result = checkReleaseVersion({ ref: "" });
    expect(result.ok).toBe(true);
    expect(result.version).toBe(result.versionFile);
  });

  test("a manifest/VERSION mismatch and a tag mismatch are both refused (plants)", async () => {
    await withTempDir("version", async (dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.0.1" }));
      writeFileSync(join(dir, "VERSION"), "0.0.2\n");
      expect(checkReleaseVersion({ root: dir, ref: "" }).problems).toEqual(["package.json says 0.0.1 and VERSION says 0.0.2"]);

      writeFileSync(join(dir, "VERSION"), "0.0.1\n");
      expect(checkReleaseVersion({ root: dir, ref: "refs/tags/v0.0.1" }).ok).toBe(true);
      expect(checkReleaseVersion({ root: dir, ref: "refs/tags/v0.9.9" }).problems).toEqual(["the pushed tag is v0.9.9 and package.json says 0.0.1"]);
    });
  });
});
