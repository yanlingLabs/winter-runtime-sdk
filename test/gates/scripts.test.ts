// PLANT TESTS FOR THE PIPELINE SCRIPTS.
//
// Every check in `build-packages.ts`, `release-pack.ts`, `smoke-installed.ts` and
// `check-release-version.ts` is a gate that only earns trust by having been SHOWN FAILING. A scan
// that has never rejected anything, a rewrite that quietly no-ops, a version check nobody has fed a
// mismatch — each of those passes forever and proves nothing. So each one is driven here against a
// synthetic tree or a synthetic string, in both directions.
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { entriesFor, missingPeerDeclarations, peerPackageDir, rewriteDeclarationSpecifiers } from "../../scripts/build-packages.ts";
import { moduleSpecifiersIn, reachableDeclarations, scanExtracted } from "../../scripts/release-pack.ts";
import { assertInstalledTreeIsDistOnly, deriveImportTargets, PROBE_NPMRC, runtimesFor } from "../../scripts/smoke-installed.ts";
import { checkReleaseVersion, versionFromRef } from "../../scripts/check-release-version.ts";
import { withTempDir } from "../../src/testing/index.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

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

  test("rule 7: the OPTIONAL peer named in a REACHABLE declaration is rejected -- and only there", async () => {
    const manifest = { name: "@yanlinglabs/winter-runtime-sdk", types: "./dist/index.d.ts", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };
    const clean = {
      "dist/index.js": "export {};",
      "dist/index.d.ts": 'export * from "./seams/index.js";\n',
      "dist/seams/index.d.ts": 'export type { OfficialAdapter } from "./official-adapter.js";\n',
      "dist/seams/official-adapter.d.ts": "export interface OfficialAdapter { launch(): void }\n",
    };
    expect(await scanSynthetic(clean, manifest)).toEqual([]);

    // A specifier in a file the `types` entry reaches: REJECTED.
    const reachable = { ...clean, "dist/seams/official-adapter.d.ts": 'import type { Options } from "@anthropic-ai/claude-agent-sdk";\nexport type O = Options;\n' };
    expect((await scanSynthetic(reachable, manifest)).join("\n")).toContain("forces every consumer to install an OPTIONAL peer");

    // The SAME specifier in a file nothing reaches (Lane A's own internals): allowed, by design.
    const unreachable = { ...clean, "dist/official/adapter.d.ts": 'import type { Options } from "@anthropic-ai/claude-agent-sdk";\nexport type O = Options;\n' };
    expect(await scanSynthetic(unreachable, manifest)).toEqual([]);

    // A doc COMMENT naming the peer is not a specifier -- the false positive that would otherwise
    // teach everyone to delete the explanation.
    const commented = { ...clean, "dist/seams/official-adapter.d.ts": '/** not `typeof import("@anthropic-ai/claude-agent-sdk")` -- see the header */\nexport interface OfficialAdapter { launch(): void }\n' };
    expect(await scanSynthetic(commented, manifest)).toEqual([]);
  });

  test("the declaration walker and the specifier extractor (plants)", () => {
    expect(moduleSpecifiersIn('import type { A } from "./a.js";\nexport * from "pkg";\n')).toEqual(["./a.js", "pkg"]);
    expect(moduleSpecifiersIn('type X = import("./b.js").B;')).toEqual(["./b.js"]);
    expect(moduleSpecifiersIn('// import { x } from "commented";\n')).toEqual([]);
    expect(moduleSpecifiersIn('/* from "blocked" */\nexport {};')).toEqual([]);
    // A KNOWN LIMIT, asserted rather than wished away: a `from "…"` inside a STRING LITERAL TYPE is
    // indistinguishable from a specifier without a parser, so the extractor reports it. The failure
    // direction is a false POSITIVE -- loud, and fixable by rewording -- and no declaration this
    // package emits carries such a type. A false negative would be the dangerous one, and comments
    // (the only realistic source of one) are stripped.
    expect(moduleSpecifiersIn('const s = "from \'in-a-string\'";')).toEqual(["in-a-string"]);
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
  test("reachableDeclarations follows relative specifiers transitively and stops at package ones", async () => {
    await withTempDir("reach", async (dir) => {
      mkdirSync(join(dir, "nested"), { recursive: true });
      writeFileSync(join(dir, "index.d.ts"), 'export * from "./nested/a.js";\nexport type { B } from "pkg";\n');
      writeFileSync(join(dir, "nested", "a.d.ts"), 'export type { C } from "../c.js";\n');
      writeFileSync(join(dir, "c.d.ts"), "export type C = 1;\n");
      writeFileSync(join(dir, "orphan.d.ts"), 'import type { X } from "@anthropic-ai/claude-agent-sdk";\nexport type Y = X;\n');
      expect(reachableDeclarations(dir, "./index.d.ts")).toEqual(["c.d.ts", "index.d.ts", "nested/a.d.ts"]);
    });
  });

  // ==================================================================================================
  // THE PROBE INSTALLS FROM THE PUBLIC REGISTRY, WHATEVER THE JOB IS PINNED TO (release 0.0.2, run 1).
  //
  // The release's GitHub Packages job runs `setup-node` with `registry-url: npm.pkg.github.com` +
  // `scope: "@yanlinglabs"`, which writes a userconfig routing the whole scope there — correct for
  // `pnpm publish`, fatal for this script, whose probe install asks for the required PEER by name.
  // The release failed `401 unauthenticated` at the smoke step with every other gate green, and
  // nothing reached either registry. The fix is a project-level `.npmrc` in the probe directory (npm
  // ranks it above any userconfig); these assertions are what keep it there, since the failure it
  // prevents cannot happen in CI — `ci.yml` pins no scope, so the bug is invisible until a release.
  // ==================================================================================================
  test("the probe's `.npmrc` pins BOTH the default registry and the `@yanlinglabs` scope to npmjs", () => {
    const lines = PROBE_NPMRC.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toEqual(["registry=https://registry.npmjs.org/", "@yanlinglabs:registry=https://registry.npmjs.org/"]);
    // THE SCOPE LINE IS THE LOAD-BEARING ONE: a scoped pin beats an unscoped `registry=` for that
    // scope, so pinning only the default would leave the job's `@yanlinglabs` route in force.
    expect(PROBE_NPMRC).toContain("@yanlinglabs:registry=");
    // NO CREDENTIAL, EVER: both packages are public, and a token here would make this gate pass for a
    // reason a consumer does not have.
    expect(PROBE_NPMRC).not.toContain("_authToken");
    expect(PROBE_NPMRC).not.toContain("npm.pkg.github.com");
  });

  test("the smoke WRITES that `.npmrc` into the probe directory before it installs", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "smoke-installed.ts"), "utf8");
    const wrote = source.indexOf('writeFileSync(join(probeDir, ".npmrc"), PROBE_NPMRC)');
    const installed = source.indexOf('Bun.spawnSync(["npm", "install"');
    expect(wrote).toBeGreaterThan(0);
    // ORDER IS THE WHOLE POINT: configuration npm reads at install time, written before the install.
    expect(installed).toBeGreaterThan(wrote);
  });

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
