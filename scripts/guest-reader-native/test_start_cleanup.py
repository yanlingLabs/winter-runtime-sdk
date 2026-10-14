"""Injected setup-debt tests: no sockets, pipes, forks, Root or native calls.

Every effect used by NativeOperation.start is replaced before the operation is
constructed. Fake descriptor ownership and gate EOF are DATA observations only.
"""
from contextlib import ExitStack, contextmanager
import errno
import os
import stat
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import producer as p


class InjectedSocket:
    def __init__(self, table, fd):
        self.table, self.fd, self.closed = table, fd, False

    def fileno(self):
        return self.fd

    def close(self):
        self.table.effect('socket-close', self.fd)
        if self.fd in self.table.failed_socket_closes:
            raise OSError(errno.EIO, 'injected socket-close failure')
        self.closed = True

    def send(self, data):
        raise AssertionError('pre-bootstrap cleanup must not send native cancellation')


class EmptyProc:
    def __enter__(self):
        return iter(())

    def __exit__(self, *_):
        return False


class InjectedEffects:
    """A closed, inert syscall table and independent owned-resource oracle."""
    def __init__(self, case):
        self.case = case
        self.registry = p.Registry()
        self.operation = None
        self.events = []
        self.live_fds = set()
        self.allocated_fds = set()
        self.sockets = []
        self.pipe_calls = 0
        self.child_pid = None
        self.child_reaped = False
        self.gate_opened = False
        self.gate_writer = 47
        self.clock = 100.0
        self.failure = OSError(errno.EIO, 'injected setup failure')
        self.fail_socket = False
        self.fail_pipe_at = None
        self.fail_fork = False
        self.fail_nonblocking = False
        self.fail_pidfd = False
        self.gate_write = 0
        self.gate_write_error = None
        self.failed_fd_closes = set()
        self.failed_socket_closes = set()
        self.wait_results = [(123, 0)]
        self.wait_error = None
        self.wait_calls = []
        self.root = SimpleNamespace(path=p.Path('/run/inert/runtime'),
            files={'artifacts/instructionReader': (100,), 'artifacts/instructionReaderLauncher': (108,)} |
                  {path.lstrip('/'): (101 + index,) for index, path in enumerate(p.LIBRARIES)},
            directories={'': (10,)})

    def effect(self, kind, detail=None):
        self.case.assertEqual(len(self.registry.debts), 1, 'registration must precede every effect')
        self.case.assertIs(self.operation.debt, self.registry.debts[0], 'one debt owns all effects')
        self.events.append((kind, detail))

    def guard(self, root):
        self.effect('guard')
        self.case.assertIs(root, self.root)

    def recheck(self, root):
        self.effect('recheck')
        self.case.assertIs(root, self.root)

    def fstat(self, fd):
        self.effect('fixture-stat', fd)
        self.case.assertIn(fd, (10,20,21,100,101,102,103,104,105,106,108), 'unexpected filesystem observation')
        return SimpleNamespace(st_mode=(stat.S_IFDIR if fd in (10,20,21) else stat.S_IFREG)|0o555,
            st_uid=0,st_gid=0,st_nlink=2 if fd in (10,20,21) else 1,st_size=0,st_mtime_ns=1,st_ctime_ns=2,st_dev=1,st_ino=fd)

    def scandir(self, path):
        self.effect('proc-inventory', path)
        self.case.assertEqual(path, '/proc')
        return EmptyProc()

    def socketpair(self, family, kind):
        self.effect('socket-allocation')
        self.case.assertEqual((family, kind), (p.socket.AF_UNIX, p.socket.SOCK_SEQPACKET))
        self.case.assertIn(('guard', None), self.events)
        self.case.assertIn(('recheck', None), self.events)
        if self.fail_socket:
            raise self.failure
        self.sockets = [InjectedSocket(self, 30), InjectedSocket(self, 31)]
        return tuple(self.sockets)

    def pipe2(self, flags):
        self.effect('pipe-allocation', self.pipe_calls)
        self.case.assertEqual(flags, os.O_CLOEXEC)
        self.case.assertEqual(self.operation.fds, self.allocated_fds,
                              'all earlier pipe FDs must already belong to operation')
        index = self.pipe_calls
        self.pipe_calls += 1
        if index == self.fail_pipe_at:
            raise self.failure
        pair = (40 + index * 2, 41 + index * 2)
        self.allocated_fds.update(pair)
        self.live_fds.update(pair)
        return pair

    def set_blocking(self, fd, value):
        self.effect('nonblocking-error-writer', fd)
        self.case.assertEqual((fd,value),(49,False))
        self.case.assertIn(fd,self.operation.fds)
        if self.fail_nonblocking:raise self.failure

    def fork(self):
        self.effect('fork')
        self.case.assertEqual(self.operation.fds, self.live_fds)
        self.case.assertEqual(len(self.live_fds), 10)
        if self.fail_fork:
            raise self.failure
        self.child_pid = 123  # Parent branch only; never runs a child/bootstrap.
        return self.child_pid

    def pidfd_open(self, pid, flags):
        self.effect('pidfd-allocation', pid)
        self.case.assertEqual((pid, flags), (123, 0))
        self.case.assertEqual(self.registry.debts[0].pid, pid,
                              'child identity must be registered before pidfd allocation')
        self.case.assertIn(self.gate_writer, self.live_fds)
        self.case.assertFalse(self.gate_opened, 'child must still be gate-blocked')
        if self.fail_pidfd:
            raise self.failure
        self.live_fds.add(60)
        self.allocated_fds.add(60)
        return 60

    def write(self, fd, data):
        self.effect('gate-write', fd)
        self.case.assertEqual((fd, data), (self.gate_writer, b'G'))
        self.case.assertEqual(self.operation.debt.pid, self.child_pid)
        self.case.assertIn(60, self.operation.fds)
        if self.gate_write_error is not None:
            raise self.gate_write_error
        if self.gate_write == 1:
            self.gate_opened = True
        return self.gate_write

    def close(self, fd):
        self.effect('fd-close', fd)
        self.case.assertIn(fd, self.live_fds, 'close must address an owned live FD exactly once')
        if fd in self.failed_fd_closes:
            raise OSError(errno.EIO, 'injected FD-close failure')
        self.live_fds.remove(fd)

    def waitpid(self, pid, flags):
        self.effect('bounded-reap', pid)
        self.case.assertEqual((pid, flags), (self.child_pid, os.WNOHANG))
        self.case.assertNotIn(self.gate_writer, self.live_fds,
                              'close gate writer before waiting: blocked child needs EOF')
        self.case.assertFalse(self.gate_opened)
        self.wait_calls.append((pid, flags))
        if self.wait_error is not None:
            raise self.wait_error
        result = self.wait_results.pop(0) if self.wait_results else (0, 0)
        if result[0] == pid:
            self.child_reaped = True
        return result

    def monotonic(self):
        self.clock += 0.25
        return self.clock

    def sleep(self, delay):
        self.effect('bounded-reap-yield', delay)
        self.case.assertLessEqual(delay, 0.05)

    def forbidden(self, *_, **__):
        raise AssertionError('unadmitted native/child effect called')

    @contextmanager
    def patches(self):
        with ExitStack() as stack:
            replacements = (
                (p.platform, 'system', lambda: 'Linux'),
                (p.platform, 'machine', lambda: 'aarch64'),
                (p.threading, 'active_count', lambda: 1),
                (p.os, 'getuid', lambda: 0), (p.os, 'geteuid', lambda: 0),
                (p.fcntl,'fcntl',lambda *_:os.O_RDONLY),(p.os, 'fstat', self.fstat), (p.os, 'scandir', self.scandir),
                (p.socket, 'socketpair', self.socketpair), (p.os, 'pipe2', self.pipe2),
                (p.os, 'set_blocking', self.set_blocking), (p.os, 'fork', self.fork), (p.os, 'pidfd_open', self.pidfd_open),
                (p.os, 'write', self.write), (p.os, 'close', self.close),
                (p.os, 'waitpid', self.waitpid), (p.time, 'monotonic', self.monotonic),
                (p.time, 'sleep', self.sleep), (p, 'child_bootstrap', self.forbidden),
                (p.os, '_exit', self.forbidden), (p.os, 'read', self.forbidden),
                (p.os, 'execve', self.forbidden), (p.os, 'chroot', self.forbidden),
                (p.os, 'dup2', self.forbidden), (p.os, 'open', self.forbidden))
            for target, name, replacement in replacements:
                stack.enter_context(patch.object(target, name, replacement, create=True))
            yield

    def start(self):
        def factory(debt):
            self.case.assertIs(debt, self.registry.debts[0])
            self.operation = p.NativeOperation(debt, self.root, 20, 21, self.guard,self.recheck,source_path='/run/inert/fixture/source',shared_path='/run/inert/fixture/shared')
            return self.operation
        with self.patches():
            return p.start_registered(self.registry, factory)


class SetupCleanupTests(unittest.TestCase):
    def assert_failed_debt(self, table, *, confirmed):
        self.assertEqual(len(table.registry.debts), 1)
        debt = table.registry.debts[0]
        self.assertIs(debt, table.operation.debt)
        self.assertEqual(debt.phase, 'failed-start')
        self.assertTrue(debt.uncertain)
        self.assertFalse(debt.complete(), 'setup cleanup must not claim native completion')
        self.assertIsNone(debt.wait_status, 'no native I/R receipt was observed')
        self.assertFalse(debt.output_drained)
        self.assertEqual(table.operation.setup_cleanup_confirmed, confirmed)
        self.assertEqual(table.operation.fds, table.live_fds, 'every live handle remains accounted for')
        return debt

    def fail_with_original(self, table):
        with self.assertRaises(OSError) as raised:
            table.start()
        self.assertIs(raised.exception, table.failure, 'cleanup must preserve the setup failure')

    def test_socket_allocation_failure_has_registered_debt_without_fake_native_completion(self):
        table = InjectedEffects(self)
        table.fail_socket = True
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=True)
        self.assertEqual(table.allocated_fds, set())
        self.assertEqual(table.sockets, [])
        self.assertIsNone(debt.pid)
        self.assertEqual(table.wait_calls, [])

    def test_each_partial_pipe_allocation_closes_all_previously_registered_resources(self):
        for fail_at in range(5):
            with self.subTest(pipe=fail_at):
                table = InjectedEffects(self)
                table.fail_pipe_at = fail_at
                self.fail_with_original(table)
                debt = self.assert_failed_debt(table, confirmed=True)
                self.assertEqual(len(table.allocated_fds), fail_at * 2)
                self.assertFalse(table.live_fds)
                self.assertTrue(all(sock.closed for sock in table.sockets))
                self.assertIsNone(debt.pid)
                self.assertFalse(any(kind == 'fork' for kind, _ in table.events))

    def test_error_writer_nonblocking_setup_failure_closes_registered_pipe(self):
        table=InjectedEffects(self);table.fail_nonblocking=True
        self.fail_with_original(table)
        self.assert_failed_debt(table,confirmed=True)
        self.assertFalse(table.live_fds)
        self.assertFalse(any(kind=='fork' for kind,_ in table.events))

    def test_successful_start_hands_off_read_end_and_closes_writer_before_gate(self):
        table=InjectedEffects(self);table.gate_write=1
        debt,op=table.start()
        self.assertEqual(op.bootstrap_error_fd,48)
        self.assertIn(48,op.fds);self.assertNotIn(49,op.fds)
        self.assertLess(table.events.index(('fd-close',49)),table.events.index(('gate-write',47)))
        self.assertFalse(debt.complete());self.assertFalse(debt.launcher_reaped)
        self.assertTrue(op.gate_released)

    def test_fork_failure_closes_all_prechild_resources(self):
        table = InjectedEffects(self)
        table.fail_fork = True
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=True)
        self.assertEqual(len(table.allocated_fds), 10)
        self.assertFalse(table.live_fds)
        self.assertTrue(all(sock.closed for sock in table.sockets))
        self.assertIsNone(debt.pid)
        self.assertFalse(debt.launcher_reaped)
        self.assertEqual(table.wait_calls, [])

    def test_pidfd_failure_keeps_child_blocked_until_gate_eof_then_bounded_reap(self):
        table = InjectedEffects(self)
        table.fail_pidfd = True
        table.wait_results = [(0, 0), (123, 0)]
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=True)
        self.assertEqual(debt.pid, 123)
        self.assertTrue(debt.launcher_reaped)
        self.assertTrue(table.child_reaped)
        self.assertTrue(debt.descriptor_drained)
        self.assertFalse(table.operation.gate_released)
        self.assertFalse(table.live_fds)
        self.assertEqual(len(table.wait_calls), 2)
        self.assertFalse(any(kind == 'gate-write' for kind, _ in table.events))
        self.assertLess(table.events.index(('fd-close', 47)),
                        table.events.index(('bounded-reap', 123)))

    def test_gate_zero_and_exception_close_writer_without_bootstrap_or_native_claim(self):
        for exception in (False, True):
            with self.subTest(exception=exception):
                table = InjectedEffects(self)
                if exception:
                    table.gate_write_error = table.failure
                    self.fail_with_original(table)
                else:
                    with self.assertRaisesRegex(p.Refusal, 'start gate write'):
                        table.start()
                debt = self.assert_failed_debt(table, confirmed=True)
                self.assertTrue(debt.launcher_reaped)
                self.assertFalse(table.operation.gate_released)
                self.assertFalse(table.gate_opened)
                self.assertFalse(table.live_fds)
                self.assertLess(table.events.index(('fd-close', 47)),
                                table.events.index(('bounded-reap', 123)))

    def test_fd_close_failure_preserves_owned_handle_and_uncertain_debt(self):
        table = InjectedEffects(self)
        table.fail_pipe_at = 2
        table.failed_fd_closes = {41}
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=False)
        self.assertEqual(table.live_fds, {41})
        self.assertFalse(debt.descriptor_drained)
        self.assertEqual(len([fd for kind, fd in table.events if kind == 'fd-close']), 4)

    def test_socket_close_failure_preserves_owning_reference_and_uncertainty(self):
        table = InjectedEffects(self)
        table.fail_pipe_at = 1
        table.failed_socket_closes = {30}
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=False)
        self.assertIs(table.operation.control, table.sockets[0])
        self.assertFalse(table.operation.control.closed)
        self.assertTrue(table.operation.peer.closed)
        self.assertFalse(debt.descriptor_drained)

    def test_bounded_unconfirmed_reap_retains_owned_pidfd_for_later_cleanup(self):
        table = InjectedEffects(self)
        table.gate_write_error = table.failure
        table.wait_results = []
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=False)
        self.assertFalse(debt.launcher_reaped)
        self.assertEqual(debt.pid, 123)
        self.assertGreater(len(table.wait_calls), 0)
        self.assertLessEqual(len(table.wait_calls), 10, 'reap must stop at the injected absolute deadline')
        self.assertIn(table.operation.pidfd, table.operation.fds,
                      'unreaped child must retain its owned pidfd')
        self.assertFalse(debt.descriptor_drained)

    def test_reap_error_preserves_original_failure_and_owned_pidfd(self):
        table = InjectedEffects(self)
        table.gate_write_error = table.failure
        table.wait_error = OSError(errno.ECHILD, 'injected unconfirmed wait')
        self.fail_with_original(table)
        debt = self.assert_failed_debt(table, confirmed=False)
        self.assertFalse(debt.launcher_reaped)
        self.assertEqual(debt.pid, 123)
        self.assertIn(table.operation.pidfd, table.operation.fds)
        self.assertFalse(debt.descriptor_drained)



class MountScopeTests(unittest.TestCase):
    def test_actual_start_supplies_all_filesystem_roles_and_excludes_socket(self):
        table=InjectedEffects(self);debt=table.registry.register()
        table.operation=p.NativeOperation(debt,table.root,20,21,table.guard,table.recheck,source_path='/run/inert/fixture/source',shared_path='/run/inert/fixture/shared')
        class ChildEnded(BaseException):pass
        seen=[]
        def bootstrap(root,argv,pass_fds,pipe_fds,**kwargs):
            seen.append((root,argv,pass_fds,kwargs))
            raise ValueError('inert pre-exec stop')
        with table.patches(),patch.object(p.os,'fork',return_value=0),patch.object(p.os,'read',return_value=b'G'),patch.object(p,'child_bootstrap',side_effect=bootstrap),patch.object(p,'emit_bootstrap_failure',return_value=True),patch.object(p.os,'_exit',side_effect=ChildEnded):
            with self.assertRaises(ChildEnded):table.operation._start()
        root,argv,pass_fds,kwargs=seen[0]
        expected=(10,108,100,20,21,101,102,103,104,105,106)
        self.assertEqual(tuple(fd for fd,_,_ in kwargs['reopen_inputs']),expected)
        self.assertNotIn(31,expected)  # Receipt socket has internal sockfs mount, C-authenticated.
        self.assertEqual(set(pass_fds)-{31},set(expected)-{10,108})
        self.assertEqual(kwargs['error_fd'],49)

if __name__ == '__main__':
    unittest.main()
