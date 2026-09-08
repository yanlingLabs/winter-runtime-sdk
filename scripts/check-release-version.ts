// THE VERSION/TAG CONSISTENCY GATE, run before anything is published.
//
// A publish is triggered by pushing `v<version>`, and what actually ships is whatever the manifest
// says at that commit — equal only because a human ran the bump before tagging. Diverging does not
// fail the publish: it SUCCEEDS at publishing the wrong number, to registries where a version can
// never be re-published. So this runs first, on both publish jobs, and fails closed.
//
// On `workflow_dispatch` there is no tag and the manifest-vs-`VERSION` half still runs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export interface VersionCheck {
  ok: boolean;
  version: string;
  versionFile: string;
  tag?: string;
  problems: string[];
}

/** `refs/tags/v0.0.1` -> `0.0.1`; anything else -> undefined. */
export function versionFromRef(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  const match = /^refs\/tags\/v(.+)$/.exec(ref);
  return match?.[1];
}

export function checkReleaseVersion(opts: { root?: string; ref?: string } = {}): VersionCheck {
  const root = opts.root ?? REPO_ROOT;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
  const versionFile = readFileSync(join(root, "VERSION"), "utf8").trim();
  const tag = versionFromRef(opts.ref ?? process.env["GITHUB_REF"]);
  const problems: string[] = [];
  if (manifest.version !== versionFile) problems.push(`package.json says ${manifest.version} and VERSION says ${versionFile}`);
  if (tag !== undefined && tag !== manifest.version) problems.push(`the pushed tag is v${tag} and package.json says ${manifest.version}`);
  return { ok: problems.length === 0, version: manifest.version, versionFile, ...(tag === undefined ? {} : { tag }), problems };
}

if (import.meta.main) {
  const result = checkReleaseVersion();
  if (!result.ok) {
    console.error(`check-release-version: REFUSING — ${result.problems.join("; ")}`);
    process.exit(1);
  }
  console.log(`check-release-version: OK — ${result.version}${result.tag === undefined ? " (no tag on this ref)" : ` matches the pushed tag v${result.tag}`}`);
}
