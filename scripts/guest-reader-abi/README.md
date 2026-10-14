# Reader ELF version preflight

`abi.py` inspects ARM64 ELF bytes using only Python's standard library. It never
opens a library path, downloads a package, imports captured source, invokes
`ldd`/`readelf`, loads an ELF, or launches a process. Callers supply the measured
artifact and image-library bytes and independently bind them to their inventories.
This module is private fixture tooling; it is not exported by the Runtime SDK.

```python
result = preflight(
    {"instructionReader": reader_bytes, "instructionReaderLauncher": launcher_bytes},
    image_library_bytes_by_guest_path,
    interpreter="/lib/ld-linux-aarch64.so.1",
)
```

The parser cross-checks section and dynamic-table mappings, `DT_NEEDED`, SONAME,
the interpreter, GNU version requirements/definitions, dynamic symbols and symbol
version indices. It refuses ambiguous mappings/SONAMEs, overlapping version
records, RPATH/RUNPATH, missing dependencies, missing version definitions and
missing strong versioned symbols. Limits are 128 MiB per ELF, 512 MiB aggregate,
four roles, 32 libraries, 65,536 symbols and 4,096 version auxiliary records.

Version requirements must be satisfied by their declared library. A symbol may
be provided elsewhere in that object's explicitly supplied NEEDED closure; the
receipt records every matching candidate SONAME rather than claiming a resolved
loader binding. This accommodates the integration of libpthread/libdl into libc
from glibc 2.34. [GNU glibc release announcement](https://sourceware.org/pipermail/libc-announce/2021/000032.html)
Unreachable libraries cannot satisfy a symbol. Weak imports need not have an
implementation, but their declared version namespace is still checked.

This is a static necessary check, not a complete dynamic-loader simulation.
Unversioned symbols, relocations, TLS, IFUNC execution, CPU/kernel requirements,
autoload, runtime imports and startup behavior are not proven. It does not
validate a rootfs filesystem layout or follow its links. All results explicitly
retain `completeABIProven=false`, `guestCompatibilityProven=false` and
`executionAuthorized=false`. A version match never authorizes library substitution
into an accepted packet or grants native/staging/profile admission.

## Verification

```sh
python3 -I -S -B -m unittest discover -s scripts/guest-reader-abi -p 'test_*.py'
```

The portable tests construct synthetic ELF data. They check an exact match,
older/incomplete libraries, missing symbols despite a matching version label,
transitive and unreachable dependencies, merged implementations, ambiguity,
search paths, malformed/overlapping version records, architecture and truncation.

The separate local DATA observation compared compile packet `38502659264`
(archive SHA256 `e3863c0ebe91a7cbe4efc0c63cf5adb232dbb5bddd1c897cd447045b8c96482b`)
with the already preserved **builder fixture image**, not a guest rootfs:

- Image archive SHA256 `85e8c23e31fc1f58c17a445379d23693924d4b70e1b0774812001dcfb19bef19`;
  275,450,880 bytes; ARM64 OCI manifest
  `9e92ecbd9aefed7147c434da63b746bc57afb3c679ad1277f0d753ae248e4aa0`.
- Final package metadata identifies libc6/libc-bin `2.39-0ubuntu8.9` ARM64.
  The five distinct loader/libc/libdl/libm/libpthread objects match the packet
  closure byte-for-byte; the second loader path is an explicit same-byte alias.
- Static version/symbol candidates matched for both roles and all supplied
  libraries. The reader requests `GLIBC_2.17`; its launcher also requests
  `GLIBC_2.33` and `GLIBC_2.34`. Thus a lower guest version is not automatically
  acceptable merely because the reader alone supports it.

This observation is a **same-build match**, not guest compatibility evidence.
The real guest-rootfs target and independent image intake remain open. It used
bounded tar reads as DATA, without extraction, disk attachment, Docker/image
execution, packet imports, compiled-output execution, or a VM. The Mac two-disk,
native-egress and GUI holds are unchanged.
