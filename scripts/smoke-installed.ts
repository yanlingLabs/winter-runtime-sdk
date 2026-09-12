// THE INSTALL-FROM-TARBALL SMOKE — what a consumer actually gets, under Node AND Bun.
//
// WS-02 §9 item 3: "a dry-run pack + install-from-tarball smoke test (Node 18 and Bun) gates every
// publish". This script packs fresh (running the tarball scan — a violation aborts before anything is
// installed), installs into a throwaway directory OUTSIDE the repo, and imports every declared
// `exports` entry under each requested runtime, failing loudly on the first import error.
//
// IT NEEDS THE NETWORK (M-5). `--offline` is gone with the symlink it existed for: both the tarball's
// install and the peer's come from the registry, so a local run without network access fails at the
// install step rather than in anything this script is about. CI always has it.
//
// THE REQUIRED PEER IS AN ORDINARY REGISTRY INSTALL (R6, the close-out collapse).
// `@yanlinglabs/winter-agent-sdk` is a REQUIRED PEER: the router's `dist/index.js` opens with
// `export * from "@yanlinglabs/winter-agent-sdk"`, so importing the package without a resolvable
// peer is not a failure of the tarball, it is the documented consequence of not installing a peer.
// Now that the peer is published, the probe installs the EXACT version this checkout has resolved
// (read off the installed copy's own manifest, not re-spelled as a range) alongside the tarball —
// which is exactly what a host with both packages vendored will have — and asserts the ROUTER's
// tarball is the dist-only thing under test.
//
// WHAT THIS PROVES, precisely: the packed manifest resolves, the compiled `default` entry runs under
// Node (which cannot execute TypeScript), the `bun` condition is gone from the published manifest,
// no `src/` shipped, and — the addition from review r1's M7 — a project WITHOUT the OPTIONAL peer can
// still TYPE-CHECK against the published declarations. That last one is a `tsc` run, not an import:
// the failure it guards against (`Cannot find module '@anthropic-ai/claude-agent-sdk'` coming out of
// our own `.d.ts`) is invisible to a runtime import, because types are erased before anything runs.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { peerPackageDir } from "./build-packages.ts";
import { releasePack } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one peer this package cannot be imported without. Spelled once. */
const REQUIRED_PEER = "@yanlinglabs/winter-agent-sdk";
/** The peer a consumer may legitimately NOT have — the whole subject of the type-check leg below. */
const OPTIONAL_PEER = "@anthropic-ai/claude-agent-sdk";

export type SmokeRuntime = "node" | "bun";

export interface ImportTarget {
  specifier: string;
  runtimes: SmokeRuntime[];
  /**
   * The floor `importUnder` treats as "actually imported something," not an empty or wrong module.
   *
   * NOT ONE NUMBER FOR EVERY TARGET. The root `"."` re-exports the entire Winter SDK plus this
   * package's own names (150+ as of 0.0.3) — a count near that is meaningful evidence the right file
   * loaded. A subpath is deliberately narrower: `"./testing"` (0.0.3, P8c-13) exports seven runtime
   * names on purpose, by the same design that keeps two optional peers out of its graph (see
   * `src/testing/host.ts`'s header) — a 10-name floor tuned for the root would fail it for being
   * exactly as small as it was built to be. So every subpath gets a floor of 1 (still catches the
   * real defect this check is for: an import that silently resolved to an empty stub or the wrong
   * file), and only `"."` keeps the larger number.
   */
  minExports: number;
}

interface ManifestShape {
  name: string;
  exports?: Record<string, unknown> | string;
  engines?: Record<string, string>;
}

/**
 * Which runtimes a target must import under, from the package's OWN `engines`.
 *
 * `engines.node` means "a Node consumer may import this" and the Node leg asserts it; `engines.bun`
 * alone means Bun-only. A package declaring NEITHER is required under both — fail closed, so a new
 * package cannot opt out of the gate by omission.
 */
export function runtimesFor(manifest: ManifestShape): SmokeRuntime[] {
  const engines = manifest.engines ?? {};
  const out: SmokeRuntime[] = [];
  if (engines["node"] !== undefined || (engines["node"] === undefined && engines["bun"] === undefined)) out.push("node");
  out.push("bun"); // Bun runs everything this repository produces, declared or not
  return out;
}

/** Every declared `exports` entry, derived from the manifest — never hand-maintained. */
export function deriveImportTargets(root: string = REPO_ROOT): ImportTarget[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as ManifestShape;
  const runtimes = runtimesFor(manifest);
  const field = manifest.exports;
  if (field === undefined || typeof field === "string") return [{ specifier: manifest.name, runtimes, minExports: 10 }];
  return Object.keys(field)
    .map((key) => ({ specifier: key === "." ? manifest.name : `${manifest.name}/${key.replace(/^\.\//, "")}`, runtimes, minExports: key === "." ? 10 : 1 }))
    .sort((a, b) => a.specifier.localeCompare(b.specifier));
}

/**
 * Every violation of the dist-only contract in an INSTALLED tree.
 *
 * The tarball scan reads the archive; this reads what the installer actually WROTE — the same fact
 * one step further along, and the step a consumer lives in. Exported so its test can drive it against
 * a synthetic tree: a check that has never been shown failing is a check nobody can trust.
 */
export function assertInstalledTreeIsDistOnly(probeDir: string, packageName: string): string[] {
  const violations: string[] = [];
  const pkgDir = join(probeDir, "node_modules", ...packageName.split("/"));
  if (existsSync(join(pkgDir, "src"))) violations.push(`  ${packageName}: node_modules/${packageName}/src exists — a published package ships compiled output only`);
  const manifestPath = join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) {
    violations.push(`  ${packageName}: installed but has no package.json`);
    return violations;
  }
  const field = (JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> | string }).exports;
  if (typeof field !== "object" || field === null) return violations;
  for (const [subpath, conditions] of Object.entries(field)) {
    const targets = typeof conditions === "string" ? { default: conditions } : (conditions as Record<string, unknown>);
    for (const [condition, target] of Object.entries(targets)) {
      if (condition === "bun") violations.push(`  ${packageName}: installed exports["${subpath}"] still carries a \`bun\` condition (${String(target)}), which points outside a dist-only package`);
      if (typeof target === "string" && target.startsWith("./src/")) violations.push(`  ${packageName}: installed exports["${subpath}"].${condition} names ${target}`);
    }
  }
  return violations;
}

async function importUnder(runtime: SmokeRuntime, specifier: string, probeDir: string, minExports: number): Promise<{ ok: boolean; output: string }> {
  const code = `import(${JSON.stringify(specifier)}).then((m) => { const n = Object.keys(m).length; if (n < ${minExports}) { console.error(${JSON.stringify(`${runtime}: ${specifier} imported but exported`)}, n, "names"); process.exit(1); } console.log(${JSON.stringify(`${runtime}: ${specifier} OK`)}, n, "exports"); }).catch((e) => { console.error(${JSON.stringify(`${runtime}: ${specifier} FAILED:`)}, e && e.message ? e.message : e); process.exit(1); });`;
  const proc = Bun.spawn([runtime, "-e", code], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { ok: exitCode === 0, output: (stdout + stderr).trim() };
}

/**
 * M7: a consumer WITHOUT the optional peer can type-check against the installed declarations.
 *
 * `skipLibCheck: false` on purpose — the whole point is the strictest reading, since a consumer with
 * `skipLibCheck: true` would never have seen the problem. Diagnostics are filtered to the ONE
 * condition this gate owns: an unresolved module (TS2307) naming the optional peer. Anything else the
 * checker says about a dependency's own declarations is that dependency's business, and failing on it
 * here would make this gate flaky for reasons it cannot fix.
 */
async function typecheckWithoutOptionalPeer(probeDir: string, packageName: string, root: string): Promise<{ ok: boolean; output: string }> {
  const peerDir = join(probeDir, "node_modules", ...OPTIONAL_PEER.split("/"));
  if (existsSync(peerDir)) return { ok: false, output: `the probe project has ${OPTIONAL_PEER} installed -- this gate is meaningless unless the OPTIONAL peer is absent` };
  writeFileSync(
    join(probeDir, "probe.ts"),
    [
      `// Generated by scripts/smoke-installed.ts. Imports the package the way a consumer would, and`,
      `// touches the types that used to name the optional peer.`,
      `import { createRuntimeSdk, type RuntimeSdk, type RuntimeSdkPeers, type OfficialAdapter, type OfficialOptions } from ${JSON.stringify(packageName)};`,
      `export type Peers = RuntimeSdkPeers;`,
      `export type Adapter = OfficialAdapter;`,
      `export type Opts = OfficialOptions;`,
      `export const make: typeof createRuntimeSdk = createRuntimeSdk;`,
      `export declare const sdk: RuntimeSdk;`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(probeDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, module: "esnext", moduleResolution: "bundler", target: "es2022", types: [] },
        files: ["probe.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "-p", join(probeDir, "tsconfig.json")], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const output = `${stdout}${stderr}`;
  // GREEN BECAUSE NOTHING RAN is the one failure shape this repository's gates take pains to exclude,
  // and filtering diagnostics has exactly that hole: a `tsc` that could not launch emits none. `tsc`
  // exits 0 (clean), 1 (diagnostics) or 2 (diagnostics with errors); anything else — a missing binary,
  // a bad `-p`, a crash — means the check did not happen, and that is a failure of the GATE, reported
  // as itself rather than as a passing type-check.
  if (![0, 1, 2].includes(exitCode)) {
    return { ok: false, output: `tsc did not run (exit ${exitCode}) -- this leg proves nothing until it does:\n${output.trim()}` };
  }
  const diagnostics = output.split("\n").filter((line) => /error TS\d+:/.test(line));
  const unresolvedPeer = diagnostics.filter((line) => line.includes("TS2307") && line.includes(OPTIONAL_PEER));
  if (unresolvedPeer.length > 0) {
    return { ok: false, output: `the published declarations force resolution of the OPTIONAL peer:\n${unresolvedPeer.join("\n")}` };
  }
  // ANY diagnostic pointing INTO this package's own installed declarations is ours, whatever its
  // code — a consumer type-checking us must get a clean read, and "no TS2307 for the peer" alone
  // would let a different defect in our `.d.ts` pass as success.
  const ours = diagnostics.filter((line) => line.includes(`node_modules/${packageName}/`));
  if (ours.length > 0) {
    return { ok: false, output: `the published declarations do not type-check for a consumer:\n${ours.join("\n")}` };
  }
  // What is left comes from a DEPENDENCY's own declarations (today: one `Cannot find name 'Buffer'`
  // out of the Winter SDK's store, because this probe deliberately installs no `@types/node`). Not
  // this package's contract, so not this gate's failure — but reported, never swallowed.
  const foreign = diagnostics.length;
  return {
    ok: true,
    output:
      `type-check against the installed declarations with NO optional peer: tsc exit ${exitCode}, ` +
      `0 diagnostics in ${packageName}, ${foreign} from its dependencies` +
      (foreign > 0 ? ` (first: ${diagnostics[0]?.trim()})` : ""),
  };
}

/**
 * THE PROBE'S OWN `.npmrc` — the smoke installs from the PUBLIC registry, whatever the job is pinned to.
 *
 * WHY IT EXISTS (release 0.0.2, run 1). The GitHub Packages release job runs `actions/setup-node` with
 * `registry-url: https://npm.pkg.github.com` + `scope: "@yanlinglabs"`, which writes a throwaway
 * USERCONFIG carrying `@yanlinglabs:registry=https://npm.pkg.github.com` — and from that step on every
 * npm resolution of the scope goes there. That is exactly right for `pnpm publish`, and exactly wrong
 * for this script: since R6 the probe installs the required PEER from a registry
 * (`@yanlinglabs/winter-agent-sdk@<resolved>`), so it asked GitHub Packages, at a step that carries no
 * token, and the release failed `401 unauthenticated` after every other gate had passed.
 *
 * WHAT THIS SMOKE IS ABOUT decides where the fix belongs: "what a CONSUMER actually gets" — a consumer
 * who installs the published tarball and the published peer from the public registry. The registry the
 * probe reads is therefore a property of the PROBE, not of the job, and pinning it in the workflow
 * would leave the same landmine for the next job that pins a scope (and for a developer whose own user
 * `.npmrc` points `@yanlinglabs` somewhere else). A project-level `.npmrc` in the probe directory beats
 * the userconfig in npm's own precedence order, which is what makes this independent rather than
 * merely usually-right.
 *
 * NO TOKEN, DELIBERATELY. Both packages are public on npmjs; a credential here would make the gate
 * pass for a reason a consumer does not have.
 */
export const PROBE_NPMRC = ["registry=https://registry.npmjs.org/", "@yanlinglabs:registry=https://registry.npmjs.org/", ""].join("\n");

export interface SmokeResult {
  ok: boolean;
  results: Array<{ specifier: string; runtime: SmokeRuntime; ok: boolean; output: string }>;
  targets: ImportTarget[];
}

export async function runSmoke(opts: { runtimes?: readonly SmokeRuntime[]; root?: string } = {}): Promise<SmokeResult> {
  const root = opts.root ?? REPO_ROOT;
  const runtimes = opts.runtimes ?? (["node", "bun"] as const);
  const outDir = mkdtempSync(join(tmpdir(), "winter-runtime-sdk-smoke-pack-"));
  const probeDir = mkdtempSync(join(tmpdir(), "winter-runtime-sdk-smoke-probe-"));
  const results: SmokeResult["results"] = [];
  try {
    const packed = await releasePack({ outDir, root });
    if (packed.violations.length > 0) throw new Error(`release-pack found violations, refusing to smoke-test:\n${packed.violations.join("\n")}`);
    const targets = deriveImportTargets(root);

    // The EXACT version this checkout has resolved (never re-spelled as a range): the smoke tests
    // the same peer version the tarball was built and tested against, not "whatever satisfies the
    // range that day."
    const peerDir = peerPackageDir(REQUIRED_PEER, root);
    if (peerDir === undefined) throw new Error(`smoke-installed: the required peer ${REQUIRED_PEER} is not resolvable from this repository — run \`pnpm install\``);
    const peerManifest = JSON.parse(readFileSync(join(peerDir, "package.json"), "utf8")) as { version?: unknown };
    if (typeof peerManifest.version !== "string") throw new Error(`smoke-installed: ${REQUIRED_PEER}'s installed package.json carries no \`version\``);

    // Outside the repository on purpose: a fresh mkdtemp, no workspace file, no lockfile, and no
    // configuration but the registry pin below. What makes this succeed is the tarball itself plus an
    // ORDINARY public-registry install of the required peer (R6) — no symlink, no sibling checkout.
    writeFileSync(join(probeDir, "package.json"), `${JSON.stringify({ name: "winter-runtime-sdk-smoke-probe", private: true, version: "0.0.0" }, null, 2)}\n`);
    // …with ONE piece of configuration, and it is the registry (see `PROBE_NPMRC`): a project-level
    // `.npmrc` here outranks whatever userconfig the surrounding job wrote, so the peer comes from the
    // public registry in CI, in the release job, and on a developer's machine alike.
    writeFileSync(join(probeDir, ".npmrc"), PROBE_NPMRC);
    // `--legacy-peer-deps`: npm 7+ tries to INSTALL peer dependencies, and the OPTIONAL peer
    // (`@anthropic-ai/claude-agent-sdk`) is deliberately absent here — `typecheckWithoutOptionalPeer`
    // below is what that absence exists to prove. No `--offline`: the required peer's install below
    // needs the registry now that it is a real dependency, not a symlink onto this checkout.
    const install = Bun.spawnSync(["npm", "install", "--legacy-peer-deps", packed.packed.tarballPath, `${REQUIRED_PEER}@${peerManifest.version}`], { cwd: probeDir, stdout: "pipe", stderr: "pipe" });
    if (install.exitCode !== 0) {
      throw new Error(`npm install failed (exit ${install.exitCode}):\n${new TextDecoder().decode(install.stdout)}${new TextDecoder().decode(install.stderr)}`);
    }

    const distOnly = assertInstalledTreeIsDistOnly(probeDir, packed.packed.name);
    if (distOnly.length > 0) throw new Error(`the installed tree is not dist-only:\n${distOnly.join("\n")}`);

    const typecheck = await typecheckWithoutOptionalPeer(probeDir, packed.packed.name, root);
    if (!typecheck.ok) throw new Error(`smoke-installed: ${typecheck.output}`);
    console.log(`smoke-installed OK: ${typecheck.output}`);

    for (const runtime of runtimes) {
      for (const target of targets) {
        if (!target.runtimes.includes(runtime)) {
          console.log(`smoke-installed SKIP: ${runtime} import of "${target.specifier}" — that package declares no \`engines.${runtime}\``);
          continue;
        }
        const result = await importUnder(runtime, target.specifier, probeDir, target.minExports);
        results.push({ specifier: target.specifier, runtime, ok: result.ok, output: result.output });
        if (!result.ok) {
          console.error(`smoke-installed FAILED: ${runtime} import of "${target.specifier}"\n${result.output}`);
          return { ok: false, results, targets };
        }
        console.log(`smoke-installed OK: ${result.output}`);
      }
    }
    return { ok: true, results, targets };
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(probeDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const runtimeArg = process.argv.find((a) => a.startsWith("--runtime="))?.split("=")[1];
  if (runtimeArg !== undefined && runtimeArg !== "node" && runtimeArg !== "bun") {
    console.error(`smoke-installed: --runtime must be "node" or "bun", got "${runtimeArg}"`);
    process.exit(1);
  }
  const { ok, targets } = await runSmoke(runtimeArg ? { runtimes: [runtimeArg] } : {});
  console.log(`smoke-installed: ${targets.length} target(s) across every declared exports entry`);
  if (!ok) process.exitCode = 1;
  else console.log("smoke-installed OK — every target imports cleanly under every requested runtime");
}
