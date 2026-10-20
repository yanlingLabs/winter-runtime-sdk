# Guided compile packet intake (DATA only)

Three runs are pinned here: `compile-39165162201.pin.json` (run 1, placeholders, **not bindable in full**),
`compile-39227365159.pin.json` (run 2, the real entries) and `compile-39327386044.pin.json` (run 3, run 2 plus the hostClient
host-spawn binding fix; the packet the hosted lane binds). Runs 2 and 3 are described in their own sections at the end;
everything before them describes run 1 and applies to later runs unless stated.

`compile-39165162201.pin.json` pins the output of the ONE guided compile-fixture run
(run 39165162201, attempt 1, success; artifact 12149668717). It is intake evidence, not an admission:
nothing here executes, imports, extracts or admits anything, and no root caller is accepted.

```
python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json>
python3 -I -B scripts/guest-guided-intake/test_verify_packet.py        # synthetic packets, 41 tests
bun test test/gates/guided-packet-pin.test.ts                          # the cascade and its mutation table
```

The run's branch `cowork/guided-packet-compile-fixture` is **FROZEN**: never push to, delete or recreate it. The arming
commit `5f3e7c95` is reachable only from it; its parent is the builder head `5c762d2b` and it changes only the
`BUILDER_HEAD` line. The workflow on `main` stays unarmed (all zeros), so nothing on `main` can fire it.

## Exit codes (the hosted path's gate)

`verify_packet.py` exits **0** only when every check holds (`allChecksHold: true`), **1** when a check failed
(`allChecksHold: false`), **2** for anything else (usage, missing or unreadable file, malformed archive or pin, running as
root). Hosted-path contract: run it on the DOWNLOADED artifact and bind nothing unless it exits 0. With more than one pin file
in this directory (run 2 adds one) the default pin lookup exits 2, so the hosted path MUST pass `--pin <the run-2 pin>`. CI cannot catch a
well-formed wrong hash in a pin, because the real-archive test is skipped without the artifact.

## What was verified (and how to repeat it)

`verify_packet.py` streams the archive once and holds it to the pin: archive and inventory hash and size; the inventory
header; every tar member equals an inventory entry exactly (regular files at mode 0400, symlinks at 0777, uid, gid and
mtime 0; no directory, hardlink, device, setuid, absolute or `..` member; no duplicate, extra or missing member); every
link target is a packet member; the 47 links split into the 29 pinned resolver aliases and the 18 dependency links; the
four roles, six natives, four role metafiles, six libraries, the Bun base, `receipt.json`, `inputs.json` and the
acquisition record equal their pinned hashes; the dependency store and the builder-origin files equal the pin; the
receipt and `inputs.json` agree with the pinned origins and claim nothing was executed or verified; no runner or home
path appears in them.

Beyond the pin, the intake audit also re-derived (locally, from Git objects and the 20 registry tarballs, not from the
pin): all 1,625 captured source files equal their blobs at the pinned commits; the packet's dependency store equals a
fresh unpack of the 20 verified tarballs; the run log's environment, checkout refs, action SHAs and 22 checksum lines
(Bun zip, dependency list, 20 tarballs) equal the input pin file; every command the log shows is a line of the reviewed
workflow; `receipt.commands` equals the argv rebuilt from the builder; the four role bundles equal, input for input,
the local bundles made before the run (579, 2, 146 and 62 inputs).

## What the packet is, and is not

This packet is not bindable in full. `providerWorker` and `hostClient` are compile-only adapters that throw as soon as they start, and
their hashes (marked `placeholder` in the pin) change when the real host client and provider runner replace them. A
hosted guided run therefore needs a second owner-approved compile run once those exist. The artifact also expires on
2026-10-25T20:51:38Z.

A hosted fixture may bind: the artifact id with its zip digest; `guided-packet.tar.gz` (f4ec23c8...d754),
`packet-inventory.json` (e098273e...ac43) and `receipt.json` (f6f335df...0c88); the `runtimeEntry` and
`instructionReader` roles; the six native artifacts; the six libraries; the Bun base. Every hash is in the pin.

Facts a rehydrator must not trust the archive for: the archiver forces every regular file to mode 0400 and every link
to 0777, so modes are not build evidence; executable modes must be assigned by the rehydrator. The 47 symlinks (29
resolver aliases and 18 dependency links) must be recreated, not skipped. The archive has no directory members.

`instructionReaderLauncher` (d8f26ced..., 73,624 bytes) is byte-identical to the launcher in reader run 38715669708:
same C source, same flags, same image. `instructionReader` differs from that run's, as expected, because its origins moved.

Linux execution, the native owner and the VM stay unverified; this packet proves the builder works end to end on Linux
and nothing more. Nothing here explains C59 or clears it.

Owner standing line: "if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted."

## When the builder changes

The pin lists the 13 builder-origin files that ran, by hash (including the two reader helper modules). Editing any of
them, or `guided-compile-inputs.pin.json` or `dependencies.lst`, fails the cascade test until the change is re-pinned
from a new compile run: that is the intent. A later compile run adds its own pin and its row in the gate test's run table in the
same reviewed change.

## Run 2 (compile run 39227365159): the packet the hosted lane binds

`compile-39227365159.pin.json` pins run 39227365159 (attempt 1, success, branch `cowork/guided-packet-compile-fixture-2`,
which is **FROZEN** like the first: never push to, delete or recreate it). The arming commit `35482214` sits on the PR 22
merge `2cb3ecf0` (the builder head) and changes only the `BUILDER_HEAD` line. Artifact 12174387240,
`guided-packet-compile-39227365159`, zip sha256 `a4d731f6...0296`, 195,477,535 bytes, expires 2026-10-26T09:05:43Z.

Verify it, with the pin named explicitly (the default pin lookup exits 2 now that two pins exist):

```
python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json> --pin scripts/guest-guided-intake/compile-39227365159.pin.json
```

Hosted-path contract, unchanged and now sharper: run exactly that on the DOWNLOADED artifact and bind nothing unless it
exits 0. Nothing in run 2 is a placeholder; `binding.notBindable` is empty. What it binds: `guided-packet.tar.gz`
(`1bea0da9...98d1`), `packet-inventory.json` (`18f5fa5b...ce62`), the artifact zip digest, and the pinned per-artifact
hashes (four roles, six natives, four metafiles, six libraries, the Bun base).

Against run 1: `runtimeEntry`, `instructionReader`, `instructionReaderLauncher`, `toolLauncher`, `runtimeLauncher`,
`fileWorker` and `processWorker` are byte-identical. `providerWorker` and `hostClient` are the real entries (runtime-sdk
PRs 20 and 21, with the `winter-standin` stub selection) and `ownerLibrary` carries the owner holder patch
(`linux-session-owner.c`, SHA-256 `95457d8f...`, agent-sdk PR 38). The pin's `continuity` record states this and the gate
test recomputes it from the two pins' hashes. The origins are runtime-sdk `ce730190`, agent-sdk `9c980c32`, Winter Core
`8b52ef83`; the dependency list is unchanged. The intake audit repeated run 1's (modes, links, inventory, 1,647 source
files against Git, the dependency store against a fresh unpack of the 20 tarballs, the run log against the reviewed
workflow) and found the same shapes; the four role bundles equal, input for input, the local dry bundles made before the
run (579, 3, 166 and 62 inputs). It is still a claim about bytes only: nothing was executed, no native owner was admitted,
no Linux or VM execution was verified, and nothing here explains C59.

## Run 3 (compile run 39327386044): the packet the hosted lane binds

`compile-39327386044.pin.json` pins run 39327386044 (attempt 1, success, branch `cowork/guided-packet-compile-fixture-3`, **FROZEN**
like the others). The arming commit `e411a50f` sits on the PR 25 merge `f7b6add7` (the builder head) and changes only the
`BUILDER_HEAD` line. Artifact 12223150881, `guided-packet-compile-39327386044`, zip sha256 `3e4e5359...57cb` (the API digest, re-derived
from the downloaded zip), 195,490,807 bytes, expires 2026-10-26T21:26:36Z. The origins are unchanged from run 2 (runtime-sdk `ce730190`,
agent-sdk `9c980c32`, Winter Core `8b52ef83`); the hostClient fix lives in the builder origin.

```
python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json> --pin scripts/guest-guided-intake/compile-39327386044.pin.json
```

Same contract as run 2: run exactly that on the DOWNLOADED artifact and bind nothing unless it exits 0. Against run 2, everything is
byte-identical except `hostClient` (`37a2cf65...` to `82997255...`), and the builder-origin files differ in exactly the five files the run-2 gate
lists as superseded. `guided-packet.tar.gz` is `fc2acae1...859a` and `packet-inventory.json` is `58c23a87...670d`. The audit repeated run 2's
(archive shape, links, inventory, 1,647 source files against Git, the dependency store, the run log against the reviewed workflow, the four role
bundles against local dry bundles of 579, 3, 166 and 62 inputs, a single SDK module instance in the hostClient metafile) with the same result. A
claim about bytes only; nothing executed, nothing explains C59.

Owner standing line: "if an automated safety flag fires on follow-on work, that work stops and is surfaced to the owner, never reworded or rerouted."

## Run 4 (compile run 39391435225): the packet with the provider worker's refusal sites

`compile-39391435225.pin.json` pins run 39391435225 (attempt 1, success, branch `cowork/guided-packet-compile-fixture-4`, **FROZEN** like the others). The
arming commit `453d5eca` sits on the PR 28 merge `1e3ff285` (the builder head) and changes only the `BUILDER_HEAD` line. Artifact 12249582986,
`guided-packet-compile-39391435225`, zip sha256 `9895ae16...fc9c` (the API digest, re-derived from the downloaded zip), 195,503,119 bytes, expires
2026-10-27T08:10:56Z. The runtime-sdk origin is `a32330d6` (the PR 27 merge, which carries the stub that names refusal sites); agent-sdk `9c980c32` and
Winter Core `8b52ef83` are unchanged.

```
python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json> --pin scripts/guest-guided-intake/compile-39391435225.pin.json
```

Same contract as runs 2 and 3: run exactly that on the DOWNLOADED artifact and bind nothing unless it exits 0. Against run 3, everything is
byte-identical except `providerWorker` (`4331d732...` to `bbf309b9...`); `hostClient` is unchanged, and the packet's `providerWorker` carries the site names
(`refusalSites`, `frame_empty_or_nul`, `system_marker`, all present as strings). The builder-origin files differ in exactly the five files the run-3 gate
lists as superseded. `guided-packet.tar.gz` is `791685a6...2a2` and `packet-inventory.json` is `1da4770d...c92`. The verifier exits 0 with 19 of 19 checks. A claim
about bytes only; nothing was executed, nothing explains C59.
