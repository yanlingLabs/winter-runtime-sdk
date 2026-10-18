#!/usr/bin/env python3
"""Verify and unpack the two downloaded inputs of the guided compile as bounded DATA. It never executes either one.

`bun`: the pinned Bun zip must match its archive SHA-256, hold only the one regular base executable, and that
executable must match its pinned SHA-256. `deps`: every pinned registry tarball must match its sha512 and unpack as plain
regular files into a pnpm-style virtual store `<fixture>/dependencies/.pnpm` (no links, devices, absolute or parent paths).
The curl, the strict checksum check and the order are the workflow's; this file is the second, independent check."""
import hashlib,importlib.util,io,json,os,stat,sys,tarfile,zipfile
from pathlib import Path,PurePosixPath
_spec=importlib.util.spec_from_file_location('guided_pins',Path(__file__).with_name('pins.py'))
pins=importlib.util.module_from_spec(_spec);_spec.loader.exec_module(pins)

LIMIT=128*1024*1024
DEP_FILES=20000
DEP_BYTES=32*1024*1024
DEP_BYTES_TOTAL=256*1024*1024

class Refusal(ValueError):pass
def refuse(reason):raise Refusal(reason)
identity=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
def read_archive(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size>limit:refuse('archive bound')
        with os.fdopen(os.dup(fd),'rb') as source:data=source.read(limit+1)
        if len(data)!=before.st_size or identity(os.fstat(fd))!=identity(before):refuse('archive changed')
        return data
    finally:os.close(fd)
def write_new(path,data,mode):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,mode)
    try:
        at=0
        while at<len(data):at+=os.write(fd,data[at:])
        if os.fstat(fd).st_nlink!=1:refuse('independent file')
    finally:os.close(fd)

def extract_bun(archive,root,bun=None):
    bun=bun or pins.BUN;root=Path(root)
    data=read_archive(archive,LIMIT)
    if hashlib.sha256(data).hexdigest()!=bun['archiveSha256']:refuse('Bun archive pin')
    with zipfile.ZipFile(io.BytesIO(data)) as zipped:
        members=zipped.infolist();wanted=bun['archiveEntry']
        folder=wanted.rsplit('/',1)[0]+'/'
        if len(members)>2 or {item.filename for item in members} not in ({wanted},{folder,wanted}):refuse('Bun archive inventory')
        item=zipped.getinfo(wanted)
        if item.file_size>LIMIT or item.flag_bits&1 or not stat.S_ISREG(item.external_attr>>16):refuse('Bun archive regular base')
        base=zipped.read(item)
    if len(base)!=item.file_size or hashlib.sha256(base).hexdigest()!=bun['executableSha256']:refuse('Bun executable pin')
    write_new(root/'linux-bun',base,0o500)
    record={'formatVersion':1,'kind':'winter-guided-compiler-acquisition','version':bun['version'],'archiveSha256':hashlib.sha256(data).hexdigest(),'archiveBytes':len(data),'baseSha256':hashlib.sha256(base).hexdigest(),'baseBytes':len(base),'archivePinMatched':True,'basePinMatched':True,'outputsExecuted':False,'nativeAdmission':False}
    write_new(root/'acquisition.json',(json.dumps(record,sort_keys=True)+'\n').encode(),0o400)
    return record

def extract_deps(tarballs,root,dependencies=None):
    """Unpack every pinned registry tarball into a pnpm-style virtual store under `<root>/dependencies/.pnpm`.
    Each tarball must match its pinned sha512, hold only regular files below `package/`, and name the pinned
    package and version. Dependency links are created from the pin, never from package contents."""
    dependencies=dependencies or pins.DEPENDENCIES;tarballs=Path(tarballs);root=Path(root)
    store=root/'dependencies'/'.pnpm';packages=dependencies['packages'];ids=[item['id'] for item in packages]
    if len(set(ids))!=len(ids) or not 1<=len(packages)<=64:refuse('dependency pin set')
    files=0;total=0
    for item in packages:
        directory=pins.package_directory(item['id']);data=read_archive(tarballs/(directory+'.tgz'),DEP_BYTES)
        if hashlib.sha512(data).hexdigest()!=item['sha512']:refuse('dependency tarball pin: '+item['id'])
        target=store/directory/'node_modules'/item['name'];names=set()
        with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
            for member in tar:
                if member.isdir():continue
                files+=1
                if files>DEP_FILES:refuse('dependency entry count')
                if not member.isreg() or member.islnk() or member.issym():refuse('dependency regular files only')
                path=PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or '' in path.parts or len(path.parts)<2 or path.parts[0]!='package' or '\\' in member.name:refuse('dependency member path')
                relative=PurePosixPath(*path.parts[1:]).as_posix()
                if relative in names or any(ord(c)<32 or ord(c)==127 for c in relative):refuse('dependency member name')
                names.add(relative);total+=member.size
                if total>DEP_BYTES_TOTAL:refuse('dependency size')
                body=tar.extractfile(member).read()
                if len(body)!=member.size:refuse('dependency member size')
                destination=target/relative;destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700);write_new(destination,body,0o400)
        manifest=json.loads((target/'package.json').read_bytes())
        if manifest.get('name')!=item['name'] or manifest.get('version')!=item['version']:refuse('dependency package identity: '+item['id'])
    for item in packages:
        for name,dependency in item['dependencies'].items():
            if dependency not in ids:refuse('dependency link outside the pin set')
            link=store/pins.package_directory(item['id'])/'node_modules'/name;link.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            aim=store/pins.package_directory(dependency)/'node_modules'/name
            link.symlink_to(os.path.relpath(aim,link.parent))
    return {'packages':len(packages),'files':files,'bytes':total}

def main(argv):
    if len(argv)!=4 or argv[1] not in ('bun','deps'):raise SystemExit('usage: acquire.py bun <zip> <fixture-dir> | deps <tarball-dir> <fixture-dir>')
    result=(extract_bun if argv[1]=='bun' else extract_deps)(argv[2],argv[3])
    print(json.dumps(result,sort_keys=True))
if __name__=='__main__':main(sys.argv)
