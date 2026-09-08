// PACK + SCAN — one real npm tarball, a checksum, and a fail-closed content scan.
//
// NOTHING HERE PUBLISHES ANYTHING. This script only ever calls `pnpm pack` (which writes a local
// .tgz); never `pnpm publish` / `npm publish` in any form, no registry, no network, no git tag. The
// one caller allowed to publish is `.github/workflows/release.yml`, gated on a `v*` tag or
// `workflow_dispatch` — `scripts/release-gates.test.ts` pins that trigger set.
//
// THE SCAN, and why each rule is here rather than trusted to the `files` allowlist (a manifest is a
// declaration; this is the output):
//   1. FORBIDDEN DIRECTORIES — `node_modules/`, `.git/`, `compat/`. The first two are accidents; the
//      third is WS-02 §2's own home for Anthropic-DERIVED material in the SDK repository, and this
//      repository has none and must never grow one inside a tarball.
//   2. AN EMBEDDED ANTHROPIC ARTIFACT BY NAME — a path segment literally `claude-agent-sdk` (the
//      pinned package's own directory name once installed) or a file literally named `sdk.mjs`
//      (WS-02 §6.1's exact "no sdk.mjs" shape). THE binding constraint of this repository is that no
//      Anthropic artifact is ever committed or redistributed; the package is an optional peer and a
//      dev dependency, installed into `node_modules` with lockfile integrity, and `node_modules` is
//      rule 1. Deliberately narrower than a text search for "Anthropic": this package's own source
//      legitimately NAMES the peer in type positions and in prose.
//   3. CREDENTIAL-SHAPED FILES BY NAME — `.env*`, `*.pem`/`*.key`/`*.p12`/`*.pfx`, `id_rsa`-shaped
//      keys, any `*credentials.json`, a bare `.npmrc`, plus a broader case-insensitive `credential`
//      net on the basename that exempts recognised source/doc extensions (a module whose NAME
//      describes credential-handling logic is not a credential).
//   4. TEST FILES NEVER SHIP — dead weight in a consumer's node_modules, importing devDependencies
//      they never installed.
//   5. DIST-ONLY — no `src/` on disk and no `bun` condition surviving in the PACKED manifest. Those
//      two must move together: a `bun` condition pointing at a `src/` the tarball does not carry
//      resolves to nothing, and reads to a Bun consumer as a missing module rather than as a
//      manifest that lies. `publishConfig.exports` (pnpm-only, hence the `prepack` guard) is what
//      drops it.
//   6. PACKAGE IDENTITY — the packed manifest is the package this script asked for, under the
//      `@yanlinglabs/` scope.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build-packages.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_OUT_DIR = join(REPO_ROOT, "dist", "packages");

export interface PackedPackage {
  name: string;
  version: string;
  tarballPath: string;
  file: string;
  sha256: string;
  size: number;
}

export interface ReleasePackResult {
  outDir: string;
  packed: PackedPackage;
  violations: string[];
  /** Files inspected by the scan — proof it actually ran (never 0). */
  filesScanned: number;
}

const FORBIDDEN_DIR_SEGMENTS = new Set(["compat", "node_modules", ".git"]);
const ANTHROPIC_ARTIFACT_SEGMENTS = new Set(["claude-agent-sdk", "sdk.mjs"]);
const CREDENTIAL_FILENAME_RE = /^\.env(\..+)?$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$|credentials\.json$|^\.npmrc$/i;
const CREDENTIAL_SUBSTRING_RE = /credential/i;
const NON_CREDENTIAL_SOURCE_EXTENSIONS_RE = /\.(ts|tsx|js|jsx|mjs|cjs|md)$/i;
const TEST_FILE_RE = /\.test\.ts$|\.test-support\.ts$/;

interface PnpmPackJson {
  name: string;
  version: string;
  filename: string;
}

async function packOne(outDir: string, root: string): Promise<PackedPackage> {
  const proc = Bun.spawn(["pnpm", "pack", "--pack-destination", outDir, "--json"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`pnpm pack failed (exit ${exitCode}):\n${stderr || stdout}`);
  // The JSON is EXTRACTED, not assumed to be the whole of stdout: the `prepack` guard prints its own
  // banner ahead of the `--json` payload. The payload is one object and it is last.
  const jsonStart = stdout.indexOf("\n{");
  const payload = (jsonStart === -1 ? stdout : stdout.slice(jsonStart + 1)).trim();
  let parsed: PnpmPackJson;
  try {
    parsed = JSON.parse(payload) as PnpmPackJson;
  } catch {
    throw new Error(`pnpm pack did not print the expected JSON on stdout:\n${stdout}\n${stderr}`);
  }
  const bytes = readFileSync(parsed.filename);
  return {
    name: parsed.name,
    version: parsed.version,
    tarballPath: parsed.filename,
    file: basename(parsed.filename),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
}

async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const proc = Bun.spawn(["tar", "-xzf", tarballPath, "-C", destDir], { stdout: "pipe", stderr: "pipe" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`tar extraction failed for ${tarballPath} (exit ${exitCode}): ${await new Response(proc.stderr).text()}`);
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

/** Every violation in ONE extracted tarball. Exported so its test can drive it against a synthetic tree. */
export function scanExtracted(root: string, expectedName: string): { violations: string[]; filesScanned: number } {
  const violations: string[] = [];
  // `pnpm pack` produces the npm layout: everything under a single `package/` directory.
  const packageRoot = join(root, "package");
  const files = walk(packageRoot);
  for (const file of files) {
    const segments = file.split("/");
    for (const segment of segments.slice(0, -1)) {
      if (FORBIDDEN_DIR_SEGMENTS.has(segment)) violations.push(`  ${expectedName}: packed a forbidden directory: ${file}`);
    }
    for (const segment of segments) {
      if (ANTHROPIC_ARTIFACT_SEGMENTS.has(segment)) violations.push(`  ${expectedName}: packed an Anthropic artifact by name: ${file}`);
    }
    const base = segments[segments.length - 1] as string;
    if (CREDENTIAL_FILENAME_RE.test(base)) violations.push(`  ${expectedName}: packed a credentials-shaped file: ${file}`);
    else if (CREDENTIAL_SUBSTRING_RE.test(base) && !NON_CREDENTIAL_SOURCE_EXTENSIONS_RE.test(base)) {
      violations.push(`  ${expectedName}: packed a file whose name contains "credential": ${file}`);
    }
    if (TEST_FILE_RE.test(base)) violations.push(`  ${expectedName}: packed a test file: ${file}`);
    if (segments[0] === "src") violations.push(`  ${expectedName}: packed source (${file}) — published tarballs are dist-only`);
  }

  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; exports?: Record<string, unknown> | string };
  if (manifest.name !== expectedName) violations.push(`  ${expectedName}: the packed manifest names "${manifest.name}"`);
  if (!(manifest.name ?? "").startsWith("@yanlinglabs/")) violations.push(`  ${expectedName}: the packed manifest is outside the @yanlinglabs scope`);
  const exportsField = manifest.exports;
  if (typeof exportsField === "object" && exportsField !== null) {
    for (const [subpath, conditions] of Object.entries(exportsField)) {
      const targets = typeof conditions === "string" ? { default: conditions } : (conditions as Record<string, unknown>);
      for (const [condition, target] of Object.entries(targets)) {
        if (condition === "bun") violations.push(`  ${expectedName}: the packed exports["${subpath}"] still carries a \`bun\` condition (${String(target)}), which points outside a dist-only package`);
        if (typeof target === "string" && target.startsWith("./src/")) violations.push(`  ${expectedName}: the packed exports["${subpath}"].${condition} names ${target}`);
      }
    }
  }
  return { violations, filesScanned: files.length };
}

export async function releasePack(opts: { outDir?: string; root?: string } = {}): Promise<ReleasePackResult> {
  const root = opts.root ?? REPO_ROOT;
  const outDir = opts.outDir ?? DEFAULT_OUT_DIR;
  // BUILT FIRST, ALWAYS: a tarball whose `default` condition names a file nobody emitted is exactly
  // the failure the scan CANNOT see (it reads what is there, not what is missing).
  await build({ root });
  mkdirSync(outDir, { recursive: true });
  const packed = await packOne(outDir, root);
  const extractDir = mkdtempSync(join(tmpdir(), "winter-runtime-sdk-scan-"));
  try {
    await extractTarball(packed.tarballPath, extractDir);
    const { violations, filesScanned } = scanExtracted(extractDir, packed.name);
    return { outDir, packed, violations, filesScanned };
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await releasePack();
  console.log(`release:pack: ${result.packed.name}@${result.packed.version} -> ${result.packed.file} (${result.packed.size} bytes, sha256 ${result.packed.sha256})`);
  console.log(`release:pack: scanned ${result.filesScanned} file(s)`);
  if (result.violations.length > 0) {
    console.error(`release:pack: REFUSING — the tarball carries forbidden content:\n${result.violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("release:pack: OK — no forbidden content");
  }
  void sep;
}
