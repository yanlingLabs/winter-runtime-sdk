// D19a: the version matrix, asserted at construction — with FAKE PEERS.
//
// Fake peers rather than the real ones, for the reason the whole phase is hermetic: the real Winter
// peer is a `link:` onto a sibling checkout whose version moves under this repository's feet, and the
// real official peer is a 200MB dev dependency. A matrix test that depended on either would be
// measuring the fixture, not the rule.
import { describe, expect, test } from "bun:test";

import { createFakeClaudePeer, createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { assertVersionMatrix, createRuntimeSdk, parseVersion, readExportedVersion, satisfiesRange, SUPPORTED, SUPPORTED_PROTOCOL_VERSIONS } from "../../src/index.ts";
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
    // from this repository's own node_modules -- the `link:`ed sibling checkout, 0.0.1 today -- and
    // refuses it. This is the live path until the Winter SDK exports a version identity of its own
    // (the CARRY in the Task 1 report), so the test asserts the SOURCE, not the number.
    const noVersion = { PROTOCOL_VERSION: "1.0" } as unknown as RuntimeSdkPeers["winter"];
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
