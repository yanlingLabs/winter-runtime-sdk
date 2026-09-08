// IDEMPOTENT RE-DRIVE, stated out loud: does THIS registry already have THIS version?
//
// Both registries refuse a version they already hold, so a half-done release must be finished by a
// `workflow_dispatch` at the SAME tag rather than by a version bump (a bump would leave the tag
// naming something other than what shipped). This script says, before the publish, whether the
// version is already there — so the log explains a skip instead of leaving a reader to infer it from
// a swallowed error.
//
// IT NEVER FAILS THE BUILD ON A LOOKUP ERROR. "Not published" and "could not ask" are different
// answers and only one of them is a reason to stop; a registry hiccup must not turn into a publish
// that is skipped silently. Unknown is reported as unknown and the publish proceeds (the registry
// itself is the backstop: it refuses a duplicate).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export type PublishedState = "published" | "absent" | "unknown";

export interface AlreadyPublishedResult {
  name: string;
  version: string;
  registry: string;
  state: PublishedState;
  detail: string;
}

export async function checkAlreadyPublished(opts: { registry: string; root?: string }): Promise<AlreadyPublishedResult> {
  const root = opts.root ?? REPO_ROOT;
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
  const spec = `${manifest.name}@${manifest.version}`;
  const proc = Bun.spawn(["npm", "view", spec, "version", "--registry", opts.registry], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const base = { name: manifest.name, version: manifest.version, registry: opts.registry };
  if (exitCode === 0 && stdout.trim() === manifest.version) return { ...base, state: "published", detail: `${spec} is already on ${opts.registry}` };
  const combined = `${stdout}${stderr}`;
  if (/E404|is not in this registry|404 Not Found|No match found/i.test(combined)) return { ...base, state: "absent", detail: `${spec} is not on ${opts.registry} yet` };
  return { ...base, state: "unknown", detail: `could not determine whether ${spec} is on ${opts.registry}: ${combined.trim().split("\n").slice(-3).join(" ")}` };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--registry");
  const registry = index === -1 ? undefined : process.argv[index + 1];
  if (registry === undefined) {
    console.error("check-already-published: --registry <url> is required");
    process.exit(1);
  }
  const result = await checkAlreadyPublished({ registry });
  console.log(`check-already-published: ${result.state.toUpperCase()} — ${result.detail}`);
}
