// @ts-nocheck -- compile-only adapter. Its relative imports resolve only inside the staged guided packet
// (source/builder/... beside source/runtime/...); the repository typecheck must not follow them.
/** Guided providerWorker, COMPILE-ONLY adapter. It bundles the actual RuntimeSDK guided provider fixture
 * (scripts/guest-guided-provider/stub.ts) so the packet carries its real bytes and graph. It adds no listener,
 * socket, descriptor handling, credential or request counter: the Root runner that drives the fixture is a later,
 * separately reviewed slice. If this executable is ever started it refuses and does nothing else. */
import { createGuidedFixturePort, SELECTION, LIMITS } from "../../../../runtime/scripts/guest-guided-provider/stub.ts";

export const providerWorkerSurface = Object.freeze({ createGuidedFixturePort, SELECTION, LIMITS });

if (import.meta.main) {
  void providerWorkerSurface;
  throw new Error("compile-only guided providerWorker: no behaviour is admitted by this packet");
}
