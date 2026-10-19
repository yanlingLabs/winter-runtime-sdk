#!/usr/bin/env python3
"""Verify a downloaded guided compile packet against its pin, in memory. DATA only.

It streams the tar.gz once, hashes every member, and compares the result with the packet inventory and the pin file.
It extracts nothing to disk, imports nothing from the archive, and executes nothing: every compiled output is bytes
that are hashed and compared. It does not rehydrate a packet and it does not admit one. Root callers are refused.

    python3 -I -B scripts/guest-guided-intake/verify_packet.py <guided-packet.tar.gz> <packet-inventory.json> [--pin <pin.json>]

Exit 0 only if every check holds; the JSON report on stdout lists each check as true or false."""
import hashlib,json,os,posixpath,stat,sys,tarfile
from pathlib import Path

HERE=Path(__file__).resolve().parent
MAX_MEMBER=128*1024*1024
MAX_PACKET=1024**3
MAX_ENTRIES=20000
MAX_JSON=16*1024*1024
SMALL=('receipt.json','inputs.json','compiler-acquisition.json')

def digest_json(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def default_pin():
    found=sorted(HERE.glob('compile-*.pin.json'))
    if len(found)!=1:raise SystemExit('exactly one compile pin required')
    return found[0]

def hash_file(path,limit):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>limit:raise ValueError('not a bounded regular file')
        h=hashlib.sha256();size=0
        while True:
            chunk=os.read(fd,1<<20)
            if not chunk:break
            h.update(chunk);size+=len(chunk)
            if size>limit:raise ValueError('file grew')
        return h.hexdigest(),size
    finally:os.close(fd)

def audit(archive,inventory,pin):
    """Returns (checks, details). `checks` maps a name to True/False; details carries counts for the report."""
    checks={};details={}
    def check(name,ok):checks[name]=bool(ok)
    archive_sha,archive_bytes=hash_file(archive,2*MAX_PACKET)
    inv_sha,inv_bytes=hash_file(inventory,MAX_JSON)
    check('archive sha256 and size equal the pin',(archive_sha,archive_bytes)==(pin['archive']['sha256'],pin['archive']['bytes']))
    check('inventory sha256 and size equal the pin',(inv_sha,inv_bytes)==(pin['inventory']['sha256'],pin['inventory']['bytes']))
    inv=json.loads(Path(inventory).read_bytes());files=inv.get('files',{})
    check('inventory header equals the pin',all(inv.get(k)==v for k,v in (('kind',pin['inventory']['kind']),('builderHead',pin['builder']['head']),('workflowHead',pin['workflowHead']),('fileCount',pin['inventory']['fileCount']),('fileBytes',pin['inventory']['fileBytes']),('archiveSha256',pin['archive']['sha256']),('archiveBytes',pin['archive']['bytes']),('excludedScratch',pin['inventory']['excludedScratch'])))
          and all(inv.get(k) is False for k in ('outputsExecuted','nativeAdmission','vmExecutionVerified','activationEnabled')))
    check('inventory counts are its own',len(files)==inv.get('fileCount') and sum(v['bytes'] for v in files.values() if v['kind']=='file')==inv.get('fileBytes'))
    check('inventory within the packet bounds',len(files)<=MAX_ENTRIES and inv.get('fileBytes',0)<=MAX_PACKET)
    seen=set();tar_problems=[];small={};modes={}
    members_ok=True
    with open(archive,'rb') as raw:
        tar=tarfile.open(fileobj=raw,mode='r|gz')
        for member in tar:
            name=member.name
            if name in seen:tar_problems.append(('duplicate',name));continue
            seen.add(name)
            if name.startswith('/') or '\\' in name or posixpath.normpath(name)!=name or '..' in name.split('/'):tar_problems.append(('path',name))
            if not (member.isreg() or member.issym()):tar_problems.append(('type',name));continue
            if member.mode&0o7000:tar_problems.append(('setuid/setgid/sticky',name))
            if (member.uid,member.gid,member.mtime)!=(0,0,0):tar_problems.append(('owner/mtime',name))
            key=('reg ' if member.isreg() else 'sym ')+oct(member.mode);modes[key]=modes.get(key,0)+1
            entry=files.get(name)
            if entry is None:tar_problems.append(('not in inventory',name));continue
            if member.issym():
                target=member.linkname
                resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),target))
                if entry.get('kind')!='symlink' or entry.get('target')!=target:tar_problems.append(('symlink differs',name))
                if target.startswith('/') or resolved=='..' or resolved.startswith('../') or '\\' in target:tar_problems.append(('symlink escapes',name))
                if member.mode!=0o777:tar_problems.append(('symlink mode',name))
                continue
            if member.mode!=0o400:tar_problems.append(('file mode',name))
            if entry.get('kind')!='file' or member.size!=entry.get('bytes') or member.size>MAX_MEMBER:tar_problems.append(('kind or size',name));continue
            h=hashlib.sha256();count=0;chunks=[]
            stream=tar.extractfile(member)
            while True:
                chunk=stream.read(1<<20)
                if not chunk:break
                h.update(chunk);count+=len(chunk)
                if name in SMALL:chunks.append(chunk)
            if h.hexdigest()!=entry['sha256'] or count!=entry['bytes']:tar_problems.append(('hash',name))
            if name in SMALL:small[name]=b''.join(chunks)
    check('archive members equal the inventory exactly',not tar_problems and seen==set(files))
    details['tarProblems']=tar_problems[:10];details['memberModes']=modes
    # Links resolve to members, and split into the pinned aliases and dependency links.
    links={k:v['target'] for k,v in files.items() if v['kind']=='symlink'}
    def exists(path):return path in files or any(k.startswith(path+'/') for k in files)
    check('every link target is a packet member',all(exists(posixpath.normpath(posixpath.join(posixpath.dirname(k),t))) for k,t in links.items()))
    aliases={k:t for k,t in links.items() if not k.startswith('dependencies/')}
    check('links split into the pinned aliases and dependency links',len(links)==pin['symlinks']['total'] and aliases==pin['resolverBindings'] and len(links)-len(aliases)==pin['symlinks']['dependencyLinks']==pin['dependencies']['links'])
    # Pinned members.
    expected={}
    for group in ('roles','natives'):
        for name,item in pin['artifacts'][group].items():expected['artifacts/'+name]=item
    for name,item in pin['metafiles'].items():expected[f'artifacts/{name}.metafile.json']=item
    expected.update(pin['environment'])
    for key in ('receipt','inputs','compilerAcquisition'):expected[pin[key]['path']]=pin[key]
    expected[pin['bun']['stageBase']['path']]=pin['bun']['stageBase']
    check('every pinned member equals the inventory',all(files.get(k,{}).get('sha256')==v['sha256'] and files.get(k,{}).get('bytes')==v['bytes'] for k,v in expected.items()))
    check('the artifacts directory holds exactly four roles, six natives and four metafiles',sorted(k for k in files if k.startswith('artifacts/'))==sorted(k for k in expected if k.startswith('artifacts/')) and len(pin['artifacts']['roles'])==4 and len(pin['artifacts']['natives'])==6)
    check('the environment holds exactly the pinned libraries',sorted(k for k in files if k.startswith('environment/'))==sorted(pin['environment']))
    check('the Bun base is the pinned executable',pin['bun']['stageBase']['sha256']==pin['bun']['executableSha256'])
    store={k:(v['sha256'] if v['kind']=='file' else ['symlink',v['target']]) for k,v in files.items() if k.startswith('dependencies/')}
    check('the dependency store equals the pinned store',len(store)==pin['dependencies']['storeEntries'] and digest_json(store)==pin['dependencies']['storeSha256'])
    builder={k.split('/',2)[2]:v['sha256'] for k,v in files.items() if k.startswith('source/builder/') and v['kind']=='file'}
    check('the builder origin files equal the pinned builder files',builder==pin['builder']['files'])
    # Receipt and inputs, parsed from the archive bytes.
    try:
        receipt=json.loads(small['receipt.json']);inputs=json.loads(small['inputs.json']);acquisition=json.loads(small['compiler-acquisition.json'])
        got={o['role']:(o['head'],o['tree'],o['inventorySha256'],len(o['eligibleFiles'])) for o in inputs['origins'] if o['role']!='builder'}
        want={role:(o['head'],o['tree'],o['inventorySha256'],o['fileCount']) for role,o in pin['origins'].items()}
        check('inputs.json origins equal the pinned origins',got==want and [o['head'] for o in inputs['origins'] if o['role']=='builder']==[pin['builder']['head']])
        check('receipt artifacts equal the inventory',all(receipt['artifacts'][n]['sha256']==files['artifacts/'+n]['sha256'] for n in receipt['artifacts']) and set(receipt['artifacts'])==set(pin['artifacts']['roles'])|set(pin['artifacts']['natives']))
        check('receipt and acquisition claim nothing was executed or verified',all(receipt.get(k) is False for k in ('linuxExecutionVerified','vmExecutionVerified','activationEnabled','nativeOwnerVerified','autoloadExecutionVerified','dynamicRuntimeImportsVerified'))
              and receipt['recipe']['outputsExecuted'] is False and acquisition.get('outputsExecuted') is False and acquisition.get('archivePinMatched') is True and acquisition.get('basePinMatched') is True)
        check('receipt resolver bindings equal the pinned aliases',{k:v['target'] for k,v in receipt['resolverBindings'].items()}==pin['resolverBindings'])
        text=small['receipt.json']+small['inputs.json']
        check('receipt and inputs name no runner or home path',not any(s.encode() in text for s in ('/var/tmp','/home/runner','/Users/','/private/')))
    except (KeyError,ValueError,TypeError):
        check('receipt, inputs and acquisition parse',False)
    details['placeholders']=sorted(n for n,v in pin['artifacts']['roles'].items() if v.get('placeholder'))
    details['symlinks']={'total':len(links),'aliases':len(aliases)}
    return checks,details

EXIT_HOLDS,EXIT_FAILED,EXIT_ERROR=0,1,2
def run(argv):
    if os.geteuid()==0:raise SystemExit('unprivileged verification required')
    args=argv[1:];pin_path=None
    if '--pin' in args:
        at=args.index('--pin');pin_path=Path(args[at+1]);del args[at:at+2]
    if len(args)!=2:raise SystemExit('usage: verify_packet.py <tar.gz> <inventory.json> [--pin <pin.json>]')
    pin=json.loads((pin_path or default_pin()).read_bytes())
    checks,details=audit(args[0],args[1],pin)
    print(json.dumps({'kind':'winter-guided-packet-verification','allChecksHold':all(checks.values()),'checks':checks,**details,'outputsExecuted':False},indent=1,sort_keys=True))
    return EXIT_HOLDS if all(checks.values()) else EXIT_FAILED
def main(argv):
    """Stable exit codes: 0 only when every check holds (allChecksHold true), 1 when a check failed (allChecksHold false),
    2 for anything else (usage, I/O, a malformed archive or pin, running as root). The hosted path binds nothing unless 0."""
    try:return run(argv)
    except SystemExit as stop:
        print(stop.code if isinstance(stop.code,str) else 'verification refused',file=sys.stderr);return EXIT_ERROR
    except Exception:
        print('verification error',file=sys.stderr);return EXIT_ERROR
if __name__=='__main__':raise SystemExit(main(sys.argv))
