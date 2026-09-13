// WS-18 W18-20 — P10b-6 fix round 1, CRITICAL: THE DEFAULT ENDPOINT RESOLVER MUST BE CATALOG-BACKED.
//
// `computeSwitchReview` (`store/handoff-barrier.ts`) and the official leg's Claude-ready wrap
// (`door.ts`) both fall back to `endpointFromOrigin` — `@yanlinglabs/winter-provider-runtime`'s
// REGISTRY-FREE fallback — whenever a host injects no `resolveEndpoint`. Measured: that fallback
// reports `readableState: "none"` for EVERY model, with no continuation or domain evidence at all, so
// a real DeepSeek→GLM switch with a `{material:"exposed",complete:true}` sidecar record — the exact
// row R-10b-2/W18-21 protects as silent — came back `warned-lossy`/`prompt:true` with no injected
// resolver. That is a silent misclassification in the direction that matters most: it PROMPTS where
// the ruling says it must not.
//
// THE FIX: build a real registry from the CATALOG data compiled into `@yanlinglabs/winter-provider-
// catalog`'s `loadCatalog()` — no network, no credentials, no adapter ever invoked — and resolve
// through `createEndpointResolver`, provider-runtime's OWN domain/readable-state derivation
// (`continuity/domains.ts`'s header: "one derivation, in the registry"). This module reimplements
// NONE of that derivation; it only builds the registry the derivation needs.
//
// THE ONE OBSTACLE, MEASURED: `ProviderRegistry.resolve()` refuses `no-adapter` for any catalog
// provider with no adapter registered — checked BEFORE the descriptor is ever read
// (`registry.ts`'s `build()`), so a registry built with ZERO adapters resolves NOTHING and this
// "fix" would be exactly as blind as `endpointFromOrigin`. `resolve()` never calls an adapter's own
// methods to answer a capability question — `readableStateOf`/`continuationDomainOf` read the
// CATALOG DESCRIPTOR, not the adapter — so a STUB satisfying only the presence check is sufficient
// and correct: one per distinct `adapterId` the catalog names, registered once, never credentialed,
// and its methods throw loudly if `resolve()`'s own behaviour ever changes to call one.
//
// A HOST'S OWN `deps.resolveEndpoint` ALWAYS WINS (both call sites check it first) — a production
// registry (live discovery, custom/disabled providers, real credentials) is what the daemon injects;
// this module is the floor under an uninjected default, not a replacement for one.
import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import { createEndpointResolver, createRegistry, endpointFromOrigin } from "@yanlinglabs/winter-provider-runtime";
import type { ContinuityEndpoint, MessageOrigin, ProviderAdapter, ProviderRegistry } from "@yanlinglabs/winter-provider-runtime";

/**
 * A `ProviderAdapter` that satisfies `ProviderRegistry.resolve()`'s presence check and nothing else.
 *
 * EVERY MEMBER THROWS. None is ever called by `resolve()` today (verified against the pinned
 * provider-runtime: capability/domain facts come from `descriptor`, not the adapter), and a throw is
 * the honest answer if that ever stops being true — silently returning a placeholder result would be
 * a second, quieter misclassification of exactly the kind this fix exists to close.
 */
function stubAdapter(adapterId: string): ProviderAdapter {
  const notCalled = (member: string) => (): never => {
    throw new Error(
      `winter-runtime-sdk: the default endpoint resolver's stub adapter "${adapterId}" had ${member} called — this adapter is registered ONLY to satisfy ProviderRegistry.resolve()'s presence check and must never be invoked (WS-18 W18-20 fix round 1)`,
    );
  };
  return {
    id: adapterId,
    version: "stub-for-endpoint-resolution-only",
    family: "custom",
    protocol: "custom",
    validateCredential: notCalled("validateCredential"),
    listModels: notCalled("listModels"),
    streamTurn: notCalled("streamTurn"),
    mapEffort: notCalled("mapEffort"),
    capabilities: notCalled("capabilities"),
  };
}

/** Builds a registry from the compiled catalog, with one never-invoked stub per distinct adapter id. */
function buildCatalogRegistry(): ProviderRegistry {
  const catalog = loadCatalog();
  const registry = createRegistry(catalog);
  const seen = new Set<string>();
  for (const provider of catalog.providers) {
    if (seen.has(provider.adapterId)) continue;
    seen.add(provider.adapterId);
    registry.register(stubAdapter(provider.adapterId));
  }
  return registry;
}

let cached: ((origin: MessageOrigin) => ContinuityEndpoint) | undefined;
let loggedFailureOnce = false;

/**
 * The router's DEFAULT `resolveEndpoint`, used at both call sites (`store/handoff-barrier.ts`'s
 * `computeSwitchReview`, `door.ts`'s Claude-ready wrap) whenever a host injects none.
 *
 * Built and memoised once per process. If the compiled catalog cannot be loaded at all (a packaging
 * defect, never expected in a normal install), this reports it ONCE — by name, never a payload — and
 * falls back to `endpointFromOrigin` rather than throwing: a broken endpoint resolver must never block
 * a model switch, only under-inform its loss review.
 */
export function defaultEndpointResolver(): (origin: MessageOrigin) => ContinuityEndpoint {
  if (cached !== undefined) return cached;
  try {
    const registry = buildCatalogRegistry();
    cached = createEndpointResolver(registry);
  } catch (error) {
    if (!loggedFailureOnce) {
      loggedFailureOnce = true;
      // NAMES ONLY, NEVER A PAYLOAD (WS-05 §13's global rule extends here): the message names what
      // failed and what a host should do about it, nothing about any session's content.
      // eslint-disable-next-line no-console
      console.warn(
        `winter-runtime-sdk: no catalog-backed endpoint resolver could be built (${error instanceof Error ? error.message : String(error)}) — every switch review falls back to the registry-free default, which reports readableState:"none" for every model and can OVER-warn on a lossless exposed-reasoning transfer. Inject HandoffBarrierDeps.resolveEndpoint / OfficialLegDeps.resolveEndpoint with a real catalog registry to fix this.`,
      );
    }
    cached = endpointFromOrigin;
  }
  return cached;
}

/** Test seam: forces the next call to rebuild (and, on failure, re-log once more). */
export function __resetDefaultEndpointResolverForTests(): void {
  cached = undefined;
  loggedFailureOnce = false;
}
