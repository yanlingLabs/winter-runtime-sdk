// THE CONTRACT RE-EXPORT GATE: this package loses no member of the Winter SDK's public surface.
//
// `src/index.ts` uses `export *` precisely so a member CANNOT be lost, but a star export has two
// failure modes a reader cannot see:
//   * a name declared locally SHADOWS the star-exported one of the same name (the ES module rule), so
//     the router could silently replace an SDK export with its own;
//   * an AMBIGUOUS name (two stars exporting it) is silently EXCLUDED rather than reported.
// Both end with a host importing something other than what the SDK exports, under the SDK's name.
// This test compares the two namespaces object-by-object, so either one fails here.
import { describe, expect, test } from "bun:test";

import * as router from "../../src/index.ts";
import * as winter from "@yanlinglabs/winter-agent-sdk";

/**
 * The door-shaped names the plan names explicitly. Pinned as DATA so the Task 1 report and this test
 * cannot disagree about what "the contract" meant, and so deleting one from `src/index.ts` fails by
 * name rather than by count.
 */
const NAMED_CONTRACT_VALUES = [
  "query",
  "WinterCompatibilitySessionStore",
  "WINTER_BRAND",
  "resolveBrand",
  "PROTOCOL_VERSION",
  "forkSession",
  "listSessions",
  "resolveSettings",
  "resolveRuntimeExecutable",
  "defaultSpawn",
  "WinterSDKError",
] as const;

describe("the Winter SDK's contract, re-exported", () => {
  test("every runtime export of the Winter barrel is present here, under the same name", () => {
    const missing = Object.keys(winter).filter((name) => !(name in router));
    expect(missing).toEqual([]);
  });

  test("and is the SAME object -- never a shadow, never a copy", () => {
    const shadowed: string[] = [];
    for (const name of Object.keys(winter)) {
      const theirs = (winter as Record<string, unknown>)[name];
      const ours = (router as Record<string, unknown>)[name];
      if (ours !== theirs) shadowed.push(name);
    }
    expect(shadowed).toEqual([]);
  });

  test("the named door-shaped values are all there (the plan's own list)", () => {
    for (const name of NAMED_CONTRACT_VALUES) {
      expect([name, name in router]).toEqual([name, true]);
    }
  });

  test("the sweep is not vacuous: the Winter barrel really does export a large surface", () => {
    // A namespace import that failed to resolve would be an empty object, and every assertion above
    // would pass. 60 is far below the current count (66 runtime values at 0.0.1) and far above zero.
    expect(Object.keys(winter).length).toBeGreaterThan(60);
  });

  test("the router's own names do not collide with the SDK's", () => {
    const ours = [
      "createRuntimeSdk",
      "assertVersionMatrix",
      "SUPPORTED",
      "SUPPORTED_PROTOCOL_VERSIONS",
      "selectRuntime",
      "selectChildRuntime",
      "createInMemoryRuntimeDirectoryStore",
      "NotImplementedYet",
      "RuntimeSdkVersionError",
      "SelectionRefusedError",
      "ROUTER_ONLY_OPTION_KEYS",
      "forwardableOptions",
      "runtimeSdkInternals",
    ];
    const collisions = ours.filter((name) => name in winter);
    expect(collisions).toEqual([]);
    for (const name of ours) expect([name, name in router]).toEqual([name, true]);
  });
});

// --- TYPE-LEVEL: the pinned types are the SDK's own, not structural look-alikes --------------------
//
// `bun test` only type-STRIPS, so these assertions are enforced by `bun run typecheck` (which
// includes `test/**`), exactly like every other type-level fact in this repository. They live in the
// test file because that is where a reader looks for "is this still true".
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _optionsIsTheSdks: Exact<router.Options, winter.Options> = true;
const _queryIsTheSdks: Exact<router.Query, winter.Query> = true;
const _sdkMessageIsTheSdks: Exact<router.SdkMessage, winter.SdkMessage> = true;
const _sessionStoreIsTheSdks: Exact<router.SessionStore, winter.SessionStore> = true;
const _brandProfileIsTheSdks: Exact<router.BrandProfile, winter.BrandProfile> = true;
const _permissionResultIsTheSdks: Exact<router.PermissionResult, winter.PermissionResult> = true;
const _familyListingIsTheSdks: Exact<router.ModelFamilyListing, winter.ModelFamilyListing> = true;
const _sessionKeyIsTheSdks: Exact<router.SessionKey, winter.SessionKey> = true;
// `RouterOptions` EXTENDS `Options` -- additive, never a redefinition.
const _routerOptionsIsAnOptions: router.RouterOptions extends winter.Options ? true : false = true;
// M2: NO ROUTER-OWNED OPTION KEY IS A REAL `Options` MEMBER.
//
// `forwardableOptions` DELETES every `ROUTER_ONLY_OPTION_KEYS` entry from what it forwards. Today
// `runtime` is not an `Options` member, so it deletes nothing real -- but if a future Winter release
// adds one, the router would silently drop it from every forwarded call and no runtime test would
// fail, because a fake peer never asserts on a key it was not told about. This line fails the
// TYPECHECK the day the collision appears, which is the only moment anyone can act on it.
const _noRouterKeyCollision: Extract<router.RouterOnlyOptionKey, keyof winter.Options> extends never ? true : false = true;
// ...and the pattern above really does discriminate: a name that IS an `Options` member takes the
// other branch. Without this line the tripwire would pass even if `Extract<>` were misspelled.
const _tripwireIsNotVacuous: Extract<"model", keyof winter.Options> extends never ? false : true = true;
void [
  _optionsIsTheSdks,
  _queryIsTheSdks,
  _sdkMessageIsTheSdks,
  _sessionStoreIsTheSdks,
  _brandProfileIsTheSdks,
  _permissionResultIsTheSdks,
  _familyListingIsTheSdks,
  _sessionKeyIsTheSdks,
  _routerOptionsIsAnOptions,
  _noRouterKeyCollision,
  _tripwireIsNotVacuous,
];

// ====================================================================================================
// RULING P-7 — THE ROUTER RE-EXPORTS NO TOOL SURFACE.
//
// The main barrel is re-exported wholesale (above) because the router IS the Winter SDK's door: a host
// that installs the router must not lose a member of the contract it wraps. `/tools` is the opposite
// case. The router owns no tool (R-8-1), so it publishes none: a host that wants the definitions, the
// schemas, the acceptors, the handler factories or the advisor imports them from the SDK, which it
// already has as a REQUIRED peer. Re-publishing them here would create the second import path that
// makes "which copy am I using?" a question again — the exact question deleting `src/native-args.ts`
// answered.
//
// A SUBPATH, NOT A SHADOW: `@yanlinglabs/winter-agent-sdk/tools` is a separate entry point, so these
// names are not part of the `export *` above and their absence is a CHOICE this test pins.
// ====================================================================================================
describe("ruling P-7 — the `/tools` surface is the SDK's alone", () => {
  test("no `/tools` name is exported from the router's own barrel", async () => {
    const tools = (await import("@yanlinglabs/winter-agent-sdk/tools")) as Record<string, unknown>;
    const leaked = Object.keys(tools).filter((name) => name in router);
    expect(leaked).toEqual([]);
  });

  test("the names the router DELETED are gone from its barrel by name, not merely absent by accident", () => {
    // The eight that lived in `src/native-args.ts` plus the three the messaging lane published.
    const moved = [
      "NATIVE_SEND_MESSAGE_SCHEMA",
      "NATIVE_LIST_AGENTS_SCHEMA",
      "NATIVE_LIST_AGENTS_OUTPUT_SCHEMA",
      "SEND_MESSAGE_TO_MAX",
      "SEND_MESSAGE_SUMMARY_MAX",
      "LIST_AGENTS_FIELD_MAX",
      "acceptNativeSendMessageArgs",
      "acceptNativeListAgentsArgs",
      "createMessagingToolHandlers",
      "toolUseIdFromExtra",
      "VENDOR_TOOL_USE_ID_META_KEY",
      "callerAddressOf",
    ] as const;
    for (const name of moved) expect({ name, onRouterBarrel: name in router }).toEqual({ name, onRouterBarrel: false });
  });
});
