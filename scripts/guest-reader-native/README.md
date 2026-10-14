# Reader-only hosted Linux harness source

This source is not execution admission. There is no workflow, CLI activation,
Core callback wiring, guided SDK profile, provider turn or VM launch in this
slice. Actual effects require a newly reviewed external parent on GitHub-hosted
`ubuntu-24.04-arm`; no self-hosted runner or local Mac/Linux VM is a venue.
The Mac two-disk, native-egress and GUI holds remain unchanged. No admission from
the earlier B fixture is reused.

`parent.py` validates the entire externally pinned 1472-leaf reader packet and
holds its descriptors. It then creates eight independent copies: the reader,
launcher and six explicit packet libraries. Files and view ancestors become
Root-owned `0555`, except the private view destination `0700`. The launch parent
must itself be Root-owned `0700` under protected Root ancestry. There is no
runner-library discovery or fallback, writable sealed runtime descriptor, or
import of captured project code. DATA intake modes are not execution authority.
The full packet capture needs 1629 descriptors; the actual parent preflights
only its own soft limit within a fixed allowed bound before capture.

`producer.py` registers one debt before effects and uses that same object for
the operation. The registry retains the actual operation before start, including
on failures; cleanup ownership never depends on traceback retention. Factories
must return the registered operation before effects or throw with none. A gated
child cannot bootstrap before its PID and pidfd are held.
The trusted single-thread Python child makes a private mount namespace and
minimal chroot before executing the dynamic launcher, so the launcher also uses
only packet libraries. Python, libc and the bootstrap are trusted host tooling,
not a measured complete toolchain. No PID namespace precedes C's original Root
peer check. Its stdin/stdout/stderr sources are distinct FIFO descriptors with
checked directions and no collisions with role descriptors. Runtime bytes are
rechecked before exec and after drain.

The collector attributes the received init pidfd using host proc observations
before writing request bytes. Request writes, bounded stdout (320 KiB), bounded
stderr (16 KiB), native control and launcher exit share an absolute deadline.
All installed rights are recovered before ancillary refusal; failed descriptor
closes retain ownership. Cancellation sends `K` or uses the held init pidfd while
preserving the monitor that emits `R`. A bounded two-second cancellation grace
does not convert uncertain debt to success. Uncertainty is monotonic, and a
cancelled lifetime stays cancelled even when its cleanup is later confirmed.
Actual `I`/`R`, matching launcher
wait, pipe EOF and descriptor closure are separate conjunctions. Partial setup
closes the unreleased gate and boundedly reaps the child; its cleanup is not a
successful native reader lifetime. Failures retain actual handles and debt.

`control.py` is trusted external source, separately hash-bound alongside the
parent. It only decodes control DATA; it cannot attest pidfds, peers or cleanup.
The injected pidfd validator, owner checks, socket factory and effect tables
are test seams, not native authority factories.

`fixture.py` prepares fixed readable readonly shared/source files and hidden
home/store canaries. Request framing is compact literal UTF8 JSON with no LF,
terminated by EOF, as required by the pinned RuntimeSDK transport. Responses
remain exactly one JSON line. Its oracle checks the exact echoed correlation and two
guidance blocks, hashes and provenance. Synthetic frames only test this oracle.
`native_cases.py` supplies callable, currently unexecuted, same-owner control,
unexpected-parent and parent-exit orchestration. Parent-exit keeps duplicated
control and stdin writer endpoints alive in the observer until actual init and
monitor pidfd readiness and adopted reaps, within three seconds from before fork
(before C's four-second deadline). Negative observations never invent `R` or
complete producer debt. Uncertain case handles remain available to their owner.

Portable validation is ordinary temporary DATA and injected operation tables:

```sh
python3 -I -S -B -m unittest discover -s scripts/guest-reader-native -p 'test_*.py'
```

These tests do not execute compiled outputs, native C, forks, namespaces, Root
guards or signals. Source contracts cannot establish the actual libc/Bun
compatibility of the no-dev/no-proc reader view. That compatibility and real
peer/PDEATHSIG/pidfd/reap/drain observations remain required by a future admitted
experiment and may fail legitimately. C's readonly empty cwd/HOME and the exact
six-variable environment must be observed; `configEffectProven` remains false.
Static autoload F evidence from the compile packet is separate from runtime
configuration behavior. No output or fixture deletion claim follows here.

The isolated reader provides only the reviewed tool-readable-bytes subset.
Atomic per-root attribution of racing source imports, tool-readable canonical
`/workspace/.winter/WINTER.md`, reader bridge/native owner integration, production
generation replay, cold/child continuity and the full guided guest turn remain
unimplemented. No personal memory, credentials, provider, production activation,
release or consumer pin is enabled.

The first hosted attempt (38559323552 at da51ed68) failed after successful
acquisition and complete DATA intake. Its retained result reports Uncertain /
ValueError with no finer cause or cleanup proof; it is not reader execution
success. The old admitted branch is frozen. The successor uses scalable readiness
for the many held capture descriptors. A high-FD DATA reproduction establishes the
old select() defect, without proving that it caused the hosted failure.

Successor failure observations contain only a closed stage, error class, literal
reason and allowlisted errno symbol. The reason tuple is mechanically generated
from literal require/Refusal/ValueError and exception-super constructor arguments
in the seven externally reviewed modules (plus fixed inline workflow literals);
computed messages remain unclassified. Tests compare the static tuple to that AST
inventory. A retained source lease tracks capture/copy/load and the case
run/verify/recheck/close phase, without changing uncertainty or cleanup outcomes.
The five harness modules come explicitly from the reviewed successor source
checkout; the compile DATA pin, acquisition and intake remain pinned to merged
4d5dfcec. Artifact, C, runtime roles, libraries and downloader are unchanged.
Fresh source/whole-chain review and a new one-run admission are required; the
failed attempt grants no retry, profile activation, guided turn or VM proof.

The next SOURCE successor preserves both failed hosted attempts and adds a
registered CLOEXEC exec-error pipe. The fixed eight-byte record contains only a
closed bootstrap step index and errno; the child writes it on pre-exec refusal
and exits 78. The writer never enters C argv or survives successful exec. EOF alone
also follows process death and is not exec proof. The intermediate H packet now
transfers exactly six descriptors: control, stdin writer, stdout reader, stderr
reader, launcher pidfd and bootstrap-error reader. Normal observations drain this
extra pipe within the original deadline; a failure record cannot become success.

Pre-I failure observations retain control packet size/tag/rights/EOF, bounded
4 KiB stderr classified only by the pinned C/header's exact static require labels
and closed errno text, and only actually reaped producer/launcher statuses. No raw
stderr or bootstrap bytes appear in result.json. The diagnostic projection accepts
an exact bounded typed schema; unknown or malformed snapshots remain unavailable.
No synthetic R, reset of uncertainty, changed deadline or cleanup success follows.
The C/table audit corrected three nested-call literals before this source freeze;
C, the compiled packet, libraries and acquisition/downloader are unchanged.
Another hosted attempt requires exact source/whole-chain review and fresh one-run
admission; no retry or activation is granted by these SOURCE changes.


Diagnostic errno coverage includes the fixed Linux exec/FD/mount error codes used
by this source recipe. A one-line, exact audited C label remains `audited_label`
when its errno text has no closed mapping; the text is discarded. Numeric native
errno 0 is interpreted with `nativeClassification`: `empty` has no error line,
`audited_label` has unmapped text, and `audited_perror` matched the fixed errno
renderer (including code 0). Linux errno 95 projects explicitly to `ENOTSUP`.
For bootstrap observations, `recordObserved:false` with errno 0 means no record;
`recordObserved:true` with errno 0 means an observed record with unknown errno.
Neither means that exec or cleanup succeeded. The correction changes no deadline,
case oracle, C bytes or compiled artifact.

The unpublished 19d mount-identity proposal below is superseded and was never run.
That SOURCE proposal removes Python's pre-exec NEWNS/unshare and
propagation mount only. The sealed eight-file loader chroot, C peer checks,
C detached clones then NEWNS/private propagation, UID/filter/limits and all case
oracles remain unchanged. Before chroot, every tree-clone filesystem descriptor
(reader/source/shared/six libraries) plus sealed root/launcher must return ordinary
STATX_MNT_ID in a bounded current mountinfo snapshot. The socket is internal sockfs,
not a filesystem clone input; its existing C peer/shape guards remain independent.
Two snapshots must match; equality does not rule out transient changes between reads. There is no unsupported
statx, missing-mask, unique-ID or pathname fallback. Failure emits the appended
closed bootstrap step `mount_identity` (index 10); existing step numbers are stable.

Kernel basis: Linux v6.12's [check_mnt and detached clone path](https://github.com/torvalds/linux/blob/v6.12/fs/namespace.c#L906)
compare an ordinary supplied mount with the current namespace; `open_detached_copy`
passes through `__do_loopback`, which can return EINVAL when that check fails.
[Namespace copying](https://github.com/torvalds/linux/blob/v6.12/fs/namespace.c#L3699)
clones mounts and updates filesystem root/cwd references, leaving earlier file
references attached to their old mount objects. This explains the SOURCE defect;
it is an inference for the hosted run, not a complete measured causal proof.
[statx implementation](https://github.com/torvalds/linux/blob/v6.12/fs/stat.c#L231)
returns the supplied path mount's ordinary ID for this mask. The
[UAPI layout](https://github.com/torvalds/linux/blob/v6.12/include/uapi/linux/stat.h#L94)
places the mask at byte 0 and mount ID at byte 0x90 in a 256-byte structure.

Portable regressions model old descriptor IDs versus copied namespace IDs, test
actual child-bootstrap ordering with every privileged operation replaced, verify
all supplied filesystem roles, and inject bounded statx/mountinfo results/failures.
They execute no mount, namespace, chroot, helper or compiled packet. Runtime
compatibility and the namespace hypothesis require a freshly reviewed hosted run.
All old experiment branches remain frozen; no retrospective cleanup claim follows.


The reopened-mount SOURCE successor instead creates Python NEWNS while still on
real `/`, makes real `/` recursively private, and nonrecursively binds the sealed
loader directory onto itself. It reopens the 11 filesystem inputs from canonical
protected paths derived solely from the sealed root and fixture. Every ancestor
is opened nofollow and checked Root-owned/nonwritable to other identities. Each
new descriptor must be distinct from original targets and match the already
hash-validated held input's dev/inode/type/uid/gid/mode/nlink/size/mtime/ctime and
readonly access; no additional 99 MiB rehash or host-library fallback occurs.
Ordinary mount IDs must belong to current mountinfo, and the loader root's
STATX_ATTR_MOUNT_ROOT must be explicitly supported and set. Only then are new
FDs installed onto original numbers, followed by sealed chroot and unchanged C
exec. Internal sockets/pidfds are never reopened; neither `/proc/self/fd` nor
pathname aliases can replace these comparisons. Newly acquired FDs get one close
attempt on failure; close uncertainty is retained, with no unmount/repair claim.

[Linux propagation checks](https://github.com/torvalds/linux/blob/v6.12/fs/namespace.c#L2544)
require a mountpoint. Chrooting into an ordinary directory alone does not supply
one; the self-bind plus explicit attribute check addresses that separate source
precondition. Earlier descriptor-mismatch causality remains unmeasured. Matching
before/after mountinfo snapshots report endpoint equality only, not absence of
transient changes. All C/artifact/deadline/case predicates remain unchanged.
Steps 11 `loader_bind` and 12 `reopen_inputs` append to stable existing indices.
Source/injected success is not hosted execution, cleanup, boot or activation proof.

The post-init diagnostic SOURCE successor adds only scalar observations on a
same-owner failure after both existing Observation and Reaps were captured. It
performs no new IO, waits, closure or cleanup. Raw validated terminal16-bit native,
launcher and producer wait statuses preserve normal exits versus signals/core bit;
null native status means missing actual R and is never replaced by zero. Existing
bounded captures supply full SHA256/byte counts and closed stdout LF framing.
The unchanged stderr classifier handles at most4096 bytes; valid captures above
that through the unchanged16384-byte limit report over_classifier_bound. No raw
content, path, PID, FD or object is attached or printed. Diagnostic/classifier/
projection failure reports available:false while preserving cause/debt/proof flags.
These hashes and lengths are ONLY for disposable fixed fixture data: never reuse
this diagnostic for real guidance, private instructions or personal memory.
The original success predicates, deadlines, C/artifact and close ordering remain
unchanged. Source review and new execution admission remain separate.


Fixture-only PUBLIC stderr successor (source, no run admission)

The failed D78 attempt 38637458454 remains frozen, failed and consumed. This
successor does not diagnose its signal 5/core-bit observation or confirm cleanup.
Only the existing same-owner failure path after captured Observation and Reaps
retains its bounded stderr bytes in the exception-owned handles. No new IO,
wait, process, cancellation, discharge, oracle, limit or deadline is introduced.

The hosted wrapper selects an immutable exact six-value host exec environment
before case effects, rejects missing/extra/changed values, and forwards that same
record through NativeOperation and child_bootstrap to os.execve. This is the
actual host argument, not an observation of the eventual C child environment.
The unchanged C literal environment remains source evidence only.

A lexical exporter is prepared only after the existing hosted Root source guard,
full fixed compile DATA validation, fixed fake fixture creation and exact packet,
request, shared/source view and fake file hash checks. It cannot mint native
admission. Production, Core, owner and VM code import no exporter. A capture is
exportable only for a same-owner failure with complete scalar post-init evidence.
The entire already-captured stderr (at most 16384 bytes) is checked before taking
a prefix. Credential patterns gh[pousr]_, github_pat_, Authorization, Bearer,
AKIA, PEM BEGIN, and Base64-like runs of 40+ characters reject export rather than
redact. False refusal is accepted. This mechanical scrub is not a secret detector
for general/private content: all sample bytes are PUBLIC, cacheable fixture DATA,
and real guidance, credentials, user directories or provider content must never
reuse it.

The exact result.json alone holds postInitStderrSample. Available samples have
exact keys available, bytesBase64, truncated, sampleSha256; the prefix is at most
4096 bytes, canonical Base64 at most 5464 characters, and its SHA is checked.
Truncation is tied to the original complete stderr length; when untruncated its
SHA equals the original full hash. The original twelve-key postInitDiagnostics
is unchanged. Unavailable results carry only available:false plus a closed
reason. Malformed projections fail unavailable and retain the original cause,
stage, debt and false proof flags. CI stdout/summary uses log_result_projection,
which omits bytesBase64 and retains only availability/reason/truncation/hash.
Evidence collection must compare that scalar projection to the actual CI JSON,
not deep-equal the full artifact when a sample is present; retain/hash the exact
artifact before offline canonical decoding. No raw or Base64 sample is printed.

New branch cowork/reader-hosted-fixture-stderr requires fresh exact Root/45/Astra
source review and separate one-run admission; no push, native execution, retry or
availability follows from portable tests or this source.


Closed crash-report-family classifier (source, no run admission)

The consumed fixture-stderr attempt returned an unrecognized 718-byte stderr whose
public sample was `scrub_rejected`: Bun's standard crash banner starts with a 60-character
`=` line, which the unchanged 40+ character long-run scrub rejects. That scrub, the
`postInitStderrSample` semantics, the twelve-key `postInitDiagnostics` and every existing
key, flag, stage, debt, hash, deadline and close ordering stay as they were. This slice adds
one orthogonal label that exports no content. It is not a cause, not an authenticated
reached-phase receipt and not a success oracle; a runtime report is untrusted text.

`native_cases.classify_report_family` reads only `handles.fixture_stderr_capture` (the
complete bounded same-owner capture, at most 16384 bytes) and returns exactly one literal
of `bun_report_shape`, `webkit_assertion_shape`, `loader_error_shape`, `unknown`,
`incomplete` or `classification_error`. It never decodes the bytes and derives nothing else
from them: no line, token, address, function, path, URL, count, length or hash. It never
emits a specific cause such as a missing device or `/proc` file. It runs inside the same
`kind == 'same-owner'` failure gate, after the existing Observation and Reaps were captured,
in its own `try` after the unchanged diagnostics, so neither can alter the other, the
original refusal, the retained handles or cleanup. The wrapper's exporter does not call it.

Recognition is a fixed grammar over whole lines, matched against the whole buffer. A family
is reported only when the buffer is exactly one complete report of that grammar. Extra,
missing, reordered or duplicated lines, a second report, ANSI escapes, CR, NUL, any byte
outside 0x20-0x7e (so any malformed UTF-8), text before or after the report, and a lookalike
inserted label are `unknown`. `incomplete` means the family's opening frame matched in full
(Bun: the 60-`=` line with its LF; WebKit: the complete first line; ld.so: the program name
and the occasion literal, or the `: version \`` prefix of a missing-version line) and the buffer then stops inside the grammar, at a line boundary or
inside a line that is a prefix of the next expected line. Empty input is `unknown`. Any
exception, a non-`bytes` value or more than 16384 bytes is `classification_error`.

`bun_report_shape` is Bun's Linux, plain-stderr banner, 1.3.x only (derived at oven-sh/bun tag
bun-v1.3.14, src/crash_handler/crash_handler.zig, and read against public 1.3.0-1.3.14 reports;
the long-run `=` line and the bun.report URL are the reason the sample is rejected): 60 `=`
(260); `Bun [Canary ]v<semver>[-canary.N][ (<sha>)] Linux arm64|x64[ (baseline)]` (850-864,
Global.zig:20-27); `Linux Kernel v<d>.<d>.<d> | glibc v<ver>|musl` (1009, 1013); optional `CPU:`
with the CPUFeatures flags in field order (1029-1031); `Args: "..."` (1033-1043); optional
`Features:` and `Builtins:` lines, each token followed by a space, so the line ends in one
(analytics.zig:129-161); optional `Elapsed:`/`RSS:` pair (1066-1083); a blank line (1089);
optional x64 AVX warning (1091-1094); `panic[(main thread)]: <printable reason>` (306-332), absent
only for the out-of-memory variant (301), optionally followed by exactly one empty line (a
message that itself ends in LF, as `Output.panic("...\n")` produces, is followed by line 332's
own LF; the reason stays one line of printable ASCII, at most 1024 bytes); optional `Crashed
while ...` (336); `oh no: Bun has crashed. This indicates a bug in Bun, not your code.` or `oh
no: Bun has run out of memory.` (424, 415); blank, the two `To send a redacted crash report...`
lines and a blank (424-430); ` https://bun.report/<semver>/<L|l|B><command char><1|2><7 hex|
unknown><trace>` (438-446, 1358-1368); a final blank line (448, 454).

The grammar is version-specific. Bun 1.4.x prints `RSS: 14.82 MB` with a space, a 9-hex sha and
a blank line before `Elapsed:`, so its banner is `unknown`; a Bun bump needs the grammar
re-derived from that tag, not assumed. Also `unknown`: ANSI-coloured banners (the colour flag
defaults to on until `Output.Source.Stdio.init` runs, main.zig:58, output.zig:425, and then
follows the stderr TTY unless `FORCE_COLOR` is set, output.zig:381-408 and 103-119; the harness's
pipe and six-variable environment give the plain form after init, so only a crash before init is
coloured), Debug, non-Linux and WSL banners, native-plugin and libuv message blocks,
"multiple threads are crashing", "panicked during a panic", and any text before or after the
banner. That includes the x64 `warn: CPU lacks AVX support, strange crashes may occur...`
preamble that Bun writes to the same stderr at startup (c-bindings.cpp:26-41, called at
main.zig:59): preamble plus banner is two things, so it is `unknown`.

`webkit_assertion_shape` is WTF's assertion text (oven-sh/WebKit 5488984d,
Source/WTF/wtf/Assertions.cpp, StackTrace.cpp): `ASSERTION FAILED: <expr>` or `SHOULD NEVER
BE REACHED` (275-282), or the formatted-message form with a following assertion line
(284-292); the call site `<file>(<n>) : <function>` (265); then either no backtrace, frame
lines `%-3d %p <name>` numbered 1..N with N at most 31 (StackTrace.cpp:162, StackTrace.h:149,
Assertions.cpp:315), or the unterminated `no stacktrace available` (357). Release `CRASH()` is
`std::abort()` (Assertions.h:353), which Bun does not catch. The source has no end marker, so
a buffer cut exactly after the call site or after a frame line is indistinguishable from a
shorter trace and reads as complete; only the existing complete bounded capture excludes that
case. A developer-mode crash that adds a Bun banner is two reports and is `unknown`.

`loader_error_shape` is glibc 2.39's ld.so (bminor/glibc ef321e23): the single fatal line
`<program>: error while loading shared libraries|symbol lookup error|version lookup error:
<printable text>` (elf/dl-catch.c:79-91, with the occasions at dl-catch.c:85,
dl-lookup.c:813 and dl-version.c:147), or one to sixteen rtld.c lines `<program>: <object>:
version \`<v>' not found (required by <requirer>)` (rtld.c:2422-2427, dl-version.c:142-144).
`<program>` is `[A-Za-z0-9_./+@%-]{1,255}` (no space or colon) or `<program name unknown>`
(ldsodefs.h:179); an occasion line's remainder is 1-2048 printable ASCII bytes. A seventeenth
missing-version line, weak-version lines, a program name outside that charset, any other ld.so
fatal shape (ELF-class, exec and debug output) and anything beside the one report are `unknown`.

`failure_record` adds the always-present key `postInitReportFamily`, a single string from
the six values above plus `not_same_owner_failure` (another case kind, or a failure before any
case stage) and `capture_absent` (a same-owner stage without a complete bounded capture: before
the existing Observation and Reaps, no handles after a launch or a later-phase failure, or no
bytes capture inside the bound). Where a failure carries no handles, the family follows the
case stage exactly as the sample reason does: a `case:same-owner:*` stage reports
`capture_absent`, anything else `not_same_owner_failure`. The two markers mirror the
`postInitStderrSample` reasons of the same names by case kind and capture presence, NOT by
provenance: the family deliberately skips the exporter's provenance gate (`provenance_unverified`
never applies to it), because only a closed enum leaves, never content. Any other value, a read
failure, or a recognized family beside post-init evidence of an empty stderr becomes
`classification_error`. `log_result_projection` passes only those values. The sample can still
be `scrub_rejected` for a recognized report, and then no sample bytes, Base64, hash or
content-derived value exist outside the pre-existing `stderrSha256`.

Portable fixtures are whole buffers: synthetic ones for every variant, plus four real public
Linux banners kept verbatim from oven-sh/bun issues 32418 (arm64, 1.3.14), 25105, 28648 (Canary
1.3.11) and 24290 (the x64 AVX line), a real 1.4.2 banner (44276, `unknown`) and the hand-trimmed
paste of 32701 (not a whole report). The only edits are LF line endings, the trailing space on
`Features:`/`Builtins:` lines where the paste lost it, and the closing blank line where the paste
dropped it; the text is public and nothing else is removed. `test_report_family.py` covers each family,
all CPU flag subsets and optional-line combinations, truncation at every byte boundary,
single-line insertion, deletion, duplication and swapping, inserted family labels, ANSI,
lookalikes, malformed UTF-8 and non-printable bytes at every position, multiple reports,
empty/oversized/non-bytes input, forbidden secret tokens in every free-text region (family
reported, sample still `scrub_rejected`), classifier exceptions in both directions, the gate
for every case kind, bounded time on adversarial input, and that every source-hash pin names
the bytes present. The classifier changed `native_cases.py`, so `wrapper.py`'s pin for it, the
reviewed workflow's `bootstrap.py` and `wrapper.py` pins and the release-gate test were
recomputed together. Branch `cowork/reader-report-classifier` is not named by the reviewed
workflow, which still admits only `cowork/reader-hosted-fixture-stderr`; no push, native
execution, retry, workflow change or run admission follows from this source.
