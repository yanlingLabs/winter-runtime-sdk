"""Reader-only Linux source harness. No implicit activation or native admission.

Real effects require a separately admitted external parent on a hosted ARM runner.
Tests inject operation tables; no compiled role, namespace or privileged call runs.
"""
import ctypes
import hashlib
import fcntl
import types
from pathlib import Path
import os
import platform
import socket
import stat
import struct
import threading
import time
from dataclasses import dataclass

UID = 20002
GROUP = 10000
VIEW = '/run/winter/instruction-reader-views/reader-case'
SOURCE = '/workspace/folders/source'
HOME = '/run/winter/instruction-reader'
ENV = {'LANG': 'C', 'LC_ALL': 'C', 'TZ': 'UTC', 'HOME': HOME,
       'TMPDIR': '/tmp', 'PATH': '/usr/bin:/bin'}
LIBRARIES = ('/lib/ld-linux-aarch64.so.1',
             '/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1',
             '/lib/aarch64-linux-gnu/libc.so.6',
             '/lib/aarch64-linux-gnu/libdl.so.2',
             '/lib/aarch64-linux-gnu/libm.so.6',
             '/lib/aarch64-linux-gnu/libpthread.so.0')
IO_MAX = 320 * 1024
DEADLINE_MS = 6000


class Refusal(ValueError):
    pass


def require(value, reason):
    if not value:
        raise Refusal(reason)


def root_linux():
    require(platform.system() == 'Linux' and platform.machine() in ('aarch64', 'arm64'),
            'hosted Linux ARM venue required')
    require(os.getuid() == 0 and os.geteuid() == 0, 'Root producer required')
    require(threading.active_count() == 1, 'single-threaded bootstrap required')
    # The final externally pinned workflow supplies venue provenance. This local
    # predicate is NOT a hosted-runner attestation or permission to execute.


def launcher_argv(reader_fd, receipt_fd, source_fd, shared_fd, libraries):
    require(tuple(path for _, path in libraries) == LIBRARIES, 'closed packet library inventory')
    descriptors = [reader_fd, receipt_fd, source_fd, shared_fd, *(fd for fd, _ in libraries)]
    require(all(type(fd) is int and 3 <= fd <= 65535 for fd in descriptors)
            and len(set(descriptors)) == len(descriptors), 'distinct inherited descriptors')
    return ['/artifacts/instructionReaderLauncher', 'instruction-reader-v1',
            str(reader_fd), VIEW, str(receipt_fd), str(UID), str(GROUP),
            str(source_fd), SOURCE, SOURCE, str(shared_fd), str(len(libraries)),
            *(value for fd, path in libraries for value in (str(fd), path))]


def parse_receipt(data, descriptors):
    # External-source control codec, never code from the captured packet. A future
    # workflow must pin this file as well as producer/parent before privileged IO.
    path = Path(__file__).with_name('control.py')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_size <= 65536, 'control source bound')
        raw = os.read(fd, 65537)
        require(hashlib.sha256(raw).hexdigest() == '05b63cfda7ef6022e13dce89e2f653db7a1b476a2904e9f57787bc12f99f1722', 'external control source pin')
    finally:
        os.close(fd)
    module = types.ModuleType('external_reader_control')
    # Execute only the exact hash-checked EXTERNAL trusted source bytes, not a
    # pathname reread/pycache and never captured packet code.
    exec(compile(raw, '<externally-pinned-reader-control>', 'exec'), module.__dict__)
    try:
        return module.decode(data, descriptors)
    except ValueError as error:
        raise Refusal('native control data refused') from error


@dataclass
class Debt:
    phase: str = 'registered'
    pid: int | None = None
    init_pidfd: int | None = None
    wait_status: int | None = None
    launcher_reaped: bool = False
    output_drained: bool = False
    descriptor_drained: bool = False
    uncertain: bool = False

    def complete(self):
        return (not self.uncertain and self.phase not in ('cancelled', 'failed-start')
                and self.wait_status is not None
                and self.launcher_reaped and self.output_drained
                and self.descriptor_drained)


class Registry:
    """Registration precedes effects; a failure cannot imply teardown."""
    def __init__(self):
        self.debts = []
        self.operation = None

    def register(self):
        require(not self.debts, 'one reader lifetime per producer')
        debt = Debt()
        self.debts.append(debt)
        return debt


def start_registered(registry, operation_factory):
    debt = registry.register()
    try:
        operation = operation_factory(debt)
        registry.operation = operation  # Retain real cleanup ownership on start refusal.
        require(operation.debt is debt, 'one registered debt identity')
        pid = operation.start()
        require(type(pid) is int and pid > 1, 'owned launcher pid')
        debt.pid = pid
        debt.phase = 'running'
        return debt, operation
    except BaseException:
        debt.phase = 'failed-start'
        debt.uncertain = True
        # The trusted real operation registers its child PID before bootstrap.
        # An injected/failed operation cannot claim there were no native effects.
        raise


def observe_native(debt, data, descriptors):
    require(debt.phase in ('running', 'cancelled'), 'reader lifetime state')
    kind, value = parse_receipt(data, descriptors)
    if kind == 'init':
        require(debt.init_pidfd is None and debt.wait_status is None, 'duplicate/late init')
        debt.init_pidfd = value
    else:
        require(debt.init_pidfd is not None and debt.wait_status is None,
                'reap without owned init')
        debt.wait_status = value


def cancel_registered(debt, operation):
    if debt.phase in ('cancelled', 'drained'):
        return
    debt.phase = 'cancelled'
    try:
        operation.cancel()
    except BaseException:
        debt.uncertain = True
        raise


def finish_registered(debt, *, launcher_reaped, output_drained, descriptor_drained):
    require(all(type(value) is bool for value in
                (launcher_reaped, output_drained, descriptor_drained)), 'closed drain observations')
    debt.launcher_reaped = launcher_reaped
    debt.output_drained = output_drained
    debt.descriptor_drained = descriptor_drained
    if debt.complete():
        debt.phase = 'drained'
    return debt.complete()


def validate_stdio(pipe_fds, pass_fds, *, get_stat=os.fstat, get_flags=None):
    if get_flags is None:
        get_flags = lambda fd: fcntl.fcntl(fd, fcntl.F_GETFL)
    require(len(pipe_fds) == 3 and len(set(pipe_fds)) == 3
            and not set(pipe_fds).intersection(pass_fds), 'distinct noncolliding stdio sources')
    for index, fd in enumerate(pipe_fds):
        require(type(fd) is int and fd >= 3 and stat.S_ISFIFO(get_stat(fd).st_mode),
                'explicit FIFO stdio')
        require(get_flags(fd) & os.O_ACCMODE == (os.O_RDONLY if index == 0 else os.O_WRONLY),
                'stdio access direction')



BOOTSTRAP_STEPS = ('child_setup', 'gate', 'root_guard', 'stdio', 'unshare',
                   'propagation', 'chroot', 'descriptor_envelope', 'exec')
BOOTSTRAP_ERRNOS = (0, 1, 2, 4, 5, 9, 10, 11, 12, 13, 17, 20, 22, 23, 24,
                    28, 30, 32, 38, 40, 95, 110)


def bootstrap_record(step, code):
    require(type(step) is int and 1 <= step <= len(BOOTSTRAP_STEPS), 'closed bootstrap step')
    require(type(code) is int and code in BOOTSTRAP_ERRNOS, 'closed bootstrap errno')
    return struct.pack('<II', step, code)


def decode_bootstrap_record(raw):
    require(type(raw) is bytes and len(raw) in (0, 8), 'bootstrap record length')
    if not raw:return {'recordObserved':False,'step':'unknown','errno':0}
    step,code=struct.unpack('<II',raw)
    bootstrap_record(step,code)
    return {'recordObserved':True,'step':BOOTSTRAP_STEPS[step-1],'errno':code}


def emit_bootstrap_failure(fd, step, error):
    # One atomic nonblocking PIPE_BUF-sized write. Refusal/death cannot invent EOF exec proof.
    code=getattr(error,'errno',None)
    if type(code) is not int:
        code=ctypes.get_errno() if step in (5,6) else 0
    if code not in BOOTSTRAP_ERRNOS:code=0
    return os.write(fd,bootstrap_record(step,code)) == 8


def child_bootstrap(root_fd, argv, pass_fds, pipe_fds, *, error_fd=None, stage=None):
    """Actual privileged effects. Not called by source/portable tests.

    Python/libc are trusted parent tooling, not measured packet runtime objects.
    No PID namespace precedes C's SO_PEERCRED/original-parent check.
    """
    def mark(index):
        ctypes.set_errno(0)
        if stage is not None:stage(index)
    mark(3)
    root_linux()
    if error_fd is not None:
        require(type(error_fd) is int and error_fd >= 3 and error_fd not in pass_fds
                and error_fd not in pipe_fds and error_fd != root_fd, 'independent bootstrap error writer')
    require(len(set(pass_fds)) == len(pass_fds), 'explicit child fd inventory')
    mark(4)
    validate_stdio(pipe_fds, pass_fds)
    for target, inherited in enumerate(pipe_fds):
        os.dup2(inherited, target)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.unshare.argtypes = [ctypes.c_int]
    libc.unshare.restype = ctypes.c_int
    libc.mount.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p, ctypes.c_ulong, ctypes.c_void_p]
    libc.mount.restype = ctypes.c_int
    mark(5)
    require(libc.unshare(0x00020000) == 0, 'private bootstrap mount namespace')
    mark(6)
    require(libc.mount(None, b'/', None, 0x4000 | 0x40000, None) == 0,
            'private bootstrap propagation')
    mark(7)
    os.fchdir(root_fd)
    os.chroot('.')
    os.chdir('/')
    # This filesystem was independently sealed before fork: captured loader and
    # six libraries only, never the runner's /lib or /etc/ld.so.preload/cache.
    mark(8)
    keep = sorted(set(pass_fds) | ({error_fd} if error_fd is not None else set()))
    begin = 3
    for fd in keep:
        require(fd >= begin, 'child fd ordering')
        os.closerange(begin, fd)
        os.set_inheritable(fd, fd != error_fd)
        begin = fd + 1
    os.closerange(begin, 1 << 20)
    mark(9)
    os.execve(argv[0], argv, ENV)
    raise Refusal('exec returned')


def bounded_capture(chunks):
    """Portable oracle for the future selector-based pipe collector."""
    result = bytearray()
    for chunk in chunks:
        require(type(chunk) is bytes and len(result) + len(chunk) <= IO_MAX,
                'reader capture bound')
        result.extend(chunk)
    return bytes(result)


def init_pid_identity(fdinfo, status, launcher_pid):
    """Closed host-proc observations; receipt JSON never supplies these values."""
    require(type(fdinfo) is bytes and len(fdinfo) <= 4096
            and type(status) is bytes and len(status) <= 16384, 'pidfd observation bound')
    def values(raw, name):
        found = [line.split(b':', 1)[1].strip().split() for line in raw.splitlines()
                 if line.startswith(name + b':')]
        require(len(found) == 1 and found[0]
                and all(part.isdigit() for part in found[0]), 'closed pidfd observation')
        return tuple(int(part) for part in found[0])
    pid, = values(fdinfo, b'Pid')
    namespace = values(fdinfo, b'NSpid')
    parent, = values(status, b'PPid')
    require(pid > 1 and len(namespace) == 2 and namespace == (pid, 1)
            and parent == launcher_pid, 'owned private PID namespace init')
    return pid


def validate_init_pidfd(fd, launcher_pid):
    require(os.readlink('/proc/self/fd/' + str(fd)) == 'anon_inode:[pidfd]',
            'received descriptor is not pidfd')
    def read_proc(path, limit):
        held = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            before = os.fstat(held)
            require(stat.S_ISREG(before.st_mode), 'proc observation regular file')
            data = bytearray()
            while True:
                chunk = os.read(held, min(4096, limit + 1 - len(data)))
                if not chunk: break
                data.extend(chunk)
                require(len(data) <= limit, 'proc observation bound')
            after = os.fstat(held)
            require((before.st_dev, before.st_ino) == (after.st_dev, after.st_ino),
                    'proc observation identity changed')
            return bytes(data)
        finally:
            os.close(held)
    info = read_proc('/proc/self/fdinfo/' + str(fd), 4096)
    pid_lines = [line[4:].strip() for line in info.splitlines() if line.startswith(b'Pid:')]
    require(len(pid_lines) == 1 and pid_lines[0].isdigit(), 'live pidfd target required')
    pid = int(pid_lines[0])
    require(pid > 1, 'live pidfd target required')
    status = read_proc('/proc/' + str(pid) + '/status', 16384)
    return init_pid_identity(info, status, launcher_pid)


def descriptor_preflight(required=4096):
    """Raise only this admitted Linux parent's soft bound, never the hard bound."""
    import resource
    root_linux()
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    require(type(required) is int and 2048 <= required <= 8192 and hard >= required,
            'fixed descriptor capacity unavailable')
    if soft < required:
        resource.setrlimit(resource.RLIMIT_NOFILE, (required, hard))
    require(resource.getrlimit(resource.RLIMIT_NOFILE)[0] >= required,
            'descriptor capacity preflight')


class NativeOperation:
    """Effects are guarded; no source test instantiates this actual launcher.

    The external parent must validate/seal and retain root + snapshot contexts.
    Root-owned fixture source/shared FDs carry scope; request bytes carry no paths.
    """
    def __init__(self, debt, root, source_fd, shared_fd, guard, recheck,
                 pidfd_validator=validate_init_pidfd, control_pair_factory=None):
        self.debt, self.root = debt, root
        self.source_fd, self.shared_fd = source_fd, shared_fd
        self.guard, self.recheck = guard, recheck
        self.pidfd_validator = pidfd_validator
        # Trusted external harness seam for the intentional ancestor-peer negative,
        # never request/config/native-authority data.
        self.control_pair_factory = control_pair_factory
        self.init_pid = None
        self.pidfd = None
        self.init_pidfd = None
        self.fds = set()
        self.cancelled = False
        self.control = None
        self.peer = None
        self.gate_released = False
        self.setup_cleanup_confirmed = False
        self.captures = {}
        self.eof_fds = set()
        self.control_eof = False
        self.bootstrap_error_fd = None
        self.bootstrap_error_bytes = bytearray()

    def start(self):
        try:
            return self._start()
        except BaseException:
            self.debt.uncertain = True
            if not self.gate_released:
                self._cleanup_before_bootstrap()
            else:
                try: self.cancel()
                except BaseException: pass  # Preserve original setup failure/debt.
            raise

    def _cleanup_before_bootstrap(self):
        # Closing the registered gate writer gives the blocked trusted child EOF.
        errors = []
        for fd in tuple(self.fds):
            if fd == self.pidfd:
                continue  # Retain exact child ownership until confirmed reap.
            try:
                os.close(fd); self.fds.remove(fd)
            except OSError as error:
                errors.append(error)
        for sock in (self.control, self.peer):
            if sock is not None:
                try: sock.close()
                except OSError as error: errors.append(error)
        if self.debt.pid is not None:
            try:
                deadline = time.monotonic() + 1
                while True:
                    pid, status = os.waitpid(self.debt.pid, os.WNOHANG)
                    if pid == self.debt.pid:
                        self.debt.launcher_reaped = True
                        break
                    if time.monotonic() >= deadline:
                        errors.append(Refusal('pre-bootstrap reap uncertain')); break
                    time.sleep(.01)
            except BaseException as error:
                errors.append(error)  # Never mask the original start failure.
        if self.pidfd is not None and self.debt.launcher_reaped:
            try:
                os.close(self.pidfd); self.fds.remove(self.pidfd)
            except OSError as error:
                errors.append(error)
        self.setup_cleanup_confirmed = not errors
        self.debt.descriptor_drained = not self.fds and not errors
        # No I/R native proof was produced: even confirmed setup cleanup is not a
        # successful native reader lifetime. Keep complete() false.

    def _start(self):
        root_linux()
        require(self.debt.phase == 'registered', 'registration before effects')
        self.guard(self.root)
        self.recheck(self.root)
        for fd in (self.source_fd, self.shared_fd):
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0,
                    'Root fixture directory scope')
        require((os.fstat(self.source_fd).st_dev, os.fstat(self.source_fd).st_ino) !=
                (os.fstat(self.shared_fd).st_dev, os.fstat(self.shared_fd).st_ino),
                'independent source/shared scope')
        # No process with the reserved identity may preexist on this disposable runner.
        seen = 0
        with os.scandir('/proc') as entries:
            for entry in entries:
                seen += 1
                require(seen <= 20000, 'UID reservation process bound')
                if entry.name.isascii() and entry.name.isdigit():
                    try:
                        require(entry.stat(follow_symlinks=False).st_uid != UID,
                                'reader UID already in use')
                    except FileNotFoundError:
                        pass  # Entry actually vanished; no permission/error skipping.
        pair_factory = self.control_pair_factory or socket.socketpair
        a, b = pair_factory(socket.AF_UNIX, socket.SOCK_SEQPACKET)
        self.control, self.peer = a, b
        pipes = []
        for _ in range(5):
            pair = os.pipe2(os.O_CLOEXEC)
            self.fds.update(pair)
            pipes.append(pair)
        stdin, stdout, stderr, gate, bootstrap_error = pipes
        os.set_blocking(bootstrap_error[1], False)
        self.fds.update(fd for pair in pipes for fd in pair)
        reader_fd = self.root.files['artifacts/instructionReader'][0]
        libraries = tuple((self.root.files[path.lstrip('/')][0], path) for path in LIBRARIES)
        argv = launcher_argv(reader_fd, b.fileno(), self.source_fd, self.shared_fd, libraries)
        pass_fds = (reader_fd, b.fileno(), self.source_fd, self.shared_fd,
                    *(fd for fd, _ in libraries))
        root_fd = self.root.directories[''][0]
        self.recheck(self.root)  # Immediately before owned fork/bootstrap/exec.
        pid = os.fork()
        if pid == 0:
            step=[1]
            def stage(index):step[0]=index
            try:
                a.close()
                os.close(bootstrap_error[0])
                os.close(gate[1])
                stage(2)
                require(os.read(gate[0], 1) == b'G', 'registered child start gate')
                os.close(gate[0])
                child_bootstrap(root_fd, argv, pass_fds,
                                (stdin[0], stdout[1], stderr[1]),
                                error_fd=bootstrap_error[1], stage=stage)
            except BaseException as error:
                try: emit_bootstrap_failure(bootstrap_error[1], step[0], error)
                except BaseException: pass  # Unknown observation; never claim exec/cleanup.
                os._exit(78)
        # Child cannot bootstrap until its PID/pidfd are registered here.
        self.debt.pid = pid
        self.pidfd = os.pidfd_open(pid, 0)
        self.fds.add(self.pidfd)
        self.debt.phase = 'running'
        b.close()
        for fd in (stdin[0], stdout[1], stderr[1], gate[0], bootstrap_error[1]):
            os.close(fd)
            self.fds.remove(fd)
        self.input_fd, self.output_fd, self.error_fd = stdin[1], stdout[0], stderr[0]
        self.bootstrap_error_fd = bootstrap_error[0]
        require(os.write(gate[1], b'G') == 1, 'start gate write')
        self.gate_released = True
        os.close(gate[1])
        self.fds.remove(gate[1])
        return pid

    def cancel(self):
        if self.cancelled or self.debt.launcher_reaped:
            return
        self.cancelled = True
        self.debt.phase = 'cancelled'
        # Preserve the monitor: it must kill/reap init and emit R. A failure to
        # send K may use the held init pidfd, never destroy the receipt producer.
        try:
            if self.control is not None:
                self.control.setblocking(False)
                require(self.control.send(b'K') == 1, 'cancel control write')
                return
        except (OSError, Refusal):
            self.debt.uncertain = True
        if self.init_pidfd is not None:
            import signal
            try: signal.pidfd_send_signal(self.init_pidfd, signal.SIGKILL)
            except ProcessLookupError: pass
            return
        self.debt.uncertain = True

    def collect(self, request):
        try:
            require(type(request) is bytes and 0 < len(request) <= 16 * 1024,
                    'bounded fixed reader request')
            require(self.debt.pid is not None and self.debt.phase == 'running',
                    'owned running reader')
            self.captures = {self.output_fd: bytearray(), self.error_fd: bytearray()}
            return self._pump(request, time.monotonic() + DEADLINE_MS / 1000)
        except BaseException:
            self.debt.uncertain = True
            try: self.cancel()
            except BaseException: pass
            try:
                if not self.debt.launcher_reaped:
                    self.drain_after_cancel()
            except BaseException:
                pass  # Debt + all cleanup handles survive for external observation.
            raise

    def drain_after_cancel(self):
        require(self.cancelled and self.debt.pid is not None, 'cancelled owned reader')
        if not self.captures:
            self.captures = {self.output_fd: bytearray(), self.error_fd: bytearray()}
        # Stop request input; bounded grace drains both pipes/control then actual reap.
        if self.input_fd in self.fds:
            os.close(self.input_fd); self.fds.remove(self.input_fd)
        return self._pump(None, time.monotonic() + 2)

    def _pump(self, request, deadline):
        import selectors
        poll = None
        try:
            at = 0
            if request is not None:
                os.set_blocking(self.input_fd, False)
            poll = selectors.DefaultSelector()
            captures = self.captures
            self.control.setblocking(False)
            if not self.control_eof:
                poll.register(self.control, selectors.EVENT_READ, 'control')
            if request is not None and self.init_pidfd is not None:
                poll.register(self.input_fd, selectors.EVENT_WRITE, 'input')
            if self.bootstrap_error_fd is not None and self.bootstrap_error_fd not in self.eof_fds:
                os.set_blocking(self.bootstrap_error_fd,False)
                poll.register(self.bootstrap_error_fd,selectors.EVENT_READ,'bootstrap')
            for fd in captures:
                if fd not in self.eof_fds:
                    os.set_blocking(fd, False)
                    poll.register(fd, selectors.EVENT_READ, 'pipe')
            while poll.get_map():
                remaining = deadline - time.monotonic()
                require(remaining > 0, 'reader lifetime deadline')
                for key, _ in poll.select(min(.05, remaining)):
                    if key.data == 'input':
                        try:
                            count = os.write(self.input_fd, request[at:])
                        except BlockingIOError:
                            continue
                        require(count > 0, 'reader request write')
                        at += count
                        if at == len(request):
                            poll.unregister(self.input_fd)
                            os.close(self.input_fd)
                            self.fds.remove(self.input_fd)
                    elif key.data == 'bootstrap':
                        raw=os.read(key.fd,9)
                        if not raw:
                            poll.unregister(key.fd);self.eof_fds.add(key.fd)
                        else:
                            self.bootstrap_error_bytes.extend(raw)
                            require(len(self.bootstrap_error_bytes)<=8,'bootstrap record byte bound')
                    elif key.data == 'pipe':
                        data = os.read(key.fd, 65536)
                        if not data:
                            poll.unregister(key.fd)
                            self.eof_fds.add(key.fd)
                            continue
                        require(len(captures[key.fd]) + len(data) <= (IO_MAX if key.fd == self.output_fd else 16 * 1024), 'reader stream bound')
                        captures[key.fd].extend(data)
                    else:
                        import array
                        data, ancillary, flags, _ = self.control.recvmsg(6, socket.CMSG_SPACE(4))
                        rights = []
                        # Collect EVERY actual SCM_RIGHTS fd before validating flags/types,
                        # so refusals cannot leak a delivered descriptor.
                        for level, kind, raw in ancillary:
                            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                                values = array.array('i'); values.frombytes(raw[:len(raw) // 4 * 4]); rights.extend(values)
                        self.fds.update(rights)
                        try:
                            require(not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC),
                                    'native receipt truncated')
                            for level, kind, raw in ancillary:
                                require(level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS
                                        and len(raw) == 4, 'native ancillary envelope')
                            if data == b'':
                                self.control_eof = True
                                poll.unregister(self.control)
                                continue
                            if data == b'I':
                                require(len(rights) == 1, 'one init pidfd')
                                self.init_pid = self.pidfd_validator(rights[0], self.debt.pid)
                            observe_native(self.debt, data, tuple(rights))
                            if data == b'I':
                                self.init_pidfd = rights[0]
                                self.fds.add(rights.pop())
                                if request is not None:
                                    poll.register(self.input_fd, selectors.EVENT_WRITE, 'input')
                        finally:
                            errors = []
                            for fd in rights:
                                try:
                                    os.close(fd); self.fds.remove(fd)
                                except OSError as error:
                                    errors.append(error)
                            if errors:
                                self.debt.uncertain = True
                                raise Refusal('received descriptor cleanup uncertain') from errors[0]
            # No poll/reap before cancellation on exceptional paths; PID stays reserved.
            wait = selectors.DefaultSelector()
            try:
                wait.register(self.pidfd, selectors.EVENT_READ)
                remaining = deadline - time.monotonic()
                require(remaining > 0 and wait.select(remaining), 'launcher exit deadline')
            finally:
                wait.close()
            waited, status = os.waitpid(self.debt.pid, os.WNOHANG)
            require(waited == self.debt.pid, 'launcher not reaped after native drain')
            self.debt.launcher_reaped = True
            require(self.debt.wait_status is not None, 'missing native reap receipt')
            require(not self.bootstrap_error_bytes,'pre-exec failure is not successful lifetime')
            native_exit = parse_receipt(b'R' + struct.pack('<I', self.debt.wait_status), ())[1]
            # Compare terminal status directly; C monitor returns namespace-init exit.
            expected_exit = (native_exit >> 8) if native_exit & 0xFF == 0 else 128 + (native_exit & 0x7F)
            require(os.waitstatus_to_exitcode(status) == expected_exit, 'matching launcher/native wait')
            self.debt.output_drained = True
            self.recheck(self.root)  # Full held/named runtime bytes after drain.
            return bytes(captures[self.output_fd]), bytes(captures[self.error_fd])
        finally:
            if poll is not None:
                poll.close()
            # Never discard cleanup handles on uncertainty. Only the full native
            # wait + launcher reap + pipe drain conjunction permits FD discharge.
            if self.debt.wait_status is not None and self.debt.launcher_reaped and self.debt.output_drained:
                errors = []
                try: self.control.close()
                except OSError as error: errors.append(error)
                for fd in tuple(self.fds):
                    try: os.close(fd); self.fds.remove(fd)
                    except OSError as error: errors.append(error)
                self.debt.descriptor_drained = not errors and not self.fds
                if errors: self.debt.uncertain = True
