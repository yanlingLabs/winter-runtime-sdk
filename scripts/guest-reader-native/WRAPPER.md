# External parent wrapper source

`acquisition.py` is unprivileged, local ZIP DATA handling. It has no downloader,
token or entrypoint. Production metadata and outer hash are fixed to artifact
11866353126/run38502659264. Its bounded central/local parser admits exactly
`reader-packet.tar.gz` and `packet-inventory.json`. The inflater uses only captured
bounded ranges, never a second mutable metadata parser; exact termination, CRC
and output caps precede SHA checks. Both inner streams are hashed
before creating output. Copying repeats the hash checks and retains an incomplete
private directory on failure, without calling it valid. Expiry at
2026-10-21T02:45:33Z refuses; no reupload/retention workaround. This validates the
container and two member bodies, not the inner tree (1472 leaves for the reviewed two-artifact
packet; the three-artifact packet's count is a measured value pinned at repin). The merged intake
and parent perform that later complete validation.

Future acquisition permissions are `contents:read` and `actions:read`. The token
belongs only in the download action's `with.github-token`, never environment,
`GITHUB_ENV`, Python or a privileged command. No workflow is added here. The outer
ZIP (81,095,921 bytes) and its hash are distinct from the inner archive
(81,359,155 bytes). All acquisition execution/admission flags remain false.

`wrapper.py` is callable source, not a native admission mechanism. Its own bytes
must be separately admitted by an external reviewed workflow before any Root
execution with `python3 -I -S -B`. Host Python/libc/kernel are trusted tooling,
not a measured complete toolchain. It copies exactly five unchanged reviewed
harness modules plus the separately hash-bound compile pin JSON as DATA into
fresh protected Root ancestry. All source bytes are bounded/hash-checked before
destination creation; copies are independent, readonly and rechecked before
every import and at the end. No packet Python, filesystem module fallback,
`sys.path` insertion or pycache is used. Only those exact held bytes enter the
five module aliases; `producer` and `control` satisfy trusted internal imports.
The external pin is passed by its explicit copied path, so relocation cannot
fall back to a nonexistent sibling checkout.

Owner/pin injection only supports portable DATA tests. Synthetic leases cannot
run native cases. The callable case set consumes the acquisition DATA record,
cross-checks its metadata, outer hash, both member hashes/sizes and observation
flags against pins, and checks expiry before imports/effects. This is record
correlation, not stronger provenance or native authority. It then requires actual
isolated Linux Root. That
predicate is not hosted-runner provenance or a production native capability.
The future external chain must independently bind the download, complete packet,
source bootstrap and approved venue before choosing to invoke this function.

The wrapper retains the source lease, complete snapshot, launch root (nine copied
objects plus the Root-created canary leaf) and fixed fixture on any uncertain outcome, including `CaseUncertain`'s
actual descriptors. It invokes the dependency-probe case first, then only the
existing same-owner, unexpected-parent and parent-exit cases. The probe uses the
reader's exact launch envelope through a factory closure that differs only in
`executable_role`, runs under the stages `case:dependency-probe:run|verify|recheck`
and leaves its closed `dependencyProbe` record on the lease (and on the handles
when it raises). That record is data beside the case set, never a reader success:
`readerCaseSetPassed` stays decided by the three reader cases, the record's
`readerSuccessImplied` and `bunCompatibilityProven` are constant false, and only a
teardown failure (`CaseUncertain`) stops the set. The record of such a failed case
reports an `unknown` line and `unknown` canary halves, never `not_visible`. The
wrapper hands the probe case the exec environment it gives the operations, which
the record's `viewContractSha256` is computed from, and the Root stage projects
the success record through the bootstrap's closed validator before it is written. Its canary halves, where only
ENOENT counts as not visible, are described in `README.md`. Actual source/context
rechecks happen after every case;
the positive frame uses the exact existing consumer oracle. Runtime and fixture
destinations are fixed fresh siblings under the same protected parent. No
directory deletion, unmount, repair, retry or sealed-stage cleanup is claimed.
Only confirmed case resources close on success; cancellation/uncertainty is never
converted into successful native lifetime.

Portable checks create ordinary temporary files/ZIPs, execute inert test-source
copies and inject orchestration tables. They do not run compiled ELF, Root guards,
native helpers, namespaces, forks or signals. Read-only inspection of the retained
actual ZIP verified its outer and both inner hashes without extraction/import or
output copying. Existing 13 harness files, C/header, two ELF roles, six libraries,
compiled packet and B remain unchanged.

No native experiment, workflow push, production profile/provider/Core activation,
SDK19 merge, release or consumer pin follows. Actual no-dev Bun/libc behavior,
owner/view/parent-death/reap/drain, canonical tool alias and atomic per-root
attribution remain required future gates. `configEffectProven`, guided turn, VM,
production activation and removal flags stay false.

The closed report-family classifier lives in `native_cases.py` (a pinned module), not in
`wrapper.py`: it labels the retained same-owner stderr capture and does not consult, relax
or replace the exporter's full-capture scrub, whose regex, provenance checks and
`postInitStderrSample` shapes are unchanged. Its separate `postInitReportFamily` value is
non-secret and appears in both `result.json` and `log_result_projection`. It mirrors the case
kind and capture presence of the sample reason, not its provenance: only a closed enum leaves, so
the family deliberately skips the exporter's provenance gate. Because it changes
`native_cases.py`, the `SOURCE_PINS` entry for that module in `wrapper.py` and the reviewed
workflow's `bootstrap.py` and `wrapper.py` pins are recomputed together; the compile-packet
and acquisition pins and every workflow branch name are untouched. The grammar, gating and
non-claims are in `README.md`.
