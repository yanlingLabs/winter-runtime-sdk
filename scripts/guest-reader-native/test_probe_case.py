"""The dependency-probe case through an injected effects table. No Linux, proc, fork, socket,
pipe or native effect; follows the injected-effects pattern of test_cases.py."""
import ast
import hashlib
from dataclasses import replace
from pathlib import Path
import unittest
from unittest.mock import patch

import native_cases as cases
import producer as p
from test_probe_line import HEALTHY, line

HEALTHY_RECORD_FIELDS = {'stackRc': 'OK', 'stackBounds': True, 'stackContains': True, 'urandomOpen': 'OK',
                         'urandomRead': True, 'getrandom': 'OK', 'procList': 'OK', 'procNumeric': 1,
                         'procRoot': True, 'canaryOpen': 'ENOENT'}
# SHA-256 of the exact source text of run_case and of class LinuxEffects at runtime-sdk 67dca46,
# before the probe case existed. The probe case must not edit either.
RUN_CASE_SHA256 = '08fc455ec76c77a4ecf01c497602498d68001ebfe6dcb813bc8bda57a4c8bb10'
LINUX_EFFECTS_SHA256 = 'c51a2a5d4e70de987092eb0d75d8b2ba6f41300aee0fef579e0fe45bf81bba0a'


class ProbeEffects:
    """Inert effects for kind 'dependency-probe': healthy by default, one field changed per test."""
    def __init__(self, stdout=HEALTHY, stderr=b'', native=0, launcher=0, producer=0):
        self.events = []
        self.h = cases.Handles(123, 20, object(), launcher_pid=456, launcher_pidfd=21, control=object(),
                               stdin=22, stdout=23, stderr=24)
        self.observation = cases.Observation(True, True, True, True, True, stdout, stderr, native)
        self.reaps = cases.Reaps(producer, launcher, None)
        self.now_calls = 0

    def now(self):
        self.now_calls += 1
        return 0 if self.now_calls == 1 else 1

    def launch(self, kind, factory, deadline):
        self.events.append(('launch', kind, deadline)); return self.h

    def receive_handles(self, h, deadline): self.events.append('handles')

    def receive_init(self, h, deadline):
        self.events.append('validated-init'); h.init_pid, h.init_pidfd = 789, 25

    def send_request(self, h, request, deadline): raise AssertionError('the probe sends no request')

    def verify_keepalive(self, h): raise AssertionError('no keepalive check')

    def exit_parent(self, h, deadline): raise AssertionError('no parent exit')

    def observe(self, h, deadline):
        assert h.retained and h.stdin == 22   # The stdin writer is neither written nor closed.
        self.events.append('observe'); return self.observation

    def reap(self, h, kind, observed, deadline):
        assert self.events[-1] == 'observe' and h.retained
        self.events.append(('reap', kind)); return self.reaps

    def close_confirmed(self, h):
        assert self.events[-1] == ('reap', 'dependency-probe')
        self.events.append('close'); h.retained = False


def run(fx=None, **kwargs):
    fx = fx or ProbeEffects(**kwargs)
    evidence = cases.run_probe_case(lambda *_: (_ for _ in ()).throw(AssertionError('actual factory invoked')), effects=fx)
    return evidence, fx


def healthy_record():
    return {'ran': True, 'line': 'valid', 'fields': dict(HEALTHY_RECORD_FIELDS),
            'observation': cases.postinit_diagnostics(cases.Observation(True, True, True, True, True, HEALTHY, b'', 0),
                                                      cases.Reaps(0, 0, None)),
            'stderrFamily': 'unknown', 'outsideCanary': {'process': 'not_visible', 'file': 'not_visible'},
            'viewContractSha256': p.view_contract_sha256(),
            'readerSuccessImplied': False, 'bunCompatibilityProven': False}


class Sequence(unittest.TestCase):
    def test_exact_sequence_and_no_request_is_ever_sent(self):
        evidence, fx = run()
        self.assertEqual(fx.events, [('launch', 'dependency-probe', 6.0), 'handles', 'validated-init', 'observe',
                                     ('reap', 'dependency-probe'), 'close'])
        self.assertTrue(evidence.descriptors_closed)
        self.assertFalse(fx.h.retained)
        self.assertFalse(evidence.config_effect_proven)
        self.assertEqual(evidence.elapsed_seconds, 1)
        self.assertEqual(fx.h.stdin, 22)   # Never closed early: no EOF was fabricated for a probe that reads no input.

    def test_healthy_probe_golden_record(self):
        evidence, fx = run()
        self.assertEqual(evidence.record, healthy_record())
        self.assertIs(fx.h.dependency_probe, evidence.record)
        self.assertIs(evidence.observation, fx.observation)
        self.assertIs(evidence.reaps, fx.reaps)
        self.assertEqual(evidence.record['viewContractSha256'], p.view_contract_sha256())
        self.assertEqual(evidence.record['observation']['stderrBytes'], 0)
        self.assertEqual(evidence.record['stderrFamily'], 'unknown')   # An empty capture is a complete capture with no report.

    def test_the_record_never_implies_reader_success_or_bun_compatibility(self):
        for fx in (ProbeEffects(), ProbeEffects(stdout=b''), ProbeEffects(native=9), ProbeEffects(stderr=b'x\n')):
            record = run(fx)[0].record
            self.assertIs(record['readerSuccessImplied'], False)
            self.assertIs(record['bunCompatibilityProven'], False)
            self.assertFalse(hasattr(run(ProbeEffects())[0], 'reader_case_set_passed'))

    def test_the_existing_diagnostic_handles_are_untouched(self):
        evidence, fx = run()
        for name in ('postinit_diagnostics', 'postinit_report_family', 'fixture_stderr_capture', 'preinit_diagnostics'):
            self.assertIsNone(getattr(fx.h, name), name)
        failing = ProbeEffects()
        failing.observe = lambda *_: (_ for _ in ()).throw(cases.Refusal('negative teardown before C deadline'))
        failure(failing, None)
        for name in ('postinit_diagnostics', 'postinit_report_family', 'fixture_stderr_capture'):
            self.assertIsNone(getattr(failing.h, name), name)

    def test_the_default_effects_table_is_the_unchanged_linux_effects(self):
        events = []
        class Table(ProbeEffects):
            def __init__(self, *a, **k): events.append('constructed'); super().__init__()
        with patch.object(cases, 'LinuxEffects', Table):
            cases.run_probe_case(lambda *_: None)
        self.assertEqual(events, ['constructed'])
        # Constructing the real table has no effect, and the real table was never edited (see Structure).
        self.assertIsNotNone(cases.LinuxEffects())

    def test_the_forbidden_reader_only_steps_are_never_called(self):
        source = Path(cases.__file__).read_text()
        function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == 'run_probe_case')
        called = [node.func.attr for node in ast.walk(function) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
        for forbidden in ('send_request', 'verify_keepalive', 'exit_parent', 'complete', 'finish_registered'):
            self.assertNotIn(forbidden, called)
        order = [name for name in called if name in ('launch', 'receive_handles', 'receive_init', 'observe', 'reap', 'close_confirmed')]
        self.assertEqual(order, ['launch', 'receive_handles', 'receive_init', 'observe', 'reap', 'close_confirmed'])


def failure(fx, change):
    """Run to a CaseUncertain; return the exception and the effects."""
    with unittest.TestCase().assertRaises(cases.CaseUncertain) as caught:
        run(fx)
    return caught.exception, fx


class ContentNeverRaises(unittest.TestCase):
    def case(self, **kwargs):
        evidence, fx = run(**kwargs)
        self.assertEqual(fx.events[-1], 'close')
        self.assertFalse(fx.h.retained)
        return evidence.record

    def test_native_wait_status_is_recorded_not_enforced(self):
        for native in (None, 1 << 8, 77 << 8, 9, 11 | 128, 0):
            record = self.case(native=native)
            self.assertEqual(record['observation']['nativeWaitStatus'], native)
            self.assertEqual(record['line'], 'valid')

    def test_launcher_status_is_recorded_not_enforced(self):
        for launcher in (1 << 8, 64 << 8, 139 << 8, 9, 11 | 128):
            record = self.case(launcher=launcher)
            self.assertEqual(record['observation']['launcherWaitStatus'], launcher)
            self.assertEqual(record['line'], 'valid')

    def test_stderr_is_recorded_not_enforced(self):
        record = self.case(stderr=b'reader root: ' + __import__('os').strerror(2).encode() + b'\n')
        self.assertEqual(record['observation']['stderrClassification'], 'audited_perror')
        self.assertEqual(record['observation']['stderrLabel'], 'reader root')
        self.assertEqual(record['stderrFamily'], 'unknown')
        loader = b'/instruction-reader: error while loading shared libraries: libfoo.so: cannot open shared object file\n'
        self.assertEqual(self.case(stderr=loader)['stderrFamily'], 'loader_error_shape')
        self.assertEqual(self.case(stderr=b'x' * 4097)['observation']['stderrClassification'], 'over_classifier_bound')
        self.assertEqual(self.case(stderr=b'x' * 16384)['stderrFamily'], 'unknown')
        self.assertEqual(self.case(stderr=b'x\n')['observation']['stderrBytes'], 2)

    def test_stdout_grammar_is_recorded_not_enforced(self):
        for stdout, want, framing in ((b'', 'absent', 'empty'), (b'garbage\n', 'unknown', 'one_lf'), (HEALTHY[:-1], 'unknown', 'unterminated'),
                                      (HEALTHY + HEALTHY, 'unknown', 'multiple_lf'), (HEALTHY.replace(b'v2', b'v1'), 'unknown', 'one_lf'),
                                      (b'\n', 'unknown', 'one_lf'), (b'\xff' * 400, 'unknown', 'unterminated')):
            record = self.case(stdout=stdout)
            self.assertEqual((record['line'], record['observation']['stdoutFraming']), (want, framing), stdout)
            self.assertIsNone(record['fields'])
            self.assertEqual(record['outsideCanary'], {'process': 'unknown', 'file': 'unknown'})

    def test_unhealthy_but_valid_lines_are_content_too(self):
        record = self.case(stdout=line(stack_rc=22, stack_bounds=0, stack_contains=0, getrandom=38, proc_numeric=3, canary_open=0))
        self.assertEqual(record['line'], 'valid')
        self.assertEqual(record['fields']['stackRc'], 'EINVAL')
        self.assertEqual(record['fields']['getrandom'], 'ENOSYS')
        self.assertEqual(record['outsideCanary'], {'process': 'visible', 'file': 'visible'})

    def test_a_crashed_probe_report_family_is_recorded(self):
        from test_report_family import bun
        raw = bun()
        record = self.case(stdout=b'', stderr=raw, native=11 | 128)
        self.assertEqual(record['stderrFamily'], 'bun_report_shape')
        self.assertEqual(record['line'], 'absent')

    def test_malformed_wait_status_leaves_the_content_but_not_the_observation(self):
        record = self.case(native=0xffff)
        self.assertEqual(record['observation'], {'available': False})
        self.assertEqual(record['line'], 'valid')
        self.assertEqual(record['outsideCanary'], {'process': 'not_visible', 'file': 'not_visible'})

    def test_oversized_stderr_in_the_observation_does_not_raise(self):
        fx = ProbeEffects(); fx.observation = replace(fx.observation, stderr=b'x' * 16385)
        record = run(fx)[0].record
        self.assertEqual(record['observation'], {'available': False})
        self.assertEqual(record['stderrFamily'], 'classification_error')

    def test_non_bytes_stdout_or_stderr_is_content_too(self):
        for stdout, stderr in (('text', b''), (None, b''), (HEALTHY, 'text'), (HEALTHY, None), (bytearray(HEALTHY), b'')):
            fx = ProbeEffects(); fx.observation = replace(fx.observation, stdout=stdout, stderr=stderr)
            record = run(fx)[0].record
            self.assertIs(record['ran'], True)
            self.assertEqual(record['observation'], {'available': False})


class TeardownRaises(unittest.TestCase):
    def assert_uncertain(self, fx, last_event=None, absent=()):
        error, fx = failure(fx, None)
        self.assertIs(error.handles, fx.h)
        self.assertTrue(fx.h.retained)
        for event in absent: self.assertNotIn(event, fx.events)
        self.assertNotIn('close', fx.events) if last_event != 'close' else None
        return error, fx

    def test_each_missing_independent_observation_retains_handles_and_claims_nothing_from_the_capture(self):
        for field in ('launcher_ready', 'init_ready', 'stdout_eof', 'stderr_eof', 'control_eof'):
            with self.subTest(field=field):
                fx = ProbeEffects(); fx.observation = replace(fx.observation, **{field: False})
                error, fx = self.assert_uncertain(fx, absent=(('reap', 'dependency-probe'),))
                record = fx.h.dependency_probe
                # A healthy-looking line from a case that did not finish its teardown proves nothing.
                self.assertEqual((record['line'], record['fields']), ('unknown', None))
                self.assertEqual(record['outsideCanary'], {'process': 'unknown', 'file': 'unknown'})
                self.assertEqual(record['observation'], {'available': False})   # No reap yet.

    def test_bootstrap_pipe_must_drain_without_a_failure_record(self):
        for eof, record_seen in ((False, False), (True, True), (False, True)):
            fx = ProbeEffects(); fx.h.bootstrap_error = 27
            fx.observation = replace(fx.observation, bootstrap_eof=eof, bootstrap_record_observed=record_seen)
            error, fx = self.assert_uncertain(fx, absent=(('reap', 'dependency-probe'),))
            self.assertEqual(str(error.cause), 'bootstrap pipe drained without failure record')
        fx = ProbeEffects(); fx.h.bootstrap_error = 27
        fx.observation = replace(fx.observation, bootstrap_eof=True)
        self.assertEqual(run(fx)[0].record['line'], 'valid')

    def test_producer_must_have_been_reaped_with_exit_zero(self):
        for status in (1 << 8, 78 << 8, 9):
            fx = ProbeEffects(producer=status)
            error, fx = self.assert_uncertain(fx)
            self.assertEqual(str(error.cause), 'producer actually reaped exit zero')
            self.assertNotIn('close', fx.events)
            self.assertEqual(fx.h.dependency_probe['line'], 'unknown')
            self.assertEqual(fx.h.dependency_probe['outsideCanary'], {'process': 'unknown', 'file': 'unknown'})
            self.assertEqual(fx.h.dependency_probe['observation']['producerWaitStatus'], status)   # The scalars are still kept.

    def test_launch_handle_and_init_failures_retain_handles_and_record_nothing_checked(self):
        for name in ('receive_handles', 'receive_init'):
            fx = ProbeEffects()
            def refuse(*_): raise cases.Refusal('inert attribution failure')
            setattr(fx, name, refuse)
            error, fx = self.assert_uncertain(fx, absent=('observe', ('reap', 'dependency-probe')))
            record = fx.h.dependency_probe
            self.assertEqual((record['ran'], record['line'], record['fields']), (True, 'unknown', None))
            self.assertEqual(record['outsideCanary'], {'process': 'not_checked', 'file': 'not_checked'})
            self.assertEqual((record['observation'], record['stderrFamily']), ({'available': False}, 'capture_absent'))
            self.assertEqual(record['viewContractSha256'], p.view_contract_sha256())
            self.assertIsNone(fx.h.fixture_stderr_capture)

    def test_a_validated_init_is_required_before_anything_is_observed(self):
        for init_pid, init_pidfd in ((None, 25), (1, 25), (789, None), ('789', 25), (True, 25)):
            fx = ProbeEffects()
            def attribute(h, deadline, pid=init_pid, pidfd=init_pidfd):
                fx.events.append('validated-init'); h.init_pid, h.init_pidfd = pid, pidfd
            fx.receive_init = attribute
            error, fx = self.assert_uncertain(fx, absent=('observe',))
            self.assertEqual(str(error.cause), 'validated init required')

    def test_observe_and_reap_failures_keep_what_was_observed(self):
        fx = ProbeEffects()
        def refuse(*_): raise cases.Refusal('negative teardown before C deadline')
        fx.observe = refuse
        error, fx = self.assert_uncertain(fx)
        self.assertEqual(fx.h.dependency_probe['outsideCanary'], {'process': 'not_checked', 'file': 'not_checked'})
        fx = ProbeEffects(stdout=line(proc_numeric=2))
        def reap_fails(h, kind, observed, deadline): raise cases.Refusal('actual producer reap')
        fx.reap = reap_fails
        error, fx = self.assert_uncertain(fx)
        record = fx.h.dependency_probe
        self.assertEqual((record['line'], record['outsideCanary']), ('unknown', {'process': 'unknown', 'file': 'unknown'}))   # Even a leak seen in a failed case.
        self.assertEqual(record['observation'], {'available': False})

    def test_deadlines_bound_the_case_and_the_discharge(self):
        for ticks in ((0.0, 6.0), (0.0, 6.5), (0.0, -1.0)):
            fx = ProbeEffects(); iterator = iter(ticks); fx.now = lambda: next(iterator)
            error, fx = self.assert_uncertain(fx)
            self.assertEqual(str(error.cause), 'bounded case before native deadline')
            self.assertNotIn('close', fx.events)
        fx = ProbeEffects(); iterator = iter((0.0, 1.0, 6.0)); fx.now = lambda: next(iterator)
        error, fx = failure(fx, None)   # The discharge itself happened; only its deadline was missed.
        self.assertEqual(str(error.cause), 'descriptor discharge before case deadline')
        self.assertEqual(fx.events[-1], 'close')
        self.assertEqual(fx.h.dependency_probe['line'], 'unknown')   # The case failed, so its capture is not trusted.
        self.assertIs(error.handles, fx.h)

    def test_close_that_does_not_discharge_is_uncertain(self):
        fx = ProbeEffects()
        def keeps(h): fx.events.append('close')
        fx.close_confirmed = keeps
        error, fx = self.assert_uncertain(fx, last_event='close')
        self.assertEqual(str(error.cause), 'confirmed descriptor discharge')
        fx = ProbeEffects()
        def fails(h): raise cases.Refusal('case descriptor close failures retained')
        fx.close_confirmed = fails
        error, fx = self.assert_uncertain(fx)
        self.assertTrue(fx.h.retained)

    def test_preinit_diagnosis_is_requested_only_for_a_failure_before_a_validated_init(self):
        for failing, diagnosed in (('receive_handles', True), ('receive_init', True), ('observe', False), ('reap', False)):
            fx = ProbeEffects(); calls = []
            fx.diagnose_preinit = lambda h, deadline, calls=calls: calls.append('diagnose')
            def refuse(*_): raise cases.Refusal('inert failure')
            setattr(fx, failing, refuse)
            with self.assertRaises(cases.CaseUncertain): run(fx)
            self.assertEqual(calls == ['diagnose'], diagnosed, failing)
        fx = ProbeEffects()
        def fail_diagnosis(*_): raise ValueError('diagnosis failure must not replace the cause')
        fx.diagnose_preinit = fail_diagnosis
        fx.receive_init = lambda *_: (_ for _ in ()).throw(cases.Refusal('original injected failure'))
        error, _ = failure(fx, None)
        self.assertEqual(str(error.cause), 'original injected failure')

    def test_a_record_failure_cannot_replace_the_original_refusal(self):
        fx = ProbeEffects(); fx.reap = lambda *_: (_ for _ in ()).throw(cases.Refusal('original injected failure'))
        with patch.object(cases, 'build_probe_record', side_effect=RuntimeError('record failure')):
            with self.assertRaises(cases.CaseUncertain) as caught: run(fx)
        self.assertEqual(str(caught.exception.cause), 'original injected failure')
        self.assertIsNone(fx.h.dependency_probe)
        self.assertTrue(fx.h.retained)


class FailedCaseNeverClaimsNotVisible(unittest.TestCase):
    """A record from a case that did not complete its teardown predicates reports line `unknown` and both canary
    halves `unknown`, whatever its capture looks like. Only the completed success path may say `not_visible`."""
    UNKNOWN = {'process': 'unknown', 'file': 'unknown'}

    def assert_nothing_claimed(self, fx, *, line='unknown'):
        with self.assertRaises(cases.CaseUncertain): run(fx)
        record = fx.h.dependency_probe
        self.assertEqual((record['ran'], record['line'], record['fields']), (True, line, None))
        self.assertEqual(record['outsideCanary'], self.UNKNOWN)
        for half in record['outsideCanary'].values(): self.assertNotEqual(half, 'not_visible')
        self.assertIs(record['readerSuccessImplied'], False)
        return record

    def test_no_stdout_eof_with_a_healthy_looking_line(self):
        fx = ProbeEffects(); fx.observation = replace(fx.observation, stdout_eof=False)
        self.assertEqual(fx.observation.stdout, HEALTHY)
        self.assert_nothing_claimed(fx)

    def test_no_stdout_eof_and_an_empty_capture_is_unknown_not_absent(self):
        fx = ProbeEffects(stdout=b''); fx.observation = replace(fx.observation, stdout_eof=False)
        self.assert_nothing_claimed(fx)

    def test_reap_that_raises(self):
        fx = ProbeEffects(); fx.reap = lambda *_: (_ for _ in ()).throw(cases.Refusal('actual producer reap'))
        record = self.assert_nothing_claimed(fx)
        self.assertEqual(record['observation'], {'available': False})

    def test_nonzero_producer_status(self):
        for status in (1 << 8, 9):
            record = self.assert_nothing_claimed(ProbeEffects(producer=status))
            self.assertEqual(record['observation']['producerWaitStatus'], status)

    def test_every_other_teardown_failure_after_a_healthy_looking_observation(self):
        def refuses(name):
            fx = ProbeEffects(); setattr(fx, name, lambda *_: (_ for _ in ()).throw(cases.Refusal('inert failure'))); return fx
        def keeps():
            fx = ProbeEffects(); fx.close_confirmed = lambda h: fx.events.append('close'); return fx
        def slow():
            fx = ProbeEffects(); iterator = iter((0.0, 6.0)); fx.now = lambda: next(iterator); return fx
        def bootstrap():
            fx = ProbeEffects(); fx.h.bootstrap_error = 27
            fx.observation = replace(fx.observation, bootstrap_eof=False); return fx
        for name, fx in (('close fails', refuses('close_confirmed')), ('close does not discharge', keeps()),
                         ('case deadline', slow()), ('bootstrap pipe', bootstrap())):
            with self.subTest(name):
                self.assert_nothing_claimed(fx)
        for field in ('launcher_ready', 'init_ready', 'stderr_eof', 'control_eof'):
            with self.subTest(field):
                fx = ProbeEffects(); fx.observation = replace(fx.observation, **{field: False})
                self.assert_nothing_claimed(fx)

    def test_a_leak_seen_in_a_failed_case_is_unknown_too(self):
        fx = ProbeEffects(stdout=line(proc_numeric=2, canary_open=0)); fx.observation = replace(fx.observation, stdout_eof=False)
        self.assert_nothing_claimed(fx)

    def test_the_builder_needs_both_a_completed_case_and_stdout_eof(self):
        observed = cases.Observation(True, True, True, True, True, HEALTHY, b'', 0)
        reaps = cases.Reaps(0, 0, None)
        def build(observed=observed, complete=True):
            return cases.build_probe_record(observed, reaps, init_bound=True, view_contract=p.view_contract_sha256(), complete=complete)
        self.assertEqual((build()['line'], build()['outsideCanary']), ('valid', {'process': 'not_visible', 'file': 'not_visible'}))
        for complete in (False, None, 1, 'True'):
            self.assertEqual((build(complete=complete)['line'], build(complete=complete)['outsideCanary']), ('unknown', self.UNKNOWN), complete)
        for eof in (False, None, 1, 'yes'):
            record = build(replace(observed, stdout_eof=eof))
            self.assertEqual((record['line'], record['fields'], record['outsideCanary']), ('unknown', None, self.UNKNOWN), eof)
        with self.assertRaises(TypeError): cases.build_probe_record(observed, reaps, init_bound=True, view_contract='0' * 64)

    def test_the_projection_keeps_such_a_record_and_the_success_golden_is_unchanged(self):
        import bootstrap as b
        fx = ProbeEffects(stdout=b''); fx.observation = replace(fx.observation, stdout_eof=False)
        record = self.assert_nothing_claimed(fx)
        self.assertEqual(b.probe_projection(record), record)
        self.assertEqual(run()[0].record, healthy_record())


class ViewContract(unittest.TestCase):
    def test_the_record_digest_follows_the_environment_handed_to_the_operation_and_equals_the_operations_own(self):
        from test_executable_role import operation, RECEIPT_FD
        environment = p.selected_host_exec_environment()
        fx = ProbeEffects()
        evidence = cases.run_probe_case(lambda *_: None, effects=fx, exec_environment=environment)
        self.assertEqual(evidence.record['viewContractSha256'], p.view_contract_sha256(environment))
        self.assertEqual(evidence.record['viewContractSha256'], p.view_contract_sha256())
        # The digest an operation built with that environment computes for itself (descriptor numbers are masked).
        self.assertEqual(evidence.record['viewContractSha256'],
                         operation('instructionReaderDependencyProbe', exec_environment=environment).view_contract_sha256(RECEIPT_FD))

    def test_any_other_environment_is_refused_before_a_single_effect(self):
        import types
        for bad in (types.MappingProxyType({}), types.MappingProxyType(dict(p.selected_host_exec_environment(), TZ='Europe/Paris')),
                    dict(p.selected_host_exec_environment())):
            fx = ProbeEffects()
            with self.assertRaises(cases.Refusal):
                cases.run_probe_case(lambda *_: None, effects=fx, exec_environment=bad)
            self.assertEqual(fx.events, [])
            self.assertEqual(fx.now_calls, 0)


class Structure(unittest.TestCase):
    source = Path(cases.__file__).read_text()
    tree = ast.parse(source)

    def segment(self, name, kind):
        node = next(node for node in self.tree.body if isinstance(node, kind) and node.name == name)
        return ast.get_source_segment(self.source, node)

    def test_run_case_and_linux_effects_source_text_is_unchanged(self):
        self.assertEqual(hashlib.sha256(self.segment('run_case', ast.FunctionDef).encode()).hexdigest(), RUN_CASE_SHA256)
        self.assertEqual(hashlib.sha256(self.segment('LinuxEffects', ast.ClassDef).encode()).hexdigest(), LINUX_EFFECTS_SHA256)

    def test_the_probe_case_is_separate_from_the_reader_cases(self):
        self.assertEqual(cases.KINDS, ('same-owner', 'unexpected-parent', 'parent-exit'))
        self.assertNotIn(cases.PROBE_KIND, cases.KINDS)
        self.assertEqual(cases.PROBE_KIND, 'dependency-probe')
        for name, kind in (('run_case', ast.FunctionDef), ('LinuxEffects', ast.ClassDef)):
            text = self.segment(name, kind).lower()
            for word in ('probe', 'dependency', 'view_contract', 'build_probe'): self.assertNotIn(word, text, name)
        with self.assertRaises(cases.Refusal): cases.run_case(cases.PROBE_KIND, None, effects=ProbeEffects())

    def test_the_real_effects_table_treats_the_probe_kind_as_a_valid_owner_shape(self):
        # LinuxEffects only compares `kind` with these two literals, so 'dependency-probe' takes the
        # same-owner-style branches: no ancestor socket pair, and the W producer-reap path.
        compared = set()
        for method in ast.walk(ast.parse(self.segment('LinuxEffects', ast.ClassDef))):
            if isinstance(method, ast.FunctionDef) and 'kind' in [a.arg for a in method.args.args]:
                for node in ast.walk(method):
                    if isinstance(node, ast.Compare) and isinstance(node.left, ast.Name) and node.left.id == 'kind':
                        compared |= {c.value for c in node.comparators if isinstance(c, ast.Constant)}
        self.assertEqual(compared, {'unexpected-parent', 'parent-exit'})

    def test_run_probe_case_is_defined_after_the_reader_machinery_and_changes_no_existing_name(self):
        names = [node.name for node in self.tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))]
        for name in ('run_case', 'LinuxEffects', 'classify_report_family', 'report_family_for_case', 'postinit_diagnostics'):
            self.assertLess(names.index(name), names.index('run_probe_case'), name)
        self.assertLess(names.index('postinit_diagnostics'), names.index('parse_probe_line'))
        self.assertLess(names.index('classify_stderr'), names.index('parse_probe_line'))

    def test_new_require_reasons_stay_inside_the_reviewed_catalog(self):
        import bootstrap as b
        function = next(node for node in self.tree.body if isinstance(node, ast.FunctionDef) and node.name == 'run_probe_case')
        reasons = {call.args[1].value for call in ast.walk(function)
                   if isinstance(call, ast.Call) and isinstance(call.func, ast.Name) and call.func.id == 'require'
                   and len(call.args) > 1 and isinstance(call.args[1], ast.Constant)}
        self.assertTrue(reasons)
        self.assertLessEqual(reasons, set(b.ERROR_REASONS))


if __name__ == '__main__': unittest.main()
