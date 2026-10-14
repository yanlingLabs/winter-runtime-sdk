"""Inert injected pre-I observations. No C, fork, Root, proc or VM execution."""
import array
import json
import os
import socket
import struct
import unittest
from unittest.mock import patch

import native_cases as cases
from producer import BOOTSTRAP_ERRNOS, BOOTSTRAP_STEPS, bootstrap_record


class Endpoint:
    def __init__(self, data=b'', rights=(), flags=0):
        self.data, self.rights, self.flags, self.sent = data, rights, flags, []
    def recvmsg(self, *_):
        anc = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', self.rights).tobytes())] if self.rights else []
        return self.data, anc, self.flags, None
    def fileno(self): return 30
    def setblocking(self, _): pass
    def send(self, data): self.sent.append(data); return len(data)


def handles():
    return cases.Handles(123, 20, Endpoint(b'W' + struct.pack('<I', 77 << 8)),
        launcher_pid=456, launcher_pidfd=21, stderr=24, bootstrap_error=27,
        producer_owned=True, launcher_identity_validated=True,
        initial_control=cases.control_observation(b'', []))


class PreinitTests(unittest.TestCase):
    def test_audited_label_survives_unmapped_errno_without_remainder_text(self):
        result = cases.classify_stderr(b'reader namespaces: PRIVATE-UNMAPPED-TEXT\n')
        self.assertEqual(result['classification'], 'audited_label')
        self.assertEqual(result['label'], 'reader namespaces')
        self.assertEqual(result['errno'], 0)
        self.assertNotIn('PRIVATE', json.dumps(result))
        for raw in (b'reader namespaces: private\nextra\n',
                    b'reader namespaces: private', b'unknown: private\n'):
            self.assertEqual(cases.classify_stderr(raw)['classification'], 'unrecognized')

    def diagnose(self, h=None, stderr=None, bootstrap=None, wait=(123, 0)):
        h = h or handles()
        chunks = {24: iter([stderr if stderr is not None else b'reader namespaces: ' + os.strerror(1).encode() + b'\n', b'']),
                  27: iter([bootstrap if bootstrap is not None else b'', b''])}
        read_calls = []
        def read(fd, count):
            read_calls.append((fd, count)); return next(chunks[fd])[:count]
        with patch.object(cases.os, 'set_blocking'), patch.object(cases.os, 'read', side_effect=read), \
             patch.object(cases, 'poll_ready', side_effect=lambda fds, **_: (list(fds), [])), \
             patch.object(cases.os, 'waitpid', return_value=wait) as reaper, \
             patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True), \
             patch.object(cases.time, 'monotonic', return_value=0):
            cases.LinuxEffects().diagnose_preinit(h, 3)
        return h, read_calls, reaper

    def test_exact_control_metadata_contains_no_payload(self):
        for raw, tag in ((b'I', 'I'), (b'R' + struct.pack('<I', 0), 'R'), (b'', 'EOF'), (b'PRIVATE-PATH', 'other')):
            value = cases.control_observation(raw, [70, 71])
            self.assertEqual(value, dict(packetObserved=True, byteCount=len(raw), tag=tag, rightsCount=2, eof=not raw))
            self.assertNotIn('PRIVATE-PATH', json.dumps(value))

    def test_h6_exact_order_and_attribution_before_diagnosis(self):
        rights = [60, 61, 62, 63, 64, 65]
        h = cases.Handles(123, 20, Endpoint(b'H' + struct.pack('<I', 456), rights))
        with patch.object(cases, 'ready'), patch.object(cases.socket, 'socket', return_value=object()), \
             patch.object(cases.os, 'readlink', return_value='anon_inode:[pidfd]'), \
             patch.object(cases.LinuxEffects, '_launcher_identity') as identity, \
             patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True):
            cases.LinuxEffects().receive_handles(h, 3)
        self.assertEqual((h.stdin, h.stdout, h.stderr, h.launcher_pidfd, h.bootstrap_error), tuple(rights[1:]))
        self.assertEqual(h.received_handles, rights)
        self.assertTrue(h.launcher_identity_validated)
        identity.assert_called_once_with(h)

    def test_unknown_truncated_and_extra_handles_remain_owned(self):
        for data, rights, flags in ((b'Z', [60, 61], 0), (b'H' + struct.pack('<I', 456), list(range(60, 67)), 0), (b'H', [60, 61], socket.MSG_CTRUNC)):
            h = cases.Handles(123, 20, Endpoint(data, rights, flags))
            with patch.object(cases, 'ready'), patch.object(cases.os, 'close') as close, \
                 patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True):
                with self.assertRaises(cases.Refusal): cases.LinuxEffects().receive_handles(h, 3)
            self.assertEqual(h.received_handles, rights)
            close.assert_not_called(); self.assertTrue(h.retained)

    def test_failed_initial_control_retains_all_rights_and_closed_observation(self):
        h = handles(); h.control = Endpoint(b'R' + struct.pack('<I', 0), [70, 71])
        with patch.object(cases, 'ready'), patch.object(cases.os, 'close') as close, \
             patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True):
            with self.assertRaises(cases.Refusal): cases.LinuxEffects().receive_init(h, 3)
        self.assertEqual(h.received_handles, [70, 71]); self.assertEqual(h.initial_control['tag'], 'R')
        self.assertEqual(h.initial_control['rightsCount'], 2); close.assert_not_called()

    def test_audited_stderr_matches_exact_label_and_closed_errno_only(self):
        for code in BOOTSTRAP_ERRNOS:
            raw = b'reader namespaces: ' + os.strerror(code).encode() + b'\n'
            value = cases.classify_stderr(raw)
            self.assertEqual((value['classification'], value['label'], value['errno']), ('audited_perror', 'reader namespaces', code))
        for raw in (b'/PRIVATE/PATH: Permission denied\n', b'reader namespaces: Permission denied\nextra', b'reader namespace: Permission denied\n'):
            value = cases.classify_stderr(raw); self.assertEqual(value['classification'], 'unrecognized')
            self.assertNotIn('PRIVATE', json.dumps(value))
        with self.assertRaises(cases.Refusal): cases.classify_stderr(b'x' * 4097)

    def test_actual_injected_reaps_are_retained_but_never_cleanup_or_cexec_proof(self):
        h, reads, reaper = self.diagnose()
        d = h.preinit_diagnostics
        self.assertEqual((d['launcherExitCode'], d['producerExitCode']), (77, 0))
        self.assertEqual((h.preinit_launcher_wait_status, h.preinit_producer_wait_status), (77 << 8, 0))
        self.assertTrue(d['controlEof'] and d['bootstrapEof'] and d['diagnosticsComplete'])
        self.assertFalse(d['bootstrapRecordObserved']); self.assertTrue(h.retained)
        self.assertEqual(h.transport.sent, [b'W']); reaper.assert_called_once_with(123, os.WNOHANG)
        self.assertNotIn('cexec', json.dumps(d).lower()); self.assertLessEqual(max(count for _, count in reads), 4097)

    def test_nested_require_labels_match_but_inner_arguments_do_not(self):
        for label in ('reader root', 'reader skeleton', 'reader private temporary files'):
            value = cases.classify_stderr((label + ': ' + os.strerror(13) + '\n').encode())
            self.assertEqual((value['classification'], value['label'], value['errno']),
                             ('audited_perror', label, 13))
        for argument in ('.', 'mode=0755,size=16m', 'mode=1777,size=8m'):
            value = cases.classify_stderr((argument + ': ' + os.strerror(13) + '\n').encode())
            self.assertEqual((value['classification'], value['label']), ('unrecognized', 'unknown'))

    def test_exact_bootstrap_records_and_malformed_bounds(self):
        for step in range(1, len(BOOTSTRAP_STEPS) + 1):
            h, _, _ = self.diagnose(stderr=b'', bootstrap=bootstrap_record(step, 13))
            d = h.preinit_diagnostics
            self.assertEqual((d['bootstrapStep'], d['bootstrapErrno'], d['bootstrapBytes']), (BOOTSTRAP_STEPS[step - 1], 13, 8))
            self.assertTrue(d['bootstrapRecordObserved'] and d['bootstrapEof'])
        for raw in (b'x', struct.pack('<II', 13, 1), struct.pack('<II', 1, 999), b'x' * 9):
            h, _, _ = self.diagnose(stderr=b'', bootstrap=raw)
            self.assertIn(h.preinit_diagnostics['bootstrapClassification'], ('invalid', 'overflow'))
            self.assertFalse(h.preinit_diagnostics['diagnosticsComplete']); self.assertTrue(h.retained)

    def test_stderr_capture_overflow_is_closed_and_retains_debt(self):
        h, _, _ = self.diagnose(stderr=b'PRIVATE' * 1000)
        d = h.preinit_diagnostics
        self.assertEqual((d['stderrBytes'], d['nativeClassification']), (4097, 'overflow'))
        self.assertFalse(d['stderrEof'] or d['diagnosticsComplete'])
        self.assertNotIn('PRIVATE', json.dumps(d)); self.assertTrue(h.retained)

    def test_unattributed_or_expired_observation_never_queries_or_reaps(self):
        for change in ('producer_owned', 'launcher_identity_validated'):
            h = handles(); setattr(h, change, False)
            with patch.object(cases, 'poll_ready') as poll, patch.object(cases.os, 'waitpid') as reaper:
                cases.LinuxEffects().diagnose_preinit(h, 3)
            poll.assert_not_called(); reaper.assert_not_called(); self.assertEqual(h.transport.sent, [])
        h = handles()
        with patch.object(cases.os, 'set_blocking'), patch.object(cases.time, 'monotonic', return_value=3), \
             patch.object(cases, 'poll_ready') as poll, patch.object(cases.os, 'waitpid') as reaper:
            cases.LinuxEffects().diagnose_preinit(h, 3)
        poll.assert_not_called(); reaper.assert_not_called(); self.assertFalse(h.preinit_diagnostics['diagnosticsComplete'])

    def test_other_child_wait_or_nonterminal_status_cannot_be_invented_evidence(self):
        for value in ((0, 0), (999, 0), (123, 0x7F)):
            h = handles()
            with self.assertRaises((cases.Refusal, ValueError)):
                self.diagnose(h=h, stderr=b'', wait=value)
            self.assertIsNone(h.preinit_diagnostics['producerExitCode']); self.assertTrue(h.retained)
        h = handles(); h.transport.data = b'R' + struct.pack('<I', 0)
        with self.assertRaises(cases.Refusal): self.diagnose(h=h, stderr=b'')
        self.assertIsNone(h.preinit_diagnostics['launcherExitCode']); self.assertTrue(h.retained)

    def test_normal_observer_requires_exact_bootstrap_record_and_records_eof(self):
        for raw in (b'', bootstrap_record(9, 13), b'truncated', b'x'):
            h = handles(); h.stdout = 23; h.init_pidfd = 25; h.control = Endpoint()
            pending_chunks = {23: iter([b'']), 24: iter([b'']),
                              27: iter([raw, b'']) if raw else iter([b''])}
            with patch.object(cases.os, 'set_blocking'), \
                 patch.object(cases.os, 'read', side_effect=lambda fd, _: next(pending_chunks[fd])), \
                 patch.object(cases, 'poll_ready', side_effect=lambda fds, **_: (list(fds), [])), \
                 patch.object(cases.socket, 'MSG_CMSG_CLOEXEC', 0, create=True), \
                 patch.object(cases.time, 'monotonic', return_value=0):
                if raw in (b'truncated', b'x'):
                    with self.assertRaises(cases.Refusal): cases.LinuxEffects().observe(h, 3)
                else:
                    observed = cases.LinuxEffects().observe(h, 3)
                    self.assertTrue(observed.bootstrap_eof)
                    self.assertEqual(observed.bootstrap_record_observed, bool(raw))
                    self.assertEqual(h.bootstrap_observation['byteCount'], len(raw))
            self.assertTrue(h.retained)

    def test_preinit_run_stays_uncertain_after_complete_diagnostic_observations(self):
        from test_cases import InertEffects
        fx = InertEffects('same-owner')
        def receive_init(*_): raise cases.Refusal('actual initial I required')
        fx.receive_init = receive_init
        fx.diagnose_preinit = lambda h, deadline: setattr(h, 'preinit_diagnostics', {'diagnosticsComplete': True})
        with self.assertRaises(cases.CaseUncertain) as caught:
            cases.run_case('same-owner', None, b'{}', effects=fx)
        self.assertIs(caught.exception.handles, fx.h)
        self.assertTrue(fx.h.retained)
        self.assertEqual(str(caught.exception.cause), 'actual initial I required')
        self.assertNotIn('close-after-proof', fx.events)
        self.assertFalse(any(isinstance(event, tuple) and event[0] == 'request' for event in fx.events))

    def test_new_bootstrap_pipe_drain_guard_never_weakens_existing_oracles(self):
        from test_cases import InertEffects
        for eof, record in ((False, False), (True, True)):
            fx = InertEffects('same-owner'); fx.h.bootstrap_error = 27
            fields = dict(fx.observation.__dict__); fields.update(bootstrap_eof=eof, bootstrap_record_observed=record)
            fx.observation = cases.Observation(**fields)
            with self.assertRaises(cases.CaseUncertain): cases.run_case('same-owner', None, b'{}', effects=fx)
            self.assertTrue(fx.h.retained); self.assertNotIn('actual-reaps', fx.events)


if __name__ == '__main__': unittest.main()
