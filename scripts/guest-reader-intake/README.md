# Reader packet DATA intake

This is an independent, unprivileged Python standard-library validator and
rehydrator. It does not modify the SDK's B stager, import captured source, run
compiled output, inspect dependencies with `ldd`, implement a privileged parent,
or confer native admission. Root callers are refused. It is separate from the
held Mac VM and native-egress lanes.

The default reviewed pin is compile38502659264. The inventory is independently
pinned to SHA256 `21e790a4c3564510398f8630581493eb606b078b408cf880bb833485290b7c5f`
(243,499 bytes), the archive to
`e3863c0ebe91a7cbe4efc0c63cf5adb232dbb5bddd1c897cd447045b8c96482b`
(81,359,155 bytes), and the receipt to
`0842d1d5de60085564cf2185d048d2b7f8dccef222decac42a1169df03b2e346`.
The tracked pin additionally binds all four origin head/tree/inventory identities,
both reader artifacts, six environment paths, the base, and all twelve explicit
resolver aliases. No check invokes Git or code inside those origins. This exact
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
  is refused; a copy failure removes the freshly created destination.
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

All six regular-file roles (`source`, `metadata`, `environment`, `reader`,
`readerLauncher`, `base`) receive mode `0400`. Created directories begin `0700`
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
1,472 leaves and 243,601,045 body bytes, and checks both rehydrated layouts, modes
and aliases without executing or importing any captured code.

Source/packet review is required before push. ABI, rootfs identity, external
parent, reader-native harness, guided profile and actual Linux runtime evidence
remain separate prerequisites, and the Mac two-disk/native-egress holds remain.
