"""Source/Data and injected bootstrap checks. No native effects or real proc IO."""
import errno
import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import bootstrap as b


class Tests(unittest.TestCase):
    def test_checked_bytes_and_alias_load_only_owned_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary).resolve()/'module.py';raw=b'MARKER=41\n'
            path.write_bytes(raw);digest=hashlib.sha256(raw).hexdigest()
            with patch.dict(sys.modules):
                module=b.load_checked('_bootstrap_fixture',path,digest)
                self.assertEqual(module.MARKER,41)
                with self.assertRaises(b.Refusal):b.load_checked('_bootstrap_fixture',path,digest)
            path.write_bytes(b'MARKER=42\n')
            with self.assertRaises(b.Refusal):b.checked_bytes(path,digest)

    def test_symlink_and_hardlink_sources_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();path=root/'file';raw=b'FIXED';path.write_bytes(raw)
            digest=hashlib.sha256(raw).hexdigest()
            alias=root/'alias';alias.symlink_to(path.name)
            with self.assertRaises(OSError):b.checked_bytes(alias,digest)
            os.link(path,root/'hardlink')
            with self.assertRaises(b.Refusal):b.checked_bytes(path,digest)

    def test_access_time_changes_do_not_make_unchanged_source_refuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary).resolve()/'module.py';raw=b'MARKER=1\n';path.write_bytes(raw)
            os.utime(path,(1,2))
            self.assertEqual(b.checked_bytes(path,hashlib.sha256(raw).hexdigest()),raw)
            path.write_bytes(b'MARKER=2\n')
            with self.assertRaises(b.Refusal):b.checked_bytes(path,hashlib.sha256(raw).hexdigest())

    def test_observer_delegates_existing_effects_and_compares_original_namespace(self):
        events=[]
        class Effects:
            def launch(self,*args):events.append('launch');return 'handles'
            def receive_init(self,*args):events.append('validated-I');return 'init'
            def close_confirmed(self,*args):events.append('confirmed-close');return 'closed'
        factory,records,baseline=b.observed_effects(SimpleNamespace(LinuxEffects=Effects),lambda:'a'*64)
        observer=factory('parent-exit')
        self.assertEqual(observer.launch('args'),'handles')
        self.assertEqual(observer.receive_init('args'),'init')
        self.assertEqual(observer.close_confirmed('args'),'closed')
        self.assertEqual(events,['launch','validated-I','confirmed-close'])
        self.assertEqual([record['phase'] for record in records],['live','after'])
        self.assertEqual(baseline,'a'*64)
        values=iter(['a'*64,'b'*64])
        factory,_,_=b.observed_effects(SimpleNamespace(LinuxEffects=Effects),lambda:next(values))
        with self.assertRaises(b.Refusal):factory('same-owner').launch()

    def test_mount_snapshot_data_bounds_without_proc_read(self):
        closed=[];chunks=iter([b'fixture mount line\n',b''])
        with patch.object(b.os,'open',return_value=90),patch.object(b.os,'read',side_effect=lambda *_:next(chunks)),patch.object(b.os,'close',side_effect=closed.append):
            value=b.snapshot_mounts()
        self.assertEqual(value,hashlib.sha256(b'fixture mount line\n').hexdigest());self.assertEqual(closed,[90])
        with patch.object(b.os,'open',return_value=90),patch.object(b.os,'read',return_value=b'x'*(b.MOUNT_MAX+1)),patch.object(b.os,'close'):
            with self.assertRaises(b.Refusal):b.snapshot_mounts()

    def test_root_or_unisolated_prepare_refuses_before_import(self):
        with patch.object(b.os,'geteuid',return_value=0):
            loader=lambda *_:self.fail('import after unavailable guard')
            with self.assertRaises(b.Refusal):b.prepare_data('/repo','/zip',{},'/scratch',loader=loader)

    def test_nonroot_run_refuses_before_source_or_effect(self):
        with patch.object(b.os,'getuid',return_value=1001),patch.object(b.sys,'platform','linux'):
            loader=lambda *_:self.fail('native source import after unavailable guard')
            with self.assertRaises(b.Refusal):b.run_root('/repo','/run/private',{},'0'*64,wrapper_source='/overlay/wrapper.py',harness_source='/overlay/native',loader=loader)

    def test_prepare_converts_exact_metadata_and_preserves_archive_path(self):
        import acquisition
        metadata=vars(acquisition.PRODUCTION_PINS.metadata).copy()
        events=[]
        class Validated:
            def __enter__(self):return self
            def __exit__(self,*args):events.append('spool-closed')
        def acquire(path,parent,meta,**kwargs):
            self.assertEqual(path,'/private/raw.zip')
            self.assertIs(type(meta),acquisition.ArtifactMetadata)
            self.assertEqual(vars(meta),metadata)
            events.append('acquired')
            return SimpleNamespace(members=[SimpleNamespace(name='reader-packet.tar.gz',path='/private/data/tar'),
                SimpleNamespace(name='packet-inventory.json',path='/private/data/inventory')],to_dict=lambda:{'data':'record'})
        acq=SimpleNamespace(PRODUCTION_PINS=acquisition.PRODUCTION_PINS,ArtifactMetadata=acquisition.ArtifactMetadata,acquire_local_zip=acquire)
        intake=SimpleNamespace(validate_packet=lambda *_ ,**kw:Validated(),rehydrate_packet=lambda *_ ,**kw:events.append('rehydrated'))
        def loader(name,*args):return acq if name=='_reader_acquisition' else intake
        with patch.object(b.os,'geteuid',return_value=1001),patch.object(b,'checked_bytes',return_value=b'{}'):
            result=b.prepare_data('/repo','/private/raw.zip',metadata,'/private/scratch',loader=loader)
            self.assertEqual(result['packet'],'/private/scratch/packet')
            self.assertEqual(events,['acquired','rehydrated','spool-closed'])
            wrong=dict(metadata,artifact_id=True)
            with self.assertRaises(b.Refusal):b.prepare_data('/repo','/private/raw.zip',wrong,'/private/scratch',loader=loader)



class RootWiringTests(unittest.TestCase):
    def test_checked_successor_harness_source_is_separate_from_fixed_data_origin(self):
        import stat
        events=[]
        lease=SimpleNamespace(recheck=lambda:events.append('source-recheck'))
        def copy(source,destination,**kwargs):
            events.append((source,destination,kwargs));return lease
        wrapper=SimpleNamespace(check_acquisition_record=lambda *_:None,copy_external_sources=copy,
            load_external_modules=lambda _: {'native_cases':object()},
            run_cases=lambda *a,**kw:{'readerCaseSetPassed':False})
        with patch.object(b.sys,'platform','linux'),patch.object(b.os,'getuid',return_value=0),patch.object(b.os,'geteuid',return_value=0),patch.object(b,'checked_bytes',return_value=b'inert'),patch.object(b.os,'open',side_effect=[80,81]),patch.object(b.os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)),patch.object(b.os,'write',side_effect=lambda fd,raw:len(raw)),patch.object(b.os,'fsync'),patch.object(b.os,'fchmod'),patch.object(b.os,'close'),patch.object(b,'observed_effects',return_value=(object(),[],'a'*64)):
            result=b.run_root('/base','/run/inert',{'acquisition':{},'packet':'/packet','inventory':'/inventory'},'0'*64,
                wrapper_source='/successor/wrapper.py',harness_source='/successor/native',loader=lambda *_ ,**kw:wrapper)
        self.assertEqual(events[0],('/successor/native',Path('/run/inert/sources'),
            {'compile_pin_path':Path('/base/scripts/guest-reader-intake/compile-38502659264.pin.json')}))
        self.assertFalse(result['readerCaseSetPassed'])

    def run_root_returning(self,returned):
        import stat
        lease=SimpleNamespace(recheck=lambda:None)
        wrapper=SimpleNamespace(check_acquisition_record=lambda *_:None,copy_external_sources=lambda *a,**kw:lease,
            load_external_modules=lambda _: {'native_cases':object()},run_cases=lambda *a,**kw:returned)
        with patch.object(b.sys,'platform','linux'),patch.object(b.os,'getuid',return_value=0),patch.object(b.os,'geteuid',return_value=0),patch.object(b,'checked_bytes',return_value=b'inert'),patch.object(b.os,'open',side_effect=[80,81]),patch.object(b.os,'fstat',return_value=SimpleNamespace(st_uid=0,st_mode=stat.S_IFDIR|0o700)),patch.object(b.os,'write',side_effect=lambda fd,raw:len(raw)),patch.object(b.os,'fsync'),patch.object(b.os,'fchmod'),patch.object(b.os,'close'),patch.object(b,'observed_effects',return_value=(object(),[],'a'*64)):
            return b.run_root('/base','/run/inert',{'acquisition':{},'packet':'/packet','inventory':'/inventory'},'0'*64,
                wrapper_source='/successor/wrapper.py',harness_source='/successor/native',loader=lambda *_ ,**kw:wrapper)

    def test_the_success_result_carries_only_the_projected_probe_record(self):
        from test_probe_line import record_for
        good=record_for()
        result=self.run_root_returning({'readerCaseSetPassed':True,'dependencyProbe':good})
        self.assertEqual(result['dependencyProbe'],good)           # A genuine record passes through unchanged...
        self.assertIsNot(result['dependencyProbe'],good)           # ...as a copy, never the wrapper's own object.
        tampered=(dict(good,readerSuccessImplied=True),dict(good,bunCompatibilityProven=1),dict(good,rawStdout='/private/x'),
                  dict(good,line='valid',fields=dict(good['fields'],canaryOpen='unknown')),   # Halves that disagree with the fields.
                  dict(good,outsideCanary={'process':'not_visible','file':'leaked'}),
                  dict(good,viewContractSha256='nothex'),{k:v for k,v in good.items() if k!='fields'},
                  {'ran':True},'a string',None,[good],42)
        for item in tampered:
            with self.subTest(item=str(item)[:60]):
                result=self.run_root_returning({'readerCaseSetPassed':True,'dependencyProbe':item})
                self.assertEqual(result['dependencyProbe'],{'ran':False})
        result=self.run_root_returning({'readerCaseSetPassed':True})   # The key is always present in what is written.
        self.assertEqual(result['dependencyProbe'],{'ran':False})
        self.assertTrue(result['readerCaseSetPassed'])             # The projection never changes the case outcome.

    def test_before_lease_source_failure_reports_bootstrap_stage(self):
        with patch.object(b.sys,'platform','linux'),patch.object(b.os,'getuid',return_value=0),patch.object(b.os,'geteuid',return_value=0),patch.object(b,'checked_bytes',side_effect=b.Refusal('bootstrap source hash/identity')):
            with self.assertRaises(b.Refusal) as caught:
                b.run_root('/base','/run/inert',{},'0'*64,wrapper_source='/successor/wrapper.py',harness_source='/successor/native')
        self.assertEqual(b.failure_record(caught.exception)['stage'],'bootstrap:copy')


class DiagnosticTests(unittest.TestCase):
    def test_closed_literal_catalog_matches_reviewed_source_calls(self):
        import ast
        expected=set()
        folder=Path(b.__file__).parent
        for name in ('parent.py','producer.py','control.py','fixture.py','native_cases.py','wrapper.py','bootstrap.py'):
            for node in ast.walk(ast.parse((folder/name).read_text())):
                if not isinstance(node,ast.Call):continue
                index=None
                if isinstance(node.func,ast.Name):index=1 if node.func.id=='require' else 0 if node.func.id in ('Refusal','ValueError') else None
                elif isinstance(node.func,ast.Attribute) and node.func.attr=='__init__' and isinstance(node.func.value,ast.Call) and isinstance(node.func.value.func,ast.Name) and node.func.value.func.id=='super':index=0
                if index is not None and len(node.args)>index and isinstance(node.args[index],ast.Constant) and type(node.args[index].value) is str:
                    expected.add(node.args[index].value)
        inline={'output_parent','output_parent_replaced','data_record_path','protected_bootstrap_pin',
                'bootstrap_source','bootstrap_source_pin','bootstrap_final_pin','data_record',
                'bootstrap_copy','result_write','result_identity'}
        self.assertEqual(set(b.ERROR_REASONS),expected|inline)
        self.assertEqual(len(b.ERROR_REASONS),len(set(b.ERROR_REASONS)))

    def test_failure_stage_errno_and_cause_are_closed_and_not_cleanup_proof(self):
        import errno
        class Uncertain(ValueError):pass
        cause=OSError(errno.EBADF,'private /secret must not appear')
        error=Uncertain('reader_wrapper_uncertain');error.cause=cause
        error.lease=SimpleNamespace(stage='case:parent-exit:run')
        record=b.failure_record(error)
        self.assertEqual(record['stage'],'case:parent-exit:run')
        self.assertEqual(record['causeErrnoSymbol'],'EBADF')
        self.assertEqual(record['causeReason'],'unclassified')
        self.assertFalse(record['nativeCleanupConfirmed'])
        self.assertNotIn('/secret',str(record))
        error.lease.stage='private /secret';error.args=('private /secret',)
        record=b.failure_record(error,stage='private /secret')
        self.assertEqual(record['stage'],'unknown')
        self.assertNotIn('/secret',str(record))

    def test_nested_retained_lease_and_static_reason_without_str_calls(self):
        class Uncertain(ValueError):
            def __str__(self):raise AssertionError('no exception rendering')
        inner=Uncertain('reader_wrapper_uncertain')
        inner.lease=SimpleNamespace(stage='source:load:native_cases')
        inner.cause=b.Refusal('outer namespace changed while live')
        outer=Uncertain('reader_wrapper_uncertain');outer.cause=inner
        result=b.failure_record(outer)
        self.assertEqual(result['stage'],'source:load:native_cases')
        self.assertEqual(result['causeReason'],'outer namespace changed while live')
        self.assertEqual(result['reason'],'reader_wrapper_uncertain')

class PreinitProjectionTests(unittest.TestCase):
    def observation(self):
        return {'controlObserved':True,'controlBytes':0,'controlTag':'EOF','controlRights':0,
            'controlEof':True,'stderrBytes':0,'stderrEof':True,'nativeClassification':'empty',
            'nativeLabel':'unknown','nativeErrno':0,'bootstrapBytes':8,'bootstrapRecordObserved':True,
            'bootstrapStep':'exec','bootstrapErrno':2,'bootstrapEof':True,'bootstrapClassification':'record',
            'launcherExitCode':78,'producerExitCode':0,'diagnosticsComplete':True}

    def project(self,record):
        item=SimpleNamespace(handles=SimpleNamespace(preinit_diagnostics=record))
        return b.preinit_record([item])

    def test_fixed_record_projection_preserves_observation_but_never_grants_success(self):
        record=self.observation();result=self.project(record)
        self.assertTrue(result['available'])
        self.assertEqual(result['bootstrapErrnoSymbol'],'ENOENT')
        self.assertEqual(result['launcherExitCode'],78)
        self.assertNotIn('execConfirmed',result);self.assertNotIn('nativeCleanupConfirmed',result)
        record['nativeLabel']='reader namespaces';record['nativeClassification']='audited_perror';record['nativeErrno']=1
        self.assertEqual(self.project(record)['nativeErrnoSymbol'],'EPERM')

    def test_audited_label_with_unmapped_errno_and_exact_linux_alias(self):
        record=self.observation()
        record.update(nativeClassification='audited_label',nativeLabel='reader namespaces',nativeErrno=0)
        result=self.project(record)
        self.assertTrue(result['available'])
        self.assertEqual(result['nativeClassification'],'audited_label')
        self.assertEqual(result['nativeLabel'],'reader namespaces')
        self.assertEqual(result['nativeErrnoSymbol'],'unknown')
        record.update(nativeClassification='audited_perror',nativeErrno=95,bootstrapErrno=95)
        result=self.project(record)
        self.assertEqual(result['nativeErrnoSymbol'],'ENOTSUP')
        self.assertEqual(result['bootstrapErrnoSymbol'],'ENOTSUP')
        error=OSError(95,'unserialized private path')
        self.assertEqual(b.failure_record(error)['errnoSymbol'],'ENOTSUP')
        record['bootstrapErrno']=80
        self.assertTrue(self.project(record)['available'])

    def test_unknown_and_type_confused_observations_never_escape_projection(self):
        changes={'controlBytes':33,'controlRights':True,'controlEof':1,'stderrBytes':4098,
            'nativeClassification':'secret','nativeLabel':'/private/secret','nativeErrno':4095,
            'bootstrapBytes':10,'bootstrapStep':'/private/secret','bootstrapErrno':True,
            'bootstrapClassification':'secret','launcherExitCode':256,'producerExitCode':False}
        for key,value in changes.items():
            with self.subTest(key=key):
                record=self.observation();record[key]=value
                self.assertEqual(self.project(record),{'available':False})
        record=self.observation();record['rawStderr']='/private/secret'
        self.assertEqual(self.project(record),{'available':False})
        record=self.observation();del record['diagnosticsComplete']
        self.assertEqual(self.project(record),{'available':False})
        self.assertEqual(b.preinit_record([]),{'available':False})

    def test_native_label_projection_matches_hash_checked_case_source_inventory(self):
        import native_cases
        self.assertEqual(b.NATIVE_STDERR_LABELS,tuple(sorted(native_cases.STDERR_LABELS)))
        for value in ('.','mode=0755,size=16m','mode=1777,size=8m'):
            self.assertNotIn(value,b.NATIVE_STDERR_LABELS)
        for value in ('reader root','reader skeleton','reader private temporary files'):
            self.assertIn(value,b.NATIVE_STDERR_LABELS)

    # The compartment's require()/perror labels, extracted from agent-sdk commit 687b9557 and re-extracted at the final
    # overlay head 53082a74, where both files have the same sha256 and the same 70 labels result
    # (packages/runtime/src/guest/linux-instruction-reader-compartment.c, sha256 28aa279d6ecb560424fe24bf8ccc0893ffc61cfbb9ba6ba72d38c66b7b655893,
    # and linux-compartment.h, sha256 92fef7c0708a23b1e930c5b2560dae6bef27294dfd682346e69d35c0484b967d). The C file has 66
    # labels: 63 are the literal last argument of a require() call, and 3 reach perror through a helper that takes the label
    # (reader_expect and reader_entropy_identity); the header adds bind, bind flags, fixture path and seccomp = 70. Re-extract and
    # update this literal, native_cases.STDERR_LABELS and bootstrap.NATIVE_STDERR_LABELS together when the C or header changes.
    # The C also has unlabelled exits that print nothing (64 refusals and bare 77 liveness failures); those are classified by
    # exit status only. The dependency probe C prints no stderr label at all (its only output is one stdout line).
    COMPARTMENT_LABELS_53082A74 = (
        'bind',
        'bind flags',
        'fixture path',
        'reader Root peer',
        'reader admitted clone',
        'reader bounding capabilities',
        'reader close-on-exec',
        'reader created entropy identity',
        'reader descriptor inventory',
        'reader descriptor kind',
        'reader directory mountpoint',
        'reader empty readonly cwd',
        'reader entropy node',
        'reader explicit pipe',
        'reader explicit pipe-only envelope',
        'reader file mountpoint',
        'reader final entropy identity',
        'reader immutable exec',
        'reader immutable file',
        'reader independent primary gid',
        'reader independent uid',
        'reader inherited descriptor',
        'reader init process id',
        'reader monitor control',
        'reader monitor control copy',
        'reader monitor death',
        'reader monitor init',
        'reader monitor init copy',
        'reader monitor originals',
        'reader monotonic deadline',
        'reader mount attach',
        'reader mount inventory',
        'reader namespace init',
        'reader namespace kill',
        'reader namespace pidfd',
        'reader namespaces',
        'reader no new privileges',
        'reader parent pidfd',
        'reader pipe descriptor',
        'reader pipe flags',
        'reader private device directory',
        'reader private proc',
        'reader private propagation',
        'reader private temporary files',
        'reader proc cwd identity',
        'reader proc root identity',
        'reader proc root inventory',
        'reader readonly device directory',
        'reader readonly skeleton',
        'reader receipt type',
        'reader recursive mount flags',
        'reader resource ceiling',
        'reader root',
        'reader seccomp',
        'reader selected directory',
        'reader selected workspace group',
        'reader service death',
        'reader service pidfd',
        'reader setup monitor death',
        'reader shared identity',
        'reader skeleton',
        'reader skeleton ancestor',
        'reader source identity',
        'reader surviving pipe',
        'reader view ancestor',
        'reader view cwd',
        'reader view ownership',
        'reader view root',
        'reader zero capabilities',
        'seccomp',
    )
    # The 13 labels the earlier audit (agent-sdk f6d88d9a, the overlay of the compile packet 38502659264) did not have.
    COMPARTMENT_LABELS_ADDED_AFTER_F6D88D9A = (
        'reader created entropy identity',
        'reader descriptor inventory',
        'reader descriptor kind',
        'reader entropy node',
        'reader final entropy identity',
        'reader init process id',
        'reader mount inventory',
        'reader private device directory',
        'reader private proc',
        'reader proc cwd identity',
        'reader proc root identity',
        'reader proc root inventory',
        'reader readonly device directory',
    )

    def test_native_labels_equal_the_pinned_compartment_label_literal_in_both_modules(self):
        import native_cases
        literal=self.COMPARTMENT_LABELS_53082A74
        self.assertEqual(len(literal),70);self.assertEqual(len(set(literal)),70)
        self.assertEqual(list(literal),sorted(literal))
        self.assertEqual(set(native_cases.STDERR_LABELS),set(literal))
        self.assertEqual(len(native_cases.STDERR_LABELS),len(set(native_cases.STDERR_LABELS)))
        self.assertEqual(b.NATIVE_STDERR_LABELS,literal)
        new=set(self.COMPARTMENT_LABELS_ADDED_AFTER_F6D88D9A)
        self.assertEqual(len(new),13);self.assertLessEqual(new,set(literal))
        self.assertEqual(len(set(literal)-new),57)

    def test_every_new_compartment_label_classifies_as_an_audited_label_never_unrecognized(self):
        import native_cases
        for label in self.COMPARTMENT_LABELS_ADDED_AFTER_F6D88D9A:
            with self.subTest(label=label):
                mapped=label.encode()+b': '+os.strerror(errno.ENODEV).encode()+b'\n'
                self.assertEqual(native_cases.classify_stderr(mapped),
                                 {'byteCount':len(mapped),'classification':'audited_perror',
                                  'label':label,'errno':errno.ENODEV})
                # An errno text outside the closed table (EFBIG, which 'reader mount inventory' raises) keeps the
                # audited step and drops the unmapped errno.
                odd=native_cases.classify_stderr(label.encode()+b': '+os.strerror(errno.EFBIG).encode()+b'\n')
                self.assertEqual((odd['classification'],odd['label'],odd['errno']),('audited_label',label,0))

    def test_opaque_pipe_contract_matches_the_actual_producer_module(self):
        import producer
        self.assertEqual(b.BOOTSTRAP_STEP_NAMES,producer.BOOTSTRAP_STEPS)
        self.assertEqual(b.DIAGNOSTIC_ERRNOS,producer.BOOTSTRAP_ERRNOS)

if __name__ == '__main__':
    unittest.main()
