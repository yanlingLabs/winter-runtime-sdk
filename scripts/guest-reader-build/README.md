# Reader-only compile packet — source prerequisite

This new unprivileged builder captures RuntimeSDK 0394, SDK 8603, the four builder source files and only the exact
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

The CLI requires an externally pinned `--builder-head`; its exact four source
files must match that Git tree and the current checkout. This is provenance data,
not self-granted trust. All source origins record the requested head, checkout head
and tree and recheck them after capture. Every ancestor of the new packet must
lack node_modules, package.json, tsconfig*.json, jsconfig.json, bunfig.toml and .env;
a bounded stream checks this before staging and on input revalidation.

`--resolver-map` supplies a bounded plain JSON map of third-party package names to
measured relative directories in the dependency store. It is explicit data, not a
version-selection fallback. The current reader has no third-party bare runtime
imports; an empty captured dependency tree/map works without a dangling .pnpm link.
Any supplied third-party alias must contribute actual new metafile inputs, and
unknown externals/global/unmeasured inputs refuse. Bare import spellings come from
the NEW compiler's bounded import records (including original when present);
missing-original ambiguity is recorded, and no comment-scanning parser invents a
source graph. This remains static compilation evidence, not runtime graph proof.

The first ordinary build must run the same recipe/parser/held compiler with one
unique bogus flag and a separate fresh negative output directory. Only exit1 and
a closed diagnostic line naming that exact unknown flag satisfy the negative;
unrelated failures or outputs refuse. The normal positive compilation follows. No
probe/compiler/output is executed by the portable tests. The copied Linux base is
rehashed after compilation as well as its original held file.

Directory intake streams before count limits. Capture timeout/overflow/setup errors
signal the still-unreaped owned process group before a bounded one-second wait;
uncertain reaping refuses, with both pipes closed. After normal EOF and a reaped
leader, including a nonzero exit, no later numeric PGID signal occurs and no
descendant-termination proof is claimed. Inert mock regressions cover these cases.

The compile recipe uses gnu11; SDK19's historical full-role object source proof used
c11. This is a distinct recipe requiring fresh ordinary build review. Native cc1/as/ld
and compiler-opened headers are not a sealed or measured complete toolchain. Each
ELF's runtime dependency path list is separate from the union; both-role union stays
within the native reader's 32-dependency ceiling. Sysroot absolute symlinks refuse;
only bounded relative public-library resolution is supported.

Closed environment/HOME omission does not prove global Bun config execution was
disabled: pinned Bun documentation describes global/local merging. Enforceable
recipe facts are the empty cwd, explicit empty config, no-env-file and four
compiled-autoload-off flags. Global configuration execution remains unverified;
first real pinned-runner probes remain owed.
