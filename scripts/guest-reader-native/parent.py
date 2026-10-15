"""External stdlib-only packet DATA validator and sealed launch-root builder.

No captured module is imported and no compiled object is executed here. A
sealed root is a filesystem result, not native admission. Root ownership,
external-parent source admission and execution remain separate caller gates.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import resource
import stat
import sys
import unicodedata

REVIEWED_PIN_SHA256 = 'e319e8a859dcc891a59c8a2d4134aa02ad8dd0da94bca45b339e49fdc92bae2b'
REVIEWED_INVENTORY_SHA256 = '21e790a4c3564510398f8630581493eb606b078b408cf880bb833485290b7c5f'
# A measured value of the reviewed packet, not a design constant: the three-artifact compile pin
# (S8) replaces the pin hash, the inventory hash and this count together with the measured numbers.
REVIEWED_FILE_COUNT = 1472
MAX_JSON = 4 * 1024 * 1024
MAX_LEAF = 128 * 1024 * 1024
MAX_BYTES = 512 * 1024 * 1024
MAX_LEAVES = 20000
CHUNK = 65536
MAX_FDS = 65000
VIEW_ID = 'reader-case'
ARTIFACTS = frozenset(('instructionReader', 'instructionReaderLauncher',
                       'instructionReaderDependencyProbe'))
# The B3 file canary. It is NOT a packet artifact and never copied: the harness itself creates it, so
# the dependency probe can try to open "/winter-outside-canary" and expect ENOENT inside the reader view.
CANARY_LEAF = 'winter-outside-canary'
CANARY_CONTENT = b'NEVER-READER-OUTSIDE-CANARY\n'
# 0444 on purpose: were the view to leak, the reader uid could open it. 0400 would turn a leak into a masking EACCES.
CANARY_MODE = 0o444
RUNTIME_FILE_MODE = 0o555
ORIGINS = frozenset(('runtime', 'sdk', 'overlay', 'builder'))
ENVIRONMENT = frozenset('/lib/' + name for name in (
    'ld-linux-aarch64.so.1', 'aarch64-linux-gnu/ld-linux-aarch64.so.1',
    'aarch64-linux-gnu/libc.so.6', 'aarch64-linux-gnu/libdl.so.2',
    'aarch64-linux-gnu/libm.so.6', 'aarch64-linux-gnu/libpthread.so.0'))
ADDITIONAL_METADATA = frozenset(('compiler-acquisition.json',)) | frozenset(
    'diagnostics/' + name + '.json' for name in (
        'autoload-default', 'autoload-enabled', 'autoload-pair-0', 'autoload-pair-1',
        'autoload-pair-2', 'autoload-pair-3', 'opaque-allowed', 'opaque-rejected', 'unresolved-pair'))
FALSE_FLAGS = frozenset((
    'activationEnabled', 'autoloadExecutionVerified',
    'dependencyPackageAttestationVerified', 'dynamicRuntimeImportsVerified',
    'executedPythonSourceAuthenticated', 'globalBunConfigurationExecutionVerified',
    'linuxExecutionVerified', 'nativeOwnerVerified', 'trustedToolchainVerified',
    'vmExecutionVerified'))
PIN_KEYS = frozenset(('archiveBytes', 'archiveSha256', 'artifacts', 'base',
    'builderHead', 'fileBytes', 'fileCount', 'formatVersion', 'inventoryBytes',
    'inventorySha256', 'origins', 'receiptSha256', 'resolverBindings', 'run',
    'runtimeDependencies', 'workflowHead'))
INVENTORY_KEYS = frozenset(('kind', 'formatVersion', 'excludedScratch', 'files',
    'builderHead', 'workflowHead', 'fileCount', 'fileBytes', 'archiveSha256',
    'archiveBytes', 'outputsExecuted', 'nativeAdmission', 'vmExecutionVerified',
    'activationEnabled'))
INPUT_KEYS = frozenset(('formatVersion', 'kind', 'origins', 'dependencies',
    'resolverBindings', 'stagedInputs', 'pythonSourceObservations',
    'executedPythonSourceAuthenticated', 'bareReferencesPendingMetafile',
    'thirdPartyResolverMapSha256', 'stagedInventorySha256',
    'dependencyInstallationPerformed', 'nativeOwnerVerified',
    'linuxExecutionVerified', 'vmExecutionVerified', 'activationEnabled'))
RECEIPT_KEYS = FALSE_FLAGS | frozenset(('formatVersion', 'kind', 'inputsSha256',
    'origins', 'resolverBindings', 'pythonSourceObservations', 'reachableGraph',
    'compilerSemanticEvidence', 'readerEmbeddedFlags', 'compiler', 'base',
    'nativeCompiler', 'recipe', 'commands', 'nativeFlags', 'systemHeaders',
    'bundledInputs', 'metafileSha256', 'artifacts', 'runtimeDependencies',
    'staticMetafileOnly'))
IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid',
                   'st_size', 'st_mtime_ns', 'st_ctime_ns')


class Refusal(ValueError):
    """The complete packet or independent copy fails the DATA contract."""


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False).encode()


def parse_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=pairs,
            parse_constant=lambda _: (_ for _ in ()).throw(Refusal('nonfinite JSON')))
    except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise Refusal('invalid JSON') from error


def keys(value, expected, reason):
    require(type(value) is dict and set(value) == set(expected), reason)


def digest_ok(value):
    return isinstance(value, str) and len(value) == 64 and all(
        c in '0123456789abcdef' for c in value)


def parts(name):
    require(isinstance(name, str) and name and len(name.encode()) <= 4096,
            'path length')
    require(unicodedata.normalize('NFC', name) == name and not any(
        ord(c) < 32 or ord(c) == 127 or c == '\\' for c in name), 'path characters')
    result = name.split('/')
    require(len(result) <= 64 and all(p not in ('', '.', '..') for p in result),
            'path traversal/depth')
    return result


def identity(info):
    return tuple(getattr(info, field) for field in IDENTITY_FIELDS)


def read_fd(fd, limit):
    before = identity(os.fstat(fd))
    require(stat.S_ISREG(before[2]) and before[3] == 1 and 0 <= before[6] <= limit,
            'regular single-link bounded file required')
    data = bytearray()
    offset = 0
    while True:
        chunk = os.pread(fd, min(CHUNK, limit + 1 - offset), offset)
        if not chunk:
            break
        data.extend(chunk)
        offset += len(chunk)
        require(offset <= limit, 'read bound')
    require(identity(os.fstat(fd)) == before and len(data) == before[6],
            'file changed during read')
    return bytes(data)


def measure_fd(fd, expected, *, copy_fd=None):
    before = identity(os.fstat(fd))
    require(stat.S_ISREG(before[2]) and before[3] == 1 and before[6] == expected['bytes'],
            'file type/link/size changed')
    digest = hashlib.sha256()
    offset = 0
    while True:
        chunk = os.pread(fd, min(CHUNK, expected['bytes'] + 1 - offset), offset)
        if not chunk:
            break
        offset += len(chunk)
        require(offset <= expected['bytes'], 'file grew during hash/copy')
        digest.update(chunk)
        if copy_fd is not None:
            view = memoryview(chunk)
            while view:
                count = os.write(copy_fd, view)
                require(count > 0, 'short copy')
                view = view[count:]
    require(offset == expected['bytes'] and digest.hexdigest() == expected['sha256']
            and identity(os.fstat(fd)) == before, 'file hash/identity changed')
    return before


class Handles:
    def __init__(self):
        self.fds = []
        self.edges = []
        self.closed = False

    def hold(self, fd):
        if len(self.fds) >= MAX_FDS:
            os.close(fd)
            raise Refusal('held descriptor count bound')
        self.fds.append(fd)
        return fd

    def directory(self, path):
        require('..' not in Path(path).parts, 'ancestor traversal')
        absolute = Path(os.path.abspath(path))
        fd = self.hold(os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
        for part in absolute.parts[1:]:
            child = self.hold(os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                     dir_fd=fd))
            self.edges.append((fd, part, child))
            fd = child
        return fd

    def file(self, path, limit):
        path = Path(path)
        parent = self.directory(path.parent)
        fd = self.hold(os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                               dir_fd=parent))
        self.edges.append((parent, path.name, fd))
        return fd, read_fd(fd, limit)

    def check_edges(self):
        require(not self.closed, 'closed handles')
        for parent, name, fd in self.edges:
            named = os.stat(name, dir_fd=parent, follow_symlinks=False)
            held = os.fstat(fd)
            require((named.st_dev, named.st_ino, named.st_mode) ==
                    (held.st_dev, held.st_ino, held.st_mode), 'named object replaced')

    def close(self):
        if not self.closed:
            for fd in reversed(self.fds):
                os.close(fd)
            self.closed = True


def directory_names(fd, expected):
    """Bound physical enumeration by the independently pinned child count."""
    names = set()
    with os.scandir(fd) as entries:
        for entry in entries:
            names.add(entry.name)
            require(len(names) <= len(expected), 'extra physical directory entry')
    require(names == expected, 'missing physical directory entry')
    return names


class ReviewedPin:
    """Externally hash-bound JSON bytes, never a packet-provided declaration."""
    def __init__(self, raw, digest, path=None):
        self.raw = bytes(raw)
        self.sha256 = digest
        self.path = Path(path) if path is not None else None

    @property
    def data(self):
        require(sha(self.raw) == self.sha256, 'reviewed pin bytes changed')
        return parse_json(self.raw)


def load_pin(path=None, *, expected_sha256=REVIEWED_PIN_SHA256):
    require(digest_ok(expected_sha256), 'external pin digest required')
    path = path or Path(__file__).parent.parent / 'guest-reader-intake' / 'compile-38502659264.pin.json'
    held = Handles()
    try:
        _, raw = held.file(path, MAX_JSON)
        held.check_edges()
        require(sha(raw) == expected_sha256, 'external compile pin hash')
        pin = parse_json(raw)
        keys(pin, PIN_KEYS, 'compile pin schema')
        require(pin['formatVersion'] == 1 and type(pin['formatVersion']) is int,
                'compile pin version')
        if expected_sha256 == REVIEWED_PIN_SHA256:
            require(pin['inventorySha256'] == REVIEWED_INVENTORY_SHA256 and
                    pin['fileCount'] == REVIEWED_FILE_COUNT, 'reviewed inventory identity')
        return ReviewedPin(raw, expected_sha256, path)
    finally:
        held.close()


def check_inventory(inv, pin):
    keys(inv, INVENTORY_KEYS, 'inventory exact schema')
    require(inv['kind'] == 'winter-reader-compile-packet' and
            type(inv['formatVersion']) is int and inv['formatVersion'] == 1,
            'inventory format')
    for flag in ('outputsExecuted', 'nativeAdmission', 'vmExecutionVerified', 'activationEnabled'):
        require(inv[flag] is False, 'inventory authority claim')
    for key in ('archiveSha256', 'archiveBytes', 'builderHead', 'workflowHead', 'fileCount', 'fileBytes'):
        require(type(inv[key]) is type(pin[key]) and inv[key] == pin[key],
                'inventory pin mismatch: ' + key)
    require(inv['excludedScratch'] == ['artifacts/native.d'], 'scratch exclusion')
    leaves = inv['files']
    require(type(leaves) is dict and type(inv['fileCount']) is int and
            0 < len(leaves) == inv['fileCount'] <= MAX_LEAVES, 'leaf count bound')
    directories, folded, total, visits = set(), {}, 0, 0
    for name, entry in leaves.items():
        path = parts(name)
        visits += len(path)
        require(visits <= 60000, 'prefix bound')
        for index in range(1, len(path) + 1):
            prefix = '/'.join(path[:index])
            key = prefix.casefold()
            require(key not in folded or folded[key] == prefix, 'casefold alias collision')
            folded[key] = prefix
            if index < len(path):
                directories.add(prefix)
        require(type(entry) is dict, 'leaf schema')
        if entry.get('kind') == 'file':
            keys(entry, ('kind', 'bytes', 'sha256'), 'file schema')
            require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= MAX_LEAF
                    and digest_ok(entry['sha256']), 'file bounds/digest')
            total += entry['bytes']
        else:
            keys(entry, ('kind', 'target'), 'alias schema')
            require(entry['kind'] == 'symlink' and isinstance(entry['target'], str)
                    and 0 < len(entry['target'].encode()) <= 4096, 'alias target')
    require(not (set(leaves) & directories), 'leaf ancestor collision')
    require(type(inv['fileBytes']) is int and total == inv['fileBytes'] <= MAX_BYTES,
            'total byte bound')
    return leaves, directories


def resolve_alias(name, target, leaves, directories):
    require(target and not target.startswith('/') and '\\' not in target, 'alias escape')
    pending = name.split('/')[:-1] + target.split('/')
    done, seen = [], set()
    while pending:
        part = pending.pop(0)
        require(part and not any(ord(c) < 32 or ord(c) == 127 for c in part), 'alias component')
        if part == '.':
            continue
        if part == '..':
            require(done, 'alias escape')
            done.pop()
            continue
        done.append(part)
        key = '/'.join(done)
        entry = leaves.get(key)
        if entry and entry['kind'] == 'symlink':
            require(key not in seen and len(seen) < 32, 'alias cycle')
            seen.add(key)
            done.pop()
            linked = entry['target']
            require(not linked.startswith('/') and '\\' not in linked, 'alias escape')
            pending = linked.split('/') + pending
        elif pending:
            require(key in directories, 'alias ancestor hazard')
    result = '/'.join(done)
    require(result in directories and result.startswith('source/sdk/packages/'),
            'alias outside captured SDK package directories')
    return result


def check_contract(inv, pin, blobs):
    leaves, directories = check_inventory(inv, pin)
    receipt, inputs = parse_json(blobs['receipt.json']), parse_json(blobs['inputs.json'])
    keys(receipt, RECEIPT_KEYS, 'receipt exact schema')
    keys(inputs, INPUT_KEYS, 'inputs exact schema')
    require(sha(blobs['receipt.json']) == pin['receiptSha256'], 'receipt pin')
    require(receipt['kind'] == 'winter-reader-compile' and
            inputs['kind'] == 'winter-reader-inputs' and
            type(receipt['formatVersion']) is int and receipt['formatVersion'] == 1 and
            type(inputs['formatVersion']) is int and inputs['formatVersion'] == 1, 'metadata format')
    for flag in FALSE_FLAGS:
        require(receipt[flag] is False, 'receipt execution/authority claim')
    for flag in ('executedPythonSourceAuthenticated', 'dependencyInstallationPerformed',
                 'nativeOwnerVerified', 'linuxExecutionVerified', 'vmExecutionVerified', 'activationEnabled'):
        require(inputs[flag] is False, 'input execution/authority claim')
    require(inputs['bareReferencesPendingMetafile'] is True and
            receipt['staticMetafileOnly'] is True, 'static metadata markers')
    require(type(receipt['recipe']) is dict and receipt['recipe'].get('outputsExecuted') is False,
            'recipe execution claim')
    require(sha(blobs['inputs.json']) == receipt['inputsSha256'] and
            sha(blobs['artifacts/instructionReader.metafile.json']) == receipt['metafileSha256'],
            'metadata bindings')
    origins = receipt['origins']
    require(type(origins) is list and len(origins) == 4 and
            all(type(o) is dict for o in origins) and
            {o.get('role') for o in origins} == ORIGINS, 'four origins')
    require(inputs['origins'] == origins and
            [{k: v for k, v in o.items() if k != 'eligibleFiles'} for o in origins] == pin['origins'],
            'exact origin identities')
    captured = set()
    for origin in origins:
        keys(origin, ('role', 'head', 'checkoutHead', 'tree', 'inventorySha256', 'eligibleFiles'),
             'origin exact schema')
        files = origin['eligibleFiles']
        require(type(files) is dict and sha(canonical(files)) == origin['inventorySha256'],
                'origin inventory digest')
        for name, entry in files.items():
            parts(name)
            key = 'source/' + origin['role'] + '/' + name
            require(leaves.get(key) == entry, 'origin leaf mismatch')
            captured.add(key)
    bindings = receipt['resolverBindings']
    require(type(bindings) is dict and len(bindings) == 12 and
            bindings == inputs['resolverBindings'] == pin['resolverBindings'], 'twelve exact aliases')
    links = {n for n, v in leaves.items() if v['kind'] == 'symlink'}
    require(links == set(bindings), 'extra/missing alias')
    resolved = {}
    for name, binding in bindings.items():
        keys(binding, ('origin', 'package', 'target', 'version'), 'binding exact schema')
        require(binding['origin'] == 'sdk' and binding['version'] == '0.0.53', 'alias SDK identity')
        require(leaves[name] == {'kind': 'symlink', 'target': binding['target']}, 'alias spelling')
        resolved[name] = resolve_alias(name, binding['target'], leaves, directories)
        captured.add(name)
    require(captured == {n for n in leaves if n.startswith('source/')}, 'source completeness')
    require(set(receipt['artifacts']) == set(pin['artifacts']) == ARTIFACTS, 'three artifact roles')
    for role in ARTIFACTS:
        artifact = receipt['artifacts'][role]
        require({k: artifact[k] for k in ('bytes', 'sha256')} == pin['artifacts'][role] and
                leaves.get('artifacts/' + role) == dict(pin['artifacts'][role], kind='file'), 'artifact pin')
    deps = receipt['runtimeDependencies']
    require(set(deps) == set(pin['runtimeDependencies']) == ENVIRONMENT, 'six exact libraries')
    for guest in ENVIRONMENT:
        require({k: deps[guest][k] for k in ('bytes', 'sha256')} == pin['runtimeDependencies'][guest]
                and leaves.get('environment/' + guest.lstrip('/')) ==
                dict(pin['runtimeDependencies'][guest], kind='file'), 'library pin')
    require(receipt['base'] == pin['base'] and
            leaves['stage/linux-bun-base']['sha256'] == pin['base']['executableSha256'], 'base pin')
    staged = inputs['stagedInputs']
    # prepare_packet records source/dependency DATA before build creates stage/.
    expected_staged = {n: v for n, v in leaves.items() if n.startswith('source/')}
    require(staged == expected_staged and sha(canonical(staged)) == inputs['stagedInventorySha256'],
            'exact staged inputs')
    require(inputs['dependencies'] == {}, 'unexpected dependency installation')
    expected_other = {'receipt.json', 'inputs.json', 'artifacts/instructionReader.metafile.json',
        'stage/linux-bun-base', 'stage/empty-bunfig.toml'} | {
        'artifacts/' + role for role in ARTIFACTS} | {
        'environment/' + path.lstrip('/') for path in ENVIRONMENT} | ADDITIONAL_METADATA
    require({n for n in leaves if not n.startswith('source/')} == expected_other,
            'extra/missing metadata or environment')
    require(leaves['stage/empty-bunfig.toml'] == {'kind': 'file', 'bytes': 0, 'sha256': sha(b'')},
            'empty base configuration')
    return receipt, resolved


class Snapshot(Handles):
    def __init__(self):
        super().__init__()
        self.files, self.directories, self.links = {}, {}, {}
        self.controls = []

    def __enter__(self):
        require(not self.closed, 'closed snapshot')
        return self

    def __exit__(self, *_):
        self.close()

    def recheck(self):
        self.check_edges()
        for name, (fd, expected, observed) in self.files.items():
            require(identity(os.fstat(fd)) == observed, 'packet identity changed: ' + name)
            measure_fd(fd, expected)
        for fd, raw, observed in self.controls:
            require(identity(os.fstat(fd)) == observed and read_fd(fd, MAX_JSON) == raw,
                    'external control changed')
        for name, (parent, leaf, target, observed) in self.links.items():
            require(identity(os.stat(leaf, dir_fd=parent, follow_symlinks=False)) == observed and
                    os.readlink(leaf, dir_fd=parent) == target, 'alias changed: ' + name)
        for name, (fd, expected, observed) in self.directories.items():
            require(identity(os.fstat(fd)) == observed and directory_names(fd, expected) == expected,
                    'directory identity/inventory changed: ' + name)


def capture_packet(tree, inventory, pin=None, *, layout='packet'):
    """Validate the complete physical tree as DATA and retain no-follow FDs."""
    require(layout == 'packet', 'external parent supports packet layout only')
    pin = pin or load_pin()
    require(isinstance(pin, ReviewedPin), 'separately reviewed pin required')
    # Freeze caller-owned mutable input by canonical JSON roundtrip.
    contract = parse_json(canonical(pin.data))
    keys(contract, PIN_KEYS, 'compile pin schema')
    snapshot = Snapshot()
    try:
        require(pin.path is not None, 'held external pin file required')
        pin_fd, pin_raw = snapshot.file(pin.path, MAX_JSON)
        require(pin_raw == pin.raw and sha(pin_raw) == pin.sha256, 'external pin file changed')
        snapshot.controls.append((pin_fd, pin_raw, identity(os.fstat(pin_fd))))
        control_fd, raw = snapshot.file(inventory, MAX_JSON)
        snapshot.controls.append((control_fd, raw, identity(os.fstat(control_fd))))
        require(len(raw) == contract['inventoryBytes'] and sha(raw) == contract['inventorySha256'],
                'external inventory pin')
        inv = parse_json(raw)
        leaves, directories = check_inventory(inv, contract)
        descriptor_need = len(leaves) + len(directories) + 2 * len(Path(os.path.abspath(tree)).parts) + 64
        soft_limit, _ = resource.getrlimit(resource.RLIMIT_NOFILE)
        require(descriptor_need <= MAX_FDS and
                (soft_limit == resource.RLIM_INFINITY or descriptor_need < soft_limit),
                'held descriptor capacity preflight')
        root = snapshot.directory(tree)
        expected_dirs = directories | {''}
        def walk(fd, prefix):
            expected = {name[len(prefix) + (1 if prefix else 0):].split('/')[0]
                        for name in set(leaves) | directories
                        if not prefix or name.startswith(prefix + '/')}
            children = directory_names(fd, expected)
            snapshot.directories[prefix] = (fd, expected, identity(os.fstat(fd)))
            require(stat.S_IMODE(os.fstat(fd).st_mode) == 0o500, 'packet directory not sealed')
            for child in sorted(children):
                name = prefix + '/' + child if prefix else child
                observed = os.stat(child, dir_fd=fd, follow_symlinks=False)
                if name in expected_dirs:
                    require(stat.S_ISDIR(observed.st_mode), 'directory replaced by leaf')
                    sub = snapshot.hold(os.open(child, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd))
                    snapshot.edges.append((fd, child, sub))
                    walk(sub, name)
                elif leaves[name]['kind'] == 'symlink':
                    require(stat.S_ISLNK(observed.st_mode) and observed.st_nlink == 1,
                            'alias type/link')
                    target = os.readlink(child, dir_fd=fd)
                    require(target == leaves[name]['target'], 'physical alias spelling')
                    snapshot.links[name] = (fd, child, target, identity(observed))
                else:
                    file_fd = snapshot.hold(os.open(child, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd))
                    snapshot.edges.append((fd, child, file_fd))
                    require(stat.S_IMODE(os.fstat(file_fd).st_mode) == 0o400, 'packet file not DATA sealed')
                    measured = measure_fd(file_fd, leaves[name])
                    require(measured == identity(observed), 'leaf race during capture')
                    snapshot.files[name] = (file_fd, leaves[name], measured)
        walk(root, '')
        blobs = {n: read_fd(snapshot.files[n][0], MAX_JSON) for n in
                 ('receipt.json', 'inputs.json', 'artifacts/instructionReader.metafile.json')}
        receipt, aliases = check_contract(inv, contract, blobs)
        snapshot.measurements = {'kind': 'winter-reader-parent-data-capture',
            'fileCount': len(leaves), 'fileBytes': inv['fileBytes'],
            'inventorySha256': sha(raw), 'compilePinSha256': pin.sha256,
            'heldDescriptorCount': len(snapshot.fds), 'descriptorCapacityBound': MAX_FDS,
            'layout': 'packet',
            'receiptSha256': sha(blobs['receipt.json']), 'aliases': aliases,
            'outputsExecuted': False, 'nativeAdmission': False, 'nativeOwnerVerified': False,
            'linuxExecutionVerified': False, 'vmExecutionVerified': False, 'activationEnabled': False}
        snapshot.pin, snapshot.receipt = contract, receipt
        snapshot.recheck()
        return snapshot
    except BaseException:
        snapshot.close()
        raise


class FilesystemOps:
    """Owner observations may be injected in portable tests, never as proof."""
    def owner(self, fd):
        return os.fstat(fd).st_uid


class SealedRoot(Handles):
    def __init__(self, snapshot, destination, ops):
        super().__init__()
        self.snapshot, self.path, self.ops = snapshot, Path(destination), ops
        self.files, self.directories = {}, {}
        self.synthetic_owner_observations = type(ops) is not FilesystemOps

    def __enter__(self):
        require(not self.closed, 'closed sealed root')
        return self

    def __exit__(self, *_):
        self.close()

    def recheck(self):
        self.check_edges()
        for name, (fd, expected, observed) in self.files.items():
            require(identity(os.fstat(fd)) == observed, 'sealed copy changed: ' + name)
            measure_fd(fd, expected)
        for name, (fd, children, observed) in self.directories.items():
            require(identity(os.fstat(fd)) == observed and directory_names(fd, children) == children,
                    'sealed directory changed: ' + name)


def create_launch_root(snapshot, destination, ops=None):
    """Copy only three artifacts and six pinned libraries, then permission-seal.

    The one other leaf, the outside canary, is created here (exclusively), never copied.
    This function does not require/elevate Root or grant native admission. Use
    guard_root_owner separately with real observations before any admitted run.
    Copies are ordinary independent files, never hardlinks to input or host /lib.
    """
    require(isinstance(snapshot, Snapshot) and not snapshot.closed, 'live snapshot required')
    snapshot.recheck()  # No destination effects before COMPLETE validation.
    result = SealedRoot(snapshot, destination, ops or FilesystemOps())
    destination = Path(destination)
    require(destination.name not in ('', '.', '..'), 'invalid destination')
    created = False
    try:
        parent = result.directory(destination.parent)
        result.ancestor_fds = tuple(result.fds)
        result.destination_parent_fd = parent
        os.mkdir(destination.name, 0o700, dir_fd=parent)
        created = True
        root = result.hold(os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent))
        result.edges.append((parent, destination.name, root))
        sources = {'artifacts/' + role: 'artifacts/' + role for role in ARTIFACTS}
        sources.update({path.lstrip('/'): 'environment/' + path.lstrip('/') for path in ENVIRONMENT})
        directories = {''}
        for name in sources:
            path = name.split('/')
            directories.update('/'.join(path[:i]) for i in range(1, len(path)))
        view = 'run/winter/instruction-reader-views/' + VIEW_ID
        directories.update('/'.join(view.split('/')[:i]) for i in range(1, 5))
        held_dirs = {'': root}
        for name in sorted(directories - {''}, key=lambda n: (n.count('/'), n)):
            upper, _, leaf = name.rpartition('/')
            parent_fd = held_dirs[upper]
            os.mkdir(leaf, 0o700, dir_fd=parent_fd)
            fd = result.hold(os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd))
            held_dirs[name] = fd
            result.edges.append((parent_fd, leaf, fd))
        for target, source in sorted(sources.items()):
            parent_name, _, leaf = target.rpartition('/')
            parent_fd = held_dirs[parent_name]
            fd = result.hold(os.open(leaf, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent_fd))
            result.edges.append((parent_fd, leaf, fd))
            source_fd, expected, observed = snapshot.files[source]
            require(identity(os.fstat(source_fd)) == observed, 'source changed before copy')
            measure_fd(source_fd, expected, copy_fd=fd)
            os.fsync(fd)
            os.fchmod(fd, 0o555)
            # No writable descriptor survives permission sealing.
            read_only = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
            require(identity(os.fstat(read_only)) == identity(os.fstat(fd)), 'sealed reopen race')
            result.edges.remove((parent_fd, leaf, fd))
            result.fds.remove(fd)
            os.close(fd)
            fd = result.hold(read_only)
            result.edges.append((parent_fd, leaf, fd))
            copied = measure_fd(fd, expected)
            require(copied[:2] != observed[:2], 'copy shares input inode')
            result.files[target] = (fd, dict(expected), copied)
        # The outside canary: created, never copied; O_EXCL refuses anything already at that name.
        try:
            fd = result.hold(os.open(CANARY_LEAF, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=root))
        except FileExistsError as occupied:
            raise Refusal('launch root canary leaf occupied') from occupied
        result.edges.append((root, CANARY_LEAF, fd))
        written = 0
        while written < len(CANARY_CONTENT):
            written += os.write(fd, CANARY_CONTENT[written:])
        os.fsync(fd)
        os.fchmod(fd, CANARY_MODE)
        read_only = os.open(CANARY_LEAF, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
        require(identity(os.fstat(read_only)) == identity(os.fstat(fd)), 'sealed reopen race')
        result.edges.remove((root, CANARY_LEAF, fd))
        result.fds.remove(fd)
        os.close(fd)
        fd = result.hold(read_only)
        result.edges.append((root, CANARY_LEAF, fd))
        canary = {'bytes': len(CANARY_CONTENT), 'sha256': sha(CANARY_CONTENT)}
        result.files[CANARY_LEAF] = (fd, canary, measure_fd(fd, canary))
        for name, fd in sorted(held_dirs.items(), key=lambda p: p[0].count('/'), reverse=True):
            os.fchmod(fd, 0o700 if name == view else 0o555)
            children = {n[len(name) + (1 if name else 0):].split('/')[0]
                        for n in directories | set(sources) | {CANARY_LEAF} if n != name and
                        (not name or n.startswith(name + '/'))}
            children.discard('')
            result.directories[name] = (fd, children, identity(os.fstat(fd)))
        snapshot.recheck()
        result.recheck()
        result.measurements = dict(snapshot.measurements, kind='winter-reader-parent-sealed-data-root',
            copiedFiles=9, createdLeaves=1, rootOwnerVerified=False, syntheticOwnerObservations=result.synthetic_owner_observations)
        return result
    except BaseException as error:
        # Cleanup only through held descriptors: never traverse a replacement path.
        if created:
            try:
                named_root = os.stat(destination.name, dir_fd=parent, follow_symlinks=False)
                require((named_root.st_dev, named_root.st_ino) ==
                        (os.fstat(root).st_dev, os.fstat(root).st_ino), 'cleanup root replaced')
                for fd, _, _ in result.directories.values():
                    os.fchmod(fd, 0o700)
                for fd in locals().get('held_dirs', {}).values():
                    os.fchmod(fd, 0o700)
                if 'held_dirs' in locals():
                    try:
                        os.unlink(CANARY_LEAF, dir_fd=held_dirs[''])
                    except FileNotFoundError:
                        pass
                for target in sorted(locals().get('sources', {}), reverse=True):
                    upper, _, leaf = target.rpartition('/')
                    try:
                        os.unlink(leaf, dir_fd=held_dirs[upper])
                    except FileNotFoundError:
                        pass
                for name in sorted(locals().get('held_dirs', {}), key=lambda n: (n.count('/'), n), reverse=True):
                    if name:
                        upper, _, leaf = name.rpartition('/')
                        os.rmdir(leaf, dir_fd=held_dirs[upper])
                os.rmdir(destination.name, dir_fd=parent)
            except BaseException as cleanup_error:
                error.add_note('sealed-root cleanup uncertain: ' + str(cleanup_error))
        result.close()
        raise


def runtime_file_mode(name):
    """Sealed runtime objects are 0555; the canary alone is a world-readable 0444 data file."""
    return CANARY_MODE if name == CANARY_LEAF else RUNTIME_FILE_MODE


def canary_ok(info):
    """Root-created, Root-group, 0444 regular file. Unprivileged callers can only reach this through a Root guard."""
    return (stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_gid == 0 and
            stat.S_IMODE(info.st_mode) == CANARY_MODE and info.st_nlink == 1)


def guard_root_owner(root):
    """Explicit real Root/seal guard. Injected observations never grant proof."""
    require(isinstance(root, SealedRoot) and not root.synthetic_owner_observations,
            'real filesystem owner observations required')
    require(sys.platform == 'linux' and os.geteuid() == 0, 'actual Linux Root caller required')
    root.recheck()
    for fd in root.ancestor_fds:
        info = os.fstat(fd)
        require(info.st_uid == 0 and not (stat.S_IMODE(info.st_mode) & 0o022),
                'Root-owned protected launch ancestry required')
    require(stat.S_IMODE(os.fstat(root.destination_parent_fd).st_mode) == 0o700,
            'Root-owned 0700 launch parent required')
    for fd, _, _ in list(root.files.values()) + list(root.directories.values()):
        require(os.fstat(fd).st_uid == 0 and root.ops.owner(fd) == 0,
                'actual Root ownership required')
    for name, (fd, _, _) in root.files.items():
        require(stat.S_IMODE(os.fstat(fd).st_mode) == runtime_file_mode(name), 'runtime object mode')
    require(canary_ok(os.fstat(root.files[CANARY_LEAF][0])), 'canary leaf Root 0444 required')
    for name, (fd, _, _) in root.directories.items():
        expected = 0o700 if name == 'run/winter/instruction-reader-views/' + VIEW_ID else 0o555
        require(stat.S_IMODE(os.fstat(fd).st_mode) == expected, 'runtime directory mode')
    return True


def recheck_runtime(root):
    """Full hash+identity checks before exec and again after output drain.

    A caller must invoke both times; this function itself runs no child and
    produces no execution receipt. Keep both contexts open for that lifetime.
    """
    require(isinstance(root, SealedRoot) and not root.closed, 'live sealed root required')
    root.snapshot.recheck()
    root.recheck()
    return dict(root.measurements)
