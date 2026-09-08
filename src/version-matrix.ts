// D19a: THE VERSION MATRIX, asserted at construction.
//
// WS-00 §2 (D19a) verbatim: "The runtime SDK asserts at construction that the injected SDK versions
// are inside its tested compatibility matrix (a `PROTOCOL_VERSION`-style negotiation) and refuses
// loudly otherwise."
//
// WHY THIS IS A CONSTRUCTION-TIME REFUSAL AND NOT A RUNTIME DEGRADE. The router is a selector and an
// adapter over two SDKs it does not version. Every one of its own guarantees — the Options template
// (WS-14 §2), the store wiring and its mirror semantics (WS-05 §6), the handoff barrier's eight
// steps (WS-05 §12) — is written against a specific pair of peer surfaces. A peer outside the matrix
// does not fail at construction on its own; it fails somewhere in the middle of a session, as a
// missing method or a changed shape, at which point the host has a half-written transcript and no
// way to attribute the fault. Refusing at `createRuntimeSdk()` costs one line in a host's startup
// path and makes the failure legible.
//
// WHAT "VERSION IDENTITY" MEANS HERE (WS-02 §3: "the runtime engine and wrapper carry separate
// version identities — sdkVersion vs engineVersion"). Two facts are read per peer:
//   * the PACKAGE version — what a host installed;
//   * for the Winter peer, `PROTOCOL_VERSION` — the wire contract the wrapper speaks to its runtime.
// The official peer has no protocol constant to read (its wire is its own business), so only its
// package version is matched.
//
// HOW THE PACKAGE VERSION IS READ, in order, with the source recorded in the report:
//   1. `peer-export` — a version identity exported by the INJECTED module namespace itself
//      (`SDK_VERSION` / `VERSION` / `PACKAGE_VERSION` / `version`). Authoritative, because it
//      describes the instance the host actually handed us, which is the only thing this package will
//      ever call.
//   2. `resolved-manifest` — the `package.json` of the copy THIS package can resolve, walked up from
//      `createRequire(import.meta.url).resolve(<name>)`. Second-best on purpose: in an ordinary
//      install it is the same copy, but a host that injected a different instance would be told
//      about the resolvable one. Recorded as its own `source` value so a diagnostic can say which
//      question was answered. Neither `@yanlinglabs/winter-agent-sdk@0.0.1` nor
//      `@anthropic-ai/claude-agent-sdk@0.3.250` exports a version identity today (measured), so this
//      is the live path for both until the Winter SDK grows one — see the CARRY in the Task 1 report.
//   3. otherwise `undefined` — which is a REFUSAL, never an assumption. "I could not tell" and "it is
//      fine" are different answers and only one of them is honest.
//
// NO `semver` DEPENDENCY. This package has zero runtime dependencies and the matrix needs exactly
// two range forms (a two-comparator range today, a caret at the close-out). `satisfiesRange` below
// implements those with plant tests; a dependency to answer `0.0.2 >= 0.0.2` would be the larger
// risk.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { RuntimeSdkVersionError } from "./errors.ts";
import type { RuntimeSdkPeers } from "./sdk.ts";

/**
 * THE MATRIX. The plan pins this object verbatim.
 *
 * `winterAgentSdk` is a RANGE because the Winter SDK is this repository's sibling and moves with it;
 * `claudeAgentSdk` is an EXACT pin because WS-02 §6.1 says declaration identity alone must not
 * approve an upgrade — a new official version is a reviewed compatibility event (WS-17's drift gate),
 * not a range that quietly widens.
 */
export const SUPPORTED = { winterAgentSdk: ">=0.0.2 <0.1.0", claudeAgentSdk: "0.3.250" } as const;

/**
 * The Winter wire protocol versions this router is tested against (`PROTOCOL_VERSION` in the SDK's
 * own `protocol/frames.ts`). Separate from `SUPPORTED` because the plan pins that object's shape and
 * because these are two independent identities: a wrapper can be re-released without moving its wire.
 */
export const SUPPORTED_PROTOCOL_VERSIONS = ["1.0"] as const;

/** Where a peer's package version came from. See this module's header. */
export type PeerVersionSource = "peer-export" | "resolved-manifest";

export interface PeerVersionIdentity {
  /** The package name the identity was read for. */
  packageName: string;
  /** The version string that was matched against the matrix. */
  packageVersion: string;
  source: PeerVersionSource;
  /** The matrix entry this peer satisfied. */
  supported: string;
}

export interface VersionMatrixReport {
  winterAgentSdk: PeerVersionIdentity & { protocolVersion: string };
  /** Absent when no official peer was injected — which is allowed (a Winter-only host). */
  claudeAgentSdk?: PeerVersionIdentity;
  /** The matrix the report was produced against, so a diagnostic never has to guess. */
  supported: typeof SUPPORTED;
  supportedProtocolVersions: readonly string[];
  /** ISO-8601, so a persisted report says when it was taken. */
  checkedAt: string;
}

// --- semver, the two forms this matrix needs ------------------------------------------------------

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** The `-alpha.1` tail, or "" for a release. */
  prerelease: string;
}

/** Parses `X.Y.Z`, `vX.Y.Z`, `X.Y.Z-tag`, `X.Y.Z+build`. Returns undefined for anything else. */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] ?? "" };
}

/** -1 / 0 / 1. A prerelease sorts BELOW the release with the same core (standard semver §11). */
function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === "") return 1;
  if (b.prerelease === "") return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

/** `^0.0.2` -> `>=0.0.2 <0.0.3`; `^0.2.1` -> `>=0.2.1 <0.3.0`; `^1.2.3` -> `>=1.2.3 <2.0.0`. */
function expandCaret(base: ParsedVersion): { lower: ParsedVersion; upper: ParsedVersion } {
  const upper: ParsedVersion =
    base.major > 0
      ? { major: base.major + 1, minor: 0, patch: 0, prerelease: "" }
      : base.minor > 0
        ? { major: 0, minor: base.minor + 1, patch: 0, prerelease: "" }
        : { major: 0, minor: 0, patch: base.patch + 1, prerelease: "" };
  return { lower: base, upper };
}

/**
 * Whether `version` satisfies `range`.
 *
 * Supported forms, and deliberately only these: a space-separated conjunction of `>=`/`>`/`<=`/`<`
 * comparators, a caret (`^X.Y.Z`), and a bare or `=`-prefixed exact version. An UNRECOGNISED range
 * throws rather than returning false — a matrix entry nobody can parse is a bug in the matrix, and
 * silently refusing every peer would look like a peer problem.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (parsed === undefined) return false;
  const comparators = range.trim().split(/\s+/).filter((c) => c.length > 0);
  if (comparators.length === 0) throw new Error(`winter-runtime-sdk: empty version range`);
  for (const comparator of comparators) {
    const caret = comparator.startsWith("^") ? parseVersion(comparator.slice(1)) : undefined;
    if (comparator.startsWith("^")) {
      if (caret === undefined) throw new Error(`winter-runtime-sdk: unparseable caret range "${comparator}"`);
      const { lower, upper } = expandCaret(caret);
      if (compareVersions(parsed, lower) < 0) return false;
      if (compareVersions(parsed, upper) >= 0) return false;
      continue;
    }
    const operatorMatch = /^(>=|<=|>|<|=)?(.*)$/.exec(comparator);
    const operator = operatorMatch?.[1] ?? "";
    const operandRaw = operatorMatch?.[2] ?? "";
    const operand = parseVersion(operandRaw);
    if (operand === undefined) throw new Error(`winter-runtime-sdk: unparseable version range "${range}" (at "${comparator}")`);
    const cmp = compareVersions(parsed, operand);
    const ok =
      operator === ">=" ? cmp >= 0 : operator === ">" ? cmp > 0 : operator === "<=" ? cmp <= 0 : operator === "<" ? cmp < 0 : cmp === 0;
    if (!ok) return false;
  }
  return true;
}

// --- reading a peer's version identity ------------------------------------------------------------

/** The export names a peer may use to publish its own package version, in probe order. */
export const VERSION_EXPORT_NAMES = ["SDK_VERSION", "VERSION", "PACKAGE_VERSION", "version"] as const;

/** Step 1: a version identity exported by the injected module namespace itself. */
export function readExportedVersion(namespace: unknown): string | undefined {
  if (typeof namespace !== "object" || namespace === null) return undefined;
  const record = namespace as Record<string, unknown>;
  for (const name of VERSION_EXPORT_NAMES) {
    const value = record[name];
    if (typeof value === "string" && parseVersion(value) !== undefined) return value;
  }
  return undefined;
}

/**
 * Step 2: the `version` of the copy of `packageName` THIS module can resolve.
 *
 * Walks up from the resolved entry file rather than resolving `<name>/package.json` directly,
 * because a package whose `exports` map is closed to `"."` (the Winter SDK's is) does not expose its
 * own manifest as a subpath. Every failure mode — no such package, a manifest that will not parse, a
 * manifest with no `version` — returns `undefined`, which the caller turns into the loud refusal.
 * Never throws: a missing OPTIONAL peer must not crash the matrix on its way to reporting itself.
 */
export function readResolvedManifestVersion(packageName: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    let dir = dirname(require.resolve(packageName));
    for (let depth = 0; depth < 10; depth++) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
        // The FIRST package.json walking up need not be the package's own (a nested one inside a
        // dist directory would be, e.g., a `{"type":"module"}` marker) -- so the name must match.
        if (parsed.name === packageName && typeof parsed.version === "string") return parsed.version;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function identityFor(packageName: string, namespace: unknown, supported: string): PeerVersionIdentity | undefined {
  const exported = readExportedVersion(namespace);
  if (exported !== undefined) return { packageName, packageVersion: exported, source: "peer-export", supported };
  const resolved = readResolvedManifestVersion(packageName);
  if (resolved !== undefined) return { packageName, packageVersion: resolved, source: "resolved-manifest", supported };
  return undefined;
}

const UNKNOWN_ACTUAL = "unknown (the injected module exports no version identity and no installed copy could be resolved)";

/**
 * Reads each injected peer's version identity and refuses loudly on a miss.
 *
 * Three outcomes, and the third is the one worth naming: an ABSENT official peer is allowed. A
 * Winter-only host injects `{ winter }` and never loads the official runtime (that is the whole
 * point of the optional peer), so "no claude peer" is a valid, fully-supported configuration and the
 * report simply omits the row.
 */
export function assertVersionMatrix(peers: RuntimeSdkPeers): VersionMatrixReport {
  const winterName = "@yanlinglabs/winter-agent-sdk";
  const winterIdentity = identityFor(winterName, peers.winter, SUPPORTED.winterAgentSdk);
  if (winterIdentity === undefined) {
    throw new RuntimeSdkVersionError({ expected: `${winterName} ${SUPPORTED.winterAgentSdk}`, actual: UNKNOWN_ACTUAL });
  }
  if (!satisfiesRange(winterIdentity.packageVersion, SUPPORTED.winterAgentSdk)) {
    throw new RuntimeSdkVersionError({ expected: `${winterName} ${SUPPORTED.winterAgentSdk}`, actual: `${winterName} ${winterIdentity.packageVersion}` });
  }

  const protocolVersion = (peers.winter as unknown as { PROTOCOL_VERSION?: unknown }).PROTOCOL_VERSION;
  if (typeof protocolVersion !== "string") {
    throw new RuntimeSdkVersionError({
      expected: `${winterName} exports PROTOCOL_VERSION (one of ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      actual: `PROTOCOL_VERSION is ${protocolVersion === undefined ? "absent" : typeof protocolVersion}`,
    });
  }
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(protocolVersion)) {
    throw new RuntimeSdkVersionError({
      expected: `${winterName} PROTOCOL_VERSION one of ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      actual: `PROTOCOL_VERSION ${protocolVersion}`,
    });
  }

  const report: VersionMatrixReport = {
    winterAgentSdk: { ...winterIdentity, protocolVersion },
    supported: SUPPORTED,
    supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
    checkedAt: new Date().toISOString(),
  };

  if (peers.claude === undefined) return report;

  const claudeName = "@anthropic-ai/claude-agent-sdk";
  const claudeIdentity = identityFor(claudeName, peers.claude, SUPPORTED.claudeAgentSdk);
  if (claudeIdentity === undefined) {
    throw new RuntimeSdkVersionError({ expected: `${claudeName} ${SUPPORTED.claudeAgentSdk}`, actual: UNKNOWN_ACTUAL });
  }
  if (!satisfiesRange(claudeIdentity.packageVersion, SUPPORTED.claudeAgentSdk)) {
    throw new RuntimeSdkVersionError({ expected: `${claudeName} ${SUPPORTED.claudeAgentSdk}`, actual: `${claudeName} ${claudeIdentity.packageVersion}` });
  }
  return { ...report, claudeAgentSdk: claudeIdentity };
}
