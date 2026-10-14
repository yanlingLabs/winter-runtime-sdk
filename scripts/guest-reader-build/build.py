#!/usr/bin/env python3
"""New reader-only, multi-origin compilation packet. Never executes outputs."""
import argparse,hashlib,importlib.util,json,os,platform,re,selectors,shlex,signal,stat,subprocess,time
from pathlib import Path
if os.geteuid()==0:raise SystemExit('unprivileged reader build required before project imports')
def observe_python_sources():
    # Bounded observations only. Python may already have loaded build.py or cached code.
    observations={}
    for name in ('build.py','provenance.py'):
        path=Path(__file__).resolve().with_name(name)
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            before=os.fstat(fd);chunks=[];size=0;limit=16*1024*1024
            if not stat.S_ISREG(before.st_mode) or before.st_size>limit:raise ValueError('bounded Python source observation')
            while True:
                data=os.read(fd,min(65536,limit-size+1))
                if not data:break
                size+=len(data)
                if size>limit:raise ValueError('Python source observation grew')
                chunks.append(data)
            after=os.fstat(fd)
            key=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
            if key(before)!=key(after) or size!=before.st_size:raise ValueError('Python source observation changed')
            observations['scripts/guest-reader-build/'+name]={'sha256':hashlib.sha256(b''.join(chunks)).hexdigest(),'bytes':size}
        finally:os.close(fd)
    return observations
PYTHON_SOURCE_OBSERVATIONS=observe_python_sources()
_spec=importlib.util.spec_from_file_location('reader_provenance',Path(__file__).with_name('provenance.py'))
p=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(p)
if observe_python_sources()!=PYTHON_SOURCE_OBSERVATIONS:raise ValueError('Python source observation changed during helper import')

MAX_OUTPUT=16*1024*1024
NATIVE_FLAGS=('-O2','-std=gnu11','-Wall','-Wextra','-Werror','-D_FORTIFY_SOURCE=2','-fstack-protector-strong','-fPIE','-pie','-Wl,-z,relro,-z,now,-z,noexecstack')
class CommandFailure(p.Refusal):
    def __init__(self,code,stdout,stderr):
        super().__init__('compiler refused');self.code=code;self.stdout=stdout;self.stderr=stderr
def command(argv,cwd,timeout=120,pass_fds=()):
    """No output command. Failure kills the unreaped owned group before bounded wait."""
    proc=subprocess.Popen(argv,cwd=cwd,env=p.ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=pass_fds,start_new_session=True)
    poll=None;chunks={};failed=True;leader_reaped=False
    try:
        poll=selectors.DefaultSelector();deadline=time.monotonic()+timeout;total=0
        for stream in (proc.stdout,proc.stderr):
            os.set_blocking(stream.fileno(),False);poll.register(stream,selectors.EVENT_READ);chunks[stream.fileno()]=bytearray()
        while poll.get_map():
            if time.monotonic()>=deadline:p.refuse('compiler timeout')
            for key,_ in poll.select(min(.1,max(0,deadline-time.monotonic()))):
                data=os.read(key.fd,65536)
                if not data:poll.unregister(key.fileobj);continue
                total+=len(data)
                if total>MAX_OUTPUT:p.refuse('compiler output bound')
                chunks[key.fd].extend(data)
        try:code=proc.wait(timeout=max(.001,deadline-time.monotonic()))
        except subprocess.TimeoutExpired:p.refuse('compiler wait timeout')
        leader_reaped=True
        stdout=bytes(chunks[proc.stdout.fileno()]);stderr=bytes(chunks[proc.stderr.fileno()])
        if code:raise CommandFailure(code,stdout,stderr)
        failed=False;return stdout,stderr
    finally:
        try:
            if failed and not leader_reaped:
                try:os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                finally:
                    try:proc.wait(timeout=1)
                    except Exception:p.refuse('compiler cleanup reap uncertain')
        finally:
            try:
                if poll is not None:poll.close()
            finally:
                try:proc.stdout.close()
                finally:proc.stderr.close()
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
def resolver_map_file(path):
    value=json_data(read_file(path,p.MAX_JSON))
    if type(value)!=dict:p.refuse('plain third-party resolver map required')
    return value
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
    return {'role':role,'head':head,'checkoutHead':p.git(path,'rev-parse','HEAD').decode().strip(),'tree':tree,'eligibleFiles':manifest,'inventorySha256':p.digest(p.canonical(manifest).encode())},fd,entries,names
BUILDER_FILES=['scripts/guest-reader-build/'+name for name in ('build.py','provenance.py','test_provenance.py','README.md')]
NODE_BUILTINS=frozenset(('assert','buffer','child_process','cluster','console','constants','crypto','dgram','diagnostics_channel','dns','domain','events','fs','http','http2','https','module','net','os','path','perf_hooks','process','punycode','querystring','readline','repl','stream','string_decoder','sys','timers','tls','trace_events','tty','url','util','v8','vm','wasi','worker_threads','zlib'))
def package_name(specifier):
    if specifier.startswith(('.', '/')) or ':' in specifier:return None
    parts=specifier.split('/');name='/'.join(parts[:2]) if specifier.startswith('@') else parts[0]
    if not re.fullmatch(r'(?:@[a-zA-Z0-9_.-]+/)?[a-zA-Z0-9_.-]+',name):p.refuse('bare package name')
    if name in NODE_BUILTINS:return None
    return name
def alias_bindings(packet,records,resolver_map):
    if type(resolver_map)!=dict:p.refuse('third-party resolver map')
    if len(resolver_map)>128:p.refuse('third-party resolver count')
    bindings={};sdk=packet/'source/sdk'
    for name,folder in p.SDK_PACKAGES.items():
        package='@yanlinglabs/'+name
        manifest=sdk/'packages'/folder/'package.json';value=json_data(read_file(manifest,p.MAX_JSON))
        if value.get('name')!=package or value.get('version')!='0.0.53':p.refuse('candidate SDK package identity')
        exports=value.get('exports',{}).get('.',{})
        if not isinstance(exports,dict) or exports.get('bun')!='./src/index.ts':p.refuse('candidate SDK source export')
        for origin in ('sdk','runtime'):
            alias=packet/'source'/origin/'node_modules/@yanlinglabs'/name;alias.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            link=os.path.relpath(manifest.parent,alias.parent);alias.symlink_to(link)
            bindings[str(alias.relative_to(packet))]={'target':link,'package':package,'origin':'sdk','version':'0.0.53'}
    # No inferred version selection. Each required third-party binding is explicitly supplied.
    for name,target in sorted(resolver_map.items()):
        if package_name(name)!=name or name.startswith('@yanlinglabs/winter-'):p.refuse('foreign SDK peer binding')
        target=p.relative(target);directory=packet/'dependencies'/target
        value=json_data(read_file(directory/'package.json',p.MAX_JSON))
        if type(value)!=dict or value.get('name')!=name or type(value.get('version'))!=str:p.refuse('third-party package identity')
        for origin in ('sdk','runtime'):
            alias=packet/'source'/origin/'node_modules'/name;alias.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            link=os.path.relpath(directory,alias.parent);alias.symlink_to(link)
            bindings[str(alias.relative_to(packet))]={'target':link,'package':name,'origin':'dependencies','version':value['version']}
    dependency_fd=p.root_fd(packet/'dependencies')
    try:
        with os.scandir(dependency_fd) as entries:has_dependencies=next(entries,None) is not None
    finally:os.close(dependency_fd)
    if has_dependencies:
        for origin in ('sdk','runtime'):
            alias=packet/'source'/origin/'node_modules/.pnpm';alias.symlink_to(os.path.relpath(packet/'dependencies',alias.parent))
    return bindings
def refuse_ancestor_config(packet):
    # Resolver traversal cannot borrow a parent package/config or node_modules tree.
    for directory in Path(packet).parents:
        fd=p.root_fd(directory);scan=None
        try:
            scan=os.scandir(fd);count=0
            for entry in scan:
                count+=1
                if count>p.MAX_ENTRIES*3:p.refuse('ancestor inventory bound')
                name=entry.name
                if name in ('node_modules','package.json','jsconfig.json','bunfig.toml','.env') or (name.startswith('tsconfig') and name.endswith('.json')):p.refuse('ancestor resolver/config present')
        finally:
            if scan is not None:scan.close()
            os.close(fd)
def snapshot(packet,inputs_only=False):
    fd=p.root_fd(Path(packet).resolve())
    try:return p.inventory(fd,('source','dependencies') if inputs_only else None)
    finally:os.close(fd)
def prepare_packet(runtime,sdk,overlay,dependencies,output,heads=None,builder_root=None,builder_head=None,resolver_map=None):
    heads=heads or {'runtime':p.RUNTIME_HEAD,'sdk':p.SDK_HEAD,'overlay':p.OVERLAY_HEAD}
    builder_root=Path(builder_root) if builder_root is not None else Path(__file__).resolve().parents[2]
    if resolver_map is None:resolver_map={}
    if type(resolver_map)!=dict:p.refuse('plain third-party resolver map required')
    builder_head=builder_head or heads.get('builder')
    if builder_head is None:p.refuse('externally pinned builder head required')
    output=Path(output)
    refuse_ancestor_config(output)
    if not output.is_absolute() or output.exists() or output.parent.resolve()!=output.parent:p.refuse('new canonical packet directory')
    records=[];held=[];depfd=None
    try:
        for role,path,names in [('runtime',runtime,None),('sdk',sdk,None),('overlay',overlay,[p.C_SOURCE,p.HEADER]),('builder',builder_root,BUILDER_FILES)]:
            record,fd,entries,eligible=eligible_capture(role,Path(path).resolve(),builder_head if role=='builder' else heads[role],names);records.append(record);held.append((fd,entries,eligible))
        for name,observation in PYTHON_SOURCE_OBSERVATIONS.items():
            if records[3]['eligibleFiles'].get(name)!={'kind':'file',**observation}:p.refuse('captured builder differs from Python source observation')
        sdk_header=records[1]['eligibleFiles'].get(p.HEADER);overlay_header=records[2]['eligibleFiles'][p.HEADER]
        if sdk_header!=overlay_header:p.refuse('SDK overlay header differs from main')
        if p.READER_ENTRY not in records[0]['eligibleFiles']:p.refuse('actual private reader entry missing')
        depfd=p.root_fd(Path(dependencies));depmanifest=p.inventory(depfd)
        if any('@yanlinglabs+winter-' in name or '@yanlinglabs/winter-' in name for name in depmanifest):p.refuse('published SDK peers in dependency store')
        output.mkdir(mode=0o700);(output/'source').mkdir(mode=0o700)
        for record,(fd,_,_) in zip(records,held):p.copy_inventory(fd,record['eligibleFiles'],output/'source'/record['role'])
        p.copy_inventory(depfd,depmanifest,output/'dependencies')
        for record,(fd,entries,eligible),path in zip(records,held,(runtime,sdk,overlay,builder_root)):
            if p.git(path,'rev-parse','HEAD').decode().strip()!=record['checkoutHead']:p.refuse('origin checkout head changed')
            if p.git_entries(path,record['head'])!=(record['tree'],entries):p.refuse('origin Git tree changed')
            if p.source_inventory(fd,entries,eligible)!=record['eligibleFiles']:p.refuse('origin changed during copy')
        if p.inventory(depfd)!=depmanifest:p.refuse('dependencies changed during copy')
        bindings=alias_bindings(output,records,resolver_map)
        # Resolve the full staged graph, including origin-crossing aliases, before compilation.
        staged=snapshot(output)
        for path,binding in bindings.items():
            if staged.get(path)!={'kind':'symlink','target':binding['target']}:p.refuse('resolver binding changed')
        manifest={'formatVersion':1,'kind':'winter-reader-inputs','origins':records,'dependencies':depmanifest,'resolverBindings':bindings,'stagedInputs':staged,
          'pythonSourceObservations':PYTHON_SOURCE_OBSERVATIONS,'executedPythonSourceAuthenticated':False,'bareReferencesPendingMetafile':True,'thirdPartyResolverMapSha256':p.digest(p.canonical(resolver_map).encode()),'stagedInventorySha256':p.digest(p.canonical(staged).encode()),'dependencyInstallationPerformed':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        p.write_new(output/'inputs.json',(p.canonical(manifest)+'\n').encode())
        return manifest
    finally:
        for fd,_,_ in held:os.close(fd)
        if depfd is not None:os.close(depfd)
def check_inputs(packet,manifest):
    refuse_ancestor_config(packet)
    if read_file(Path(packet)/'inputs.json',p.MAX_JSON)!=(p.canonical(manifest)+'\n').encode():p.refuse('input manifest changed')
    actual=snapshot(packet,True)
    expected=manifest['stagedInputs']
    # inputs.json and output work directories are not compiler source inputs.
    actual={name:value for name,value in actual.items() if name.startswith(('source/','dependencies/'))}
    if actual!=expected:p.refuse('staged bytes/resolver changed')
    for alias,binding in manifest['resolverBindings'].items():
        if actual.get(alias)!={'kind':'symlink','target':binding['target']}:p.refuse('candidate resolver changed')
def manifest_target(text,packet,measured,base='stage'):
    if type(text)!=str or not text or len(text.encode())>4096:p.refuse('metafile path scalar')
    if text.startswith('/'):
        path=Path(text)
        if not path.is_relative_to(packet):p.refuse('metafile path outside packet')
        relative=path.relative_to(packet).as_posix()
    else:relative=base+'/'+text
    # Pure manifest graph; never look up an unmeasured filesystem fallback.
    return p.resolved_link('metafile-anchor',relative,measured)
def normalized_metafile(data,packet,manifest):
    if type(data)!=dict or type(data.get('inputs'))!=dict or not 1<=len(data['inputs'])<=p.MAX_ENTRIES:p.refuse('metafile shape')
    measured=manifest['stagedInputs'];mapped={};bundled=set()
    for raw,info in data['inputs'].items():
        if type(raw)!=str or type(info)!=dict or type(info.get('bytes'))!=int:p.refuse('metafile input record')
        relative=manifest_target(raw,packet,measured)
        if measured.get(relative,{}).get('kind')!='file' or measured[relative]['bytes']!=info['bytes']:p.refuse('metafile input outside capture')
        if ('0.0.28' in relative) or ('/dist/' in relative and relative.startswith('source/sdk/packages/')):p.refuse('old/unmeasured SDK emit')
        if relative.startswith('dependencies/') and '@yanlinglabs' in relative:p.refuse('published peer resolver')
        mapped[raw]=relative;bundled.add(relative)
    entry='source/runtime/'+p.READER_ENTRY
    if entry not in bundled:p.refuse('reader entry missing from graph')
    if not any(name.startswith('source/sdk/packages/sdk/') for name in bundled):p.refuse('actual candidate SDK peer absent')
    def remap(value):
        if isinstance(value,str):
            if value in mapped:return mapped[value]
            if value.startswith('/'):
                path=Path(value)
                if not path.is_relative_to(packet):p.refuse('private absolute metafile path')
                return '<packet>/'+path.relative_to(packet).as_posix()
            return value
        if isinstance(value,list):return [remap(item) for item in value]
        if isinstance(value,dict):return {remap(key):remap(item) for key,item in value.items()}
        return value
    normalized=remap(data);normalized_inputs={};edge_count=0
    for raw,info in data['inputs'].items():
        record=remap(info);imports=info.get('imports',[])
        if type(imports)!=list:p.refuse('metafile import list')
        normalized_imports=[]
        for item in imports:
            edge_count+=1
            if edge_count>p.MAX_ENTRIES or type(item)!=dict or type(item.get('path'))!=str or type(item.get('external',False))!=bool:p.refuse('metafile import record')
            copy=remap(item)
            # Original spelling is evidence; it must not be treated as a filesystem path.
            if 'original' in item:copy['original']=item['original']
            if not item.get('external',False):
                target=item['path']
                if target.startswith('/'):
                    resolved=manifest_target(target,packet,measured)
                elif target.startswith(('./','../')):
                    resolved=manifest_target(target,packet,measured,str(Path(mapped[raw]).parent))
                elif target in mapped:resolved=mapped[target]
                else:p.refuse('unsupported metafile import spelling')
                if resolved not in bundled:p.refuse('outside/non-bundled import target')
                copy['path']=resolved
            normalized_imports.append(copy)
        record['imports']=normalized_imports
        if mapped[raw] in normalized_inputs:p.refuse('duplicate canonical metafile input')
        normalized_inputs[mapped[raw]]=record
    normalized['inputs']=normalized_inputs
    return normalized,{name:measured[name] for name in sorted(bundled)}
def unknown_flag_probe(runner,compiler_fd,packet,recipe):
    negative=packet/'stage/negative';negative.mkdir(mode=0o700);bogus='--winter-reader-build-option-must-refuse'
    args=[arg.replace(str(packet/'artifacts'),str(negative)) for arg in recipe]+[bogus]
    try:runner(['/proc/self/fd/'+str(compiler_fd),*args],packet/'stage',120,(compiler_fd,))
    except CommandFailure as failure:
        # An argv echo or unrelated compiler error cannot satisfy this attribution.
        pattern=re.compile(r"(?:error: )?(?:unknown|unrecognized|unsupported|invalid|unexpected) (?:command.line )?(?:flag|option|argument)(?:[: =]+|\s+)[\"'`]?"+re.escape(bogus)+r"[\"'`]?\.?",re.IGNORECASE)
        lines=failure.stderr.decode('utf8').splitlines()
        matches=[line for line in lines if len(line.encode())<=512 and pattern.fullmatch(line.strip())]
        if failure.code!=1 or len(matches)!=1:p.refuse('unknown flag refusal mismatch')
        negative_fd=p.root_fd(negative)
        try:
            with os.scandir(negative_fd) as entries:
                if next(entries,None) is not None:p.refuse('unknown flag created output')
        finally:os.close(negative_fd)
        return {'exitCode':failure.code,'diagnosticClass':'unique_unknown_flag','stdoutSha256':p.digest(failure.stdout),'stdoutBytes':len(failure.stdout),'stderrSha256':p.digest(failure.stderr),'stderrBytes':len(failure.stderr),'outputCreated':False,'receiptCreated':False}
    p.refuse('unknown flag was accepted')
def graph_evidence(metafile,packet,manifest):
    measured=manifest['stagedInputs'];references=[];edges=[];used=set();missing_original=0
    bound=0
    for source,info in metafile['inputs'].items():
        imports=info.get('imports',[])
        if type(imports)!=list:p.refuse('metafile import list')
        for item in imports:
            bound+=1
            if bound>p.MAX_ENTRIES:p.refuse('metafile import count')
            if type(item)!=dict or type(item.get('kind'))!=str or type(item.get('path'))!=str or type(item.get('external',False))!=bool:p.refuse('metafile import record')
            if len(item['kind'].encode())>128 or len(item['path'].encode())>4096:p.refuse('metafile import scalar bound')
            target=item['path'];external=item.get('external',False);original=item.get('original')
            if original is not None and (type(original)!=str or not original or len(original.encode())>4096):p.refuse('metafile original specifier')
            if original is None:missing_original+=1
            if external:
                builtin=target.removeprefix('node:').split('/')[0]
                if target!='bun' and builtin not in NODE_BUILTINS:p.refuse('unresolved/non-builtin external')
                if original is not None and not (original=='bun' or original.startswith('node:') or original.split('/')[0] in NODE_BUILTINS):p.refuse('external bare mismatch')
            elif target not in measured or measured[target]['kind']!='file':p.refuse('unmeasured metafile import target')
            edges.append({'source':source,'kind':item['kind'],'target':target,'external':external})
            if original is not None and not original.startswith(('.', '/')):
                references.append({'source':source,'sourceSha256':measured[source]['sha256'],'specifier':original,'target':target,'kind':item['kind'],'external':external})
    # The exact top-level third-party aliases must actually contribute reachable inputs.
    for alias,binding in manifest['resolverBindings'].items():
        if binding['origin']!='dependencies':continue
        target=(packet/alias).resolve().relative_to(packet).as_posix()
        if any(name.startswith(target+'/') for name in metafile['inputs']):used.add(binding['package'])
    required={binding['package'] for binding in manifest['resolverBindings'].values() if binding['origin']=='dependencies'}
    if used!=required:p.refuse('unused third-party resolver binding')
    return {'edges':edges,'bareReferences':references,'missingOriginalCount':missing_original,'staticMetafileOnly':True,'dynamicRuntimeImportsVerified':False}
def compiler_recipe(packet):
    return ['build','--no-env-file','--config='+str(packet/'stage/empty-bunfig.toml'),'--compile','--reject-unresolved',*p.AUTOLOAD_FLAGS,
      '--target='+p.BASE['target'],'--compile-executable-path='+str(packet/'stage/linux-bun-base'),'--metafile='+str(packet/'artifacts/instructionReader.metafile.json'),
      str(packet/'source/runtime'/p.READER_ENTRY),'--outfile',str(packet/'artifacts/instructionReader')]
def dependency_closure(artifacts,sysroot,destination):
    sysroot=Path(sysroot)
    if sysroot.resolve()!=sysroot:p.refuse('canonical sysroot')
    fd=p.root_fd(sysroot)
    try:return _dependency_closure(artifacts,sysroot,destination,fd)
    finally:os.close(fd)
def _dependency_closure(artifacts,sysroot,destination,sysroot_fd):
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
            fd=None
            for prefix in ('lib/aarch64-linux-gnu/','usr/lib/aarch64-linux-gnu/'):
                try:fd,resolved=p.sysroot_leaf(sysroot_fd,prefix+request[1]);guest='/'+prefix+request[1];break
                except FileNotFoundError:continue
            if fd is None:p.refuse('required ELF dependency missing')
        else:
            if request!='/lib/ld-linux-aarch64.so.1':p.refuse('unadmitted ELF interpreter')
            guest=request;fd,resolved=p.sysroot_leaf(sysroot_fd,request[1:])
        if guest in result:os.close(fd);continue
        try:data=p.read_fd(fd,p.MAX_DEPENDENCY);measurement={'sha256':p.digest(data),'bytes':len(data)}
        except BaseException:os.close(fd);raise
        try:
            data=p.read_fd(fd,p.MAX_DEPENDENCY);meta=p.elf_metadata(fd)
            if p.digest(data)!=measurement['sha256'] or p.digest(p.read_fd(fd,p.MAX_DEPENDENCY))!=measurement['sha256']:p.refuse('dependency changed')
            if meta['type']!=3 or meta['soname'] not in (None,Path(guest).name):p.refuse('dependency ELF identity')
        finally:os.close(fd)
        total+=measurement['bytes']
        if len(result)>=p.MAX_DEPENDENCIES or total>p.MAX_DEPENDENCY_BYTES:p.refuse('ELF closure bound')
        p.write_new(destination/guest[1:],data,True)
        result[guest]={**measurement,'elf':meta,'sourceRelative':resolved}
        queue.extend(([meta['interpreter']] if meta['interpreter'] else [])+[('needed',name) for name in meta['needed']])
    # Each compiled role has its own exact closure; the union remains within C's 32-FD ceiling.
    def needed_path(name):
        for prefix in ('/lib/aarch64-linux-gnu/','/usr/lib/aarch64-linux-gnu/'):
            if prefix+name in result:return prefix+name
        p.refuse('ELF role dependency missing')
    for item in artifact_metadata.values():
        paths=set();pending=[];meta=item['elf']
        if meta['interpreter']:pending.append(meta['interpreter'])
        pending.extend(needed_path(name) for name in meta['needed'])
        while pending:
            guest=pending.pop(0)
            if guest in paths:continue
            if guest not in result:p.refuse('ELF role dependency outside union')
            paths.add(guest);meta=result[guest]['elf']
            if meta['interpreter']:pending.append(meta['interpreter'])
            pending.extend(needed_path(name) for name in meta['needed'])
        item['runtimeDependencyPaths']=sorted(paths)
    return artifact_metadata,result
def build(runtime,sdk,overlay,dependencies,compiler,base,cc,sysroot,output,runner=command,heads=None,base_pin=None,builder_root=None,builder_head=None,resolver_map=None):
    """runner injection permits portable refusal tests; CLI never replaces the runner/pins."""
    manifest=prepare_packet(runtime,sdk,overlay,dependencies,output,heads,builder_root,builder_head,resolver_map);packet=Path(output);pin=base_pin or p.BASE
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
        flag_refusal=unknown_flag_probe(runner,compiler_fd,packet,compile_args)
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
        graph=graph_evidence(normalized,packet,manifest)
        # Replace raw paths with normalized owned evidence; never preserve private CLI paths.
        (packet/'artifacts/instructionReader.metafile.json').unlink()
        meta_wire=(p.canonical(normalized)+'\n').encode();p.write_new(packet/'artifacts/instructionReader.metafile.json',meta_wire)
        artifacts={name:packet/'artifacts'/name for name in ('instructionReader','instructionReaderLauncher')}
        bodies,closure=dependency_closure(artifacts,Path(sysroot),packet/'environment')
        if p.digest(read_file(packet/'stage/linux-bun-base',p.MAX_ELF))!=base_meta['sha256']:p.refuse('staged base changed')
        for fd,expected in ((compiler_fd,compiler_meta),(base_fd,base_meta),(cc_fd,cc_meta)):
            if p.digest(p.read_fd(fd,p.MAX_ELF))!=expected['sha256']:p.refuse('held tool/base changed')
        receipt={'formatVersion':1,'kind':'winter-reader-compile','inputsSha256':p.digest(read_file(packet/'inputs.json',p.MAX_JSON)),'origins':manifest['origins'],
          'resolverBindings':manifest['resolverBindings'],'pythonSourceObservations':PYTHON_SOURCE_OBSERVATIONS,'executedPythonSourceAuthenticated':False,'reachableGraph':graph,'unknownFlagRefusal':flag_refusal,'compiler':{'version':pin['version'],**compiler_meta},'base':{**pin,'archiveAcquisitionVerified':False},'nativeCompiler':{'version':first,**cc_meta},
          'recipe':{'target':p.BASE['target'],'autoloadFlags':list(p.AUTOLOAD_FLAGS),'environment':p.ENV,'cwd':'stage','outputsExecuted':False},
          'commands':{'bun':['<held-compiler>',*[arg.replace(str(packet),'<packet>') for arg in compile_args]],'nativeCC':['<held-native-cc>',*[arg.replace(str(packet),'<packet>') for arg in native_args]]},'nativeFlags':list(NATIVE_FLAGS),'systemHeaders':headers,'bundledInputs':bundled,'metafileSha256':p.digest(meta_wire),'artifacts':bodies,'runtimeDependencies':closure,
          'dynamicRuntimeImportsVerified':False,'globalBunConfigurationExecutionVerified':False,'staticMetafileOnly':True,'trustedToolchainVerified':False,'dependencyPackageAttestationVerified':False,'autoloadExecutionVerified':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        p.write_new(packet/'receipt.json',(p.canonical(receipt)+'\n').encode());return receipt
    finally:
        for fd in tools:os.close(fd)
def main():
    parser=argparse.ArgumentParser()
    for name in ('runtime','sdk','overlay','dependencies','compiler','base','cc','sysroot','out'):parser.add_argument('--'+name,required=True,type=Path)
    parser.add_argument('--builder-head',required=True)
    parser.add_argument('--resolver-map',required=True,type=Path)
    args=parser.parse_args()
    if platform.system()!='Linux' or platform.machine() not in ('aarch64','arm64'):p.refuse('ordinary Linux ARM64 build required')
    resolver_map=resolver_map_file(args.resolver_map)
    receipt=build(args.runtime,args.sdk,args.overlay,args.dependencies,args.compiler,args.base,args.cc,args.sysroot,args.out,builder_head=args.builder_head,resolver_map=resolver_map)
    print(json.dumps({'compiled':True,'receiptSha256':p.digest(p.canonical(receipt).encode()+b'\n'),'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}))
if __name__=='__main__':main()
