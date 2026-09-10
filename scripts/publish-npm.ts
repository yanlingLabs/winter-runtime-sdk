// THE npm LEG: pack with pnpm, publish the TARBALL with npm, attach provenance.
//
// THE COMBINATION IS THE POINT, and it is the SDK repository's own hard-won recipe:
//   * `pnpm pack` (via `releasePack`) is what applies `publishConfig.exports`/`files` — the dist-only
//     overrides. Plain `npm pack` IGNORES them, and a hand-packed tarball would carry a manifest whose
//     `bun` condition names a `src/` that is not inside it.
//   * `npm publish <tarball> --provenance` is what actually attaches a signed provenance statement.
//     pnpm's own recursive publish REBUILDS npm's argv and forwards only a few flags — `--provenance`
//     is silently dropped, and a YAML-text assertion would keep passing while nothing was signed.
//
// SKIP-IF-EXISTS runs inside this script, against THIS registry, so a `workflow_dispatch` re-drive at
// the same tag finishes a half-done release instead of colliding on a version that is already there.
import { fileURLToPath } from "node:url";

import { checkAlreadyPublished } from "./check-already-published.ts";
import { releasePack } from "./release-pack.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const NPM_REGISTRY = "https://registry.npmjs.org";

export type PublishOutcome = "published" | "skipped" | "dry-run";

export interface PublishResult {
  /** True only when npm actually accepted the tarball. A dry-run is NOT a publish. */
  published: boolean;
  outcome: PublishOutcome;
  reason: string;
}

export async function publishToNpm(opts: { registry?: string; root?: string; dryRun?: boolean } = {}): Promise<PublishResult> {
  const root = opts.root ?? REPO_ROOT;
  const registry = opts.registry ?? NPM_REGISTRY;
  const already = await checkAlreadyPublished({ registry, root });
  if (already.state === "published") return { published: false, outcome: "skipped", reason: already.detail };

  const packed = await releasePack({ root });
  if (packed.violations.length > 0) throw new Error(`publish-npm: REFUSING — the tarball carries forbidden content:\n${packed.violations.join("\n")}`);

  const args = ["npm", "publish", packed.packed.tarballPath, "--provenance", "--access", "public", "--registry", registry];
  if (opts.dryRun === true) args.push("--dry-run");
  const proc = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`publish-npm: \`${args.join(" ")}\` failed (exit ${exitCode})`);
  const spec = `${packed.packed.name}@${packed.packed.version}`;
  // GREEN BECAUSE NOTHING RAN, named as such: a dry-run exits 0 having published nothing, and a final
  // line that said PUBLISHED taught a reader the opposite of what happened (Phase 8a Task 0 review).
  if (opts.dryRun === true) return { published: false, outcome: "dry-run", reason: `${spec} would be published (dry-run) to ${registry}` };
  return { published: true, outcome: "published", reason: `${spec} published to ${registry}` };
}

if (import.meta.main) {
  const result = await publishToNpm({ dryRun: process.argv.includes("--dry-run") });
  console.log(`publish-npm: ${result.outcome.toUpperCase()} — ${result.reason}`);
}
