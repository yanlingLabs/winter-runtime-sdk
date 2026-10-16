# Reader packet DATA intake

This is an independent, unprivileged Python standard-library validator and
rehydrator. It does not modify the SDK's B stager, import captured source, run
compiled output, inspect dependencies with `ldd`, implement a privileged parent,
or confer native admission. Root callers are refused. It is separate from the
held Mac VM and native-egress lanes.

The default reviewed pin is compile38715669708 (builder 0dd4d8f2, workflow 75a4fe07). The
inventory is independently pinned to SHA256
`0893ae66d58aa577713d8d73a989a0b0e760a9f1c031eb1ce64bfb849302f6c7`
(243,843 bytes), the archive to
`e8249728f18bf37e2e22f299df3ad1829e2930e8ab589cabfb804d6ed6386f3c`
(81,378,280 bytes), and the receipt to
`6ae867037f315a8a9fcd50c311617816f66001f2e91883f49f99740bcef1a135`.
The tracked pin additionally binds all four origin head/tree/inventory identities,
all three compiled artifacts (the reader, its launcher and the reader dependency
probe), six environment paths, the base, and all twelve explicit resolver aliases. No check invokes Git or code inside those origins. This exact
pin contract consumes the previously reviewed source/compiler audit as a DATA
prerequisite; it does not independently reproduce that audit or establish ABI
compatibility with any prospective guest image.

## API

```python
with validate_packet(archive, inventory) as validated:
    receipt = rehydrate_packet(validated, fresh_destination, layout="packet")
```

- `validate_packet(archive: Path, inventory: Path, *, pin=None) -> ValidatedPacket`
  hashes a held archive copy and validates the entire physical tar inventory into
  a private spool. No destination is created. `pin=None` selects the tracked exact
  pin. A caller-supplied pin is a separate reviewed contract, never a packet's own
  declaration. The context manager removes the spool on exit, including failure.
- `rehydrate_packet(validated: ValidatedPacket, destination: Path, *,
  layout="packet") -> dict` copies only that validated spool into a fresh
  destination. It rechecks each held file's hash while copying. Existing output
  is refused. A copy failure attempts removal of the freshly created destination,
  preserving the original failure even if cleanup encounters another error; an
  exception note reports uncertain cleanup and no receipt is issued.
- `load_pin(path=None) -> dict` reads a bounded pin JSON file without following
  filesystem symlinks or accepting a hardlinked file. The pin file and this tool
  are trusted caller-owned source and must be hash-bound by any future external
  parent admission.

`packet` preserves every captured path. `siblings` removes only the leading
`source/` from the four source roots: `runtime/`, `sdk/`, `overlay/`, and
`builder/` become siblings of `artifacts/`, `environment/`, and `stage/`.
Aliases are generated from the explicitly bound alias's validated captured target
identity, mapped through that exact layout. They are never inferred from package
names or the host filesystem. Both layouts retain all captured sources and allow
aliases only into captured SDK package roots.

All seven regular-file roles (`source`, `metadata`, `environment`, `reader`,
`readerLauncher`, `readerDependencyProbe`, `base`) receive mode `0400`. Created directories begin `0700`
and finish `0500`. Every compiled object is non-executable DATA. Symlink mode is
platform-defined; aliases are created only after all regular copies finish.
Archive `0400` does not grant execution. Returned receipts explicitly keep all
execution, authority, native-admission, activation and profile flags false.

## Bounds and refusals

Inventory/control JSON is bounded to 4 MiB; compressed archive to 128 MiB;
individual bodies to 128 MiB; total bodies to 512 MiB; physical leaves to 20,000;
names/targets to 4,096 bytes; paths to 64 components; directory-prefix visits to
60,000; alias expansion to 32 links. Path depth is checked before prefix expansion.
Physical tar parsing
permits only regular `0400` files and zero-size `0777` symlinks with zero
UID/GID/mtime, empty owner names and zero device fields. PAX/GNU extension
headers, hardlinks, directories, device nodes, FIFOs, unknown types, extra or
missing leaves, duplicate leaves, malformed padding and trailing payload refuse.
JSON duplicate keys, absolute/noncanonical paths, casefold collisions,
non-NFC names, leaf/ancestor collisions, dangling aliases, alias cycles and
escapes also refuse. The actual pinned packet has no casefold collisions.

Input files must be same-user regular files with one link; every ancestor and
output traversal is opened with no-follow directory descriptors. Private spool
and output use fresh directories. This protects against ordinary path/link
confusion. It is not a defense against arbitrary same-user inspection or code
mutation, an atomic publication protocol, a launch receipt, trusted toolchain
proof, or a substitute for a separately reviewed external parent. Returned paths
are local DATA locations, not admitted reader scopes. The private spool must stay
inside the context-manager lifetime.

## Verification

```sh
python3 -m unittest discover -s scripts/guest-reader-intake -p test_intake.py -v
python3 scripts/guest-reader-intake/intake.py \
  --archive /absolute/reader-packet.tar.gz \
  --inventory /absolute/packet-inventory.json
```

The CLI above validates only. An explicit `--destination /absolute/fresh-path`
materializes DATA; `--layout siblings` selects the documented mapping. There is
no execute/authority option. Tests use synthetic DATA, including synthetic
compiled-role bodies. The retained real packet check separately validates all
1,474 leaves and 243,716,286 body bytes, and checks both rehydrated layouts, modes
and aliases without executing or importing any captured code.

The default pin is the three-artifact packet of compile run 38715669708 (reader, launcher and
dependency probe). Every field of the pin is a measured value of that packet, taken from its
inventory and its `receipt.json`; compared with the earlier two-artifact pin (run 38502659264,
removed, still in git history) only the heads, trees and inventory digests of the overlay and
builder origins, the launcher, the added probe, the archive and inventory identities, the leaf
and byte counts, the receipt digest, the run and the workflow head changed. The reader, the
base, the six runtime libraries, the twelve resolver bindings and the runtime and sdk origins
are byte-identical to the earlier packet. Nothing in the tests depends on these numbers: they
synthesize their own three-artifact packets from the pin's non-artifact fields.

Source/packet review is required before push. ABI, rootfs identity, external
parent, reader-native harness, guided profile and actual Linux runtime evidence
remain separate prerequisites, and the Mac two-disk/native-egress holds remain.
