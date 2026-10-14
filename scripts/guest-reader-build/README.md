# Reader-only compile packet — source prerequisite

This new unprivileged builder captures RuntimeSDK 0394, SDK 8603 and only the exact
SDK19 f6 reader C/header overlay. The main SDK header must equal the overlay header.
Source bytes must match the pinned Git trees, and all dependencies and relative
alias resolutions remain inside the new packet. SDK-family aliases select all six
captured 0.0.53 source packages; published 0.0.28/global resolution refuses. No
production manifests, dependency installations, consumer pins or B paths change.

The eventual ordinary Linux ARM64 CLI compiles only the actual private reader
entry and its native reader launcher, records individual recursive ELF dependency
files, and never executes an output. It requires official pinned Bun 1.3.14
compiler/base bytes and all four literal autoload-off flags; there is no unsupported
flag fallback. Empty build cwd/config, no dotenv and closed environment apply.
Source/data tests inject compiler refusal: **no actual compilation or download has
been performed for this source freeze**. No artifact workflow is added here.

```
python3 -I -S scripts/guest-reader-build/test_provenance.py
```

Data limits: individual source 16MiB, aggregate 256MiB, entries 20,000, directory depth 64,
bounded symlink traversal 32; output ELF 128MiB, dependency 32MiB/count 32/aggregate 128MiB,
JSON/compiler output 16MiB and compiler deadlines 120s. Git/compiler/nativeCC hashes
and versions are measurements, not a full trusted-toolchain or package attestation.
The system-header dependency observation does not establish atomic compiler reads.
Receipts keep nativeOwnerVerified/linuxExecutionVerified/vmExecutionVerified/
activationEnabled false. Existing static graph limitations are not upgraded.

This is not Core host adapter/RPC/profile wiring or a whole guided four-role packet.
No native Root mounts, owner admission, reader debt, VM, egress or GUI execution.
SDK19 remains draft; its no-device Bun compatibility and legacy ARM race remain
open. Root+45+Astra must review the complete new source before any ordinary artifact
build; later privileged admission needs a separate parent/sealing/re-hydration
review. B's old stage/artifacts/pins are not reusable admission.

The dependency input is a separately prepared, captured PNPM-store tree without
published SDK-family packages. This slice does not install or prune an existing
consumer dependency tree. Empty stage cwd and explicit empty Bun config are used;
source package manifests serve only the measured resolver. Personal/global Git
configuration is disabled. The official archive hash is a prescribed acquisition
pin; archive acquisition itself is not performed or attested by this builder.
Native system headers are bounded post-compile observations; they are not a sealed
compiler/toolchain snapshot or proof that the compiler opened those exact bytes.

The pinned compiler recipe rejects unresolved dynamic imports rather than adding a
resolver fallback. The normalized metafile proves only its recorded static inputs;
receipts explicitly leave dynamicRuntimeImportsVerified false. Captured sources
are immutable copies by default modes, with complete byte/resolver rechecks; the
unprivileged owner can still change them, so this packet is not a Root admission.
