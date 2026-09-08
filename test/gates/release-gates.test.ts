// NOTHING PUBLISHES BEFORE THE CLOSE-OUT — pinned as a test, not as an intention.
//
// The plan's Global Constraints: "Nothing publishes on a phase tag; the router's `release.yml`
// mirrors the SDK repo's (`v*` tags / dispatch only …)". A workflow's trigger block is one line away
// from being wrong in the direction nobody notices until a package is on a registry it can never be
// removed from, so this file parses the real YAML and asserts the trigger set, and asserts that no
// OTHER workflow in this repository contains the word `publish` at all.
//
// It also pins the manifest facts a publish depends on: dist-only overrides, the pnpm-only pack
// guard, and the absence of any committed Anthropic artifact (this repository's own hard rule).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOW_DIR, name), "utf8");

/**
 * The parsed workflow. `Bun.YAML.parse` is the structural reading (review r1, M6): the text slice
 * below is kept as a second belt, but a re-indent or a `#`-comment inside the block could move what
 * IT sees, and the trigger set is the one fact in this repository that must not be misread.
 *
 * Typed through a cast because `@types/bun` does not declare `Bun.YAML` at the pinned version, and a
 * gate should not wait on a types release to become structural.
 */
function parseWorkflow(name: string): { on?: unknown; jobs?: Record<string, unknown> } {
  const yaml = (Bun as unknown as { YAML: { parse(source: string): unknown } }).YAML;
  return yaml.parse(readWorkflow(name)) as { on?: unknown; jobs?: Record<string, unknown> };
}

/** The `on:` block, from `on:` to the next top-level key. Text — the second belt. */
function triggerBlock(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^on:/.test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[A-Za-z]/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("the release workflow", () => {
  const release = readWorkflow("release.yml");

  test("fires ONLY on a `v*` tag or a workflow_dispatch (parsed, not sliced)", () => {
    // THE STRUCTURAL ASSERTION: the whole `on` object, compared as data. A third trigger, a branch
    // filter, a `phase-*` tag pattern -- any of them changes this object and fails here.
    expect(parseWorkflow("release.yml").on).toEqual({ push: { tags: ["v*"] }, workflow_dispatch: {} });
    expect(Object.keys(parseWorkflow("release.yml").jobs ?? {}).sort()).toEqual(["publish", "publish-npm"]);
  });

  test("ci.yml's own triggers carry no tag and no publish job", () => {
    const ci = parseWorkflow("ci.yml");
    expect(ci.on).toEqual(["push", "pull_request"]);
    expect(Object.keys(ci.jobs ?? {}).sort()).toEqual(["build", "pack-smoke"]);
  });

  test("the text belt agrees with the parse", () => {
    const block = triggerBlock(release);
    expect(block).toContain('tags: ["v*"]');
    expect(block).toContain("workflow_dispatch:");
    // No branch trigger, and no phase tag: `phase-7b-runtime-sdk` must never publish anything.
    expect(block).not.toMatch(/branches:/);
    expect(block).not.toMatch(/phase-/);
    // EXACTLY two triggers, named -- a third one added below the block would otherwise pass every
    // assertion above.
    expect(block.match(/^ {2}([a-z_]+):/gm)).toEqual(["  push:", "  workflow_dispatch:"]);
  });

  test("the publish steps are gated behind that workflow and nowhere else", () => {
    const workflows = readdirSync(WORKFLOW_DIR).sort();
    expect(workflows).toEqual(["ci.yml", "release.yml"]);
    const ci = readWorkflow("ci.yml");
    // The word appears in ci.yml only inside the comment that says this very thing.
    const publishLines = ci.split("\n").filter((line) => /publish/i.test(line));
    for (const line of publishLines) expect(line.trimStart().startsWith("#")).toBe(true);
    expect(ci).not.toMatch(/^\s*-\s*run:.*publish/m);
  });

  test("the npm leg is token-gated and carries provenance; the GitHub Packages leg carries `packages: write`", () => {
    expect(release).toContain("if: ${{ env.NPM_TOKEN != '' }}");
    expect(release).toContain("id-token: write");
    expect(release).toContain("packages: write");
    expect(release).toContain("needs: publish");
    // `--provenance` lives in the script (pnpm's recursive publish drops the flag); the workflow
    // calls that script rather than spelling a publish command that would silently lose it.
    expect(readFileSync(join(REPO_ROOT, "scripts", "publish-npm.ts"), "utf8")).toContain("--provenance");
  });

  test("both publish jobs run the version/tag gate before anything is published", () => {
    const jobs = release.split(/^  [a-z-]+:$/m);
    const publishJobs = jobs.filter((job) => job.includes("publish"));
    expect(publishJobs.length).toBeGreaterThan(0);
    for (const job of publishJobs) {
      if (!job.includes("pnpm publish") && !job.includes("publish-npm.ts")) continue;
      expect(job).toContain("check-release-version.ts");
      expect(job).toContain("build:packages");
    }
  });
});

describe("the ci workflow runs every gate", () => {
  const ci = readWorkflow("ci.yml");

  test("build, the full suite, and the typecheck — in that order, inside the build job", () => {
    // The BUILD job's own text, so a step in another job cannot satisfy this ordering.
    const build = ci.slice(ci.indexOf("\n  build:"), ci.indexOf("\n  pack-smoke:"));
    const buildAt = build.indexOf("- run: bun run build:packages");
    const testAt = build.indexOf("- run: bun test");
    const typecheckAt = build.indexOf("- run: bun run typecheck");
    expect(buildAt).toBeGreaterThan(0);
    expect(testAt).toBeGreaterThan(buildAt);
    expect(typecheckAt).toBeGreaterThan(testAt);
  });

  test("the installed-tarball smoke runs under BOTH runtimes, blocking", () => {
    expect(ci).toContain("scripts/smoke-installed.ts --runtime=node");
    expect(ci).toContain("scripts/smoke-installed.ts --runtime=bun");
    expect(ci).not.toContain("continue-on-error");
  });

  test("`pnpm install --frozen-lockfile` everywhere -- never a bare install", () => {
    const installs = ci.split("\n").filter((line) => /pnpm install/.test(line));
    expect(installs.length).toBeGreaterThan(0);
    for (const line of installs) expect(line).toContain("--frozen-lockfile");
  });

  test("the peer checkout is public and unauthenticated -- no cross-repo secret in CI", () => {
    expect(ci).toContain("repository: yanlingLabs/winter-agent-sdk");
    expect(ci).not.toMatch(/token:\s*\$\{\{\s*secrets\./);
  });
});

describe("the manifest a publish would ship", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    files: string[];
    exports: Record<string, Record<string, string>>;
    publishConfig: { exports: Record<string, Record<string, string>> };
    scripts: Record<string, string>;
    winter?: { publish?: { npm?: boolean } };
  };

  test("is dist-only: `files` never lists src, and publishConfig drops the `bun` condition", () => {
    expect(manifest.files).not.toContain("src");
    expect(manifest.exports["."]?.["bun"]).toBe("./src/index.ts");
    expect(manifest.publishConfig.exports["."]?.["bun"]).toBeUndefined();
    expect(manifest.publishConfig.exports["."]?.["default"]).toBe("./dist/index.js");
    // Every in-repo `exports` key has a publishConfig twin -- a new subpath cannot ship with a `bun`
    // condition just because someone forgot the override.
    expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(Object.keys(manifest.exports).sort());
  });

  test("carries the pnpm-only pack guard", () => {
    expect(manifest.scripts["prepack"]).toContain("npm_config_user_agent");
    expect(manifest.scripts["prepack"]).toContain("pnpm");
  });
});

describe("no Anthropic artifact is committed (WS-02 §2)", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\n").filter((p) => p.length > 0);

  test("the sweep sees the tree", () => {
    expect(tracked.length).toBeGreaterThan(20);
  });

  test("nothing tracked is the pinned package, its bundle, or a vendored copy", () => {
    const offenders = tracked.filter((path) => {
      const segments = path.split("/");
      return segments.includes("claude-agent-sdk") || segments.includes("sdk.mjs") || segments.includes("node_modules") || segments.includes("compat");
    });
    expect(offenders).toEqual([]);
  });

  test("`.gitignore` keeps node_modules out, which is where the pinned package lives", () => {
    const ignore = readFileSync(join(REPO_ROOT, ".gitignore"), "utf8");
    expect(ignore.split("\n").map((l) => l.trim())).toContain("node_modules");
    expect(ignore.split("\n").map((l) => l.trim())).toContain("dist");
  });
});
