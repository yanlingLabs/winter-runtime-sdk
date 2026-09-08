// WS-14 §12: PER-BRANCH AUTHENTICATION — exactly one auth family, injected at spawn, never on disk.
//
// "The session's `RuntimeSelection` selects exactly ONE auth family, injected via §3's allowlist at
// spawn. Credentials live in Keychain, fetched at spawn, never written to disk, session files, or
// fixtures."
//
// THIS MODULE IS NAMES, NOT MATERIAL. It answers one question — WHICH environment variables is this
// session's auth family allowed to set — and the answer is a closed set per family. The values come
// from the host's `KeychainSeam` at spawn (`fetchAuthCredentials` below is the only place this
// package reads one) and are handed straight to the env builder, which hands them to the child. This
// module holds nothing: no cache, no module-level map, no default that could outlive a call.
//
// THE VARIABLE NAMES ARE A PINNED CAPTURE, NOT AN ASSUMPTION. §12: "Exact variable names are captured
// per pinned version into the env-allowlist fixture, NEVER assumed stable across upgrades." Every
// name below was verified present in the pinned 0.3.250 runtime artifact (a string scan of the
// installed `sdk.mjs`, recorded in the Lane A report), and `test/official/env-allowlist.test.ts`
// re-runs that scan so an upgrade that drops a name fails here rather than in a user's session.
//
// PRECEDENCE IS WHY THE FAMILY MUST BE EXACTLY ONE. The runtime resolves credentials in a fixed
// order — cloud provider credentials, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then
// `apiKeyHelper`, then `CLAUDE_CODE_OAUTH_TOKEN`, then profile/federation, then stored `/login`
// subscription credentials. Injecting two families does not "prefer" one, it silently picks by that
// table, and the session then bills, rate-limits and audits against an account the host did not
// choose. Refusing the combination is the only way to keep the selection meaningful.
import type { CredentialRef } from "@yanlinglabs/winter-agent-sdk";

import type { KeychainSeam } from "../seams/keychain.ts";
import type { RuntimeSelection } from "../selection/runtime-selection.ts";
import { OfficialConfigurationError } from "./errors.ts";

/** `RuntimeSelection.authFamily` — restated as a local alias so the tables below read as tables. */
export type AuthFamily = RuntimeSelection["authFamily"];

/**
 * The credential-shaped variables ONE auth family may set, per §12's table.
 *
 * `cloud-credential-chain` is deliberately split by provider: Bedrock and Vertex are two different
 * variable sets and a session is on one of them, never both. The split key is `providerId`, which is
 * the persisted selection's own field — never an ambient scan of the environment (WS-14's Phase 6
 * amendment: "a pinned alias resolves to the `anthropic` provider ONLY when a credential ref for it
 * is configured, and never by ambient environment scan").
 */
export const AUTH_FAMILY_VARIABLES = {
  "api-key": ["ANTHROPIC_API_KEY"],
  /**
   * A bearer credential (Console OAuth, or an approved gateway).
   *
   * THE FULL PAIR, ALWAYS — §12's gateway caveat: "an explicit gateway credential replaces
   * subscription login, but `ANTHROPIC_BASE_URL` alone can leave a stored OAuth credential active;
   * gateway configs MUST set the full credential pair." So the endpoint is part of this family's set
   * rather than a separate knob, and the validator below refuses a base URL with no token.
   */
  "console-oauth": ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"],
  bedrock: ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
  vertex: ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_VERTEX_BASE_URL"],
  /**
   * §12's last row: NONE. "Claude OAuth (D14-gated) — stored subscription credentials live inside the
   * spool namespace; no env credential injected." The empty set is the rule, not an oversight.
   */
  "claude-oauth": [],
  /** A runtime with no credential at all (a local endpoint). Nothing to inject. */
  "local-none": [],
} as const satisfies Record<string, readonly string[]>;

export type AuthVariableSetKey = keyof typeof AUTH_FAMILY_VARIABLES;

/** Every credential-shaped name any family may set — the env allowlist's auth section. */
export const ALL_AUTH_VARIABLES: readonly string[] = Object.values(AUTH_FAMILY_VARIABLES).flat().filter((name, index, all) => all.indexOf(name) === index);

/**
 * NEVER INJECTED, on any branch, in any family (§3, §5.1, §12; WS-01 §2.5).
 *
 * The subscription OAuth token is the one credential the runtime can pick up from the environment
 * that Winter must never place there: D14 gates the OAuth branch entirely, and the supported flow
 * puts its stored credentials INSIDE THE SPOOL rather than in a variable.
 */
export const NEVER_INJECTED_AUTH_VARIABLES: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN"];

/** Which variable set a selection's family uses, `providerId` deciding the cloud split. */
export function authVariableSetKey(selection: Pick<RuntimeSelection, "authFamily" | "providerId">): AuthVariableSetKey | "custom" {
  switch (selection.authFamily) {
    case "cloud-credential-chain":
      return selection.providerId.toLowerCase().includes("vertex") ? "vertex" : "bedrock";
    case "custom":
      return "custom";
    default:
      return selection.authFamily;
  }
}

/**
 * The names this session's family is allowed to set.
 *
 * `custom` returns `undefined` rather than a set: a host that declares a custom auth family is saying
 * "I name these variables myself", and the env builder validates them against the FORBIDDEN list
 * instead of an allowlist. That is a deliberate hole with a fence around it — §3's "anything else is
 * a deliberate, documented addition" — and it is the only family for which the set is open.
 */
export function allowedAuthVariables(selection: Pick<RuntimeSelection, "authFamily" | "providerId">): readonly string[] | undefined {
  const key = authVariableSetKey(selection);
  return key === "custom" ? undefined : AUTH_FAMILY_VARIABLES[key];
}

/** D14's ship gate: the OAuth branch is built but publicly gated pending written approval. */
export interface ClaudeOauthGate {
  /** Default FALSE everywhere. "Until approval exists, the shippable branch uses API-key/cloud/gateway auth only." */
  approved: boolean;
}

/**
 * Validates the credential material a caller assembled for this session, before it reaches a child.
 *
 * Four refusals, each naming a real way the "exactly one family" rule breaks:
 *   1. a variable outside the family's set (two families at once, decided silently by precedence);
 *   2. `CLAUDE_CODE_OAUTH_TOKEN`, ever;
 *   3. a bearer family with a base URL and no token (the §12 gateway caveat's exact failure: the
 *      endpoint moves and a STORED subscription credential stays active behind it);
 *   4. `claude-oauth` while the D14 gate is closed, or with any variable at all (that family injects
 *      none by definition).
 */
export function validateAuthEnvironment(args: {
  selection: Pick<RuntimeSelection, "authFamily" | "providerId">;
  credentials: Readonly<Record<string, string>>;
  gate: ClaudeOauthGate;
  branchLabel: string;
}): void {
  const names = Object.keys(args.credentials);
  for (const name of names) {
    if (NEVER_INJECTED_AUTH_VARIABLES.includes(name)) {
      throw new OfficialConfigurationError({
        option: `env.${name}`,
        reason: "this credential is never injected on this branch: D14 gates the subscription-OAuth route, and its supported flow stores credentials inside the spool namespace instead (WS-14 §12, WS-01 §2.5)",
        branchLabel: args.branchLabel,
      });
    }
  }
  if (args.selection.authFamily === "claude-oauth") {
    if (!args.gate.approved) {
      throw new OfficialConfigurationError({
        option: "selection.authFamily",
        reason: "the Claude OAuth branch is ship-gated pending written approval (D14); the shippable branch uses API-key, cloud-credential-chain or gateway auth only",
        branchLabel: args.branchLabel,
      });
    }
    if (names.length > 0) {
      throw new OfficialConfigurationError({
        option: "credentials",
        reason: `the Claude OAuth family injects NO credential variable — its stored subscription state lives inside the spool namespace — but ${names.join(", ")} was supplied`,
        branchLabel: args.branchLabel,
      });
    }
    return;
  }
  const allowed = allowedAuthVariables(args.selection);
  if (allowed !== undefined) {
    const stray = names.filter((name) => !allowed.includes(name));
    if (stray.length > 0) {
      throw new OfficialConfigurationError({
        option: "credentials",
        reason: `${stray.join(", ")} does not belong to the ${args.selection.authFamily} family (${allowed.length === 0 ? "which injects nothing" : allowed.join(", ")}); two families in one child are resolved by the runtime's own precedence order, not by the host's selection`,
        branchLabel: args.branchLabel,
      });
    }
    if (allowed.includes("ANTHROPIC_AUTH_TOKEN") && names.includes("ANTHROPIC_BASE_URL") && !names.includes("ANTHROPIC_AUTH_TOKEN")) {
      throw new OfficialConfigurationError({
        option: "credentials.ANTHROPIC_BASE_URL",
        reason: "a gateway endpoint without its bearer token leaves a stored subscription credential active behind the new endpoint (WS-14 §12's gateway caveat) — set the full pair or neither",
        branchLabel: args.branchLabel,
      });
    }
  }
}

/** One variable's credential source: the name to set, and the ref whose material fills it. */
export interface AuthCredentialPlan {
  variable: string;
  ref: CredentialRef;
}

/**
 * Fetches this session's credential material AT SPAWN (§12) and returns it for immediate injection.
 *
 * THE ONLY KEYCHAIN READ IN THIS PACKAGE, and it returns rather than stores. A missing ref is a
 * TYPED refusal and not a silent omission: a child launched with an empty auth family falls through
 * the runtime's precedence table to whatever the spool happens to hold, which is the accident §12
 * exists to prevent.
 */
export async function fetchAuthCredentials(args: {
  plan: readonly AuthCredentialPlan[];
  keychain: KeychainSeam;
  branchLabel: string;
}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of args.plan) {
    const material = await args.keychain.read(entry.ref);
    if (material === undefined || material.length === 0) {
      throw new OfficialConfigurationError({
        option: `credentials.${entry.variable}`,
        reason: `the host's keychain holds no material for this session's ${entry.ref.kind} credential reference; launching without it would fall through the runtime's precedence order to whatever the spool holds`,
        branchLabel: args.branchLabel,
      });
    }
    out[entry.variable] = material;
  }
  return out;
}
