// THE COMPILED EMIT — this repository's single package, built the way the SDK repository builds its
// five (`scripts/build-packages.ts` there, adapted here for one package at the repo root).
//
// WHY A COMPILED EMIT AT ALL. `exports` points `bun` at `./src/index.ts` and `default` at
// `./dist/index.js`. Bun — this repo's own tests and any Bun consumer — keeps resolving the SOURCE,
// byte for byte. Node cannot import TypeScript at any version (and REFUSES to strip types for a file
// under `node_modules`: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a Node consumer falls
// through to `default`, and WS-02 §9 item 3 gates every publish on an install-from-tarball smoke
// under Node 18 AND Bun.
//
// TWO EMITTERS, because they answer two different questions:
//   * JS — ONE `bun build` listing every export entry, `--splitting --outdir dist`.
//     `--packages=external` keeps every bare specifier (both peers) a real import the consumer's own
//     node_modules resolves, which is the whole architecture: the peers are INJECTED, never bundled.
//   * declarations — `tsc --emitDeclarationOnly`, then a bounded rewrite of relative `.ts` specifiers
//     to `.js`. It has to be tsc (`bun build` emits no types), and `rewriteRelativeImportExtensions`
//     provably does NOT rewrite emitted `.d.ts` (measured on 5.9 in the SDK repository), so the
//     rewrite below is what actually makes the declarations resolvable — with its own plant test.
//
// THE PEER'S OWN DECLARATIONS MUST EXIST FIRST, and this script says so out loud rather than failing
// inside tsc. `tsconfig.build.json` sets `paths: {}` — it must, because the repo-wide `paths` point
// at the sibling checkout's `src`, and files outside `rootDir` break a declaration emit outright. So
// `@yanlinglabs/winter-agent-sdk` resolves the ordinary way, through node_modules to its `types`
// condition, i.e. to ITS `dist` — which is gitignored in that repository and absent on a fresh clone.
// One `bun run build:packages` over there fixes it; the message below says exactly that.
//
// NOTHING HERE PUBLISHES ANYTHING and nothing here writes outside `dist/` (gitignored).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface BuiltEntry {
  /** The `exports` key this entry serves, e.g. ".". */
  subpath: string;
  /** Source entry, package-relative. */
  source: string;
  /** Emitted JS, package-relative. */
  js: string;
  /** Emitted declaration, package-relative. */
  types: string;
}

export interface BuildResult {
  entries: BuiltEntry[];
  /** Every command that ran, in order — so a caller can report what actually happened. */
  commands: string[];
}

/**
 * The export entries, read from the manifest itself rather than listed here.
 *
 * A subpath added to `exports` without a build entry would otherwise ship a `default` pointing at a
 * file nobody emitted, and the smoke would only find it after a pack. A manifest whose map is already
 * conditional (this script's own output, on a rebuild) reads the `bun` condition — the source path.
 */
export function entriesFor(manifestPath: string): Array<{ subpath: string; sourceRelative: string }> {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> | string };
  const field = manifest.exports;
  if (field === undefined) return [{ subpath: ".", sourceRelative: "src/index.ts" }];
  if (typeof field === "string") return [{ subpath: ".", sourceRelative: field.replace(/^\.\//, "") }];
  const out: Array<{ subpath: string; sourceRelative: string }> = [];
  for (const [subpath, value] of Object.entries(field)) {
    const source =
      typeof value === "string" ? value : typeof (value as Record<string, unknown>)["bun"] === "string" ? ((value as Record<string, string>)["bun"] as string) : undefined;
    if (source === undefined) throw new Error(`build:packages: exports["${subpath}"] has no source path (expected a string or a "bun" condition)`);
    out.push({ subpath, sourceRelative: source.replace(/^\.\//, "") });
  }
  return out;
}

/** `src/x/index.ts` -> `dist/x/index.js` — the dist tree MIRRORS src, so two `index.ts` cannot collide. */
function distPathFor(sourceRelative: string, extension: ".js" | ".d.ts"): string {
  const withoutSrc = sourceRelative.replace(/^src\//, "");
  return `dist/${withoutSrc.replace(/\.ts$/, extension === ".js" ? ".js" : ".d.ts")}`;
}

/**
 * Rewrites RELATIVE module specifiers ending in `.ts` to `.js`, in one emitted `.d.ts`.
 *
 * Bounded to the two syntactic positions a specifier can occupy in a declaration file — the
 * `from "..."` clause and a type-position `import("...")` — and to specifiers that START with `.`, so
 * a package name is never touched and a `.ts` inside a string literal TYPE is left alone. Exported
 * for its plant test.
 */
export function rewriteDeclarationSpecifiers(source: string): string {
  return source
    .replace(/(\bfrom\s*)(["'])(\.[^"']*)\.ts\2/g, (_m, from: string, quote: string, path: string) => `${from}${quote}${path}.js${quote}`)
    .replace(/(\bimport\s*\(\s*)(["'])(\.[^"']*)\.ts\2/g, (_m, open: string, quote: string, path: string) => `${open}${quote}${path}.js${quote}`);
}

function declarationsUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...declarationsUnder(full).map((p) => `${entry.name}/${p}`));
    else if (entry.isFile() && entry.name.endsWith(".d.ts")) out.push(entry.name);
  }
  return out;
}

function rewriteDeclarationsIn(dir: string): number {
  let changed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      changed += rewriteDeclarationsIn(full);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const before = readFileSync(full, "utf8");
    const after = rewriteDeclarationSpecifiers(before);
    if (after !== before) {
      writeFileSync(full, after);
      changed++;
    }
  }
  return changed;
}

async function run(command: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`build:packages: \`${command.join(" ")}\` failed (exit ${exitCode}) in ${cwd}:\n${stdout}\n${stderr}`);
}

/**
 * The directory of an installed (here: `link:`ed) package, walked up from its resolved entry file.
 *
 * Walks up rather than resolving `<name>/package.json` directly, because a package whose `exports`
 * map is closed to `"."` — the Winter SDK's is — does not expose its own manifest as a subpath.
 * Returns undefined when the package cannot be resolved at all.
 */
export function peerPackageDir(name: string, root: string = REPO_ROOT): string | undefined {
  const require = createRequire(join(root, "package.json"));
  let dir: string;
  try {
    dir = dirname(require.resolve(name));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 10; depth++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
      if (parsed.name === name) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The peer declarations the build resolves through, checked BEFORE tsc runs.
 *
 * Exported so a test can drive it; returns the missing package names.
 */
export function missingPeerDeclarations(root: string = REPO_ROOT): string[] {
  const missing: string[] = [];
  for (const name of ["@yanlinglabs/winter-agent-sdk"]) {
    const packageDir = peerPackageDir(name, root);
    if (packageDir === undefined) {
      missing.push(`${name} (not installed — run \`pnpm install\`)`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { types?: string };
    const types = manifest.types ?? "./dist/index.d.ts";
    if (!existsSync(join(packageDir, types))) missing.push(`${name} (${types} is absent — run \`bun run build:packages\` in that checkout)`);
  }
  return missing;
}

export async function build(opts: { root?: string } = {}): Promise<BuildResult> {
  const root = opts.root ?? REPO_ROOT;
  const commands: string[] = [];
  const missing = missingPeerDeclarations(root);
  if (missing.length > 0) {
    throw new Error(
      `build:packages: this package's declaration emit resolves its peers through node_modules (tsconfig.build.json sets \`paths: {}\`, and it must), ` +
        `and these are not built:\n  ${missing.join("\n  ")}\n` +
        `The sibling checkout's \`dist\` is gitignored there, so a fresh clone always needs one build first.`,
    );
  }

  const distDir = join(root, "dist");
  // A FULL CLEAN per build: a source file deleted between builds would otherwise leave its stale
  // `.js`/`.d.ts` in the tarball, still resolvable and wrong.
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const entryPlan = entriesFor(join(root, "package.json"));
  for (const { sourceRelative } of entryPlan) mkdirSync(dirname(join(root, distPathFor(sourceRelative, ".js"))), { recursive: true });
  const buildCommand = ["bun", "build", ...entryPlan.map((e) => e.sourceRelative), "--target=node", "--format=esm", "--packages=external", "--splitting", "--outdir", "dist"];
  commands.push(buildCommand.join(" "));
  await run(buildCommand, root);

  const entries: BuiltEntry[] = [];
  for (const { subpath, sourceRelative } of entryPlan) {
    const js = distPathFor(sourceRelative, ".js");
    if (!existsSync(join(root, js))) throw new Error(`build:packages: ${subpath}: bun build produced no ${js}`);
    entries.push({ subpath, source: sourceRelative, js, types: distPathFor(sourceRelative, ".d.ts") });
  }

  const declarationsBefore = new Set(declarationsUnder(join(root, "src")));
  const tsc = ["bunx", "tsc", "-p", "tsconfig.build.json"];
  commands.push(tsc.join(" "));
  await run(tsc, root);
  const rewritten = rewriteDeclarationsIn(distDir);
  commands.push(`rewriteDeclarationSpecifiers: ${rewritten} .d.ts file(s)`);
  for (const entry of entries) {
    if (!existsSync(join(root, entry.types))) throw new Error(`build:packages: ${entry.subpath}: tsc produced no ${entry.types}`);
  }

  // NOTHING MAY LAND IN `src/`. A tsc run that fails `rootDir` containment still EMITS before it
  // reports, and it emits BESIDE THE SOURCE rather than into `outDir` — untracked, and easy to commit
  // by accident. A loud failure beats a `.gitignore` entry: the emit is the symptom, the containment
  // break is the defect.
  const stray = declarationsUnder(join(root, "src")).filter((p) => !declarationsBefore.has(p));
  if (stray.length > 0) {
    throw new Error(
      `build:packages: the declaration run wrote ${stray.length} NEW .d.ts file(s) under src/ (first few: ${stray.slice(0, 5).join(", ")}). ` +
        `That means tsc pulled in a file outside this package's rootDir; delete them, then either exclude the importer or move the shared type in.`,
    );
  }
  return { entries, commands };
}

if (import.meta.main) {
  const result = await build();
  for (const entry of result.entries) console.log(`build:packages: ${entry.subpath} -> ${entry.js} + ${entry.types}`);
  console.log(`build:packages: OK (${result.entries.length} entr${result.entries.length === 1 ? "y" : "ies"})`);
}
