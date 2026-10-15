"""Unprivileged reader build data capture. No project imports or output execution."""
import hashlib,json,os,selectors,signal,stat,struct,subprocess,time
from pathlib import Path,PurePosixPath

MAX_FILE=16*1024*1024
MAX_SOURCE=256*1024*1024
MAX_ENTRIES=20000
MAX_JSON=16*1024*1024
MAX_ELF=128*1024*1024
MAX_DEPENDENCY=32*1024*1024
MAX_DEPENDENCIES=32
MAX_DEPENDENCY_BYTES=128*1024*1024
AUTOLOAD_FLAGS=('--no-compile-autoload-bunfig','--no-compile-autoload-dotenv','--no-compile-autoload-tsconfig','--no-compile-autoload-package-json')
SDK_HEAD='8603da22d9fe7f1695166891cd29ccd254b1d21e'
RUNTIME_HEAD='0394b36f674765c942f8db07f009b7ad20787dba'
OVERLAY_HEAD='f6d88d9a2f8ae15bb50afb98868183ae769e3b11'  # still the pre-probe overlay; the integrator moves it with OVERLAY_SOURCE_SHA256 to the frozen agent-sdk sha
C_SOURCE='packages/runtime/src/guest/linux-instruction-reader-compartment.c'
PROBE_SOURCE='packages/runtime/src/guest/linux-instruction-reader-dependency-probe.c'
HEADER='packages/runtime/src/guest/linux-compartment.h'
# PLACEHOLDER (lane B scaffolding): these are the agent-sdk 94dd2f48 overlay hashes. The integrator replaces
# them with the hashes of the frozen agent-sdk sha before any compile run; never treat them as a reviewed pin.
OVERLAY_SOURCE_SHA256={
    C_SOURCE:'14622f98f4b809867326b26386599eae36fc34fee407ff4415418b65d28d5d46',
    PROBE_SOURCE:'c0da913079104150fcc8c218718589a30f36fc157bcfb682f4f82de21642fd18',
    HEADER:'92fef7c0708a23b1e930c5b2560dae6bef27294dfd682346e69d35c0484b967d'}
READER_ENTRY='src/guest/instruction-reader-entry.ts'
SDK_PACKAGES={'winter-agent-sdk':'sdk','winter-agent-runtime':'runtime','winter-provider-catalog':'provider-catalog','winter-provider-runtime':'provider-runtime','winter-conformance':'conformance','winter-provider-conformance':'provider-conformance'}
BASE={'version':'1.3.14','target':'bun-linux-arm64','archiveSha256':'a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b','executableSha256':'37141662ebed915a2ab89313156e455e2a1374395f5f6760d06407f49406f086'}
ENV={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C','TZ':'UTC','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_SYSTEM':'/dev/null'}

class Refusal(ValueError):pass
def refuse(reason):raise Refusal(reason)
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def digest(data):return hashlib.sha256(data).hexdigest()
def relative(name):
    if type(name)!=str or not name or len(name.encode())>4096 or any(ord(c)<32 or ord(c)==127 for c in name) or '\\' in name:refuse('relative path')
    path=PurePosixPath(name)
    if path.is_absolute() or str(path)!=name or any(p in ('','..','.') for p in path.parts):refuse('relative path')
    return name
def identity(info):return (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def root_fd(path):
    path=Path(path)
    if not path.is_absolute() or path.resolve()!=path:refuse('canonical input root')
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
    if not stat.S_ISDIR(os.fstat(fd).st_mode):os.close(fd);refuse('directory input')
    return fd
def leaf(root,name):
    parts=PurePosixPath(relative(name)).parts;fd=os.dup(root)
    try:
        for part in parts[:-1]:
            next_fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(fd);fd=next_fd
        result=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=fd)
        return result
    finally:os.close(fd)
def sysroot_leaf(root,name):
    """Resolve bounded internal sysroot links without following host-absolute paths."""
    pending=list(PurePosixPath(relative(name)).parts);done=[];seen=set();hops=0
    if len(pending)>64:refuse('sysroot path depth')
    ancestors=[os.dup(root)]
    try:
        if not stat.S_ISDIR(os.fstat(ancestors[0]).st_mode):refuse('sysroot directory root')
        while pending:
            part=pending.pop(0)
            if part in ('','.'):continue
            if part=='..':
                if not done:refuse('sysroot link escaped')
                done.pop();os.close(ancestors.pop());continue
            parent=ancestors[-1];info=os.stat(part,dir_fd=parent,follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                current='/'.join(done+[part])
                if current in seen or hops>=32:refuse('sysroot link cycle or hops')
                target=os.readlink(part,dir_fd=parent)
                if identity(info)!=identity(os.stat(part,dir_fd=parent,follow_symlinks=False)):refuse('sysroot link replacement')
                if not target or target.startswith('/') or len(target.encode())>4096 or '\\' in target or any(ord(c)<32 or ord(c)==127 for c in target):refuse('sysroot bounded relative link')
                seen.add(current);hops+=1;pending=target.split('/')+pending
                if len(done)+len(pending)>64 or len('/'.join(done+pending).encode())>4096:refuse('sysroot path bound')
                continue
            if pending:
                if not stat.S_ISDIR(info.st_mode):refuse('sysroot directory ancestor')
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent)
                try:
                    if identity(info)!=identity(os.fstat(child)) or identity(info)!=identity(os.stat(part,dir_fd=parent,follow_symlinks=False)):refuse('sysroot directory replacement')
                except BaseException:os.close(child);raise
                ancestors.append(child);done.append(part);continue
            resolved='/'.join(done+[part])
            if not resolved.startswith(('lib/','usr/lib/')):refuse('sysroot public library path')
            if not stat.S_ISREG(info.st_mode):refuse('sysroot regular file')
            result=os.open(part,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
            try:
                held=os.fstat(result)
                if not stat.S_ISREG(held.st_mode) or identity(info)!=identity(held) or identity(info)!=identity(os.stat(part,dir_fd=parent,follow_symlinks=False)):refuse('sysroot file replacement')
                for index,component in enumerate(done):
                    named=os.stat(component,dir_fd=ancestors[index],follow_symlinks=False)
                    if not stat.S_ISDIR(named.st_mode) or identity(named)!=identity(os.fstat(ancestors[index+1])):refuse('sysroot ancestor replacement')
            except BaseException:os.close(result);raise
            return result,resolved
        refuse('sysroot regular file')
    finally:
        for ancestor in reversed(ancestors):os.close(ancestor)
def read_fd(fd,limit=MAX_FILE):
    before=os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_size>limit:refuse('regular bounded file')
    os.lseek(fd,0,os.SEEK_SET);chunks=[];size=0
    while True:
        data=os.read(fd,min(65536,limit-size+1))
        if not data:break
        size+=len(data)
        if size>limit:refuse('file grew over bound')
        chunks.append(data)
    if identity(before)!=identity(os.fstat(fd)) or size!=before.st_size:refuse('held input changed')
    return b''.join(chunks)
def measure(root,name,limit=MAX_FILE,retain=False):
    fd=leaf(root,name)
    try:
        data=read_fd(fd,limit);result={'kind':'file','sha256':digest(data),'bytes':len(data)}
        return (result,data) if retain else result
    finally:os.close(fd)
def write_new(path,data,executable=False):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o500 if executable else 0o400)
    try:
        at=0
        while at<len(data):at+=os.write(fd,data[at:])
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:refuse('independent captured file')
    finally:os.close(fd)
def resolved_link(name,target,inventory):
    if type(target)!=str or not target or target.startswith('/') or len(target.encode())>4096 or '\\' in target or any(ord(c)<32 for c in target):refuse('bounded internal link')
    pending=list(PurePosixPath(name).parent.parts)+target.split('/');done=[];seen=set();hops=0
    while pending:
        part=pending.pop(0)
        if part in ('','.'):continue
        if part=='..':
            if not done:refuse('link escaped')
            done.pop();continue
        done.append(part);current='/'.join(done)
        node=inventory.get(current)
        if node and node['kind']=='symlink':
            if current in seen or hops>=32:refuse('link cycle')
            seen.add(current);hops+=1;done.pop();pending=node['target'].split('/')+pending
    result='/'.join(done)
    if result not in inventory and not any(path.startswith(result+'/') for path in inventory):refuse('dangling link')
    return result
def validate_links(inventory):
    for name,node in inventory.items():
        if node['kind']=='symlink':resolved_link(name,node['target'],inventory)
        for parent in PurePosixPath(name).parents:
            if str(parent)=='.':continue
            if str(parent) in inventory:refuse('file/link ancestor')
def inventory(root,top_names=None):
    result={};total=0;visits=0;root_info=os.fstat(root)
    def walk(fd,prefix=''):
        nonlocal total,visits
        if len(PurePosixPath(prefix).parts)>64:refuse('directory depth')
        items=os.scandir(fd)
        try:
            for item in items:
                visits+=1
                if visits>MAX_ENTRIES*3:refuse('directory visit count')
                if not prefix and top_names is not None and item.name not in top_names:continue
                name=relative(prefix+item.name);info=item.stat(follow_symlinks=False)
                if len(result)>=MAX_ENTRIES:refuse('entry count')
                if stat.S_ISDIR(info.st_mode):
                    child=os.open(item.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd)
                    try:
                        if identity(info)!=identity(os.fstat(child)):refuse('directory replacement')
                        walk(child,name+'/')
                    finally:os.close(child)
                elif stat.S_ISLNK(info.st_mode):result[name]={'kind':'symlink','target':os.readlink(item.name,dir_fd=fd)}
                elif stat.S_ISREG(info.st_mode):
                    measured=measure(root,name);total+=measured['bytes'];result[name]=measured
                    if total>MAX_SOURCE:refuse('source aggregate')
                else:refuse('special input')
        finally:items.close()
    walk(root)
    if identity(root_info)!=identity(os.fstat(root)):refuse('root changed')
    validate_links(result);return dict(sorted(result.items()))
def git(root,*args):
    # Even Git data commands use bounded pipes and never load personal/global config.
    proc=subprocess.Popen(['git','-C',str(root),*args],env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    poll=None;chunks={};failed=True;leader_reaped=False
    try:
        poll=selectors.DefaultSelector();deadline=time.monotonic()+30
        for stream in (proc.stdout,proc.stderr):
            os.set_blocking(stream.fileno(),False);poll.register(stream,selectors.EVENT_READ);chunks[stream.fileno()]=bytearray()
        while poll.get_map():
            if time.monotonic()>=deadline:refuse('git timeout')
            for key,_ in poll.select(min(.1,max(0,deadline-time.monotonic()))):
                data=os.read(key.fd,65536)
                if not data:poll.unregister(key.fileobj);continue
                limit=MAX_JSON if key.fd==proc.stdout.fileno() else 4096
                if len(chunks[key.fd])+len(data)>limit:refuse('git output bound')
                chunks[key.fd].extend(data)
        try:code=proc.wait(timeout=max(.001,deadline-time.monotonic()))
        except subprocess.TimeoutExpired:refuse('git wait timeout')
        leader_reaped=True
        if code:refuse('git capture failed')
        result=bytes(chunks[proc.stdout.fileno()]);failed=False
        return result
    finally:
        try:
            if failed and not leader_reaped:
                try:os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                finally:
                    try:proc.wait(timeout=1)
                    except Exception:refuse('git cleanup reap uncertain')
        finally:
            try:
                if poll is not None:poll.close()
            finally:
                try:proc.stdout.close()
                finally:proc.stderr.close()
def git_entries(path,head):
    if not isinstance(head,str) or len(head)!=40 or any(c not in '0123456789abcdef' for c in head):refuse('git head')
    if git(path,'rev-parse','--show-object-format').strip()!=b'sha1':refuse('git object format')
    tree=git(path,'rev-parse',head+'^{tree}').decode().strip()
    if git(path,'rev-parse','HEAD^{tree}').decode().strip()!=tree:refuse('checkout tree differs')
    entries={}
    for record in git(path,'ls-tree','-rz','--full-tree',head).split(b'\0'):
        if not record:continue
        metadata,name=record.split(b'\t',1);mode,kind,oid=metadata.decode().split(' ');name=relative(name.decode('utf8'))
        if mode not in ('100644','100755','120000') or kind!='blob':refuse('git entry type')
        entries[name]=(mode,oid)
    return tree,entries
def eligible(name):
    return name.startswith(('src/','packages/','scripts/')) or name in ('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','bunfig.toml') or (name.startswith('tsconfig') and name.endswith('.json'))
def source_inventory(root,entries,names):
    result={};total=0
    for name in sorted(names):
        mode,oid=entries[name]
        if mode=='120000':
            parent=os.dup(root)
            try:
                parts=PurePosixPath(name).parts
                for part in parts[:-1]:
                    nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent);os.close(parent);parent=nxt
                text=os.readlink(parts[-1],dir_fd=parent);data=text.encode()
            finally:os.close(parent)
            result[name]={'kind':'symlink','target':text}
        else:
            value,data=measure(root,name,retain=True);result[name]=value;total+=len(data)
        if hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()!=oid:refuse('checkout bytes differ from git')
        if total>MAX_SOURCE or len(result)>MAX_ENTRIES:refuse('source budget')
    validate_links(result);return result
def copy_inventory(root,manifest,destination):
    destination=Path(destination);destination.mkdir(mode=0o700)
    for name,item in manifest.items():
        if item['kind']!='file':continue
        value,data=measure(root,name,retain=True)
        if value!=item:refuse('captured input changed')
        write_new(destination/name,data)
    for name,item in manifest.items():
        if item['kind']!='symlink':continue
        path=destination/name;path.parent.mkdir(parents=True,exist_ok=True,mode=0o700);path.symlink_to(item['target'])
    check=root_fd(destination.resolve())
    try:
        if inventory(check)!=manifest:refuse('copied inventory differs')
    finally:os.close(check)

def standalone_flags(output_fd,base_fd):
    """Pinned Bun 1.3.14 standalone layout inspection; never execute or load ELF data."""
    source_commit='0d9b296af33f2b851fcbf4df3e9ec89751734ba4'
    def layout(data):
        if len(data)<64 or data[:7]!=b'\x7fELF\x02\x01\x01':refuse('standalone ELF64 little endian')
        kind,machine,version=struct.unpack_from('<HHI',data,16)
        if kind not in (2,3) or machine!=183 or version!=1:refuse('standalone ARM64 ELF')
        phoff,shoff=struct.unpack_from('<QQ',data,32)
        ehsize,phsize,phcount,shsize,shcount,strings_index=struct.unpack_from('<HHHHHH',data,52)
        if ehsize!=64 or phsize!=56 or not 1<=phcount<=256 or phoff<64 or phoff+56*phcount>len(data):refuse('standalone program table')
        if shsize!=64 or not 1<=shcount<=512 or shoff<64 or shoff+64*shcount>len(data) or not 0<strings_index<shcount:refuse('standalone section table')
        sections=[struct.unpack_from('<IIQQQQIIQQ',data,shoff+64*i) for i in range(shcount)]
        strings_section=sections[strings_index];strings_at,strings_size=strings_section[4:6]
        if strings_section[1]!=3 or not 1<=strings_size<=1024*1024 or strings_at+strings_size>len(data):refuse('standalone section strings')
        strings=data[strings_at:strings_at+strings_size];bun_sections=[]
        for section in sections:
            name_at=section[0]
            if name_at>=len(strings):refuse('standalone section name')
            end=strings.find(b'\0',name_at,min(len(strings),name_at+4097))
            if end<0:refuse('standalone section name bound')
            if strings[name_at:end]==b'.bun':bun_sections.append(section)
        if len(bun_sections)!=1:refuse('standalone unique .bun section')
        section=bun_sections[0];address,at,size=section[3:6]
        if section[1]!=1 or size<8 or at+size>len(data) or address+size>2**64:refuse('standalone .bun PROGBITS bounds')
        loads=[]
        for i in range(phcount):
            ptype,_flags,offset,va,_pa,filesize,memsize,_align=struct.unpack_from('<IIQQQQQQ',data,phoff+56*i)
            if ptype!=1:continue
            if filesize>memsize or offset+filesize>len(data) or va+memsize>2**64:refuse('standalone load bounds')
            for old_offset,old_va,old_file,old_mem in loads:
                if (filesize and old_file and offset<old_offset+old_file and old_offset<offset+filesize) or (memsize and old_mem and va<old_va+old_mem and old_va<va+memsize):refuse('standalone overlapping load map')
            loads.append((offset,va,filesize,memsize))
        return {'fileOffset':at,'virtualAddress':address,'bytes':size},loads
    def mapped(loads,at,size,expected):
        file_maps=[load for load in loads if load[0]<=at and at+size<=load[0]+load[2]]
        if len(file_maps)!=1:refuse('standalone unique file map')
        load=file_maps[0];va=load[1]+at-load[0]
        virtual_maps=[item for item in loads if item[1]<=va and va+size<=item[1]+item[3]]
        if va!=expected or len(virtual_maps)!=1 or virtual_maps[0]!=load:refuse('standalone virtual map')
    base=read_fd(base_fd,MAX_ELF);output=read_fd(output_fd,MAX_ELF)
    base_section,base_loads=layout(base);section,loads=layout(output)
    original_at=base_section['fileOffset'];original_va=base_section['virtualAddress']
    mapped(base_loads,original_at,8,original_va)
    if struct.unpack_from('<Q',base,original_at)[0]!=0:refuse('standalone base slot not zero')
    if original_at+8>len(output):refuse('standalone original slot bounds')
    mapped(loads,original_at,8,original_va)
    at,size,address=section['fileOffset'],section['bytes'],section['virtualAddress']
    if struct.unpack_from('<Q',output,original_at)[0]!=address or address==0:refuse('standalone original slot pointer')
    if at<original_at+8 and original_at<at+size:refuse('standalone original slot overlaps payload')
    mapped(loads,at,size,address)
    payload_size=struct.unpack_from('<Q',output,at)[0];trailer=b'\n---- Bun! ----\n'
    if size!=8+payload_size or payload_size<32+len(trailer):refuse('standalone payload size')
    payload=output[at+8:at+size]
    if not payload.endswith(trailer):refuse('standalone payload trailer')
    offsets_at=len(payload)-len(trailer)-32
    byte_count,modules_at,modules_size,entry,argv_at,argv_size,flags=struct.unpack_from('<QIIIIII',payload,offsets_at)
    if byte_count!=offsets_at:refuse('standalone offsets byte count')
    if flags&0xfffffff0:refuse('standalone reserved flags')
    def pointer(at,size):
        if at>byte_count or size>byte_count-at:refuse('standalone pointer range')
    pointer(modules_at,modules_size);pointer(argv_at,argv_size)
    if argv_size!=0 or argv_at>=byte_count or payload[argv_at]!=0:refuse('standalone empty exec argv terminator')
    module_count=modules_size//52
    if modules_size%52 or not 1<=module_count<=MAX_ENTRIES or entry>=module_count:refuse('standalone modules or entry')
    for module_at in range(modules_at,modules_at+modules_size,52):
        for slot in range(6):pointer(*struct.unpack_from('<II',payload,module_at+slot*8))
    return {'version':'1.3.14','sourceCommit':source_commit,'layout':'bun-1.3.14-elf64le-arm64-standalone',
        'baseSha256':digest(base),'outputSha256':digest(output),'flagsWord':flags,'flagsNibble':flags&15,'disableDefaultEnvFiles':bool(flags&1),
        'disableAutoloadBunfig':bool(flags&2),'disableAutoloadTsconfig':bool(flags&4),'disableAutoloadPackageJson':bool(flags&8),
        'payload':{'sha256':digest(payload),'bytes':len(payload),'byteCount':byte_count,'modulesOffset':modules_at,'modulesBytes':modules_size,
            'moduleCount':module_count,'entryPointId':entry,'compileExecArgvOffset':argv_at,'compileExecArgvBytes':argv_size},
        'originalSlot':{'fileOffset':original_at,'virtualAddress':original_va},'section':section}

def elf_metadata(fd):
    """Bounded ELF64 little-endian data inspection only, never readelf/ldd execution."""
    data=read_fd(fd,MAX_ELF)
    if len(data)<64 or data[:6]!=b'\x7fELF\x02\x01':refuse('ELF64 little endian')
    kind,machine=struct.unpack_from('<HH',data,16)
    if machine!=183 or kind not in (2,3):refuse('ARM64 ELF type')
    offset=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54)
    if size!=56 or count>256 or offset+size*count>len(data):refuse('ELF program headers')
    loads=[];dynamic=None;interpreter=None
    for i in range(count):
        ptype,_flags,at,va,_pa,filesize,_mem,_align=struct.unpack_from('<IIQQQQQQ',data,offset+i*size)
        if at+filesize>len(data):refuse('ELF segment bounds')
        if ptype==1:loads.append((va,filesize,at))
        elif ptype==2:
            if dynamic is not None or filesize%16 or filesize>65536:refuse('ELF dynamic table')
            dynamic=(at,filesize)
        elif ptype==3:
            raw=data[at:at+filesize]
            if interpreter is not None or not raw.endswith(b'\0') or len(raw)>4096:refuse('ELF interpreter')
            interpreter=raw[:-1].decode('ascii')
    values={};needed=[]
    if dynamic:
        at,length=dynamic;terminated=False
        for pos in range(at,at+length,16):
            tag,value=struct.unpack_from('<qQ',data,pos)
            if tag==0:terminated=True;break
            if tag==1:needed.append(value)
            elif tag in (5,10,14,15,29):
                if tag in values:refuse('duplicate ELF dynamic key')
                values[tag]=value
        if not terminated or len(needed)>MAX_DEPENDENCIES:refuse('ELF dynamic bound')
    strings=b''
    if needed or any(key in values for key in (14,15,29)):
        if 5 not in values or 10 not in values or values[10]>4*1024*1024:refuse('ELF string table')
        for va,length,at in loads:
            if va<=values[5] and values[5]+values[10]<=va+length:strings=data[at+values[5]-va:at+values[5]-va+values[10]];break
        if not strings:refuse('ELF mapped strings')
    def text(at):
        if at>=len(strings):refuse('ELF string offset')
        end=strings.find(b'\0',at)
        if end<0 or end-at>4096:refuse('ELF string bound')
        return strings[at:end].decode('ascii')
    names=[text(at) for at in needed]
    if any(not name or '/' in name or '\\' in name or '..' in name or any(ord(c)<33 for c in name) for name in names):refuse('ELF dependency name')
    if 15 in values or 29 in values:refuse('ELF search path')
    return {'type':kind,'machine':machine,'interpreter':interpreter,'needed':names,'soname':text(values[14]) if 14 in values else None,'rpath':None,'runpath':None}
