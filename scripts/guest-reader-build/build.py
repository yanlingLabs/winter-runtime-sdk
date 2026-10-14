#!/usr/bin/env python3
"""New reader-only, multi-origin compilation packet. Never executes outputs."""
import argparse,hashlib,importlib.util,json,os,platform,selectors,shlex,signal,subprocess,time
from pathlib import Path
if os.geteuid()==0:raise SystemExit('unprivileged reader build required before project imports')
_spec=importlib.util.spec_from_file_location('reader_provenance',Path(__file__).with_name('provenance.py'))
p=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(p)

MAX_OUTPUT=16*1024*1024
NATIVE_FLAGS=('-O2','-std=gnu11','-Wall','-Wextra','-Werror','-D_FORTIFY_SOURCE=2','-fstack-protector-strong','-fPIE','-pie','-Wl,-z,relro,-z,now,-z,noexecstack')
def command(argv,cwd,timeout=120,pass_fds=()):
    """Bounded ordinary compiler/tool invocation; compiled outputs never appear as commands."""
    proc=subprocess.Popen(argv,cwd=cwd,env=p.ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=pass_fds,start_new_session=True)
    poll=selectors.DefaultSelector();chunks={};total=0;deadline=time.monotonic()+timeout
    for stream in (proc.stdout,proc.stderr):os.set_blocking(stream.fileno(),False);poll.register(stream,selectors.EVENT_READ);chunks[stream.fileno()]=bytearray()
    try:
        while poll.get_map():
            if time.monotonic()>=deadline:p.refuse('compiler timeout')
            for key,_ in poll.select(min(.1,max(0,deadline-time.monotonic()))):
                data=os.read(key.fd,65536)
                if not data:poll.unregister(key.fileobj);continue
                total+=len(data)
                if total>MAX_OUTPUT:p.refuse('compiler output bound')
                chunks[key.fd].extend(data)
        code=proc.wait(timeout=max(.001,deadline-time.monotonic()))
        if code:p.refuse('compiler refused')
        return bytes(chunks[proc.stdout.fileno()]),bytes(chunks[proc.stderr.fileno()])
    finally:
        poll.close()
        if proc.poll() is None:
            os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        proc.stdout.close();proc.stderr.close()
def file_input(path,limit):
    path=Path(path)
    if path.resolve()!=path or not path.is_absolute():p.refuse('canonical regular tool')
    root=p.root_fd(Path('/'))
    try:fd=p.leaf(root,path.relative_to('/').as_posix())
    finally:os.close(root)
    try:
        data=p.read_fd(fd,limit)
        if p.identity(os.stat(path,follow_symlinks=False))!=p.identity(os.fstat(fd)):p.refuse('named tool replaced')
        return fd,{'sha256':p.digest(data),'bytes':len(data)}
    except:os.close(fd);raise
def json_data(data):
    def object_pairs(pairs):
        result={}
        for key,value in pairs:
            if key in result:p.refuse('duplicate JSON key')
            result[key]=value
        return result
    return json.loads(data,object_pairs_hook=object_pairs)
def read_file(path,limit):
    fd,_=file_input(Path(path),limit)
    try:return p.read_fd(fd,limit)
    finally:os.close(fd)
def eligible_capture(role,path,head,names=None):
    tree,entries=p.git_entries(path,head)
    names=sorted(name for name in entries if p.eligible(name)) if names is None else names
    if any(name not in entries for name in names):p.refuse('required source missing')
    fd=p.root_fd(Path(path).resolve())
    try:manifest=p.source_inventory(fd,entries,names)
    except:os.close(fd);raise
    return {'role':role,'head':head,'tree':tree,'eligibleFiles':manifest,'inventorySha256':p.digest(p.canonical(manifest).encode())},fd,entries,names
def alias_bindings(packet):
    bindings={}
    sdk=packet/'source/sdk'
    for name,folder in p.SDK_PACKAGES.items():
        manifest=sdk/'packages'/folder/'package.json'
        value=json_data(read_file(manifest,p.MAX_JSON))
        if value.get('name')!='@yanlinglabs/'+name or value.get('version')!='0.0.53':p.refuse('candidate SDK package identity')
        exports=value.get('exports',{}).get('.',{})
        if not isinstance(exports,dict) or exports.get('bun')!='./src/index.ts':p.refuse('candidate SDK source export')
        target=manifest.parent
        for origin in ('sdk','runtime'):
            alias=packet/'source'/origin/'node_modules/@yanlinglabs'/name
            alias.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            link=os.path.relpath(target,alias.parent)
            alias.symlink_to(link)
            bindings[str(alias.relative_to(packet))]={'target':link,'package':'@yanlinglabs/'+name,'origin':'sdk','version':'0.0.53'}
    # Only already-captured ordinary dependencies are available. No install/global fallback.
    for origin in ('sdk','runtime'):
        path=packet/'source'/origin/'node_modules/.pnpm';path.symlink_to(os.path.relpath(packet/'dependencies',path.parent))
    return bindings
def snapshot(packet,inputs_only=False):
    fd=p.root_fd(Path(packet).resolve())
    try:return p.inventory(fd,('source','dependencies') if inputs_only else None)
    finally:os.close(fd)
def prepare_packet(runtime,sdk,overlay,dependencies,output,heads=None):
    heads=heads or {'runtime':p.RUNTIME_HEAD,'sdk':p.SDK_HEAD,'overlay':p.OVERLAY_HEAD}
    output=Path(output)
    if not output.is_absolute() or output.exists() or output.parent.resolve()!=output.parent:p.refuse('new canonical packet directory')
    records=[];held=[];depfd=None
    try:
        for role,path,names in [('runtime',runtime,None),('sdk',sdk,None),('overlay',overlay,[p.C_SOURCE,p.HEADER])]:
            record,fd,entries,eligible=eligible_capture(role,Path(path).resolve(),heads[role],names);records.append(record);held.append((fd,entries,eligible))
        sdk_header=records[1]['eligibleFiles'].get(p.HEADER);overlay_header=records[2]['eligibleFiles'][p.HEADER]
        if sdk_header!=overlay_header:p.refuse('SDK overlay header differs from main')
        if p.READER_ENTRY not in records[0]['eligibleFiles']:p.refuse('actual private reader entry missing')
        depfd=p.root_fd(Path(dependencies));depmanifest=p.inventory(depfd)
        if any('@yanlinglabs+winter-' in name or '@yanlinglabs/winter-' in name for name in depmanifest):p.refuse('published SDK peers in dependency store')
        output.mkdir(mode=0o700);(output/'source').mkdir(mode=0o700)
        for record,(fd,_,_) in zip(records,held):p.copy_inventory(fd,record['eligibleFiles'],output/'source'/record['role'])
        p.copy_inventory(depfd,depmanifest,output/'dependencies')
        for record,(fd,entries,eligible),path in zip(records,held,(runtime,sdk,overlay)):
            if p.git_entries(path,heads[record['role']])!=(record['tree'],entries):p.refuse('origin Git tree changed')
            if p.source_inventory(fd,entries,eligible)!=record['eligibleFiles']:p.refuse('origin changed during copy')
        if p.inventory(depfd)!=depmanifest:p.refuse('dependencies changed during copy')
        bindings=alias_bindings(output)
        # Resolve the full staged graph, including origin-crossing aliases, before compilation.
        staged=snapshot(output)
        for path,binding in bindings.items():
            if staged.get(path)!={'kind':'symlink','target':binding['target']}:p.refuse('resolver binding changed')
        manifest={'formatVersion':1,'kind':'winter-reader-inputs','origins':records,'dependencies':depmanifest,'resolverBindings':bindings,'stagedInputs':staged,
          'stagedInventorySha256':p.digest(p.canonical(staged).encode()),'dependencyInstallationPerformed':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        p.write_new(output/'inputs.json',(p.canonical(manifest)+'\n').encode())
        return manifest
    finally:
        for fd,_,_ in held:os.close(fd)
        if depfd is not None:os.close(depfd)
def check_inputs(packet,manifest):
    if read_file(Path(packet)/'inputs.json',p.MAX_JSON)!=(p.canonical(manifest)+'\n').encode():p.refuse('input manifest changed')
    actual=snapshot(packet,True)
    expected=manifest['stagedInputs']
    # inputs.json and output work directories are not compiler source inputs.
    actual={name:value for name,value in actual.items() if name.startswith(('source/','dependencies/'))}
    if actual!=expected:p.refuse('staged bytes/resolver changed')
    for alias,binding in manifest['resolverBindings'].items():
        if actual.get(alias)!={'kind':'symlink','target':binding['target']}:p.refuse('candidate resolver changed')
def normalized_metafile(data,packet,manifest):
    if type(data)!=dict or type(data.get('inputs'))!=dict or not 1<=len(data['inputs'])<=p.MAX_ENTRIES:p.refuse('metafile shape')
    measured=manifest['stagedInputs'];mapped={}
    for raw,info in data['inputs'].items():
        if type(raw)!=str or type(info)!=dict or type(info.get('bytes'))!=int:p.refuse('metafile input record')
        physical=(packet/'stage'/raw).resolve();relative=physical.relative_to(packet).as_posix() if physical.is_relative_to(packet) else None
        if relative is None or measured.get(relative,{}).get('kind')!='file' or measured[relative]['bytes']!=info['bytes']:p.refuse('metafile input outside capture')
        if '0.0.28' in relative or '/dist/' in relative and relative.startswith('source/sdk/'):p.refuse('old/unmeasured SDK emit')
        if relative.startswith('dependencies/') and '@yanlinglabs' in relative:p.refuse('published peer resolver')
        mapped[raw]=relative
    entry='source/runtime/'+p.READER_ENTRY
    if entry not in mapped.values():p.refuse('reader entry missing from graph')
    if not any(name.startswith('source/sdk/packages/sdk/') for name in mapped.values()):p.refuse('actual candidate SDK peer absent')
    def remap(value):
        if isinstance(value,str):
            if value in mapped:return mapped[value]
            if str(packet) in value:return value.replace(str(packet),'<packet>')
            if value.startswith('/'):p.refuse('private absolute metafile path')
            return value
        if isinstance(value,list):return [remap(item) for item in value]
        if isinstance(value,dict):return {remap(key):remap(item) for key,item in value.items()}
        return value
    normalized=remap(data)
    return normalized,{name:measured[name] for name in sorted(set(mapped.values()))}
def compiler_recipe(packet):
    return ['build','--no-env-file','--config='+str(packet/'stage/empty-bunfig.toml'),'--compile','--reject-unresolved',*p.AUTOLOAD_FLAGS,
      '--target='+p.BASE['target'],'--compile-executable-path='+str(packet/'stage/linux-bun-base'),'--metafile='+str(packet/'artifacts/instructionReader.metafile.json'),
      str(packet/'source/runtime'/p.READER_ENTRY),'--outfile',str(packet/'artifacts/instructionReader')]
def dependency_closure(artifacts,sysroot,destination):
    sysroot=Path(sysroot)
    if sysroot.resolve()!=sysroot:p.refuse('canonical sysroot')
    destination.mkdir(mode=0o700);queue=[];result={};total=0
    def inspect(path):
        fd,measurement=file_input(path,p.MAX_ELF)
        try:
            meta=p.elf_metadata(fd)
            if p.digest(p.read_fd(fd,p.MAX_ELF))!=measurement['sha256']:p.refuse('artifact changed')
            return meta,measurement
        finally:os.close(fd)
    artifact_metadata={}
    for name,path in artifacts.items():
        meta,measurement=inspect(path);artifact_metadata[name]={'elf':meta,**measurement}
        queue.extend(([meta['interpreter']] if meta['interpreter'] else [])+[('needed',name) for name in meta['needed']])
    while queue:
        request=queue.pop(0)
        if isinstance(request,tuple):
            candidates=[sysroot/'lib/aarch64-linux-gnu'/request[1],sysroot/'usr/lib/aarch64-linux-gnu'/request[1]]
            source=next((path for path in candidates if path.exists()),None)
            if source is None:p.refuse('required ELF dependency missing')
            guest='/'+source.relative_to(sysroot).as_posix()
        else:
            if request!='/lib/ld-linux-aarch64.so.1':p.refuse('unadmitted ELF interpreter')
            guest=request;source=sysroot/request[1:]
        if guest in result:continue
        canonical=source.resolve()
        if not canonical.is_relative_to(sysroot):p.refuse('sysroot link escaped')
        fd,measurement=file_input(canonical,p.MAX_DEPENDENCY)
        try:
            data=p.read_fd(fd,p.MAX_DEPENDENCY);meta=p.elf_metadata(fd)
            if p.digest(data)!=measurement['sha256'] or p.digest(p.read_fd(fd,p.MAX_DEPENDENCY))!=measurement['sha256']:p.refuse('dependency changed')
            if meta['type']!=3 or meta['soname'] not in (None,Path(guest).name):p.refuse('dependency ELF identity')
        finally:os.close(fd)
        total+=measurement['bytes']
        if len(result)>=p.MAX_DEPENDENCIES or total>p.MAX_DEPENDENCY_BYTES:p.refuse('ELF closure bound')
        p.write_new(destination/guest[1:],data,True)
        result[guest]={**measurement,'elf':meta,'sourceRelative':canonical.relative_to(sysroot).as_posix()}
        queue.extend(([meta['interpreter']] if meta['interpreter'] else [])+[('needed',name) for name in meta['needed']])
    return artifact_metadata,result
def build(runtime,sdk,overlay,dependencies,compiler,base,cc,sysroot,output,runner=command,heads=None,base_pin=None):
    """runner injection permits portable refusal tests; CLI never replaces the runner/pins."""
    manifest=prepare_packet(runtime,sdk,overlay,dependencies,output,heads);packet=Path(output);pin=base_pin or p.BASE
    for name in ('stage','artifacts'): (packet/name).mkdir(mode=0o700)
    p.write_new(packet/'stage/empty-bunfig.toml',b'')
    tools=[]
    try:
        compiler_fd,compiler_meta=file_input(Path(compiler),p.MAX_ELF);tools.append(compiler_fd)
        base_fd,base_meta=file_input(Path(base),p.MAX_ELF);tools.append(base_fd)
        cc_fd,cc_meta=file_input(Path(cc),p.MAX_ELF);tools.append(cc_fd)
        if base_meta['sha256']!=pin['executableSha256'] or compiler_meta['sha256']!=pin['executableSha256']:p.refuse('pinned Linux compiler/base')
        p.write_new(packet/'stage/linux-bun-base',p.read_fd(base_fd,p.MAX_ELF),True)
        check_inputs(packet,manifest)
        version,_=runner(['/proc/self/fd/'+str(compiler_fd),'--version'],packet/'stage',30,(compiler_fd,))
        if version.strip()!=pin['version'].encode():p.refuse('Bun version changed')
        cc_version,_=runner(['/proc/self/fd/'+str(cc_fd),'--version'],packet/'stage',30,(cc_fd,))
        first=cc_version.decode('utf8').splitlines()[0]
        if len(first.encode())>512 or '/' in first:p.refuse('native compiler version bound')
        compile_args=compiler_recipe(packet)
        runner(['/proc/self/fd/'+str(compiler_fd),*compile_args],packet/'stage',120,(compiler_fd,))
        native_args=[*NATIVE_FLAGS,'-I'+str(packet/'source/overlay/packages/runtime/src/guest'),'-MD','-MF',str(packet/'artifacts/native.d'),
          str(packet/'source/overlay'/p.C_SOURCE),'-o',str(packet/'artifacts/instructionReaderLauncher')]
        runner(['/proc/self/fd/'+str(cc_fd),*native_args],packet/'stage',120,(cc_fd,))
        # Full system header provenance is an observation, not trusted toolchain proof.
        depfile=read_file(packet/'artifacts/native.d',p.MAX_JSON)
        words=shlex.split(depfile.decode().replace('\\\n',' '),posix=True)
        if not words or not words[0].endswith(':'):p.refuse('native dependency metadata')
        headers={}
        for raw in words[1:]:
            path=Path(raw).resolve()
            if not path.is_file() or len(headers)>=4096:p.refuse('native header inventory')
            if path.is_relative_to(packet):key=path.relative_to(packet).as_posix()
            elif path.is_relative_to(Path(sysroot)):key='sysroot/'+path.relative_to(Path(sysroot)).as_posix()
            else:p.refuse('native header outside sysroot')
            fd,meta=file_input(path,p.MAX_FILE)
            try:headers[key]=meta
            finally:os.close(fd)
        check_inputs(packet,manifest)
        metafile=json_data(read_file(packet/'artifacts/instructionReader.metafile.json',p.MAX_JSON))
        normalized,bundled=normalized_metafile(metafile,packet,manifest)
        # Replace raw paths with normalized owned evidence; never preserve private CLI paths.
        (packet/'artifacts/instructionReader.metafile.json').unlink()
        meta_wire=(p.canonical(normalized)+'\n').encode();p.write_new(packet/'artifacts/instructionReader.metafile.json',meta_wire)
        artifacts={name:packet/'artifacts'/name for name in ('instructionReader','instructionReaderLauncher')}
        bodies,closure=dependency_closure(artifacts,Path(sysroot),packet/'environment')
        for fd,expected in ((compiler_fd,compiler_meta),(base_fd,base_meta),(cc_fd,cc_meta)):
            if p.digest(p.read_fd(fd,p.MAX_ELF))!=expected['sha256']:p.refuse('held tool/base changed')
        receipt={'formatVersion':1,'kind':'winter-reader-compile','inputsSha256':p.digest(read_file(packet/'inputs.json',p.MAX_JSON)),'origins':manifest['origins'],
          'resolverBindings':manifest['resolverBindings'],'compiler':{'version':pin['version'],**compiler_meta},'base':{**pin,'archiveAcquisitionVerified':False},'nativeCompiler':{'version':first,**cc_meta},
          'recipe':{'target':p.BASE['target'],'autoloadFlags':list(p.AUTOLOAD_FLAGS),'environment':p.ENV,'cwd':'stage','outputsExecuted':False},
          'commands':{'bun':['<held-compiler>',*[arg.replace(str(packet),'<packet>') for arg in compile_args]],'nativeCC':['<held-native-cc>',*[arg.replace(str(packet),'<packet>') for arg in native_args]]},'nativeFlags':list(NATIVE_FLAGS),'systemHeaders':headers,'bundledInputs':bundled,'metafileSha256':p.digest(meta_wire),'artifacts':bodies,'runtimeDependencies':closure,
          'dynamicRuntimeImportsVerified':False,'staticMetafileOnly':True,'trustedToolchainVerified':False,'dependencyPackageAttestationVerified':False,'autoloadExecutionVerified':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        p.write_new(packet/'receipt.json',(p.canonical(receipt)+'\n').encode());return receipt
    finally:
        for fd in tools:os.close(fd)
def main():
    parser=argparse.ArgumentParser()
    for name in ('runtime','sdk','overlay','dependencies','compiler','base','cc','sysroot','out'):parser.add_argument('--'+name,required=True,type=Path)
    args=parser.parse_args()
    if platform.system()!='Linux' or platform.machine() not in ('aarch64','arm64'):p.refuse('ordinary Linux ARM64 build required')
    receipt=build(args.runtime,args.sdk,args.overlay,args.dependencies,args.compiler,args.base,args.cc,args.sysroot,args.out)
    print(json.dumps({'compiled':True,'receiptSha256':p.digest(p.canonical(receipt).encode()+b'\n'),'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}))
if __name__=='__main__':main()
