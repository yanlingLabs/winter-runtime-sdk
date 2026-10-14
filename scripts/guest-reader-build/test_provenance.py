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
def standalone_pair(flags=15):
    body=bytes(64);payload=body+struct.pack('<QIIIIII',64,0,52,0,52,0,flags)+b'\n---- Bun! ----\n';strings=b'\0.bun\0.shstrtab\0'
    def image(compiled):
        data=bytearray(3072);data[:7]=b'\x7fELF\x02\x01\x01'
        struct.pack_into('<HHI',data,16,3,183,1);struct.pack_into('<QQ',data,32,64,2048);struct.pack_into('<HHHHHH',data,52,64,56,1,64,3,2)
        struct.pack_into('<IIQQQQQQ',data,64,1,6,0,0x400000,0,1536,1536,4096)
        section_at=1024 if compiled else 512;section_size=8+len(payload) if compiled else 8
        struct.pack_into('<IIQQQQIIQQ',data,2112,1,1,3,0x400000+section_at,section_at,section_size,0,0,8,0)
        struct.pack_into('<IIQQQQIIQQ',data,2176,6,3,0,0,1792,len(strings),0,0,1,0);data[1792:1792+len(strings)]=strings
        if compiled:struct.pack_into('<Q',data,512,0x400000+1024);struct.pack_into('<Q',data,1024,len(payload));data[1032:1032+len(payload)]=payload
        return bytes(data)
    return image(False),image(True)
def decode_standalone_pair(base,output):
    with tempfile.TemporaryFile() as bf,tempfile.TemporaryFile() as of:
        bf.write(base);bf.flush();of.write(output);of.flush();return p.standalone_flags(of.fileno(),bf.fileno())
class PacketTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-reader-data-test-',dir=Path('/var/tmp').resolve());self.root=Path(self.temp.name).resolve()
        self.runtime=self.root/'runtime';self.sdk=self.root/'sdk';self.overlay=self.root/'overlay';self.builder=self.root/'builder';self.deps=self.root/'deps'
        for directory in (self.runtime,self.sdk,self.overlay,self.builder,self.deps):directory.mkdir()
        put(self.runtime,'package.json',b'{"name":"runtime-fixture"}');put(self.runtime,p.READER_ENTRY,b'export const reader = true;\n')
        put(self.sdk,'package.json',b'{"name":"sdk-fixture"}');put(self.sdk,p.HEADER,b'/* same header */\n')
        for name,folder in p.SDK_PACKAGES.items():
            put(self.sdk,'packages/'+folder+'/package.json',json.dumps({'name':'@yanlinglabs/'+name,'version':'0.0.53','exports':{'.':{'bun':'./src/index.ts'}}}).encode())
            put(self.sdk,'packages/'+folder+'/src/index.ts',b'export const WINTER_BRAND = {};\n')
        put(self.overlay,p.HEADER,b'/* same header */\n');put(self.overlay,p.C_SOURCE,b'#include "linux-compartment.h"\n')
        for name in b.BUILDER_FILES:
            data=(Path(__file__).resolve().parents[2]/name).read_bytes() if name in b.PYTHON_SOURCE_OBSERVATIONS else b'inert builder source data\n'
            put(self.builder,name,data)
        put(self.deps,'typescript/lib/index.js',b'/* inert dependency */\n')
        self.heads={name:git_commit(path) for name,path in [('runtime',self.runtime),('sdk',self.sdk),('overlay',self.overlay),('builder',self.builder)]}
        self.output=self.root/'packet'
    def tearDown(self):self.temp.cleanup()
    def prepare(self):return b.prepare_packet(self.runtime,self.sdk,self.overlay,self.deps,self.output,self.heads,builder_root=self.builder)
    def test_actual_staging_and_candidate_aliases(self):
        manifest=self.prepare();b.check_inputs(self.output,manifest)
        self.assertEqual(len(manifest['origins']),4);self.assertEqual(len(manifest['resolverBindings']),12)
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
    def test_import_targets_normalize_actual_bun_relative_absolute_and_alias_shapes(self):
        put(self.sdk,'packages/provider-catalog/src/families.ts',b'export const families = [];')
        put(self.sdk,'packages/sdk/src/validate.ts',b'export const validate = true;')
        self.heads['sdk']=git_commit(self.sdk);manifest=self.prepare()
        names=['source/runtime/'+p.READER_ENTRY,'source/sdk/packages/sdk/src/index.ts','source/sdk/packages/sdk/src/validate.ts','source/sdk/packages/provider-catalog/src/index.ts','source/sdk/packages/provider-catalog/src/families.ts']
        data={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes'],'imports':[]} for name in names}}
        data['inputs'][str(self.output/names[1])]['imports']=[{'kind':'import-statement','original':'./validate.ts','path':str(self.output/names[2])}]
        data['inputs'][str(self.output/names[3])]['imports']=[{'kind':'import-statement','path':'./families.ts'}]
        data['inputs'][str(self.output/names[0])]['imports']=[{'kind':'import-statement','original':'@yanlinglabs/winter-agent-sdk','path':str(self.output/'source/runtime/node_modules/@yanlinglabs/winter-agent-sdk/src/index.ts')},{'kind':'import-statement','original':'node:fs','path':'fs','external':True}]
        normalized,_=b.normalized_metafile(data,self.output,manifest);graph=b.graph_evidence(normalized,self.output,manifest)
        self.assertEqual(normalized['inputs'][names[3]]['imports'][0]['path'],names[4]);self.assertEqual(graph['missingOriginalCount'],1)
        self.assertEqual(graph['bareReferences'][0]['specifier'],'@yanlinglabs/winter-agent-sdk')
        data['inputs'][str(self.output/names[0])]['imports'][0]['path']='../../node_modules/@yanlinglabs/winter-agent-sdk/src/index.ts'
        normalized,_=b.normalized_metafile(data,self.output,manifest);self.assertEqual(normalized['inputs'][names[0]]['imports'][0]['path'],names[1])
        for target in ('/tmp/unmeasured.ts','./missing.ts'):
            data['inputs'][str(self.output/names[1])]['imports'][0]['path']=target
            with self.assertRaises(p.Refusal):b.normalized_metafile(data,self.output,manifest)
    def test_literal_dynamic_missing_original_preserves_measured_graph(self):
        put(self.runtime,'src/instruction-reader.ts',b'export const read = true;');self.heads['runtime']=git_commit(self.runtime)
        manifest=self.prepare();entry='source/runtime/'+p.READER_ENTRY;target='source/runtime/src/instruction-reader.ts'
        data={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes'],'imports':[]} for name in (entry,target,'source/sdk/packages/sdk/src/index.ts')}}
        data['inputs'][str(self.output/entry)]['imports']=[{'kind':'dynamic-import','path':str(self.output/target)}]
        normalized,_=b.normalized_metafile(data,self.output,manifest);graph=b.graph_evidence(normalized,self.output,manifest)
        self.assertEqual(graph['missingOriginalCount'],1);self.assertFalse(graph['dynamicRuntimeImportsVerified'])
        self.assertEqual(graph['edges'][0]['target'],target)
        data['inputs'][str(self.output/entry)]['imports'][0]['path']='/tmp/unmeasured-dynamic.ts'
        with self.assertRaises(p.Refusal):b.normalized_metafile(data,self.output,manifest)
        data['inputs'][str(self.output/entry)]['imports'][0]={'kind':'dynamic-import','path':'unknown-package','external':True}
        normalized,_=b.normalized_metafile(data,self.output,manifest)
        with self.assertRaisesRegex(p.Refusal,'non-builtin external'):b.graph_evidence(normalized,self.output,manifest)
    def bare_fixture(self):
        types='src/run-home/types.ts';put(self.runtime,types,b'export const types = true;')
        catalog=self.sdk/'packages/provider-catalog/package.json';value=json.loads(catalog.read_bytes());value['exports']['./families']={'types':'./dist/families.d.ts','bun':'./src/families.ts','default':'./dist/families.js'};catalog.write_text(json.dumps(value))
        put(self.sdk,'packages/provider-catalog/src/families.ts',b'export const families = [];')
        self.heads['runtime']=git_commit(self.runtime);self.heads['sdk']=git_commit(self.sdk);manifest=self.prepare()
        names=['source/runtime/'+p.READER_ENTRY,'source/runtime/'+types,'source/sdk/packages/sdk/src/index.ts','source/sdk/packages/provider-catalog/src/families.ts']
        data={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes'],'imports':[]} for name in names}}
        for name in names[:2]:data['inputs'][str(self.output/name)]['imports']=[{'kind':'import-statement','path':'@yanlinglabs/winter-agent-sdk'}]
        data['inputs'][str(self.output/names[2])]['imports']=[{'kind':'import-statement','path':'@yanlinglabs/winter-provider-catalog/families'}]
        return manifest,names,data
    def test_exact_observed_bare_sdk_root_and_families_records(self):
        manifest,names,data=self.bare_fixture();normalized,_=b.normalized_metafile(data,self.output,manifest);graph=b.graph_evidence(normalized,self.output,manifest)
        self.assertEqual(graph['missingOriginalCount'],3);self.assertEqual(len(graph['capturedBareExports']),3)
        for name in names[:2]:
            item=normalized['inputs'][name]['imports'][0];self.assertEqual(item['path'],names[2]);self.assertNotIn('original',item)
            self.assertEqual(item['capturedBareExport']['rawPath'],'@yanlinglabs/winter-agent-sdk')
        item=normalized['inputs'][names[2]]['imports'][0]
        self.assertEqual(item['path'],names[3]);self.assertEqual(item['capturedBareExport']['exportKey'],'./families')
        self.assertEqual(item['capturedBareExport']['packageJsonSha256'],manifest['stagedInputs']['source/sdk/packages/provider-catalog/package.json']['sha256'])
        self.assertFalse(graph['dynamicRuntimeImportsVerified'])
    def test_bare_sdk_unknown_foreign_unbundled_and_evidence_collision_refuse(self):
        manifest,names,data=self.bare_fixture();item=data['inputs'][str(self.output/names[0])]['imports'][0]
        for target in ('@yanlinglabs/winter-agent-sdk/unknown','@yanlinglabs/winter-agent-sdk/','@yanlinglabs/winter-agent-sdk/../index','@yanlinglabs/winter-agent-sdk/wild*','@yanlinglabs/winter-other','unmeasured-third-party'):
            item['path']=target
            with self.assertRaises(p.Refusal):b.normalized_metafile(data,self.output,manifest)
        item['path']='@yanlinglabs/winter-agent-sdk';item['capturedBareExport']={}
        with self.assertRaisesRegex(p.Refusal,'evidence collision'):b.normalized_metafile(data,self.output,manifest)
        del item['capturedBareExport'];del data['inputs'][str(self.output/names[3])]
        with self.assertRaisesRegex(p.Refusal,'unbundled'):b.normalized_metafile(data,self.output,manifest)
    def test_raw_derived_export_evidence_collision_refuses_all_path_classes(self):
        manifest,names,data=self.bare_fixture();imports=data['inputs'][str(self.output/names[0])]['imports']
        for item in ({'path':str(self.output/names[2])},{'path':'../../node_modules/@yanlinglabs/winter-agent-sdk/src/index.ts'},{'path':'fs','external':True}):
            imports[0]={'kind':'import-statement','capturedBareExport':{'rawPath':'forged'},**item}
            with self.assertRaisesRegex(p.Refusal,'evidence collision'):b.normalized_metafile(data,self.output,manifest)
    def test_bare_sdk_manifest_conditions_and_byte_binding_refuse(self):
        manifest,names,data=self.bare_fixture();name='source/sdk/packages/sdk/package.json';path=self.output/name;original=path.read_bytes();value=json.loads(original);path.chmod(0o600)
        path.write_bytes(original+b' ')
        with self.assertRaisesRegex(p.Refusal,'manifest changed'):b.normalized_metafile(data,self.output,manifest)
        variants=[{**value,'version':'0.0.28'},{**value,'name':'@yanlinglabs/winter-other'}]
        for selected in ('./src/index.ts',{'default':'./dist/index.js'},{'bun':'./dist/index.js'},{'bun':'./src/../index.ts'},{'bun':'./src/missing.ts'},{'bun':'/tmp/outside.ts'},{'bun':'./src/index.ts','import':{'default':'./src/index.ts'}},{'bun':['./src/index.ts']}):
            variants.append({**value,'exports':{'.':selected}})
        variants.append({**value,'exports':{'.':value['exports']['.'],'./*':{'bun':'./src/index.ts'}}})
        for wrong in variants:
            raw=json.dumps(wrong).encode();path.write_bytes(raw);manifest['stagedInputs'][name]={'kind':'file','sha256':p.digest(raw),'bytes':len(raw)}
            with self.assertRaises(p.Refusal):b.normalized_metafile(data,self.output,manifest)
        raw=b'{"name":"@yanlinglabs/winter-agent-sdk","version":"0.0.53","exports":{".":{"bun":"./src/index.ts"},".":{"bun":"./src/index.ts"}}}'
        path.write_bytes(raw);manifest['stagedInputs'][name]={'kind':'file','sha256':p.digest(raw),'bytes':len(raw)}
        with self.assertRaisesRegex(p.Refusal,'duplicate JSON key'):b.normalized_metafile(data,self.output,manifest)
    def test_bare_sdk_alias_identity_and_target_collision_refuse(self):
        manifest,names,data=self.bare_fixture();alias='source/runtime/node_modules/@yanlinglabs/winter-agent-sdk';binding=manifest['resolverBindings'][alias]
        for change in ({'version':'0.0.28'},{'origin':'dependencies'},{'package':'@yanlinglabs/winter-other'}):
            original=dict(binding);binding.update(change)
            with self.assertRaisesRegex(p.Refusal,'alias identity'):b.normalized_metafile(data,self.output,manifest)
            binding.clear();binding.update(original)
        binding['target']='../../../sdk/packages/provider-catalog';manifest['stagedInputs'][alias]={'kind':'symlink','target':binding['target']}
        with self.assertRaisesRegex(p.Refusal,'alias collision'):b.normalized_metafile(data,self.output,manifest)
    def test_falsey_resolver_maps_are_not_defaulted(self):
        for value in (False,[],0,''):
            with self.assertRaisesRegex(p.Refusal,'plain third-party resolver map'):
                b.prepare_packet(self.runtime,self.sdk,self.overlay,self.deps,self.output,self.heads,builder_root=self.builder,resolver_map=value)
        path=self.root/'resolver-map.json'
        for value in (None,False,[],0,''):
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(p.Refusal,'plain third-party resolver map'):b.resolver_map_file(path)
        self.assertFalse(self.output.exists())
    def test_duplicate_physical_inputs_and_nonbundled_import_refuse(self):
        manifest=self.prepare();entry='source/runtime/'+p.READER_ENTRY;sdk='source/sdk/packages/sdk/src/index.ts'
        alias='source/runtime/node_modules/@yanlinglabs/winter-agent-sdk/src/index.ts'
        names=[entry,sdk,alias]
        data={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][sdk if name==alias else name]['bytes']} for name in names}}
        with self.assertRaisesRegex(p.Refusal,'duplicate canonical'):b.normalized_metafile(data,self.output,manifest)
        del data['inputs'][str(self.output/alias)]
        data['inputs'][str(self.output/sdk)]['imports']=[{'kind':'import-statement','path':str(self.output/'source/sdk'/p.HEADER)}]
        with self.assertRaisesRegex(p.Refusal,'non-bundled'):b.normalized_metafile(data,self.output,manifest)
    def test_embedded_private_paths_and_json_escapes_refuse_without_wire_outputs(self):
        manifest=self.prepare();entry='source/runtime/'+p.READER_ENTRY;sdk='source/sdk/packages/sdk/src/index.ts'
        for embedded in ('file://'+str(self.output)+'/source/secret','prefix '+str(self.output)+' suffix'):
            data={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes']} for name in (entry,sdk)},'diagnostic':embedded}
            with self.assertRaisesRegex(p.Refusal,'private packet path'):b.normalized_metafile(data,self.output,manifest)
            for name in ('receipt.json','metafile.json'):
                with self.assertRaisesRegex(p.Refusal,'private packet path'):b.write_wire(self.output/name,{'nested':[embedded]},self.output)
                self.assertFalse((self.output/name).exists())
            escaped=json.dumps({'diagnostic':embedded}).replace('/','\\u002f')
            with self.assertRaisesRegex(p.Refusal,'private packet path'):b.refuse_private_wire(json.loads(escaped),self.output)
    def test_actual_builder_injected_compiler_refusal_retains_measured_stage(self):
        tools={}
        for name in ('compiler','base','cc'):
            path=self.root/name;path.write_bytes(standalone_pair()[0]);tools[name]=path
        pin={**p.BASE,'executableSha256':p.digest(standalone_pair()[0])};calls=[]
        def refusal(*args):calls.append(args);raise p.Refusal('injected compiler refusal')
        with self.assertRaisesRegex(p.Refusal,'injected compiler refusal'):
            b.build(self.runtime,self.sdk,self.overlay,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=refusal,heads=self.heads,base_pin=pin,builder_root=self.builder)
        self.assertEqual(len(calls),1);self.assertTrue((self.output/'inputs.json').is_file());self.assertFalse((self.output/'receipt.json').exists())
        manifest=json.loads((self.output/'inputs.json').read_bytes());b.check_inputs(self.output,manifest)
    def synthetic_build(self,tamper_base=False):
        # The injected runner writes inert ELF data; no compiler/output is invoked.
        import shlex
        tools={}
        for name in ('compiler','base','cc'):
            path=self.root/name;path.write_bytes(standalone_pair()[0]);tools[name]=path
        pin={**p.BASE,'executableSha256':p.digest(standalone_pair()[0])};calls=[]
        def runner(argv,cwd,timeout,pass_fds):
            calls.append(argv)
            if argv[-1]=='--version':return (b'1.3.14\n' if len(calls)==1 else b'FixtureCC 1.0\n'),b''
            if 'build' in argv:
                for negative,positive in zip(p.AUTOLOAD_FLAGS,b.POSITIVE_AUTOLOAD):
                    if negative in argv and positive in argv:raise b.CommandFailure(1,b'',('error: Cannot use both '+positive+' and '+negative+'\n').encode())
                if '--allow-unresolved=*' in argv:raise b.CommandFailure(1,b'',b'error: --reject-unresolved and --allow-unresolved cannot be used together\n')
                opaque=any(str(arg).endswith('/opaque-import.ts') for arg in argv)
                if opaque and '--reject-unresolved' in argv:raise b.CommandFailure(1,b'',b.opaque_diagnostic(Path(next(str(arg) for arg in argv if str(arg).endswith('/opaque-import.ts')))))
                outfile=Path(argv[argv.index('--outfile')+1]);metafile=Path(next(arg.split('=',1)[1] for arg in argv if arg.startswith('--metafile=')))
                nibble=15 if all(flag in argv for flag in p.AUTOLOAD_FLAGS) else 0 if all(flag in argv for flag in b.POSITIVE_AUTOLOAD) else 12
                outfile.write_bytes(standalone_pair(nibble)[1])
                names=['source/runtime/'+p.READER_ENTRY,'source/sdk/packages/sdk/src/index.ts']
                data={'inputs':{str(self.output/name):{'bytes':(self.output/name).stat().st_size} for name in names},'outputs':{str(outfile):{}}}
                metafile.write_bytes(json.dumps(data).encode())
            else:
                put(self.output,'artifacts/instructionReaderLauncher',elf())
                source=str(self.output/'source/overlay'/p.C_SOURCE)
                put(self.output,'artifacts/native.d',('reader: '+shlex.quote(source)+'\n').encode())
                if tamper_base:
                    staged=self.output/'stage/linux-bun-base';staged.chmod(0o600);staged.write_bytes(b'tampered base')
            return b'',b''
        result=b.build(self.runtime,self.sdk,self.overlay,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=runner,heads=self.heads,base_pin=pin,builder_root=self.builder)
        return result,calls
    def test_actual_builder_synthetic_outputs_bind_closed_receipt(self):
        result,calls=self.synthetic_build()
        self.assertEqual(len(calls),13);self.assertEqual(set(result['artifacts']),{'instructionReader','instructionReaderLauncher'})
        self.assertNotIn(str(self.root),p.canonical(result));self.assertFalse(result['linuxExecutionVerified']);self.assertFalse(result['base']['archiveAcquisitionVerified'])
        b.check_inputs(self.output,json.loads((self.output/'inputs.json').read_bytes()))
    def test_staged_base_tamper_refuses_after_injected_compilation(self):
        with self.assertRaisesRegex(p.Refusal,'staged base changed'):self.synthetic_build(tamper_base=True)
        self.assertFalse((self.output/'receipt.json').exists())
    def test_dist_rejection_covers_every_sdk_family(self):
        for folder in p.SDK_PACKAGES.values():put(self.sdk,'packages/'+folder+'/dist/index.js',b'foreign SDK emit')
        self.heads['sdk']=git_commit(self.sdk);manifest=self.prepare()
        entries=['source/runtime/'+p.READER_ENTRY,'source/sdk/packages/sdk/src/index.ts']
        for folder in p.SDK_PACKAGES.values():
            names=entries+['source/sdk/packages/'+folder+'/dist/index.js']
            metadata={'inputs':{str(self.output/name):{'bytes':manifest['stagedInputs'][name]['bytes']} for name in names}}
            with self.assertRaisesRegex(p.Refusal,'SDK emit'):b.normalized_metafile(metadata,self.output,manifest)
    def test_manifest_tamper_and_inherited_old_peer_refuse(self):
        manifest=self.prepare();path=self.output/'inputs.json';path.chmod(0o600);path.write_text('{}')
        with self.assertRaisesRegex(p.Refusal,'manifest changed'):b.check_inputs(self.output,manifest)
    def test_explicit_third_party_aliases_are_measured_and_unused_refuses(self):
        put(self.deps,'fixture-pkg@1/node_modules/fixture-pkg/package.json',b'{"name":"fixture-pkg","version":"1"}')
        put(self.deps,'fixture-pkg@1/node_modules/fixture-pkg/index.js',b'export default 1;')
        manifest=b.prepare_packet(self.runtime,self.sdk,self.overlay,self.deps,self.output,self.heads,builder_root=self.builder,resolver_map={'fixture-pkg':'fixture-pkg@1/node_modules/fixture-pkg'})
        self.assertEqual(len(manifest['resolverBindings']),14)
        entry='source/runtime/'+p.READER_ENTRY;dependency='dependencies/fixture-pkg@1/node_modules/fixture-pkg/index.js'
        metadata={'inputs':{entry:{'imports':[]}}}
        with self.assertRaisesRegex(p.Refusal,'unused'):b.graph_evidence(metadata,self.output,manifest)
        metadata['inputs'][entry]['imports']=[{'kind':'import-statement','original':'fixture-pkg','path':dependency,'external':False}]
        metadata['inputs'][dependency]={'imports':[]}
        graph=b.graph_evidence(metadata,self.output,manifest)
        self.assertEqual(graph['bareReferences'][0]['specifier'],'fixture-pkg');b.check_inputs(self.output,manifest)
    def test_empty_dependencies_do_not_make_dangling_pnpm_alias(self):
        (self.deps/'typescript/lib/index.js').unlink();(self.deps/'typescript/lib').rmdir();(self.deps/'typescript').rmdir()
        manifest=self.prepare();b.check_inputs(self.output,manifest)
        self.assertEqual(manifest['dependencies'],{})
        for origin in ('runtime','sdk'):self.assertFalse((self.output/'source'/origin/'node_modules/.pnpm').is_symlink())
    def test_actual_metafile_import_records_reject_unknown_externals(self):
        manifest=self.prepare();entry='source/runtime/'+p.READER_ENTRY
        metadata={'inputs':{entry:{'imports':[{'kind':'import-statement','original':'node:fs','path':'fs','external':True}]}}}
        graph=b.graph_evidence(metadata,self.output,manifest);self.assertEqual(graph['bareReferences'][0]['specifier'],'node:fs')
        metadata['inputs'][entry]['imports'][0]={'kind':'import-statement','original':'unresolved-package','path':'unresolved-package','external':True}
        with self.assertRaisesRegex(p.Refusal,'external'):b.graph_evidence(metadata,self.output,manifest)
    def test_ancestor_config_refuses_without_output(self):
        for name in ('node_modules','package.json','tsconfig.x.json','jsconfig.json','bunfig.toml','.env'):
            path=self.root/name;path.touch()
            with self.assertRaisesRegex(p.Refusal,'ancestor resolver'):self.prepare()
            self.assertFalse(self.output.exists());path.unlink()
    def test_builder_self_source_requires_pinned_clean_bytes(self):
        put(self.builder,b.BUILDER_FILES[0],b'changed builder')
        with self.assertRaisesRegex(p.Refusal,'git'):self.prepare()
        self.assertFalse(self.output.exists())
    def test_semantic_negative_rejects_unrelated_errors_and_records_before_refusal(self):
        self.output.mkdir();(self.output/'stage').mkdir();scratch=self.root/'scratch';scratch.mkdir();recipe=b.compiler_recipe(self.output)
        expected='error: Cannot use both --compile-autoload-bunfig and --no-compile-autoload-bunfig'
        def runner(*args):raise b.CommandFailure(1,b'',(expected+'\nerror: unrelated failure\n').encode())
        record,stderr,_=b.run_measurement(runner,123,self.output,scratch,'wrong',recipe)
        with self.assertRaisesRegex(p.Refusal,'diagnostic'):b.exact_negative(record,stderr,expected)
        observed=json.loads((self.output/'diagnostics/wrong.json').read_bytes())
        self.assertEqual(observed['stderrSha256'],p.digest(stderr));self.assertEqual(observed['outputs'],{})
        self.assertFalse((self.output/'receipt.json').exists())
    def test_semantic_negative_rejects_zero_or_created_output(self):
        line='error: fixed conflict';record={'exitCode':0,'stdoutBytes':0,'outputs':{}}
        with self.assertRaises(p.Refusal):b.exact_negative(record,(line+'\n').encode(),line)
        record={'exitCode':1,'stdoutBytes':0,'outputs':{'instructionReader':{'sha256':'x','bytes':1}}}
        with self.assertRaises(p.Refusal):b.exact_negative(record,(line+'\n').encode(),line)
    def test_conflict_exact_bytes_and_nonstandard_exit_refuse(self):
        line='error: fixed conflict';record={'exitCode':1,'stdoutBytes':0,'outputs':{}}
        b.exact_negative(record,(line+'\n').encode(),line)
        for wrong in ((line+' \n').encode(),(' '+line+'\n').encode(),(line+'\n\n').encode(),(line+'\nerror: unrelated\n').encode()):
            with self.assertRaises(p.Refusal):b.exact_negative(record,wrong,line)
        for code in (-6,2,True):
            with self.assertRaises(p.Refusal):b.exact_negative({**record,'exitCode':code},(line+'\n').encode(),line)
    def test_parsed_control_hash_mismatch_refuses(self):
        directory=self.root/'control';directory.mkdir();base,output=standalone_pair();(directory/'instructionReader').write_bytes(output)
        fd=os.open(self.root/'base',os.O_WRONLY|os.O_CREAT,0o600);os.write(fd,base);os.close(fd);fd=os.open(self.root/'base',os.O_RDONLY)
        try:
            with self.assertRaisesRegex(p.Refusal,'hash mismatch'):b.parsed_output({'exitCode':0,'outputs':{'instructionReader':{'sha256':'0'*64}}},directory,fd,15)
        finally:os.close(fd)
    def test_parsed_control_base_read_refusal_closes_output(self):
        from unittest.mock import patch
        directory=self.root/'control';directory.mkdir();(directory/'instructionReader').write_bytes(standalone_pair()[1])
        real_input=b.file_input;real_read=p.read_fd;held=[]
        def tracked_input(*args):
            fd,meta=real_input(*args);held.append(fd);return fd,meta
        def refuse_base(fd,limit):
            if fd==123:raise p.Refusal('injected base read')
            return real_read(fd,limit)
        with patch.object(b,'file_input',side_effect=tracked_input),patch.object(p,'read_fd',side_effect=refuse_base):
            with self.assertRaisesRegex(p.Refusal,'base read'):b.parsed_output({'exitCode':0,'outputs':{'instructionReader':{'sha256':'0'*64}}},directory,123,15)
        self.assertEqual(len(held),1)
        with self.assertRaises(OSError):os.fstat(held[0])
    def test_opaque_fixed_envelope_and_nonstandard_exit_refuse(self):
        opaque=self.root/'opaque-import.ts';record={'exitCode':1,'stdoutBytes':0,'outputs':{}};stderr=b.opaque_diagnostic(opaque)
        b.exact_opaque_negative(record,stderr,opaque)
        for wrong in (stderr+b'error: unrelated\n',stderr.replace(b':1:14',b':1:7'),stderr.replace(b'                 ^',b'                ^')):
            with self.assertRaises(p.Refusal):b.exact_opaque_negative(record,wrong,opaque)
        for exit_code in (-6,2,True):
            with self.assertRaises(p.Refusal):b.exact_opaque_negative({**record,'exitCode':exit_code},stderr,opaque)
    def test_malformed_and_overbound_measurement_still_records_refusal(self):
        self.output.mkdir();(self.output/'stage').mkdir();scratch=self.root/'scratch';scratch.mkdir()
        from unittest.mock import patch
        def runner(*args):return b'too much',b''
        with patch.object(b,'MAX_OUTPUT',1):
            with self.assertRaisesRegex(p.Refusal,'observation refused'):b.run_measurement(runner,123,self.output,scratch,'overflow',b.compiler_recipe(self.output))
        record=json.loads((self.output/'diagnostics/overflow.json').read_bytes());self.assertTrue(record['captureRefused']);self.assertFalse(record['captureHashesComplete'])
        self.assertFalse((self.output/'receipt.json').exists())
    def test_runner_capture_error_is_not_complete_hash_evidence(self):
        self.output.mkdir();(self.output/'stage').mkdir();scratch=self.root/'scratch';scratch.mkdir()
        def runner(*args):raise RuntimeError('inert injected capture failure')
        with self.assertRaisesRegex(p.Refusal,'observation refused'):b.run_measurement(runner,123,self.output,scratch,'runner-error',b.compiler_recipe(self.output))
        record=json.loads((self.output/'diagnostics/runner-error.json').read_bytes())
        self.assertTrue(record['runnerError']);self.assertFalse(record['captureHashesComplete'])
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
    def test_inventory_stops_streaming_and_closes(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        class Scan:
            visits=0;closed=False
            def __iter__(self):return self
            def __next__(self):self.visits+=1;return SimpleNamespace(name='excluded')
            def close(self):self.closed=True
        scan=Scan();info=SimpleNamespace(st_dev=1,st_ino=2,st_size=0,st_mtime_ns=3,st_ctime_ns=4)
        with patch.object(p,'MAX_ENTRIES',2),patch.object(p.os,'fstat',return_value=info),patch.object(p.os,'scandir',return_value=scan):
            with self.assertRaisesRegex(p.Refusal,'directory visit count'):p.inventory(123,top_names={'wanted'})
        self.assertEqual(scan.visits,7);self.assertTrue(scan.closed)
    def test_capture_cleanup_owns_unreaped_group_and_always_closes(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        for module,function,args in ((p,p.git,('/inert','status')),(b,b.command,(['inert-compiler'],'/inert',30))):
            for mode in ('timeout','output','selector','setup','reap-timeout','reap-error','wait-timeout','nonzero'):
                with self.subTest(module=module.__name__,mode=mode):
                    events=[];clock_calls=0
                    class Stream:
                        def __init__(self,fd):self.fd=fd;self.closed=False
                        def fileno(self):return self.fd
                        def close(self):self.closed=True
                    class Proc:
                        pid=12345
                        def __init__(self):self.stdout=Stream(101);self.stderr=Stream(102);self.waits=0
                        def poll(self):raise AssertionError('poll may release PGID ownership')
                        def wait(self,timeout=None):
                            self.waits+=1;events.append(('wait',timeout))
                            if mode=='reap-timeout' or (mode=='wait-timeout' and self.waits==1):raise subprocess.TimeoutExpired('fixture',timeout)
                            if mode=='reap-error':raise OSError('inert reap error')
                            return 1 if mode=='nonzero' else 0
                    class Selector:
                        def __init__(self):self.keys={};self.closed=False
                        def register(self,stream,event):
                            if mode=='setup':raise OSError('inert setup error')
                            self.keys[stream.fd]=SimpleNamespace(fd=stream.fd,fileobj=stream)
                        def get_map(self):return self.keys
                        def select(self,timeout):
                            if mode=='selector':raise OSError('inert select error')
                            return [(key,module.selectors.EVENT_READ) for key in list(self.keys.values())]
                        def unregister(self,stream):del self.keys[stream.fd]
                        def close(self):self.closed=True
                    proc=Proc();selector=Selector()
                    def clock():
                        nonlocal clock_calls
                        clock_calls+=1
                        return 31 if clock_calls>1 and mode in ('timeout','reap-timeout','reap-error') else 0
                    def killpg(pid,sig):events.append(('kill',pid,sig))
                    bound='MAX_JSON' if module is p else 'MAX_OUTPUT'
                    expected=OSError if mode in ('selector','setup') else p.Refusal
                    with patch.object(module.subprocess,'Popen',return_value=proc),patch.object(module.selectors,'DefaultSelector',return_value=selector),patch.object(module.os,'set_blocking'),patch.object(module.os,'read',return_value=b'' if mode in ('nonzero','wait-timeout') else b'x'),patch.object(module.os,'killpg',side_effect=killpg),patch.object(module.time,'monotonic',side_effect=clock),patch.object(module,bound,0):
                        with self.assertRaises(expected) as failure:function(*args)
                    if mode.startswith('reap-'):self.assertIn('cleanup reap uncertain',str(failure.exception))
                    if mode=='nonzero':self.assertEqual(events,[('wait',30)])
                    elif mode=='wait-timeout':self.assertEqual(events,[('wait',30),('kill',proc.pid,module.signal.SIGKILL),('wait',1)])
                    else:self.assertEqual(events,[('kill',proc.pid,module.signal.SIGKILL),('wait',1)])
                    self.assertTrue(selector.closed);self.assertTrue(proc.stdout.closed);self.assertTrue(proc.stderr.closed)
    def test_symlink_escape_cycle_and_dangling(self):
        for graph in ({'a':{'kind':'symlink','target':'../outside'}},{'a':{'kind':'symlink','target':'b'},'b':{'kind':'symlink','target':'a'}},{'a':{'kind':'symlink','target':'missing'}}):
            with self.assertRaises(p.Refusal):p.validate_links(graph)
    def test_sysroot_relative_library_alias(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();(root/'usr/lib').mkdir(parents=True);(root/'usr/lib/file').write_bytes(b'inert library bytes')
            (root/'lib').symlink_to('usr/lib');(root/'usr/lib/alias').symlink_to('file');held=p.root_fd(root)
            try:
                fd,name=p.sysroot_leaf(held,'lib/alias')
                try:self.assertEqual(name,'usr/lib/file');self.assertEqual(p.read_fd(fd),b'inert library bytes')
                finally:os.close(fd)
            finally:os.close(held)
    def test_sysroot_forbidden_targets_cycles_and_hops(self):
        for mode in ('absolute','internal','escape','cycle','hops'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as temp:
                root=Path(temp).resolve();(root/'lib').mkdir();(root/'etc').mkdir();(root/'etc/file').write_bytes(b'inert')
                target={'absolute':'/usr/lib/file','internal':'../etc/file','escape':'../../outside','cycle':'b','hops':'link0'}[mode]
                (root/'lib/a').symlink_to(target)
                if mode=='cycle':(root/'lib/b').symlink_to('a')
                if mode=='hops':
                    for index in range(33):(root/f'lib/link{index}').symlink_to(f'link{index+1}')
                    (root/'lib/link33').write_bytes(b'inert')
                held=p.root_fd(root)
                try:
                    with self.assertRaises(p.Refusal):p.sysroot_leaf(held,'lib/a')
                finally:os.close(held)
    def test_sysroot_shape_identity_and_owned_descriptors(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp).resolve();(root/'lib').mkdir();(root/'lib/file').write_bytes(b'inert');(root/'lib/directory').mkdir();os.mkfifo(root/'lib/fifo');held=p.root_fd(root)
            try:
                for name in ('lib/directory','lib/fifo'):
                    with self.assertRaises(p.Refusal):p.sysroot_leaf(held,name)
                real_fstat=p.os.fstat;real_open=p.os.open;real_dup=p.os.dup;opened=[]
                def capture_open(*args,**kwargs):
                    fd=real_open(*args,**kwargs);opened.append(fd);return fd
                def capture_dup(*args,**kwargs):
                    fd=real_dup(*args,**kwargs);opened.append(fd);return fd
                def mismatch(fd):
                    value=real_fstat(fd)
                    if opened and fd==opened[-1] and p.stat.S_ISREG(value.st_mode):
                        altered=list(value);altered[1]+=1;return os.stat_result(altered)
                    return value
                with patch.object(p.os,'open',side_effect=capture_open),patch.object(p.os,'dup',side_effect=capture_dup),patch.object(p.os,'fstat',side_effect=mismatch):
                    with self.assertRaises(p.Refusal):p.sysroot_leaf(held,'lib/file')
                for fd in opened:
                    with self.assertRaises(OSError):real_fstat(fd)
                self.assertTrue(p.stat.S_ISDIR(real_fstat(held).st_mode))
            finally:os.close(held)
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
    def test_standalone_all_nibbles(self):
        for flags in range(16):
            result=decode_standalone_pair(*standalone_pair(flags));self.assertEqual(result['flagsNibble'],flags)
            self.assertEqual(result['outputSha256'],p.digest(standalone_pair(flags)[1]));self.assertEqual(result['baseSha256'],p.digest(standalone_pair(flags)[0]))
            self.assertEqual(result['payload']['compileExecArgvBytes'],0);self.assertEqual(result['payload']['bytes'],112)
    def test_standalone_scalar_corruption(self):
        mutations=[('reserved','<I',1124,16),('reserved-high','<I',1124,1<<31),('length','<Q',1024,110),('section-size','<Q',2144,121),('byte-count','<Q',1096,63),('modules-size','<I',1108,53),('entry','<I',1112,1),('argv-pointer','<I',1116,65),('argv-nonempty','<I',1120,1),('module-length','<I',1036,65),('original-pointer','<Q',512,0x400401),('original-va-map','<Q',80,0x401000),('unmapped-payload','<Q',96,1030),('section-count','<H',60,513),('strings-size','<Q',2208,1024*1024+1),('section-name','<I',2112,1024*1024),('no-load','<I',64,4),('machine','<H',18,62),('not-progbits','<I',2116,8)]
        mutations += [(f'module-pointer-{slot}','<I',1032+slot*8,65) for slot in range(6)]
        for name,fmt,at,value in mutations:
            with self.subTest(name=name):
                base,output=standalone_pair();output=bytearray(output);struct.pack_into(fmt,output,at,value)
                with self.assertRaises(p.Refusal):decode_standalone_pair(base,output)
    def test_standalone_overlap_trailer_original_slot_and_missing_argv_nul(self):
        for name in ('duplicate-output','duplicate-base','overlap','trailer','base-slot','class','endian','section-pointer','missing-nul','absent-section'):
            with self.subTest(name=name):
                base,output=map(bytearray,standalone_pair())
                if name.startswith('duplicate'):
                    data=base if name=='duplicate-base' else output;struct.pack_into('<H',data,60,4);data[2240:2304]=data[2112:2176]
                elif name=='overlap':struct.pack_into('<H',output,56,2);output[120:176]=output[64:120]
                elif name=='trailer':output[1143]=0
                elif name=='base-slot':struct.pack_into('<Q',base,512,1)
                elif name=='class':output[4]=1
                elif name=='endian':output[5]=2
                elif name=='missing-nul':output[1084]=1
                elif name=='absent-section':struct.pack_into('<I',output,2112,6)
                else:struct.pack_into('<Q',output,2128,0x400500);struct.pack_into('<Q',output,512,0x400500)
                with self.assertRaises(p.Refusal):decode_standalone_pair(base,output)
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
            bodies,closure=b.dependency_closure({'reader':path},sysroot,root/'env');self.assertEqual(len(closure),2);self.assertEqual(set(bodies['reader']['runtimeDependencyPaths']),set(closure))
            (sysroot/'lib/aarch64-linux-gnu/libc.so.6').unlink()
            with self.assertRaises(p.Refusal):b.dependency_closure({'reader':path},sysroot,root/'other-env')
if __name__=='__main__':unittest.main()
