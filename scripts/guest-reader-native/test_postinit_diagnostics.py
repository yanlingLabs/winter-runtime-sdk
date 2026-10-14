"""Fixture-only post-init scalar tests; no native IO/wait/reap/close effects."""
from dataclasses import replace
import hashlib
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import bootstrap as b
import native_cases as cases
from test_cases import InertEffects


def make(stdout=b'fixture\n',stderr=b'',native=0,launcher=0,producer=0):
    observed=cases.Observation(True,True,True,True,True,stdout,stderr,native)
    return observed,cases.Reaps(producer,launcher,None)


class Tests(unittest.TestCase):
    def test_each_outcome_conjunct_and_combinations_keep_original_refusal_and_handles(self):
        for mask in range(1,16):
            with self.subTest(mask=mask):
                fx=InertEffects('same-owner')
                fx.observation=replace(fx.observation,native_wait_status=77<<8 if mask&1 else 0,
                    stdout=b'fixture' if mask&4 else b'fixture\n',stderr=b'fixture stderr' if mask&8 else b'')
                fx.reaps=replace(fx.reaps,launcher_status=77<<8 if mask&2 else 0)
                with self.assertRaises(cases.CaseUncertain) as caught:
                    cases.run_case('same-owner',None,b'{}',effects=fx)
                self.assertEqual(str(caught.exception.cause),'same-owner native control outcome')
                self.assertIs(caught.exception.handles,fx.h);self.assertTrue(fx.h.retained)
                self.assertEqual(fx.events[-1],'actual-reaps');self.assertNotIn('close-after-proof',fx.events)
                d=fx.h.postinit_diagnostics;self.assertTrue(d['available'])
                self.assertEqual(d['nativeWaitStatus'],fx.observation.native_wait_status)
                self.assertEqual(d['launcherWaitStatus'],fx.reaps.launcher_status)
                self.assertEqual(d['stdoutSha256'],hashlib.sha256(fx.observation.stdout).hexdigest())

    def test_missing_r_and_monitor_exit_are_not_replaced_with_native_zero(self):
        for native in (None,0,77<<8,9,11|128):
            observed,reaps=make(native=native,launcher=139<<8)
            d=cases.postinit_diagnostics(observed,reaps)
            self.assertEqual(d['nativeWaitStatus'],native)
            self.assertEqual(d['launcherWaitStatus'],139<<8)
        self.assertEqual(os.waitstatus_to_exitcode(11|128),-11)
        self.assertEqual(os.waitstatus_to_exitcode(139<<8),139)
        self.assertTrue((11|128)&128)  # Raw native core bit remains distinguishable.

    def test_framing_and_complete_bounded_hashes(self):
        for raw,kind in ((b'','empty'),(b'x','unterminated'),(b'\xff\x00','unterminated'),(b'x\n','one_lf'),(b'x\ny\n','multiple_lf'),(b'x\ny','unterminated'),(b'\n','one_lf')):
            d=cases.postinit_diagnostics(*make(stdout=raw))
            self.assertEqual((d['stdoutBytes'],d['stdoutFraming']),(len(raw),kind))
            self.assertEqual(d['stdoutSha256'],hashlib.sha256(raw).hexdigest())
        raw=b'x'*cases.IO_MAX;d=cases.postinit_diagnostics(*make(stdout=raw))
        self.assertEqual(d['stdoutSha256'],hashlib.sha256(raw).hexdigest())
        with self.assertRaises(cases.Refusal):cases.postinit_diagnostics(*make(stdout=raw+b'x'))

    def test_stderr_classifications_bounds_and_classifier_failure(self):
        known=b'reader immutable exec: '+os.strerror(2).encode()+b'\n'
        for raw,kind in ((b'','empty'),(known,'audited_perror'),(b'reader namespaces: private opaque text\n','audited_label'),(b'opaque\n','unrecognized'),(known+known,'unrecognized'),(b'x'*4096,'unrecognized')):
            d=cases.postinit_diagnostics(*make(stderr=raw))
            self.assertEqual(d['stderrClassification'],kind)
            self.assertEqual(d['stderrSha256'],hashlib.sha256(raw).hexdigest())
            if raw:self.assertNotIn(raw.decode('utf8',errors='replace'),str(d))
        for size in (4097,16384):
            with patch.object(cases,'classify_stderr',side_effect=AssertionError('no oversized classifier call')):
                d=cases.postinit_diagnostics(*make(stderr=b'x'*size))
            self.assertEqual(d['stderrClassification'],'over_classifier_bound')
        with self.assertRaises(cases.Refusal):cases.postinit_diagnostics(*make(stderr=b'x'*16385))

    def test_diagnostic_failure_does_not_replace_cause_or_add_effects(self):
        fx=InertEffects('same-owner');fx.observation=replace(fx.observation,stderr=b'private stderr')
        with patch.object(cases,'classify_stderr',side_effect=ValueError('private classifier message')):
            with self.assertRaises(cases.CaseUncertain) as caught:cases.run_case('same-owner',None,b'{}',effects=fx)
        self.assertEqual(str(caught.exception.cause),'same-owner native control outcome')
        self.assertEqual(fx.h.postinit_diagnostics,{'available':False});self.assertTrue(fx.h.retained)
        self.assertEqual(fx.events[-1],'actual-reaps')
        self.assertNotIn('close-after-proof',fx.events)

    def test_other_cases_and_pre_reap_failure_do_not_capture_post_init_data(self):
        for kind in ('same-owner','parent-exit','unexpected-parent'):
            fx=InertEffects(kind)
            def fail(*_):raise cases.Refusal('original injected failure')
            fx.receive_handles=fail
            with self.assertRaises(cases.CaseUncertain):cases.run_case(kind,None,b'{}' if kind=='same-owner' else b'',effects=fx)
            self.assertIsNone(fx.h.postinit_diagnostics)
        fx=InertEffects('parent-exit');fx.reaps=replace(fx.reaps,launcher_status=0)
        with self.assertRaises(cases.CaseUncertain):cases.run_case('parent-exit',None,effects=fx)
        self.assertIsNone(fx.h.postinit_diagnostics)
        fx=InertEffects('same-owner');cases.run_case('same-owner',None,b'{}',effects=fx)
        self.assertIsNone(fx.h.postinit_diagnostics)

    def test_raw_terminal_shapes_are_validated_before_record(self):
        for invalid in (True,-1,65536,0xffff,0x7f,0x100|9,65,128,1.0,'0'):
            for slot in ('native','launcher','producer'):
                kwargs={slot:invalid}
                with self.subTest(slot=slot,value=invalid),self.assertRaises(ValueError):cases.postinit_diagnostics(*make(**kwargs))

    def project(self,raw):
        return b.postinit_record([SimpleNamespace(handles=SimpleNamespace(postinit_diagnostics=raw))])

    def test_projection_rejects_exact_shape_type_bounds_enum_and_hash_errors(self):
        raw=cases.postinit_diagnostics(*make())
        self.assertEqual(self.project(raw),raw)
        changes={'available':1,'nativeWaitStatus':True,'launcherWaitStatus':-1,'producerWaitStatus':0xffff,
            'stdoutBytes':cases.IO_MAX+1,'stderrBytes':16385,'stdoutSha256':'A'*64,
            'stderrSha256':'a'*63,'stdoutFraming':'private','stderrClassification':'private',
            'stderrLabel':'/private/path','stderrErrno':True}
        for key,value in changes.items():
            bad=dict(raw);bad[key]=value
            with self.subTest(key=key):self.assertEqual(self.project(bad),{'available':False})
        for key in raw:
            bad=dict(raw);del bad[key];self.assertEqual(self.project(bad),{'available':False})
        self.assertEqual(self.project(dict(raw,rawOutput='/private/path')),{'available':False})
        for bad in (None,[],False,{'available':False}):self.assertEqual(self.project(bad),{'available':False})

    def test_failure_record_original_fields_and_proof_flags_unchanged(self):
        class CaseUncertain(ValueError):pass
        cause=cases.Refusal('same-owner native control outcome')
        inner=CaseUncertain('native case uncertain; ownership retained');inner.cause=cause
        inner.handles=SimpleNamespace(postinit_diagnostics=cases.postinit_diagnostics(*make(native=9)))
        import wrapper
        outer=wrapper.Uncertain(SimpleNamespace(stage='case:same-owner:run'),inner)
        with patch.object(b,'postinit_record',return_value={'available':False}):baseline=b.failure_record(outer)
        actual=b.failure_record(outer)
        self.assertEqual({k:v for k,v in actual.items() if k!='postInitDiagnostics'},
            {k:v for k,v in baseline.items() if k!='postInitDiagnostics'})
        self.assertTrue(actual['postInitDiagnostics']['available'])
        self.assertTrue(all(actual[key] is False for key in ('readerCaseSetPassed','nativeCleanupConfirmed','configEffectProven','vmExecutionVerified','productionActivation')))
        with patch.object(b,'postinit_record',side_effect=ValueError('private projection failure')):
            refused=b.failure_record(outer)
        self.assertEqual(refused['postInitDiagnostics'],{'available':False})
        self.assertEqual({k:v for k,v in refused.items() if k!='postInitDiagnostics'},
            {k:v for k,v in baseline.items() if k!='postInitDiagnostics'})
        inner.handles.postinit_diagnostics={'raw':'private'}
        self.assertEqual(b.failure_record(outer)['postInitDiagnostics'],{'available':False})


if __name__=='__main__':unittest.main()
