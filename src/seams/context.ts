// WHAT EVERY SEAM FACTORY IS HANDED (review r1, M3).
//
// The spine's promise is that a lane's wiring diff in `src/sdk.ts` — a spine-owned file four lanes
// compile against — is ONE LINE: `stubX(context)` becomes `createX(context)`. That property was true
// for shape and false for arguments while three of the four stubs took none: Lane A's real factory
// needs the injected `peers.claude` AND the `KeychainSeam` (WS-14 §12's credential fetch at spawn has
// no other owner) AND the resolved brand; Lane C's barrier needs the directory to compute
// `HandoffPlan.from`; Lane B's messaging needs the directory it is constructed beside.
//
// So there is ONE context object, built once in `createRuntimeSdk`, and every factory takes it. A
// lane that needs something new adds a field here — a spine edit, but a one-line one, and visible to
// the other three lanes in a single place rather than in four call sites.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

import type { RuntimeSdkPeers } from "../sdk.ts";
import type { RuntimeDirectory } from "./directory.ts";
import type { RuntimeDirectoryStore } from "./directory-store.ts";
import type { KeychainSeam } from "./keychain.ts";

/** Everything the directory itself needs. */
export interface SeamContext {
  peers: RuntimeSdkPeers;
  /** WS-14 §12: the host's credential reads. Nothing in this package caches what it returns. */
  keychain: KeychainSeam;
  /**
   * The RESOLVED profile (I2) — never `Partial`, never a literal, resolved exactly once at
   * construction through the INJECTED peer's own `resolveBrand`. Every Winter-owned name any seam
   * spells derives from this.
   */
  brand: BrandProfile;
  directoryStore: RuntimeDirectoryStore;
  /** WS-14 §5.1: `pathToClaudeCodeExecutable` — the host vendors it; tests point at node_modules. */
  vendoredOfficialRuntime?: string;
}

/** What every OTHER seam needs: the same, plus the directory, which is built first. */
export interface SeamContextWithDirectory extends SeamContext {
  directory: RuntimeDirectory;
}
