// R.3 touch 3 add-on: THE DEFAULT RESOLVER'S MEMO MUST NEVER HAND ONE CALLER'S ORIGIN TO ANOTHER.
//
// `defaultEndpointResolver()` is memoised once per process, and provider-runtime's
// `createEndpointResolver` caches each answer by `origin.modelKey` ALONE while the answer echoes the
// caller's `family` (and, on a registry miss, the caller's whole origin). So the first review of a
// model key decided the family every later review of that key saw — measured in the full router run:
// the same-view switch scenario resolved `anthropic/claude-sonnet-5` with the Winter runtime's origin
// family `"anthropic"`, and the store's Sonnet -> Opus review later in the same process read Sonnet as
// `"anthropic"` beside Opus's `"claude"`: not same-family, a spurious lossy prompt.
import { expect, test } from "bun:test";

import { defaultEndpointResolver } from "../../src/default-endpoint-resolver.ts";

test("the same model key resolved under two families answers each caller with its OWN family (a catalog hit)", () => {
  const resolve = defaultEndpointResolver();
  const modelKey = "anthropic/claude-sonnet-5";
  const asProvider = resolve({ providerId: "anthropic", modelKey, family: "anthropic" });
  const asModelFamily = resolve({ providerId: "anthropic", modelKey, family: "claude" });
  expect([asProvider.family, asModelFamily.family]).toEqual(["anthropic", "claude"]);
  // The catalog facts themselves are the same for both.
  expect({ ...asProvider, family: "x" }).toEqual({ ...asModelFamily, family: "x" });
});

test("a registry MISS echoes the caller's own origin, never an earlier caller's", () => {
  const resolve = defaultEndpointResolver();
  const modelKey = "touch3-miss/not-a-catalog-model";
  const first = resolve({ providerId: "p-one", modelKey, family: "f-one", continuationDomain: "d-one" });
  const second = resolve({ providerId: "p-two", modelKey, family: "f-two", continuationDomain: "d-two" });
  expect([first.providerId, first.family, first.continuationDomain]).toEqual(["p-one", "f-one", "d-one"]);
  expect([second.providerId, second.family, second.continuationDomain]).toEqual(["p-two", "f-two", "d-two"]);
});
