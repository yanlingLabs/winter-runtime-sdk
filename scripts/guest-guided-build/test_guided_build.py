"""Portable source/data tests. No compiler, compiled ELF, launcher or native role runs: the injected runner writes
inert bytes and records every argv so the tests can prove nothing it was asked to start is an output."""
import hashlib,importlib.util,io,json,os,re,tarfile,tempfile,unittest,zipfile
from pathlib import Path
HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
b=load('guided_build',HERE/'build.py');g=b.g;pins=b.pins;p=b.p;r=b.r
acquire=load('guided_acquire',HERE/'acquire.py')
rt=load('reader_test_helpers',HERE.parent/'guest-reader-build'/'test_provenance.py')  # inert ELF/Bun-layout/git fixtures only
elf,standalone_pair,git_commit,put=rt.elf,rt.standalone_pair,rt.git_commit,rt.put
REPO=HERE.parents[1]
WORKFLOW=REPO/'.github/workflows/cowork-guided-packet-compile-fixture.yml'
GUEST='packages/runtime/src/guest/'

class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-guided-data-test-',dir=Path('/var/tmp').resolve());self.root=Path(self.temp.name).resolve()
        self.runtime,self.sdk,self.winter,self.builder,self.deps=(self.root/n for n in ('runtime','sdk','winter','builder','deps'))
        for directory in (self.runtime,self.sdk,self.winter,self.builder,self.deps):directory.mkdir()
        put(self.runtime,'package.json',b'{"name":"runtime-fixture"}')
        for name in ('src/guest/instruction-reader-entry.ts','src/guest/instruction-reader-transport.ts','scripts/guest-guided-provider/stub.ts'):put(self.runtime,name,b'export const fixture = true;\n')
        put(self.sdk,'package.json',b'{"name":"sdk-fixture"}')
        for name,folder in p.SDK_PACKAGES.items():
            put(self.sdk,'packages/'+folder+'/package.json',json.dumps({'name':'@yanlinglabs/'+name,'version':'0.0.53','exports':{'.':{'types':'./dist/index.d.ts','bun':'./src/index.ts','default':'./dist/index.js'}}}).encode())
            put(self.sdk,'packages/'+folder+'/src/index.ts',b'export const WINTER_BRAND = {};\n')
        for name in ('linux-guided-host-query-main.ts','linux-session-entry.ts','linux-session-admission.ts','linux-compartment.h'):put(self.sdk,GUEST+name,b'/* guest fixture */\n')
        for spec in pins.NATIVE.values():put(self.sdk,GUEST+spec['source'],b'#include "linux-compartment.h"\n')
        put(self.winter,'package.json',b'{"name":"winter-fixture"}');put(self.winter,'packages/core/package.json',b'{"name":"@yanlinglabs/winter-core"}')
        put(self.winter,'packages/protocol/package.json',json.dumps({'name':'@yanlinglabs/winter-protocol','version':'0.124.0','exports':{'.':'./src/index.ts'}}).encode())
        put(self.winter,'packages/protocol/src/index.ts',b'import { z } from "zod";\nexport const protocol = z;\n')
        for name in ('current-context','current-context-resolver','structured-instruction-mapper','authority','guest-paths','types'):put(self.winter,'packages/core/src/cowork/'+name+'.ts',b'export const fixture = 1;\n')
        put(self.winter,'packages/core/src/cowork/current-context.test.ts',b'test only\n');put(self.winter,'packages/core/test/cowork/x.ts',b'test only\n')
        put(self.winter,'packages/core/src/daemon.ts',b'outside the closed slice\n')
        put(self.winter,'packages/core/src/runtime-state/records.ts',b'export const records = 1;\n');put(self.winter,'packages/core/src/runtime-sdk/model-tag.ts',b'export const tag = 1;\n')
        for name in pins.BUILDER_FILES:
            real=REPO/name
            put(self.builder,name,real.read_bytes() if name in {**b.PYTHON_SOURCE_OBSERVATIONS,**b.READER_OBSERVATIONS} else b'inert builder source data\n')
        store='.pnpm/zod@4.4.3/node_modules/zod/'
        put(self.deps,store+'package.json',json.dumps({'name':'zod','version':'4.4.3','exports':{'.':{'@zod/source':'./src/index.ts','types':'./index.d.cts','import':'./index.js','require':'./index.cjs'}}}).encode())
        put(self.deps,store+'index.js',b'export const z = {};\n')
        # A second package with a dependency link, no exports map and a main field: the shape of cross-spawn -> which.
        put(self.deps,'.pnpm/left@1.0.0/node_modules/left/package.json',b'{"name":"left","version":"1.0.0","main":"lib.js"}');put(self.deps,'.pnpm/left@1.0.0/node_modules/left/lib.js',b'x\n')
        put(self.deps,'.pnpm/right@2.0.0/node_modules/right/package.json',b'{"name":"right","version":"2.0.0","module":"./esm.js","main":"./esm.js"}');put(self.deps,'.pnpm/right@2.0.0/node_modules/right/esm.js',b'x\n')
        (self.deps/'.pnpm/left@1.0.0/node_modules/right').symlink_to('../../right@2.0.0/node_modules/right')
        self.heads={name:git_commit(path) for name,path in [('runtime',self.runtime),('sdk',self.sdk),('winter',self.winter),('builder',self.builder)]}
        self.output=self.root/'packet';self.aliases={'winter':{'zod':'zod@4.4.3'}}
    def tearDown(self):self.temp.cleanup()
    def prepare(self,**kw):return b.prepare_packet(self.runtime,self.sdk,self.winter,self.deps,self.output,self.heads,{},self.builder,aliases=kw.pop('aliases',self.aliases),**kw)

class StagingTests(Fixture):
    def test_four_origins_aliases_and_the_closed_winter_slice(self):
        manifest=self.prepare();r.check_inputs(self.output,manifest)
        self.assertEqual([o['role'] for o in manifest['origins']],['runtime','sdk','winter','builder'])
        self.assertEqual(len(manifest['resolverBindings']),6*4+1+1)
        self.assertEqual({v['origin'] for v in manifest['resolverBindings'].values()},{'sdk','winter','dependencies'})
        winter=manifest['origins'][2]['eligibleFiles']
        self.assertIn('packages/core/src/cowork/current-context.ts',winter)
        for excluded in ('packages/core/src/daemon.ts','packages/core/test/cowork/x.ts','packages/core/src/cowork/current-context.test.ts'):self.assertNotIn(excluded,winter)
        self.assertFalse(manifest['nativeOwnerVerified']);self.assertFalse(manifest['activationEnabled'])
    def test_workspace_alias_exists_only_under_winter(self):
        manifest=self.prepare()
        protocol=[k for k in manifest['resolverBindings'] if k.endswith('winter-protocol')]
        self.assertEqual(protocol,['source/winter/node_modules/@yanlinglabs/winter-protocol'])
    def test_dirty_source_wrong_head_and_existing_output_refuse_before_output(self):
        put(self.winter,'packages/core/src/cowork/current-context.ts',b'changed\n')
        with self.assertRaises(p.Refusal):self.prepare()
        self.assertFalse(self.output.exists())
    def test_wrong_tree_pin_refuses(self):
        with self.assertRaisesRegex(p.Refusal,'tree differs'):
            b.prepare_packet(self.runtime,self.sdk,self.winter,self.deps,self.output,self.heads,{'sdk':'0'*40},self.builder,aliases=self.aliases)
        self.assertFalse(self.output.exists())
    def test_published_peer_store_refuses(self):
        put(self.deps,'@yanlinglabs/winter-agent-sdk/package.json',b'{}')
        with self.assertRaisesRegex(p.Refusal,'published SDK peers'):self.prepare()
    def test_missing_role_or_native_source_refuses_before_output(self):
        (self.sdk/(GUEST+'process-worker.c')).unlink();self.heads['sdk']=git_commit(self.sdk)
        with self.assertRaisesRegex(p.Refusal,'native source missing'):self.prepare()
        self.assertFalse(self.output.exists())
    def test_a_missing_role_entry_or_required_source_refuses_before_output(self):
        for origin,repo,name in (('runtime',self.runtime,'scripts/guest-guided-provider/stub.ts'),('winter',self.winter,'packages/core/src/cowork/current-context-resolver.ts'),('sdk',self.sdk,GUEST+'linux-guided-host-query-main.ts')):
            (repo/name).unlink();self.heads[origin]=git_commit(repo)
            with self.assertRaisesRegex(p.Refusal,'role source missing'):self.prepare()
            self.assertFalse(self.output.exists())
            put(repo,name,b'export const restored = 1;\n');self.heads[origin]=git_commit(repo)
    def test_builder_self_source_requires_clean_bytes(self):
        put(self.builder,'scripts/guest-guided-build/build.py',b'tampered\n');self.heads['builder']=git_commit(self.builder)
        with self.assertRaisesRegex(p.Refusal,'builder differs'):self.prepare()
    def test_reader_helper_bytes_are_captured_with_the_builder(self):
        manifest=self.prepare();files=manifest['origins'][3]['eligibleFiles']
        for name in pins.READER_HELPERS:self.assertEqual(files[name]['sha256'],r.PYTHON_SOURCE_OBSERVATIONS[name]['sha256'])
    def test_falsey_alias_map_is_not_defaulted(self):
        with self.assertRaisesRegex(p.Refusal,'alias map'):self.prepare(aliases=[])
        self.assertFalse(self.output.exists())

class BuildTests(Fixture):
    INTERP='/lib/ld-linux-aarch64.so.1'
    def sysroot(self):
        put(self.root,'lib/ld-linux-aarch64.so.1',elf());put(self.root,'lib/aarch64-linux-gnu/libc.so.6',elf());put(self.root,'usr/include/fixture-system.h',b'/* system header fixture */\n')
    def tools(self):
        tools={}
        for name in ('compiler','base','cc'):
            path=self.root/name;path.write_bytes(standalone_pair()[0]);tools[name]=path
        return tools,{**pins.BASE,'executableSha256':p.digest(standalone_pair()[0])}
    def synthetic(self,drop_input=None,role_nibble=None,tamper_after_compile=False):
        import shlex
        self.sysroot();tools,pin=self.tools();calls=[]
        header=self.root/'usr/include/fixture-system.h'
        def runner(argv,cwd,timeout,pass_fds):
            calls.append(list(argv))
            if argv[-1]=='--version':return (pin['version'].encode()+b'\n' if len(calls)==1 else b'FixtureCC 1.0\n'),b''
            if 'build' in argv:
                for negative,positive in zip(p.AUTOLOAD_FLAGS,r.POSITIVE_AUTOLOAD):
                    if negative in argv and positive in argv:raise b.CommandFailure(1,b'',('error: Cannot use both '+positive+' and '+negative+'\n').encode())
                if '--allow-unresolved=*' in argv:raise b.CommandFailure(1,b'',b'error: --reject-unresolved and --allow-unresolved cannot be used together\n')
                opaque=[str(a) for a in argv if str(a).endswith('/opaque-import.ts')]
                if opaque and '--reject-unresolved' in argv:raise b.CommandFailure(1,b'',r.opaque_diagnostic(Path(opaque[0])))
                outfile=Path(argv[argv.index('--outfile')+1]);metafile=Path(next(a.split('=',1)[1] for a in argv if a.startswith('--metafile=')))
                nibble=15 if all(f in argv for f in p.AUTOLOAD_FLAGS) else 0 if all(f in argv for f in r.POSITIVE_AUTOLOAD) else 12
                if role_nibble is not None and nibble==15 and 'reader-compiler-measurements' not in str(outfile):nibble=role_nibble
                outfile.write_bytes(standalone_pair(nibble)[1])
                role=outfile.name if outfile.name in pins.ROLES else 'instructionReader';spec=pins.ROLES[role]
                names=[spec['entry'],*spec['required'],'source/sdk/packages/sdk/src/index.ts']
                if role=='hostClient':names.append('dependencies/.pnpm/zod@4.4.3/node_modules/zod/index.js')
                if drop_input and role==drop_input[0]:names=[n for n in names if n!=drop_input[1]]
                metafile.write_bytes(json.dumps({'inputs':{str(self.output/n):{'bytes':(self.output/n).stat().st_size} for n in names},'outputs':{str(outfile):{}}}).encode())
            else:
                output=Path(argv[argv.index('-o')+1]);source=Path(argv[argv.index('-o')-1])
                if tamper_after_compile and output.name=='fileWorker':
                    victim=self.output/'artifacts/hostClient';victim.chmod(0o600);victim.write_bytes(standalone_pair(15)[1]+b'\0')
                output.write_bytes(elf(('libc.so.6',),self.INTERP) if output.name=='instructionReaderLauncher' else elf())
                put(self.output,'artifacts/native.d',('x: '+shlex.quote(str(source))+' '+shlex.quote(str(header))+'\n').encode())
            return b'',b''
        result=b.build(self.runtime,self.sdk,self.winter,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=runner,heads=self.heads,trees={},base_pin=pin,builder_root=self.builder,aliases=self.aliases)
        return result,calls
    def test_injected_compiler_refusal_retains_measured_stage_and_makes_no_receipt(self):
        tools,pin=self.tools();calls=[]
        def refusal(*args):calls.append(args);raise p.Refusal('injected compiler refusal')
        with self.assertRaisesRegex(p.Refusal,'injected compiler refusal'):
            b.build(self.runtime,self.sdk,self.winter,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=refusal,heads=self.heads,trees={},base_pin=pin,builder_root=self.builder,aliases=self.aliases)
        self.assertEqual(len(calls),1);self.assertTrue((self.output/'inputs.json').is_file());self.assertFalse((self.output/'receipt.json').exists())
        r.check_inputs(self.output,json.loads((self.output/'inputs.json').read_bytes()))
    def test_a_role_compile_refused_after_the_semantic_checks_leaves_no_receipt_and_no_output(self):
        tools,pin=self.tools();self.sysroot()
        def runner(argv,cwd,timeout,pass_fds):
            if argv[-1]=='--version':return pin['version'].encode()+b'\n',b''
            for negative,positive in zip(p.AUTOLOAD_FLAGS,r.POSITIVE_AUTOLOAD):
                if negative in argv and positive in argv:raise b.CommandFailure(1,b'',('error: Cannot use both '+positive+' and '+negative+'\n').encode())
            if '--allow-unresolved=*' in argv:raise b.CommandFailure(1,b'',b'error: --reject-unresolved and --allow-unresolved cannot be used together\n')
            opaque=[str(a) for a in argv if str(a).endswith('/opaque-import.ts')]
            if opaque and '--reject-unresolved' in argv:raise b.CommandFailure(1,b'',r.opaque_diagnostic(Path(opaque[0])))
            outfile=Path(argv[argv.index('--outfile')+1])
            if 'reader-compiler-measurements' not in str(outfile):raise p.Refusal('injected role compile refusal')
            outfile.write_bytes(standalone_pair(15 if all(f in argv for f in p.AUTOLOAD_FLAGS) else 0 if all(f in argv for f in r.POSITIVE_AUTOLOAD) else 12)[1])
            return b'',b''
        with self.assertRaisesRegex(p.Refusal,'injected role compile refusal'):
            b.build(self.runtime,self.sdk,self.winter,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=runner,heads=self.heads,trees={},base_pin=pin,builder_root=self.builder,aliases=self.aliases)
        self.assertFalse((self.output/'receipt.json').exists());self.assertEqual(list((self.output/'artifacts').iterdir()),[])
        self.assertTrue((self.output/'diagnostics').is_dir())
    def test_synthetic_outputs_bind_the_closed_ten_artifact_receipt(self):
        result,calls=self.synthetic()
        self.assertEqual(set(result['artifacts']),set(pins.ARTIFACT_NAMES));self.assertEqual(len(result['artifacts']),10)
        self.assertEqual(set(result['roles']),set(pins.ROLE_NAMES));self.assertEqual(set(result['commands']['native']),set(pins.NATIVE_NAMES))
        self.assertNotIn(str(self.root),p.canonical(result))
        for flag in ('nativeOwnerVerified','linuxExecutionVerified','vmExecutionVerified','activationEnabled','autoloadExecutionVerified','dynamicRuntimeImportsVerified'):self.assertFalse(result[flag])
        self.assertTrue(set(pins.ROLES['hostClient']['required'])<=set(result['roles']['hostClient']['bundledInputs']))
        r.check_inputs(self.output,json.loads((self.output/'inputs.json').read_bytes()))
    def test_every_started_process_is_the_held_compiler_or_the_held_cc_and_never_an_output(self):
        _,calls=self.synthetic()
        self.assertGreater(len(calls),20)
        for argv in calls:
            self.assertRegex(argv[0],r'^/proc/self/fd/\d+$')
            for out in pins.ARTIFACT_NAMES:self.assertNotEqual(Path(argv[0]).name,out)
        natives=[a for a in calls if '-o' in a];self.assertEqual(len(natives),6)
        for argv in natives:
            name=Path(argv[argv.index('-o')+1]).name;spec=pins.NATIVE[name]
            expected=list(spec['flags']) if spec['flags'] else list(r.NATIVE_FLAGS)
            self.assertEqual(argv[1:1+len(expected)],expected)
    def test_roles_are_compiled_with_the_same_literal_flags_and_the_reader_recipe_is_the_accepted_one(self):
        _,calls=self.synthetic()
        compiles=[a for a in calls if 'build' in a and 'reader-compiler-measurements' not in ' '.join(map(str,a))]
        self.assertEqual(len(compiles),4)
        for argv in compiles:
            for flag in p.AUTOLOAD_FLAGS:self.assertIn(flag,argv)
            for flag in ('--compile','--reject-unresolved','--no-env-file'):self.assertIn(flag,argv)
            self.assertIn('--target=bun-linux-arm64',argv)
        self.assertEqual(b.role_recipe(self.output,'instructionReader'),r.compiler_recipe(self.output))
    def test_a_role_that_does_not_embed_all_four_autoload_flags_refuses(self):
        with self.assertRaisesRegex(p.Refusal,'embedded autoload flags'):self.synthetic(role_nibble=12)
        self.assertFalse((self.output/'receipt.json').exists())
    def test_a_role_changed_after_its_compile_refuses_on_the_decoded_hash(self):
        with self.assertRaisesRegex(p.Refusal,'decoded hash mismatch'):self.synthetic(tamper_after_compile=True)
        self.assertFalse((self.output/'receipt.json').exists())
    def test_a_role_recipe_that_differs_from_the_accepted_reader_recipe_refuses(self):
        put(self.runtime,'src/guest/instruction-reader.ts',b'x\n');self.heads['runtime']=git_commit(self.runtime)
        tools,pin=self.tools();self.sysroot();old=pins.ROLES['instructionReader']['entry']
        def runner(argv,cwd,timeout,pass_fds):
            if argv[-1]=='--version':return pin['version'].encode()+b'\n',b''
            raise p.Refusal('must not reach a compile')
        pins.ROLES['instructionReader']['entry']='source/runtime/src/guest/instruction-reader.ts'
        try:
            with self.assertRaisesRegex(p.Refusal,'accepted reader recipe'):
                b.build(self.runtime,self.sdk,self.winter,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=runner,heads=self.heads,trees={},base_pin=pin,builder_root=self.builder,aliases=self.aliases)
        finally:pins.ROLES['instructionReader']['entry']=old
    def test_role_missing_a_required_input_refuses_without_a_receipt(self):
        with self.assertRaisesRegex(p.Refusal,'required input missing'):self.synthetic(drop_input=('hostClient','source/winter/packages/core/src/cowork/current-context-resolver.ts'))
        self.assertFalse((self.output/'receipt.json').exists())
    def test_unused_third_party_binding_refuses(self):
        self.aliases={'winter':{'zod':'zod@4.4.3'},'sdk':{'left':'left@1.0.0'}}
        with self.assertRaisesRegex(p.Refusal,'unused third-party'):self.synthetic()
    def test_mismatched_pinned_compiler_refuses(self):
        tools,pin=self.tools();pin['executableSha256']='0'*64
        with self.assertRaisesRegex(p.Refusal,'pinned Linux compiler'):
            b.build(self.runtime,self.sdk,self.winter,self.deps,tools['compiler'],tools['base'],tools['cc'],self.root,self.output,runner=lambda *a:(b'',b''),heads=self.heads,trees={},base_pin=pin,builder_root=self.builder,aliases=self.aliases)

class ArchiveTests(Fixture):
    def test_archive_excludes_scratch_records_the_inventory_and_honours_the_bound(self):
        packet=self.root/'archive-packet';put(packet,'artifacts/hostClient',b'inert');put(packet,'artifacts/native.d',b'scratch');put(packet,'receipt.json',b'{}')
        out=self.root/'out';out.mkdir()
        evidence=b.archive_packet(packet,out,'a'*40,'b'*40)
        self.assertEqual(sorted(evidence['files']),['artifacts/hostClient','receipt.json']);self.assertFalse(evidence['outputsExecuted']);self.assertFalse(evidence['activationEnabled'])
        with tarfile.open(out/'guided-packet.tar.gz') as tar:self.assertEqual(sorted(tar.getnames()),['artifacts/hostClient','receipt.json'])
        self.assertEqual(evidence['archiveSha256'],hashlib.sha256((out/'guided-packet.tar.gz').read_bytes()).hexdigest())
        out2=self.root/'out2';out2.mkdir();old=pins.MAX_PACKET_BYTES;pins.MAX_PACKET_BYTES=3
        try:
            with self.assertRaisesRegex(p.Refusal,'packet bytes'):b.archive_packet(packet,out2,'a'*40,'b'*40)
        finally:pins.MAX_PACKET_BYTES=old

ZOD='dependencies/.pnpm/zod@4.4.3/node_modules/zod/index.js'
class GraphTests(Fixture):
    def staged(self):
        self.aliases={'winter':{'zod':'zod@4.4.3'},'sdk':{'left':'left@1.0.0'}}
        return self.prepare()
    def test_sdk_family_workspace_and_third_party_bare_exports(self):
        manifest=self.staged();bundled={'source/sdk/packages/sdk/src/index.ts','source/winter/packages/protocol/src/index.ts',ZOD}
        t,e=g.captured_bare_export('@yanlinglabs/winter-agent-sdk','source/builder/scripts/guest-guided-build/entries/host-client.ts',self.output,manifest,bundled)
        self.assertEqual((t,e['bindingKind'],e['condition']),('source/sdk/packages/sdk/src/index.ts','sdk','bun'))
        t,e=g.captured_bare_export('@yanlinglabs/winter-protocol','source/winter/packages/core/src/runtime-sdk/model-tag.ts',self.output,manifest,bundled)
        self.assertEqual((t,e['bindingKind']),('source/winter/packages/protocol/src/index.ts','winter'))
        t,e=g.captured_bare_export('zod','source/winter/packages/protocol/src/index.ts',self.output,manifest,bundled)
        self.assertEqual((t,e['bindingKind'],e['declaredTarget']),(ZOD,'dependencies','./index.js'))
    def test_a_dependency_importer_resolves_through_its_own_virtual_store_links_with_main_and_module_fields(self):
        manifest=self.staged()
        t,e=g.captured_bare_export('right','dependencies/.pnpm/left@1.0.0/node_modules/left/lib.js',self.output,manifest,set())
        self.assertEqual((t,e['bindingKind'],e['condition']),('dependencies/.pnpm/right@2.0.0/node_modules/right/esm.js','dependencies-internal','main-or-module-field'))
        with self.assertRaisesRegex(p.Refusal,'not found above'):g.captured_bare_export('absent','dependencies/.pnpm/left@1.0.0/node_modules/left/lib.js',self.output,manifest,set())
    def test_main_and_module_fields_that_disagree_refuse(self):
        self.assertEqual(g.main_field({'main':'a.js'}),'./a.js');self.assertEqual(g.main_field({}),'./index.js');self.assertEqual(g.main_field({'module':'./m.js','main':'./m.js'}),'./m.js')
        with self.assertRaisesRegex(p.Refusal,'disagree'):g.main_field({'module':'m.js','main':'c.js'})
    def test_bare_export_refusals(self):
        manifest=self.staged();importer='source/winter/packages/protocol/src/index.ts'
        with self.assertRaises(p.Refusal):g.captured_bare_export('left-pad',importer,self.output,manifest,{'x'})
        with self.assertRaisesRegex(p.Refusal,'origin'):g.captured_bare_export('zod','dependencies/zod/index.js'.replace('dependencies','elsewhere'),self.output,manifest,{ZOD})
        with self.assertRaisesRegex(p.Refusal,'workspace export'):g.captured_bare_export('@yanlinglabs/winter-protocol/x',importer,self.output,manifest,set())
        with self.assertRaisesRegex(p.Refusal,'alias identity'):g.captured_bare_export('@yanlinglabs/winter-protocol','source/runtime/src/guest/instruction-reader-entry.ts',self.output,manifest,set())
    def test_exports_condition_order_is_the_objects_own(self):
        exports={'@zod/source':'./src/index.ts','types':'./index.d.cts','import':'./index.js','require':'./index.cjs'}
        self.assertEqual(g.resolve_exports({'.':exports},'.'),'./index.js')
        self.assertEqual(g.resolve_exports({'.':{'require':'./c.cjs','import':'./m.js'}},'.'),'./m.js')
        self.assertEqual(g.resolve_exports({'.':{'default':'./d.js','import':'./m.js'}},'.'),'./d.js')
        self.assertIsNone(g.resolve_exports({'.':{'require':'./c.cjs'}},'.'));self.assertIsNone(g.resolve_exports({'.':'./x.js'},'./sub'))
        with self.assertRaises(p.Refusal):g.resolve_exports({},'.')
        with self.assertRaises(p.Refusal):g.resolve_exports({'.':'./a.js','import':'./b.js'},'.')
    def test_extensionless_relative_edges_resolve_in_bun_extension_order_inside_the_capture(self):
        measured={'a/x.ts':{'kind':'file'},'a/x.js':{'kind':'file'},'a/y/index.ts':{'kind':'file'},'a/z.json':{'kind':'file'},'a/w.ts':{'kind':'file'}}
        self.assertEqual(g.resolve_relative_edge('./x','a/main.ts',measured),'a/x.ts')
        self.assertEqual(g.resolve_relative_edge('./y','a/main.ts',measured),'a/y/index.ts')
        self.assertEqual(g.resolve_relative_edge('./w.ts','a/main.ts',measured),'a/w.ts')
        self.assertEqual(g.resolve_relative_edge('./z','a/main.ts',measured),'a/z.json')
        with self.assertRaisesRegex(p.Refusal,'escapes'):g.resolve_relative_edge('../../escape','a/main.ts',measured)
        for bad in ('./missing','/abs/x'):
            with self.assertRaises(p.Refusal):g.resolve_relative_edge(bad,'a/main.ts',measured)
    def stage_config(self,manifest,name,text):
        path=self.output/name;path.parent.mkdir(parents=True,exist_ok=True)
        if path.exists():path.chmod(0o600)
        path.write_text(text);manifest['stagedInputs'][name]={'kind':'file','sha256':p.digest(text.encode()),'bytes':len(text.encode())}
    def test_tsconfig_paths_are_modelled_exactly_and_everything_else_refuses(self):
        manifest=self.staged();importer='source/builder/scripts/guest-guided-build/entries/host-client.ts';staged=manifest['stagedInputs']
        self.stage_config(manifest,'source/builder/scripts/tsconfig.base.json','// comment\n{"compilerOptions":{"paths":{"@yanlinglabs/winter-agent-sdk":["../../sdk/packages/sdk/src/index.ts"]}}}\n')
        self.stage_config(manifest,'source/builder/scripts/tsconfig.json','{"extends":"./tsconfig.base.json"}\n')
        found=g.tsconfig_paths(importer,Path('source/builder'),self.output,staged)
        self.assertEqual(g.tsconfig_mapping('@yanlinglabs/winter-agent-sdk',found),'source/sdk/packages/sdk/src/index.ts')
        self.assertIsNone(g.tsconfig_mapping('zod',found))
        self.stage_config(manifest,'source/builder/scripts/tsconfig.base.json','{"compilerOptions":{"paths":{"@yanlinglabs/*":["../../sdk/packages/*/src/index.ts"]}}}\n')
        with self.assertRaisesRegex(p.Refusal,'wildcard'):g.tsconfig_mapping('@yanlinglabs/winter-agent-sdk',g.tsconfig_paths(importer,Path('source/builder'),self.output,staged))
        self.stage_config(manifest,'source/builder/scripts/tsconfig.base.json','{"compilerOptions":{"baseUrl":"."}}\n')
        with self.assertRaisesRegex(p.Refusal,'baseUrl'):g.tsconfig_paths(importer,Path('source/builder'),self.output,staged)
        self.stage_config(manifest,'source/builder/scripts/tsconfig.json','{"extends":"typescript/tsconfig"}\n')
        with self.assertRaisesRegex(p.Refusal,'extends'):g.tsconfig_paths(importer,Path('source/builder'),self.output,staged)
    def test_a_tsconfig_paths_entry_must_name_the_same_file_the_alias_derives(self):
        manifest=self.staged();bundled={'source/sdk/packages/sdk/src/index.ts'}
        importer='source/builder/scripts/guest-guided-build/entries/host-client.ts'
        self.stage_config(manifest,'source/builder/scripts/tsconfig.json','{"compilerOptions":{"paths":{"@yanlinglabs/winter-agent-sdk":["../../sdk/packages/sdk/src/index.ts"]}}}\n')
        target,evidence=g.captured_bare_export('@yanlinglabs/winter-agent-sdk',importer,self.output,manifest,bundled)
        self.assertEqual(target,'source/sdk/packages/sdk/src/index.ts');self.assertTrue(evidence['tsconfigPathsAgree'])
        self.stage_config(manifest,'source/builder/scripts/tsconfig.json','{"compilerOptions":{"paths":{"@yanlinglabs/winter-agent-sdk":["../../sdk/packages/sdk/src/other.ts"]}}}\n')
        with self.assertRaisesRegex(p.Refusal,'tsconfig paths disagree'):g.captured_bare_export('@yanlinglabs/winter-agent-sdk',importer,self.output,manifest,bundled)
    def test_jsonc_strips_comments_outside_strings_and_refuses_trailing_commas(self):
        self.assertEqual(g.jsonc(b'{ /* a */ "k": "v // not a comment", // tail\n "n": 1 }'),{'k':'v // not a comment','n':1})
        with self.assertRaises(Exception):g.jsonc(b'{"a":1,}')
    def test_a_pruned_edge_is_recorded_not_admitted_and_an_unmeasured_one_refuses(self):
        manifest=self.staged();entry='source/winter/packages/protocol/src/index.ts'
        role={'entry':entry,'required':()}
        def metafile(path):
            size=(self.output/entry).stat().st_size
            return {'inputs':{str(self.output/entry):{'bytes':size,'imports':[{'path':path,'kind':'import-statement','original':'./x'}]}},'outputs':{}}
        measured_target=str(self.output/'source/winter/packages/core/src/cowork/types.ts')
        normalized,bundled=g.normalized_metafile(metafile(measured_target),self.output,manifest,role)
        self.assertEqual(normalized['prunedEdgeCount'],1);self.assertNotIn('source/winter/packages/core/src/cowork/types.ts',bundled)
        with self.assertRaises(p.Refusal):g.normalized_metafile(metafile(str(self.output/'source/winter/packages/core/src/nowhere.ts')),self.output,manifest,role)
        with self.assertRaisesRegex(p.Refusal,'outside capture'):g.normalized_metafile(metafile(str(self.output/'source/winter/packages/core/src/cowork')),self.output,manifest,role)
    def test_externals_allow_node_bun_and_bun_ffi_only(self):
        manifest=self.staged()
        def evidence(target):
            m={'inputs':{'source/runtime/src/guest/instruction-reader-entry.ts':{'imports':[{'kind':'import-statement','path':target,'external':True,'original':target}]}}}
            return g.graph_evidence(m,self.output,manifest)
        for ok in ('node:fs','fs','bun','bun:ffi'):evidence(ok)
        for bad in ('bun:sqlite','left-pad','@scope/pkg'):
            with self.assertRaises(p.Refusal):evidence(bad)

class AcquireTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-guided-acquire-test-',dir=Path('/var/tmp').resolve());self.root=Path(self.temp.name).resolve()
    def tearDown(self):self.temp.cleanup()
    def zip(self,members):
        buffer=io.BytesIO()
        with zipfile.ZipFile(buffer,'w') as z:
            for name,data in members:
                info=zipfile.ZipInfo(name);info.external_attr=(0o100755<<16) if not name.endswith('/') else (0o40755<<16);z.writestr(info,data)
        path=self.root/'bun.zip';path.write_bytes(buffer.getvalue());return path,hashlib.sha256(buffer.getvalue()).hexdigest()
    def bun_pin(self,archive,base):return {**pins.BUN,'archiveSha256':archive,'executableSha256':hashlib.sha256(base).hexdigest()}
    def test_bun_zip_is_verified_and_unpacked_as_data(self):
        path,digest=self.zip([('bun-linux-aarch64/',b''),('bun-linux-aarch64/bun',b'inert base bytes')]);out=self.root/'fx';out.mkdir()
        record=acquire.extract_bun(path,out,self.bun_pin(digest,b'inert base bytes'))
        self.assertTrue(record['archivePinMatched'] and record['basePinMatched']);self.assertFalse(record['outputsExecuted'])
        self.assertEqual((out/'linux-bun').read_bytes(),b'inert base bytes');self.assertEqual((out/'linux-bun').stat().st_mode&0o777,0o500)
    def test_bun_zip_refusals(self):
        path,digest=self.zip([('bun-linux-aarch64/bun',b'inert')])
        for label,pin in (('archive pin',self.bun_pin('0'*64,b'inert')),('executable pin',self.bun_pin(digest,b'other'))):
            out=self.root/label.replace(' ','-');out.mkdir()
            with self.assertRaisesRegex(acquire.Refusal,label):acquire.extract_bun(path,out,pin)
        path,digest=self.zip([('bun-linux-aarch64/bun',b'inert'),('bun-linux-aarch64/extra',b'x')]);out=self.root/'inv';out.mkdir()
        with self.assertRaisesRegex(acquire.Refusal,'inventory'):acquire.extract_bun(path,out,self.bun_pin(digest,b'inert'))
    def tgz(self,name,members):
        buffer=io.BytesIO()
        with tarfile.open(fileobj=buffer,mode='w:gz') as tar:
            for member,data,kind in members:
                info=tarfile.TarInfo(member);info.type=kind
                if kind==tarfile.REGTYPE:info.size=len(data);tar.addfile(info,io.BytesIO(data))
                else:info.linkname='/etc/passwd';tar.addfile(info)
        (self.root/'tarballs').mkdir(exist_ok=True);path=self.root/'tarballs'/(pins.package_directory(name)+'.tgz');path.write_bytes(buffer.getvalue());return hashlib.sha512(buffer.getvalue()).hexdigest()
    def pin(self,mutate=None):
        manifest=lambda name,version:json.dumps({'name':name,'version':version}).encode()
        packages=[]
        for ident,name,version,deps in (('@s/a@1.0.0','@s/a','1.0.0',{'b':'b@2.0.0'}),('b@2.0.0','b','2.0.0',{})):
            members=(('package/package.json',manifest(name,version),tarfile.REGTYPE),('package/lib/index.js',b'x',tarfile.REGTYPE))
            if mutate and mutate[0]==ident:members=mutate[1]
            packages.append({'id':ident,'name':name,'version':version,'url':'https://registry.npmjs.org/x','sha512':self.tgz(ident,members),'dependencies':deps})
        return {'packages':packages}
    def test_dependencies_unpack_into_a_pnpm_style_virtual_store_with_links_from_the_pin(self):
        pin=self.pin();out=self.root/'fx';out.mkdir()
        result=acquire.extract_deps(self.root/'tarballs',out,pin);self.assertEqual(result['packages'],2)
        store=out/'dependencies/.pnpm'
        self.assertEqual((store/'@s+a@1.0.0/node_modules/@s/a/lib/index.js').read_bytes(),b'x')
        link=store/'@s+a@1.0.0/node_modules/b';self.assertTrue(link.is_symlink());self.assertEqual(os.readlink(link),'../../b@2.0.0/node_modules/b')
        self.assertEqual((link/'package.json').read_bytes(),(store/'b@2.0.0/node_modules/b/package.json').read_bytes())
    def test_dependency_tarball_refusals(self):
        good=lambda name:(('package/package.json',json.dumps({'name':name,'version':'2.0.0'}).encode(),tarfile.REGTYPE),)
        cases={'path':(('package/../evil',b'x',tarfile.REGTYPE),),'prefix':(('other/x',b'x',tarfile.REGTYPE),),'link':(('package/l',b'',tarfile.SYMTYPE),),
               'identity':(('package/package.json',b'{"name":"b","version":"0.0.1"}',tarfile.REGTYPE),)}
        for label,members in cases.items():
            pin=self.pin(mutate=('b@2.0.0',members));out=self.root/('fx-'+label);out.mkdir()
            with self.assertRaises(acquire.Refusal,msg=label):acquire.extract_deps(self.root/'tarballs',out,pin)
    def test_a_swapped_tarball_or_a_link_outside_the_pin_set_refuses(self):
        pin=self.pin();pin['packages'][1]['sha512']='0'*128;out=self.root/'fx-swap';out.mkdir()
        with self.assertRaisesRegex(acquire.Refusal,'tarball pin'):acquire.extract_deps(self.root/'tarballs',out,pin)
        pin=self.pin();pin['packages'][0]['dependencies']={'c':'c@9.9.9'};out=self.root/'fx-link';out.mkdir()
        with self.assertRaisesRegex(acquire.Refusal,'outside the pin set'):acquire.extract_deps(self.root/'tarballs',out,pin)
        pin=self.pin();pin['packages'].append(dict(pin['packages'][0]));out=self.root/'fx-dup';out.mkdir()
        with self.assertRaisesRegex(acquire.Refusal,'pin set'):acquire.extract_deps(self.root/'tarballs',out,pin)

class PinCascadeTests(unittest.TestCase):
    PIN=json.loads((HERE/'guided-compile-inputs.pin.json').read_bytes())
    def test_pin_file_shape_and_hex_forms(self):
        self.assertEqual(set(self.PIN),{'formatVersion','kind','note','bun','origins','dependencies','trigger','actions','retentionDays','limits'})
        for origin in self.PIN['origins'].values():
            self.assertRegex(origin['head'],r'^[0-9a-f]{40}$');self.assertRegex(origin['tree'],r'^[0-9a-f]{40}$')
        for action,sha in self.PIN['actions'].items():self.assertRegex(sha,r'^[0-9a-f]{40}$')
        for key in ('archiveSha256','executableSha256'):self.assertRegex(self.PIN['bun'][key],r'^[0-9a-f]{64}$')
        deps=self.PIN['dependencies'];ids=[item['id'] for item in deps['packages']]
        self.assertEqual(len(ids),len(set(ids)))
        for item in deps['packages']:
            self.assertRegex(item['sha512'],r'^[0-9a-f]{128}$');self.assertTrue(item['url'].startswith('https://registry.npmjs.org/'));self.assertEqual(item['id'],item['name']+'@'+item['version'])
            for name,target in item['dependencies'].items():self.assertIn(target,ids)
        for origin,mapping in deps['aliases'].items():
            for name,target in mapping.items():self.assertIn(target,ids);self.assertEqual(target.rpartition('@')[0],name)
    def test_python_constants_are_the_pin_file(self):
        self.assertEqual(pins.BASE,{k:self.PIN['bun'][k] for k in ('version','target','archiveSha256','executableSha256')})
        self.assertEqual(pins.HEADS,{'runtime':self.PIN['origins']['runtimeSdk']['head'],'sdk':self.PIN['origins']['agentSdk']['head'],'winter':self.PIN['origins']['winterCore']['head']})
        self.assertEqual(pins.TRIGGER_BRANCH,self.PIN['trigger']['branch']);self.assertEqual(pins.DEPENDENCIES,self.PIN['dependencies'])
    def test_the_dependency_list_file_is_exactly_the_rendering_of_the_pin(self):
        self.assertEqual((HERE/'dependencies.lst').read_text(),pins.dependency_list())
        for line in (HERE/'dependencies.lst').read_text().splitlines():
            digest,name,url=line.split(' ');self.assertRegex(digest,r'^[0-9a-f]{128}$');self.assertTrue(name.endswith('.tgz'));self.assertTrue(url.startswith('https://registry.npmjs.org/'))
    def test_the_two_zod_majors_do_not_collide_and_each_origin_gets_its_own(self):
        self.assertEqual(pins.ALIASES['winter']['zod'],'zod@4.4.3')
        self.assertNotIn('zod',pins.ALIASES['sdk'])
        self.assertTrue(any(item['id']=='zod@4.5.4' for item in pins.DEPENDENCY_PACKAGES))
    def test_the_bun_record_has_exactly_one_home_in_the_sources(self):
        for name in ('pins.py','graph.py','acquire.py','build.py','pin-deps.ts','entries/provider-worker.ts','entries/host-client.ts'):
            text=(HERE/name).read_text()
            for literal in (self.PIN['bun']['archiveSha256'],self.PIN['bun']['executableSha256'],'bun-v'+self.PIN['bun']['version'],'1.3.14'):
                self.assertNotIn(literal,text,name)
    def test_the_target_follows_the_accepted_reader_recipe_and_the_roles_are_four_plus_six(self):
        self.assertEqual(pins.BASE['target'],p.BASE['target'])
        self.assertEqual(len(pins.ROLE_NAMES),4);self.assertEqual(len(pins.NATIVE_NAMES),6);self.assertEqual(len(set(pins.ARTIFACT_NAMES)),10)
        self.assertEqual(set(pins.ROLE_NAMES),{'runtimeEntry','providerWorker','hostClient','instructionReader'})
        self.assertEqual(set(pins.NATIVE_NAMES),{'toolLauncher','runtimeLauncher','fileWorker','processWorker','ownerLibrary','instructionReaderLauncher'})
    def test_builder_file_list_names_real_files_and_this_directory_completely(self):
        for name in pins.BUILDER_FILES:self.assertTrue((REPO/name).is_file(),name)
        own={'scripts/guest-guided-build/'+path.relative_to(HERE).as_posix() for path in HERE.rglob('*') if path.is_file() and '__pycache__' not in path.parts}
        self.assertEqual(own,{n for n in pins.BUILDER_FILES if n.startswith('scripts/guest-guided-build/')})
    def test_retention_is_capped_at_seven_days_and_the_limit_is_stated(self):
        self.assertEqual(pins.RETENTION_DAYS,7);self.assertLessEqual(pins.RETENTION_DAYS,7)
        self.assertEqual(pins.MAX_PACKET_BYTES,1024**3)
    def test_trigger_branch_is_new_and_not_a_reader_or_hosted_name(self):
        for used in ('cowork/instruction-reader-compile-fixture','cowork/reader-hosted-dependency-probe','cowork/reader-hosted-fixture-stderr','cowork/guided-packet-build'):self.assertNotEqual(pins.TRIGGER_BRANCH,used)
        self.assertEqual(pins.TRIGGER_BRANCH,'cowork/guided-packet-compile-fixture')

class NoExecutionTests(unittest.TestCase):
    SOURCES=('build.py','graph.py','acquire.py','pins.py')
    FORBIDDEN=re.compile(r'\b(os\.(system|exec\w*|spawn\w*|popen|posix_spawn\w*)|subprocess\.(run|call|check_call|check_output|getoutput)|ctypes|dlopen|pty\.|runpy|os\.fork|os\.startfile)\b')
    def test_no_source_can_start_a_process_other_than_through_the_injected_runner(self):
        for name in self.SOURCES:self.assertIsNone(self.FORBIDDEN.search((HERE/name).read_text()),name)
    def test_every_runner_call_names_the_held_compiler_or_held_cc(self):
        text=(HERE/'build.py').read_text()
        calls=re.findall(r"runner\(\[([^\]]*)\]",text);self.assertEqual(len(calls),4)
        for argv in calls:self.assertRegex(argv,r"^'/proc/self/fd/'\+str\((compiler_fd|cc_fd)\)")
    def test_the_entry_adapters_refuse_when_started_and_import_nothing_dynamic(self):
        for name in ('provider-worker.ts','host-client.ts'):
            text=(HERE/'entries'/name).read_text()
            self.assertIn('if (import.meta.main)',text);self.assertIn('throw new Error("compile-only',text)
            self.assertNotRegex(text,r'\bimport\s*\(');self.assertNotRegex(text,r'child_process|node:net|fetch\(|Bun\.spawn|dlopen')

if __name__=='__main__':unittest.main()
