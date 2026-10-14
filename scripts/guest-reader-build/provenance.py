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
OVERLAY_HEAD='f6d88d9a2f8ae15bb50afb98868183ae769e3b11'
C_SOURCE='packages/runtime/src/guest/linux-instruction-reader-compartment.c'
HEADER='packages/runtime/src/guest/linux-compartment.h'
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
        for item in sorted(os.scandir(fd),key=lambda item:item.name):
            if not prefix and top_names is not None and item.name not in top_names:continue
            visits+=1
            if visits>MAX_ENTRIES*3:refuse('directory visit count')
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
    walk(root)
    if identity(root_info)!=identity(os.fstat(root)):refuse('root changed')
    validate_links(result);return dict(sorted(result.items()))
def git(root,*args):
    # Even Git data commands use bounded pipes and never load personal/global config.
    proc=subprocess.Popen(['git','-C',str(root),*args],env=ENV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    poll=selectors.DefaultSelector();chunks={};deadline=time.monotonic()+30
    for stream in (proc.stdout,proc.stderr):
        os.set_blocking(stream.fileno(),False);poll.register(stream,selectors.EVENT_READ);chunks[stream.fileno()]=bytearray()
    try:
        while poll.get_map():
            if time.monotonic()>=deadline:refuse('git timeout')
            for key,_ in poll.select(min(.1,max(0,deadline-time.monotonic()))):
                data=os.read(key.fd,65536)
                if not data:poll.unregister(key.fileobj);continue
                limit=MAX_JSON if key.fd==proc.stdout.fileno() else 4096
                if len(chunks[key.fd])+len(data)>limit:refuse('git output bound')
                chunks[key.fd].extend(data)
        if proc.wait(timeout=max(.001,deadline-time.monotonic())):refuse('git capture failed')
        return bytes(chunks[proc.stdout.fileno()])
    finally:
        poll.close()
        if proc.poll() is None:
            os.killpg(proc.pid,signal.SIGKILL);proc.wait()
        proc.stdout.close();proc.stderr.close()
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
