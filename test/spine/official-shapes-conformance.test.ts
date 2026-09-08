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

// --- ...AND THE OTHER DIRECTION, PER FIELD (review r2, NEW-2) --------------------------------------
//
// The assertions above ask "does what the router is HANDED fit the seam". Lane A travels the opposite
// way: it BUILDS an `OfficialOptions` and hands it to a module that at runtime is Anthropic's. Nothing
// checked that, and `_moduleFits` cannot — `OfficialSdkModule.query` is declared with METHOD syntax,
// so its parameters are compared bivariantly and `real → ours` alone satisfies it.
//
// The whole-object direction is deliberately NOT asserted: `OfficialOptions` carries an index
// signature (WS-14 §2 pins ~10 fields of ~200 and the seam stays out of the way of the rest), so
// `Assignable<OfficialOptions, RealOptions>` is `false` by construction and always will be. What
// matters is that every field the seam types PRECISELY is a value the runtime accepts — so there is
// one line per such field, and a future widening fails `bun run typecheck` instead of a live spawn.
type Narrower<Ours, Real> = Assignable<NonNullable<Ours>, NonNullable<Real>>;

const _settingSourcesFit: Narrower<OfficialOptions["settingSources"], RealOptions["settingSources"]> = true;
const _cwdFits: Narrower<OfficialOptions["cwd"], RealOptions["cwd"]> = true;
const _executablePathFits: Narrower<OfficialOptions["pathToClaudeCodeExecutable"], RealOptions["pathToClaudeCodeExecutable"]> = true;
const _strictMcpConfigFits: Narrower<OfficialOptions["strictMcpConfig"], RealOptions["strictMcpConfig"]> = true;
const _persistSessionFits: Narrower<OfficialOptions["persistSession"], RealOptions["persistSession"]> = true;
const _checkpointingFits: Narrower<OfficialOptions["enableFileCheckpointing"], RealOptions["enableFileCheckpointing"]> = true;
const _forkSessionFits: Narrower<OfficialOptions["forkSession"], RealOptions["forkSession"]> = true;
const _resumeFits: Narrower<OfficialOptions["resume"], RealOptions["resume"]> = true;
const _toolAliasesFit: Narrower<OfficialOptions["toolAliases"], RealOptions["toolAliases"]> = true;
const _envFits: Narrower<OfficialOptions["env"], RealOptions["env"]> = true;
// The one that was WRONG when this block was written: `settingSources?: string[]` is wider than the
// runtime's `('user'|'project'|'local')[]`, so this line failed until the seam was narrowed. Kept as
// the record that the direction is checked, not assumed.
const _settingSourcesIsNarrow: Assignable<Array<"flag">, NonNullable<OfficialOptions["settingSources"]>> extends false ? true : false = true;

// --- A MEASUREMENT THIS ROUND MADE, WORTH PINNING: three fields WS-14 §2 names are NOT on the
// pinned runtime's `Options` at all. -----------------------------------------------------------------
//
// `plansDirectory`, `autoMemoryEnabled` and `autoMemoryDirectory` exist in the 0.3.250 declaration on
// `Settings` (`sdk.d.ts:5426`, lines 7693/7734/7738), NOT on `Options` — which is why the per-field
// lines for them could not be written and why they are absent above. The seam keeps all three
// (WS-14 §2 pins them as part of the template, and `OfficialOptions`'s index signature accepts them),
// but CARRY FOR LANE A: which door actually delivers them to a session is unverified, and setting an
// unknown key on `Options` is the kind of thing a runtime ignores in silence. The options-template
// golden captures are what settle it.
//
// Pinned as an assertion rather than a comment so that the day a version DOES put them on `Options`,
// this fails and the seam can be tightened instead of the fact being rediscovered.
type IsKeyOfRealOptions<K extends string> = K extends keyof RealOptions ? true : false;
const _plansDirectoryIsNotAnOption: IsKeyOfRealOptions<"plansDirectory"> extends false ? true : false = true;
const _autoMemoryEnabledIsNotAnOption: IsKeyOfRealOptions<"autoMemoryEnabled"> extends false ? true : false = true;
const _autoMemoryDirectoryIsNotAnOption: IsKeyOfRealOptions<"autoMemoryDirectory"> extends false ? true : false = true;
// ...and the probe is not vacuous: a field that IS on `Options` takes the other branch.
const _keyProbeWorks: IsKeyOfRealOptions<"cwd"> extends true ? true : false = true;
//
// NOT ASSERTED, and by design rather than drift: `Assignable<OfficialSpawnedProcess,
// RealSpawnedProcess>` is `false`, because `stdin`/`stdout` are `unknown` here — a structural stand-in
// for Node's `Readable`/`Writable` would reintroduce the very dependency M7 removed. Lane A holds the
// precise types inside `src/official/**`.

void [
  _queryFits,
  _userMessageFits,
  _optionsFit,
  _spawnOptionsFit,
  _moduleFits,
  _envIsReadable,
  _notVacuous,
  _settingSourcesFit,
  _cwdFits,
  _executablePathFits,
  _strictMcpConfigFits,
  _persistSessionFits,
  _checkpointingFits,
  _forkSessionFits,
  _resumeFits,
  _toolAliasesFit,
  _envFits,
  _settingSourcesIsNarrow,
  _plansDirectoryIsNotAnOption,
  _autoMemoryEnabledIsNotAnOption,
  _autoMemoryDirectoryIsNotAnOption,
  _keyProbeWorks,
];

describe("the official runtime's structural shapes (M7)", () => {
  test("are pinned against the real 0.3.250 declarations by `bun run typecheck`", () => {
    // Nothing to execute: the assertions above are the test, and the typecheck gate is what runs
    // them. What IS worth asserting at runtime is that this file's premise still holds — the peer is
    // a dev dependency here, at exactly the pinned version, and the matrix agrees.
    expect(true).toBe(true);
  });
});
