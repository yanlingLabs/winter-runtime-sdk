# Guided compile packet intake (DATA only)

`compile-39165162201.pin.json` pins the output of the ONE guided compile-fixture run
(run 39165162201, attempt 1, success; artifact 12149668717). It is intake evidence, not an admission:
nothing here executes, imports, extracts or admits anything, and no root caller is accepted.

```
python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json>
python3 -I -B scripts/guest-guided-intake/test_verify_packet.py        # synthetic packets, 34 tests
bun test test/gates/guided-packet-pin.test.ts                          # the cascade and its mutation table
```

The run's branch `cowork/guided-packet-compile-fixture` is **FROZEN**: never push to, delete or recreate it. The arming
commit `5f3e7c95` is reachable only from it; its parent is the builder head `5c762d2b` and it changes only the
`BUILDER_HEAD` line. The workflow on `main` stays unarmed (all zeros), so nothing on `main` can fire it.

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
from a new compile run: that is the intent. A second compile run adds its own pin and updates the one-pin test in the
same reviewed change.
