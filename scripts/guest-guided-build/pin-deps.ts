/** Offline generator for the `dependencies` block of guided-compile-inputs.pin.json. It reads the two lockfiles you
 * point it at and nothing else: no network, no install, no process. Run it again, and diff, whenever the agent-sdk
 * or Winter Core head moves (docs: README "Moving a pinned origin"):
 *   bun run scripts/guest-guided-build/pin-deps.ts --sdk-lock <agent-sdk>/pnpm-lock.yaml --winter-lock <winter>/pnpm-lock.yaml
 * Each package is pinned by the lockfile's own sha512 integrity; ids are pnpm virtual-store ids. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Pkg = { id: string; name: string; version: string; url: string; sha512: string; dependencies: Record<string, string> };
// What each origin imports by bare name. Closed on purpose: a name here must be reached by a role, or the build refuses.
export const ALIASES: Record<string, Record<string, string>> = {
  sdk: { "@modelcontextprotocol/client": "@modelcontextprotocol/client@2.1.0", ajv: "ajv@8.20.0", ignore: "ignore@7.0.5" },
  winter: { zod: "zod@4.4.3" },
};
const yaml = (Bun as unknown as { YAML: { parse(source: string): unknown } }).YAML;

export function closure(lockText: string, roots: string[]): Pkg[] {
  const lock = yaml.parse(lockText) as { snapshots: Record<string, any>; packages: Record<string, any> };
  const out = new Map<string, Pkg>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    if (id.includes("(")) throw new Error(`peer-suffixed snapshot id is not pinned: ${id}`);
    const snap = lock.snapshots[id], meta = lock.packages[id];
    if (!snap || !meta) throw new Error(`lock has no entry for ${id}`);
    const at = id.lastIndexOf("@"), name = id.slice(0, at), version = id.slice(at + 1);
    const integrity: string = meta.resolution?.integrity ?? "";
    if (!integrity.startsWith("sha512-")) throw new Error(`no sha512 integrity for ${id}`);
    const base = name.startsWith("@") ? name.split("/")[1]! : name;
    const dependencies: Record<string, string> = {};
    for (const [dep, range] of Object.entries({ ...(snap.dependencies ?? {}), ...(snap.optionalDependencies ?? {}) }) as [string, string][]) {
      dependencies[dep] = `${dep}@${range}`;
      queue.push(`${dep}@${range}`);
    }
    out.set(id, { id, name, version, url: `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`, sha512: Buffer.from(integrity.slice(7), "base64").toString("hex"), dependencies: Object.fromEntries(Object.entries(dependencies).sort()) });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function render(sdkLockText: string, winterLockText: string) {
  const sdk = closure(sdkLockText, Object.values(ALIASES.sdk!));
  const winter = closure(winterLockText, Object.values(ALIASES.winter!));
  const packages = [...sdk, ...winter];
  const ids = packages.map((pkg) => pkg.id);
  if (new Set(ids).size !== ids.length) throw new Error("the same package id comes from both lockfiles; the layout would collide");
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  return { registry: "https://registry.npmjs.org/", generatedFrom: { agentSdkPnpmLockSha256: sha(sdkLockText), winterPnpmLockSha256: sha(winterLockText) }, aliases: ALIASES, packages };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const at = args.indexOf(flag); if (at < 0 || !args[at + 1]) throw new Error(`${flag} required`); return args[at + 1]!; };
  console.log(JSON.stringify(render(readFileSync(value("--sdk-lock"), "utf8"), readFileSync(value("--winter-lock"), "utf8")), null, 1));
}
