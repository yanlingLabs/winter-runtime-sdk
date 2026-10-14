"""Temporary SOURCE DATA copies and inert code/table tests, never native effects."""
import hashlib
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wrapper as w
OBSERVED_TIME=datetime(2026,10,14,tzinfo=timezone.utc)
RECORD={'metadata':dict(w.ACQUISITION_METADATA),'checked_at':OBSERVED_TIME.isoformat(),
    'directory':'/unprivileged/data','directory_identity':{},'outer_zip_sha256':w.OUTER_ZIP_SHA256,
    'outer_zip_identity':{},'members':[{'name':name,'path':'/unprivileged/data/'+name,
        'size':size,'sha256':digest,'identity':{}} for name,(size,digest) in w.ACQUISITION_MEMBERS.items()],
    'packet_data_validated':True,'packet_code_imported':False,'native_execution':False,
    'source_admission':False,'execution_admission':False,'vm_execution':False}
ACQUISITION={'acquisition_record':RECORD,'now':OBSERVED_TIME}


class SyntheticOwner(w.OwnerOps):
    def owner(self, fd): return 0
    def protected_ancestor(self, fd): return True


class Tests(unittest.TestCase):
    def data(self, temporary):
        source, private = Path(temporary).resolve()/'source', Path(temporary).resolve()/'private'
        source.mkdir(); private.mkdir(mode=0o700)
        bodies = {name: b'MARKER=42\n' for name in w.SOURCE_PINS}
        bodies['native_cases.py'] = b'from producer import MARKER\nassert MARKER==42\n'
        pins = {}
        for name, raw in bodies.items():
            (source/name).write_bytes(raw); pins[name]=hashlib.sha256(raw).hexdigest()
        pin=source/w.COMPILE_PIN;pin.write_bytes(b'{"fixture":true}')
        lease=w.copy_external_sources(source,private/'copy',ops=SyntheticOwner(),pins=pins,
            compile_pin_path=pin,compile_pin_sha256=hashlib.sha256(pin.read_bytes()).hexdigest())
        self.addCleanup(self.cleanup,lease)
        return source,lease,pins

    def cleanup(self, lease):
        # Ordinary test DATA only; never a native teardown oracle.
        lease.unresolved=False
        if not lease.closed:lease.close()
        if lease.path.exists():os.chmod(lease.path,0o700)

    def test_independent_readonly_copy_and_synthetic_native_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            source,lease,_=self.data(temporary)
            try:
                lease.recheck()
                self.assertTrue(lease.synthetic)
                self.assertEqual(set(lease.files),set(w.SOURCE_PINS)|{w.COMPILE_PIN})
                for name,(fd,_) in lease.files.items():
                    self.assertNotEqual(os.fstat(fd).st_ino,os.stat(source/name).st_ino)
                    self.assertEqual(os.fstat(fd).st_mode & 0o777,0o400)
                with patch.object(w,'load_external_modules') as loader:
                    with self.assertRaises(w.Refusal):
                        w.run_cases(lease,'packet','inventory','launch','fixture',**ACQUISITION)
                    loader.assert_not_called()
            finally:self.cleanup(lease)

    def test_all_hashes_before_destination_and_reserved_pin_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            source,lease,pins=self.data(temporary)
            try:
                (source/'parent.py').write_bytes(b'changed')
                with self.assertRaises(w.Uncertain) as caught:
                    w.copy_external_sources(source,lease.path.parent/'new',ops=SyntheticOwner(),pins=pins)
                self.assertFalse((lease.path.parent/'new').exists())
                caught.exception.lease.unresolved=False;caught.exception.lease.close()
                for wrong in ({},dict(pins,foreign='0'*64)):
                    with self.assertRaises(w.Refusal):
                        w.copy_external_sources(source,lease.path.parent/'new',ops=SyntheticOwner(),pins=wrong)
            finally:self.cleanup(lease)

    def test_symlink_and_hardlink_sources_refuse_without_destination(self):
        for kind in ('symlink','hardlink'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temporary:
                source,lease,pins=self.data(temporary)
                try:
                    path=source/'control.py';old=source/'old'
                    path.rename(old)
                    if kind=='symlink':path.symlink_to('old')
                    else:os.link(old,path)
                    with self.assertRaises(w.Uncertain) as caught:
                        w.copy_external_sources(source,lease.path.parent/'new',ops=SyntheticOwner(),pins=pins)
                    self.assertFalse((lease.path.parent/'new').exists())
                    caught.exception.lease.unresolved=False;caught.exception.lease.close()
                finally:self.cleanup(lease)

    def test_no_unchecked_module_alias_or_filesystem_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            _,lease,_=self.data(temporary)
            before=list(sys.path)
            try:
                with patch.dict(sys.modules):
                    for name,_ in w.MODULE_ORDER:sys.modules.pop(name,None)
                    sys.modules['producer']=SimpleNamespace(MARKER=-1)
                    with self.assertRaises(w.Refusal):w.load_external_modules(lease)
                    sys.modules.pop('producer')
                    modules=w.load_external_modules(lease)
                    self.assertEqual(modules['native_cases'].MARKER,42)
                    self.assertIs(sys.modules['producer'],modules['producer'])
                    self.assertEqual(sys.path,before)
                    lease.recheck()
                    sys.modules['producer']=SimpleNamespace(MARKER=42)
                    with self.assertRaises(w.Refusal):lease.recheck()
            finally:self.cleanup(lease)

    def test_copy_inventory_and_hash_change_refuse_before_import(self):
        for kind in ('extra','changed'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as temporary:
                _,lease,_=self.data(temporary)
                try:
                    if kind=='extra':
                        os.chmod(lease.path,0o700);(lease.path/'other.py').write_bytes(b'raise Exception()')
                    else:
                        path=lease.path/'control.py';os.chmod(path,0o600);path.write_bytes(b'changed')
                    with self.assertRaises(w.Refusal):w.load_external_modules(lease)
                finally:self.cleanup(lease)

    def test_uncertain_lease_cannot_close_or_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            _,lease,_=self.data(temporary)
            try:
                owned=set(lease.fds);lease.unresolved=True
                with self.assertRaises(w.Refusal):lease.close()
                with self.assertRaises(w.Refusal):w.load_external_modules(lease)
                self.assertEqual(set(lease.fds),owned)
            finally:self.cleanup(lease)

    def test_isolated_flags_required_even_for_otherwise_real_lease(self):
        fake=SimpleNamespace(synthetic=False,unresolved=False,recheck=lambda:None)
        with patch.object(w.sys,'platform','linux'),patch.object(w.os,'getuid',return_value=0),patch.object(w.os,'geteuid',return_value=0),patch.object(w.sys,'flags',SimpleNamespace(isolated=0,no_site=1)):
            with self.assertRaises(w.Refusal):w.native_guard(fake)

    def test_partial_source_walk_attempts_all_closes_and_retains_failed_handle(self):
        calls=[]
        def close(fd):
            calls.append(fd)
            if fd==80:raise OSError('inert close failure')
        with patch.object(w.os,'open',side_effect=[80,81,OSError('inert ancestor refusal')]),patch.object(w.os,'close',side_effect=close):
            with self.assertRaises(w.Uncertain) as caught:
                w.copy_external_sources('/safe/fail','/protected/new',ops=SyntheticOwner())
        self.assertEqual(calls,[81,80])
        self.assertEqual(caught.exception.lease.fds,[80])
        self.assertTrue(caught.exception.lease.unresolved)

    def orchestrator(self, failure=None):
        events=[]
        class Resource:
            def __init__(self,name):self.name=name;self.closed=False
            def close(self):events.append('close-'+self.name);self.closed=True
            def recheck(self):events.append('check-'+self.name)
        snapshot,runtime,fixture=(Resource(name) for name in ('snapshot','runtime','fixture'))
        fixture.fds={'source':30,'shared':31}
        lease=SimpleNamespace(path=Path('/run/reader-wrapper/sources'),unresolved=False,
            recheck=lambda:events.append('source-check'),case_failure=None)
        pin=object()
        def capture(packet,inventory,*,pin):
            self.assertIs(pin,expected_pin);events.append('capture');return snapshot
        expected_pin=pin
        def pin_load(path):
            self.assertEqual(path,lease.path/w.COMPILE_PIN);events.append('pin-load');return pin
        parent=SimpleNamespace(load_pin=pin_load,capture_packet=capture,
            create_launch_root=lambda *_:runtime,guard_root_owner=lambda _:events.append('guard-root'),
            recheck_runtime=lambda _:events.append('runtime-check'))
        producer=SimpleNamespace(descriptor_preflight=lambda:events.append('preflight'),
            NativeOperation=lambda *args,**kw:SimpleNamespace(debt=args[0]))
        data=SimpleNamespace(create_fixture=lambda _:fixture,request_bytes=lambda:b'compact-input',
            verify_response=lambda out,err:events.append('frame-check'))
        def case(kind,factory,request,**kwargs):
            events.append(kind)
            if kwargs:events.append(('effects',kwargs['effects']))
            self.assertEqual(request,b'compact-input' if kind=='same-owner' else b'')
            debt=object();self.assertIs(factory(debt,None).debt,debt)
            if kind==failure:raise ValueError('inert uncertain case')
            return SimpleNamespace(descriptors_closed=True,elapsed_seconds=.25,
                observation=SimpleNamespace(stdout=b'frame',stderr=b'',native_wait_status=0 if kind=='same-owner' else None),
                reaps=SimpleNamespace(launcher_status=0 if kind=='same-owner' else 64<<8 if kind=='unexpected-parent' else 9,
                    producer_status=0,init_status=9 if kind=='parent-exit' else None),
                keepalive_before_parent_exit=kind=='parent-exit')
        modules={'reader_parent':parent,'producer':producer,'reader_fixture':data,
                 'native_cases':SimpleNamespace(run_case=case)}
        return lease,modules,events,(snapshot,runtime,fixture)

    def test_relocated_explicit_pin_and_closed_success_ordering(self):
        lease,modules,events,resources=self.orchestrator()
        with patch.object(w,'native_guard'),patch.object(w,'load_external_modules',return_value=modules):
            result=w.run_cases(lease,'packet','inventory',lease.path.parent/'runtime',lease.path.parent/'fixture',**ACQUISITION)
        self.assertTrue(result['readerCaseSetPassed']);self.assertEqual(lease.stage,'close')
        self.assertEqual([case['kind'] for case in result['cases']],['same-owner','unexpected-parent','parent-exit'])
        self.assertEqual(events[-4:],['close-fixture','close-runtime','close-snapshot','source-check'])
        self.assertTrue(all(resource.closed for resource in resources))
        self.assertLess(events.index('pin-load'),events.index('capture'))
        self.assertFalse(result['configEffectProven']);self.assertFalse(result['fixtureRemovalConfirmed'])

    def test_case_failure_keeps_actual_contexts_and_does_not_close_or_pass(self):
        lease,modules,events,resources=self.orchestrator('unexpected-parent')
        with patch.object(w,'native_guard'),patch.object(w,'load_external_modules',return_value=modules):
            with self.assertRaises(w.Uncertain) as caught:
                w.run_cases(lease,'packet','inventory',lease.path.parent/'runtime',lease.path.parent/'fixture',**ACQUISITION)
        self.assertIs(caught.exception.lease,lease)
        self.assertEqual(lease.stage,'case:unexpected-parent:run')
        self.assertIs(lease.snapshot,resources[0]);self.assertIs(lease.runtime,resources[1]);self.assertIs(lease.fixture,resources[2])
        self.assertTrue(lease.unresolved);self.assertFalse(any(resource.closed for resource in resources))
        self.assertNotIn('parent-exit',events)

    def test_preflight_failure_retains_closed_stage_before_any_capture(self):
        lease,modules,events,resources=self.orchestrator()
        def fail():raise OSError(24,'unserialized private path')
        modules['producer'].descriptor_preflight=fail
        with patch.object(w,'native_guard'),patch.object(w,'load_external_modules',return_value=modules):
            with self.assertRaises(w.Uncertain) as caught:
                w.run_cases(lease,'packet','inventory',lease.path.parent/'runtime',lease.path.parent/'fixture',**ACQUISITION)
        self.assertEqual(caught.exception.lease.stage,'preflight')
        self.assertNotIn('capture',events)
        self.assertTrue(lease.unresolved)
        self.assertFalse(any(resource.closed for resource in resources))

    def test_wrong_sibling_path_refuses_before_import_or_capture(self):
        lease,modules,events,_=self.orchestrator()
        with patch.object(w,'native_guard'),patch.object(w,'load_external_modules') as loader:
            with self.assertRaises(w.Refusal):w.run_cases(lease,'packet','inventory','/tmp/other','/tmp/fixture',**ACQUISITION)
            loader.assert_not_called()

    def test_only_exact_checked_modules_and_trusted_effects_are_reused(self):
        lease,modules,events,_=self.orchestrator()
        modules['control']=object()
        lease.modules=modules
        with patch.object(w,'native_guard'):
            result=w.run_cases(lease,'packet','inventory',lease.path.parent/'runtime',lease.path.parent/'fixture',
                **ACQUISITION,loaded_modules=dict(modules),effects_factory=lambda kind:'instrument-'+kind)
        self.assertTrue(result['readerCaseSetPassed'])
        self.assertEqual([event for event in events if isinstance(event,tuple)],
            [('effects','instrument-same-owner'),('effects','instrument-unexpected-parent'),('effects','instrument-parent-exit')])
        foreign=dict(modules,producer=object())
        with patch.object(w,'native_guard'):
            with self.assertRaises(w.Refusal):
                w.run_cases(lease,'packet','inventory',lease.path.parent/'runtime',lease.path.parent/'fixture',
                    **ACQUISITION,loaded_modules=foreign)

    def test_expired_foreign_and_bool_metadata_refuse_before_any_import_or_effect(self):
        lease,_,_,_=self.orchestrator()
        for key,value in (('expired',True),('repository_id',True),('head_sha','0'*40),('size_in_bytes',0)):
            metadata=dict(w.ACQUISITION_METADATA);metadata[key]=value
            with patch.object(w,'native_guard') as guard,patch.object(w,'load_external_modules') as loader:
                with self.assertRaises(w.Refusal):
                    w.run_cases(lease,'packet','inventory','launch','fixture',acquisition_record=dict(RECORD,metadata=metadata),now=OBSERVED_TIME)
                guard.assert_not_called();loader.assert_not_called()
        for now in (datetime(2026,10,21,2,45,33,tzinfo=timezone.utc),datetime(2026,10,14)):
            with patch.object(w,'native_guard') as guard:
                with self.assertRaises(w.Refusal):
                    w.run_cases(lease,'packet','inventory','launch','fixture',acquisition_record=RECORD,now=now)
                guard.assert_not_called()

    def test_record_member_hash_and_module_file_path_cannot_drift(self):
        members=[dict(member) for member in RECORD['members']]
        members[0]['sha256']='0'*64
        with self.assertRaises(w.Refusal):w.check_acquisition_record(dict(RECORD,members=members),OBSERVED_TIME)
        with tempfile.TemporaryDirectory() as temporary:
            _,lease,_=self.data(temporary)
            try:
                with patch.dict(sys.modules):
                    for name,_ in w.MODULE_ORDER:sys.modules.pop(name,None)
                    modules=w.load_external_modules(lease)
                    modules['producer'].__file__='/foreign/producer.py'
                    with self.assertRaises(w.Refusal):lease.recheck()
            finally:self.cleanup(lease)


if __name__=='__main__':unittest.main()
