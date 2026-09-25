// D19a: the version matrix, asserted at construction — with FAKE PEERS.
//
// Fake peers rather than the real ones, for the reason the whole phase is hermetic: the real Winter
// peer is a REGISTRY pin whose version moves with the SDK's own releases (it was a `link:` onto a
// sibling checkout until P8a's Task 0 retired that shape). A matrix test that depended on it would be
// measuring the fixture, not the rule. WS-23: the official peer's row is gone from the matrix.
import { describe, expect, test } from "bun:test";

import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { assertVersionMatrix, createRuntimeSdk, parseVersion, readExportedVersion, readResolvedManifestVersion, runtimeSdkInternals, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS } from "../../src/index.ts";
import { RuntimeSdkVersionError } from "../../src/errors.ts";
import type { RuntimeSdkPeers } from "../../src/sdk.ts";
// NOT on the package barrel (`src/index.ts`), deliberately (R2 review r1) — a real host never needs
// to override how this package resolves its own peers' manifests. Reached by relative path here, the
// one test that needs the seam.
import { resolveVersionMatrix } from "../../src/version-matrix.ts";

const keychain = createFakeKeychain();

describe("satisfiesRange (plants)", () => {
  test("the matrix's own entry (WS-23: the claude pin is gone)", () => {
    expect(satisfiesRange("0.0.21", SUPPORTED.winterAgentSdk)).toBe(true);
    expect(satisfiesRange("0.0.99", SUPPORTED.winterAgentSdk)).toBe(true);
    expect(satisfiesRange("0.0.20", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("0.0.1", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("0.1.0", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(satisfiesRange("1.0.0", SUPPORTED.winterAgentSdk)).toBe(false);
    expect(Object.keys(SUPPORTED)).toEqual(["winterAgentSdk"]);
  });

  test("the caret form the close-out pins (`^0.0.3`) behaves like the range it replaces", () => {
    expect(satisfiesRange("0.0.3", "^0.0.3")).toBe(true);
    expect(satisfiesRange("0.0.4", "^0.0.3")).toBe(false); // a 0.0.x caret pins the patch
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
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.3" }); // exports SDK_VERSION itself, out of range and irrelevant -- declared wins regardless
    const report = assertVersionMatrix({ winter: peer }, { winterAgentSdk: "0.0.21" });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.21");
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
    expect(error.expected).toBe("@yanlinglabs/winter-agent-sdk >=0.0.21 <0.1.0");
    expect(error.actual).toBe("@yanlinglabs/winter-agent-sdk 0.9.9");
    expect(error.message).toContain("version matrix refuses this peer set");
  });

  test("(c) a malformed declared version (\"abc\") falls through to peer-export", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.21" });
    const report = assertVersionMatrix({ winter: peer }, { winterAgentSdk: "abc" });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.21");
    expect(report.winterAgentSdk.source).toBe("peer-export");
  });

  test("(d) the compiled-binary door: a declared Winter version wins when resolved-manifest is GENUINELY unavailable", () => {
    // ONE integrated scenario, through `resolveVersionMatrix` (the seam-carrying internal, not the
    // public `assertVersionMatrix`): a resolver that fails for EVERY name, threaded end to end into
    // probe 2 -- what `readResolvedManifestVersion`'s default resolver
    // (`createRequire(import.meta.url).resolve`) would do inside a compiled binary
    // (`file:///$bunfs/...`). Without this seam, probe 2 would resolve the REAL, installed
    // `@yanlinglabs/winter-agent-sdk` devDependency in this checkout and silently mask the very
    // condition this test exists to demonstrate.
    const unresolvable = (): string => {
      throw new Error("Cannot find module (simulated compiled-binary resolution failure)");
    };
    // A Winter peer exporting NO version identity of its own (probe 1 fails too), only its protocol.
    const noVersionWinter = { PROTOCOL_VERSION: "1.0" } as unknown as RuntimeSdkPeers["winter"];

    // (i) No `declared`, peer-export absent, and probe 2 genuinely broken: construction REFUSES.
    // This is the proof that the manifest path was actually unavailable in this scenario, not merely
    // unused.
    expect(() => resolveVersionMatrix({ winter: noVersionWinter }, undefined, { resolveEntry: unresolvable })).toThrow(RuntimeSdkVersionError);

    // (ii) The SAME peer and the SAME failing resolver, plus `peerVersions.winterAgentSdk` --
    // construction now succeeds, and the source is `host-declared`: the only door that was open.
    const report = resolveVersionMatrix({ winter: noVersionWinter }, { winterAgentSdk: "0.0.21" }, { resolveEntry: unresolvable });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.21");
    expect(report.winterAgentSdk.source).toBe("host-declared");
  });

  test("(e) an ABSENT `peerVersions` leaves the existing peer-export/resolved-manifest behaviour untouched", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.21" });
    const report = assertVersionMatrix({ winter: peer });
    expect(report.winterAgentSdk.source).toBe("peer-export");
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.21");
  });
});

describe("assertVersionMatrix", () => {
  test("an in-range Winter peer reports its identity and its protocol version", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.21" });
    const report = assertVersionMatrix({ winter: peer });
    expect(report.winterAgentSdk.packageVersion).toBe("0.0.21");
    expect(report.winterAgentSdk.source).toBe("peer-export");
    expect(report.winterAgentSdk.protocolVersion).toBe("1.0");
    expect(report.winterAgentSdk.supported).toBe(SUPPORTED.winterAgentSdk);
    expect("claudeAgentSdk" in report).toBe(false);
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
    expect(error.expected).toBe("@yanlinglabs/winter-agent-sdk >=0.0.21 <0.1.0");
    expect(error.actual).toBe("@yanlinglabs/winter-agent-sdk 0.0.1");
    expect(error.message).toContain("version matrix refuses this peer set");
  });

  test("WS-23: a Winter-only host is the only configuration — the report has no official-peer row at all", () => {
    const { peer } = createFakeWinterPeer({ packageVersion: "0.0.21" });
    const report = assertVersionMatrix({ winter: peer });
    expect(Object.keys(report).sort()).toEqual(["checkedAt", "supported", "supportedProtocolVersions", "winterAgentSdk"]);
  });

  test("a missing or unsupported PROTOCOL_VERSION refuses -- it is the second identity, not a detail", () => {
    const noProtocol = { SDK_VERSION: "0.0.21" } as unknown as RuntimeSdkPeers["winter"];
    expect(() => assertVersionMatrix({ winter: noProtocol })).toThrow(RuntimeSdkVersionError);

    const { peer } = createFakeWinterPeer({ protocolVersion: "2.0", packageVersion: "0.0.21" });
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
    // from this repository's own node_modules -- the REGISTRY-installed copy -- and answers from its
    // manifest. The test asserts the SOURCE, not the number, so it survives every floor move.
    //
    // WHAT CHANGED (P7b fix round 1, Lane A; unchanged in shape by R8's move to >=0.0.3): the SDK
    // repository BUMPED to 0.0.2, which was inside the
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
    const { peer: good } = createFakeWinterPeer({ packageVersion: "0.0.21" });
    const sdk = createRuntimeSdk({ peers: { winter: good }, keychain });
    expect(sdk.versions.winterAgentSdk.packageVersion).toBe("0.0.21");
  });
});

describe("the matrix and the manifest never drift", () => {
  test("`SUPPORTED` equals this package's own declared peer ranges", async () => {
    const manifest = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
    };
    expect(manifest.peerDependencies["@yanlinglabs/winter-agent-sdk"]).toBe(SUPPORTED.winterAgentSdk);
    // WS-23: the official peer is not a peer at all any more — neither required nor optional.
    expect(manifest.peerDependencies["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
    expect(manifest.peerDependenciesMeta["@anthropic-ai/claude-agent-sdk"]).toBeUndefined();
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
  test("it constructs, and the matrix reads the peer's own exported version identity", async () => {
    const winter = await import("@yanlinglabs/winter-agent-sdk");
    const sdk = createRuntimeSdk({ peers: { winter }, keychain: createFakeKeychain() });
    // FLIPPED BY THE FLOOR MOVE (plan R10 / carry 23), and it flipped the moment `pnpm install`
    // resolved 0.0.3: that release carries `SDK_VERSION` on the main barrel (SDK ruling P-5), so
    // probe 1 answers and the matrix never reaches the resolved manifest. The assertion is still on
    // the SOURCE rather than the number — what changed is which probe the REAL peer now satisfies.
    expect(sdk.versions.winterAgentSdk.source).toBe("peer-export");
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
    // WS-23: the switch reviewer (still reached as `barrier`) and the context — no official adapter,
    // no decorator.
    expect(typeof internals?.barrier.reviewSwitch).toBe("function");
    expect(internals?.context).toBeDefined();
    expect(Object.keys(internals ?? {}).sort()).toEqual(["barrier", "context"]);
    // The door F-3 widened the field for, over the real peer.
    expect(typeof sdk.messaging.attachWinterSession).toBe("function");
    expect("attachOfficialSession" in sdk.messaging).toBe(false);
    expect(typeof sdk.directory.record).toBe("function");
  });
});
