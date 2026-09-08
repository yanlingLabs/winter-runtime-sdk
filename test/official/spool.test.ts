// WS-14 §1: the two launch profiles, and the rule that the OBSERVED root wins.
//
// The interesting assertions are the disagreements, because agreement is not what §1 is about: a
// `fresh-spool` generation that came back with a staging root, and a `store-backed-resume` generation
// whose staging uuid we could never have predicted, are the two cases the classifier exists for.
import { describe, expect, test } from "bun:test";
import { WINTER_BRAND } from "@yanlinglabs/winter-agent-sdk";

import { OfficialConfigurationError } from "../../src/official/errors.ts";
import {
  RESUME_STAGING_PREFIX,
  classifyLocalWriteRoot,
  isResumeStagingRoot,
  officialSpoolRoot,
  resumeStagingRoot,
  validateObservedConfigDir,
  vendorTempRootReport,
} from "../../src/official/spool.ts";

const brand = WINTER_BRAND;

describe("WS-14 §1 — launch profiles and the authoritative root", () => {
  test("the spool hangs off the RESOLVED brand home, so a reuser's spool is under their own home", () => {
    expect(officialSpoolRoot("/Users/x/.winter")).toBe("/Users/x/.winter/runtimes/official-agent-spool");
    expect(officialSpoolRoot("/Users/x/.acme")).toBe("/Users/x/.acme/runtimes/official-agent-spool");
    expect(() => officialSpoolRoot("")).toThrow(TypeError);
  });

  test("a staging root is recognised by BASENAME, never by substring", () => {
    expect(isResumeStagingRoot(resumeStagingRoot("/tmp", "a1e35775"))).toBe(true);
    expect(resumeStagingRoot("/tmp/", "u")).toBe(`/tmp/${RESUME_STAGING_PREFIX}u`);
    // a project directory that merely CONTAINS the prefix higher up is not a staging root
    expect(isResumeStagingRoot("/tmp/claude-resume-9/projects/key")).toBe(false);
    // the bare prefix with no uuid is not one either
    expect(isResumeStagingRoot(`/tmp/${RESUME_STAGING_PREFIX}`)).toBe(false);
    expect(isResumeStagingRoot("/Users/x/.winter/runtimes/official-agent-spool")).toBe(false);
  });

  test("classification is by SHAPE, and carries WS-16's own root kind", () => {
    expect(classifyLocalWriteRoot("/Users/x/.winter/runtimes/official-agent-spool")).toEqual({
      configDir: "/Users/x/.winter/runtimes/official-agent-spool",
      kind: "official-spool",
      profile: "fresh-spool",
    });
    expect(classifyLocalWriteRoot("/tmp/claude-resume-abc")).toEqual({
      configDir: "/tmp/claude-resume-abc",
      kind: "sdk-resume-staging",
      profile: "store-backed-resume",
    });
  });

  test("an ABSENT observed value fails the spawn — an unknown transcript root is unrecoverable", () => {
    expect(() => validateObservedConfigDir({ observed: undefined, configured: "/spool", profile: "fresh-spool", brand })).toThrow(OfficialConfigurationError);
    expect(() => validateObservedConfigDir({ observed: "", configured: "/spool", profile: "fresh-spool", brand })).toThrow(/config dir/);
  });

  test("a fresh generation that did not get the configured spool is refused, both ways it can happen", () => {
    // (a) it was handed a staging root
    expect(() => validateObservedConfigDir({ observed: "/tmp/claude-resume-x", configured: "/spool", profile: "fresh-spool", brand })).toThrow(/resume staging root/);
    // (b) it was handed a DIFFERENT spool — the record and the transcript would disagree
    expect(() => validateObservedConfigDir({ observed: "/other-spool", configured: "/spool", profile: "fresh-spool", brand })).toThrow(/authoritative/);
  });

  test("a store-backed resume only has to LOOK like a staging root — its uuid is the wrapper's", () => {
    expect(validateObservedConfigDir({ observed: "/tmp/claude-resume-9f2", configured: "/spool", profile: "store-backed-resume", brand })).toEqual({
      configDir: "/tmp/claude-resume-9f2",
      kind: "sdk-resume-staging",
      profile: "store-backed-resume",
    });
    // REVIEW r1, m1: …but it does have to look like ONE. Before the fix both refusals were gated on
    // `fresh-spool`, so a store-backed resume accepted any path at all — including the vendor's own
    // user-level home, recorded as kind `official-spool`, which is §1's exact conflation.
    expect(() => validateObservedConfigDir({ observed: "/spool", configured: "/spool", profile: "store-backed-resume", brand })).toThrow(/not a materialization staging root/);
    expect(() => validateObservedConfigDir({ observed: "/Users/dev/somewhere-else", configured: "/spool", profile: "store-backed-resume", brand })).toThrow(/staging root/);
  });

  test("the vendor's user-level home is refused on BOTH profiles (review r1, m1)", () => {
    for (const profile of ["fresh-spool", "store-backed-resume"] as const) {
      expect(() => validateObservedConfigDir({ observed: "/Users/dev/.claude", configured: "/spool", profile, brand })).toThrow(/vendor's user-level home/);
      expect(() => validateObservedConfigDir({ observed: "/Users/dev/.claude/projects", configured: "/spool", profile, brand })).toThrow(/vendor's user-level home/);
    }
  });

  test("the vendor temp root is reported HONESTLY: configured root plus the engine's own segment", () => {
    const report = vendorTempRootReport({ sharedTempRoot: "/private/tmp/acme-501", uid: 501 });
    expect(report.configured).toBe("/private/tmp/acme-501");
    expect(report.engineComputed).toBe("/private/tmp/acme-501/claude-501");
    expect(report.vendorSegment).toBe("claude-501");
    expect(report.note).toMatch(/forbidden/);
  });
});
