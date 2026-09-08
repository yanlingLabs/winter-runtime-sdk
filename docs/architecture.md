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
| RuntimeDirectory + messaging router + adapters | `src/directory/**`, `src/messaging/**`, the in-memory store implementation in `src/seams/directory-store.ts` + `test/messaging/**` | Lane B |
| Store wiring + handoff barrier + materialized-resume doors | `src/store/**` (`wiring.ts`, `handoff-barrier.ts`, `materialized-resume.ts`, `temp-continuity.ts`) + `test/store/**` | Lane C |
| Selection + persisted choice + child-runtime rule + D29 probe + WS-17 rows | `src/selection/**`, `docs/probes/d29-advisor.md`, `test/selection/**`, `test/conformance/rows.test.ts` | Lane D |
| Close-out | `README.md`, `docs/conformance-rows.md`, the repo flip to public, the spec amendments | Task 6 |

**Shared files (`src/index.ts`, `src/seams/*.ts`, `package.json`) are spine-owned.** A lane that needs
a change there posts NEEDS_CONTEXT with the exact diff. Two edits are pre-authorised because the
spine scheduled them:

1. `src/seams/messaging-contract.ts` — its whole body becomes a re-export of
   `@yanlinglabs/winter-agent-sdk/messaging` once Task 0's subpath lands (Lane B's first commit).
2. The five wiring lines in `createRuntimeSdk` — each lane replaces one `stubX()` call with its real
   factory. `src/seams/stubs.ts` exists to make that diff a single line.

---

## Pinned interfaces

These are the signatures every lane builds against. They are in `src/`; this table is the index.

| Interface | File |
| --- | --- |
| `RuntimeSdkPeers`, `RuntimeSdkOptions`, `RuntimeSdk`, `RouterOptions`, `createRuntimeSdk` | `src/sdk.ts` |
| `SUPPORTED`, `SUPPORTED_PROTOCOL_VERSIONS`, `assertVersionMatrix`, `VersionMatrixReport` | `src/version-matrix.ts` |
| `RuntimeKind`, `RuntimeSelection`, `SelectionInput`, `SelectionRefusal`, `selectRuntime`, `selectChildRuntime` | `src/selection/runtime-selection.ts` |
| `RuntimeDirectoryStore`, `RuntimeDirectoryEntry`, `CursorStore`, `MailboxStore`, `createInMemoryRuntimeDirectoryStore` | `src/seams/directory-store.ts` |
| `OfficialAdapter`, `OfficialLaunchPlan`, `OfficialResumePlan`, `OfficialSession`, `OptionsTemplateInput`, `EnvInput` | `src/seams/official-adapter.ts` |
| `HandoffBarrier`, `HandoffPlan`, `HandoffOutcome` | `src/seams/handoff.ts` |
| `MaterializedResumeDecorator` and its probe report | `src/seams/materialized-resume.ts` |
| `KeychainSeam` | `src/seams/keychain.ts` |
| `RuntimeDirectory`, `GlobalMessaging` | `src/seams/directory.ts`, `src/seams/global-messaging.ts` |
| `RuntimeAddress`, `ListedRuntimeObject`, `DeliveryOutcome`, `GlobalAgentMessage`, `RuntimeMessagingAdapter` | `src/seams/messaging-contract.ts` (temporary — see above) |

### Three places the plan's pinned text had to change, and why

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
