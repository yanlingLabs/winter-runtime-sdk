"""SOURCE ONLY Linux reader cases. No entrypoint or native admission.

Actual effects below are for a newly admitted hosted ubuntu-24.04-arm run only.
Portable tests supply an entirely inert effect table. Negative evidence is
independent of producer Debt: no forged R, finish_registered or complete call.
The intermediate producer uses the unchanged sealed-root bootstrap and ENV.
"""
import array
import ctypes
import os
import selectors
import socket
import struct
import time
from dataclasses import dataclass

from producer import (Registry, Refusal, IO_MAX, parse_receipt, require,
                      root_linux, start_registered, validate_init_pidfd,
                      BOOTSTRAP_ERRNOS, decode_bootstrap_record)

KINDS = ('same-owner', 'unexpected-parent', 'parent-exit')
NEGATIVE_SECONDS = 3.0  # From BEFORE fork, strictly before C's 4000ms deadline.


@dataclass
class Handles:
    producer_pid: int
    producer_pidfd: int
    transport: object
    launcher_pid: int | None = None
    launcher_pidfd: int | None = None
    control: object = None
    stdin: int | None = None
    stdout: int | None = None
    stderr: int | None = None
    bootstrap_error: int | None = None
    init_pid: int | None = None
    init_pidfd: int | None = None
    retained: bool = True
    subreaper_before: int = 0
    producer_owned: bool = False
    launcher_identity_validated: bool = False
    initial_control: object = None
    preinit_diagnostics: object = None
    received_handles: object = None
    preinit_launcher_wait_status: int | None = None
    preinit_producer_wait_status: int | None = None


@dataclass(frozen=True)
class Observation:
    launcher_ready: bool
    init_ready: bool
    stdout_eof: bool
    stderr_eof: bool
    control_eof: bool
    stdout: bytes
    stderr: bytes
    native_wait_status: int | None = None  # Only an actual decoded R packet.
    bootstrap_eof: bool = False
    bootstrap_record_observed: bool = False


@dataclass(frozen=True)
class Reaps:
    producer_status: int
    launcher_status: int
    init_status: int | None  # None only if monitor actually reaped init (real R).


@dataclass(frozen=True)
class CaseEvidence:
    kind: str
    original_socket_owner: str
    validated_init_pid: int | None
    input_bytes: int
    keepalive_before_parent_exit: bool
    elapsed_seconds: float
    observation: Observation
    reaps: Reaps
    descriptors_closed: bool
    config_effect_proven: bool = False


class CaseUncertain(Refusal):
    """Expose retained actual handles instead of silently discarding debt."""
    def __init__(self, handles, cause):
        super().__init__('native case uncertain; ownership retained')
        self.handles, self.cause = handles, cause


def run_case(kind, operation_factory, request=b'', *, effects=None):
    """Factory(debt, pair_factory) must build the trusted NativeOperation.

    pair_factory is None for both valid-owner shapes; unexpected-parent gets a
    one-use ancestor-created SOCK_SEQPACKET pair. Factory must retain sealed root
    contexts and their guard/recheck. This API creates no permission mechanism.
    """
    require(kind in KINDS, 'closed native case kind')
    require(type(request) is bytes, 'request bytes')
    require((kind == 'same-owner' and 0 < len(request) <= 16384)
            or (kind != 'same-owner' and request == b''), 'case input shape')
    fx = effects if effects is not None else LinuxEffects()
    started = fx.now()
    deadline = started + (6.0 if kind == 'same-owner' else NEGATIVE_SECONDS)
    handles = fx.launch(kind, operation_factory, deadline)
    try:
        fx.receive_handles(handles, deadline)
        input_bytes = 0
        if kind != 'unexpected-parent':
            # No input, EOF or parent-exit command precedes actual I attribution.
            fx.receive_init(handles, deadline)
            require(type(handles.init_pid) is int and handles.init_pid > 1
                    and handles.init_pidfd is not None, 'validated init required')
        if kind == 'parent-exit':
            fx.verify_keepalive(handles)
            fx.exit_parent(handles, deadline)
        elif kind == 'same-owner':
            input_bytes = fx.send_request(handles, request, deadline)
            require(input_bytes == len(request), 'complete request write')
        observed = fx.observe(handles, deadline)
        require(observed.launcher_ready and observed.stdout_eof and observed.stderr_eof
                and observed.control_eof, 'independent launcher and pipe teardown')
        if handles.bootstrap_error is not None:
            require(observed.bootstrap_eof and not observed.bootstrap_record_observed,
                    'bootstrap pipe drained without failure record')
        if kind == 'unexpected-parent':
            require(handles.init_pid is None and handles.init_pidfd is None
                    and observed.native_wait_status is None and observed.stdout == b'',
                    'pre-init unexpected-parent refusal')
        else:
            require(observed.init_ready, 'independent init pidfd teardown')
        reaps = fx.reap(handles, kind, observed, deadline)
        require(reaps.producer_status == 0, 'producer actually reaped exit zero')
        if kind == 'unexpected-parent':
            require(os.waitstatus_to_exitcode(reaps.launcher_status) == 64,
                    'unexpected-parent exact native refusal')
        if kind == 'same-owner':
            require(observed.native_wait_status == 0 and reaps.launcher_status == 0
                    and observed.stdout.endswith(b'\n') and observed.stderr == b'',
                    'same-owner native control outcome')
        if kind == 'parent-exit':
            require(os.waitstatus_to_exitcode(reaps.launcher_status) == -9
                    and reaps.init_status is not None
                    and os.waitstatus_to_exitcode(reaps.init_status) == -9,
                    'producer death killed launcher and adopted init')
        elapsed = fx.now() - started
        require(0 <= elapsed < deadline - started, 'bounded case before native deadline')
        fx.close_confirmed(handles)
        require(not handles.retained, 'confirmed descriptor discharge')
        elapsed = fx.now() - started
        require(0 <= elapsed < deadline - started, 'descriptor discharge before case deadline')
        return CaseEvidence(kind, 'ancestor' if kind == 'unexpected-parent' else 'producer',
                            handles.init_pid, input_bytes, kind == 'parent-exit', elapsed,
                            observed, reaps, True)
    except BaseException as error:
        # Do not close deliberate keepalives, synthesize terminal receipts, or
        # lose pidfds on uncertain cleanup. External owner must inspect handles.
        if kind != 'unexpected-parent' and handles.init_pid is None \
                and hasattr(fx, 'diagnose_preinit'):
            try: fx.diagnose_preinit(handles, deadline)
            except BaseException: pass  # Original refusal/debt is never replaced.
        raise CaseUncertain(handles, error) from error


def recv_rights(sock, maximum, owner=None, packet_attribute=None):
    """Recover all delivered rights before checking envelope/truncation."""
    data, ancillary, flags, _ = sock.recvmsg(32, socket.CMSG_SPACE(32 * 4),
                                          socket.MSG_CMSG_CLOEXEC)
    rights = []
    try:
        for level, kind, raw in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array('i'); values.frombytes(raw[:len(raw) // 4 * 4])
                rights.extend(values)
        if owner is not None:
            owner.received_handles = list(owner.received_handles or []) + rights
            if packet_attribute is not None:
                setattr(owner, packet_attribute, control_observation(data, rights))
        require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), 'case receipt truncation')
        require(len(rights) <= maximum and all(level == socket.SOL_SOCKET
                and kind == socket.SCM_RIGHTS and len(raw) % 4 == 0
                for level, kind, raw in ancillary), 'case ancillary envelope')
        return data, rights
    except BaseException as error:
        if owner is None and rights:
            # No implicit closure/discharge on malformed envelopes. All installed
            # rights remain visible to the actual caller, including extra rights.
            raise CaseUncertain(tuple(rights), error) from error
        raise


def control_observation(data, rights):
    require(type(data) is bytes, 'control observation bytes')
    tag = 'EOF' if data == b'' else 'I' if data[:1] == b'I' else 'R' if data[:1] == b'R' else 'other'
    return {'packetObserved': True, 'byteCount': len(data), 'tag': tag,
            'rightsCount': len(rights), 'eof': data == b''}


# Exact static require/perror labels audited from pinned C/header sources.
STDERR_LABELS = ('bind', 'bind flags', 'fixture path', 'reader Root peer', 'reader admitted clone',
    'reader bounding capabilities', 'reader close-on-exec',
    'reader directory mountpoint', 'reader empty readonly cwd', 'reader explicit pipe',
    'reader explicit pipe-only envelope', 'reader file mountpoint',
    'reader immutable exec', 'reader immutable file', 'reader independent primary gid',
    'reader independent uid', 'reader inherited descriptor', 'reader monitor control',
    'reader monitor control copy', 'reader monitor death', 'reader monitor init',
    'reader monitor init copy', 'reader monitor originals', 'reader monotonic deadline',
    'reader mount attach', 'reader namespace init', 'reader namespace kill',
    'reader namespace pidfd', 'reader namespaces', 'reader no new privileges',
    'reader parent pidfd', 'reader pipe descriptor', 'reader pipe flags',
    'reader private propagation', 'reader private temporary files',
    'reader readonly skeleton', 'reader receipt type',
    'reader recursive mount flags', 'reader resource ceiling', 'reader root', 'reader seccomp',
    'reader selected directory', 'reader selected workspace group', 'reader service death',
    'reader service pidfd', 'reader setup monitor death', 'reader shared identity',
    'reader skeleton', 'reader skeleton ancestor', 'reader source identity', 'reader surviving pipe',
    'reader view ancestor', 'reader view cwd', 'reader view ownership', 'reader view root',
    'reader zero capabilities', 'seccomp')


def classify_stderr(raw):
    require(type(raw) is bytes and len(raw) <= 4096, 'diagnostic stderr bound')
    result = {'byteCount': len(raw), 'classification': 'empty' if not raw else 'unrecognized',
              'label': 'unknown', 'errno': 0}
    for label in STDERR_LABELS:
        for code in BOOTSTRAP_ERRNOS:
            if raw == (label + ': ' + os.strerror(code) + '\n').encode('utf-8'):
                return {**result, 'classification': 'audited_perror', 'label': label, 'errno': code}
    return result


def poll_ready(readers=(), writers=(), timeout=0):
    """Readiness without select()'s FD_SETSIZE ceiling. No ownership is inferred."""
    with selectors.DefaultSelector() as poll:
        for fd in readers:
            poll.register(fd, selectors.EVENT_READ)
        for fd in writers:
            poll.register(fd, selectors.EVENT_WRITE)
        events = poll.select(timeout)
        return ([key.fd for key, mask in events if mask & selectors.EVENT_READ],
                [key.fd for key, mask in events if mask & selectors.EVENT_WRITE])


def ready(fd, deadline):
    left = deadline - time.monotonic()
    require(left > 0 and poll_ready([fd], timeout=left)[0], 'case absolute deadline')


class LinuxEffects:
    """Unexecuted real Linux effects; constructing the table has no effects."""
    def now(self):
        return time.monotonic()

    def launch(self, kind, factory, deadline):
        root_linux()
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                              ctypes.c_ulong, ctypes.c_ulong]
        libc.prctl.restype = ctypes.c_int
        # Register resources immediately, including incomplete pre-fork setup.
        h = Handles(0, -1, None)
        h.subreaper_changed = False
        pair = None
        child_transport = None
        try:
            before = ctypes.c_int()
            require(libc.prctl(37, ctypes.addressof(before), 0, 0, 0) == 0, 'get subreaper')
            h.subreaper_before = before.value
            require(libc.prctl(36, 1, 0, 0, 0) == 0, 'ancestor subreaper')
            h.subreaper_changed = True
            h.transport, child_transport = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            if kind == 'unexpected-parent':
                pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            pid = os.fork()
            if pid == 0:
                try:
                    h.transport.close()
                    pair_used = False
                    def ancestor_pair(family, socket_type):
                        nonlocal pair_used
                        require(family == socket.AF_UNIX and socket_type == socket.SOCK_SEQPACKET,
                                'ancestor socket shape')
                        require(not pair_used, 'one ancestor pair lifetime')
                        pair_used = True
                        return pair
                    debt, op = start_registered(Registry(), lambda debt:
                        factory(debt, ancestor_pair if pair is not None else None))
                    descriptors = array.array('i', [op.control.fileno(), op.input_fd,
                        op.output_fd, op.error_fd, op.pidfd, op.bootstrap_error_fd])
                    require(child_transport.sendmsg([b'H' + struct.pack('<I', debt.pid)],
                        [(socket.SOL_SOCKET, socket.SCM_RIGHTS, descriptors)]) == 5,
                        'actual handle transfer')
                    # SCM_RIGHTS installed the observer's writer before we close
                    # this copy. Positive EOF must not be held open by producer.
                    os.close(op.input_fd); op.fds.remove(op.input_fd)
                    # Keep the producer alive and input/control unchanged until
                    # ancestor validates I and explicitly chooses X or W.
                    ready(child_transport, deadline)
                    command, extra = recv_rights(child_transport, 0)
                    require(not extra and command in (b'X', b'W'), 'producer fixed command')
                    if command == b'X': os._exit(0)
                    waited, status = os.waitpid(debt.pid, os.WNOHANG)
                    require(waited == debt.pid, 'actual intermediate launcher reap')
                    require(child_transport.send(b'W' + struct.pack('<I', status)) == 5,
                            'intermediate reap observation')
                    os._exit(0)
                except BaseException:
                    os._exit(78)
            h.producer_pid = pid
            h.producer_pidfd = os.pidfd_open(pid, 0)
            h.producer_owned = True  # Actual os.fork result and its held pidfd.
            child_transport.close(); child_transport = None
            if pair is not None:
                for sock in pair: sock.close()
                pair = None
            return h
        except BaseException as error:
            # An uncertain fork/pidfd path keeps all discoverable handles.
            h.extra_handles = (pair, child_transport)
            raise CaseUncertain(h, error) from error

    def receive_handles(self, h, deadline):
        ready(h.transport, deadline)
        data, rights = recv_rights(h.transport, 6, owner=h)
        # Retain every received fd even if later type/PID checks fail.
        require(len(data) == 5 and data[:1] == b'H' and len(rights) == 6,
                'actual child handle envelope')
        h.launcher_pid = struct.unpack('<I', data[1:])[0]
        require(h.launcher_pid > 1, 'launcher pid')
        h.control = socket.socket(fileno=rights[0])
        h.stdin, h.stdout, h.stderr, h.launcher_pidfd, h.bootstrap_error = rights[1:]
        require(os.readlink('/proc/self/fd/' + str(h.launcher_pidfd)) == 'anon_inode:[pidfd]',
                'launcher pidfd type')
        # This pidfd originated in the trusted producer; validate its live target
        # and exact PPid too, before accepting any I.
        self._launcher_identity(h)
        h.launcher_identity_validated = True

    def _launcher_identity(self, h):
        def bounded(path, maximum):
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                raw = os.read(fd, maximum + 1)
                require(len(raw) <= maximum, 'launcher proc bound')
                return raw
            finally: os.close(fd)
        info = bounded('/proc/self/fdinfo/' + str(h.launcher_pidfd), 4096)
        status = bounded('/proc/' + str(h.launcher_pid) + '/status', 16384)
        require([line.split(b':', 1)[1].strip() for line in info.splitlines()
                 if line.startswith(b'Pid:')] == [str(h.launcher_pid).encode()], 'launcher attribution')
        require([line.split(b':', 1)[1].strip() for line in status.splitlines()
                 if line.startswith(b'PPid:')] == [str(h.producer_pid).encode()], 'launcher parent')

    def receive_init(self, h, deadline):
        ready(h.control, deadline)
        data, rights = recv_rights(h.control, 1, owner=h, packet_attribute='initial_control')
        h.pending_rights = rights
        require(data == b'I' and len(rights) == 1, 'actual initial I required')
        h.init_pidfd = rights[0]
        h.init_pid = validate_init_pidfd(h.init_pidfd, h.launcher_pid)
        require(not poll_ready([h.init_pidfd, h.launcher_pidfd])[0],
                'live init and launcher before case trigger')

    def diagnose_preinit(self, h, deadline):
        """Closed observations only. No receipt synthesis or cleanup discharge.

        Reaping is restricted to the actual fork owner and its corroborated
        launcher, after pidfd readiness. The unchanged W actor does the launcher
        waitpid; this observer alone owns the actual producer waitpid.
        """
        d = {'controlObserved': False, 'controlBytes': 0, 'controlTag': 'unknown',
             'controlRights': 0, 'controlEof': False, 'stderrBytes': 0,
             'stderrEof': False, 'nativeClassification': 'empty',
             'nativeLabel': 'unknown', 'nativeErrno': 0, 'bootstrapBytes': 0,
             'bootstrapRecordObserved': False, 'bootstrapStep': 'unknown',
             'bootstrapErrno': 0, 'bootstrapEof': False,
             'bootstrapClassification': 'empty', 'launcherExitCode': None,
             'producerExitCode': None, 'diagnosticsComplete': False}
        h.preinit_diagnostics = d
        if h.initial_control is not None:
            p = h.initial_control
            d.update(controlObserved=p['packetObserved'], controlBytes=p['byteCount'],
                     controlTag=p['tag'], controlRights=p['rightsCount'], controlEof=p['eof'])
        # Partial/malformed H attribution never permits a wait query or proc read.
        if not (h.producer_owned and h.launcher_identity_validated
                and h.init_pid is None and h.bootstrap_error is not None): return
        captures = {h.stderr: bytearray(), h.bootstrap_error: bytearray()}
        for fd in captures: os.set_blocking(fd, False)
        pending = set(captures) | {h.launcher_pidfd}
        sent_wait = False
        while pending:
            left = deadline - self.now()
            if left <= 0: break
            readable = poll_ready(list(pending), timeout=left)[0]
            if not readable: break
            for fd in readable:
                if fd in captures:
                    limit = 4096 if fd == h.stderr else 8
                    chunk = os.read(fd, limit + 1 - len(captures[fd]))
                    if not chunk:
                        pending.remove(fd)
                        d['stderrEof' if fd == h.stderr else 'bootstrapEof'] = True
                    else:
                        captures[fd].extend(chunk)
                        if len(captures[fd]) > limit: pending.remove(fd)
                    if fd == h.stderr:
                        d['stderrBytes'] = len(captures[fd])
                        result = classify_stderr(bytes(captures[fd])) if len(captures[fd]) <= limit else {'classification': 'overflow', 'label': 'unknown', 'errno': 0}
                        d.update(nativeClassification=result['classification'], nativeLabel=result['label'], nativeErrno=result['errno'])
                    else:
                        d['bootstrapBytes'] = len(captures[fd])
                        if len(captures[fd]) > limit:
                            d['bootstrapClassification'] = 'overflow'
                        elif d['bootstrapEof']:
                            try:
                                record = decode_bootstrap_record(bytes(captures[fd]))
                                d.update(bootstrapRecordObserved=record['recordObserved'],
                                         bootstrapStep=record['step'], bootstrapErrno=record['errno'],
                                         bootstrapClassification='record' if record['recordObserved'] else 'empty')
                            except Refusal: d['bootstrapClassification'] = 'invalid'
                elif fd == h.launcher_pidfd:
                    pending.remove(fd)
                    if deadline - self.now() <= 0: return
                    require(h.transport.send(b'W') == 1, 'diagnostic owned launcher wait query')
                    sent_wait = True; pending.add(h.transport.fileno())
                elif fd == h.transport.fileno() and sent_wait:
                    data, rights = recv_rights(h.transport, 0, owner=h)
                    require(not rights and len(data) == 5 and data[:1] == b'W',
                            'diagnostic actual producer wait response')
                    status = struct.unpack('<I', data[1:])[0]
                    from control import wait_exit_code
                    wait_exit_code(status)
                    h.preinit_launcher_wait_status = status
                    d['launcherExitCode'] = os.waitstatus_to_exitcode(status)
                    pending.remove(fd); pending.add(h.producer_pidfd)
                elif fd == h.producer_pidfd:
                    waited, status = os.waitpid(h.producer_pid, os.WNOHANG)
                    require(waited == h.producer_pid, 'diagnostic actual owned producer reap')
                    from control import wait_exit_code
                    wait_exit_code(status)
                    h.preinit_producer_wait_status = status
                    d['producerExitCode'] = os.waitstatus_to_exitcode(status)
                    pending.remove(fd)
        d['diagnosticsComplete'] = (d['stderrEof'] and d['bootstrapEof']
            and d['launcherExitCode'] is not None and d['producerExitCode'] is not None
            and d['nativeClassification'] != 'overflow'
            and d['bootstrapClassification'] not in ('overflow', 'invalid'))

    def verify_keepalive(self, h):
        import fcntl
        import stat
        require(h.control.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) == socket.SOCK_SEQPACKET
                and stat.S_ISFIFO(os.fstat(h.stdin).st_mode)
                and fcntl.fcntl(h.stdin, fcntl.F_GETFL) & os.O_ACCMODE == os.O_WRONLY,
                'duplicated control and stdin write endpoints alive')

    def exit_parent(self, h, deadline):
        require(not poll_ready([h.init_pidfd, h.launcher_pidfd])[0],
                'both native processes live at parent-exit trigger')
        require(h.transport.send(b'X') == 1, 'parent exit command')
        ready(h.producer_pidfd, deadline)

    def send_request(self, h, request, deadline):
        os.set_blocking(h.stdin, False)
        at = 0
        while at < len(request):
            left = deadline - self.now()
            require(left > 0 and poll_ready(writers=[h.stdin], timeout=left)[1], 'request deadline')
            try: count = os.write(h.stdin, request[at:])
            except BlockingIOError: continue
            require(count > 0, 'request progress'); at += count
        os.close(h.stdin)
        if h.received_handles is not None:
            h.received_handles = [fd for fd in h.received_handles if fd != h.stdin]
        h.stdin = None  # Reader's exact framing is EOF JSON.
        return at

    def observe(self, h, deadline):
        captures = {h.stdout: bytearray(), h.stderr: bytearray()}
        if h.bootstrap_error is not None: captures[h.bootstrap_error] = bytearray()
        for fd in captures: os.set_blocking(fd, False)
        h.control.setblocking(False)
        pending = set(captures) | {h.control.fileno(), h.launcher_pidfd}
        if h.init_pidfd is not None: pending.add(h.init_pidfd)
        eof, exited, native_wait = set(), set(), None
        while pending:
            left = deadline - self.now()
            require(left > 0, 'negative teardown before C deadline')
            for fd in poll_ready(list(pending), timeout=left)[0]:
                if fd in (h.launcher_pidfd, h.init_pidfd):
                    exited.add(fd); pending.remove(fd)
                elif fd in captures:
                    chunk = os.read(fd, 9 - len(captures[fd]) if fd == h.bootstrap_error else 65536)
                    if not chunk: eof.add(fd); pending.remove(fd)
                    else:
                        limit = 8 if fd == h.bootstrap_error else IO_MAX if fd == h.stdout else 16384
                        require(len(captures[fd]) + len(chunk) <= limit, 'case pipe bound')
                        captures[fd].extend(chunk)
                else:
                    data, rights = recv_rights(h.control, 1, owner=h)
                    if rights:
                        h.unexpected_rights = rights
                        raise Refusal('unexpected native rights after I or pre-init negative')
                    if not data: eof.add(fd); pending.remove(fd)
                    else:
                        kind, status = parse_receipt(data, ())
                        require(kind == 'reaped' and h.init_pidfd is not None
                                and native_wait is None, 'only actual terminal R')
                        native_wait = status
        bootstrap_eof, bootstrap_record = False, False
        if h.bootstrap_error is not None:
            bootstrap_eof = h.bootstrap_error in eof
            record = decode_bootstrap_record(bytes(captures[h.bootstrap_error]))
            h.bootstrap_observation = {**record, 'eof': bootstrap_eof,
                                       'byteCount': len(captures[h.bootstrap_error])}
            bootstrap_record = record['recordObserved']
        return Observation(h.launcher_pidfd in exited, h.init_pidfd in exited,
                           h.stdout in eof, h.stderr in eof, h.control.fileno() in eof,
                           bytes(captures[h.stdout]), bytes(captures[h.stderr]), native_wait,
                           bootstrap_eof, bootstrap_record)

    def reap(self, h, kind, observed, deadline):
        init_status = None
        if kind == 'parent-exit':
            # Ancestor subreaper owns orphans. Monitor can die on producer PDEATH
            # without R; that missing receipt must never become fake Debt success.
            waited, launcher_status = os.waitpid(h.launcher_pid, os.WNOHANG)
            require(waited == h.launcher_pid, 'adopted launcher actually reaped')
            if observed.native_wait_status is None:
                waited, init_status = os.waitpid(h.init_pid, os.WNOHANG)
                require(waited == h.init_pid, 'adopted init actually reaped')
        else:
            require(h.transport.send(b'W') == 1, 'reap command after pidfd readiness')
            ready(h.transport, deadline)
            data, rights = recv_rights(h.transport, 0, owner=h)
            require(not rights and len(data) == 5 and data[:1] == b'W', 'actual producer reap')
            launcher_status = struct.unpack('<I', data[1:])[0]
        ready(h.producer_pidfd, deadline)
        waited, producer_status = os.waitpid(h.producer_pid, os.WNOHANG)
        require(waited == h.producer_pid and producer_status == 0, 'actual producer reap')
        # Validate observed terminal statuses without synthesizing native receipts.
        from control import wait_exit_code
        wait_exit_code(launcher_status)
        if init_status is not None: wait_exit_code(init_status)
        return Reaps(producer_status, launcher_status, init_status)

    def close_confirmed(self, h):
        # Deliberate keepalives survive until both readiness/reap and EOF checks.
        failures = []
        known = {fd for fd in (h.stdin, h.stdout, h.stderr, h.launcher_pidfd,
                 h.init_pidfd, h.producer_pidfd, h.bootstrap_error) if fd is not None}
        socket_fds = {sock.fileno() for sock in (h.control, h.transport)
                       if hasattr(sock, 'fileno')}
        for sock in (h.control, h.transport):
            try: sock.close()
            except OSError: failures.append(sock)
        for fd in (h.stdin, h.stdout, h.stderr, h.launcher_pidfd,
                   h.init_pidfd, h.producer_pidfd, h.bootstrap_error):
            if fd is not None:
                try: os.close(fd)
                except OSError: failures.append(fd)
        for fd in set(h.received_handles or []) - known - socket_fds:
            try: os.close(fd)
            except OSError: failures.append(fd)
        h.failed_close_handles = failures
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong,
                              ctypes.c_ulong, ctypes.c_ulong]
        libc.prctl.restype = ctypes.c_int
        require(libc.prctl(36, h.subreaper_before, 0, 0, 0) == 0, 'restore subreaper')
        h.subreaper_changed = False
        require(not failures, 'case descriptor close failures retained')
        h.retained = False
