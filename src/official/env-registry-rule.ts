// THE INDEPENDENT CLASSIFIER (review r3, NEW-10) — and "independent" is the whole point.
//
// The r2 drift test selected its universe with `isAuthShapedVariable` and then asserted that every
// selected name was refused by `isAuthShapedVariable`. It could not fail for any regex, and it could
// not see a credential-bearing name that regex missed — which was precisely the class r2 raised.
// Seventeen names the artifact's own registry declares rode the extras door underneath it.
//
// So the classification that builds the allowlist is made HERE, by a different rule than the one the
// door applies: a NAME-KEYWORD test over the artifact's own registry, rather than a prefix shape over
// a caller's input. The door then consults the RESULT (a committed list, `env-registry.ts`), and the
// drift gate re-derives the result from the artifact and fails on a difference — so a runtime upgrade
// that adds a credential accessor breaks a test rather than opening a door.
//
// THE RULE IS DELIBERATELY BLUNT. A name containing any of these segments is treated as
// credential-bearing, and the false positives (a model-name knob that happens to say `PROJECT`) cost
// a host one entry in `reviewedCredentialShapedExtras`. The opposite error costs an account.

/** Segments that make a variable name credential-bearing, whatever else it says. */
export const CREDENTIAL_NAME_KEYWORDS: readonly string[] = [
  "KEY",
  "TOKEN",
  "SECRET",
  "CRED",
  "AUTH",
  "CERT",
  "PASSWORD",
  "PASSWD",
  "PASSPHRASE",
  "OAUTH",
  "PROXY",
  "SSL",
  "TLS",
  "IDENTITY",
  "LOGIN",
  "SIGN",
  "SESSION",
  "ACCOUNT",
  "PROFILE",
  "SCOPE",
  "DESCRIPTOR",
  "SOCKET",
  "ENDPOINT",
  "URL",
  "HOST",
  "CONFIG_DIR",
  "REGION",
  "PROJECT",
  "WORKSPACE",
  "ORGANIZATION",
  "BEARER",
  "PRIVATE",
  "HELPER",
  "STORE",
  "HEADERS",
  "COOKIE",
  "SIGNATURE",
  "WEBHOOK",
];

/**
 * Every env-shaped accessor the pinned artifact declares (`NAME:()=>fn` in its own export map).
 *
 * Filtered to env-SHAPED names — an upper- or lower-snake identifier with at least one underscore —
 * because the same construct carries minified function names, and a registry padded with those would
 * make the drift gate noisy rather than informative.
 */
export function extractEnvRegistry(artifact: string): string[] {
  const names = new Set<string>();
  for (const match of artifact.matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,})\s*:\s*\(\)\s*=>/g)) {
    const name = match[1] as string;
    if (/^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** The independent rule: is this NAME credential-bearing? Case-insensitive, by segment. */
export function isCredentialByName(name: string): boolean {
  const upper = name.toUpperCase();
  return CREDENTIAL_NAME_KEYWORDS.some((keyword) => upper.includes(keyword));
}
