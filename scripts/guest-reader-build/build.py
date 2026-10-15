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
PROBE_ROLE='instructionReaderDependencyProbe'
ARTIFACT_ROLES=('instructionReader','instructionReaderLauncher',PROBE_ROLE)
OVERLAY_NAMES=(p.C_SOURCE,p.PROBE_SOURCE,p.HEADER)
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
def prepare_packet(runtime,sdk,overlay,dependencies,output,heads=None,builder_root=None,builder_head=None,resolver_map=None,overlay_pins=None):
    heads=heads or {'runtime':p.RUNTIME_HEAD,'sdk':p.SDK_HEAD,'overlay':p.OVERLAY_HEAD}
    builder_root=Path(builder_root) if builder_root is not None else Path(__file__).resolve().parents[2]
    if resolver_map is None:resolver_map={}
    if type(resolver_map)!=dict:p.refuse('plain third-party resolver map required')
    builder_head=builder_head or heads.get('builder')
    # The pins are injectable like the heads; the CLI never replaces the constant.
    overlay_pins=p.OVERLAY_SOURCE_SHA256 if overlay_pins is None else overlay_pins
    if type(overlay_pins)!=dict or set(overlay_pins)!=set(OVERLAY_NAMES) or any(type(value)!=str for value in overlay_pins.values()):p.refuse('overlay source pin set')
    if builder_head is None:p.refuse('externally pinned builder head required')
    output=Path(output)
    refuse_ancestor_config(output)
    if not output.is_absolute() or output.exists() or output.parent.resolve()!=output.parent:p.refuse('new canonical packet directory')
    records=[];held=[];depfd=None
    try:
        for role,path,names in [('runtime',runtime,None),('sdk',sdk,None),('overlay',overlay,list(OVERLAY_NAMES)),('builder',builder_root,BUILDER_FILES)]:
            record,fd,entries,eligible=eligible_capture(role,Path(path).resolve(),builder_head if role=='builder' else heads[role],names);records.append(record);held.append((fd,entries,eligible))
        for name,observation in PYTHON_SOURCE_OBSERVATIONS.items():
            if records[3]['eligibleFiles'].get(name)!={'kind':'file',**observation}:p.refuse('captured builder differs from Python source observation')
        sdk_header=records[1]['eligibleFiles'].get(p.HEADER);overlay_header=records[2]['eligibleFiles'][p.HEADER]
        if sdk_header!=overlay_header:p.refuse('SDK overlay header differs from main')
        for name in OVERLAY_NAMES:
            if records[2]['eligibleFiles'][name].get('sha256')!=overlay_pins[name]:p.refuse('overlay source differs from its pin')
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
def refuse_private_wire(value,packet):
    # JSON has already been decoded. Inspect keys and values, including embedded/URL strings.
    private=str(packet)
    def inspect(item):
        if isinstance(item,str):
            if private in item:p.refuse('private packet path in wire')
        elif isinstance(item,dict):
            for key,child in item.items():inspect(key);inspect(child)
        elif isinstance(item,list):
            for child in item:inspect(child)
    inspect(value)
def write_wire(path,value,packet):
    refuse_private_wire(value,packet)
    wire=(p.canonical(value)+'\n').encode();p.write_new(path,wire);return wire
def manifest_target(text,packet,measured,base='stage'):
    if type(text)!=str or not text or len(text.encode())>4096:p.refuse('metafile path scalar')
    if text.startswith('/'):
        path=Path(text)
        if not path.is_relative_to(packet):p.refuse('metafile path outside packet')
        relative=path.relative_to(packet).as_posix()
    else:relative=base+'/'+text
    # Pure manifest graph; never look up an unmeasured filesystem fallback.
    return p.resolved_link('metafile-anchor',relative,measured)
def captured_bare_export(target,importer,packet,manifest,bundled):
    """Pinned Bun0d9 bundle_v2:3323-3344 cache hits need disclosed absolute edges."""
    if type(target)!=str or len(target.encode())>4096:p.refuse('bare SDK specifier')
    parts=target.split('/');package='/'.join(parts[:2])
    names={'@yanlinglabs/'+name:folder for name,folder in p.SDK_PACKAGES.items()}
    if package not in names:p.refuse('unsupported metafile import spelling')
    subpath='/'.join(parts[2:])
    if subpath:
        p.relative(subpath)
        if not re.fullmatch(r'[A-Za-z0-9_./-]+',subpath):p.refuse('bare SDK literal subpath')
    if len(parts)>2 and not subpath:p.refuse('bare SDK subpath')
    if not importer.startswith(('source/runtime/','source/sdk/')):p.refuse('bare SDK importer origin')
    origin=importer.split('/')[1];alias='source/'+origin+'/node_modules/'+package
    measured=manifest['stagedInputs'];origin_root=Path('source/'+origin);directory=Path(importer).parent
    while True:
        if any((directory/name).as_posix() in measured for name in ('tsconfig.json','jsconfig.json')):p.refuse('bare SDK importer config')
        nearer=(directory/'node_modules'/package).as_posix()
        if directory!=origin_root and (nearer in measured or any(name.startswith(nearer+'/') for name in measured)):p.refuse('bare SDK nearer alias')
        if directory==origin_root:break
        if directory==directory.parent:p.refuse('bare SDK importer ancestry')
        directory=directory.parent
    binding=manifest['resolverBindings'].get(alias)
    if type(binding)!=dict or binding.get('package')!=package or binding.get('origin')!='sdk' or binding.get('version')!='0.0.53':p.refuse('bare SDK alias identity')
    if measured.get(alias)!={'kind':'symlink','target':binding.get('target')}:p.refuse('bare SDK alias differs')
    directory='source/sdk/packages/'+names[package]
    if p.resolved_link(alias,binding['target'],measured)!=directory:p.refuse('bare SDK alias collision')
    package_json=directory+'/package.json';expected=measured.get(package_json)
    if not expected or expected.get('kind')!='file':p.refuse('bare SDK manifest absent')
    raw=read_file(packet/package_json,p.MAX_JSON)
    if p.digest(raw)!=expected['sha256'] or len(raw)!=expected['bytes']:p.refuse('bare SDK manifest changed')
    value=json_data(raw)
    if type(value)!=dict or value.get('name')!=package or value.get('version')!='0.0.53':p.refuse('bare SDK package identity')
    exports=value.get('exports')
    if type(exports)!=dict or not exports or any(type(key)!=str or '*' in key or (key!='.' and not key.startswith('./')) for key in exports):p.refuse('bare SDK exact exports required')
    key='.' if not subpath else './'+subpath;selected=exports.get(key)
    if type(selected)!=dict or list(selected)!=['types','bun','default'] or any(type(item)!=str for item in selected.values()):p.refuse('bare SDK export conditions')
    declared=selected.get('bun')
    if type(declared)!=str or not declared.startswith('./src/') or not re.fullmatch(r'\./src/[A-Za-z0-9_./-]+',declared):p.refuse('bare SDK source bun export')
    relative=p.relative(declared[2:]);resolved=p.resolved_link('bare-export-anchor',directory+'/'+relative,measured)
    if not resolved.startswith(directory+'/src/') or measured.get(resolved,{}).get('kind')!='file' or resolved not in bundled:p.refuse('bare SDK export outside/unbundled')
    return resolved,{'rawPath':target,'alias':alias,'packageJson':package_json,'packageJsonSha256':expected['sha256'],'package':package,'version':'0.0.53','exportKey':key,'condition':'bun','declaredTarget':declared,'resolvedTarget':resolved}
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
    normalized=remap(data);normalized_inputs={};edge_count=0;disclosed=[];derived=[]
    for raw,info in data['inputs'].items():
        record=remap(info);imports=info.get('imports',[])
        if type(imports)!=list:p.refuse('metafile import list')
        normalized_imports=[]
        for item in imports:
            edge_count+=1
            if edge_count>p.MAX_ENTRIES or type(item)!=dict or type(item.get('path'))!=str or type(item.get('external',False))!=bool:p.refuse('metafile import record')
            if 'capturedBareExport' in item:p.refuse('bare SDK evidence collision')
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
                else:
                    resolved,evidence=captured_bare_export(target,mapped[raw],packet,manifest,bundled)
                    copy['capturedBareExport']=evidence
                if resolved not in bundled:p.refuse('outside/non-bundled import target')
                if target.startswith('/'):disclosed.append({'source':mapped[raw],'original':item.get('original'),'target':resolved})
                if 'capturedBareExport' in copy:derived.append({'source':mapped[raw],**copy['capturedBareExport']})
                copy['path']=resolved
            normalized_imports.append(copy)
        record['imports']=normalized_imports
        if mapped[raw] in normalized_inputs:p.refuse('duplicate canonical metafile input')
        normalized_inputs[mapped[raw]]=record
    # Pinned bundle_v2 cache hits retain the bare spelling after a prior real resolution.
    for item in derived:
        if not any(edge['target']==item['resolvedTarget'] for edge in disclosed):p.refuse('bare SDK target undisclosed')
        for edge in disclosed:
            if edge['original']==item['rawPath'] and edge['source'].split('/')[1]==item['source'].split('/')[1] and edge['target']!=item['resolvedTarget']:p.refuse('bare SDK disclosed disagreement')
    normalized['inputs']=normalized_inputs
    refuse_private_wire(normalized,packet)
    return normalized,{name:measured[name] for name in sorted(bundled)}
def graph_evidence(metafile,packet,manifest):
    measured=manifest['stagedInputs'];references=[];edges=[];used=set();missing_original=0;bare_exports=[]
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
            if 'capturedBareExport' in item:bare_exports.append({'source':source,'sourceSha256':measured[source]['sha256'],**item['capturedBareExport']})
            if original is not None and not original.startswith(('.', '/')):
                references.append({'source':source,'sourceSha256':measured[source]['sha256'],'specifier':original,'target':target,'kind':item['kind'],'external':external})
    # The exact top-level third-party aliases must actually contribute reachable inputs.
    for alias,binding in manifest['resolverBindings'].items():
        if binding['origin']!='dependencies':continue
        target=(packet/alias).resolve().relative_to(packet).as_posix()
        if any(name.startswith(target+'/') for name in metafile['inputs']):used.add(binding['package'])
    required={binding['package'] for binding in manifest['resolverBindings'].values() if binding['origin']=='dependencies'}
    if used!=required:p.refuse('unused third-party resolver binding')
    return {'edges':edges,'bareReferences':references,'capturedBareExports':bare_exports,'missingOriginalCount':missing_original,'staticMetafileOnly':True,'dynamicRuntimeImportsVerified':False}
BUN_SOURCE_COMMIT='0d9b296af33f2b851fcbf4df3e9ec89751734ba4'
POSITIVE_AUTOLOAD=tuple(flag.replace('--no-compile-','--compile-',1) for flag in p.AUTOLOAD_FLAGS)
OPAQUE_SOURCE=b'await import(globalThis.__winter_reader_missing_specifier);\n'
def measurement_inventory(directory):
    result={};fd=p.root_fd(directory);total=0
    try:
        with os.scandir(fd) as entries:
            for entry in entries:
                if len(result)>=16:p.refuse('measurement output count')
                name=p.relative(entry.name);info=entry.stat(follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):p.refuse('measurement output regular file')
                held=p.leaf(fd,name)
                try:data=p.read_fd(held,p.MAX_ELF)
                finally:os.close(held)
                total+=len(data)
                if total>2*p.MAX_ELF:p.refuse('measurement output aggregate')
                result[name]={'sha256':p.digest(data),'bytes':len(data)}
    finally:os.close(fd)
    return dict(sorted(result.items()))
def measurement_recipe(recipe,packet,directory,entry=None):
    args=[arg.replace(str(packet/'artifacts'),str(directory)) for arg in recipe]
    if entry is not None:
        args=[str(entry) if arg==str(packet/'source/runtime'/p.READER_ENTRY) else arg for arg in args]
    return args
def run_measurement(runner,compiler_fd,packet,scratch,case,args):
    directory=scratch/case;directory.mkdir(mode=0o700);stdout=stderr=b'';exit_code=None;runner_error=False
    try:
        stdout,stderr=runner(['/proc/self/fd/'+str(compiler_fd),*measurement_recipe(args,packet,directory)],packet/'stage',120,(compiler_fd,));exit_code=0
    except CommandFailure as failure:stdout=failure.stdout;stderr=failure.stderr;exit_code=failure.code
    except Exception:runner_error=True
    capture_refused=type(stdout)!=bytes or type(stderr)!=bytes or len(stdout)+len(stderr)>MAX_OUTPUT
    if capture_refused:
        stdout=stdout[:MAX_OUTPUT] if type(stdout)==bytes else b'';stderr=stderr[:max(0,MAX_OUTPUT-len(stdout))] if type(stderr)==bytes else b''
    record={'formatVersion':1,'kind':'winter-reader-compiler-observation','case':case,'exitCode':exit_code,'runnerError':runner_error,'captureRefused':capture_refused,'captureHashesComplete':not capture_refused and not runner_error,'stdoutSha256':p.digest(stdout),'stdoutBytes':len(stdout),'stderrSha256':p.digest(stderr),'stderrBytes':len(stderr),'outputsExecuted':False,'nativeAdmission':False}
    try:record['outputs']=measurement_inventory(directory)
    except Exception:
        record['outputs']=None;record['inventoryRefused']=True
    # A durable bounded sanitized observation precedes every semantic refusal.
    record_path=packet/'diagnostics'/f'{case}.json';write_wire(record_path,record,packet)
    if runner_error or capture_refused or record.get('inventoryRefused'):p.refuse('measurement observation refused')
    return record,stderr,directory
def exact_negative(record,stderr,line):
    if type(record['exitCode'])!=int or record['exitCode']!=1 or record.get('stdoutBytes')!=0 or record['outputs']!= {}:p.refuse('semantic negative outcome')
    if stderr!=(line+'\n').encode():p.refuse('semantic negative diagnostic')
def opaque_diagnostic(opaque):
    source=OPAQUE_SOURCE.decode().rstrip('\n')
    error='This import() expression will not be bundled because the argument is not a string literal'
    note='To allow opaque dynamic specifiers, use Bun.build({ allowUnresolved: [""] }) or pass --allow-unresolved with an empty-string pattern'
    return ('1 | '+source+'\n'+' '*17+'^\n'+'error: '+error+'\n'+' '*4+'at '+str(opaque)+':1:14\n\n'+'1 | '+source+'\n'+' '*17+'^\n'+'note: '+note+'\n'+' '*3+'at '+str(opaque)+':1:14\n').encode()
def exact_opaque_negative(record,stderr,opaque):
    if record['exitCode']!=1 or type(record['exitCode'])!=int or record.get('stdoutBytes')!=0 or record['outputs']!={}:p.refuse('opaque negative outcome')
    if stderr!=opaque_diagnostic(opaque):p.refuse('opaque diagnostic envelope')
def parsed_output(record,directory,base_fd,expected_nibble):
    if record['exitCode']!=0 or 'instructionReader' not in record['outputs']:p.refuse('measurement compile outcome')
    fd,_=file_input(directory/'instructionReader',p.MAX_ELF)
    try:
        base_hash=p.digest(p.read_fd(base_fd,p.MAX_ELF))
        decoded=p.standalone_flags(fd,base_fd)
    finally:os.close(fd)
    if decoded['baseSha256']!=base_hash or decoded['outputSha256']!=record['outputs']['instructionReader']['sha256']:p.refuse('measurement decoded hash mismatch')
    if decoded['flagsNibble']!=expected_nibble or decoded['payload']['compileExecArgvBytes']!=0:p.refuse('measurement embedded flags')
    return decoded
def compiler_semantic_evidence(runner,compiler_fd,base_fd,packet,recipe):
    scratch=packet.parent/'reader-compiler-measurements';scratch.mkdir(mode=0o700);evidence={};records=[]
    for index,(negative,positive) in enumerate(zip(p.AUTOLOAD_FLAGS,POSITIVE_AUTOLOAD)):
        case=f'autoload-pair-{index}'
        record,stderr,_=run_measurement(runner,compiler_fd,packet,scratch,case,[*recipe,positive]);records.append(record)
        exact_negative(record,stderr,'error: Cannot use both '+positive+' and '+negative)
    record,stderr,_=run_measurement(runner,compiler_fd,packet,scratch,'unresolved-pair',[*recipe,'--allow-unresolved=*']);records.append(record)
    exact_negative(record,stderr,'error: --reject-unresolved and --allow-unresolved cannot be used together')
    for case,arguments,nibble in (
        ('autoload-default',[arg for arg in recipe if arg not in p.AUTOLOAD_FLAGS],12),
        ('autoload-enabled',[POSITIVE_AUTOLOAD[p.AUTOLOAD_FLAGS.index(arg)] if arg in p.AUTOLOAD_FLAGS else arg for arg in recipe],0)):
        record,_,directory=run_measurement(runner,compiler_fd,packet,scratch,case,arguments);records.append(record)
        evidence[case]={'observation':record,'embedded':parsed_output(record,directory,base_fd,nibble)}
    opaque=scratch/'opaque-import.ts';p.write_new(opaque,OPAQUE_SOURCE)
    opaque_recipe=measurement_recipe(recipe,packet,packet/'artifacts',opaque)
    record,stderr,_=run_measurement(runner,compiler_fd,packet,scratch,'opaque-rejected',opaque_recipe);records.append(record)
    exact_opaque_negative(record,stderr,opaque)
    record,_,directory=run_measurement(runner,compiler_fd,packet,scratch,'opaque-allowed',[arg for arg in opaque_recipe if arg!='--reject-unresolved']);records.append(record)
    evidence['opaque-control']={'observation':record,'embedded':parsed_output(record,directory,base_fd,15),'sourceSha256':p.digest(OPAQUE_SOURCE),'sourceBytes':len(OPAQUE_SOURCE)}
    return {'sourceCommit':BUN_SOURCE_COMMIT,'parserCases':records,'differentials':evidence,'unknownLongOptions':{'property':'skipped','observedRun':38494750351,'observedExitCode':0,'usedAsGate':False},'opaqueDynamicRejectionVerified':True,'optionalLiteralImportsVerified':False,'dynamicRuntimeImportsVerified':False,'measurementScratchArchived':False,'outputsExecuted':False}
def compiler_recipe(packet):
    return ['build','--no-env-file','--config='+str(packet/'stage/empty-bunfig.toml'),'--compile','--reject-unresolved',*p.AUTOLOAD_FLAGS,
      '--target='+p.BASE['target'],'--compile-executable-path='+str(packet/'stage/linux-bun-base'),'--metafile='+str(packet/'artifacts/instructionReader.metafile.json'),
      str(packet/'source/runtime'/p.READER_ENTRY),'--outfile',str(packet/'artifacts/instructionReader')]
def native_command(packet,source,output):
    # One argv builder for every native role, so the probe and the launcher cannot drift apart in flags.
    return [*NATIVE_FLAGS,'-I'+str(packet/'source/overlay/packages/runtime/src/guest'),'-MD','-MF',str(packet/'artifacts/native.d'),str(source),'-o',str(output)]
def header_observations(packet,sysroot,depfile):
    # Full system header provenance is an observation, not trusted toolchain proof.
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
    return headers
def merge_headers(first,second):
    # The two compiles reuse one depfile path sequentially; a path both saw must have identical bytes.
    merged=dict(first)
    for key,meta in second.items():
        if merged.setdefault(key,meta)!=meta:p.refuse('native header changed between compiles')
    if len(merged)>4096:p.refuse('native header inventory')
    return dict(sorted(merged.items()))
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
    if PROBE_ROLE in artifact_metadata:
        # The probe measures the packet's own pinned libraries; it may not pull in a seventh object.
        probe=artifact_metadata[PROBE_ROLE]
        if not probe['elf']['interpreter']:p.refuse('probe must be dynamic')
        packet_paths=set().union(*(item['runtimeDependencyPaths'] for name,item in artifact_metadata.items() if name!=PROBE_ROLE))
        if not set(probe['runtimeDependencyPaths'])<=packet_paths:p.refuse('probe dependency outside reader closure')
    return artifact_metadata,result
def build(runtime,sdk,overlay,dependencies,compiler,base,cc,sysroot,output,runner=command,heads=None,base_pin=None,builder_root=None,builder_head=None,resolver_map=None,overlay_pins=None):
    """runner injection permits portable refusal tests; CLI never replaces the runner/pins."""
    manifest=prepare_packet(runtime,sdk,overlay,dependencies,output,heads,builder_root,builder_head,resolver_map,overlay_pins);packet=Path(output);pin=base_pin or p.BASE
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
        semantic_evidence=compiler_semantic_evidence(runner,compiler_fd,base_fd,packet,compile_args)
        runner(['/proc/self/fd/'+str(compiler_fd),*compile_args],packet/'stage',120,(compiler_fd,))
        native_args=native_command(packet,packet/'source/overlay'/p.C_SOURCE,packet/'artifacts/instructionReaderLauncher')
        runner(['/proc/self/fd/'+str(cc_fd),*native_args],packet/'stage',120,(cc_fd,))
        reader_fd,_=file_input(packet/'artifacts/instructionReader',p.MAX_ELF)
        try:reader_flags=p.standalone_flags(reader_fd,base_fd)
        finally:os.close(reader_fd)
        if reader_flags['flagsNibble']!=15 or reader_flags['payload']['compileExecArgvBytes']!=0:p.refuse('reader embedded autoload flags')
        headers=header_observations(packet,sysroot,read_file(packet/'artifacts/native.d',p.MAX_JSON))
        # The dependency probe reuses the one excluded scratch path, sequentially: remove the launcher's
        # depfile first so the second read can only be a fresh write, then merge both observations.
        (packet/'artifacts/native.d').unlink()
        probe_args=native_command(packet,packet/'source/overlay'/p.PROBE_SOURCE,packet/'artifacts'/PROBE_ROLE)
        runner(['/proc/self/fd/'+str(cc_fd),*probe_args],packet/'stage',120,(cc_fd,))
        headers=merge_headers(headers,header_observations(packet,sysroot,read_file(packet/'artifacts/native.d',p.MAX_JSON)))
        check_inputs(packet,manifest)
        metafile=json_data(read_file(packet/'artifacts/instructionReader.metafile.json',p.MAX_JSON))
        normalized,bundled=normalized_metafile(metafile,packet,manifest)
        graph=graph_evidence(normalized,packet,manifest)
        # Replace raw paths with normalized owned evidence; never preserve private CLI paths.
        (packet/'artifacts/instructionReader.metafile.json').unlink()
        meta_wire=write_wire(packet/'artifacts/instructionReader.metafile.json',normalized,packet)
        artifacts={name:packet/'artifacts'/name for name in ARTIFACT_ROLES}
        bodies,closure=dependency_closure(artifacts,Path(sysroot),packet/'environment')
        if p.digest(read_file(packet/'stage/linux-bun-base',p.MAX_ELF))!=base_meta['sha256']:p.refuse('staged base changed')
        if reader_flags['outputSha256']!=bodies['instructionReader']['sha256'] or reader_flags['baseSha256']!=base_meta['sha256']:p.refuse('reader decoded hash mismatch')
        for fd,expected in ((compiler_fd,compiler_meta),(base_fd,base_meta),(cc_fd,cc_meta)):
            if p.digest(p.read_fd(fd,p.MAX_ELF))!=expected['sha256']:p.refuse('held tool/base changed')
        receipt={'formatVersion':1,'kind':'winter-reader-compile','inputsSha256':p.digest(read_file(packet/'inputs.json',p.MAX_JSON)),'origins':manifest['origins'],
          'resolverBindings':manifest['resolverBindings'],'pythonSourceObservations':PYTHON_SOURCE_OBSERVATIONS,'executedPythonSourceAuthenticated':False,'reachableGraph':graph,'compilerSemanticEvidence':semantic_evidence,'readerEmbeddedFlags':reader_flags,'compiler':{'version':pin['version'],**compiler_meta},'base':{**pin,'archiveAcquisitionVerified':False},'nativeCompiler':{'version':first,**cc_meta},
          'recipe':{'target':p.BASE['target'],'autoloadFlags':list(p.AUTOLOAD_FLAGS),'environment':p.ENV,'cwd':'stage','outputsExecuted':False},
          'commands':{'bun':['<held-compiler>',*[arg.replace(str(packet),'<packet>') for arg in compile_args]],'nativeCC':['<held-native-cc>',*[arg.replace(str(packet),'<packet>') for arg in native_args]],'nativeProbeCC':['<held-native-cc>',*[arg.replace(str(packet),'<packet>') for arg in probe_args]]},'nativeFlags':list(NATIVE_FLAGS),'systemHeaders':headers,'bundledInputs':bundled,'metafileSha256':p.digest(meta_wire),'artifacts':bodies,'runtimeDependencies':closure,
          'dynamicRuntimeImportsVerified':False,'globalBunConfigurationExecutionVerified':False,'staticMetafileOnly':True,'trustedToolchainVerified':False,'dependencyPackageAttestationVerified':False,'autoloadExecutionVerified':False,'nativeOwnerVerified':False,'linuxExecutionVerified':False,'vmExecutionVerified':False,'activationEnabled':False}
        write_wire(packet/'receipt.json',receipt,packet);return receipt
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
