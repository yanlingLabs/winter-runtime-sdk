// WS-15 §6.1 (D19b's relocation): THE RUNTIME DIRECTORY SEAM. Lane B implements it in `src/directory/**`.
//
// The directory is the router's answer to "what is out there, and which of them is this name". It
// sits over the `RuntimeDirectoryStore` seam (R-7b-2) and is the ONLY thing that authors canonical
// addresses: an adapter performs owner-specific operations, but "runtime kind and backend ids live in
// the directory record, never trusted from user or model text" (WS-10 §11).
//
// RESOLUTION IS A MUST-ORDER, not a heuristic (WS-10 §11): exact canonical address → a stable child
// id beats a name → a unique display name → ambiguity RETURNS CANDIDATES ("the router never chooses
// arbitrarily") → a stale name is refused → and "names never grant permission or bypass receiver
// policy". `DirectoryResolution`'s arms are that list, which is why `ambiguous` carries candidates
// and `stale-name` is its own arm rather than a flavour of `not-found`.
import type { RuntimeDirectoryEntry } from "./directory-store.ts";
import type { ListedRuntimeObject, RuntimeAddress, SerializedRuntimeAddress } from "./messaging-contract.ts";

export interface DirectoryResolutionContext {
  /** Who is asking. Scopes "a stable child id beats a name" to the asker's own children. */
  from: RuntimeAddress;
}

export type DirectoryResolution =
  | { kind: "resolved"; entry: RuntimeDirectoryEntry }
  | { kind: "ambiguous"; candidates: ListedRuntimeObject[] }
  | { kind: "stale-name"; reason: string; candidates: ListedRuntimeObject[] }
  | { kind: "not-found"; reason: string };

/** WS-15 §6.4's seven-step restart recovery, reported step by step. */
export interface RuntimeDirectoryRecoveryStep {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  name: string;
  outcome: string;
}

export interface RuntimeDirectoryRecovery {
  steps: RuntimeDirectoryRecoveryStep[];
  entriesLoaded: number;
  /** Entries whose runtime object no longer exists and were marked accordingly (never deleted silently). */
  staleMarked: number;
  cursorsRestored: number;
  heldMessagesFound: number;
}

/** WS-15 §6.1. Lane B implements; the spine pins the signature. */
export interface RuntimeDirectory {
  list(scope?: { parent?: SerializedRuntimeAddress }): Promise<RuntimeDirectoryEntry[]>;
  get(address: SerializedRuntimeAddress): Promise<RuntimeDirectoryEntry | undefined>;
  record(entry: RuntimeDirectoryEntry): Promise<void>;
  forget(address: SerializedRuntimeAddress): Promise<void>;
  /** `to` is the raw model- or user-supplied target string (WS-10 §10.1 caps it at 300 chars, no newline, no `*`). */
  resolve(to: string, context: DirectoryResolutionContext): Promise<DirectoryResolution>;
  recover(): Promise<RuntimeDirectoryRecovery>;
}
