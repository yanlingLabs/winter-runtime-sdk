# Guided packet builder (compile only, never triggered)

This directory builds the **guided** compile packet: four compiled roles and six native artifacts, from four
pinned source origins. It is the source for ONE owner-approved compile-fixture run. It has not been run on a
runner, and the workflow that would run it has never been triggered.

```
python3 -I -S -B scripts/guest-guided-build/test_guided_build.py     # portable data tests; no compiler, no output runs
bun test test/gates/guided-packet-compile-gates.test.ts              # the workflow gates and their mutation table
```

## Why a sibling of `scripts/guest-reader-build/`

That README says the reader builder is "not a whole guided four-role packet", and its sources, pins and
workflows are an accepted evidence chain (compile run 38715669708, `compile-38715669708.pin.json`, the reviewed
native workflow, the frozen hosted workflow). Editing it would move those hashes. This builder therefore lives
beside it, loads two of its modules by path (`build.py`, `provenance.py`: bounded readers, the Bun ELF layout
decoder, the compiler parser checks) and changes neither. The bytes of both are observed at load time and must
equal the bytes captured with the builder origin.

## Roles and artifacts (ten ELF bodies)

| Compiled role | Entry | Notes |
| --- | --- | --- |
| `runtimeEntry` | agent-sdk `packages/runtime/src/guest/linux-guided-host-query-main.ts` | The guided native-owner entry. Reaches the MCP client closure, `ajv` and `ignore`. |
| `providerWorker` | `entries/provider-worker.ts` (this directory) | Compile-only adapter around runtime-sdk `scripts/guest-guided-provider/stub.ts`. Refuses if started. |
| `hostClient` | `entries/host-client.ts` (this directory) | Compile-only adapter: the SDK `query` plus Winter Core's planner, resolver and structured-instruction mapper. Refuses if started. |
| `instructionReader` | runtime-sdk `src/guest/instruction-reader-entry.ts` | Same recipe as the accepted reader packet (asserted equal in the tests). |

| Native artifact | Source (agent-sdk `packages/runtime/src/guest/`) | Flags |
| --- | --- | --- |
| `toolLauncher` | `linux-tool-compartment.c` | `-std=c11 -O2 -Wall -Wextra -Werror -static` |
| `runtimeLauncher` | `linux-runtime-compartment.c` | same |
| `fileWorker` | `file-worker.c` | same |
| `processWorker` | `process-worker.c` | same |
| `ownerLibrary` | `linux-session-owner.c` | `... -shared -fPIC` |
| `instructionReaderLauncher` | `linux-instruction-reader-compartment.c` | the reader packet's hardened dynamic flags |

**Placeholders.** The `providerWorker` and `hostClient` outputs are placeholders: compile-only adapters that refuse if
started. Their hashes are NOT final. They change when the real host client and the provider runner replace the
adapters, and the hosted-run slice must not bind to them.

The two entry adapters are new reviewed source and are the only authored TypeScript here. They exist so the
packet carries the real bytes and import graph of the stub and of Core's planner/resolver/mapper; they add no
behaviour. `scripts/guest-host-query/host-client.ts` does not import Core, so it cannot be relabelled as this role.

## Pins

All pins live in `guided-compile-inputs.pin.json`; `pins.py` loads it, the workflow mirrors it in one `env:`
block, and both test files fail when any copy drifts.

| Pin | Value | Moves when |
| --- | --- | --- |
| agent-sdk head | `68e57c646f23feba09b00c78d05d8c80d6f2962d` (main, compartment C applied by PR 34, Root reader service by PR 35) | a later agent-sdk change; see below |
| runtime-sdk head | `29eede4b3e085044f5ed6bc6cf99e8f6c4daf6a1` (main, includes the guided provider stub and the reader entry) | never for this run |
| Winter Core head | `8b52ef83d1ba721a4dd80cdbb205c617f8656555` on `cowork/output-integration` (an exact commit, never the branch name) | Core's cowork sources change |
| Bun | 1.3.14, archive and executable SHA-256 in the `bun` object | the owner chooses another version |
| builder head | all zeros until armed | the arming step |
| registry packages | 20 tarballs, each by the lockfile's own sha512, listed in `dependencies.lst` | a lockfile changes |
| actions | `actions/checkout` and `actions/upload-artifact`, each a full commit SHA | never |

**Winter Core is the fourth origin** and is captured as a closed slice (`pins.winter_eligible`): the cowork
sources, `runtime-state/records.ts`, `runtime-sdk/model-tag.ts`, the protocol package's `src`, and the package and
tsconfig files that resolution reads. It is not the whole repository, and no test or daemon file enters the packet.

### Dependencies

The agent-sdk guided entry bundles `@modelcontextprotocol/client` (with its 12-package closure), `ajv` and
`ignore`; Winter's protocol package bundles `zod`. The two origins pin different zod versions (4.5.4 for the SDK
side through the MCP client, 4.4.3 for Core), so a flat tree cannot hold both. The pin file lists 20 registry
tarballs, generated offline from the two `pnpm-lock.yaml` files by `pin-deps.ts`, and `acquire.py deps` unpacks
them into a pnpm-style virtual store (`dependencies/.pnpm/<id>/node_modules/<name>`) with dependency links taken
from the pin, never from package contents. No package manager, install script or registry resolution runs.

## What the build checks (and does not)

Reused from the reader builder: unprivileged only, empty build cwd and config, closed environment, the four
literal compile-autoload-off flags, the compiler parser negatives and positive controls, the standalone-layout
decoder, the held-descriptor tool reads, bounded ELF dependency data, and no output execution (`outputsExecuted`
false). New here: a four-origin capture with per-file Git identity, per-origin third-party aliases, a
metafile normalizer that handles bare, extensionless-relative and pruned edges and tsconfig `paths`, per-role
required inputs, a union check that every third-party alias is reached, a closed ten-artifact receipt, and a
packet archive bounded by the pin file (1 GiB, 20,000 entries).

Static metafile evidence only. Dynamic runtime imports, global Bun configuration, autoload execution, the native
owner, Linux execution and the VM all stay unverified (`*Verified: false`, `activationEnabled: false`).

**Local dry evidence (not a substitute for the run).** The same pinned sources and the 20 tarballs were staged by
`prepare_packet` and bundled with a local Bun 1.3.14 (`bun build --target=bun --metafile`, output discarded, never
run). The four real metafiles all normalize: runtimeEntry 579 inputs, providerWorker 2, hostClient 146,
instructionReader 62, and every third-party alias is reached. This exercised the extensionless-relative,
pruned-edge and tsconfig-`paths` rules, which the reader builder refuses. It is a macOS bundle, not a
`--compile` for `bun-linux-arm64`; the real run can still refuse.

## The run

`.github/workflows/cowork-guided-packet-compile-fixture.yml` fires only on the **first creation** of the branch
`cowork/guided-packet-compile-fixture` (`created == true`, `run_attempt == '1'`). It has no pull request,
dispatch, schedule or tag trigger, no `paths` filter, no secrets, `contents: read`, no sudo, and it runs on
`ubuntu-24.04-arm`. It curls the pinned Bun zip and the 20 pinned tarballs (each checked by a strict checksum),
runs `build.py` (which runs `bun build --compile` four times, `cc` six times, plus the semantic parser runs) and
uploads the archive and inventory with 7-day retention. A failed run uploads diagnostics only. The branch is
never created, pushed or re-run by the author. After the one run the branch is frozen.

Deleting and recreating the branch would fire it again; nothing in YAML can prevent that, so the approval is the
control. Read the run's output as data: nothing here explains C59, and a red or green result from this packet
neither explains nor clears it.

### Arming (owner-approved step, not part of this change)

1. The owner chooses the Bun version (default 1.3.14, matching the guest base and the reader pins). The owner approves the single run.
2. One commit on top of the reviewed builder commit sets `BUILDER_HEAD` in the workflow to that builder commit.
   That commit changes nothing else: it is the single `BUILDER_HEAD: '<sha>'` line, with the same quoting as the zeros line.
3. The branch is created once from that exact commit.

The owner's approval of that exact arming commit is the control, and the controller verifies the one-line diff by hand
too. The workflow adds a second, mechanical check: its first two steps (a full-history checkout of the pushed commit,
then a shell guard) refuse unless `BUILDER_HEAD` is non-zero, is an ancestor of the pushed commit, and the whole diff
`BUILDER_HEAD..pushed` is that one line of that one file. Only then does the guard check out the builder head, so an
unreviewed commit's `build.py` or `acquire.py` is never reached. Unarmed (all zeros) still fails closed. The gate test
runs the guard script for real against temporary repositories: an extra file, a non-ancestor head, a two-line diff and a
respelled line each fail on their own check. No ruleset or repository setting is involved.

### Moving a pinned origin

* **A later agent-sdk change (PR 35 is already in the pin).** Change the one constant `origins.agentSdk.head` (and `.tree`) in the pin file and the
  mirrored `AGENT_SDK_HEAD` line; the agreement tests name whichever is left behind. The Root reader service is a
  Python supervisor change (data in the captured SDK tree, not compiled here), so the compiled outputs only change
  if it touches a bundled TypeScript file or one of the six C sources. If the lockfile changed, rerun
  `pin-deps.ts` (it prints the whole `dependencies` block) and update `dependencies.lst` and its env hash.
* **Bun version.** Edit the `bun` object in the pin file (version, archive SHA-256, executable SHA-256) and the
  three mirrored `BUN_*` lines, then re-pin the run output. This is the owner's decision before the run. The
  standalone-layout decoder and the compiler parser checks were derived from Bun 1.3.14 sources, so another
  version will probably refuse until they are re-derived: the mechanical change is small, the review is not.

## Limits

Individual source 16 MiB; 20,000 entries per origin; ELF 128 MiB; packet 1 GiB; at most 32 ELF dependencies.
Compiler and Git hashes are measurements, not a trusted toolchain attestation.

Owner standing line: "if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted."
