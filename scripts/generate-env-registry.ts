// Regenerates `src/official/env-registry.ts` from the PINNED artifact (review r3, NEW-10).
//
// Run after a reviewed runtime upgrade; the drift gate in `test/official/env-allowlist.test.ts`
// re-derives the same list and fails when the committed file and the artifact disagree, so this
// script is the only sanctioned way for that file to change.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { extractEnvRegistry, isCredentialByName } from "../src/official/env-registry-rule.ts";

const officialPackageJson = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk/package.json");
const artifact = readFileSync(join(dirname(officialPackageJson), "sdk.mjs"), "utf8");
const registry = extractEnvRegistry(artifact);
const allow = registry.filter((name) => !isCredentialByName(name)).sort();

const header = `// GENERATED FROM THE PINNED ARTIFACT — do not hand-edit. See \`env-registry-rule.ts\` for the rule
// and \`test/official/env-allowlist.test.ts\` for the drift gate that re-derives this and fails on a
// difference. Regenerate with \`bun run scripts/generate-env-registry.ts\` after a reviewed upgrade.
//
// WHAT THIS IS (review r3, NEW-10). The pinned runtime bundles its OWN registry of environment
// accessors — ${registry.length} env-shaped names it declares it reads. This file is the subset that an
// INDEPENDENT name-keyword rule classifies as NON-credential, and it is the positive allowlist the
// configured-extras door consults: a name that is not here does not ride the door, whether or not any
// regex of ours recognises it. The previous shape — a denylist plus a test that selected its universe
// with the same predicate it tested — could not fail, and seventeen credential-bearing names the
// registry declares rode straight through it.
export const PINNED_ENV_REGISTRY_SIZE = ${registry.length};

/** The non-credential subset of the pinned artifact's own env registry (${allow.length} names). */
export const NON_CREDENTIAL_ENV_REGISTRY: readonly string[] = [
`;
writeFileSync(join(import.meta.dir, "..", "src", "official", "env-registry.ts"), header + allow.map((name) => `  ${JSON.stringify(name)},`).join("\n") + "\n];\n");
// eslint-disable-next-line no-console
console.log(`generate-env-registry: ${registry.length} registry entries -> ${allow.length} non-credential names`);
