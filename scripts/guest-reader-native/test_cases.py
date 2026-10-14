"""Inert injected/source tests; no Linux/proc/fork/socket/pipe/native effects."""
import array
import ast
from pathlib import Path
import socket
import struct
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import native_cases as cases


class InertEffects:
    def __init__(self, kind):
        self.kind, self.events = kind, []
        self.h = cases.Handles(123, 20, object(), launcher_pid=456,
                               launcher_pidfd=21, control=object(), stdin=22,
                               stdout=23, stderr=24)
        self.observation = cases.Observation(True, kind != 'unexpected-parent',
            True, True, True, b'{"injected":true}\n' if kind == 'same-owner' else b'',
            b'', 0 if kind == 'same-owner' else None)
        self.reaps = cases.Reaps(0, 9 if kind == 'parent-exit' else
                                 64 << 8 if kind == 'unexpected-parent' else 0,
                                 9 if kind == 'parent-exit' else None)
        self.now_calls = 0

    def now(self):
        self.now_calls += 1
        return 0 if self.now_calls == 1 else 1

    def launch(self, kind, factory, deadline):
        self.events.append(('launch', kind, deadline)); return self.h

    def receive_handles(self, h, deadline): self.events.append('handles')

    def receive_init(self, h, deadline):
        self.events.append('validated-init'); h.init_pid, h.init_pidfd = 789, 25

    def verify_keepalive(self, h):
        assert h.stdin == 22 and h.control is not None
        self.events.append('retained-control-and-stdin')

    def exit_parent(self, h, deadline):
        assert 'validated-init' in self.events and 'retained-control-and-stdin' in self.events
        self.events.append('parent-exit')

    def send_request(self, h, request, deadline):
        assert 'validated-init' in self.events
        self.events.append(('request', request)); return len(request)

    def observe(self, h, deadline):
        assert h.retained
        if self.kind == 'parent-exit': assert h.stdin == 22
        self.events.append('independent-pidfd-pipe-observation'); return self.observation

    def reap(self, h, kind, observed, deadline):
        assert self.events[-1] == 'independent-pidfd-pipe-observation'
        assert h.retained
        self.events.append('actual-reaps'); return self.reaps

    def close_confirmed(self, h):
        assert self.events[-1] == 'actual-reaps'
        self.events.append('close-after-proof'); h.retained = False


class CasesTests(unittest.TestCase):
    def run_inert(self, kind, fx=None):
        fx = fx or InertEffects(kind)
        evidence = cases.run_case(kind, lambda *_: self.fail('actual factory invoked'),
                                 b'{}' if kind == 'same-owner' else b'', effects=fx)
        return evidence, fx

    def test_unexpected_parent_has_distinct_pre_init_evidence(self):
        evidence, fx = self.run_inert('unexpected-parent')
        self.assertEqual(evidence.original_socket_owner, 'ancestor')
        self.assertIsNone(evidence.validated_init_pid)
        self.assertEqual(evidence.input_bytes, 0)
        self.assertFalse(evidence.keepalive_before_parent_exit)
        self.assertNotIn('validated-init', fx.events)
        self.assertFalse(evidence.config_effect_proven)
        self.assertEqual(fx.events[0], ('launch', 'unexpected-parent', 3.0))

    def test_parent_exit_validates_before_trigger_retains_endpoints_through_reap(self):
        evidence, fx = self.run_inert('parent-exit')
        self.assertEqual(fx.events, [('launch', 'parent-exit', 3.0), 'handles',
            'validated-init', 'retained-control-and-stdin', 'parent-exit',
            'independent-pidfd-pipe-observation', 'actual-reaps', 'close-after-proof'])
        self.assertIsNone(evidence.observation.native_wait_status)
        self.assertEqual(evidence.reaps.init_status, 9)
        self.assertTrue(evidence.keepalive_before_parent_exit)

    def test_same_shape_positive_writes_only_after_init_and_preserves_raw_frame(self):
        evidence, fx = self.run_inert('same-owner')
        self.assertEqual(evidence.original_socket_owner, 'producer')
        self.assertLess(fx.events.index('validated-init'), fx.events.index(('request', b'{}')))
        self.assertEqual(evidence.observation.stdout, b'{"injected":true}\n')
        self.assertEqual(evidence.input_bytes, 2)
        self.assertEqual(evidence.reaps.launcher_status, 0)

    def test_negative_requests_are_never_written(self):
        for kind in ('parent-exit', 'unexpected-parent'):
            fx = InertEffects(kind)
            with self.assertRaises(cases.Refusal):
                cases.run_case(kind, None, b'{}', effects=fx)
            self.assertEqual(fx.events, [])

    def test_closed_case_and_request_types(self):
        for kind, request in (('other', b''), ('same-owner', b''),
                              ('same-owner', b'x' * 16385), ('same-owner', '{}')):
            fx = InertEffects(kind)
            with self.assertRaises(cases.Refusal):
                cases.run_case(kind, None, request, effects=fx)
            self.assertEqual(fx.events, [])

    def test_each_missing_independent_observation_retains_handles(self):
        for field in ('launcher_ready', 'init_ready', 'stdout_eof', 'stderr_eof', 'control_eof'):
            fx = InertEffects('parent-exit')
            fields = dict(fx.observation.__dict__); fields[field] = False
            fx.observation = cases.Observation(**fields)
            with self.assertRaises(cases.CaseUncertain) as caught:
                self.run_inert('parent-exit', fx)
            self.assertIs(caught.exception.handles, fx.h)
            self.assertTrue(fx.h.retained)
            self.assertNotIn('actual-reaps', fx.events)
            self.assertNotIn('close-after-proof', fx.events)

    def test_unexpected_init_receipt_or_output_cannot_be_refusal_success(self):
        for change in ('init', 'receipt', 'stdout', 'exit'):
            fx = InertEffects('unexpected-parent')
            original = fx.receive_handles
            if change == 'init':
                def handles(h, deadline): original(h, deadline); h.init_pid, h.init_pidfd = 789, 25
                fx.receive_handles = handles
            elif change in ('receipt', 'stdout'):
                fields = dict(fx.observation.__dict__)
                fields['native_wait_status' if change == 'receipt' else 'stdout'] = 0 if change == 'receipt' else b'frame\n'
                fx.observation = cases.Observation(**fields)
            else: fx.reaps = cases.Reaps(0, 77 << 8, None)
            with self.assertRaises(cases.CaseUncertain): self.run_inert('unexpected-parent', fx)
            self.assertTrue(fx.h.retained)

    def test_parent_exit_needs_actual_sigkill_waits_not_only_pidfd_readiness(self):
        for launcher, init in ((0, 9), (9, 0), (9, None), (77 << 8, 9)):
            fx = InertEffects('parent-exit'); fx.reaps = cases.Reaps(0, launcher, init)
            with self.assertRaises(cases.CaseUncertain): self.run_inert('parent-exit', fx)
            self.assertTrue(fx.h.retained)

    def test_pidfd_validation_failure_prevents_input_and_parent_exit(self):
        for kind in ('parent-exit', 'same-owner'):
            fx = InertEffects(kind)
            def refuse(*_): raise cases.Refusal('inert attribution failure')
            fx.receive_init = refuse
            with self.assertRaises(cases.CaseUncertain): self.run_inert(kind, fx)
            self.assertNotIn('parent-exit', fx.events)
            self.assertFalse(any(isinstance(event, tuple) and event[0] == 'request' for event in fx.events))
            self.assertTrue(fx.h.retained)

    def test_deadline_never_relabels_timeout_as_parent_death(self):
        fx = InertEffects('parent-exit')
        ticks = iter((0.0, 3.0)); fx.now = lambda: next(ticks)
        with self.assertRaises(cases.CaseUncertain): self.run_inert('parent-exit', fx)
        self.assertNotIn('close-after-proof', fx.events)
        self.assertTrue(fx.h.retained)

    def test_ancillary_truncation_retains_every_installed_fd(self):
        class InertSocket:
            def recvmsg(self, *_):
                return b'H', [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                               array.array('i', [70, 71]).tobytes())], socket.MSG_CTRUNC, None
        closed = []
        with patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0x40000000, create=True), \
             patch.object(cases.os, 'close', side_effect=closed.append):
            with self.assertRaises(cases.CaseUncertain) as caught: cases.recv_rights(InertSocket(), 6)
        self.assertEqual(closed, [])
        self.assertEqual(caught.exception.handles, (70, 71))

    def test_source_preserves_actual_branch_topology_and_no_fake_debt_completion(self):
        source = Path(cases.__file__).read_text()
        tree = ast.parse(source)
        calls = [node.func.attr for node in ast.walk(tree) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Attribute)]
        self.assertNotIn('complete', calls)
        self.assertNotIn('finish_registered', calls)
        launch = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)
                      and node.name == 'launch' and len(node.args.args) == 4)
        segments = ast.get_source_segment(source, launch)
        self.assertLess(segments.index('pair = socket.socketpair'), segments.index('pid = os.fork()'))
        self.assertIn("ancestor_pair if pair is not None else None", segments)
        self.assertIn('factory(debt,', segments)
        self.assertLess(segments.index('sendmsg'), segments.index('os.close(op.input_fd)'))
        self.assertIn('os.waitpid(debt.pid, os.WNOHANG)', segments)

    def test_received_rights_refusal_never_attempts_implicit_close(self):
        class InertSocket:
            def recvmsg(self, *_):
                return b'H', [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                               array.array('i', [70, 71]).tobytes())], socket.MSG_CTRUNC, None
        attempted = []
        def close(fd):
            attempted.append(fd)
            if fd == 70: raise OSError('inert close failure')
        with patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0x40000000, create=True), \
             patch.object(cases.os, 'close', side_effect=close):
            with self.assertRaises(cases.CaseUncertain) as caught:
                cases.recv_rights(InertSocket(), 6)
        self.assertEqual(attempted, [])
        self.assertEqual(caught.exception.handles, (70, 71))

    def test_actual_producer_exit_zero_is_required(self):
        fx = InertEffects('parent-exit'); fx.reaps = cases.Reaps(78 << 8, 9, 9)
        with self.assertRaises(cases.CaseUncertain): self.run_inert('parent-exit', fx)
        self.assertTrue(fx.h.retained)

    def test_actual_launch_setup_refusal_retains_subreaper_change_without_fork(self):
        calls = []
        libc = SimpleNamespace(prctl=lambda *args: calls.append(args) or 0)
        # Callable attributes support the source's explicit ctypes prototypes.
        with patch.object(cases, 'root_linux'), \
             patch.object(cases.ctypes, 'CDLL', return_value=libc), \
             patch.object(cases.socket, 'socketpair', side_effect=OSError('inert allocation refusal')), \
             patch.object(cases.os, 'fork', side_effect=AssertionError('fork must not run')):
            with self.assertRaises(cases.CaseUncertain) as caught:
                cases.LinuxEffects().launch('same-owner', None, 3)
        h = caught.exception.handles
        self.assertTrue(h.retained)
        self.assertTrue(h.subreaper_changed)
        self.assertEqual(h.producer_pid, 0)
        self.assertEqual([args[0] for args in calls], [37, 36])

    def test_actual_close_attempts_all_and_retains_failed_endpoint(self):
        attempted = []
        class InertSocket:
            def __init__(self, name): self.name = name
            def close(self):
                attempted.append(self.name)
                if self.name == 'control': raise OSError('inert socket close failure')
        h = InertEffects('parent-exit').h
        h.control, h.transport = InertSocket('control'), InertSocket('transport')
        h.init_pidfd = 25
        h.bootstrap_error = 27
        h.received_handles = [22, 23, 24, 21, 25, 27, 28]
        h.subreaper_changed = True
        libc = SimpleNamespace(prctl=lambda *_: 0)
        def close(fd):
            attempted.append(fd)
            if fd == 22: raise OSError('inert writer close failure')
        with patch.object(cases.os, 'close', side_effect=close), \
             patch.object(cases.ctypes, 'CDLL', return_value=libc):
            with self.assertRaises(cases.Refusal): cases.LinuxEffects().close_confirmed(h)
        self.assertEqual(attempted, ['control', 'transport', 22, 23, 24, 21, 25, 20, 27, 28])
        self.assertTrue(h.retained)
        self.assertFalse(h.subreaper_changed)
        self.assertEqual(h.failed_close_handles, [h.control, 22])

    def test_actual_observer_keeps_pidfd_and_pipe_observations_separate(self):
        h = InertEffects('parent-exit').h
        h.init_pidfd = 25
        class InertSocket:
            def fileno(self): return 26
            def setblocking(self, _): pass
        h.control = InertSocket()
        # Inert readiness and EOF: no os fd is read, opened, polled or closed.
        with patch.object(cases.os, 'set_blocking'), \
             patch.object(cases.os, 'read', return_value=b''), \
             patch.object(cases, 'poll_ready', side_effect=lambda read, **_: (list(read), [])), \
             patch.object(cases, 'recv_rights', return_value=(b'', [])), \
             patch.object(cases.time, 'monotonic', return_value=0):
            observation = cases.LinuxEffects().observe(h, 3)
        self.assertTrue(observation.init_ready and observation.launcher_ready)
        self.assertTrue(observation.stdout_eof and observation.stderr_eof and observation.control_eof)
        self.assertIsNone(observation.native_wait_status)
        self.assertTrue(h.retained)


if __name__ == '__main__': unittest.main()
