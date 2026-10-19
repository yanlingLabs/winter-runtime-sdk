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
| `providerWorker` | `entries/provider-worker.ts` (this directory) | The request-counting provider runner around runtime-sdk `scripts/guest-guided-provider/stub.ts`. Contract C-P1..C-P10 below. |
| `hostClient` | `entries/host-client.ts` (this directory) | The guided host client: the SDK `query` plus Winter Core's guided reader adapter (planner, resolver, structured-instruction mapper). Contract C-H1..C-H12 below. |
| `instructionReader` | runtime-sdk `src/guest/instruction-reader-entry.ts` | Same recipe as the accepted reader packet (asserted equal in the tests). |

| Native artifact | Source (agent-sdk `packages/runtime/src/guest/`) | Flags |
| --- | --- | --- |
| `toolLauncher` | `linux-tool-compartment.c` | `-std=c11 -O2 -Wall -Wextra -Werror -static` |
| `runtimeLauncher` | `linux-runtime-compartment.c` | same |
| `fileWorker` | `file-worker.c` | same |
| `processWorker` | `process-worker.c` | same |
| `ownerLibrary` | `linux-session-owner.c` | `... -shared -fPIC` |
| `instructionReaderLauncher` | `linux-instruction-reader-compartment.c` | the reader packet's hardened dynamic flags |

**Placeholders, status.** Run 39165162201 compiled the earlier compile-only adapters for these two roles, so its
`providerWorker` and `hostClient` outputs are placeholders (`placeholder: true` in its pin) and are not bindable. The
sources in this directory are the real entries. Their hashes exist only after a second compile run, and the hosted run
binds to that run's pin, never to run 1's two placeholder outputs. Nothing here has been compiled, started or run.

Each entry is a thin runner (`entries/provider-worker.ts`, `entries/host-client.ts`: descriptors, native calls, the SDK
and Core imports) over a pure core (`entries/provider-worker-core.ts`, `entries/host-client-core.ts`: every decision, no
import, no I/O). `guided-entries.test.ts` is the test-level spec of the cores; `test_guided_build.py` statically pins the
runners (no network, no child process, no dynamic import, one `dlopen` of `/proc/self/fd/5`). Both runners are guarded
by `if (import.meta.main)`, so importing them starts nothing.

## Entry contracts

These are the statements the hosted fixture (agent-sdk S5) may rely on. Each id is cited by a test in
`guided-entries.test.ts` and `test_guided_build.py` fails when an id is defined here but not tested, or the reverse.
Wire formats are JSON lines on stdout, at most 4096 bytes each, written whole and synchronously.

### providerWorker (the stub behind the native owner)

Started by Root, as the provider UID, from the Root-owned compiled `providerWorker`; not by the guided runtimeEntry. The
guided runtime reaches it only through the native owner's provider symbols, so the worker is the host-side provider
fixture and the runtime never receives its descriptors.

* **C-P1** argv is exactly `--listener-fd 3 --admission-fd 4 --owner-library-fd 5 --metadata-fd 6`, on Linux. Anything
  else prints `{"kind":"provider-refused","code":"argv"|"platform"}` and exits 2, having read nothing. Stdin is Root's control channel (C-P11).
* **C-P2** fds 5 (owner library, at most 4 MiB) and 6 (metadata, at most 64 KiB) must be regular files owned by uid 0
  with one link and no write bit. Otherwise `provider-refused` code `input`, exit 2.
* **C-P3** the metadata is canonical `JSON.stringify` bytes with exactly `version` (1), `runtimeUid` (integer from 1000),
  `scriptSha256` (64 lowercase hex) and `script` (an object). The script bytes are `JSON.stringify(script)`; the hash is
  Root's independent value and the fixture port refuses the script on a mismatch (`provider-refused` code `fixture`).
  Any other shape: code `metadata`, exit 2. No credential, token or guidance text belongs in it and none is read.
* **C-P4** admission: the library is opened only as `/proc/self/fd/5`, and `winter_provider_receive_owner(4)` must return a
  descriptor; otherwise a `provider-summary` with reason `failure` and exit 3. The worker then accepts only on
  inherited descriptor 3 as `runtimeUid`. It creates no socket, makes no connection, runs no child and imports no network API.
* **C-P5** counting: every native arrival, readable or not, is counted at the earliest point the worker can observe it,
  before decoding, and a `{"kind":"provider-request","n":<k>,"readable":<bool>}` line is on stdout before the fixture
  port sees the bytes or any reply is written. `n` starts at 1 and increases by one per arrival.
* **C-P6** framing: the native owner's NUL-terminated JSON line becomes the fixture's frame by adding a 4-byte big-endian
  length prefix, and the reply goes back with the prefix removed and a NUL appended. The JSON bytes are not modified.
  An empty line, a line containing NUL or over 2 MiB + 4096 is never given to the port (counted as `unframed`).
* **C-P7** refusal: when the fixture port refuses (bad frame, wrong scope, a third begin, a missing or reordered marker,
  anything after a close) the worker writes no reply, closes that client and keeps running. The fixture closes itself on its
  first refusal, so every later arrival is still counted and answered with nothing. A line `{"kind":"provider-outcome",
  "n":<k>,"outcome":"accepted"|"refused"|"unreadable"}` follows each arrival.
* **C-P8** output: stdout carries only `provider-ready`, `provider-request`, `provider-outcome`, `provider-summary`,
  `provider-receipt`, `provider-control-refused` and `provider-refused` lines; stderr is never written. No request body, marker, guidance text, script text or response text
  appears on stdout; the per-turn evidence is the turn digests in the summary.
* **C-P9** summary: on SIGTERM/SIGINT (reason `signal`) or when the owner is no longer live (`owner-gone`) the worker
  writes one `provider-summary` and exits 0. Its fields are `requests` (arrivals), `unreadable`, `unframed`, `refused`,
  `answered`, the fixture's `receivedFrames`, `receivedBegins`, `acceptedBegins`, `completed`, `portClosed`,
  `scriptSha256`, `turnSha256` (one digest per accepted turn) and `countersAgree`
  (`requests == receivedFrames + unreadable + unframed`). A run that is revoked must show the same `requests` at the
  revocation barrier and at the end; the worker has no other way to know it was revoked, and none is needed.
* **C-P11** counter read-out, the Root runner's only way to read the stub's counters, from the provider process and never
  relayed by the host client: Root writes `receipt <tag>\n` on the worker's stdin (`tag` is 1 to 32 characters of
  `a-z0-9-`, starting with `a-z0-9`; the whole line is at most 64 bytes). The worker answers with exactly one
  `{"kind":"provider-receipt","tag":...,"requests","unreadable","unframed","refused","answered","receivedFrames",
  "receivedBegins","acceptedBegins","completed","portClosed","outcomes":[...],"countersAgree","controlRefused"}` line. The
  snapshot is read-only, counts no arrival and cannot straddle an arrival (no await separates the worker's count from the
  fixture's own). `outcomes` lists the first 64 arrivals as `accepted`/`refused`/`unreadable`, so a third begin that the
  stub refuses still shows as `receivedBegins` 3, `acceptedBegins` 2, `refused` 1. Any other line is answered with
  `{"kind":"provider-control-refused","code":"line"}` and counted in `controlRefused`; end of input is not a stop.
* **C-P10** exit codes: 0 stopped, 2 startup refusal (C-P1..C-P3), 3 native failure (C-P4, a failed reply write). A
  refused request never changes the exit code; S5 judges the run from the summary.

The worker has no network access of its own; S5 must still launch it with no network interface (an assertion of the
launch, not of this source). Its bundle contains only `stub.ts`, the core and `node:crypto`.

### hostClient (SDK `query` plus Winter Core)

Started by Root as uid 40001 with the v1 harness descriptor layout. It is the host side of the query: it does not start
the guided runtimeEntry. Root starts that (the guided `host-query-guided-v1` bootstrap and five-descriptor reader
registration, produced by the Root supervisor) and the host client reaches it only through the pipes below, as the v1 host
client does.

* **C-H1** argv is exactly `--input-fd 3 --output-fd 4 --error-fd 5 --metadata-fd 6 --lifecycle-fd 7 --cancel-fd 8`, on
  Linux, running as uid 40001; otherwise `{"kind":"host-refused","code":"argv"|"platform"|"identity"}`, exit 2.
* **C-H2** fd 6 is a Root-owned immutable regular file (at most 64 KiB, as C-P2); fds 3, 4, 5, 7 and 8 are Root-owned
  FIFOs with one link. Otherwise `host-refused` code `input`, exit 2.
* **C-H3** the metadata is canonical `JSON.stringify` bytes with exactly `version` (1), `workspaceKey`, `incarnationId`,
  `leaseEpoch`, `prompts` (exactly two non-empty dispatch prompts, at most 1024 bytes each),
  `runtimeConfig` (the query options Root expects, without `requiredRuntimeContext`), `readerRegistration` (the Root
  reader registration the SDK profile validates) and `fixture` (see C-H5). Otherwise `host-refused` code `metadata`, exit 2.
* **C-H4** stdin and stdout: stdin carries only Root's commands (C-H9), one per line, at most 64 bytes; end of input ends
  the run (never passed unless `finish` came first). stdout carries only `host-spawn`, `host-query-ended`, `host-dispatch`,
  `host-premint`, `host-presented`, `host-revoked`, `host-command-refused`, `host-result` and `host-refused` lines; every
  command gets exactly one reply line. stderr is never written. The only free text ever printed is a dispatch's answer
  text (at most 512 bytes: the stub's scripted response, which Root compares with its own script); no prompt, guidance,
  path, binding id or message text is printed. The host client never reports provider-call counts: that is C-P11.
* **C-H5** record sources: Winter Core's guided reader adapter takes a repository, a grant resolver, a boot id port and
  a registration port. This client supplies in-memory FIXTURE objects built from `metadata.fixture` (`registration`,
  `capture`, `runtimeRow`, `workspace`, `binding`, `policy`, `sources`, `grants`, `bootId`), not Winter's SQLite state: the
  fixture answers exactly the two raw statements the planner issues and throws on any other, on an unknown id or on a
  grant key outside its own table. A run with these records proves nothing about Winter's real runtime state.
* **C-H6** setup order, the contract: claim the SDK guest issuer (once per module instance) -> `advance(workspaceKey,
  incarnationId, leaseEpoch)` -> build the guided context handler -> `prepareGuidedQuery` with the SAME `onRuntimeContext`
  and `spawnClaudeCodeProcess` function objects later passed to `query` -> `mint` a ticket for that preparation ->
  `query` with `executionPosture: "confined-guest"`, `requireRuntimeContext: true`, `guidedQueryPreparation`,
  `guidedGuestTicket`, `onRuntimeContext`, `spawnClaudeCodeProcess` and a streaming prompt that sends nothing until a
  `dispatch` command. Nothing is retried and no step is skipped. Every later presentation (C-H10) is prepared the same way.
* **C-H7** spawn hook: `consumeGuidedQueryCorrelation` is called with the hook's own `guidedQueryClaim` and exact `args`
  before anything else; the emitted `--config-json` is then parsed and validated by `assertLinuxGuidedHostQueryConfig`
  against `readerRegistration`; only then is the pipe-backed process created and `{"kind":"host-spawn"}` printed.
  Any refusal throws `host config refused` and no process exists. Exactly one runtime process exists per run: a second
  spawn, from any preparation, is refused before anything is consumed or created, so a presentation the SDK wrongly
  accepted can never wrap the Root pipes again. Such a presentation is reported `refused:false`, `processStarted:true`
  (meaning started or attempted), and the run does not pass.
* **C-H8** frames: the adapter's `readFrame(signal)` is the SDK's `readGuidedQueryInstructions(preparation, signal)` for the
  exact preparation above; Core parses the frame as guest-controlled bytes. The runtime-context handler is called once
  per generation and a refusal propagates as `required_context_unavailable`.
* **C-H9** commands, exactly these lines on stdin, in any order the rules allow: `dispatch 1`, `dispatch 2` (in that
  order, before the revoke; each sends its prompt and replies `{"kind":"host-dispatch","n":<1|2>,"ok":<bool>,"answer":
  "<text>"}`, with `"ended"` added when the query had already ended); `premint` (once, before the revoke: a second
  preparation and a second, UNSPENT ticket, held in memory and never printed; replies `host-premint`); `reuse` (after
  `dispatch 2`, before the revoke: present the first, spent ticket again); `revoke` (once; `issuer.revoke(workspaceKey)`;
  replies `host-revoked`); `present-premint` (after both `premint` and `revoke`: present the held ticket) and `finish`.
  Root edits the shared guidance between the `dispatch 1` reply and `dispatch 2`, and reads the provider receipt (C-P11)
  between any two commands: each command's reply is written only after its effect is complete, so a receipt requested
  after a reply cannot race the command.
* **C-H10** presentations and revocation: `reuse` and `present-premint` each call `query` with a streaming-free prompt, the
  ticket's own preparation and callbacks, and read its first step. The reply is `{"kind":"host-presented","which":
  "spent"|"premint","refused":<bool>,"errorClass":"required_context_unavailable"|"other"|"none","processStarted":<bool>}`.
  `refused` is true only when the first step threw AND no runtime process was started or attempted for it; `errorClass` is the SDK's
  own refusal text mapped to a closed class (`none` when the presentation produced a step). `issuer.revoke` kills the
  running first query (the SDK's contract); the client does not wait for that and does not send a third prompt. The
  zero-provider-requests observation is Root's: equal provider receipts (C-P11) before `revoke` and after
  `present-premint`.
* **C-H11** failures and refusals: an unknown, malformed, overlong or out-of-order command is answered
  `{"kind":"host-command-refused","code":"unknown"|"order"}`, executes nothing, and the run can no longer pass. A query that
  ends early is reported once as `host-query-ended` with a closed `how` (`completed`, `torn-down:<code>`, `failed:<code>`).
  Codes are closed (`required_context_unavailable`, `fixture_records`, `command`, `config`, `turn`, `revoke_not_observed`,
  `host_failure`); no message text is ever reported. `host-result.passed` requires `finish` after two successful dispatches,
  a refused `reuse` and a refused `present-premint` (both `required_context_unavailable`), no result after the revoke and
  no refused command.
* **C-H12** exit codes: 0 passed, 1 run failed (`passed:false`, or a failure the core could not report), 2 startup refusal.
  The last stdout line is always `host-result` or `host-refused`.

### What S5 must assume, as testable statements

1. The hosted fixture provides metadata files that satisfy C-P3 and C-H3, built by Root, and a Root reader that
   produces the five-descriptor registration and the immutable shared and source views. This builder does not supply them.
2. `runtimeConfig` is a set of query options whose emitted config passes `assertLinuxGuidedHostQueryConfig` for the given
   `readerRegistration`. This is checked at C-H7 and is an unverified assumption until the run: the option names that make
   the SDK emit `winterHome` and `storeHome` were not derived from a run.
3. A streaming prompt (`AsyncIterable<string>`) is accepted by a guided `query`, and `issuer.revoke` ends it. The SDK's
   revoke contract says it tears down the running query; this is also unverified end to end.
4. The lifecycle pipe (fd 7) carries `HQX1:<code>\n` as in the v1 harness.
5. The provider and the host client are separate processes with separate pipes. Root asks the provider for a `receipt <tag>`
   (C-P11) only after it has read the host reply for the previous command and before it writes the next command, so the
   five readings (after dispatch 1, after dispatch 2, after the reuse attempt, immediately before `revoke`, immediately
   after `present-premint`) cannot race a command.
6. Neither process has a network interface. The cores import nothing and the runners contain no network API (statically
   tested); the hostClient bundle does contain the SDK, which includes a process spawner and an MCP client the entry never
   calls. That is why S5 must assert the launch has no network interface instead of relying on the source.

### Differences from the assumptions in agent-sdk PR 36 (follow the real interfaces; the S5 lane reconciles)

1. PR 36 reads the counters "at five points" and the doc suggests a `receipt` request on a control channel: built as C-P11
   on the provider's stdin. Same intent, one difference: the reply is a stdout line from the provider process.
2. PR 36 presents the pre-minted ticket "after a revoke" and counts "immediately before and immediately after revocation":
   built as `premint` / `revoke` / `present-premint` (C-H9). The SDK mints only against a preparation, so the pre-minted
   ticket comes with its own preparation and callbacks, and a revoke kills it. The mint after the revoke is not a command:
   it is refused by the SDK (`required_context_unavailable`) and is not part of the contract.
3. PR 36's `shared_edit`/`dispatch` answer text is `host-dispatch.answer` (bounded, the only free text on stdout).
4. PR 36 says "each role exits 0 on success and non-zero on refusal": providerWorker exits 0 on a normal stop even when it
   refused requests (C-P7, C-P10), because refusing a request is expected evidence, not a failure; Root judges the run
   from the receipts. hostClient exits 0 only when `host-result.passed` is true (C-H12).
5. PR 36 says the stub transport is the native peer/pidfd transport with no egress: the provider worker uses exactly the
   native owner's provider symbols (`winter_provider_receive_owner/accept/owner_live/read_frame/write_frame/close_client`)
   on inherited descriptor 3, the same ones the v1 harness's provider uses, and creates no socket. The hostClient bundle
   still contains SDK code that could spawn or fetch; S5 must launch it without a network interface (S5 assumption 6 above).
6. The run has a guided runtimeEntry started by Root, not by the hostClient; the hostClient reaches it through the Root
   pipes only (C-H1, C-H2). Nothing in this change starts the runtime.

### Flags for the reviewer

* The host client imports an SDK-internal module (`packages/sdk/src/guided-query-reader.ts`, not exported from the
  package index) by relative path, and claims the SDK guest issuer, a door whose documented importers are not this packet.
  Both are the only way to supply the adapter's `readFrame` seam today and are the review question.
* The adapter `guided-reader-adapter.ts` is part of the pinned Winter slice (8b52ef83, unchanged) but is "SOURCE ONLY" there:
  no production code imports it. Its in-memory records and grants here are fixture data (C-H5).
* The hosted path must run `scripts/guest-guided-intake/verify_packet.py` (exit 0 only when every check holds) on the
  DOWNLOADED artifact and refuse to bind anything unless it exits 0. A well-formed but wrong hash in a pin is not caught by
  CI, whose real-archive test is skipped without the artifact. Exit codes: 0 all checks hold, 1 a check failed
  (`allChecksHold: false`), 2 usage or I/O error.

## Pins

All pins live in `guided-compile-inputs.pin.json`; `pins.py` loads it, the workflow mirrors it in one `env:`
block, and both test files fail when any copy drifts.

| Pin | Value | Moves when |
| --- | --- | --- |
| agent-sdk head | `9c980c326638489e0183d7fcddcf1a93553be0ba` (main, compartment C by PR 34, Root reader service by PR 35, owner holder/CLOEXEC patch by PR 38; run 1 used `68e57c64`) | a later agent-sdk change; see below |
| runtime-sdk head | `ce730190854fd807446ac3a229a358c553a57697` (main, includes the real entries, PR 20, and the `winter-standin` stub selection, PR 21; run 1 used `29eede4b`) | a later runtime-sdk change to a compiled input |
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
run). The four real metafiles all normalize: runtimeEntry 579 inputs, providerWorker 3, hostClient 166,
instructionReader 62, and every third-party alias is reached. This exercised the extensionless-relative,
pruned-edge and tsconfig-`paths` rules, which the reader builder refuses. It is a macOS bundle, not a
`--compile` for `bun-linux-arm64`; the real run can still refuse.

## The run

`.github/workflows/cowork-guided-packet-compile-fixture.yml` fires only on the **first creation** of the branch
`cowork/guided-packet-compile-fixture-2` (`created == true`, `run_attempt == '1'`). It has no pull request,
dispatch, schedule or tag trigger, no `paths` filter, no secrets, `contents: read`, no sudo, and it runs on
`ubuntu-24.04-arm`. It curls the pinned Bun zip and the 20 pinned tarballs (each checked by a strict checksum),
runs `build.py` (which runs `bun build --compile` four times, `cc` six times, plus the semantic parser runs) and
uploads the archive and inventory with 7-day retention. A failed run uploads diagnostics only. The branch is
never created, pushed or re-run by the author. After the one run the branch is frozen.

The first run used `cowork/guided-packet-compile-fixture` (run 39165162201). That branch is frozen: this workflow no
longer names it (a gate tripwire refuses that exact name, and any other `cowork/guided-packet-compile-fixture*` name except the new one), so a push to it starts nothing.
The second run starts only from an owner-approved first-creation push of `cowork/guided-packet-compile-fixture-2`,
made from the arming commit described below; no other event can start it, and the gate test proves that.

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
* **The run-2 agent-sdk head.** Run 1 used agent-sdk `68e57c64`. Run 2 takes `9c980c32` (PR 38, the owner-side holder/CLOEXEC
  patch to `linux-session-owner.c`, the `ownerLibrary` native), so a third compile run is not needed. Between the two heads no
  lockfile or package manifest changed (so `pin-deps.ts` was not rerun) and no bundled TypeScript file changed; only that C
  source did among compiled inputs. It was the same single-constant move (`origins.agentSdk.head`/`.tree`, `AGENT_SDK_HEAD`).
* **Bun version.** Edit the `bun` object in the pin file (version, archive SHA-256, executable SHA-256) and the
  three mirrored `BUN_*` lines, then re-pin the run output. This is the owner's decision before the run. The
  standalone-layout decoder and the compiler parser checks were derived from Bun 1.3.14 sources, so another
  version will probably refuse until they are re-derived: the mechanical change is small, the review is not.

## Limits

Individual source 16 MiB; 20,000 entries per origin; ELF 128 MiB; packet 1 GiB; at most 32 ELF dependencies.
Compiler and Git hashes are measurements, not a trusted toolchain attestation.

Owner standing line: "if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted."
