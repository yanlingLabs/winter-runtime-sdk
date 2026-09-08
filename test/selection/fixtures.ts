// The listings and credential maps every selection test is built from.
//
// SHAPED LIKE THE REAL CATALOG, on purpose. `ModelFamilyListing` is what `Query.listModelFamilies()`
// returns, and the D13 table is only as trustworthy as the shapes it was exercised against — so the
// families, the slot names, the canonical ids and the provider-qualified row keys below are the
// spellings the generated catalog actually publishes (`packages/provider-catalog/generated/
// catalog.json`, read at 2026-09-08): the `claude` family's four reserved slots, `gpt`'s four, one
// canonical Claude model served by three different providers with three different wire dialects, and
// a Bedrock row whose key carries the vendor's own namespace.
//
// NOTHING HERE IS A CREDENTIAL. `CredentialPresence` carries ref KINDS and auth families, never
// material; there is no keychain, no environment read and no file in this file.
import type { CredentialPresence, ProviderAuthView } from "../../src/selection/runtime-selection.ts";
import type { ModelFamilyListing } from "@yanlinglabs/winter-agent-sdk";

type Family = ModelFamilyListing["families"][number];
type Row = Family["models"][number]["rows"][number];

/** A servable row, spelled the way the listing spells one. */
export function row(key: string, providerId: string, over: Partial<Row> = {}): Row {
  return { key, providerId, status: "candidate", pricingBasis: "token", servable: "present", ...over };
}

const slot = (name: string, canonicalModelId: string) => ({
  name,
  canonicalModelId,
  description: `the ${name} slot`,
  reason: `fixture: ${name}`,
});

/** The `claude` family with D25's four reserved slot names and the rows row 17 turns on. */
export const claudeFamily: Family = {
  id: "claude",
  displayName: "Claude",
  vendor: "Anthropic",
  slots: [slot("fable", "claude-fable-5.1"), slot("opus", "claude-opus-5"), slot("sonnet", "claude-sonnet-5"), slot("haiku", "claude-haiku-4.5")],
  models: [
    { canonicalModelId: "claude-fable-5.1", displayName: "Fable 5.1", rows: [row("anthropic/claude-fable-5-1", "anthropic")] },
    {
      canonicalModelId: "claude-opus-5",
      displayName: "Opus 5",
      // THREE PROVIDERS, ONE RAW MODEL ID — the catalog really ships six of these for this id. The
      // first is the vendor's own Anthropic-dialect endpoint; the other two resell the same model
      // over an OpenAI-shaped wire, which is D13 row 3's whole subject.
      rows: [row("anthropic/claude-opus-5", "anthropic"), row("kie/claude-opus-5", "kie"), row("agentrouter/claude-opus-5", "agentrouter")],
    },
    { canonicalModelId: "claude-sonnet-5", displayName: "Sonnet 5", rows: [row("anthropic/claude-sonnet-5", "anthropic")] },
    {
      canonicalModelId: "claude-haiku-4.5",
      displayName: "Haiku 4.5",
      rows: [row("anthropic/claude-haiku-4.5", "anthropic"), row("bedrock/anthropic.claude-haiku-4-5", "bedrock")],
    },
  ],
};

/** The `gpt` family — D28's "Astra and Luna route to Winter" side of the table. */
export const gptFamily: Family = {
  id: "gpt",
  displayName: "GPT",
  vendor: "OpenAI",
  slots: [slot("astra", "gpt-6-astra"), slot("sol", "gpt-5.6-sol"), slot("terra", "gpt-5.6-terra"), slot("luna", "gpt-5.6-luna")],
  models: [
    { canonicalModelId: "gpt-6-astra", displayName: "Astra", rows: [row("openai/gpt-6-astra", "openai"), row("azure-openai/gpt-6-astra", "azure-openai")] },
    { canonicalModelId: "gpt-5.6-luna", displayName: "Luna", rows: [row("openai/gpt-5.6-luna", "openai")] },
  ],
};

/** A third family, so "a unique slot name in some other family" has something to be unique against. */
export const geminiFamily: Family = {
  id: "gemini",
  displayName: "Gemini",
  vendor: "Google",
  slots: [slot("pro", "gemini-3-pro"), slot("flash", "gemini-3-flash")],
  models: [
    { canonicalModelId: "gemini-3-pro", displayName: "Gemini 3 Pro", rows: [row("google/gemini-3-pro", "google"), row("vertex/gemini-3-pro", "vertex")] },
    { canonicalModelId: "gemini-3-flash", displayName: "Gemini 3 Flash", rows: [row("google/gemini-3-flash", "google")] },
  ],
};

/** A listing whose active set is the named family's own slots (`ActiveSlotSet.source` per WS-13c §3). */
export function listing(activeFamily?: "claude" | "gpt" | "gemini", families: Family[] = [claudeFamily, gptFamily, geminiFamily]): ModelFamilyListing {
  if (activeFamily === undefined) return { active: undefined, families };
  const family = families.find((f) => f.id === activeFamily);
  if (family === undefined) throw new Error(`fixture: no ${activeFamily} family in this listing`);
  return {
    active: { family: family.id, source: family.id === "claude" ? "claude-pinned" : "family-default", slots: family.slots },
    families,
  };
}

/** The provider descriptions the real catalog carries for these ids (protocols + auth kind). */
export const PROVIDER_VIEWS: Record<string, ProviderAuthView> = {
  anthropic: { authFamily: "api-key", protocols: ["anthropic-messages"] },
  bedrock: { authFamily: "cloud-credential-chain", protocols: ["bedrock-converse"] },
  vertex: { authFamily: "cloud-credential-chain", protocols: ["google-generate-content"] },
  kie: { authFamily: "api-key", protocols: ["openai-chat-completions"] },
  agentrouter: { authFamily: "api-key", protocols: ["openai-chat-completions"] },
  openai: { authFamily: "api-key", protocols: ["openai-responses", "openai-chat-completions"] },
  "azure-openai": { authFamily: "api-key", protocols: ["azure-openai"] },
  google: { authFamily: "api-key", protocols: ["google-generate-content"] },
};

/**
 * A credential map naming the providers a session has a configured ref for.
 *
 * `over` replaces a provider's auth view — that is how a test says "this session's Anthropic
 * credential is a Claude OAuth one" without inventing a provider.
 */
export function credentials(providerIds: string[], over: Record<string, ProviderAuthView> = {}): CredentialPresence {
  const byProvider: Record<string, "keychain" | "env" | "file" | "inline" | "aws-default-chain" | "none"> = {};
  const authByProvider: Record<string, ProviderAuthView> = {};
  for (const id of providerIds) {
    const view = over[id] ?? PROVIDER_VIEWS[id];
    if (view === undefined) throw new Error(`fixture: no provider view for ${id}`);
    byProvider[id] = view.authFamily === "cloud-credential-chain" ? "aws-default-chain" : view.authFamily === "local-none" ? "none" : "keychain";
    authByProvider[id] = view;
  }
  return { byProvider, authByProvider };
}

/** A fixed instant, so a produced record is byte-reproducible in a test. */
export const NOW = "2026-09-08T12:00:00.000Z";

/** The version identities a host would stamp; both present so a test can see which one was chosen. */
export const VERSIONS = { winterSdkVersion: "0.0.2", claudeSdkVersion: "0.3.250", engineVersion: "2.1.250" };
