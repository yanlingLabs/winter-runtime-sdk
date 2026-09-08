// WS-14 §12: THE CREDENTIAL SEAM. The router never opens a keychain itself.
//
// "Credentials live in Keychain, fetched at spawn, never written to disk." Two consequences shape
// this interface:
//
//   1. THE HOST OWNS THE KEYCHAIN. Which service name, which account, which platform API, which
//      user-consent prompt — all product decisions (WS-15/Phase 8). The router asks for the material
//      belonging to a `CredentialRef` it was handed and gets a string back; it never learns where
//      that string lives. A test injects an in-memory double (`src/testing/`), which is what keeps
//      every test in this package off the real Keychain — a hard rule of this phase.
//   2. THE MATERIAL IS FETCHED AT SPAWN AND HELD BY NOBODY. `read()` returns it to the one caller
//      that needs it (the official adapter's env builder, WS-14 §3), which puts it into the child
//      environment and drops it. Nothing in this package caches it, logs it, or writes it anywhere;
//      WS-14 §6 says the spawn proxy "never retains staged credentials", and a seam that returned a
//      long-lived handle would make that promise impossible to keep.
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";

export interface KeychainSeam {
  /**
   * The credential material for `ref`, or `undefined` when the host has none for it.
   *
   * `undefined` is a normal answer, not an error: the selector's own `CredentialPresence` is what
   * decides whether a route is available, and a missing credential at spawn is a typed refusal
   * (WS-10's `child-provider-unavailable`), never a throw from the middle of a launch.
   */
  read(ref: CredentialRef): Promise<string | undefined>;
}
