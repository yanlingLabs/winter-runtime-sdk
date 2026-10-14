"""Collector ownership tests using only injected inert effect tables.

No socket, pipe, process, selector backend, Root observation or signal is real.
Control words and fake descriptor observations are DATA, never native proof.
"""
from contextlib import ExitStack, contextmanager
import array
import errno
import os
import selectors
import signal
import socket
import struct
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import control
import producer as p


class InertSocket:
    def __init__(self, table):
        self.table = table
        self.closed = False

    def fileno(self):
        return 26

    def setblocking(self, value):
        self.table.events.append(('control-blocking', value))

    def send(self, value):
        self.table.events.append(('cancel-send', value))
        self.table.case.assertEqual(value, b'K')
        if self.table.send_error is not None:
            raise self.table.send_error
        return self.table.send_result

    def close(self):
        self.table.events.append(('control-close',))
        self.closed = True

    def recvmsg(self, data_bound, ancillary_bound):
        self.table.case.assertEqual(data_bound, 6)
        self.table.case.assertEqual(ancillary_bound, socket.CMSG_SPACE(4))
        message = self.table.messages.pop(0)
        # Independent oracle: every complete SCM_RIGHTS int is now caller-owned.
        for level, kind, raw in message[1]:
            if (level, kind) == (socket.SOL_SOCKET, socket.SCM_RIGHTS):
                values = array.array('i')
                width = values.itemsize
                values.frombytes(raw[:len(raw) // width * width])
                self.table.installed.update(values)
                self.table.live.update(values)
        self.table.events.append(('recvmsg',))
        return message


class InertPoll:
    def __init__(self, table, number):
        self.table, self.number = table, number
        self.keys = {}
        self.closed = False

    def register(self, fd, events, data=None):
        number = fd.fileno() if hasattr(fd, 'fileno') else fd
        self.table.events.append(('register', self.number, number))
        if self.number == 0 and number == self.table.fail_register:
            raise self.table.failure
        self.keys[number] = SimpleNamespace(fd=number, data=data)

    def unregister(self, fd):
        self.keys.pop(fd.fileno() if hasattr(fd, 'fileno') else fd)

    def get_map(self):
        return self.keys

    def select(self, timeout):
        self.table.case.assertGreater(timeout, 0)
        self.table.events.append(('select', self.number, timeout))
        actions = self.table.actions.get(self.number, [])
        if not actions:
            return []
        number = actions.pop(0)
        if isinstance(number, BaseException):
            raise number
        return [(self.keys[number], selectors.EVENT_READ)]

    def close(self):
        self.table.events.append(('poll-close', self.number))
        self.closed = True


class CollectorTable:
    def __init__(self, case, *, held_init=False):
        self.case = case
        self.events = []
        self.clock = 0
        self.step = .2
        self.failure = OSError(errno.EIO, 'injected collection failure')
        self.send_error = None
        self.send_result = 1
        self.fail_blocking = None
        self.fail_register = None
        self.fail_selector = False
        self.failed_closes = set()
        self.messages = []
        self.reads = {24: [], 25: []}
        self.actions = {}
        self.polls = []
        self.installed = set()
        self.live = {23, 24, 25, 27}
        debt = p.Debt(phase='running', pid=123)
        self.op = p.NativeOperation(debt, object(), 5, 6, self.forbidden, self.forbidden,
                                    pidfd_validator=self.validate_pidfd)
        self.op.control = InertSocket(self)
        self.op.input_fd, self.op.output_fd, self.op.error_fd = 23, 24, 25
        self.op.pidfd = 27
        self.op.fds = set(self.live)
        if held_init:
            self.op.init_pidfd = 70
            self.op.debt.init_pidfd = 70
            self.op.fds.add(70)
            self.live.add(70)

    def selector(self):
        number = len(self.polls)
        self.events.append(('poll-create', number))
        if self.fail_selector and number == 0:
            self.fail_selector = False
            raise self.failure
        poll = InertPoll(self, number)
        self.polls.append(poll)
        return poll

    def set_blocking(self, fd, value):
        self.events.append(('blocking', fd, value))
        self.case.assertIn(fd, self.live)
        if fd == self.fail_blocking:
            self.fail_blocking = None  # Fail initial setup; drain still gets a turn.
            raise self.failure

    def write(self, fd, data):
        self.events.append(('write', fd))
        self.case.assertEqual(fd, 23)
        self.case.assertIn(fd, self.live)
        return len(data)

    def read(self, fd, maximum):
        self.events.append(('read', fd))
        self.case.assertIn(fd, (24, 25))
        self.case.assertIn(fd, self.live)
        return self.reads[fd].pop(0)

    def close(self, fd):
        self.events.append(('close', fd))
        self.case.assertIn(fd, self.live, 'only owned handles may be discharged')
        if fd in self.failed_closes:
            raise OSError(errno.EIO, 'injected descriptor-close failure')
        self.live.remove(fd)

    def monotonic(self):
        self.clock += self.step
        return self.clock

    def send_signal(self, fd, sig, *args):
        self.events.append(('init-signal', fd, sig))
        self.case.assertEqual((fd, sig), (70, signal.SIGKILL))
        self.case.assertIn(fd, self.op.fds)
        self.case.assertIn(fd, self.live)

    def parse_receipt(self, data, rights):
        try:
            return control.decode(data, rights)
        except control.ControlRefusal as error:
            raise p.Refusal('injected external control refusal') from error

    def validate_pidfd(self, fd, launcher_pid):
        self.events.append(('validate-init-pidfd', fd, launcher_pid))
        self.case.assertIn(fd, self.live)
        self.case.assertEqual(launcher_pid, 123)
        return 456  # Pure injected identity observation; never a /proc probe.

    def forbidden(self, *args, **kwargs):
        raise AssertionError('unadmitted native/Root/probe effect attempted')

    @contextmanager
    def patches(self):
        with ExitStack() as stack:
            replacements = (
                (selectors, 'DefaultSelector', self.selector),
                (p.os, 'set_blocking', self.set_blocking),
                (p.os, 'write', self.write), (p.os, 'read', self.read),
                (p.os, 'close', self.close), (p.time, 'monotonic', self.monotonic),
                (signal, 'pidfd_send_signal', self.send_signal),
                (p, 'parse_receipt', self.parse_receipt),
                (p.os, 'waitpid', self.forbidden), (p.os, 'kill', self.forbidden),
                (p.os, 'open', self.forbidden), (p.os, 'fstat', self.forbidden),
                (p.os, 'fork', self.forbidden), (p.os, 'pipe2', self.forbidden),
                (p.os, 'pidfd_open', self.forbidden), (p, 'root_linux', self.forbidden),
                (p, 'child_bootstrap', self.forbidden),
                (p.socket, 'socketpair', self.forbidden))
            for target, name, replacement in replacements:
                stack.enter_context(patch.object(target, name, replacement, create=True))
            yield


class CollectorCleanupTests(unittest.TestCase):
    def assert_uncertain_owned_lifetime(self, table):
        debt = table.op.debt
        self.assertTrue(table.op.cancelled)
        self.assertEqual(debt.phase, 'cancelled')
        self.assertTrue(debt.uncertain)
        self.assertFalse(debt.complete(), 'injected error cannot prove native completion')
        self.assertFalse(debt.launcher_reaped)
        self.assertFalse(debt.output_drained)
        self.assertFalse(debt.descriptor_drained)
        self.assertIsNone(debt.wait_status)
        self.assertEqual(table.op.fds, table.live, 'all uncertain owned handles must remain accounted for')
        self.assertIn(27, table.op.fds, 'preserve the launcher monitor pidfd')
        self.assertFalse(table.op.control.closed, 'monitor channel must survive uncertain drain')
        self.assertTrue(all(poll.closed for poll in table.polls))

    def assert_cancel_then_bounded_drain(self, table):
        sent = table.events.index(('cancel-send', b'K'))
        drain = table.events.index(('close', 23))
        self.assertLess(sent, drain)
        self.assertNotIn(23, table.live)
        # The inert clock reaches the two-second grace deadline; no real wait.
        polls_after_cancel = [e for e in table.events[sent:] if e[0] == 'select']
        self.assertGreater(len(polls_after_cancel), 0)
        self.assertLessEqual(len(polls_after_cancel), 12)
        self.assertTrue(all(e[2] <= .05 for e in polls_after_cancel))

    def test_invalid_requests_cancel_and_attempt_bounded_drain(self):
        for request in (b'', b'x' * (16 * 1024 + 1), 'wrong type'):
            with self.subTest(request_type=type(request), length=len(request)):
                table = CollectorTable(self)
                with table.patches():
                    with self.assertRaisesRegex(p.Refusal, 'reader request'):
                        table.op.collect(request)
                self.assert_uncertain_owned_lifetime(table)
                self.assert_cancel_then_bounded_drain(table)

    def test_set_blocking_failure_preserves_original_error_and_drains_after_cancel(self):
        for fd in (23, 24, 25):
            with self.subTest(fd=fd):
                table = CollectorTable(self)
                table.fail_blocking = fd
                with table.patches():
                    with self.assertRaises(OSError) as raised:
                        table.op.collect(b'{}')
                self.assertIs(raised.exception, table.failure)
                self.assert_uncertain_owned_lifetime(table)
                self.assert_cancel_then_bounded_drain(table)

    def test_partial_selector_registration_failure_closes_poll_and_drains_after_cancel(self):
        for fd in (26, 23, 24, 25):
            with self.subTest(fd=fd):
                table = CollectorTable(self, held_init=True)
                table.fail_register = fd
                with table.patches():
                    with self.assertRaises(OSError) as raised:
                        table.op.collect(b'{}')
                self.assertIs(raised.exception, table.failure)
                self.assertEqual(len(table.polls), 2)
                self.assert_uncertain_owned_lifetime(table)
                self.assert_cancel_then_bounded_drain(table)

    def test_selector_creation_failure_retains_lifetime_and_attempts_bounded_drain(self):
        table = CollectorTable(self)
        table.fail_selector = True
        with table.patches():
            with self.assertRaises(OSError) as raised:
                table.op.collect(b'{}')
        self.assertIs(raised.exception, table.failure)
        self.assert_uncertain_owned_lifetime(table)
        self.assert_cancel_then_bounded_drain(table)

    def test_uncertain_input_close_keeps_handle_and_original_request_error(self):
        table = CollectorTable(self)
        table.failed_closes = {23}
        with table.patches():
            with self.assertRaisesRegex(p.Refusal, 'reader request'):
                table.op.collect(b'')
        self.assertIn(('cancel-send', b'K'), table.events)
        self.assertIn(('close', 23), table.events)
        self.assertEqual(table.live, {23, 24, 25, 27})
        self.assert_uncertain_owned_lifetime(table)

    def test_stderr_has_independent_16kib_cap(self):
        table = CollectorTable(self, held_init=True)
        table.actions[0] = [23, 25, 25]
        table.reads[25] = [b'e' * (16 * 1024), b'x']
        with table.patches():
            with self.assertRaisesRegex(p.Refusal, 'reader stream bound'):
                table.op.collect(b'{}')
        self.assertEqual(bytes(table.op.captures[25]), b'e' * (16 * 1024))
        self.assert_uncertain_owned_lifetime(table)

    def test_stdout_larger_than_stderr_cap_retained_under_its_own_bound(self):
        table = CollectorTable(self, held_init=True)
        table.actions[0] = [23, 24]
        table.reads[24] = [b'o' * (16 * 1024 + 1)]
        with table.patches():
            with self.assertRaisesRegex(p.Refusal, 'reader lifetime deadline'):
                table.op.collect(b'{}')
        self.assertEqual(len(table.op.captures[24]), 16 * 1024 + 1)
        self.assert_uncertain_owned_lifetime(table)

    def test_cancel_keeps_launcher_monitor_when_K_is_sent_or_init_pidfd_used(self):
        for send_error in (None, BrokenPipeError(), ConnectionResetError()):
            with self.subTest(send_error=type(send_error)):
                table = CollectorTable(self, held_init=True)
                table.send_error = send_error
                with table.patches():
                    table.op.cancel()
                    table.op.cancel()  # Idempotent cancellation must not kill monitor.
                self.assertEqual(table.events.count(('cancel-send', b'K')), 1)
                if send_error is not None:
                    self.assertIn(('init-signal', 70, signal.SIGKILL), table.events)
                else:
                    self.assertNotIn(('init-signal', 70, signal.SIGKILL), table.events)
                self.assertEqual(table.op.fds, table.live)
                self.assertEqual(table.live, {23, 24, 25, 27, 70})
                self.assertFalse(table.op.control.closed)
                self.assertFalse(table.op.debt.complete())

    def test_cancel_zero_send_uses_held_init_pidfd_without_destroying_monitor(self):
        table = CollectorTable(self, held_init=True)
        table.send_result = 0
        with table.patches():
            table.op.cancel()
        self.assertIn(('init-signal', 70, signal.SIGKILL), table.events,
                      'zero-byte K delivery cannot count as cancellation')
        self.assertIn(27, table.op.fds)
        self.assertFalse(table.op.control.closed)

    def test_cancel_blocked_send_uses_init_pidfd_and_still_attempts_bounded_drain(self):
        table = CollectorTable(self, held_init=True)
        table.send_error = BlockingIOError(errno.EAGAIN, 'injected blocked control send')
        with table.patches():
            with self.assertRaisesRegex(p.Refusal, 'reader request'):
                table.op.collect(b'')
        self.assertIn(('init-signal', 70, signal.SIGKILL), table.events)
        self.assert_uncertain_owned_lifetime(table)
        self.assert_cancel_then_bounded_drain(table)

    def test_malformed_ancillary_tail_closes_every_complete_installed_descriptor(self):
        for ancillary in (
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack('ii', 80, 81) + b'x')],
            [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack('i', 80)),
             (socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack('i', 81) + b'xyz')]):
            with self.subTest(entries=len(ancillary)):
                table = CollectorTable(self)
                table.actions[0] = [26]
                table.messages = [(b'I', ancillary, 0, None)]
                with table.patches():
                    with self.assertRaisesRegex(p.Refusal, 'ancillary envelope'):
                        table.op.collect(b'{}')
                self.assertEqual(table.installed, {80, 81})
                self.assertNotIn(80, table.live)
                self.assertNotIn(81, table.live)
                self.assertLess(table.events.index(('close', 80)),
                                table.events.index(('cancel-send', b'K')))
                self.assertLess(table.events.index(('close', 81)),
                                table.events.index(('cancel-send', b'K')))
                self.assert_uncertain_owned_lifetime(table)

    def test_ancillary_close_error_attempts_every_fd_and_retains_unclosed_handle(self):
        table = CollectorTable(self)
        table.actions[0] = [26]
        table.failed_closes = {80}
        table.messages = [(b'I', [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                           struct.pack('ii', 80, 81) + b'x')], 0, None)]
        with table.patches():
            with self.assertRaises((OSError, p.Refusal)):
                table.op.collect(b'{}')
        self.assertIn(('close', 81), table.events, 'one failed close must not skip other installed FDs')
        self.assertNotIn(81, table.live)
        self.assertIn(80, table.op.fds, 'unclosed delivered FD must remain an owned cleanup handle')
        self.assert_uncertain_owned_lifetime(table)


if __name__ == '__main__':
    unittest.main()
