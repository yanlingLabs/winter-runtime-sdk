"""Unprivileged DATA endpoints above FD_SETSIZE; no native fixture or fork.

Pipe stand-ins exercise the observer's readiness routing, not PID attribution.
The Linux-only test uses a pidfd for this test process, without terminating it.
"""
import fcntl
import os
import resource
import socket
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import native_cases as cases


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        limits = resource.getrlimit(resource.RLIMIT_NOFILE)
        target = 2048 if limits[1] == resource.RLIM_INFINITY else min(2048, limits[1])
        if target <= 1100:
            self.skipTest('DATA high-FD regression requires a per-process limit above 1100')
        if limits[0] != resource.RLIM_INFINITY and limits[0] < target:
            resource.setrlimit(resource.RLIMIT_NOFILE, (target, limits[1]))
            self.addCleanup(resource.setrlimit, resource.RLIMIT_NOFILE, limits)
        self.fds = []
        self.addCleanup(self.close_fds)

    def close_fds(self):
        for fd in reversed(self.fds):
            os.close(fd)

    def high(self, fd):
        held = fcntl.fcntl(fd, fcntl.F_DUPFD_CLOEXEC, 1100)
        self.fds.append(held)
        self.assertGreaterEqual(held, 1100)
        return held

    def pipe(self):
        reader, writer = os.pipe()
        self.fds.extend((reader, writer))
        return reader, writer

    def close(self, fd):
        os.close(fd)
        self.fds.remove(fd)

    def sockets(self):
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        return left, right

    def test_high_pipe_read_write_and_deadline_readiness(self):
        reader, writer = self.pipe()
        high_read, high_write = self.high(reader), self.high(writer)
        self.assertEqual(cases.poll_ready([high_read]), ([], []))
        self.assertEqual(cases.poll_ready(writers=[high_write]), ([], [high_write]))
        os.write(writer, b'DATA')
        cases.ready(high_read, time.monotonic() + 1)
        self.assertEqual(cases.poll_ready([high_read]), ([high_read], []))
        self.assertEqual(os.read(high_read, 4), b'DATA')
        with patch.object(cases, 'poll_ready') as poll:
            with self.assertRaisesRegex(cases.Refusal, 'case absolute deadline'):
                cases.ready(high_read, time.monotonic() - 1)
            poll.assert_not_called()

    def test_high_socket_zero_timeout_and_init_parent_checks(self):
        sender, receiver = self.sockets()
        control_fd = self.high(receiver.fileno())
        control = socket.socket(fileno=control_fd)
        self.fds.remove(control_fd)
        self.addCleanup(control.close)
        init_reader, init_writer = self.pipe()
        launcher_reader, _ = self.pipe()
        init_fd, launcher_fd = self.high(init_reader), self.high(launcher_reader)
        self.assertEqual(cases.poll_ready([control]), ([], []))
        sender.send(b'I')
        self.assertEqual(cases.poll_ready([control]), ([control_fd], []))
        h = cases.Handles(123, control_fd, SimpleNamespace(send=lambda _: 1),
                          launcher_pid=456, launcher_pidfd=launcher_fd, control=control)
        with patch.object(cases, 'recv_rights', return_value=(b'I', [init_fd])), \
             patch.object(cases, 'validate_init_pidfd', return_value=789):
            cases.LinuxEffects().receive_init(h, time.monotonic() + 1)
        self.assertEqual(h.init_pid, 789)
        self.assertEqual(h.init_pidfd, init_fd)
        cases.LinuxEffects().exit_parent(h, time.monotonic() + 1)
        # Pipe readability is only a stand-in for the zero-timeout liveness check.
        os.write(init_writer, b'x')
        with self.assertRaisesRegex(cases.Refusal, 'both native processes live'):
            cases.LinuxEffects().exit_parent(h, time.monotonic() + 1)

    def test_high_request_writer_preserves_exact_input_and_eof(self):
        reader, writer = self.pipe()
        high_writer = self.high(writer)
        h = cases.Handles(123, 0, None, stdin=high_writer)
        self.assertEqual(cases.LinuxEffects().send_request(h, b'fixed request', time.monotonic() + 1), 13)
        self.fds.remove(high_writer)  # send_request closed its own write endpoint.
        self.assertIsNone(h.stdin)
        self.assertEqual(os.read(reader, 13), b'fixed request')
        self.close(writer)
        self.assertEqual(os.read(reader, 1), b'')

    def test_high_observer_keeps_pipe_eof_control_eof_and_exit_readiness_separate(self):
        stdout, stdout_writer = self.pipe()
        stderr, stderr_writer = self.pipe()
        launcher, launcher_writer = self.pipe()
        init, init_writer = self.pipe()
        sender, receiver = self.sockets()
        control_fd = self.high(receiver.fileno())
        control = socket.socket(fileno=control_fd)
        self.fds.remove(control_fd)
        self.addCleanup(control.close)
        h = cases.Handles(123, 0, None, control=control,
            stdout=self.high(stdout), stderr=self.high(stderr),
            launcher_pidfd=self.high(launcher), init_pidfd=self.high(init))
        self.close(stdout_writer); self.close(stderr_writer); sender.close()
        os.write(launcher_writer, b'x'); os.write(init_writer, b'x')
        with patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True):
            observed = cases.LinuxEffects().observe(h, time.monotonic() + 1)
        self.assertTrue(observed.launcher_ready and observed.init_ready)
        self.assertTrue(observed.stdout_eof and observed.stderr_eof and observed.control_eof)
        self.assertEqual(observed.stdout, b'')
        self.assertEqual(observed.stderr, b'')
        self.assertIsNone(observed.native_wait_status)

    @unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'),
                         'actual pidfd DATA check requires Linux')
    def test_high_live_self_pidfd_does_not_report_an_exit(self):
        fd = os.pidfd_open(os.getpid(), 0)
        self.fds.append(fd)
        high_pidfd = self.high(fd)
        self.assertEqual(cases.poll_ready([high_pidfd]), ([], []))


if __name__ == '__main__':
    unittest.main()
