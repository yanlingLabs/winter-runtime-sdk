// WS-14 §14: BRANDING AND DISCLOSURE ON THE OFFICIAL BRANCH.
//
// "UI may say 'Claude Agent' or 'Claude' and must describe the backend accurately; it must not
// present the integration as 'Claude Code' or Winter as an Anthropic product. Product UI labels
// sessions '<Product> Agent'; internal diagnostics label this branch `winter-claude-agent`."
//
// THIS MODULE OWNS THE DIAGNOSTICS LABEL AND THE DISCLOSURE SET, AND NOTHING ELSE. Product UI
// strings are the HOST's (WS-15/Phase 8, D19c) — a router that exported a user-facing sentence would
// be making a product decision on the host's behalf, in a package a reuser rebrands. What a host
// cannot invent for itself is the honest list of vendor-named artifacts this branch leaves behind,
// so that list lives here as data rather than as prose in a spec nobody ships.
//
// THE LABEL IS BRAND-DERIVED, not the literal WS-01 §5 spells. For Winter's own profile
// `processLabel` is the product token D12 already labels the child with, so the derivation produces
// exactly the documented string; for a reuser it produces theirs. A literal would hand every reuser
// Winter's diagnostics name, which is the whole failure mode `brand` exists to prevent.
import type { BrandProfile } from "@yanlinglabs/winter-agent-sdk";

/**
 * The internal diagnostics label for this branch (WS-14 §14, WS-01 §5).
 *
 * `<processLabel>-claude-agent` — the Winter-owned half comes from the profile, the Claude-mirroring
 * half is fixed (WS-01 §5/D16: vendor literals are never rebranded, because renaming them would be a
 * lie about which runtime is executing).
 */
export function officialBranchLabel(brand: Pick<BrandProfile, "processLabel">): string {
  return `${brand.processLabel}-claude-agent`;
}

/** One disclosed vendor-named artifact: what it is, where it shows up, and why it cannot be renamed. */
export interface OfficialDisclosure {
  /** A stable id so a capability matrix can key rows off it rather than off prose. */
  id: "signed-binary-identity" | "spool-config-file" | "nested-engine-temp" | "resume-staging" | "extraction-cache";
  /** The vendor literal a user or an operator will actually see. */
  literal: string;
  /** Where it appears. */
  where: string;
  /** Why Winter does not and must not rename it. */
  why: string;
}

/**
 * WS-14 §14's disclosure set, as data.
 *
 * Every entry is a place the official branch is visibly Anthropic's, and the honest caveat D12
 * attaches to the process label ("the Mach-O stays signed `com.anthropic.claude-code`; some process
 * viewers, crash reports and code-signing displays reveal the real identity") is the first row. The
 * last row is the one that is disclosed as AVOIDED rather than present, because WS-02 ships the
 * native package as a normal resource and a disclosure that quietly dropped it would read, later, as
 * a claim that the cache never existed.
 */
export const OFFICIAL_DISCLOSURES: readonly OfficialDisclosure[] = [
  {
    id: "signed-binary-identity",
    literal: "com.anthropic.claude-code",
    where: "the code signature of the runtime binary, in process viewers, crash reports and signing displays",
    why: "the binary is never patched, re-signed, or misrepresented as ours — the D12 process label is cosmetic and this is the identity underneath it",
  },
  {
    id: "spool-config-file",
    literal: ".claude.json",
    where: "inside the spool root (CLAUDE_CONFIG_DIR relocates the root; the basename stays literal)",
    why: "the runtime's own config file name; the supported control is the ROOT, not the basename",
  },
  {
    id: "nested-engine-temp",
    literal: "claude-<uid>",
    where: "a subdirectory the engine appends under the configured shared temp root",
    why: "the runtime computes it itself; symlink tricks are rejected by the runtime and forbidden",
  },
  {
    id: "resume-staging",
    literal: "claude-resume-<uuid>",
    where: "the OS temp directory, for a generation resumed out of the shared session store",
    why: "the prefix is fixed by the runtime; only the temp BASE is host-controllable, and only through the SDK parent's own process environment",
  },
  {
    id: "extraction-cache",
    literal: "claude-agent-sdk-<hash>",
    where: "not present — avoided by packaging the native runtime as an ordinary resource rather than a self-extracting bundle",
    why: "disclosed as avoided rather than omitted, so a later reader can tell an absent cache from an undocumented one",
  },
] as const;
