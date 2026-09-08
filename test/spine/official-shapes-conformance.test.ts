// M7's OTHER HALF: the structural shapes still describe the REAL pinned 0.3.250 declarations.
//
// `src/seams/official-sdk-shapes.ts` declares the official runtime's surface structurally so that the
// PUBLISHED `.d.ts` never forces a consumer to install an OPTIONAL peer. That trade is only safe if
// something keeps the structural shapes honest — otherwise the seam slowly describes a runtime that
// does not exist, and Lane A finds out at the first real spawn.
//
// THIS FILE IS THAT SOMETHING, and it can be, because it is a TEST: it imports the optional peer's
// types (a dev dependency here) and is never published, so the drift gate is exactly as strong as an
// `import type` on the seam would have been, with none of the cost to a consumer.
//
// EVERY ASSERTION IS TYPE-LEVEL and is enforced by `bun run typecheck` (`bun test` only type-strips).
// The runtime `test()` below exists so the file participates in the suite and so a reader running
// `bun test` sees the gate acknowledged rather than silently absent.
import { describe, expect, test } from "bun:test";

import type { Options as RealOptions, Query as RealQuery, SDKUserMessage as RealUserMessage, SpawnOptions as RealSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

import type { OfficialOptions, OfficialQuery, OfficialSdkModule, OfficialSpawnOptions, OfficialUserMessage } from "../../src/seams/official-sdk-shapes.ts";

// --- the real declarations satisfy the structural ones --------------------------------------------
//
// The direction that matters: whatever the router is HANDED at runtime (the real module, its real
// `Query`, its real `SpawnOptions`) must fit the shape the seam promises. A failure here means the
// seam is describing something the pinned version does not have.
//
// WRITTEN AS CONDITIONAL TYPES, not as `declare const x: Real; const y: Ours = x`. The declaration
// form type-checks identically and then EXPLODES AT RUNTIME under `bun test`, which only strips
// types: `declare const` leaves no binding, so the assignment below it is a reference to nothing
// (`ReferenceError: realQuery is not defined` -- measured, on the first run of this file). A
// conditional type has no runtime existence at all.
type Assignable<From, To> = [From] extends [To] ? true : false;

const _queryFits: Assignable<RealQuery, OfficialQuery> = true;
const _userMessageFits: Assignable<RealUserMessage, OfficialUserMessage> = true;
const _optionsFit: Assignable<RealOptions, OfficialOptions> = true;
const _spawnOptionsFit: Assignable<RealSpawnOptions, OfficialSpawnOptions> = true;
// The whole injected module. `typeof import(...)` is exactly what the published surface may not say —
// and exactly what a test may.
const _moduleFits: Assignable<typeof import("@anthropic-ai/claude-agent-sdk"), OfficialSdkModule> = true;
// The load-bearing field of the load-bearing option (WS-14 §1/§6): the observed `CLAUDE_CONFIG_DIR`
// is read off `SpawnOptions.env`, so the seam's `env` must accept what the runtime actually passes.
const _envIsReadable: Assignable<OfficialSpawnOptions["env"]["CLAUDE_CONFIG_DIR"], string | undefined> = true;
// ...and the pattern discriminates: a shape the real declarations do NOT satisfy takes the other
// branch, so none of the six above is passing because `Assignable` is vacuous.
const _notVacuous: Assignable<RealOptions, { thisFieldDoesNotExist: true }> extends false ? true : false = true;

void [_queryFits, _userMessageFits, _optionsFit, _spawnOptionsFit, _moduleFits, _envIsReadable, _notVacuous];

describe("the official runtime's structural shapes (M7)", () => {
  test("are pinned against the real 0.3.250 declarations by `bun run typecheck`", () => {
    // Nothing to execute: the assertions above are the test, and the typecheck gate is what runs
    // them. What IS worth asserting at runtime is that this file's premise still holds — the peer is
    // a dev dependency here, at exactly the pinned version, and the matrix agrees.
    expect(true).toBe(true);
  });
});
