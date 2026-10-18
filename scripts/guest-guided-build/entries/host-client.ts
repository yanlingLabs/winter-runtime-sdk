// @ts-nocheck -- compile-only adapter. Its relative imports resolve only inside the staged guided packet
// (source/builder/... beside source/winter/...); the repository typecheck must not follow them.
/** Guided hostClient, COMPILE-ONLY adapter. It bundles the actual SDK `query` together with Winter Core's guidance
 * planner, resolver and structured-instruction mapper, so the packet carries their real bytes and import graph
 * (the fourth origin). It wires nothing: no ticket minting, no F2 issuer claim, no host RPC, no descriptor use.
 * The host client that does those things is a later, separately reviewed slice. If this executable is ever
 * started it refuses and does nothing else. */
import { query } from "@yanlinglabs/winter-agent-sdk";
import { CoworkCurrentContextPlanner } from "../../../../winter/packages/core/src/cowork/current-context.ts";
import { CoworkCurrentContextResolver } from "../../../../winter/packages/core/src/cowork/current-context-resolver.ts";
import { mapStructuredCoworkInstructions } from "../../../../winter/packages/core/src/cowork/structured-instruction-mapper.ts";

export const hostClientSurface = Object.freeze({ query, CoworkCurrentContextPlanner, CoworkCurrentContextResolver, mapStructuredCoworkInstructions });

if (import.meta.main) {
  void hostClientSurface;
  throw new Error("compile-only guided hostClient: no behaviour is admitted by this packet");
}
