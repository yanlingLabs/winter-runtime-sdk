"""Fixed PUBLIC fixture DATA only. No launch, privileged effects or real guidance."""
import base64
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace,MappingProxyType
import unittest
from unittest.mock import patch
import bootstrap as b
import wrapper as w
import producer as p
import fixture as f
import native_cases as cases
from test_cases import InertEffects


class Tests(unittest.TestCase):
    def bound(self):
        # Inert SourceLease DATA: never calls native_guard or mints admission.
        lease=object.__new__(w.SourceLease)
        lease.path=Path('/run/fixed/sources');lease.synthetic=False;lease.closed=False;lease.unresolved=False
        lease.snapshot=object();lease.runtime=object();lease.fixture=SimpleNamespace(path=lease.path.parent/'fixture')
        modules={'reader_fixture':f,'producer':p,'reader_parent':object(),'control':object(),'native_cases':cases}
        lease.modules=modules
        pin=SimpleNamespace(sha256=w.COMPILE_PIN_SHA256)
        return lease,pin,modules

    def export(self,raw,kind='same-owner'):
        lease,pin,modules=self.bound()
        export=w._fixture_stderr_exporter(lease,pin,modules,p.selected_host_exec_environment())
        return export(SimpleNamespace(handles=SimpleNamespace(fixture_stderr_capture=raw)),kind)

    def project(self,raw):
        return b.stderr_sample_record([SimpleNamespace(lease=SimpleNamespace(fixture_stderr_sample=raw))])

    def test_exact_fixed_fake_fixture_contract_and_prefix_bounds(self):
        for size in (0,1,4096,4097,16384):
            raw=(b'fixture stderr!\n'*1100)[:size]
            sample=self.export(raw)
            self.assertTrue(sample['available'])
            self.assertEqual(base64.b64decode(sample['bytesBase64']),raw[:4096])
            self.assertEqual(sample['sampleSha256'],hashlib.sha256(raw[:4096]).hexdigest())
            self.assertEqual(sample['truncated'],size>4096)
            self.assertEqual(self.project(sample),sample)
        self.assertEqual(self.export(b'x'*16385)['reason'],'capture_absent')
        self.assertEqual(self.export(None)['reason'],'capture_absent')

    def test_full_capture_scrub_rejects_before_prefix_and_never_redacts(self):
        for marker in (b'ghp_',b'gho_',b'ghu_',b'ghs_',b'ghr_',b'github_pat_',b'AUTHORIZATION',
                       b'bEaReR ',b'AKIA',b'-----BEGIN',b'A'*40,b'_'*40):
            raw=b'! '*2100+marker
            result=self.export(raw)
            self.assertEqual(result,{'available':False,'reason':'scrub_rejected'})
            self.assertNotIn('bytesBase64',result)
        self.assertTrue(self.export(b'A'*39)['available'])

    def test_packet_request_views_and_fixture_bytes_must_match(self):
        for change in ('synthetic','closed','unresolved','packet','fixture','source','shared','contents','request','lease','module'):
            with self.subTest(change=change):
                lease,pin,modules=self.bound();data=SimpleNamespace(SOURCE=f.SOURCE,SHARED=f.SHARED,CONTENTS=dict(f.CONTENTS),request_bytes=f.request_bytes)
                modules['reader_fixture']=data
                if change in ('synthetic','closed','unresolved'):setattr(lease,change,True)
                elif change=='packet':pin.sha256='0'*64
                elif change=='fixture':lease.fixture.path=Path('/foreign/fixture')
                elif change=='source':data.SOURCE='/foreign/source'
                elif change=='shared':data.SHARED='/foreign/shared'
                elif change=='contents':data.CONTENTS['source']=b'private guidance'
                elif change=='request':data.request_bytes=lambda:b'foreign request'
                elif change=='lease':lease=SimpleNamespace(**lease.__dict__)
                elif change=='module':lease.modules=dict(modules,control=object())
                export=w._fixture_stderr_exporter(lease,pin,modules,p.selected_host_exec_environment())
                self.assertEqual(export(SimpleNamespace(handles=SimpleNamespace(fixture_stderr_capture=b'!')),'same-owner')['reason'],'provenance_unverified')
        self.assertEqual(self.export(b'!','parent-exit')['reason'],'not_same_owner_failure')

    def test_selected_exec_environment_is_exact_immutable_and_unknown_refuses_before_effects(self):
        selected=p.selected_host_exec_environment()
        self.assertEqual(dict(selected),p.ENV)
        with self.assertRaises(TypeError):selected['EXTRA']='value'
        self.assertIs(p.checked_host_exec_environment(selected),selected)
        for value in (dict(selected),MappingProxyType(dict(selected,EXTRA='x')),MappingProxyType({'LANG':'C'}),MappingProxyType(dict(selected,HOME='/foreign'))):
            with self.subTest(value=dict(value)),patch.object(p,'root_linux') as effect:
                with self.assertRaises(p.Refusal):p.child_bootstrap(10,(),(),(),exec_environment=value)
                effect.assert_not_called()
        with patch.dict(p.ENV,{'EXTRA':'x'}):
            with self.assertRaises(p.Refusal):p.selected_host_exec_environment()

    def test_strict_sample_projection_refuses_every_malformed_variant(self):
        positive=self.export(b'fixture!')
        for mutation in ({'extra':0},{'available':1},{'bytesBase64':1},{'bytesBase64':'Zh=='},
                         {'bytesBase64':'?==='},{'truncated':1},{'truncated':True},
                         {'sampleSha256':'0'*64},{'sampleSha256':'A'*64},{'bytesBase64':'A'*5465}):
            self.assertEqual(self.project(dict(positive,**mutation)),{'available':False,'reason':'projection_error'})
        for value in ({},[],{'available':False},{'available':False,'reason':'secret'},
                      {'available':False,'reason':'capture_absent','extra':0}):
            self.assertEqual(self.project(value),{'available':False,'reason':'projection_error'})
        for reason in b.SAMPLE_REASONS:self.assertEqual(self.project({'available':False,'reason':reason}),{'available':False,'reason':reason})

    def test_log_projection_omits_sample_bytes_and_original_debt_flags_survive(self):
        lease=SimpleNamespace(stage='case:same-owner:run',fixture_stderr_sample=self.export(b'fake diagnostic!'),unresolved=True)
        cause=w.Refusal('same-owner native control outcome');error=w.Uncertain(lease,cause)
        record=b.failure_record(error)
        # A sample may only survive alongside complete matching post-init evidence.
        self.assertFalse(record['postInitStderrSample']['available'])
        record['postInitStderrSample']=lease.fixture_stderr_sample
        projected=b.log_result_projection(record)
        self.assertNotIn('bytesBase64',json.dumps(projected))
        self.assertNotIn(base64.b64encode(b'fake diagnostic!').decode(),json.dumps(projected))
        self.assertIn('bytesBase64',record['postInitStderrSample'])
        for flag in ('readerCaseSetPassed','nativeCleanupConfirmed','configEffectProven','vmExecutionVerified','productionActivation'):self.assertIs(record[flag],False)
        self.assertTrue(lease.unresolved);self.assertIs(error.cause,cause)
        old=b.failure_record(w.Uncertain(SimpleNamespace(stage=lease.stage),cause))
        for key in old:
            if key!='postInitStderrSample':self.assertEqual(record[key],old[key])

    def test_failure_sample_coherence_and_no_added_effect_or_cleanup(self):
        fx=InertEffects('same-owner')
        raw=b'public fixture panic!\n'
        from dataclasses import replace
        fx.observation=replace(fx.observation,stderr=raw)
        with self.assertRaises(cases.CaseUncertain) as caught:
            cases.run_case('same-owner',None,b'{}',effects=fx)
        self.assertIs(fx.h.fixture_stderr_capture,raw)
        self.assertTrue(fx.h.retained);self.assertEqual(fx.events[-1],'actual-reaps')
        self.assertNotIn('close-after-proof',fx.events)
        lease=SimpleNamespace(stage='case:same-owner:run',fixture_stderr_sample=self.export(raw))
        record=b.failure_record(w.Uncertain(lease,caught.exception))
        self.assertEqual(record['postInitStderrSample'],lease.fixture_stderr_sample)
        self.assertEqual(record['postInitDiagnostics']['stderrSha256'],hashlib.sha256(raw).hexdigest())
        lease.fixture_stderr_sample=self.export(b'other!')
        self.assertEqual(b.failure_record(w.Uncertain(lease,caught.exception))['postInitStderrSample'],{'available':False,'reason':'projection_error'})
        with patch.object(cases,'postinit_diagnostics',side_effect=ValueError('private')):
            fx=InertEffects('same-owner');fx.observation=replace(fx.observation,stderr=raw)
            with self.assertRaises(cases.CaseUncertain) as failure:cases.run_case('same-owner',None,b'{}',effects=fx)
            self.assertEqual(str(failure.exception.cause),'same-owner native control outcome')
            self.assertTrue(fx.h.retained)
            lease.fixture_stderr_sample=self.export(raw)
            self.assertFalse(b.failure_record(w.Uncertain(lease,failure.exception))['postInitStderrSample']['available'])

    def test_hosted_export_has_no_production_import_route_or_raw_log(self):
        root=Path(__file__).resolve().parents[2]
        for source in (root/'src').rglob('*.ts'):
            self.assertNotIn('guest-reader-native/wrapper',source.read_text())
        workflow=(root/'.github/workflows/cowork-reader-native-reviewed.yml').read_text()
        self.assertEqual(workflow.count('module.log_result_projection(result)'),2)
        self.assertNotIn('print(json.dumps(result,sort_keys=True))',workflow)


if __name__=='__main__':unittest.main()
