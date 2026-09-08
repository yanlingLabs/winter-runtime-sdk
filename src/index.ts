// `@yanlinglabs/winter-runtime-sdk` — the public barrel.
//
// TWO HALVES, and the first one is the contract:
//
//   1. THE WINTER SDK'S ENTIRE PUBLIC SURFACE, re-exported. `query`, `Options`, `Query`, `SdkMessage`
//      and every named variant, `SessionStore`/`WinterCompatibilitySessionStore`, `BrandProfile`/
//      `WINTER_BRAND`/`resolveBrand`, `ModelFamilyListing`, `PermissionResult`, the settings surface,
//      the hooks surface, the wire types, the error classes — all of it.
//
//      A STAR RE-EXPORT, NOT A HAND-WRITTEN LIST, and that is the whole design decision. The plan's
//      constraint is "the pinned Options/Query/SDKMessage contract loses no member and gains nothing
//      the Winter SDK does not already export". A list of 231 names would satisfy that on the day it
//      was written and would be one SDK release away from being wrong, silently, in the direction
//      nobody checks (a member that stopped being re-exported does not fail anything here — it fails
//      in a host, as a missing import, months later). `export *` makes losing a member IMPOSSIBLE,
//      and `test/spine/contract-reexport.test.ts` pins the other direction: every runtime export of
//      the Winter barrel is present here under the same name AND is the same object.
//
//      A name declared BELOW shadows a star-exported one of the same name (the ES module rule TS
//      implements), so the router's own names always win; the contract test asserts no such shadow
//      exists by accident.
//
//   2. THE ROUTER'S OWN NAMES: the constructor and its handle, the version matrix, the selection
//      contract, the seams every lane implements behind, and the typed errors.
//
// `src/testing/` is NOT exported. It wires `@yanlinglabs/winter-conformance` and
// `@yanlinglabs/winter-provider-conformance` — DEV dependencies — into `bun test`; a published
// subpath for it would name imports a consumer never installed, and the installed-tarball smoke
// (which walks every declared `exports` entry) would fail on it. Tests reach it by relative path.
export * from "@yanlinglabs/winter-agent-sdk";

// --- the constructor, the handle, the door ---------------------------------------------------------
export { createRuntimeSdk, forwardableOptions, runtimeSdkInternals, ROUTER_ONLY_OPTION_KEYS } from "./sdk.ts";
export type { RouterOnlyOptionKey, RouterOptions, RouterRuntimeInput, RuntimeSdk, RuntimeSdkInternals, RuntimeSdkOptions, RuntimeSdkPeers } from "./sdk.ts";

// --- D19a: the version matrix ----------------------------------------------------------------------
export { assertVersionMatrix, parseVersion, readExportedVersion, readResolvedManifestVersion, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS, VERSION_EXPORT_NAMES } from "./version-matrix.ts";
export type { PeerVersionIdentity, PeerVersionSource, VersionMatrixReport } from "./version-matrix.ts";

// --- D13/D28: selection and its persisted choice ---------------------------------------------------
export { isSelectionRefusal, selectChildRuntime, selectRuntime, SelectionRefusedError } from "./selection/runtime-selection.ts";
export type { ChildSelectionInput, CredentialPresence, RuntimeKind, RuntimeSelection, SelectionInput, SelectionRefusal } from "./selection/runtime-selection.ts";

// --- the seams (interfaces the four lanes implement behind) ----------------------------------------
export * from "./seams/index.ts";

// --- typed errors ----------------------------------------------------------------------------------
export { NotImplementedYet, RuntimeSdkDisposedError, RuntimeSdkError, RuntimeSdkVersionError } from "./errors.ts";
export type { LaneId } from "./errors.ts";
