#!/usr/bin/env python3
"""Guided four-role compile packet builder. COMPILE ONLY: it never executes a compiled output, a native artifact or
any downloaded input. Sibling of the reader-only builder (scripts/guest-reader-build), which stays frozen: that
builder's README says it is not a whole guided packet, and its sources, pins and workflows are an accepted, pinned
evidence chain. This builder loads that one's bounded helpers by path (their bytes are observed and captured with the
builder origin) and changes none of them.

Roles (compiled with `bun build --compile`): runtimeEntry, providerWorker, hostClient, instructionReader.
Native artifacts (compiled with `cc`): toolLauncher, runtimeLauncher, fileWorker, processWorker, ownerLibrary,
instructionReaderLauncher. Origins staged: runtime-sdk, agent-sdk, a closed slice of Winter Core, and this builder."""
import argparse,hashlib,io,json,os,platform,stat,sys,tarfile
from pathlib import Path
if os.geteuid()==0:raise SystemExit('unprivileged guided build required before project imports')
HERE=Path(__file__).resolve().parent
OWN_FILES=('pins.py','graph.py','acquire.py','build.py')
def observe_python_sources():
    # Bounded observations only. Python may already have loaded the file or cached code.
    observations={}
    for name in OWN_FILES:
        fd=os.open(HERE/name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            before=os.fstat(fd);limit=16*1024*1024
            if not stat.S_ISREG(before.st_mode) or before.st_size>limit:raise ValueError('bounded Python source observation')
            data=b''
            while True:
                chunk=os.read(fd,min(65536,limit-len(data)+1))
                if not chunk:break
                data+=chunk
                if len(data)>limit:raise ValueError('Python source observation grew')
            key=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
            if key(before)!=key(os.fstat(fd)) or len(data)!=before.st_size:raise ValueError('Python source observation changed')
            observations['scripts/guest-guided-build/'+name]={'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}
        finally:os.close(fd)
    return observations
PYTHON_SOURCE_OBSERVATIONS=observe_python_sources()
import importlib.util
_spec=importlib.util.spec_from_file_location('guided_graph',HERE/'graph.py')
g=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(g)
if observe_python_sources()!=PYTHON_SOURCE_OBSERVATIONS:raise ValueError('Python source observation changed during helper import')
pins,r,p=g.pins,g.reader,g.p
READER_OBSERVATIONS=dict(r.PYTHON_SOURCE_OBSERVATIONS)
Refusal=p.Refusal
CommandFailure=r.CommandFailure
command=r.command

def role_recipe(packet,name):
    role=pins.ROLES[name]
    return ['build','--no-env-file','--config='+str(packet/'stage/empty-bunfig.toml'),'--compile','--reject-unresolved',*p.AUTOLOAD_FLAGS,
      '--target='+pins.BASE['target'],'--compile-executable-path='+str(packet/'stage/linux-bun-base'),'--metafile='+str(packet/'artifacts'/(name+'.metafile.json')),
      str(packet/role['entry']),'--outfile',str(packet/'artifacts'/name)]
def native_argv(packet,name):
    spec=pins.NATIVE[name];source=packet/'source/sdk'/pins.GUEST_DIR/spec['source'];output=packet/'artifacts'/name
    if spec['flags'] is None:
        return [*r.NATIVE_FLAGS,'-I'+str(packet/'source/sdk'/pins.GUEST_DIR),'-MD','-MF',str(packet/'artifacts/native.d'),str(source),'-o',str(output)]
    return [*spec['flags'],'-MD','-MF',str(packet/'artifacts/native.d'),str(source),'-o',str(output)]

def capture_origin(role,path,head,names=None):
    return r.eligible_capture(role,Path(path).resolve(),head,names)
def winter_names(path,head):
    _,entries=p.git_entries(Path(path).resolve(),head)
    names=sorted(name for name in entries if pins.winter_eligible(name))
    if not names:p.refuse('winter closed slice empty')
    return names
def alias_bindings(packet,aliases):
    """aliases: {origin: {bare name: pnpm virtual-store id}} from the pin file. Explicit data, never a version search."""
    if type(aliases)!=dict or set(aliases)-set(pins.ALIAS_ORIGINS) or any(type(v)!=dict for v in aliases.values()):p.refuse('third-party alias map')
    if sum(len(v) for v in aliases.values())>128:p.refuse('third-party alias count')
    bindings={};sdk=packet/'source/sdk'
    def link(origin,package,directory,binding):
        alias=packet/'source'/origin/'node_modules'/package;alias.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        target=os.path.relpath(directory,alias.parent);alias.symlink_to(target)
        bindings[str(alias.relative_to(packet))]={'target':target,'package':package,**binding}
    for name,folder in p.SDK_PACKAGES.items():
        package='@yanlinglabs/'+name;manifest=sdk/'packages'/folder/'package.json';value=r.json_data(r.read_file(manifest,p.MAX_JSON))
        if value.get('name')!=package or value.get('version')!=pins.SDK_FAMILY_VERSION:p.refuse('candidate SDK package identity')
        exports=value.get('exports',{}).get('.',{})
        if not isinstance(exports,dict) or exports.get('bun')!='./src/index.ts':p.refuse('candidate SDK source export')
        for origin in pins.ALIAS_ORIGINS:link(origin,package,manifest.parent,{'origin':'sdk','version':pins.SDK_FAMILY_VERSION})
    for package,folder in pins.WORKSPACE_PACKAGE.items():
        manifest=packet/'source/winter'/folder/'package.json';value=r.json_data(r.read_file(manifest,p.MAX_JSON))
        if value.get('name')!=package or type(value.get('version'))!=str or value.get('exports')!={'.':'./src/index.ts'}:p.refuse('Winter workspace package identity')
        link('winter',package,manifest.parent,{'origin':'winter','version':value['version']})
    for origin,mapping in sorted(aliases.items()):
        for name,identifier in sorted(mapping.items()):
            if r.package_name(name)!=name or name.startswith('@yanlinglabs/winter-') or identifier.rpartition('@')[0]!=name:p.refuse('foreign SDK peer binding')
            directory=packet/'dependencies/.pnpm'/pins.package_directory(identifier)/'node_modules'/name
            value=r.json_data(r.read_file(directory/'package.json',p.MAX_JSON))
            if type(value)!=dict or value.get('name')!=name or value.get('version')!=identifier.rpartition('@')[2]:p.refuse('third-party package identity')
            link(origin,name,directory,{'origin':'dependencies','version':value['version'],'id':identifier})
    return bindings

ROLE_SOURCE_FILES=tuple(sorted({name for role in pins.ROLES.values() for name in (role['entry'],*role['required'])}))

def prepare_packet(runtime,sdk,winter,dependencies,output,heads=None,trees=None,builder_root=None,builder_head=None,aliases=None):
    heads=pins.HEADS if heads is None else heads
    trees=pins.TREES if trees is None else trees
    builder_root=Path(builder_root) if builder_root is not None else HERE.parents[1]
    aliases=pins.ALIASES if aliases is None else aliases
    if type(aliases)!=dict:p.refuse('third-party alias map required')
    builder_head=builder_head or heads.get('builder')
    if builder_head is None:p.refuse('externally pinned builder head required')
    if set(heads)-{'runtime','sdk','winter','builder'} or not {'runtime','sdk','winter'}<=set(heads):p.refuse('origin head set')
    output=Path(output)
    r.refuse_ancestor_config(output)
    if not output.is_absolute() or output.exists() or output.parent.resolve()!=output.parent:p.refuse('new canonical packet directory')
    builder_names=list(pins.BUILDER_FILES)
    plan=[('runtime',runtime,None),('sdk',sdk,None),('winter',winter,winter_names(winter,heads['winter'])),('builder',builder_root,builder_names)]
    records=[];held=[];depfd=None
    try:
        for role,path,names in plan:
            record,fd,entries,eligible=capture_origin(role,path,builder_head if role=='builder' else heads[role],names);records.append(record);held.append((fd,entries,eligible))
            if role in trees and record['tree']!=trees[role]:p.refuse('origin tree differs from its pin')
        observed={**PYTHON_SOURCE_OBSERVATIONS,**READER_OBSERVATIONS}
        for name,observation in observed.items():
            if records[3]['eligibleFiles'].get(name)!={'kind':'file',**observation}:p.refuse('captured builder differs from Python source observation')
        if p.READER_ENTRY not in records[0]['eligibleFiles']:p.refuse('actual private reader entry missing')
        index={'runtime':0,'sdk':1,'winter':2,'builder':3}
        for name in ROLE_SOURCE_FILES:
            _,origin,inner=name.split('/',2)
            if inner not in records[index[origin]]['eligibleFiles']:p.refuse('required role source missing')
        for name in NATIVE_SOURCE_FILES:
            if name not in records[1]['eligibleFiles']:p.refuse('required native source missing')
        depfd=p.root_fd(Path(dependencies));depmanifest=p.inventory(depfd)
        if any('@yanlinglabs+winter-' in name or '@yanlinglabs/winter-' in name for name in depmanifest):p.refuse('published SDK peers in dependency store')
        output.mkdir(mode=0o700);(output/'source').mkdir(mode=0o700)
        for record,(fd,_,_) in zip(records,held):p.copy_inventory(fd,record['eligibleFiles'],output/'source'/record['role'])
        p.copy_inventory(depfd,depmanifest,output/'dependencies')
        for record,(fd,entries,eligible),path in zip(records,held,(runtime,sdk,winter,builder_root)):
            if p.git(path,'rev-parse','HEAD').decode().strip()!=record['checkoutHead']:p.refuse('origin checkout head changed')
            if p.git_entries(path,record['head'])!=(record['tree'],entries):p.refuse('origin Git tree changed')
            if p.source_inventory(fd,entries,eligible)!=record['eligibleFiles']:p.refuse('origin changed during copy')
        if p.inventory(depfd)!=depmanifest:p.refuse('dependencies changed during copy')
        bindings=alias_bindings(output,aliases)
        staged=r.snapshot(output)
        for path,binding in bindings.items():
            if staged.get(path)!={'kind':'symlink','target':binding['target']}:p.refuse('resolver binding changed')
        manifest={'formatVersion':1,'kind':'winter-guided-inputs','origins':records,'dependencies':depmanifest,'resolverBindings':bindings,'stagedInputs':staged,
          'pythonSourceObservations':observed,'executedPythonSourceAuthenticated':False,'bareReferencesPendingMetafile':True,
          'thirdPartyAliasMapSha256':p.digest(p.canonical(aliases).encode()),'stagedInventorySha256':p.digest(p.canonical(staged).encode()),
          'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        p.write_new(output/'inputs.json',(p.canonical(manifest)+'\n').encode())
        return manifest
    finally:
        for fd,_,_ in held:os.close(fd)
        if depfd is not None:os.close(depfd)

NATIVE_SOURCE_FILES=tuple('packages/runtime/src/guest/'+spec['source'] for spec in pins.NATIVE.values())

def build(runtime,sdk,winter,dependencies,compiler,base,cc,sysroot,output,runner=command,heads=None,trees=None,base_pin=None,builder_root=None,builder_head=None,aliases=None):
    """runner injection permits portable refusal tests; the CLI never replaces the runner or the pins."""
    manifest=prepare_packet(runtime,sdk,winter,dependencies,output,heads,trees,builder_root,builder_head,aliases);packet=Path(output);pin=base_pin or pins.BASE
    for name in ('stage','artifacts'):(packet/name).mkdir(mode=0o700)
    p.write_new(packet/'stage/empty-bunfig.toml',b'')
    tools=[]
    try:
        compiler_fd,compiler_meta=r.file_input(Path(compiler),p.MAX_ELF);tools.append(compiler_fd)
        base_fd,base_meta=r.file_input(Path(base),p.MAX_ELF);tools.append(base_fd)
        cc_fd,cc_meta=r.file_input(Path(cc),p.MAX_ELF);tools.append(cc_fd)
        if base_meta['sha256']!=pin['executableSha256'] or compiler_meta['sha256']!=pin['executableSha256']:p.refuse('pinned Linux compiler/base')
        p.write_new(packet/'stage/linux-bun-base',p.read_fd(base_fd,p.MAX_ELF),True)
        r.check_inputs(packet,manifest)
        version,_=runner(['/proc/self/fd/'+str(compiler_fd),'--version'],packet/'stage',30,(compiler_fd,))
        if version.strip()!=pin['version'].encode():p.refuse('Bun version changed')
        cc_version,_=runner(['/proc/self/fd/'+str(cc_fd),'--version'],packet/'stage',30,(cc_fd,))
        first=cc_version.decode('utf8').splitlines()[0]
        if len(first.encode())>512 or '/' in first:p.refuse('native compiler version bound')
        if role_recipe(packet,'instructionReader')!=r.compiler_recipe(packet):p.refuse('reader role recipe differs from the accepted reader recipe')
        semantic_evidence=r.compiler_semantic_evidence(runner,compiler_fd,base_fd,packet,r.compiler_recipe(packet))
        commands={'bun':{},'native':{}};embedded={}
        for name in pins.ROLE_NAMES:
            args=role_recipe(packet,name)
            runner(['/proc/self/fd/'+str(compiler_fd),*args],packet/'stage',120,(compiler_fd,))
            fd,_=r.file_input(packet/'artifacts'/name,p.MAX_ELF)
            try:flags=p.standalone_flags(fd,base_fd)
            finally:os.close(fd)
            if flags['flagsNibble']!=15 or flags['payload']['compileExecArgvBytes']!=0:p.refuse('role embedded autoload flags')
            embedded[name]=flags;commands['bun'][name]=['<held-compiler>',*[arg.replace(str(packet),'<packet>') for arg in args]]
        headers={}
        for name in pins.NATIVE_NAMES:
            argv=native_argv(packet,name)
            runner(['/proc/self/fd/'+str(cc_fd),*argv],packet/'stage',120,(cc_fd,))
            headers=r.merge_headers(headers,r.header_observations(packet,sysroot,r.read_file(packet/'artifacts/native.d',p.MAX_JSON)))
            (packet/'artifacts/native.d').unlink()
            commands['native'][name]=['<held-native-cc>',*[arg.replace(str(packet),'<packet>') for arg in argv]]
        r.check_inputs(packet,manifest)
        graphs={};bundled_all={};used_all=set()
        for name in pins.ROLE_NAMES:
            raw=packet/'artifacts'/(name+'.metafile.json')
            normalized,bundled=g.normalized_metafile(r.json_data(r.read_file(raw,p.MAX_JSON)),packet,manifest,pins.ROLES[name])
            evidence,used=g.graph_evidence(normalized,packet,manifest);used_all|=used
            raw.unlink();wire=r.write_wire(raw,normalized,packet)
            graphs[name]={'reachableGraph':evidence,'bundledInputs':bundled,'metafileSha256':p.digest(wire)};bundled_all[name]=bundled
        required={alias for alias,binding in manifest['resolverBindings'].items() if binding['origin']=='dependencies'}
        if used_all!=required:p.refuse('unused third-party resolver binding')
        artifacts={name:packet/'artifacts'/name for name in pins.ARTIFACT_NAMES}
        bodies,closure=r.dependency_closure(artifacts,Path(sysroot),packet/'environment')
        if p.digest(r.read_file(packet/'stage/linux-bun-base',p.MAX_ELF))!=base_meta['sha256']:p.refuse('staged base changed')
        for name in pins.ROLE_NAMES:
            if embedded[name]['outputSha256']!=bodies[name]['sha256'] or embedded[name]['baseSha256']!=base_meta['sha256']:p.refuse('role decoded hash mismatch')
        for fd,expected in ((compiler_fd,compiler_meta),(base_fd,base_meta),(cc_fd,cc_meta)):
            if p.digest(p.read_fd(fd,p.MAX_ELF))!=expected['sha256']:p.refuse('held tool/base changed')
        receipt={'formatVersion':1,'kind':'winter-guided-compile','inputsSha256':p.digest(r.read_file(packet/'inputs.json',p.MAX_JSON)),'origins':manifest['origins'],
          'resolverBindings':manifest['resolverBindings'],'pythonSourceObservations':manifest['pythonSourceObservations'],'executedPythonSourceAuthenticated':False,
          'roles':{name:{'entry':pins.ROLES[name]['entry'],**graphs[name],'embedded':embedded[name]} for name in pins.ROLE_NAMES},
          'compilerSemanticEvidence':semantic_evidence,'compiler':{'version':pin['version'],**compiler_meta},'base':{**pin,'archiveAcquisitionVerified':False},'nativeCompiler':{'version':first,**cc_meta},
          'recipe':{'target':pins.BASE['target'],'autoloadFlags':list(p.AUTOLOAD_FLAGS),'environment':p.ENV,'cwd':'stage','outputsExecuted':False},
          'commands':commands,'nativeFlagsReaderLauncher':list(r.NATIVE_FLAGS),'systemHeaders':headers,'artifacts':bodies,'dependencyClosure':closure,
          'dynamicRuntimeImportsVerified':False,'globalBunConfigurationExecutionVerified':False,'staticMetafileOnly':True,'trustedToolchainVerified':False,'dependencyPackageAttestationVerified':False,
          'autoloadExecutionVerified':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        r.write_wire(packet/'receipt.json',receipt,packet);return receipt
    finally:
        for fd in tools:os.close(fd)

def archive_packet(packet,archive_dir,builder_head,workflow_head):
    """Closed tar.gz of the packet plus a fresh inventory. Nothing is executed; the size bound is the pin file's."""
    packet=Path(packet);archive_dir=Path(archive_dir);inventory={};total=0;visits=0
    root=p.root_fd(packet)
    def walk(fd,prefix='',depth=0):
        nonlocal total,visits
        if depth>64:p.refuse('packet depth')
        with os.scandir(fd) as entries:
            for entry in entries:
                visits+=1
                if visits>3*pins.MAX_PACKET_ENTRIES or len(inventory)>=pins.MAX_PACKET_ENTRIES:p.refuse('packet count')
                name=p.relative(prefix+entry.name)
                if name=='artifacts/native.d':continue
                info=entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                    try:
                        if p.identity(info)!=p.identity(os.fstat(child)):p.refuse('packet directory changed')
                        walk(child,name+'/',depth+1)
                    finally:os.close(child)
                elif stat.S_ISLNK(info.st_mode):inventory[name]={'kind':'symlink','target':os.readlink(entry.name,dir_fd=fd)}
                elif stat.S_ISREG(info.st_mode):
                    file=p.leaf(root,name)
                    try:data=p.read_fd(file,p.MAX_ELF)
                    finally:os.close(file)
                    total+=len(data)
                    if total>pins.MAX_PACKET_BYTES:p.refuse('packet bytes')
                    inventory[name]={'kind':'file','sha256':p.digest(data),'bytes':len(data)}
                else:p.refuse('packet special file')
    try:
        walk(root);p.validate_links(inventory)
        archive=archive_dir/'guided-packet.tar.gz'
        output=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
        with os.fdopen(output,'wb') as wire,tarfile.open(fileobj=wire,mode='w:gz',format=tarfile.PAX_FORMAT) as tar:
            for name,item in sorted(inventory.items()):
                record=tarfile.TarInfo(name);record.uid=record.gid=0;record.mtime=0
                if item['kind']=='symlink':record.type=tarfile.SYMTYPE;record.linkname=item['target'];record.mode=0o777;tar.addfile(record)
                else:
                    file=p.leaf(root,name)
                    with os.fdopen(file,'rb') as incoming:
                        data=p.read_fd(incoming.fileno(),p.MAX_ELF)
                        if p.digest(data)!=item['sha256']:p.refuse('packet leaf changed')
                        record.size=len(data);record.mode=0o400;tar.addfile(record,io.BytesIO(data))
    finally:os.close(root)
    with archive.open('rb') as incoming:archive_hash=hashlib.file_digest(incoming,'sha256').hexdigest()
    evidence={'formatVersion':1,'kind':'winter-guided-compile-packet','builderHead':builder_head,'workflowHead':workflow_head,'excludedScratch':['artifacts/native.d'],
      'files':inventory,'fileCount':len(inventory),'fileBytes':total,'archiveSha256':archive_hash,'archiveBytes':archive.stat().st_size,
      'outputsExecuted':False,'nativeAdmission':False,'vmExecutionVerified':False,'activationEnabled':False}
    with (archive_dir/'packet-inventory.json').open('x') as target:json.dump(evidence,target,sort_keys=True,separators=(',',':'));target.write('\n')
    return evidence

def main():
    parser=argparse.ArgumentParser()
    for name in ('runtime','sdk','winter','dependencies','compiler','base','cc','sysroot','out','archive-dir','acquisition'):parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--builder-head',required=True)
    parser.add_argument('--workflow-head',required=True)
    args=parser.parse_args()
    if platform.system()!='Linux' or platform.machine() not in ('aarch64','arm64'):p.refuse('ordinary Linux ARM64 build required')
    receipt=build(args.runtime,args.sdk,args.winter,args.dependencies,args.compiler,args.base,args.cc,args.sysroot,args.out,builder_head=args.builder_head)
    # The acquisition record is a measurement made before the build; it joins the packet before the archive is cut.
    p.write_new(args.out/'compiler-acquisition.json',r.read_file(args.acquisition,p.MAX_JSON))
    archive=archive_packet(args.out,args.archive_dir,args.builder_head,args.workflow_head)
    print(json.dumps({'compiled':True,'receiptSha256':p.digest(p.canonical(receipt).encode()+b'\n'),'archiveSha256':archive['archiveSha256'],'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}))
if __name__=='__main__':main()
