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
