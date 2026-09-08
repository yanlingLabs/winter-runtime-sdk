// HERMETICITY HELPERS — the two doubles and the one temp-home idiom every test in this package uses.
//
// THE RULE THIS FILE EXISTS TO MAKE EASY (Phase 7b Global Constraints): a test never touches
// `~/.winter`, `~/.norma`, `~/.claude` or the Keychain. Those are not style preferences — a test that
// reads a developer's real home passes on their machine and fails in CI (or, worse, the reverse), and
// a test that reaches the Keychain prompts a human.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";

import type { KeychainSeam } from "../seams/keychain.ts";

export interface FakeKeychain extends KeychainSeam {
  /** Stores material for a ref, keyed the same way `read` looks it up. */
  set(ref: CredentialRef, material: string): void;
  /** Every `read` this double served, in order — so a test can prove the fetch happened at spawn. */
  readonly reads: CredentialRef[];
}

/** A stable key for a `CredentialRef`, so `set`/`read` agree without comparing objects. */
function keyOf(ref: CredentialRef): string {
  switch (ref.kind) {
    case "keychain":
      return `keychain:${ref.service ?? ""}:${ref.account}`;
    case "env":
      return `env:${ref.name}`;
    case "file":
      return `file:${ref.path}:${ref.format}:${ref.profile ?? ""}`;
    case "inline":
      return `inline:${ref.value}`;
    default:
      return ref.kind;
  }
}

/**
 * An in-memory `KeychainSeam`. NEVER `Bun.secrets`, never the OS keychain.
 *
 * An unset ref reads `undefined`, which is the seam's own documented "the host has none" answer —
 * so the missing-credential path is testable without arranging for a real keychain to be empty.
 */
export function createFakeKeychain(initial: Array<{ ref: CredentialRef; material: string }> = []): FakeKeychain {
  const store = new Map<string, string>();
  const reads: CredentialRef[] = [];
  for (const entry of initial) store.set(keyOf(entry.ref), entry.material);
  return {
    reads,
    set(ref, material) {
      store.set(keyOf(ref), material);
    },
    async read(ref) {
      reads.push(ref);
      return store.get(keyOf(ref));
    },
  };
}

/**
 * A fresh temp directory that is removed whatever the body does.
 *
 * `mkdtemp` under the OS temp root, never a path built from a home directory: the point is a
 * directory this process created and this process owns.
 */
export async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `winter-runtime-sdk-${prefix}-`));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The home directories a hermetic official-branch test needs: a throwaway `HOME` and a throwaway
 * `CLAUDE_CONFIG_DIR`, both under one temp root that is removed in a `finally`.
 */
export async function withHermeticHomes<T>(fn: (homes: { home: string; claudeConfigDir: string }) => Promise<T>): Promise<T> {
  return withTempDir("homes", async (root) => {
    const home = mkdtempSync(join(root, "home-"));
    const claudeConfigDir = mkdtempSync(join(root, "claude-config-"));
    return fn({ home, claudeConfigDir });
  });
}
