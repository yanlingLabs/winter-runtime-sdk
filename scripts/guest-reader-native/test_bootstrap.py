"""Source/Data and injected bootstrap checks. No native effects or real proc IO."""
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
            with self.assertRaises(b.Refusal):b.run_root('/repo','/run/private',{},'0'*64,wrapper_source='/overlay/wrapper.py',loader=loader)

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


if __name__=='__main__':unittest.main()
