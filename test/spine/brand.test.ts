// I2: THE BRAND IS RESOLVED ONCE AND REACHES BOTH BRANCHES.
//
// `Options.brand` is worth exactly as much as the number of places that read it. Before this round
// the constructor's `brand` was accepted, stored, and read by nobody: a host that passed one and then
// called `sdk.query({prompt})` got Winter's names, and three lanes that need a RESOLVED profile
// (Lane A's `OptionsTemplateInput.brand`/`EnvInput.brand`, Lane B's MCP tool names, Lane C's spool
// root) had no producer to get one from — so each would have invented its own, and they would not
// have agreed.
//
// The rule this file pins, in one sentence: a per-query `Options.brand` wins on the Winter leg and is
// never rewritten; the constructor profile fills in when a query supplies none; Winter's own defaults
// fill in when neither does.
import { describe, expect, test } from "bun:test";

import { createFakeKeychain, createFakeWinterPeer } from "../../src/testing/index.ts";
import { createRuntimeSdk, forwardableOptions, runtimeSdkInternals } from "../../src/index.ts";
import { InvalidBrandError, WINTER_BRAND, type BrandProfile } from "@yanlinglabs/winter-agent-sdk";

const keychain = createFakeKeychain();

/** A complete, valid reuser profile — every field a host would have to override to be honestly theirs. */
const ACME: Partial<BrandProfile> = {
  productName: "Acme",
  packageName: "acme-agent-sdk",
  homeDirName: ".acme",
  projectDirName: ".acme",
  instructionsFile: "ACME.md",
  envPrefix: "ACME_",
  keychainService: "com.acme.core",
  mcpServerName: "acme",
  processLabel: "acme",
  codexOriginator: "acme",
  tempRootName: "acme",
  pluginManifestDir: ".acme-plugin",
};

describe("the resolved brand", () => {
  test("with no profile, `sdk.brand` is byte-identical to the SDK's own default", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    expect(sdk.brand).toEqual(WINTER_BRAND);
    // A FRESH object, not the frozen singleton: `resolveBrand` builds one per call so a host that
    // mutates what it got back cannot reach the shared constant through it.
    expect(sdk.brand).not.toBe(WINTER_BRAND);
  });

  test("a partial profile is folded onto Winter's defaults, once, at construction", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, brand: { productName: "Acme", homeDirName: ".acme" } });
    expect(sdk.brand.productName).toBe("Acme");
    expect(sdk.brand.homeDirName).toBe(".acme");
    // Everything not overridden keeps Winter's value — that is what "fold onto the defaults" means.
    expect(sdk.brand.presetName).toBe(WINTER_BRAND.presetName);
    // Resolved ONCE: the same object every time, not a re-resolution per read.
    expect(sdk.brand).toBe(sdk.brand);
  });

  test("an INVALID profile is a typed construction refusal, through the injected peer's own class", () => {
    const { peer } = createFakeWinterPeer();
    let thrown: unknown;
    try {
      // `homeDirName` must be a leading dot then a lowercase token — it names a hidden directory.
      createRuntimeSdk({ peers: { winter: peer }, keychain, brand: { homeDirName: "acme" } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidBrandError);
    expect((thrown as InvalidBrandError).reason).toContain("homeDirName");
  });
});

describe("the brand reaches both branches", () => {
  test("the OFFICIAL seam gets the resolved profile through the one context every factory takes", () => {
    const { peer } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, brand: ACME });
    const context = runtimeSdkInternals(sdk)?.context;
    expect(context?.brand).toBe(sdk.brand);
    expect(context?.brand.mcpServerName).toBe("acme");
    // Lane A's two inputs are typed `brand: BrandProfile` — a FULL profile — and this is its producer.
    const optionsTemplateBrand: BrandProfile = context!.brand;
    const envInputBrand: BrandProfile = context!.brand;
    expect(optionsTemplateBrand.envPrefix).toBe("ACME_");
    expect(envInputBrand.keychainService).toBe("com.acme.core");
  });

  test("the WINTER leg gets it in the forwarded options, when the query itself names none", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, brand: ACME });
    sdk.query({ prompt: "hello", options: { model: "m" } });
    expect(calls[0]?.options.brand).toBe(sdk.brand);
    expect(calls[0]?.options.model).toBe("m");
  });

  test("a per-query `Options.brand` WINS and is never rewritten", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain, brand: ACME });
    const perQuery = { productName: "Per-Query" };
    const options = { brand: perQuery };
    sdk.query({ prompt: "hello", options });
    expect(calls[0]?.options.brand).toBe(perQuery);
    // Nothing to strip and nothing to fill in, so the caller's own object goes through by reference.
    expect(calls[0]?.options).toBe(options);
  });

  test("with NO constructor brand the forwarded object is still the caller's own, by reference", () => {
    const { peer, calls } = createFakeWinterPeer();
    const sdk = createRuntimeSdk({ peers: { winter: peer }, keychain });
    const options = { model: "m" };
    sdk.query({ prompt: "hello", options });
    // The resolved default IS Winter's default, which the SDK would apply anyway — so injecting it
    // would change nothing except this object's identity, and the pass-through is worth more.
    expect(calls[0]?.options).toBe(options);
    expect("brand" in calls[0]!.options).toBe(false);
  });

  test("`forwardableOptions` fills in and strips in the same pass", () => {
    const brand = { ...WINTER_BRAND, productName: "Acme" };
    expect(forwardableOptions({ model: "m" }, brand)).toEqual({ model: "m", brand });
    expect(forwardableOptions({ model: "m", runtime: {} }, brand)).toEqual({ model: "m", brand });
    expect(forwardableOptions({ model: "m", brand: { productName: "Mine" } }, brand)).toEqual({ model: "m", brand: { productName: "Mine" } });
  });
});
