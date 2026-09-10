// D19a: the version matrix, asserted at construction — with FAKE PEERS.
//
// Fake peers rather than the real ones, for the reason the whole phase is hermetic: the real Winter
// peer is a `link:` onto a sibling checkout whose version moves under this repository's feet, and the
// real official peer is a 200MB dev dependency. A matrix test that depended on either would be
// measuring the fixture, not the rule.
import { describe, expect, test } from "bun:test";

import { createFakeClaudePeer, createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { assertVersionMatrix, createRuntimeSdk, parseVersion, readExportedVersion, readResolvedManifestVersion, runtimeSdkInternals, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS } from "../../src/index.ts";
import { RuntimeSdkVersionError } from "../../src/errors.ts";
import type { RuntimeSdkPeers } from "../../src/sdk.ts";

const keychain = createFakeKeychain();

describe("satisfiesRange (plants)", () => {
  test("the matrix's own two entries", () => {
    expect(satisfiesRange("0.0.2", SUPPORTED.winterAgentSdk)).toBe(true);
    expect(satisfiesRange("0.0.9", SUPPORTED.winterAgentSdk)).toBe(true);
    expect(satisfiesRange("0.0.1", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("0.1.0", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("1.0.0", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("0.3.250", SUPPORTED.claudeAgentSdk)).toBe(true);
    expect(satisfiesRange("0.3.251", SUPPORTED.claudeAgentSdk)).toBe(false);
    expect(satisfiesRange("0.3.249", SUPPORTED.claudeAgentSdk)).toBe(false);
  });

  test("the caret form the close-out pins (`^0.0.2`) behaves like the range it replaces", () => {
    expect(satisfiesRange("0.0.2", "^0.0.2")).toBe(true);
    expect(satisfiesRange("0.0.3", "^0.0.2")).toBe(false); // a 0.0.x caret pins the patch
    expect(satisfiesRange("0.2.1", "^0.2.0")).toBe(true);
    expect(satisfiesRange("0.3.0", "^0.2.0")).toBe(false);
    expect(satisfiesRange("1.9.9", "^1.2.3")).toBe(true);
    expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
  });

  test("a prerelease sorts below its own release, and junk never satisfies anything", () => {
    expect(satisfiesRange("0.0.2-rc.1", ">=0.0.2")).toBe(false);
    expect(satisfiesRange("0.0.2-rc.1", ">=0.0.1")).toBe(true);
    expect(satisfiesRange("not-a-version", ">=0.0.2")).toBe(false);
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: "" });
    expect(parseVersion("1.2")).toBeUndefined();
  });

  test("an unparseable RANGE throws rather than refusing every peer", () => {
    expect(() => satisfiesRange("1.0.0", "latest")).toThrow(/unparseable version range/);
  });
});

describe("readExportedVersion", () => {
  test("takes the first probe name that carries a real version", () => {
    expect(readExportedVersion({ SDK_VERSION: "1.2.3", version: "9.9.9" })).toBe("1.2.3");
    expect(readExportedVersion({ version: "9.9.9" })).toBe("9.9.9");
    expect(readExportedVersion({ SDK_VERSION: "not-a-version", VERSION: "0.4.0" })).toBe("0.4.0");
    expect(readExportedVersion({})).toBeUndefined();
    expect(readExportedVersion(null)).toBeUndefined();
  });
});

// ====================================================================================================
// R2 — `RuntimeSdkOptions.peerVersions`: the host-declared door, WS-02 §7.1. The only way a compiled
// binary (the daemon self-spawning `dist/norma-core`, `file:///$bunfs/...`) can identify its peers:
// `createRequire(...).resolve()` cannot see outside the bundle there, so `resolved-manifest` (probe 2)
// can never answer. Declared wins over BOTH other probes -- it is the host asserting what it actually
// vendored, not a fallback guess.
// ====================================================================================================
describe("assertVersionMatrix — peerVersions (R2)", () => {
  test("(a) a declared version wins over a peer that ALSO exports SDK_VERSION", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.2" }); // exports SDK_VERSION itself
    const report = assertVersionMatrix({ winter: peer }, { winterAgentSdk: "0.0.5" });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.5");
    expect(report.winterAgentSdk.source).toBe("host-declared");
  });

  test("(b) a declared OUT-OF-RANGE version refuses with the same message shape as an out-of-range peer-export", () => {
    const { peer } = createFakeWinterPeer(); // in-range peer-export -- irrelevant, declared wins first
    let thrown: unknown;
    try {
      assertVersionMatrix({ winter: peer }, { winterAgentSdk: "0.9.9" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeSdkVersionError);
    const error = thrown as RuntimeSdkVersionError;
    // SAME SHAPE as the existing peer-export refusal test above: `expected` names the matrix entry,
    // `actual` names the package and the identity that missed it.
    expect(error.expected).toBe("@yanlinglabs/winter-agent-sdk >=0.0.2 <0.1.0");
    expect(error.actual).toBe("@yanlinglabs/winter-agent-sdk 0.9.9");
    expect(error.message).toContain("version matrix refuses this peer set");
  });

  test("(c) a malformed declared version (\"abc\") falls through to peer-export", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.6" });
    const report = assertVersionMatrix({ winter: peer }, { winterAgentSdk: "abc" });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.6");
    expect(report.winterAgentSdk.source).toBe("peer-export");
  });

  test("(d) the compiled-binary door: a declared claude version wins even when resolved-manifest is unavailable", () => {
    // `readResolvedManifestVersion`'s default resolver is `createRequire(import.meta.url).resolve`,
    // which cannot see outside a compiled binary's bundle (`file:///$bunfs/...`). The injected
    // resolver below fails exactly the way that one would there -- proving the seam, not just
    // asserting a return value.
    const unresolvable = (): string => {
      throw new Error("Cannot find module (simulated compiled-binary resolution failure)");
    };
    expect(readResolvedManifestVersion("@anthropic-ai/claude-agent-sdk", unresolvable)).toBeUndefined();

    // The construction itself: a claude peer exporting NO version identity of its own, and no
    // `peerVersions`, would refuse here in a real compiled binary (probe 1 fails, probe 2 cannot run).
    // `peerVersions.claudeAgentSdk` is the only door -- and it wins over probe 2 even though, in THIS
    // dev checkout, probe 2 would actually succeed (the peer is a real installed devDependency): the
    // `source` assertion is what proves declared was used, not just a value that could have come from
    // either probe.
    const { peer } = createFakeWinterPeer();
    const noVersionClaude = {} as unknown as NonNullable<RuntimeSdkPeers["claude"]>;
    const report = assertVersionMatrix({ winter: peer, claude: noVersionClaude }, { claudeAgentSdk: "0.3.250" });
    expect(report.claudeAgentSdk?.packageVersion).toBe("0.3.250");
    expect(report.claudeAgentSdk?.source).toBe("host-declared");
  });

  test("(e) an ABSENT `peerVersions` leaves the existing peer-export/resolved-manifest behaviour untouched", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.2" });
    const report = assertVersionMatrix({ winter: peer });
    expect(report.winterAgentSdk.source).toBe("peer-export");
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.2");
    // The one-arg call shape (no second parameter at all) stays legal too.
    const claudeReport = assertVersionMatrix({ winter: peer, claude: createFakeClaudePeer() });
    expect(claudeReport.claudeAgentSdk?.source).toBe("peer-export");
  });
});

describe("assertVersionMatrix", () => {
  test("an in-range Winter peer reports its identity and its protocol version", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.2" });
    const report = assertVersionMatrix({ winter: peer });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.2");
    expect(report.winterAgentSdk.source).toBe("peer-export");
    expect(report.winterAgentSdk.protocolVersion).toBe("1.0");
    expect(report.winterAgentSdk.supported).toBe(SUPPORTED.winterAgentSdk);
    expect(report.claudeAgentSdk).toBeUndefined();
    expect(report.supportedProtocolVersions).toEqual(SUPPORTED_PROTOCOL_VERSIONS);
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
  });

  test("an OUT-OF-RANGE Winter peer refuses loudly, with expected and actual", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.1" });
    let thrown: unknown;
    try {
      assertVersionMatrix({ winter: peer });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeSdkVersionError);
    const error = thrown as RuntimeSdkVersionError;
    expect(error.expected).toBe("@yanlinglabs/winter-agent-sdk >=0.0.2 <0.1.0");
    expect(error.actual).toBe("@yanlinglabs/winter-agent-sdk 0.0.1");
    expect(error.message).toContain("version matrix refuses this peer set");
  });

  test("AN ABSENT OFFICIAL PEER IS ALLOWED -- a Winter-only host is a supported configuration", () => {
    const { peer } = createFakeWinterPeer();
    const report = assertVersionMatrix({ winter: peer });
    expect(report.claudeAgentSdk).toBeUndefined();
  });

  test("an in-range official peer is reported; an out-of-range one refuses", () => {
    const { peer } = createFakeWinterPeer();
    const ok = assertVersionMatrix({ winter: peer, claude: createFakeClaudePeer() });
    expect(ok.claudeAgentSdk?.packageVersion).toBe("0.3.250");
    expect(ok.claudeAgentSdk?.packageName).toBe("@anthropic-ai/claude-agent-sdk");

    let thrown: unknown;
    try {
      assertVersionMatrix({ winter: peer, claude: createFakeClaudePeer({ packageVersion: "0.3.265" }) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeSdkVersionError);
    expect((thrown as RuntimeSdkVersionError).actual).toBe("@anthropic-ai/claude-agent-sdk 0.3.265");
  });

  test("a missing or unsupported PROTOCOL_VERSION refuses -- it is the second identity, not a detail", () => {
    const noProtocol = { SDK_VERSION: "0.0.2" } as unknown as RuntimeSdkPeers["winter"];
    expect(() => assertVersionMatrix({ winter: noProtocol })).toThrow(RuntimeSdkVersionError);

    const { peer } = createFakeWinterPeer({ protocolVersion: "2.0" });
    let thrown: unknown;
    try {
      assertVersionMatrix({ winter: peer });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as RuntimeSdkVersionError).actual).toBe("PROTOCOL_VERSION 2.0");
  });

  test("no version identity anywhere -> the second probe answers, and here that is the REAL installed peer", () => {
    // A namespace with no version export at all. Probe 2 resolves `@yanlinglabs/winter-agent-sdk`
    // from this repository's own node_modules -- the `link:`ed sibling checkout -- and answers from
    // its manifest. This is the live path until the Winter SDK exports a version identity of its own
    // (the CARRY in the Task 1 report), so the test asserts the SOURCE, not the number.
    //
    // WHAT CHANGED (P7b fix round 1, Lane A): the SDK repository BUMPED to 0.0.2, which is inside the
    // matrix -- so the assertion "the real peer is refused" stopped being true, in this repository and
    // in CI, without a line of this package changing. The spine's own concern 2 predicted exactly this
    // ("every construction with the REAL peer refuses UNTIL THE SDK BUMPS"). The test now derives its
    // expectation from the resolved manifest instead of hard-coding either side of that bump, so it
    // stays honest across the transition rather than pinning whichever side happened to be current.
    const noVersion = { PROTOCOL_VERSION: "1.0" } as unknown as RuntimeSdkPeers["winter"];
    const resolved = readResolvedManifestVersion("@yanlinglabs/winter-agent-sdk");
    const insideMatrix = resolved !== undefined && satisfiesRange(resolved, SUPPORTED.winterAgentSdk);
    if (insideMatrix) {
      const report = assertVersionMatrix({ winter: noVersion });
      expect(report.winterAgentSdk.packageVersion).toBe(resolved);
      // …and the SOURCE is still the second probe: the module exported no identity of its own.
      expect(report.winterAgentSdk.source).toBe("resolved-manifest");
      return;
    }
    let thrown: unknown;
    try {
      assertVersionMatrix({ winter: noVersion });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RuntimeSdkVersionError);
    const actual = (thrown as RuntimeSdkVersionError).actual;
    // Either the resolvable copy was found and refused by version, or it could not be resolved at
    // all -- both are refusals, and the message says which.
    expect(actual.startsWith("@yanlinglabs/winter-agent-sdk ") || actual.startsWith("unknown (")).toBe(true);
  });

  test("`createRuntimeSdk` asserts the matrix BEFORE it builds anything", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.1" });
    expect(() => createRuntimeSdk({ peers: { winter: peer }, keychain })).toThrow(RuntimeSdkVersionError);
    const { peer: good } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: good }, keychain });
    expect(sdk.versions.winterAgentSdk.packageVersion).toBe("0.0.2");
  });
});

describe("the matrix and the manifest never drift", () => {
  test("`SUPPORTED` equals this package's own declared peer ranges", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(manifest.peerDependencies["@yanlinglabs/winter-agent-sdk"]).toBe(SUPPORTED.winterAgentSdk);
    expect(manifest.peerDependencies["@anthropic-ai/claude-agent-sdk"]).toBe(SUPPORTED.claudeAgentSdk);
    // The official peer is OPTIONAL, which is what makes "no claude peer" a configuration rather
    // than a broken install.
    expect(manifest.peerDependenciesMeta["@anthropic-ai/claude-agent-sdk"]?.optional).toBe(true);
  });
});

// ====================================================================================================
// F-8 — THE ONE LINE EVERY HOST WILL RUN, AND THAT NO TEST RAN.
//
// Every `createRuntimeSdk(...)` under `test/` receives `createFakeWinterPeer().peer`; the real module
// was imported only for a namespace comparison and for its store class. So the construction path a
// host actually takes — the real Winter SDK as the injected peer — was unexercised: the version
// matrix's real-peer leg used a hand-built `{ PROTOCOL_VERSION }` object, and brand threading and the
// facet's presence were asserted on the fake. This costs one import and no network.
// ====================================================================================================
describe("F-8 — the handle constructed over the REAL Winter SDK module instance", () => {
  test("it constructs, and the matrix resolves the peer's version from its installed manifest", async () => {
    const winter = await import("@yanlinglabs/winter-agent-sdk");
    const sdk = createRuntimeSdk({ peers: { winter }, keychain: createFakeKeychain() });
    // The peer exports no version identity of its own (SDK 0.0.3 carry), so the matrix falls back to
    // the resolved manifest — which is the source this asserts, not a value that could drift.
    expect(sdk.versions.winterAgentSdk.source).toBe("resolved-manifest");
    // NOT VACUOUS: the version it resolved really is inside the matrix's own supported range.
    expect(satisfiesRange(sdk.versions.winterAgentSdk.packageVersion, SUPPORTED.winterAgentSdk)).toBe(true);
  });

  test("the brand it resolves is the module's own WINTER_BRAND, through the module's own resolveBrand", async () => {
    const winter = await import("@yanlinglabs/winter-agent-sdk");
    const sdk = createRuntimeSdk({ peers: { winter }, keychain: createFakeKeychain() });
    expect(sdk.brand).toEqual(winter.WINTER_BRAND);
  });

  test("the internals are populated, and the messaging facet's doors are present on the handle", async () => {
    const winter = await import("@yanlinglabs/winter-agent-sdk");
    const sdk = createRuntimeSdk({ peers: { winter }, keychain: createFakeKeychain() });
    const internals = runtimeSdkInternals(sdk);
    expect(internals).toBeDefined();
    expect(internals?.official).toBeDefined();
    expect(internals?.barrier).toBeDefined();
    expect(internals?.decorator).toBeDefined();
    // The two doors F-3 widened the field for, over the real peer.
    expect(typeof sdk.messaging.attachWinterSession).toBe("function");
    expect(typeof sdk.messaging.attachOfficialSession).toBe("function");
    expect(typeof sdk.directory.record).toBe("function");
  });
});
