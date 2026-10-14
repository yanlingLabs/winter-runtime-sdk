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

The mount-identity SOURCE successor removes Python's pre-exec NEWNS/unshare and
propagation mount only. The sealed eight-file loader chroot, C peer checks,
C detached clones then NEWNS/private propagation, UID/filter/limits and all case
oracles remain unchanged. Before chroot, every tree-clone filesystem descriptor
(reader/source/shared/six libraries) plus sealed root/launcher must return ordinary
STATX_MNT_ID in a bounded current mountinfo snapshot. The socket is internal sockfs,
not a filesystem clone input; its existing C peer/shape guards remain independent.
A second snapshot refuses concurrent namespace change. There is no unsupported
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
