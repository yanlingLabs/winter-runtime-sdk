"""Portable tests for verify_packet.py on synthetic packets. Pure data: no compiler, nothing is executed, nothing is
extracted; a tiny tar.gz is built in a temporary directory and audited in memory."""
import copy,hashlib,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('verify_packet',HERE/'verify_packet.py');vp=importlib.util.module_from_spec(spec);spec.loader.exec_module(vp)
sha=lambda b:hashlib.sha256(b).hexdigest()
ROLES=('runtimeEntry','providerWorker','hostClient','instructionReader')
NATIVES=('toolLauncher','runtimeLauncher','fileWorker','processWorker','ownerLibrary','instructionReaderLauncher')

def files_model():
    """name -> bytes (regular file) or ('link', target)."""
    f={}
    for n in ROLES+NATIVES:f['artifacts/'+n]=b'\x7fELF inert '+n.encode()
    for n in ROLES:f[f'artifacts/{n}.metafile.json']=b'{"inputs":{}}'
    f['environment/lib/aarch64-linux-gnu/libc.so.6']=b'inert libc'
    f['stage/linux-bun-base']=b'inert bun base'
    f['stage/empty-bunfig.toml']=b''
    f['source/builder/scripts/x.py']=b'print(1)\n'
    f['source/sdk/node_modules/pkg']=('link','../../../dependencies/.pnpm/a@1.0.0/node_modules/a')
    f['dependencies/.pnpm/a@1.0.0/node_modules/a/package.json']=b'{"name":"a"}'
    f['dependencies/.pnpm/b@1.0.0/node_modules/a']=('link','../../a@1.0.0/node_modules/a')
    f['compiler-acquisition.json']=json.dumps({'outputsExecuted':False,'archivePinMatched':True,'basePinMatched':True}).encode()
    f['inputs.json']=json.dumps({'origins':[{'role':r,'head':'a'*40,'tree':'b'*40,'inventorySha256':'c'*64,'eligibleFiles':{'x':1}} for r in ('runtime','sdk','winter')]+[{'role':'builder','head':'d'*40,'tree':'e'*40,'inventorySha256':'f'*64,'eligibleFiles':{}}]}).encode()
    f['receipt.json']=json.dumps({'artifacts':{n:{'sha256':sha(f['artifacts/'+n])} for n in ROLES+NATIVES},
        'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False,'nativeOwnerVerified':False,'autoloadExecutionVerified':False,'dynamicRuntimeImportsVerified':False,
        'recipe':{'outputsExecuted':False},'resolverBindings':{'source/sdk/node_modules/pkg':{'target':f['source/sdk/node_modules/pkg'][1]}}}).encode()
    return f

def inventory_of(model,**header):
    files={}
    for n,v in model.items():files[n]={'kind':'symlink','target':v[1]} if isinstance(v,tuple) else {'kind':'file','sha256':sha(v),'bytes':len(v)}
    total=sum(v['bytes'] for v in files.values() if v['kind']=='file')
    base={'formatVersion':1,'kind':'winter-guided-compile-packet','builderHead':'d'*40,'workflowHead':'9'*40,'excludedScratch':['artifacts/native.d'],'files':files,'fileCount':len(files),'fileBytes':total,
          'outputsExecuted':False,'nativeAdmission':False,'vmExecutionVerified':False,'activationEnabled':False}
    base.update(header);return base

def write_tar(path,entries):
    """entries: list of dicts name,kind(reg|sym|hard|dir),data/target,mode,uid,gid,mtime."""
    with tarfile.open(path,'w:gz') as tar:
        for e in entries:
            info=tarfile.TarInfo(e['name']);info.uid=e.get('uid',0);info.gid=e.get('gid',0);info.mtime=e.get('mtime',0)
            kind=e.get('kind','reg')
            if kind=='sym':info.type=tarfile.SYMTYPE;info.linkname=e['target'];info.mode=e.get('mode',0o777);tar.addfile(info)
            elif kind=='hard':info.type=tarfile.LNKTYPE;info.linkname=e['target'];info.mode=0o400;tar.addfile(info)
            elif kind=='dir':info.type=tarfile.DIRTYPE;info.mode=0o700;tar.addfile(info)
            else:
                info.size=len(e['data']);info.mode=e.get('mode',0o400);tar.addfile(info,io.BytesIO(e['data']))

def entries_of(model):
    out=[]
    for n,v in sorted(model.items()):out.append({'name':n,'kind':'sym','target':v[1]} if isinstance(v,tuple) else {'name':n,'data':v})
    return out

def pin_of(model,inv_bytes,archive_bytes):
    ent=lambda n:{'sha256':sha(model[n]),'bytes':len(model[n])}
    inv=json.loads(inv_bytes)
    dep={k:(v['sha256'] if v['kind']=='file' else ['symlink',v['target']]) for k,v in inv['files'].items() if k.startswith('dependencies/')}
    return {'archive':{'sha256':sha(archive_bytes),'bytes':len(archive_bytes)},
        'inventory':{'sha256':sha(inv_bytes),'bytes':len(inv_bytes),'kind':'winter-guided-compile-packet','fileCount':inv['fileCount'],'fileBytes':inv['fileBytes'],'excludedScratch':['artifacts/native.d']},
        'builder':{'head':'d'*40,'files':{'scripts/x.py':sha(model['source/builder/scripts/x.py'])}},'workflowHead':'9'*40,
        'receipt':{'path':'receipt.json',**ent('receipt.json')},'inputs':{'path':'inputs.json',**ent('inputs.json')},'compilerAcquisition':{'path':'compiler-acquisition.json',**ent('compiler-acquisition.json')},
        'origins':{r:{'head':'a'*40,'tree':'b'*40,'inventorySha256':'c'*64,'fileCount':1} for r in ('runtime','sdk','winter')},
        'bun':{'executableSha256':sha(model['stage/linux-bun-base']),'stageBase':{'path':'stage/linux-bun-base',**ent('stage/linux-bun-base')}},
        'dependencies':{'storeEntries':len(dep),'storeSha256':vp.digest_json(dep),'links':1},
        'artifacts':{'roles':{n:{**ent('artifacts/'+n),**({'placeholder':True} if n in ('providerWorker','hostClient') else {})} for n in ROLES},'natives':{n:ent('artifacts/'+n) for n in NATIVES}},
        'metafiles':{n:ent(f'artifacts/{n}.metafile.json') for n in ROLES},'environment':{'environment/lib/aarch64-linux-gnu/libc.so.6':ent('environment/lib/aarch64-linux-gnu/libc.so.6')},
        'resolverBindings':{'source/sdk/node_modules/pkg':model['source/sdk/node_modules/pkg'][1]},'symlinks':{'total':2,'resolverAliases':1,'dependencyLinks':1}}

class Base(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='winter-guided-verify-test-');self.dir=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def packet(self,model=None,entries=None,inv_mutate=None,pin_mutate=None,model_for_pin=None):
        model=model or files_model();archive=self.dir/'p.tar.gz';write_tar(archive,entries if entries is not None else entries_of(model))
        archive_bytes=archive.read_bytes();inv=inventory_of(model,archiveSha256=sha(archive_bytes),archiveBytes=len(archive_bytes))
        if inv_mutate:inv_mutate(inv)
        inv_bytes=json.dumps(inv).encode()
        pin=pin_of(model_for_pin or model,inv_bytes,archive_bytes)
        if pin_mutate:pin_mutate(pin)
        (self.dir/'inv.json').write_bytes(inv_bytes)
        return vp.audit(archive,self.dir/'inv.json',pin)
    def failing(self,**kw):
        checks,details=self.packet(**kw);return sorted(k for k,v in checks.items() if not v),details

class HonestPacket(Base):
    def test_a_correct_packet_passes_every_check_and_reports_the_placeholders(self):
        checks,details=self.packet()
        self.assertTrue(all(checks.values()),[k for k,v in checks.items() if not v]);self.assertEqual(details['placeholders'],['hostClient','providerWorker'])
        self.assertEqual(details['memberModes'],{'reg 0o400':len(files_model())-2,'sym 0o777':2})

class ArchiveRefusals(Base):
    MEMBERS='archive members equal the inventory exactly'
    def mutated(self,fn):
        model=files_model();entries=entries_of(model);fn(entries);return self.failing(model=model,entries=entries)
    def test_absolute_symlink_target(self):
        # Inventory and tar agree on the absolute target, so only the escape rule can see it.
        model=files_model();model['source/sdk/node_modules/pkg']=('link','/etc/passwd')
        failed,d=self.failing(model=model);self.assertTrue(any(p[0]=='symlink escapes' for p in d['tarProblems']));self.assertIn(self.MEMBERS,failed)
    def test_a_link_to_a_missing_target(self):
        model=files_model();model['source/sdk/node_modules/pkg']=('link','../../../dependencies/.pnpm/nope@1.0.0/node_modules/nope')
        failed,_=self.failing(model=model);self.assertIn('every link target is a packet member',failed)
    def test_symlink_escaping_the_packet(self):
        failed,d=self.mutated(lambda e:[x.update(target='../../../../../etc') for x in e if x['name']=='source/sdk/node_modules/pkg']);self.assertIn(self.MEMBERS,failed);self.assertTrue(any(p[0]=='symlink escapes' for p in d['tarProblems']))
    def test_hardlink_member(self):
        failed,d=self.mutated(lambda e:e.append({'name':'artifacts/extra','kind':'hard','target':'artifacts/toolLauncher'}));self.assertIn(self.MEMBERS,failed);self.assertTrue(any(p[0]=='type' for p in d['tarProblems']))
    def test_directory_member(self):
        failed,d=self.mutated(lambda e:e.append({'name':'artifacts','kind':'dir'}));self.assertIn(self.MEMBERS,failed)
    def test_setuid_file(self):
        failed,d=self.mutated(lambda e:[x.update(mode=0o4755) for x in e if x['name']=='artifacts/toolLauncher']);self.assertTrue(any(p[0]=='setuid/setgid/sticky' for p in d['tarProblems']));self.assertIn(self.MEMBERS,failed)
    def test_executable_mode_is_not_accepted_as_build_evidence(self):
        failed,d=self.mutated(lambda e:[x.update(mode=0o755) for x in e if x['name']=='artifacts/toolLauncher']);self.assertTrue(any(p[0]=='file mode' for p in d['tarProblems']))
    def test_extra_member(self):
        failed,d=self.mutated(lambda e:e.append({'name':'artifacts/extra','data':b'x'}));self.assertIn(self.MEMBERS,failed);self.assertTrue(any(p[0]=='not in inventory' for p in d['tarProblems']))
    def test_missing_member(self):
        failed,d=self.mutated(lambda e:e.pop(0));self.assertIn(self.MEMBERS,failed)
    def test_changed_content_of_the_same_size(self):
        name=b'\x7fELF inert toolLauncher';failed,d=self.mutated(lambda e:[x.update(data=name.replace(b'inert',b'EVIL!')) for x in e if x['name']=='artifacts/toolLauncher']);self.assertEqual([p[0] for p in d['tarProblems']],['hash']);self.assertIn(self.MEMBERS,failed)
    def test_changed_size(self):
        failed,d=self.mutated(lambda e:[x.update(data=b'other') for x in e if x['name']=='artifacts/toolLauncher']);self.assertEqual([p[0] for p in d['tarProblems']],['kind or size'])
    def test_duplicate_member(self):
        failed,d=self.mutated(lambda e:e.append(dict(e[0])));self.assertTrue(any(p[0]=='duplicate' for p in d['tarProblems']))
    def test_parent_path_and_absolute_name(self):
        for name in ('../escape','/abs/x','artifacts/../x','artifacts//x'):
            failed,d=self.mutated(lambda e,name=name:e.append({'name':name,'data':b'x'}));self.assertTrue(any(p[0]=='path' for p in d['tarProblems']),name)
    def test_nonzero_owner_or_mtime(self):
        for key in ('uid','gid','mtime'):
            failed,d=self.mutated(lambda e,key=key:[x.update({key:1}) for x in e if x['name']=='artifacts/toolLauncher']);self.assertTrue(any(p[0]=='owner/mtime' for p in d['tarProblems']),key)
    def test_symlink_not_in_inventory_as_a_symlink(self):
        failed,d=self.mutated(lambda e:[x.update(target='../../../dependencies/.pnpm/b@1.0.0/node_modules/a') for x in e if x['name']=='source/sdk/node_modules/pkg']);self.assertTrue(any(p[0]=='symlink differs' for p in d['tarProblems']))

class PinRefusals(Base):
    def test_archive_hash_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['archive'].update(sha256='0'*64));self.assertIn('archive sha256 and size equal the pin',failed)
    def test_inventory_hash_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['inventory'].update(sha256='0'*64));self.assertIn('inventory sha256 and size equal the pin',failed)
    def test_inventory_claims_execution(self):
        failed,_=self.failing(inv_mutate=lambda i:i.update(outputsExecuted=True),pin_mutate=lambda p:None);self.assertIn('inventory header equals the pin',failed)
    def test_inventory_builder_head_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['builder'].update(head='1'*40));self.assertIn('inventory header equals the pin',failed)
    def test_pinned_artifact_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['artifacts']['natives']['toolLauncher'].update(sha256='0'*64));self.assertIn('every pinned member equals the inventory',failed)
    def test_artifacts_directory_with_an_extra_artifact(self):
        model=files_model();model['artifacts/surprise']=b'x'
        failed,_=self.failing(model=model,model_for_pin=files_model());self.assertTrue(failed)
    def test_environment_set_differs(self):
        model=files_model();model['environment/lib/extra.so']=b'x'
        failed,_=self.failing(model=model,pin_mutate=lambda p:None)
        self.assertIn('the environment holds exactly the pinned libraries',failed)
    def test_bun_base_is_not_the_pinned_executable(self):
        failed,_=self.failing(pin_mutate=lambda p:p['bun'].update(executableSha256='0'*64));self.assertIn('the Bun base is the pinned executable',failed)
    def test_dependency_store_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['dependencies'].update(storeSha256='0'*64));self.assertIn('the dependency store equals the pinned store',failed)
    def test_builder_file_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['builder']['files'].update({'scripts/x.py':'0'*64}));self.assertIn('the builder origin files equal the pinned builder files',failed)
    def test_alias_set_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['resolverBindings'].update({'source/sdk/node_modules/other':'x'}));self.assertIn('links split into the pinned aliases and dependency links',failed)
    def test_link_counts_differ(self):
        failed,_=self.failing(pin_mutate=lambda p:p['symlinks'].update(total=3));self.assertIn('links split into the pinned aliases and dependency links',failed)
    def test_origin_pin_differs(self):
        failed,_=self.failing(pin_mutate=lambda p:p['origins']['sdk'].update(head='1'*40));self.assertIn('inputs.json origins equal the pinned origins',failed)

class ReceiptRefusals(Base):
    def with_receipt(self,fn):
        model=files_model();r=json.loads(model['receipt.json']);fn(r);model['receipt.json']=json.dumps(r).encode();return self.failing(model=model)
    def test_receipt_claims_linux_execution(self):
        failed,_=self.with_receipt(lambda r:r.update(linuxExecutionVerified=True));self.assertIn('receipt and acquisition claim nothing was executed or verified',failed)
    def test_receipt_says_outputs_executed(self):
        failed,_=self.with_receipt(lambda r:r['recipe'].update(outputsExecuted=True));self.assertIn('receipt and acquisition claim nothing was executed or verified',failed)
    def test_receipt_artifact_hash_differs_from_the_inventory(self):
        failed,_=self.with_receipt(lambda r:r['artifacts']['toolLauncher'].update(sha256='0'*64));self.assertIn('receipt artifacts equal the inventory',failed)
    def test_receipt_leaks_a_runner_path(self):
        failed,_=self.with_receipt(lambda r:r.update(leak='/home/runner/work/x'));self.assertIn('receipt and inputs name no runner or home path',failed)
    def test_unpinned_resolver_binding(self):
        failed,_=self.with_receipt(lambda r:r['resolverBindings'].update({'source/sdk/node_modules/zz':{'target':'x'}}));self.assertIn('receipt resolver bindings equal the pinned aliases',failed)
    def test_unparseable_receipt(self):
        model=files_model();model['receipt.json']=b'not json';failed,_=self.failing(model=model);self.assertIn('receipt, inputs and acquisition parse',failed)

class ExitCodes(Base):
    """The hosted path binds nothing unless the exit code is 0 (README "Exit codes")."""
    def run_main(self,*extra):
        import contextlib
        out,err=io.StringIO(),io.StringIO()
        with contextlib.redirect_stdout(out),contextlib.redirect_stderr(err):code=vp.main(['verify_packet.py',*extra])
        return code,out.getvalue(),err.getvalue()
    def pin_file(self,model=None):
        model=model or files_model();archive=self.dir/'p.tar.gz';write_tar(archive,entries_of(model));ab=archive.read_bytes()
        inv=inventory_of(model,archiveSha256=sha(ab),archiveBytes=len(ab));ib=json.dumps(inv).encode();(self.dir/'inv.json').write_bytes(ib)
        pin=pin_of(model,ib,ab);(self.dir/'pin.json').write_text(json.dumps(pin));return archive
    def test_zero_only_when_every_check_holds(self):
        archive=self.pin_file()
        code,out,_=self.run_main(str(archive),str(self.dir/'inv.json'),'--pin',str(self.dir/'pin.json'))
        self.assertEqual(code,0);self.assertTrue(json.loads(out)['allChecksHold'])
    def test_one_when_a_check_fails_and_the_report_says_so(self):
        archive=self.pin_file();pin=json.loads((self.dir/'pin.json').read_text());pin['archive']['sha256']='0'*64;(self.dir/'pin.json').write_text(json.dumps(pin))
        code,out,_=self.run_main(str(archive),str(self.dir/'inv.json'),'--pin',str(self.dir/'pin.json'))
        self.assertEqual(code,1);self.assertFalse(json.loads(out)['allChecksHold'])
    def test_two_for_usage_missing_files_and_malformed_input_never_zero_or_one(self):
        archive=self.pin_file()
        for argv in ((),(str(archive),),(str(archive),str(self.dir/'inv.json'),'extra'),(str(self.dir/'missing.tar.gz'),str(self.dir/'inv.json'),'--pin',str(self.dir/'pin.json')),
                     (str(archive),str(self.dir/'missing.json'),'--pin',str(self.dir/'pin.json')),(str(archive),str(self.dir/'inv.json'),'--pin',str(self.dir/'missing-pin.json'))):
            code,out,err=self.run_main(*argv);self.assertEqual(code,2,argv);self.assertEqual(out,'',argv);self.assertNotIn(str(self.dir),err)
        (self.dir/'bad.tar.gz').write_bytes(b'not a tar');code,out,_=self.run_main(str(self.dir/'bad.tar.gz'),str(self.dir/'inv.json'),'--pin',str(self.dir/'pin.json'))
        self.assertIn(code,(1,2));self.assertNotEqual(code,0)
    def test_the_codes_are_constants(self):self.assertEqual((vp.EXIT_HOLDS,vp.EXIT_FAILED,vp.EXIT_ERROR),(0,1,2))

class NoExecution(unittest.TestCase):
    def test_the_verifier_cannot_start_a_process_or_extract(self):
        import re
        text=(HERE/'verify_packet.py').read_text()
        self.assertIsNone(re.search(r'\b(subprocess|os\.(system|exec\w*|spawn\w*|popen|fork)|ctypes|runpy|importlib|extractall|\.extract\()\b',text))
        self.assertIn('geteuid',text)

if __name__=='__main__':unittest.main()
