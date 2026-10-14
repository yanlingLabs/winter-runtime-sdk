"""Hosted reader bootstrap SOURCE: no autorun, token or admission by shape.

The new externally reviewed workflow must admit these bytes before execution.
Tests inject tables; no privileged/native case executes during source validation.
"""
import hashlib
import base64
import binascii
import errno
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



# Generated from literal require/Refusal/ValueError messages in the seven reviewed modules.
ERROR_REASONS = (
    'Root fixture directory scope',
    'Root producer required',
    'Root readonly bootstrap source',
    'Root wrapper copy',
    'Root-owned 0700 launch parent required',
    'Root-owned protected launch ancestry required',
    'UID reservation process bound',
    'acquisition member pin mismatch',
    'acquisition observation flags',
    'acquisition observation time',
    'actual Linux Root caller required',
    'actual Root ownership required',
    'actual child handle envelope',
    'actual handle transfer',
    'actual initial I required',
    'actual intermediate launcher reap',
    'actual producer reap',
    'adopted init actually reaped',
    'adopted launcher actually reaped',
    'alias SDK identity',
    'alias ancestor hazard',
    'alias component',
    'alias cycle',
    'alias escape',
    'alias outside captured SDK package directories',
    'alias spelling',
    'alias target',
    'alias type/link',
    'ancestor socket shape',
    'ancestor subreaper',
    'ancestor traversal',
    'artifact expired or clock unavailable',
    'artifact pin',
    'base pin',
    'bootstrap FD outside current mount namespace',
    'bootstrap alias occupied',
    'bootstrap alias replaced',
    'bootstrap mount count bound',
    'bootstrap mount snapshots differ',
    'bootstrap mountinfo byte bound',
    'bootstrap mountinfo shape',
    'bootstrap pipe drained without failure record',
    'bootstrap record byte bound',
    'bootstrap record length',
    'bootstrap source byte bound',
    'bootstrap source descriptors retained',
    'bootstrap source hash/identity',
    'bootstrap source replaced',
    'bootstrap statx endian',
    'bootstrap statx shape',
    'bootstrap statx syscall',
    'bootstrap statx unavailable',
    'bootstrap_copy',
    'bootstrap_final_pin',
    'bootstrap_source',
    'bootstrap_source_pin',
    'both native processes live at parent-exit trigger',
    'bounded case before native deadline',
    'bounded fixed reader request',
    'bounded independent bootstrap source',
    'bounded independent source file',
    'cancel control write',
    'cancelled owned reader',
    'canonical protected reopen path',
    'case absolute deadline',
    'case ancillary envelope',
    'case descriptor close failures retained',
    'case input shape',
    'case pipe bound',
    'case receipt truncation',
    'casefold alias collision',
    'child fd ordering',
    'cleanup root replaced',
    'closed acquisition member',
    'closed acquisition metadata',
    'closed acquisition record required',
    'closed bootstrap errno',
    'closed bootstrap mount FDs',
    'closed bootstrap source path',
    'closed bootstrap step',
    'closed drain observations',
    'closed external source pins',
    'closed handles',
    'closed native case kind',
    'closed packet library inventory',
    'closed pidfd observation',
    'closed reopen inventory',
    'closed sealed root',
    'closed snapshot',
    'closed source copy inventory',
    'closed source directory path',
    'closed source lease',
    'compile DATA pin replaced',
    'compile pin digest',
    'compile pin version',
    'complete bounded bootstrap mountinfo',
    'complete outer mount snapshot',
    'complete request write',
    'confirmed descriptor discharge',
    'control observation bytes',
    'control source bound',
    'copy shares input inode',
    'data_record',
    'data_record_path',
    'descriptor capacity preflight',
    'descriptor discharge before case deadline',
    'diagnostic actual owned producer reap',
    'diagnostic actual producer wait response',
    'diagnostic owned launcher wait query',
    'diagnostic stderr bound',
    'directory replaced by leaf',
    'distinct inherited descriptors',
    'distinct noncolliding stdio sources',
    'distinct original reopen FDs',
    'duplicate JSON key',
    'duplicate reader key',
    'duplicate/late init',
    'duplicated control and stdin write endpoints alive',
    'empty base configuration',
    'exact acquisition metadata required',
    'exact downloader metadata conversion',
    'exact origin identities',
    'exact staged inputs',
    'exec returned',
    'explicit FIFO stdio',
    'explicit bootstrap reopen scope',
    'explicit child fd inventory',
    'explicit fixture reopen paths',
    'external compile DATA pin mismatch',
    'external compile pin hash',
    'external control changed',
    'external control source pin',
    'external inventory pin',
    'external parent supports packet layout only',
    'external pin digest required',
    'external pin file changed',
    'external source pin mismatch',
    'extra physical directory entry',
    'extra/missing alias',
    'extra/missing metadata or environment',
    'file bounds/digest',
    'file changed during read',
    'file grew during hash/copy',
    'file hash/identity changed',
    'file type/link/size changed',
    'fixed descriptor capacity unavailable',
    'fixed protected Root parent venue',
    'fixed protected fixture siblings required',
    'fixed selected exec environment',
    'fixture directory replaced',
    'fixture directory seal changed',
    'fixture file bytes changed',
    'fixture file identity changed',
    'fixture write incomplete',
    'four origins',
    'fresh source destination',
    'get subreaper',
    'held descriptor capacity preflight',
    'held descriptor count bound',
    'held external pin file required',
    'held immutable reopen input',
    'hidden canary leaked',
    'hosted Linux ARM venue required',
    'immutable selected exec environment',
    'independent bootstrap error writer',
    'independent fixture file required',
    'independent init pidfd teardown',
    'independent launcher and pipe teardown',
    'independent source/shared scope',
    'input execution/authority claim',
    'intermediate reap observation',
    'invalid JSON',
    'invalid destination',
    'inventory authority claim',
    'inventory format',
    'isolated actual Root bootstrap required',
    'isolated actual Root stage required',
    'isolated unprivileged data stage required',
    'launcher attribution',
    'launcher exit deadline',
    'launcher not reaped after native drain',
    'launcher parent',
    'launcher pid',
    'launcher pidfd type',
    'launcher proc bound',
    'leaf ancestor collision',
    'leaf count bound',
    'leaf race during capture',
    'leaf schema',
    'library pin',
    'live init and launcher before case trigger',
    'live pidfd target required',
    'live sealed root required',
    'live snapshot required',
    'loader bind target identity',
    'matching launcher/native wait',
    'metadata bindings',
    'metadata format',
    'missing native reap receipt',
    'missing physical directory entry',
    'module alias already occupied',
    'named object replaced',
    'native ancillary envelope',
    'native case uncertain; ownership retained',
    'native control data refused',
    'native receipt truncated',
    'negative teardown before C deadline',
    'new reopen ancestry descriptors retained',
    'new reopen descriptors distinct',
    'new reopen descriptors retained',
    'nonfinite JSON',
    'nonrecursive loader root bind',
    'one ancestor pair lifetime',
    'one bounded reader frame required',
    'one init pidfd',
    'one reader lifetime per producer',
    'one registered debt identity',
    'only actual terminal R',
    'only checked lease modules may be reused',
    'ordinary bootstrap mount ID required',
    'origin inventory digest',
    'origin leaf mismatch',
    'outer mount snapshot bound',
    'outer namespace changed after teardown',
    'outer namespace changed before launch',
    'outer namespace changed while live',
    'output_parent',
    'output_parent_replaced',
    'owned launcher pid',
    'owned private PID namespace init',
    'owned running reader',
    'packet directory not sealed',
    'packet file not DATA sealed',
    'parent exit command',
    'parent held reopen identity changed',
    'path characters',
    'path length',
    'path traversal/depth',
    'physical alias spelling',
    'pidfd observation bound',
    'plain downloader metadata required',
    'post-init bounded captures',
    'pre-bootstrap reap uncertain',
    'pre-exec failure is not successful lifetime',
    'pre-init unexpected-parent refusal',
    'prefix bound',
    'private Root parent',
    'private bootstrap mount namespace',
    'private real root propagation',
    'private source parent required',
    'proc observation bound',
    'proc observation identity changed',
    'proc observation regular file',
    'producer actually reaped exit zero',
    'producer death killed launcher and adopted init',
    'producer fixed command',
    'protected Root source ancestry required',
    'protected bootstrap source ancestry',
    'protected reopen ancestry',
    'protected source ancestry changed',
    'protected source file changed',
    'protected source root changed',
    'protected_bootstrap_pin',
    'read bound',
    'reader UID already in use',
    'reader capture bound',
    'reader fixture/correlation mismatch',
    'reader lifetime deadline',
    'reader lifetime state',
    'reader request write',
    'reader stream bound',
    'reader_wrapper_uncertain',
    'real filesystem owner observations required',
    'reap command after pidfd readiness',
    'reap without owned init',
    'receipt execution/authority claim',
    'receipt pin',
    'received descriptor cleanup uncertain',
    'received descriptor is not pidfd',
    'recipe execution claim',
    'registered child start gate',
    'registration before effects',
    'regular single-link bounded file required',
    'reopen identity changed before install',
    'reopened immutable identity mismatch',
    'request bytes',
    'request deadline',
    'request progress',
    'restore subreaper',
    'result_identity',
    'result_write',
    'reviewed inventory identity',
    'reviewed pin bytes changed',
    'runtime directory mode',
    'runtime object mode',
    'same-owner native control outcome',
    'scratch exclusion',
    'sealed reopen race',
    'separately reviewed pin required',
    'short copy',
    'single-threaded bootstrap required',
    'six exact libraries',
    'source ancestry replaced',
    'source changed before copy',
    'source completeness',
    'source copy write',
    'source hash changed',
    'source import pin',
    'source input descriptors retained',
    'source leaf replaced',
    'source read bound',
    'source read identity changed',
    'source reopen changed',
    'source traversal descriptors retained',
    'start gate write',
    'static metadata markers',
    'stdio access direction',
    'supported loader mount root required',
    'total byte bound',
    'trusted module alias replaced',
    'trusted module source path replaced',
    'twelve exact aliases',
    'two acquisition members',
    'two artifact roles',
    'uncertain resources must remain owned',
    'uncertain source lease',
    'unexpected dependency installation',
    'unexpected native rights after I or pre-init negative',
    'unexpected reader stderr',
    'unexpected-parent exact native refusal',
    'unique bootstrap mount IDs',
    'validated init required',
)

ERROR_CLASSES = ('Refusal', 'Uncertain', 'CaseUncertain', 'ValueError', 'OSError',
                 'PermissionError', 'FileNotFoundError', 'TimeoutError', 'BlockingIOError',
                 'ProcessLookupError', 'ChildProcessError', 'BrokenPipeError')
ERRNO_SYMBOLS = ('EACCES', 'EPERM', 'ENOENT', 'EBADF', 'EINVAL', 'EMFILE', 'ENFILE',
                 'ENOMEM', 'ENOSPC', 'EROFS', 'EIO', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT',
                 'EINTR', 'EAGAIN', 'ENOTDIR', 'ELOOP', 'ESRCH', 'ECHILD', 'EEXIST', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP',
                 'E2BIG', 'ENOEXEC', 'EFAULT', 'EBUSY', 'EXDEV', 'ENODEV', 'EISDIR',
                 'ETXTBSY', 'ENAMETOOLONG', 'EOVERFLOW', 'ELIBBAD', 'EUSERS')
FAILURE_STAGES = ('preflight', 'load_pin', 'capture', 'launch_root', 'guard', 'fixture',
                  'close', 'source:capture', 'source:copy', 'bootstrap:copy', 'bootstrap:load') + tuple(
    'source:load:' + name for name in ('control', 'producer', 'reader_parent', 'reader_fixture', 'native_cases')) + tuple(
    'case:' + kind + ':' + phase for kind in ('same-owner', 'unexpected-parent', 'parent-exit')
    for phase in ('run', 'verify', 'recheck'))



# Literal inventory of require labels in SDK f6d88d9a C/header; not output authority.
NATIVE_STDERR_LABELS = (
    'bind',
    'bind flags',
    'fixture path',
    'reader Root peer',
    'reader admitted clone',
    'reader bounding capabilities',
    'reader close-on-exec',
    'reader directory mountpoint',
    'reader empty readonly cwd',
    'reader explicit pipe',
    'reader explicit pipe-only envelope',
    'reader file mountpoint',
    'reader immutable exec',
    'reader immutable file',
    'reader independent primary gid',
    'reader independent uid',
    'reader inherited descriptor',
    'reader monitor control',
    'reader monitor control copy',
    'reader monitor death',
    'reader monitor init',
    'reader monitor init copy',
    'reader monitor originals',
    'reader monotonic deadline',
    'reader mount attach',
    'reader namespace init',
    'reader namespace kill',
    'reader namespace pidfd',
    'reader namespaces',
    'reader no new privileges',
    'reader parent pidfd',
    'reader pipe descriptor',
    'reader pipe flags',
    'reader private propagation',
    'reader private temporary files',
    'reader readonly skeleton',
    'reader receipt type',
    'reader recursive mount flags',
    'reader resource ceiling',
    'reader root',
    'reader seccomp',
    'reader selected directory',
    'reader selected workspace group',
    'reader service death',
    'reader service pidfd',
    'reader setup monitor death',
    'reader shared identity',
    'reader skeleton',
    'reader skeleton ancestor',
    'reader source identity',
    'reader surviving pipe',
    'reader view ancestor',
    'reader view cwd',
    'reader view ownership',
    'reader view root',
    'reader zero capabilities',
    'seccomp',
)
PREINIT_KEYS = ('controlObserved', 'controlBytes', 'controlTag', 'controlRights', 'controlEof', 'stderrBytes', 'stderrEof', 'nativeClassification', 'nativeLabel', 'nativeErrno', 'bootstrapBytes', 'bootstrapRecordObserved', 'bootstrapStep', 'bootstrapErrno', 'bootstrapEof', 'bootstrapClassification', 'launcherExitCode', 'producerExitCode', 'diagnosticsComplete')
BOOTSTRAP_STEP_NAMES = ('child_setup','gate','root_guard','stdio','unshare','propagation',
                        'chroot','descriptor_envelope','exec','mount_identity','loader_bind','reopen_inputs')
DIAGNOSTIC_ERRNOS = (0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
                    18, 19, 20, 21, 22, 23, 24, 26, 28, 30, 32, 36, 38, 40,
                    75, 80, 87, 95, 110)


def preinit_record(chain):
    """Copy only fully validated closed observations. Missing/malformed stays unknown."""
    raw=None
    for item in chain:
        observed=getattr(getattr(item,'handles',None),'preinit_diagnostics',None)
        if observed is not None:raw=observed;break
    if type(raw) is not dict or set(raw)!=set(PREINIT_KEYS):return {'available':False}
    for name in ('controlObserved','controlEof','stderrEof','bootstrapRecordObserved','bootstrapEof','diagnosticsComplete'):
        if type(raw[name]) is not bool:return {'available':False}
    for name,limit in (('controlBytes',32),('controlRights',32),('stderrBytes',4097),('bootstrapBytes',9)):
        if type(raw[name]) is not int or not 0<=raw[name]<=limit:return {'available':False}
    for name in ('nativeErrno','bootstrapErrno'):
        if type(raw[name]) is not int or raw[name] not in DIAGNOSTIC_ERRNOS:return {'available':False}
    for name in ('launcherExitCode','producerExitCode'):
        if raw[name] is not None and (type(raw[name]) is not int or not -64<=raw[name]<=255):return {'available':False}
    choices={'controlTag':('I','R','EOF','other','unknown'),
             'nativeClassification':('empty','audited_perror','audited_label','unrecognized','overflow'),
             'nativeLabel':NATIVE_STDERR_LABELS+('unknown',),
             'bootstrapStep':BOOTSTRAP_STEP_NAMES+('unknown',),
             'bootstrapClassification':('empty','record','invalid','overflow')}
    for name,values in choices.items():
        if type(raw[name]) is not str or raw[name] not in values:return {'available':False}
    result={name:raw[name] for name in PREINIT_KEYS};result['available']=True
    for name in ('nativeErrno','bootstrapErrno'):
        symbol='ENOTSUP' if raw[name]==95 else errno.errorcode.get(raw[name])
        result[name+'Symbol']=symbol if symbol in ERRNO_SYMBOLS else 'unknown'
    return result



POSTINIT_KEYS = ('available','nativeWaitStatus','launcherWaitStatus','producerWaitStatus',
                'stdoutBytes','stdoutSha256','stdoutFraming','stderrBytes','stderrSha256',
                'stderrClassification','stderrLabel','stderrErrno')


def terminal_status(value):
    if type(value) is not int or not 0<=value<=65535:return False
    low=value&255
    return low==0 or (value>>8==0 and 1 <= (low&127) <= 64)


def postinit_record(chain):
    """Fixture-only scalar observation. No raw guidance or authority is projected."""
    raw=None
    for item in chain:
        observed=getattr(getattr(item,'handles',None),'postinit_diagnostics',None)
        if observed is not None:raw=observed;break
    if type(raw) is not dict or set(raw)!=set(POSTINIT_KEYS) or raw['available'] is not True:return {'available':False}
    if raw['nativeWaitStatus'] is not None and not terminal_status(raw['nativeWaitStatus']):return {'available':False}
    if not all(terminal_status(raw[name]) for name in ('launcherWaitStatus','producerWaitStatus')):return {'available':False}
    for name,limit in (('stdoutBytes',320*1024),('stderrBytes',16384)):
        if type(raw[name]) is not int or not 0<=raw[name]<=limit:return {'available':False}
    for name in ('stdoutSha256','stderrSha256'):
        value=raw[name]
        if type(value) is not str or len(value)!=64 or any(c not in '0123456789abcdef' for c in value):return {'available':False}
    if type(raw['stdoutFraming']) is not str or raw['stdoutFraming'] not in ('empty','unterminated','one_lf','multiple_lf'):return {'available':False}
    if (raw['stdoutBytes']==0)!=(raw['stdoutFraming']=='empty'):return {'available':False}
    if type(raw['stderrClassification']) is not str or raw['stderrClassification'] not in ('empty','audited_perror','audited_label','unrecognized','over_classifier_bound'):return {'available':False}
    if type(raw['stderrLabel']) is not str or raw['stderrLabel'] not in NATIVE_STDERR_LABELS+('unknown',):return {'available':False}
    if type(raw['stderrErrno']) is not int or raw['stderrErrno'] not in DIAGNOSTIC_ERRNOS:return {'available':False}
    if (raw['stderrBytes']==0)!=(raw['stderrClassification']=='empty'):return {'available':False}
    if (raw['stderrBytes']>4096)!=(raw['stderrClassification']=='over_classifier_bound'):return {'available':False}
    kind=raw['stderrClassification']
    if kind in ('empty','unrecognized','over_classifier_bound') and (raw['stderrLabel']!='unknown' or raw['stderrErrno']!=0):return {'available':False}
    if kind in ('audited_perror','audited_label') and raw['stderrLabel']=='unknown':return {'available':False}
    if kind=='audited_label' and raw['stderrErrno']!=0:return {'available':False}
    if raw['stdoutFraming']=='multiple_lf' and raw['stdoutBytes']<2:return {'available':False}
    empty_sha=hashlib.sha256(b'').hexdigest()
    for size,digest in (('stdoutBytes','stdoutSha256'),('stderrBytes','stderrSha256')):
        if raw[size]==0 and raw[digest]!=empty_sha:return {'available':False}
    return {name:raw[name] for name in POSTINIT_KEYS}


SAMPLE_REASONS=('not_same_owner_failure','scrub_rejected','provenance_unverified',
                'capture_absent','projection_error')


def stderr_sample_record(chain):
    """Fixture-only PUBLIC bytes; strict additive projection, never general guidance."""
    raw=None
    for item in chain:
        observed=getattr(getattr(item,'lease',None),'fixture_stderr_sample',None)
        if observed is not None:raw=observed;break
    unavailable={'available':False,'reason':'projection_error'}
    if raw is None:return {'available':False,'reason':'capture_absent'}
    if type(raw) is not dict or type(raw.get('available')) is not bool:return unavailable
    if raw['available'] is False:
        if set(raw)=={'available','reason'} and type(raw['reason']) is str and raw['reason'] in SAMPLE_REASONS:
            return dict(raw)
        return unavailable
    if set(raw)!={'available','bytesBase64','truncated','sampleSha256'}:return unavailable
    encoded=raw['bytesBase64'];digest=raw['sampleSha256']
    if type(encoded) is not str or len(encoded)>5464 or type(raw['truncated']) is not bool:return unavailable
    if type(digest) is not str or len(digest)!=64 or any(c not in '0123456789abcdef' for c in digest):return unavailable
    try:sample=base64.b64decode(encoded,validate=True)
    except (ValueError,binascii.Error):return unavailable
    if len(sample)>4096 or base64.b64encode(sample).decode('ascii')!=encoded:return unavailable
    if raw['truncated'] and len(sample)!=4096:return unavailable
    if hashlib.sha256(sample).hexdigest()!=digest:return unavailable
    return dict(raw)


def log_result_projection(result):
    """No raw/Base64 sample in CI output; the exact artifact alone holds bytes."""
    projected=dict(result)
    if 'postInitStderrSample' in projected:
        sample=projected['postInitStderrSample']
        if type(sample) is dict and sample.get('available') is True:
            projected['postInitStderrSample']={key:sample[key] for key in
                ('available','truncated','sampleSha256')}
        else:
            projected['postInitStderrSample']={'available':False}
            if type(sample) is dict and sample.get('reason') in SAMPLE_REASONS:
                projected['postInitStderrSample']['reason']=sample['reason']
    return projected


def failure_record(error, *, stage='preflight'):
    """Closed observations plus explicitly gated PUBLIC fixture sample only."""
    chain=[error]
    for _ in range(2):
        nested=getattr(chain[-1], 'cause', None)
        if nested is None:break
        chain.append(nested)
    for item in chain:
        lease=getattr(item, 'lease', None)
        observed=getattr(lease, 'stage', None)
        if type(observed) is str and observed in FAILURE_STAGES:
            stage=observed;break
        observed=getattr(item, 'reader_stage', None)
        if type(observed) is str and observed in FAILURE_STAGES:stage=observed
    def closed(item):
        name=type(item).__name__
        reason=item.args[0] if isinstance(item, BaseException) and len(item.args)==1 else None
        code=getattr(item, 'errno', None)
        symbol=('ENOTSUP' if code==95 else errno.errorcode.get(code)) if type(code) is int else None
        return (name if name in ERROR_CLASSES else 'Other',
                reason if type(reason) is str and reason in ERROR_REASONS else 'unclassified',
                symbol if symbol in ERRNO_SYMBOLS else 'unknown')
    try:postinit=postinit_record(chain)
    except BaseException:postinit={'available':False}
    try:sample=stderr_sample_record(chain)
    except BaseException:sample={'available':False,'reason':'projection_error'}
    if sample['available']:
        size=postinit.get('stderrBytes') if postinit.get('available') is True else None
        if (type(size) is not int or sample['truncated']!=(size>4096)
                or len(base64.b64decode(sample['bytesBase64']))!=min(size,4096)
                or (not sample['truncated'] and sample['sampleSha256']!=postinit['stderrSha256'])):
            sample={'available':False,'reason':'projection_error'}
    name,reason,symbol=closed(error)
    cause_name,cause_reason,cause_errno=closed(chain[-1])
    return {'readerCaseSetPassed':False, 'stage':stage if type(stage) is str and stage in FAILURE_STAGES else 'unknown',
            'reason':reason, 'exceptionClass':name, 'errnoSymbol':symbol,
            'causeClass':cause_name, 'causeReason':cause_reason, 'causeErrnoSymbol':cause_errno,
            'preInitDiagnostics':preinit_record(chain),
            'postInitDiagnostics':postinit,
            'postInitStderrSample':sample,
            'nativeCleanupConfirmed':False, 'configEffectProven':False,
            'vmExecutionVerified':False, 'productionActivation':False}


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


def run_root(repository,protected_parent,data,wrapper_digest,*,wrapper_source,harness_source,loader=load_checked):
    """Unexecuted Root stage. Caller must externally admit this bootstrap first."""
    require(sys.platform=='linux' and os.getuid()==0 and os.geteuid()==0
            and sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            'isolated actual Root stage required')
    stage='preflight'
    try:
        repository=Path(repository);protected_parent=Path(protected_parent)
        stage='bootstrap:copy'
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
        stage='bootstrap:load'
        wrapper=loader('_reader_root_wrapper',target,wrapper_digest,root_copy=True)
        wrapper.check_acquisition_record(data['acquisition'],datetime.now(timezone.utc))
        lease=wrapper.copy_external_sources(harness_source,protected_parent/'sources',
            compile_pin_path=repository/'scripts/guest-reader-intake/compile-38502659264.pin.json')
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
    except BaseException as error:
        error.reader_stage=stage
        raise
