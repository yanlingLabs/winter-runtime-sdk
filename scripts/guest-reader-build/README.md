# Reader-only compile packet — source prerequisite

This new unprivileged builder captures RuntimeSDK 0394, SDK 8603, the four builder source files and only the exact
SDK19 reader C, reader dependency-probe C and header overlay (three files, each checked
against `OVERLAY_SOURCE_SHA256`). The main SDK header must equal the overlay header.
Source bytes must match the pinned Git trees, and all dependencies and relative
alias resolutions remain inside the new packet. SDK-family aliases select all six
captured 0.0.53 source packages; published 0.0.28/global resolution refuses. No
production manifests, dependency installations, consumer pins or B paths change.

The eventual ordinary Linux ARM64 CLI compiles only the actual private reader
entry, its native reader launcher and the native reader dependency probe, records
individual recursive ELF dependency files, and never executes an output. It requires official pinned Bun 1.3.14
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

The pinned compiler recipe rejects opaque nonliteral dynamic specifiers rather than
adding a resolver fallback; optional literal imports remain outside that proof. The normalized metafile proves only its recorded static inputs;
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

The first compile-only job (38494750351) acquired the pinned compiler but refused
before positive reader/C compilation or packet upload: Bun 1.3.14 returned zero
for the bogus-long-option probe. Its pinned parser skips unknown long options;
repositioning that option cannot establish semantic recognition. No artifact or
complete reader receipt was produced. This source successor has not been compiled.

The replacement gates are complementary compiler/data measurements:

- Four same-recipe negatives append each autoload-positive counterpart, plus a
  reject/allow-unresolved conflict. Each requires exit 1, empty stdout and output
  directory, and the exact pinned one-line conflict diagnostic.
- Compiler-only default/all-enabled controls must decode low flag nibbles 0xC/0;
  the actual reader must decode 0xF. The bounded pinned ELF64/AArch64 decoder binds
  the original base .bun pointer slot to the relocated output payload through
  unique file/virtual PT_LOAD mappings. It checks exact section size, the 32-byte
  Offsets record, the **16-byte** trailer, reserved zero bits and empty NUL-ended
  compile argv. Decoded base/output hashes must match their measured bytes.
- A fixed live nonliteral import expression must refuse with reject-unresolved
  and the full source-derived error/note codeframe envelope; without the flag it
  compiles only as data. Optional literal imports and runtime import completeness
  remain unverified. Missing-original metafile records remain explicit ambiguity;
  literal dynamic records still require measured bundled targets. The metafile
  cannot independently establish absence of opaque runtime imports.

Each bounded observation (exit, stdout/stderr hashes, output inventory, malformed
capture/inventory refusal) is written before semantic refusal. Measurement sources
and ELF controls live outside the packet and are never admitted or archived as
executable roles; exactly the reader, its launcher and the dependency probe remain
admitted compile outputs. No output is executed. The first reviewed new job must confirm the exact
source-derived diagnostic envelopes or fail honestly; portable fixtures do not
establish real compiler behavior. The copied Linux base is rehashed after compiling.

These checks are specific to Bun source
[0d9b296](https://github.com/oven-sh/bun/tree/0d9b296af33f2b851fcbf4df3e9ec89751734ba4):
Arguments.zig conflict handlers, Context.zig defaults, StandaloneModuleGraph.zig
Offsets/read path, exe_format/elf.zig slot writes, and P.zig opaque-import handling.
Compiler flags, embedded bits and parser effect do not prove autoload execution or
global configuration behavior. All execution/authority flags remain false.

Directory intake streams before count limits. Capture timeout/overflow/setup errors
signal the still-unreaped owned process group before a bounded one-second wait;
uncertain reaping refuses, with both pipes closed. After normal EOF and a reaped
leader, including a nonzero exit, no later numeric PGID signal occurs and no
descendant-termination proof is claimed. Inert mock regressions cover these cases.

The compile recipe uses gnu11; SDK19's historical full-role object source proof used
c11. This is a distinct recipe requiring fresh ordinary build review. Native cc1/as/ld
and compiler-opened headers are not a sealed or measured complete toolchain. Each
ELF's runtime dependency path list is separate from the union; the three-role union stays
within the native reader's 32-dependency ceiling. Sysroot absolute symlinks refuse;
only bounded relative public-library resolution is supported.

Closed environment/HOME omission does not prove global Bun config execution was
disabled: pinned Bun documentation describes global/local merging. Enforceable
recipe facts are the empty cwd, explicit empty config, no-env-file and four
compiled-autoload-off flags. Global configuration execution remains unverified;
first real pinned-runner probes remain owed.

The two executing Python source files are hashed before helper exec_module and
reobserved afterward, then compared with the four-file builder capture. These are
bounded observations, not executed-source authentication: Python may have loaded
different/cached code, and capture is not a sealed interpreter/code-loader proof.

Compiler/Git descendants that closed inherited pipes before normal leader reaping
are accepted only for this ephemeral ordinary CI fixture. Their termination is
not proven. Future artifact workflow must place --out outside the checkout and
outside a RUNNER_TEMP ancestor carrying resolver config; the explicit ancestor
checks govern. Import targets use only the captured bundled manifest graph, with
one fixed importer-directory base for explicit ./../ edges, absolute paths as-is,
and exact raw-key matches for other supported spellings. Unsupported extensionless
paths refuse; there is no importer/build-cwd fallback or filesystem search.

After canonicalization, decoded metadata/receipt keys and values are checked for
the private packet path anywhere, including composite strings and file URLs. A
match refuses before writing a normalized metafile or receipt; it is not silently
redacted. Raw failed compiler evidence may remain locally for inspection and is
not a valid emitted packet. The separate branch-scoped source workflow runs only
these portable Python/Git-data/mock checks; it performs no artifact compilation.

The separately reviewed diagnostic run38500676309 retained a bounded raw reader
metafile after the unchanged unsupported-spelling refusal; it is diagnostic-only,
not a normalized/admitted packet. Its three rejected imports were nonexternal
literal SDK-family package spellings (SDK root twice, catalog/families once).
This successor resolves only those family aliases through the captured package's
exact export key and source `bun` condition. Alias identity, package name/version,
manifest bytes and an already measured **bundled** target must agree. Pattern,
nested/unknown condition, dist, outside, missing/unbundled and foreign package
fallbacks refuse. The raw bare spelling and manifest hash remain separate derived
resolution evidence; missing compiler `original` remains counted as ambiguity.
No new compiler run, packet or runtime/native execution follows from this source.

Bare-cache evidence follows pinned
[bundle_v2](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/bundler/bundle_v2.zig#L3323-L3344):
the source-index cache-hit branch retains bare path text after prior resolution;
the new-file branch discloses its absolute target. Every derived export therefore
requires a disclosed absolute inbound edge to that same canonical input. Disclosed
same-specifier edges from the same origin must agree. Export condition order is
pinned to `types`, `bun`, `default`, placing the source bun condition before the
unconditional default. Staged tsconfig.json/jsconfig.json in importer ancestry
and nearer family aliases refuse; this helper never models their path overrides.

## Dependency probe (third compiled artifact)

`artifacts/instructionReaderDependencyProbe` is compiled from the overlay's
`linux-instruction-reader-dependency-probe.c` with the identical `NATIVE_FLAGS` and the
same single argv builder (`native_command`) as the launcher; only the source and `-o` differ. It
is a dynamic ELF like the launcher. Its dependency under test is the packet's own pinned libc,
so there is no static probe: the build refuses a probe without an interpreter, and refuses a
probe whose recursive library paths are not a subset of the reader's and launcher's, so the
packet keeps its six libraries. The receipt `commands` gain `nativeProbeCC` beside `nativeCC`.

The probe reuses the one excluded scratch path `artifacts/native.d` sequentially: the launcher
depfile is read and removed, the probe compile writes it fresh, and the two header observations
merge into one `systemHeaders` map. A header seen by both compiles with different bytes refuses.
The scratch stays a single path, so the workflow's exclusion and the inventory's
`excludedScratch` do not change.

`OVERLAY_SOURCE_SHA256` (C, probe C, header) in `provenance.py` holds the hashes of those three
files at agent-sdk 687b9557. `OVERLAY_HEAD` is a separate pin and moves to the final agent-sdk head
on its own; the three sources must be byte-identical there, which the per-file pin check enforces
before any output exists. Tests inject their own pins the same way they inject heads. Like every
source test, none of them compiles anything, and no test executes the probe or any other output:
the injected runner only writes inert bytes.
