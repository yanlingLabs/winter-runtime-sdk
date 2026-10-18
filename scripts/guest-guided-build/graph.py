"""Metafile normalization and reachable-graph evidence for the four-origin guided packet.

Generalizes the reader builder's single-entry, two-origin graph rules to four roles and four origins. It reuses that
builder's bounded helpers by loading them from their (hash-observed) paths and changes none of them. Static
compiler-metafile evidence only: dynamic runtime imports stay unverified, nothing here executes any output."""
import importlib.util,json,posixpath,re
from pathlib import Path

HERE=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
pins=load('guided_pins',HERE/'pins.py')
reader=load('guided_reader_build',HERE.parent/'guest-reader-build'/'build.py')
p=reader.p
# Conditions Bun enables when it resolves an ESM `import` for the bun target. Order is the exports object's own order.
ACTIVE_CONDITIONS=('bun','node','import','module','default')

def importer_origin(importer):
    parts=importer.split('/')
    if len(parts)<3 or parts[0]!='source' or parts[1] not in pins.ALIAS_ORIGINS:p.refuse('bare importer origin')
    return parts[1]
def package_of(target):
    if type(target)!=str or not target or len(target.encode())>4096:p.refuse('bare specifier')
    parts=target.split('/');package='/'.join(parts[:2]) if target.startswith('@') else parts[0]
    return package,'/'.join(parts[2:] if target.startswith('@') else parts[1:])
def pick_condition(node,active):
    if type(node)==str:return node
    if type(node)!=dict or not node:p.refuse('package condition shape')
    for name,value in node.items():
        if name in active:
            result=pick_condition(value,active)
            if result is not None:return result
    return None
def resolve_exports(node,key,active=ACTIVE_CONDITIONS):
    """Exact-key package exports resolution (no patterns, no arrays); first active condition in object order wins."""
    if type(node)==str:return node if key=='.' else None
    if type(node)!=dict or not node:p.refuse('package exports shape')
    if all(not name.startswith('.') for name in node):
        return pick_condition(node,active) if key=='.' else None
    if any(not name.startswith('.') for name in node):p.refuse('mixed package exports')
    chosen=node.get(key)
    return None if chosen is None else pick_condition(chosen,active)
def main_field(value):
    """No `exports`: Bun's bun-target main fields are not assumed. Differing module/main spellings refuse."""
    module,main=value.get('module'),value.get('main')
    candidates={item for item in (module,main) if type(item)==str}
    if len(candidates)>1:p.refuse('package main/module disagree')
    chosen=candidates.pop() if candidates else 'index.js'
    return chosen if chosen.startswith('./') else './'+chosen

EXTENSIONS=('.tsx','.ts','.jsx','.js','.mjs','.cjs','.json')
def resolve_relative_edge(target,importer,measured):
    """A relative specifier retained by a bundler cache hit, e.g. ./current-context. The first existing measured
    candidate in Bun's extension order is the target; an unmeasured target refuses. Whether it was bundled or pruned
    is decided by the caller."""
    if type(target)!=str or not target or target.startswith('/') or '\\' in target:p.refuse('relative specifier')
    base=posixpath.normpath(posixpath.join(posixpath.dirname(importer),target))
    if base=='..' or base.startswith('../') or base.startswith('/'):p.refuse('relative specifier escapes the packet')
    for candidate in (base,*(base+ext for ext in EXTENSIONS),*(base+'/index'+ext for ext in EXTENSIONS)):
        node=measured.get(candidate)
        if node and node['kind']=='file':
            return candidate
    p.refuse('relative target unmeasured')

def jsonc(raw):
    """tsconfig-style JSON: comments allowed, trailing commas are not (they refuse)."""
    out=[];i=0;n=len(raw);text=raw.decode('utf8')
    n=len(text)
    while i<n:
        c=text[i]
        if c=='"':
            j=i+1
            while j<n and text[j]!='"':j+=2 if text[j]=='\\' else 1
            out.append(text[i:j+1]);i=j+1
        elif text.startswith('//',i):
            while i<n and text[i]!='\n':i+=1
        elif text.startswith('/*',i):
            end=text.find('*/',i+2)
            if end<0:p.refuse('tsconfig comment')
            i=end+2
        else:out.append(c);i+=1
    return reader.json_data(''.join(out).encode())
def tsconfig_paths(importer,origin_root,packet,measured):
    """The `paths` map Bun would apply to this importer, or None. Only exact-key maps are modelled; baseUrl and
    wildcard keys refuse. Returns (declaring directory, paths)."""
    directory=Path(importer).parent;config=None
    while True:
        for name in ('tsconfig.json','jsconfig.json'):
            if (directory/name).as_posix() in measured:config=(directory/name).as_posix();break
        if config or directory==origin_root:break
        directory=directory.parent
    if config is None:return None
    found=None;current=config
    for _ in range(5):
        node=measured.get(current)
        if not node or node['kind']!='file':p.refuse('tsconfig unmeasured')
        value=jsonc(reader.read_file(packet/current,p.MAX_JSON))
        if type(value)!=dict:p.refuse('tsconfig shape')
        options=value.get('compilerOptions',{})
        if type(options)!=dict or 'baseUrl' in options:p.refuse('tsconfig baseUrl or options shape')
        if 'paths' in options and found is None:
            if type(options['paths'])!=dict:p.refuse('tsconfig paths shape')
            found=(posixpath.dirname(current),options['paths'])
        parent=value.get('extends')
        if parent is None:return found
        if type(parent)!=str or not parent.startswith(('./','../')):p.refuse('tsconfig extends spelling')
        current=posixpath.normpath(posixpath.join(posixpath.dirname(current),parent if parent.endswith('.json') else parent+'.json'))
    p.refuse('tsconfig extends depth')
def tsconfig_mapping(target,paths):
    if paths is None:return None
    declared,table=paths
    for key in table:
        if '*' in key and re.fullmatch(re.escape(key).replace(r'\*','.*'),target):p.refuse('tsconfig wildcard paths match')
    if target not in table:return None
    value=table[target]
    if type(value)!=list or not value or type(value[0])!=str or '*' in value[0]:p.refuse('tsconfig paths target')
    return posixpath.normpath(posixpath.join(declared,value[0]))

def nearest_package(importer,package,measured):
    """Node lookup over the staged inventory: the nearest `<dir>/node_modules/<package>` above the importer."""
    directory=Path(importer).parent
    while True:
        if directory.name!='node_modules':
            candidate=(directory/'node_modules'/package).as_posix()
            if candidate in measured or f'{candidate}/package.json' in measured:return candidate
        if directory==directory.parent:p.refuse('bare package not found above importer')
        directory=directory.parent

def captured_bare_export(target,importer,packet,manifest,bundled):
    """Pinned bundle_v2 cache hits retain a bare spelling; derive its target from the measured manifest only."""
    package,subpath=package_of(target)
    if subpath:
        p.relative(subpath)
        if not re.fullmatch(r'[A-Za-z0-9_./-]+',subpath):p.refuse('bare literal subpath')
    measured=manifest['stagedInputs'];in_dependencies=importer.startswith('dependencies/.pnpm/');mapped_by_config=None
    if in_dependencies:
        alias=nearest_package(importer,package,measured);binding={'package':package,'origin':'dependencies','target':None};kind='dependencies-internal'
    else:
        origin=importer_origin(importer);origin_root=Path('source/'+origin);directory=Path(importer).parent
        alias='source/'+origin+'/node_modules/'+package
        mapped_by_config=tsconfig_mapping(target,tsconfig_paths(importer,origin_root,packet,measured))
        while True:
            nearer=(directory/'node_modules'/package).as_posix()
            if directory!=origin_root and (nearer in measured or any(name.startswith(nearer+'/') for name in measured)):p.refuse('bare nearer alias')
            if directory==origin_root:break
            if directory==directory.parent:p.refuse('bare importer ancestry')
            directory=directory.parent
        binding=manifest['resolverBindings'].get(alias)
        if type(binding)!=dict or binding.get('package')!=package:p.refuse('bare alias identity')
        if measured.get(alias)!={'kind':'symlink','target':binding.get('target')}:p.refuse('bare alias differs')
        kind=binding['origin']
    if in_dependencies:
        if measured.get(alias,{}).get('kind')=='symlink':package_dir=p.resolved_link(alias,measured[alias]['target'],measured)
        else:package_dir=alias
    else:package_dir=p.resolved_link(alias,binding['target'],measured)
    expected_dir={'sdk':'source/sdk/packages/','winter':'source/winter/packages/','dependencies':'dependencies/.pnpm/','dependencies-internal':'dependencies/.pnpm/'}.get(kind)
    if expected_dir is None or not package_dir.startswith(expected_dir):p.refuse('bare alias collision')
    package_json=package_dir+'/package.json';expected=measured.get(package_json)
    if not expected or expected.get('kind')!='file':p.refuse('bare manifest absent')
    raw=reader.read_file(packet/package_json,p.MAX_JSON)
    if p.digest(raw)!=expected['sha256'] or len(raw)!=expected['bytes']:p.refuse('bare manifest changed')
    value=reader.json_data(raw)
    if type(value)!=dict or value.get('name')!=package or type(value.get('version'))!=str or (binding.get('version') is not None and value.get('version')!=binding.get('version')):p.refuse('bare package identity')
    key='.' if not subpath else './'+subpath;exports=value.get('exports')
    if kind=='sdk':
        if package not in {'@yanlinglabs/'+name for name in p.SDK_PACKAGES} or value.get('version')!=pins.SDK_FAMILY_VERSION:p.refuse('bare SDK package identity')
        if type(exports)!=dict or not exports or any(type(name)!=str or '*' in name or (name!='.' and not name.startswith('./')) for name in exports):p.refuse('bare SDK exact exports required')
        selected=exports.get(key)
        if type(selected)!=dict or list(selected)!=['types','bun','default'] or any(type(item)!=str for item in selected.values()):p.refuse('bare SDK export conditions')
        declared=selected['bun'];condition='bun'
        if not re.fullmatch(r'\./src/[A-Za-z0-9_./-]+',declared):p.refuse('bare SDK source bun export')
    elif kind=='winter':
        if package not in pins.WORKSPACE_PACKAGE or subpath or exports!={'.':'./src/index.ts'}:p.refuse('bare workspace export')
        declared=exports['.'];condition='exact-string'
    elif exports is None:
        if subpath:p.refuse('bare third-party subpath without exports')
        declared=main_field(value);condition='main-or-module-field'
    else:
        declared=resolve_exports(exports,key)
        if type(declared)!=str:p.refuse('bare third-party export')
        condition='first-active-in-object-order'
    if not declared.startswith('./') or '*' in declared:p.refuse('bare third-party export spelling')
    relative=p.relative(declared[2:]);resolved=p.resolved_link('bare-export-anchor',package_dir+'/'+relative,measured)
    if not resolved.startswith(package_dir+'/') or measured.get(resolved,{}).get('kind')!='file':p.refuse('bare export outside capture')
    if mapped_by_config is not None and mapped_by_config!=resolved:p.refuse('tsconfig paths disagree with the derived target')
    return resolved,{'rawPath':target,'alias':alias,'packageJson':package_json,'packageJsonSha256':expected['sha256'],'package':package,'version':value['version'],'exportKey':key,'condition':condition,'declaredTarget':declared,'resolvedTarget':resolved,'bindingKind':kind,'tsconfigPathsAgree':mapped_by_config is not None}

def package_scope(path):
    # The unit within which one bare spelling must mean one thing: an origin, or one virtual-store package.
    parts=path.split('/')
    return '/'.join(parts[:3]) if parts[0]=='dependencies' else '/'.join(parts[:2])

def normalized_metafile(data,packet,manifest,role):
    if type(data)!=dict or type(data.get('inputs'))!=dict or not 1<=len(data['inputs'])<=p.MAX_ENTRIES:p.refuse('metafile shape')
    measured=manifest['stagedInputs'];mapped={};bundled=set()
    for raw,info in data['inputs'].items():
        if type(raw)!=str or type(info)!=dict or type(info.get('bytes'))!=int:p.refuse('metafile input record')
        relative=reader.manifest_target(raw,packet,measured)
        if measured.get(relative,{}).get('kind')!='file' or measured[relative]['bytes']!=info['bytes']:p.refuse('metafile input outside capture')
        if ('0.0.28' in relative) or ('/dist/' in relative and relative.startswith('source/sdk/packages/')):p.refuse('old/unmeasured SDK emit')
        if relative.startswith('dependencies/') and '@yanlinglabs' in relative:p.refuse('published peer resolver')
        mapped[raw]=relative;bundled.add(relative)
    if role['entry'] not in bundled:p.refuse('role entry missing from graph')
    for required in role['required']:
        if required not in bundled:p.refuse('role required input missing from graph')
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
    normalized=remap(data);normalized_inputs={};edge_count=0;disclosed=[];derived=[];pruned=[]
    for raw,info in data['inputs'].items():
        record=remap(info);imports=info.get('imports',[])
        if type(imports)!=list:p.refuse('metafile import list')
        normalized_imports=[]
        for item in imports:
            edge_count+=1
            if edge_count>p.MAX_ENTRIES*4 or type(item)!=dict or type(item.get('path'))!=str or type(item.get('external',False))!=bool:p.refuse('metafile import record')
            if 'capturedBareExport' in item:p.refuse('bare evidence collision')
            copy=remap(item)
            if 'original' in item:copy['original']=item['original']
            if not item.get('external',False):
                target=item['path']
                if target.startswith('/'):resolved=reader.manifest_target(target,packet,measured)
                elif target.startswith(('./','../')):resolved=resolve_relative_edge(target,mapped[raw],measured)
                elif target in mapped:resolved=mapped[target]
                else:
                    resolved,evidence=captured_bare_export(target,mapped[raw],packet,manifest,bundled)
                    copy['capturedBareExport']=evidence
                if measured.get(resolved,{}).get('kind')!='file':p.refuse('import target outside capture')
                if resolved not in bundled:
                    # An edge the bundler saw but dropped (an unused import of a side-effect-free module). The target must still be
                    # a measured file; it is evidence of a pruned edge, never an input.
                    copy['pruned']=True;pruned.append({'source':mapped[raw],'target':resolved})
                if target.startswith('/'):disclosed.append({'source':mapped[raw],'original':item.get('original'),'target':resolved})
                if 'capturedBareExport' in copy:derived.append({'source':mapped[raw],**copy['capturedBareExport']})
                copy['path']=resolved
            normalized_imports.append(copy)
        record['imports']=normalized_imports
        if mapped[raw] in normalized_inputs:p.refuse('duplicate canonical metafile input')
        normalized_inputs[mapped[raw]]=record
    for item in derived:
        if not any(edge['target']==item['resolvedTarget'] for edge in disclosed):p.refuse('bare target undisclosed')
        for edge in disclosed:
            if edge['original']==item['rawPath'] and package_scope(edge['source'])==package_scope(item['source']) and edge['target']!=item['resolvedTarget']:p.refuse('bare disclosed disagreement')
    normalized['inputs']=normalized_inputs
    normalized['prunedEdgeCount']=len(pruned)
    reader.refuse_private_wire(normalized,packet)
    return normalized,{name:measured[name] for name in sorted(bundled)}

def graph_evidence(metafile,packet,manifest):
    """Per-role reachable graph. Returns (evidence, alias paths of third-party bindings this role actually reached)."""
    measured=manifest['stagedInputs'];references=[];edges=[];used=set();missing_original=0;bare_exports=[];bound=0
    for source,info in metafile['inputs'].items():
        imports=info.get('imports',[])
        if type(imports)!=list:p.refuse('metafile import list')
        for item in imports:
            bound+=1
            if bound>p.MAX_ENTRIES*4:p.refuse('metafile import count')
            if type(item)!=dict or type(item.get('kind'))!=str or type(item.get('path'))!=str or type(item.get('external',False))!=bool:p.refuse('metafile import record')
            if len(item['kind'].encode())>128 or len(item['path'].encode())>4096:p.refuse('metafile import scalar bound')
            target=item['path'];external=item.get('external',False);original=item.get('original')
            if original is not None and (type(original)!=str or not original or len(original.encode())>4096):p.refuse('metafile original specifier')
            if original is None:missing_original+=1
            if external:
                if not (target in pins.ALLOWED_BUN_EXTERNALS or target.removeprefix('node:').split('/')[0] in reader.NODE_BUILTINS):p.refuse('unresolved/non-builtin external')
                if original is not None and not (original in pins.ALLOWED_BUN_EXTERNALS or original.removeprefix('node:').split('/')[0] in reader.NODE_BUILTINS):p.refuse('external bare mismatch')
            elif target not in measured or measured[target]['kind']!='file':p.refuse('unmeasured metafile import target')
            edges.append({'source':source,'kind':item['kind'],'target':target,'external':external})
            if 'capturedBareExport' in item:bare_exports.append({'source':source,'sourceSha256':measured[source]['sha256'],**item['capturedBareExport']})
            if original is not None and not original.startswith(('.', '/')):
                references.append({'source':source,'sourceSha256':measured[source]['sha256'],'specifier':original,'target':target,'kind':item['kind'],'external':external})
    for alias,binding in manifest['resolverBindings'].items():
        if binding['origin']!='dependencies':continue
        target=p.resolved_link(alias,binding['target'],measured)
        if any(name.startswith(target+'/') for name in metafile['inputs']):used.add(alias)
    return {'edges':edges,'bareReferences':references,'capturedBareExports':bare_exports,'missingOriginalCount':missing_original,'staticMetafileOnly':True,'dynamicRuntimeImportsVerified':False},used
