"""Portable source/data tests. No compiler, compiled ELF, launcher or native role runs."""
import importlib.util,json,os,struct,subprocess,tempfile,unittest
from pathlib import Path
_spec=importlib.util.spec_from_file_location('reader_build',Path(__file__).with_name('build.py'))
b=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(b);p=b.p

def git_commit(root):
    env={**p.ENV,'HOME':str(root),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null'}
    for args in (['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-qm','fixture']):
        subprocess.run(['git','-C',str(root),*args],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    return subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],env=env).decode().strip()
def put(root,name,data):
    path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
def elf(needed=(),interpreter=None,rpath=False):
    strings=b'\0';positions=[]
    for name in needed:positions.append(len(strings));strings+=name.encode()+b'\0'
    dyn=[(5,0x400000+512),(10,len(strings)),*[(1,index) for index in positions]]
    if rpath:dyn.append((29,0))
    dyn.append((0,0));data=bytearray(1024);data[:6]=b'\x7fELF\x02\x01'
    struct.pack_into('<HH',data,16,3,183);struct.pack_into('<Q',data,32,64)
    count=3 if interpreter else 2;struct.pack_into('<HH',data,54,56,count)
    struct.pack_into('<IIQQQQQQ',data,64,1,4,0,0x400000,0,1024,1024,4096)
    struct.pack_into('<IIQQQQQQ',data,120,2,4,256,0x400100,0,len(dyn)*16,len(dyn)*16,8)
    for index,(tag,value) in enumerate(dyn):struct.pack_into('<qQ',data,256+index*16,tag,value)
    data[512:512+len(strings)]=strings
    if interpreter:
        raw=interpreter.encode()+b'\0';struct.pack_into('<IIQQQQQQ',data,176,3,4,600,0,0,len(raw),len(raw),1);data[600:600+len(raw)]=raw
    return bytes(data)
class PacketTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-reader-data-test-');self.root=Path(self.temp.name).resolve()
        self.runtime=self.root/'runtime';self.sdk=self.root/'sdk';self.overlay=self.root/'overlay';self.deps=self.root/'deps'
        for directory in (self.runtime,self.sdk,self.overlay,self.deps):directory.mkdir()
        put(self.runtime,'package.json',b'{"name":"runtime-fixture"}');put(self.runtime,p.READER_ENTRY,b'export const reader = true;\n')
        put(self.sdk,'package.json',b'{"name":"sdk-fixture"}');put(self.sdk,p.HEADER,b'/* same header */\n')
        for name,folder in p.SDK_PACKAGES.items():
            put(self.sdk,'packages/'+folder+'/package.json',json.dumps({'name':'@yanlinglabs/'+name,'version':'0.0.53','exports':{'.':{'bun':'./src/index.ts'}}}).encode())
            put(self.sdk,'packages/'+folder+'/src/index.ts',b'export const WINTER_BRAND = {};\n')
        put(self.overlay,p.HEADER,b'/* same header */\n');put(self.overlay,p.C_SOURCE,b'#include "linux-compartment.h"\n')
        put(self.deps,'typescript/lib/index.js',b'/* inert dependency */\n')
        self.heads={name:git_commit(path) for name,path in [('runtime',self.runtime),('sdk',self.sdk),('overlay',self.overlay)]}
        self.output=self.root/'packet'
    def tearDown(self):self.temp.cleanup()
    def prepare(self):return b.prepare_packet(self.runtime,self.sdk,self.overlay,self.deps,self.output,self.heads)
    def test_actual_staging_and_candidate_aliases(self):
        manifest=self.prepare();b.check_inputs(self.output,manifest)
        self.assertEqual(len(manifest['origins']),3);self.assertEqual(len(manifest['resolverBindings']),12)
        for alias in manifest['resolverBindings']:
            self.assertTrue((self.output/alias).resolve().is_relative_to(self.output/'source/sdk/packages'))
        leaf=self.output/'source/runtime'/p.READER_ENTRY
        self.assertEqual(leaf.stat().st_nlink,1);self.assertFalse(manifest['nativeOwnerVerified']);self.assertFalse(manifest['activationEnabled'])
    def test_dirty_source_and_wrong_git_head_refuse_before_output(self):
        put(self.runtime,p.READER_ENTRY,b'changed\n')
        with self.assertRaises(p.Refusal):self.prepare()
        self.assertFalse(self.output.exists())
        with self.assertRaises(p.Refusal):p.git_entries(self.sdk,self.heads['runtime'])
    def test_overlay_header_mismatch_refuses_without_overwrite(self):
        put(self.overlay,p.HEADER,b'foreign header\n');self.heads['overlay']=git_commit(self.overlay)
        with self.assertRaisesRegex(p.Refusal,'header differs'):self.prepare()
        self.assertEqual((self.sdk/p.HEADER).read_bytes(),b'/* same header */\n');self.assertFalse(self.output.exists())
    def test_published_peer_store_and_existing_output_refuse(self):
        put(self.deps,'@yanlinglabs+winter-agent-sdk@0.0.28/index.js',b'old')
        with self.assertRaises(p.Refusal):self.prepare()
        (self.deps/'@yanlinglabs+winter-agent-sdk@0.0.28/index.js').unlink()
        self.output.mkdir()
        with self.assertRaises(p.Refusal):self.prepare()
    def test_tampered_source_and_resolver_refuse(self):
        manifest=self.prepare();path=self.output/'source/runtime'/p.READER_ENTRY;path.chmod(0o600);path.write_bytes(b'tampered')
        with self.assertRaises(p.Refusal):b.check_inputs(self.output,manifest)
    def test_alias_changed_to_old_global_target_refuses(self):
        manifest=self.prepare();alias=next(iter(manifest['resolverBindings']));path=self.output/alias;path.unlink();path.symlink_to('/tmp/foreign-sdk')
        with self.assertRaises(p.Refusal):b.check_inputs(self.output,manifest)
    def test_output_artifacts_not_misread_as_source(self):
        manifest=self.prepare();(self.output/'artifacts').mkdir();put(self.output,'artifacts/large',b'x')
        (self.output/'artifacts/large').unlink();os.mkfifo(self.output/'artifacts/untrusted-output')
        b.check_inputs(self.output,manifest)
    def test_metafile_exact_origin_resolution_and_negatives(self):
        manifest=self.prepare()
        entries=['source/runtime/'+p.READER_ENTRY,'source/sdk/packages/sdk/src/index.ts']
        metadata={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes']} for name in entries},'outputs':{'reader':{}}}
        normalized,bundled=b.normalized_metafile(metadata,self.output,manifest)
        self.assertEqual(set(bundled),set(entries));self.assertNotIn(str(self.root),p.canonical(normalized))
        for wrong in ['/tmp/global-peer.js','../outside/index.ts']:
            bad={'inputs':{wrong:{'bytes':1}}}
            with self.assertRaises(p.Refusal):b.normalized_metafile(bad,self.output,manifest)
        bad={'inputs':{entries[0]:{'bytes':1}}}
        with self.assertRaises(p.Refusal):b.normalized_metafile(bad,self.output,manifest)
    def test_actual_builder_injected_compiler_refusal_retains_measured_stage(self):
        tools={}
        for name in ('compiler','base','cc'):
            path=self.root/name;path.write_bytes(b'inert tool bytes');tools[name]=path
        pin={**p.BASE,'executableSha256':p.digest(b'inert tool bytes')};calls=[]
        def refusal(*args):calls.append(args);raise p.Refusal('injected compiler refusal')
        with self.assertRaisesRegex(p.Refusal,'injected compiler refusal'):
            b.build(self.runtime,self.sdk,self.overlay,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=refusal,heads=self.heads,base_pin=pin)
        self.assertEqual(len(calls),1);self.assertTrue((self.output/'inputs.json').is_file());self.assertFalse((self.output/'receipt.json').exists())
        manifest=json.loads((self.output/'inputs.json').read_bytes());b.check_inputs(self.output,manifest)
    def test_actual_builder_synthetic_outputs_bind_closed_receipt(self):
        # The injected runner writes inert ELF data; no compiler/output is invoked.
        import shlex
        tools={}
        for name in ('compiler','base','cc'):
            path=self.root/name;path.write_bytes(b'inert tool bytes');tools[name]=path
        pin={**p.BASE,'executableSha256':p.digest(b'inert tool bytes')};calls=[]
        def runner(argv,cwd,timeout,pass_fds):
            calls.append(argv)
            if argv[-1]=='--version':return (b'1.3.14\n' if len(calls)==1 else b'FixtureCC 1.0\n'),b''
            if 'build' in argv:
                put(self.output,'artifacts/instructionReader',elf())
                names=['source/runtime/'+p.READER_ENTRY,'source/sdk/packages/sdk/src/index.ts']
                data={'inputs':{str(self.output/name):{'bytes':(self.output/name).stat().st_size} for name in names},'outputs':{str(self.output/'artifacts/instructionReader'):{}}}
                put(self.output,'artifacts/instructionReader.metafile.json',json.dumps(data).encode())
            else:
                put(self.output,'artifacts/instructionReaderLauncher',elf())
                source=str(self.output/'source/overlay'/p.C_SOURCE)
                put(self.output,'artifacts/native.d',('reader: '+shlex.quote(source)+'\n').encode())
            return b'',b''
        result=b.build(self.runtime,self.sdk,self.overlay,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=runner,heads=self.heads,base_pin=pin)
        self.assertEqual(len(calls),4);self.assertEqual(set(result['artifacts']),{'instructionReader','instructionReaderLauncher'})
        self.assertNotIn(str(self.root),p.canonical(result));self.assertFalse(result['linuxExecutionVerified']);self.assertFalse(result['base']['archiveAcquisitionVerified'])
        b.check_inputs(self.output,json.loads((self.output/'inputs.json').read_bytes()))
    def test_manifest_tamper_and_inherited_old_peer_refuse(self):
        manifest=self.prepare();path=self.output/'inputs.json';path.chmod(0o600);path.write_text('{}')
        with self.assertRaisesRegex(p.Refusal,'manifest changed'):b.check_inputs(self.output,manifest)
    def test_candidate_export_must_resolve_source(self):
        manifest=self.sdk/'packages/sdk/package.json'
        value=json.loads(manifest.read_bytes());value['exports']['.']['bun']='./dist/index.js';manifest.write_text(json.dumps(value))
        self.heads['sdk']=git_commit(self.sdk)
        with self.assertRaisesRegex(p.Refusal,'source export'):self.prepare()
    def test_ambiguous_json_and_bounded_metadata_refuse(self):
        with self.assertRaisesRegex(p.Refusal,'duplicate JSON'):b.json_data(b'{"inputs":{},"inputs":{}}')
        path=self.root/'metadata';path.write_bytes(b'overbound')
        with self.assertRaises(p.Refusal):b.read_file(path,1)
        path.unlink();path.symlink_to('/dev/null')
        with self.assertRaises(p.Refusal):b.read_file(path,100)
    def test_four_autoload_flags_are_literal_and_no_output_execution(self):
        recipe=b.compiler_recipe(self.output)
        self.assertEqual([flag for flag in recipe if flag.startswith('--no-compile-autoload-')],list(p.AUTOLOAD_FLAGS))
        self.assertIn('--reject-unresolved',recipe);self.assertIn('--no-env-file',recipe);self.assertNotIn(str(self.output/'artifacts/instructionReaderLauncher'),recipe)
class PrimitiveTests(unittest.TestCase):
    def test_held_fd_mutation_and_file_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'file';path.write_bytes(b'bytes');fd=os.open(path,os.O_RDONLY)
            try:
                with self.assertRaises(p.Refusal):p.read_fd(fd,1)
                self.assertEqual(p.read_fd(fd),b'bytes')
            finally:os.close(fd)
    def test_mutation_during_held_read_and_source_aggregate_refuse(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();path=root/'file';path.write_bytes(b'abc');fd=os.open(path,os.O_RDONLY);read=os.read;changed=False
            def changing_read(fileno,size):
                nonlocal changed
                data=read(fileno,size)
                if not changed:path.write_bytes(b'changed');changed=True
                return data
            try:
                with patch.object(p.os,'read',changing_read):
                    with self.assertRaises(p.Refusal):p.read_fd(fd)
            finally:os.close(fd)
            rootfd=p.root_fd(root)
            try:
                with patch.object(p,'MAX_SOURCE',1):
                    with self.assertRaises(p.Refusal):p.inventory(rootfd)
            finally:os.close(rootfd)
    def test_symlink_escape_cycle_and_dangling(self):
        for graph in ({'a':{'kind':'symlink','target':'../outside'}},{'a':{'kind':'symlink','target':'b'},'b':{'kind':'symlink','target':'a'}},{'a':{'kind':'symlink','target':'missing'}}):
            with self.assertRaises(p.Refusal):p.validate_links(graph)
    def test_relative_link_and_hardlink_copies_are_independent(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);source=root/'source';source.mkdir();put(source,'one',b'one');os.link(source/'one',source/'two');(source/'alias').symlink_to('one')
            fd=p.root_fd(source.resolve())
            try:manifest=p.inventory(fd);p.copy_inventory(fd,manifest,root/'copy')
            finally:os.close(fd)
            self.assertNotEqual((root/'copy/one').stat().st_ino,(root/'copy/two').stat().st_ino);self.assertEqual((root/'copy/one').stat().st_nlink,1)
    def test_fifo_directory_ancestor_and_budget_refuse(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);os.mkfifo(root/'fifo');fd=p.root_fd(root.resolve())
            try:
                with self.assertRaises(p.Refusal):p.measure(fd,'fifo')
                with self.assertRaises(p.Refusal):p.inventory(fd)
            finally:os.close(fd)
        with self.assertRaises(p.Refusal):p.validate_links({'a':{'kind':'file','bytes':1,'sha256':'x'},'a/b':{'kind':'file','bytes':1,'sha256':'x'}})
    def test_bounded_ELF_dependency_data_no_execution(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);path=root/'reader';path.write_bytes(elf(['libc.so.6'],'/lib/ld-linux-aarch64.so.1'));fd=os.open(path,os.O_RDONLY)
            try:
                parsed=p.elf_metadata(fd);self.assertEqual(parsed['needed'],['libc.so.6']);self.assertEqual(parsed['interpreter'],'/lib/ld-linux-aarch64.so.1')
            finally:os.close(fd)
            for data in (b'notELF',elf(['../escape']),elf(['libc.so.6'],rpath=True)):
                path.write_bytes(data);fd=os.open(path,os.O_RDONLY)
                try:
                    with self.assertRaises((p.Refusal,UnicodeError)):p.elf_metadata(fd)
                finally:os.close(fd)
    def test_recursive_ELF_closure_and_missing_dependency(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();sysroot=root/'sysroot';sysroot.mkdir();put(sysroot,'lib/ld-linux-aarch64.so.1',elf());put(sysroot,'lib/aarch64-linux-gnu/libc.so.6',elf())
            path=root/'reader';path.write_bytes(elf(['libc.so.6'],'/lib/ld-linux-aarch64.so.1'))
            bodies,closure=b.dependency_closure({'reader':path},sysroot,root/'env');self.assertEqual(len(closure),2)
            (sysroot/'lib/aarch64-linux-gnu/libc.so.6').unlink()
            with self.assertRaises(p.Refusal):b.dependency_closure({'reader':path},sysroot,root/'other-env')
if __name__=='__main__':unittest.main()
