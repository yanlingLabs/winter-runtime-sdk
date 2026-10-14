"""Hosted reader bootstrap SOURCE: no autorun, token or admission by shape.

The new externally reviewed workflow must admit these bytes before execution.
Tests inject tables; no privileged/native case executes during source validation.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import types
from datetime import datetime, timezone

ACQUISITION_SHA = 'b8d1239464603c040d1d179651e8a7d75dbbd7ccd92235d7b84158e4f57273d9'
INTAKE_SHA = '38e2546eb85fb10d06175871960e5370bac15f26aa9f5e0916fd3e880b42aaaa'
PIN_SHA = 'e319e8a859dcc891a59c8a2d4134aa02ad8dd0da94bca45b339e49fdc92bae2b'
SOURCE_MAX = 64 * 1024
MOUNT_MAX = 1024 * 1024


class Refusal(ValueError): pass


def require(value, reason):
    if not value: raise Refusal(reason)


def stable_identity(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_uid,info.st_gid,
            info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)


def checked_bytes(path, digest, *, limit=SOURCE_MAX, root_copy=False):
    """Bound a held independent file. Root-copy paths have protected ancestry."""
    path=Path(path)
    require(path.is_absolute() and len(path.parts)<=64 and '..' not in path.parts,
            'closed bootstrap source path')
    fds=[]
    try:
        upper=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.append(upper)
        edges=[]
        for part in path.parts[1:-1]:
            held=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=upper)
            fds.append(held);edges.append((upper,part,held));upper=held
        fd=os.open(path.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=upper)
        fds.append(fd);edges.append((upper,path.name,fd))
        before=os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=limit,
                'bounded independent bootstrap source')
        if root_copy:
            for ancestor in fds[:-1]:
                info=os.fstat(ancestor)
                require(info.st_uid==0 and not stat.S_IMODE(info.st_mode)&0o022,
                        'protected bootstrap source ancestry')
            require(before.st_uid==0 and stat.S_IMODE(before.st_mode)==0o400,
                    'Root readonly bootstrap source')
        raw=bytearray()
        while True:
            chunk=os.read(fd,min(65536,limit+1-len(raw)))
            if not chunk:break
            raw.extend(chunk);require(len(raw)<=limit,'bootstrap source byte bound')
        after=os.fstat(fd)
        require(stable_identity(before)==stable_identity(after) and len(raw)==before.st_size
                and hashlib.sha256(raw).hexdigest()==digest,'bootstrap source hash/identity')
        for parent,name,held in edges:
            named,opened=os.stat(name,dir_fd=parent,follow_symlinks=False),os.fstat(held)
            require((named.st_dev,named.st_ino,named.st_mode)==
                    (opened.st_dev,opened.st_ino,opened.st_mode),'bootstrap source replaced')
        return bytes(raw)
    finally:
        failed=[]
        for fd in reversed(fds):
            try:os.close(fd)
            except OSError:failed.append(fd)
        if failed:
            error=Refusal('bootstrap source descriptors retained');error.retained_fds=failed
            raise error


def load_checked(name,path,digest,*,root_copy=False):
    require(name not in sys.modules,'bootstrap alias occupied')
    raw=checked_bytes(path,digest,root_copy=root_copy)
    module=types.ModuleType(name);module.__file__=str(path);module.__package__=''
    sys.modules[name]=module
    try:
        exec(compile(raw,str(path),'exec'),module.__dict__)
        checked_bytes(path,digest,root_copy=root_copy)
        require(sys.modules.get(name) is module,'bootstrap alias replaced')
        return module
    except BaseException:
        # Keep the checked module identity reachable; no fallback/retry import.
        raise


def prepare_data(repository,zip_path,metadata,private_scratch,*,now=None,loader=load_checked):
    """Token-free unprivileged stage using the merged acquisition and intake."""
    require(os.geteuid()!=0 and sys.flags.isolated and sys.flags.no_site
            and sys.dont_write_bytecode,'isolated unprivileged data stage required')
    require(type(metadata) is dict and all(type(key) is str for key in metadata),
            'plain downloader metadata required')
    repository=Path(repository);private_scratch=Path(private_scratch)
    acq=loader('_reader_acquisition',repository/'scripts/guest-reader-native/acquisition.py',ACQUISITION_SHA)
    intake=loader('_reader_intake',repository/'scripts/guest-reader-intake/intake.py',INTAKE_SHA)
    expected=acq.PRODUCTION_PINS.metadata
    require(set(metadata)==set(vars(expected)) and all(type(metadata[key]) is
            type(value) and metadata[key]==value for key,value in vars(expected).items()),
            'exact downloader metadata conversion')
    pin=json.loads(checked_bytes(repository/'scripts/guest-reader-intake/compile-38502659264.pin.json',PIN_SHA))
    record=acq.acquire_local_zip(zip_path,private_scratch,acq.ArtifactMetadata(**metadata),
        now=datetime.now(timezone.utc) if now is None else now)
    members={member.name:Path(member.path) for member in record.members}
    destination=private_scratch/'packet'
    with intake.validate_packet(members['reader-packet.tar.gz'],members['packet-inventory.json'],pin=pin) as validated:
        intake.rehydrate_packet(validated,destination,layout='packet')
    checked_bytes(repository/'scripts/guest-reader-native/acquisition.py',ACQUISITION_SHA)
    checked_bytes(repository/'scripts/guest-reader-intake/intake.py',INTAKE_SHA)
    return {'acquisition':record.to_dict(),'packet':str(destination),
            'inventory':str(members['packet-inventory.json']),
            'nativeExecution':False,'sourceAdmission':False}


def snapshot_mounts():
    """Original parent namespace DATA, not a C receipt or native admission."""
    fd=os.open('/proc/self/mountinfo',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        raw=bytearray()
        while True:
            chunk=os.read(fd,min(65536,MOUNT_MAX+1-len(raw)))
            if not chunk:break
            raw.extend(chunk);require(len(raw)<=MOUNT_MAX,'outer mount snapshot bound')
        require(raw and raw.endswith(b'\n'),'complete outer mount snapshot')
        return hashlib.sha256(raw).hexdigest()
    finally:os.close(fd)


def observed_effects(cases,snapshot=snapshot_mounts):
    """Trusted observation only; all native lifecycle remains existing effects."""
    baseline=snapshot();observations=[]
    class Observed(cases.LinuxEffects):
        def __init__(self,kind):self.kind=kind
        def launch(self,*args):
            require(snapshot()==baseline,'outer namespace changed before launch')
            return super().launch(*args)
        def receive_init(self,*args):
            result=super().receive_init(*args)
            value=snapshot();require(value==baseline,'outer namespace changed while live')
            observations.append({'kind':self.kind,'phase':'live','sha256':value})
            return result
        def close_confirmed(self,*args):
            result=super().close_confirmed(*args)
            value=snapshot();require(value==baseline,'outer namespace changed after teardown')
            observations.append({'kind':self.kind,'phase':'after','sha256':value})
            return result
    return lambda kind:Observed(kind),observations,baseline


def run_root(repository,protected_parent,data,wrapper_digest,*,wrapper_source,loader=load_checked):
    """Unexecuted Root stage. Caller must externally admit this bootstrap first."""
    require(sys.platform=='linux' and os.getuid()==0 and os.geteuid()==0
            and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            'isolated actual Root stage required')
    repository=Path(repository);protected_parent=Path(protected_parent)
    raw=checked_bytes(wrapper_source,wrapper_digest)
    # Parent is fresh, Root-owned0700, created by the reviewed inline workflow.
    require(protected_parent.is_absolute() and protected_parent.parent==Path('/run'),
            'fixed protected Root parent venue')
    parent=os.open(protected_parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        info=os.fstat(parent)
        require(info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o700,'private Root parent')
        target=protected_parent/'wrapper.py'
        fd=os.open('wrapper.py',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
        try:
            at=0
            while at<len(raw):
                count=os.write(fd,raw[at:]);require(count>0,'Root wrapper copy');at+=count
            os.fsync(fd);os.fchmod(fd,0o400)
        finally:os.close(fd)
    finally:os.close(parent)
    wrapper=loader('_reader_root_wrapper',target,wrapper_digest,root_copy=True)
    wrapper.check_acquisition_record(data['acquisition'],datetime.now(timezone.utc))
    lease=wrapper.copy_external_sources(repository/'scripts/guest-reader-native',protected_parent/'sources')
    # Default effects receive an optional trusted instrumentation factory only;
    # this seam never supplies scope or native authority.
    modules=wrapper.load_external_modules(lease)
    factory,observations,baseline=observed_effects(modules['native_cases'])
    result=wrapper.run_cases(lease,data['packet'],data['inventory'],protected_parent/'runtime',
        protected_parent/'fixture',acquisition_record=data['acquisition'],effects_factory=factory,
        loaded_modules=modules)
    lease.recheck();checked_bytes(target,wrapper_digest,root_copy=True)
    result['outerMountsSha256']=baseline;result['outerObservations']=observations
    return result
