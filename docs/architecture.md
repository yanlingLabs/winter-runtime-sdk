# Architecture — `@yanlinglabs/winter-runtime-sdk`

One door over two agent runtimes: the Winter Agent SDK and the official Claude Agent SDK. **A
selector and an adapter, never a translation layer** — the pinned `query()` / `Options` /
`SDKMessage` contract passes through verbatim, plus runtime-selection inputs.

Decision record: WS-00 §2 D19 (a/b/c) + D19a. This document is the working map for Phase 7b: what the
package owns, who owns which files, and the interfaces the four lanes build behind.

---

## What this package owns (D19b)

- **Runtime selection and its persisted choice** (D13/D28, WS-13 §9, WS-13c §6). The runtime is
  decided at session creation and persisted; a family or runtime change mid-session is the certified
  handoff or a visible fork, **never a silent rewrite**.
- **The official-SDK adapter** (WS-14 §1–§15): launch profiles and the `CLAUDE_CONFIG_DIR` spool, the
  `Options` template, the allowlist child environment, the shared session-store wiring and
  `mirror_error`, the supervised spawn proxy, tool aliases and the deny floor, builtin-path
  containment, the Winter MCP server registration, per-branch auth, and the error taxonomy.
- **The shared store wiring, the handoff barrier and the materialized-resume doors** (WS-05 §6/§12,
  WS-13 §8.2). The router owns the *mechanics* and Claude-leg injection; switch UX and confirmations
  stay with the host (R-7b-3, Phase 8).
- **The runtime directory and the cross-runtime messaging router** (WS-15 §6.1–6.4, WS-10 §10–§15),
  composed from `@yanlinglabs/winter-agent-sdk/messaging` (R-7b-4) with one adapter per runtime.

## What it does not own

- The Winter SDK stands alone for Winter-only hosts and never learns this package or the official
  runtime exists.
- Product concerns stay with the harness (D19 clause c): the SDK-message→SessionEvent projector, the
  approval/question broker bridges, product session records and migrations, launchd/Sparkle, and the
  CLI/app/iOS touchpoints.
- **Persistence.** The router never opens the host's `runtime-state.db` (R-7b-2). It defines
  `RuntimeDirectoryStore` and receives an implementation; an in-memory default ships for tests and
  for hosts with no durable state.
- **Credentials.** The router never opens a keychain. It asks the host's `KeychainSeam` at spawn and
  keeps nothing (WS-14 §12).

---

## Ownership map (lanes edit disjoint files; the spine pins the seams)

| Area | Files | Owner |
| --- | --- | --- |
| Scaffold, CI, release, contract re-export, constructor + version matrix, seams (interfaces + stubs), test harness wiring | `package.json`, `tsconfig*.json`, `.github/workflows/*`, `scripts/**`, `src/index.ts`, `src/sdk.ts`, `src/version-matrix.ts`, `src/errors.ts`, `src/seams/**`, `src/testing/**` | Task 1 (spine) |
| Official adapter | `src/official/**` (`options-template.ts`, `env-allowlist.ts`, `spool.ts`, `spawn-proxy.ts`, `containment.ts`, `aliases.ts`, `supervision.ts`, `callbacks.ts`, `mcp-descriptors.ts`, `auth.ts`, `errors.ts`, `adapter.ts`) + `test/official/**` | Lane A |
| RuntimeDirectory + messaging router + adapters | `src/directory/**`, `src/messaging/**` + `test/messaging/**` | Lane B |
| Store wiring + handoff barrier + materialized-resume doors | `src/store/**` (`wiring.ts`, `handoff-barrier.ts`, `materialized-resume.ts`, `temp-continuity.ts`) + `test/store/**` | Lane C |
| Selection + persisted choice + child-runtime rule + D29 probe + WS-17 rows | `src/selection/**`, `docs/probes/d29-advisor.md`, `test/selection/**`, `test/conformance/rows.test.ts` | Lane D |
| Close-out | `README.md`, `docs/conformance-rows.md`, the repo flip to public, the spec amendments | Task 6 |

> **The in-memory `RuntimeDirectoryStore` is SPINE-owned and already complete** (`src/seams/directory-store.ts`). The plan's ownership map listed it under Lane B; it shipped with the spine instead, because it is the default store and every hermetic test's store. Lane B implements the DIRECTORY and the MESSAGING ROUTER over it — not the store.

**Shared files (`src/index.ts`, `src/seams/*.ts`, `package.json`) are spine-owned.** A lane that needs
a change there posts NEEDS_CONTEXT with the exact diff. Two edits were pre-authorised because the
spine scheduled them, and **both have landed**:

1. `src/seams/messaging-contract.ts` **IS** a re-export of `@yanlinglabs/winter-agent-sdk/messaging`
   (Lane B's first commit). One deliberate duplicate survives it — `RuntimeKind`, declared in
   `src/selection/runtime-selection.ts` and character-identical to the subpath's — and it is
   documented at the site.
2. The five wiring lines in `createRuntimeSdk` **are** the real factories; `src/seams/stubs.ts`
   survives for the seams tests, which is what it is now for.

**Two modules belong to NO lane** (fix wave, review r4 N13): `src/vendor-paths.ts` — the vendor's
`claude-resume-<uuid>` staging-root vocabulary, shared by the official adapter (which recognises one)
and the store lane (which stages one) — and `src/native-args.ts` — WS-10 §10.1/§10.2's model-facing
schemas and their acceptors, shared by the official branch's alias targets and the Winter branch's
canonical handler. Both were written TWICE, in parallel trees, with mirrored argument orders and
already-drifted validation. Each now has one definition, is exported once from the package barrel and
by no lane barrel, and `test/spine/barrel-exports.test.ts` fails if a name is ever exported by two
lane barrels again.

**`test/joint/` belongs to no lane either.** It is the bed where one real pinned runtime drives Lane
B's real router: every lane had proven its own half against a DOUBLE of its neighbour, which is
exactly where a schema mismatch or a caller-identity mistake survives four reviews. WS-17 rows 1, 2,
4 and 5 are proven there.

---

## Pinned interfaces

These are the signatures every lane builds against. They are in `src/`; this table is the index.

| Interface | File |
| --- | --- |
| `RuntimeSdkPeers`, `RuntimeSdkOptions`, `RuntimeSdk`, `RouterOptions`, `RouterRuntimeInput`, `createRuntimeSdk` | `src/sdk.ts` |
| `RouterOfficialInput`, `RouterQuery`, `isOfficialQuery`, `OfficialInputStream`, `officialCredentialPlan` — the door's official leg | `src/door.ts` |
| `MATERIALIZED_RESUME_PROBE_REPORTS`, `materializedResumeReportForPin` — R-7b-12's per-pin verdict | `src/store/pinned-probes.ts` |
| `SUPPORTED`, `SUPPORTED_PROTOCOL_VERSIONS`, `assertVersionMatrix`, `VersionMatrixReport` | `src/version-matrix.ts` |
| `RuntimeKind`, `RuntimeSelection`, `SelectionInput`, `SelectionRefusal`, `selectRuntime`, `selectChildRuntime` | `src/selection/runtime-selection.ts` |
| `RuntimeDirectoryStore`, `RuntimeDirectoryEntry`, `RuntimeTransport`, `CursorStore`, `MailboxStore`, `DeliveryRecordStore`, `IdleSubscriptionStore`, `NameLeaseStore`, `createInMemoryRuntimeDirectoryStore` | `src/seams/directory-store.ts` |
| `SeamContext`, `SeamContextWithDirectory` (what every seam factory is handed) | `src/seams/context.ts` |
| `OfficialSdkModule`, `OfficialOptions`, `OfficialQuery`, `OfficialUserMessage`, `OfficialSpawnOptions`, `OfficialSpawnedProcess`, `OfficialSpawnClaudeCodeProcess` | `src/seams/official-sdk-shapes.ts` |
| `OfficialAdapter`, `OfficialLaunchPlan`, `OfficialResumePlan`, `OfficialSession`, `OptionsTemplateInput`, `EnvInput` | `src/seams/official-adapter.ts` |
| `HandoffBarrier`, `HandoffPlan`, `HandoffOutcome` | `src/seams/handoff.ts` |
| `MaterializedResumeDecorator` and its probe report | `src/seams/materialized-resume.ts` |
| `KeychainSeam` | `src/seams/keychain.ts` |
| `RuntimeDirectory`, `GlobalMessaging` | `src/seams/directory.ts`, `src/seams/global-messaging.ts` |
| `RuntimeAddress`, `ListedRuntimeObject`, `DeliveryOutcome`, `GlobalAgentMessage`, `RuntimeMessagingAdapter` | `src/seams/messaging-contract.ts` — a re-export of the SDK's `messaging` subpath; no second definition of any contract type |

### Five places the plan's pinned text had to change, and why

Each is documented at the site as well; they are collected here so a reviewer sees them together.

1. **`query()` takes ONE params object, not two positional arguments.** The plan writes
   `query(prompt, options?)`. Both SDKs take a single object — the Winter SDK's
   `query(args: { prompt; options }): Query` and the official SDK's `query(_params: { prompt;
   options? }): Query`. A router whose door had a different arity than the two doors it wraps would be
   a translation layer in exactly the place the architecture forbids one, and every host would have to
   rewrite its call site to adopt it.
2. **The streaming prompt is `AsyncIterable<string>`, not `AsyncIterable<SDKUserMessage>`.** The plan
   names the *official* SDK's type. The Winter SDK — the required peer this door forwards to — takes
   `string | AsyncIterable<string>` and exports no `SDKUserMessage` at all, so the pinned type would
   make the door untypeable. Mapping onto the official branch's message-shaped prompt is Lane A's
   adapter concern; `OfficialLaunchPlan.prompt` already carries the official shape.
3. **`OfficialAdapter.spawnProxy` has the OFFICIAL hook's shape.** The plan types it as the Winter
   SDK's exported `SpawnClaudeCodeProcess`. The two are not structurally compatible — Winter's yields
   `stdout: AsyncIterable<string>` and an `exited` promise, the official one `stdout: Readable` with
   `on('exit')` — and this proxy is handed to the official SDK (WS-14 §6 is the Claude branch's own
   spec). The Winter name still reaches a consumer unchanged through the contract re-export.
4. **`RuntimeSdkPeers.claude` is a structural `OfficialSdkModule`, not `typeof import("@anthropic-ai/
   claude-agent-sdk")`** (fix round 1, review M7). A `typeof import(…)` in a published `.d.ts` makes
   every consumer's type-checker resolve that module — so a Winter-only host that correctly did not
   install an OPTIONAL peer saw `Cannot find module` coming out of this package. Every shape the
   published surface needs is now declared structurally in `src/seams/official-sdk-shapes.ts`;
   fidelity moved into `test/spine/official-shapes-conformance.test.ts`, which asserts the REAL
   0.3.250 declarations satisfy each one (it caught two mismatches the day it landed: `interrupt()`
   resolves a response rather than `void`, and `Options.env` values are `string | undefined`). Two
   gates keep it that way: `release-pack.ts` scan rule 7 walks the declaration graph reachable from
   the package's `types` entry and fails the pack if the peer is named there, and the installed smoke
   type-checks a probe project that does NOT have the peer installed, with `skipLibCheck: false`.

   **The rule for Lane A:** `src/official/**` MAY `import type` from the optional peer for its own
   internals — those declarations are emitted but unreachable from `dist/index.d.ts`, so no consumer
   loads them. What must not happen is one of those types reaching an exported member of
   `src/index.ts`. Rule 7 is the enforcement, not the convention.
5. **`query()` returns `Query` OR the official SDK's own `Query`, and is overloaded to say which**
   (Task 6b). The plan writes `query(...): Query`. Once the door actually serves both runtimes, that
   signature has only two possible readings and both are wrong: return a FACADE that translates the
   official handle into the Winter one — the single thing D19b says this package must never be — or
   declare a type that lies about a handle missing `messaging` and `listModelFamilies`. So the door
   returns `RouterQuery = Query | OfficialQuery`, and the two overloads make the split cost a host
   nothing it did not ask for: the official leg is reachable ONLY through `options.runtime`, so a call
   without one is typed `Query` exactly as before, and a call with one is typed as the union.
   `isOfficialQuery()` narrows it by registry rather than by structural sniffing.

---

## The door (Task 6b)

`RuntimeSdk.query()` routes by the decided `RuntimeSelection`. The Winter leg is a pass-through: the
caller's own `options` object is forwarded by reference when there is no router-owned key to remove,
and the prompt is never drained on the way past. The official leg is a COMPOSITION of the four lanes,
and it lives in `src/door.ts` so that `src/sdk.ts` keeps one line per leg.

| What the leg does | Whose code |
| --- | --- |
| decide (persisted wins; a change is `handoff-required`) | Lane D, `src/selection/**` |
| the Options template, the child env allowlist, the spool profile, the supervised launch | Lane A, `src/official/**` |
| the one shared session store (and the winter home the spool hangs off) | Lane C, `src/store/**` |
| the directory row (identity + persisted selection) and the messaging attachment | Lane B, `src/directory/**`, `src/messaging/**` |

Four decisions the composition forced, each with its reasoning at the site:

1. **The launch is deferred to the FIRST PULL.** WS-14 §12's "credentials are fetched at spawn" is a
   `KeychainSeam.read`, which returns a promise, while `query()` returns a `Query` rather than a
   promise for one. Deferring is also the vendor's own semantics — the pinned runtime spawns lazily
   too — so a session that is never iterated has never started under either design.
2. **The handle forwards every member of the vendor's `Query`,** by trap rather than by a facade that
   would have to name them (this package never puts the vendor's types on its published surface).
   `then`/`catch`/`finally` are never forwarded, because a thenable handle would be swallowed by any
   `await`; `close()` is synchronous and cancels an unstarted launch.
3. **The prompt IS the session's input stream** (R-7b-4). An `AsyncIterable<string>` prompt is pumped
   into a stream the door owns, with the caller's backpressure preserved, and the messaging registry's
   pushes interleave into the same stream — so the session is attached as a live receiver. A STRING
   prompt has no stream (the vendor runs one turn and exits), so that session is recorded but not
   attached, and delivery to it is `unavailable` rather than a push into nothing.
4. **Credentials come from `Options.provider`,** the pinned contract's own credential surface, which a
   host already fills for the Winter leg. Only families whose variable mapping is unambiguous are
   derived (`api-key`, `console-oauth`, and the two that inject nothing); a cloud credential chain and
   the open `custom` family name their own variables, because only the host knows them.

R-7b-1's cross-runtime CHILD is the same leg with `runtime.official.parentSessionId`: the row is an
`agent:<parent>:<child>` address with `transport: "claude-handle"` — a session in its own right rather
than a native subagent of an official parent (`claude-child`), which is the field Lane B's adapter
branches on.

---

## The contract re-export

`src/index.ts` re-exports the Winter SDK's **entire** public surface with `export *`, then adds the
router's own names. The constraint is "loses no member and gains nothing the Winter SDK does not
already export"; a hand-written list of 231 names would satisfy that on the day it was written and
be one SDK release away from being silently wrong. `test/spine/contract-reexport.test.ts` compares the
two namespaces object by object — every SDK export is present here, under the same name, and is the
same object — which is also what catches a local name shadowing an SDK export.

`src/testing/**` is **not** a published subpath: it reaches dev dependencies a consumer never
installs. Tests import it by relative path.

---

## Consuming the Winter SDK (the temporary shape)

Until the SDK repository's first publish (R-7b-5, a user gate), the three `@yanlinglabs/*`
dependencies are `link:` onto a **sibling checkout**:

```
<parent>/winter-runtime-sdk     <- this repository
<parent>/winter-agent-sdk       <- the SDK repository, checked out beside it
```

`pnpm install` then symlinks `packages/sdk`, `packages/conformance` and `packages/provider-conformance`
into `node_modules/@yanlinglabs/`, and `tsconfig.base.json`'s `paths` point the type-checker at their
`src`.

**`link:` and not `file:`, measured.** pnpm's `file:` on a workspace package tries to install that
package's own dependencies, and the SDK's are `workspace:*`, which cannot resolve outside its
workspace: `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND … "@yanlinglabs/winter-provider-catalog@workspace:*" is
in the dependencies but no package named … is present in the workspace`. `link:` is the pure symlink
the design intends.

**One build in the sibling checkout is required before `bun run build:packages` here.**
`tsconfig.build.json` sets `paths: {}` (it must — files outside `rootDir` break a declaration emit),
so `tsc` resolves the peer through node_modules to its `types` condition, i.e. to its `dist`, which is
gitignored there. `scripts/build-packages.ts` refuses with that instruction rather than failing inside
tsc. CI does it explicitly.

**At the close-out** the three `link:` dependencies become `^0.0.2` from the registries, the second
checkout disappears from both workflows, and the smoke installs the peer instead of symlinking it.

---

## The brand (I2)

`createRuntimeSdk` resolves the brand exactly once, through the **injected** peer's own `resolveBrand`
(so a host that vendored its own copy of the Winter SDK gets its validation and its
`InvalidBrandError`), and exposes the result as `RuntimeSdk.brand: BrandProfile`. Precedence, in one
sentence: **a per-query `Options.brand` wins on the Winter leg and is never rewritten; the constructor
profile fills in when a query supplies none; Winter's own defaults fill in when neither does.** With
no constructor brand the forwarded options object is still the caller's own, by reference — the
resolved default *is* Winter's default, so injecting it would change nothing but identity.

Both branches read the same resolved profile: the Winter leg through the forwarded `Options.brand`,
the official branch through `SeamContext.brand`, which is what `OptionsTemplateInput.brand` and
`EnvInput.brand` are populated from. No lane spells a Winter-owned name; the brand gate forbids it.

---

## The seam context (what a lane's factory receives)

Every seam factory takes ONE object (`src/seams/context.ts`): the injected `peers`, the host's
`keychain`, the resolved `brand`, the `directoryStore`, the optional `vendoredOfficialRuntime`, the
optional `winterHome`, and — for everything except the directory itself — the `directory`, which is
built first and hoisted out of the handle's object literal. A lane's wiring diff in `src/sdk.ts` was
therefore one line (`stubX(context)` → `createX(context)`).

**Wired for construction is not wired for configuration** (whole-branch review, F-3). Calling every
factory was the spine's promise and it was kept — but the factories' OPTIONS had no field on
`RuntimeSdkOptions`, and the consequences were not cosmetic: with no `participants` the barrier marks
step 8 "no destination runtime was supplied", so `sdk.handoff()` could never return `resumed`; with no
`official.permissionClass` an official receiver's class can never be known, and since D2 an unknown
class fails closed, so every message to every official session was HELD. `RuntimeSdkOptions.handoff`
and `RuntimeSdkOptions.messaging` are those doors, threaded verbatim into the two factory calls;
`SeamContext.winterHome` is fed from `handoff.winterHome`, so the context and the barrier cannot
resolve two different homes.

---

## Version matrix (D19a)

`createRuntimeSdk` asserts the matrix before it builds anything and refuses loudly with
`RuntimeSdkVersionError { expected, actual }`.

- `SUPPORTED.winterAgentSdk` is a **range** (`>=0.0.2 <0.1.0`) — the Winter SDK is this repository's
  sibling and moves with it.
- `SUPPORTED.claudeAgentSdk` is an **exact pin** (`0.3.250`) — WS-02 §6.1: declaration identity alone
  must not approve an upgrade; a new official version is a reviewed compatibility event.
- The Winter peer's `PROTOCOL_VERSION` is checked against `SUPPORTED_PROTOCOL_VERSIONS` — the second,
  independent identity (WS-02 §3's `sdkVersion` vs `engineVersion` distinction).
- **An absent official peer is allowed**: a Winter-only host is a supported configuration, and that is
  what the optional peer is for.

A peer's package version is read from an exported version identity first (`SDK_VERSION` / `VERSION` /
`PACKAGE_VERSION` / `version`), then from the resolvable installed manifest, and otherwise refused —
"I could not tell" and "it is fine" are different answers. **Carry:** neither peer exports a version
identity today, so the second probe is the live path; the Winter SDK exporting one at `0.0.2` would
make the assertion describe the *injected instance* rather than the resolvable copy.

---

## Hermeticity rules for every test in this repository

- Never `~/.winter`, `~/.norma`, `~/.claude`, or the Keychain. `src/testing/hermetic.ts` provides the
  `mkdtemp` homes and the in-memory `KeychainSeam`; `officialCaptureEnv` builds the four-variable
  replacement environment (including a throwaway `HOME`, because `os.homedir()` otherwise falls back
  to the OS user database regardless of `CLAUDE_CONFIG_DIR`).
- Loopback fakes bind `127.0.0.1:0` and close in a `finally` — use `withLoopbackFake`.
- The official SDK is driven only through the loopback capture (R-7b-6), never a real endpoint. The
  capture itself (`runOfficialCapture`) is network-bound and gated: `bun test` never calls it.
- `bun test` runs the whole suite alone; no test needs a flag, a secret, or a network.
