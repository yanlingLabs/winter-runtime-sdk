"""External reader wrapper SOURCE ONLY; no CLI, downloader or native admission.

The future workflow must hash-admit this bootstrap before privileged execution
with python3 -I -S -B. Tokens are never inputs to this module. Captured packet
Python is DATA and is never imported. Host Python/libc remain trusted tooling.
"""
import hashlib
from datetime import datetime, timezone
import os
from pathlib import Path
import stat
import sys
import types

SOURCE_PINS = {
    'parent.py': '856dc389f06ae973b1c1a65149671d984288cf558d7a461e32c89758036c63af',
    'producer.py': 'a3c8dee9d422a6dd9bf39235c549843c70e40892c6294f41f5e8c34da972feab',
    'control.py': '05b63cfda7ef6022e13dce89e2f653db7a1b476a2904e9f57787bc12f99f1722',
    'fixture.py': '108715d6d4b182e1a7d162fb3096cba1620b71e201dc4338c3da968a0a9d5814',
    'native_cases.py': '4d2824ab9ee4abbf92e0930f77926368d4a102b2c864bd4c38dffad2c4fb588f',
}
MODULE_ORDER = (('control', 'control.py'), ('producer', 'producer.py'),
                ('reader_parent', 'parent.py'), ('reader_fixture', 'fixture.py'),
                ('native_cases', 'native_cases.py'))
MAX_FILE = 64 * 1024
MAX_SOURCE_BYTES = 256 * 1024
COMPILE_PIN = 'compile-38502659264.pin.json'
COMPILE_PIN_SHA256 = 'e319e8a859dcc891a59c8a2d4134aa02ad8dd0da94bca45b339e49fdc92bae2b'
ACQUISITION_METADATA = {
    'repository_id': 1358618589, 'run_id': 38502659264,
    'head_sha': '29fe5cff1ea0b93d7970cfee566030f3532fdd74',
    'artifact_id': 11866353126, 'artifact_name': 'reader-compile-packet-38502659264',
    'size_in_bytes': 81095921, 'expired': False, 'expires_at': '2026-10-21T02:45:33Z',
}
ACQUISITION_MEMBERS = {
    'reader-packet.tar.gz': (81359155, 'e3863c0ebe91a7cbe4efc0c63cf5adb232dbb5bddd1c897cd447045b8c96482b'),
    'packet-inventory.json': (243499, '21e790a4c3564510398f8630581493eb606b078b408cf880bb833485290b7c5f'),
}
OUTER_ZIP_SHA256 = 'bd586bafdcffeca4c4fbdfcdd65b4f8b807b2ff2b7ba8adfebbacf067874dfcd'


class Refusal(ValueError):
    pass


class Uncertain(Refusal):
    def __init__(self, lease, cause):
        super().__init__('reader_wrapper_uncertain')
        self.lease, self.cause = lease, cause


def require(value, reason):
    if not value:
        raise Refusal(reason)


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def read_fd(fd, limit):
    before = os.fstat(fd)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and 0 <= before.st_size <= limit, 'bounded independent source file')
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while True:
        chunk = os.read(fd, min(65536, limit + 1 - len(data)))
        if not chunk: break
        data.extend(chunk)
        require(len(data) <= limit, 'source read bound')
    require(identity(os.fstat(fd)) == identity(before)
            and len(data) == before.st_size, 'source read identity changed')
    return bytes(data)


def directory(path):
    """Hold every nofollow ancestor; caller owns returned handles."""
    path = Path(path)
    require(path.is_absolute() and len(str(path).encode()) <= 4096
            and len(path.parts) <= 64 and all(part not in ('.', '..')
                for part in path.parts[1:]), 'closed source directory path')
    handles, edges = [], []
    try:
        current = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        handles.append(current)
        for part in path.parts[1:]:
            held = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                           dir_fd=current)
            handles.append(held); edges.append((current, part, held))
            current = held
        return current, handles, edges
    except BaseException as error:
        failed = []
        for fd in reversed(handles):
            try: os.close(fd)
            except OSError: failed.append(fd)
        if failed:
            refusal = Refusal('source traversal descriptors retained')
            refusal.retained_fds = failed
            raise refusal from error
        raise


def check_edges(edges):
    for upper, leaf, held in edges:
        named, opened = os.stat(leaf, dir_fd=upper, follow_symlinks=False), os.fstat(held)
        require((named.st_dev, named.st_ino, named.st_mode) ==
                (opened.st_dev, opened.st_ino, opened.st_mode), 'source ancestry replaced')


class OwnerOps:
    def owner(self, fd):
        return os.fstat(fd).st_uid

    def protected_ancestor(self, fd):
        return self.owner(fd) == 0 and not stat.S_IMODE(os.fstat(fd).st_mode) & 0o022


class SourceLease:
    """Retains checked source FD/module identities, not a native capability."""
    def __init__(self, path, pins, ops, data_pin_digest=COMPILE_PIN_SHA256):
        self.path, self.pins, self.ops = Path(path), pins, ops
        self.all_pins = dict(pins, **{COMPILE_PIN: data_pin_digest})
        self.synthetic = (type(ops) is not OwnerOps or pins != SOURCE_PINS
                          or data_pin_digest != COMPILE_PIN_SHA256)
        self.fds, self.edges, self.files, self.modules = [], [], {}, {}
        self.closed, self.unresolved = False, False
        self.runtime = self.snapshot = self.fixture = self.case_failure = None

    def recheck(self):
        require(not self.closed, 'closed source lease')
        check_edges(self.edges)
        require(all(self.ops.protected_ancestor(fd) for fd in self.ancestor_fds)
                and stat.S_IMODE(os.fstat(self.parent_fd).st_mode) == 0o700,
                'protected source ancestry changed')
        require(set(os.listdir(self.root_fd)) == set(self.all_pins), 'closed source copy inventory')
        require(self.ops.owner(self.root_fd) == 0
                and stat.S_IMODE(os.fstat(self.root_fd).st_mode) == 0o500,
                'protected source root changed')
        for name, (fd, observed) in self.files.items():
            require(identity(os.fstat(fd)) == observed and self.ops.owner(fd) == 0
                    and stat.S_IMODE(os.fstat(fd).st_mode) == 0o400,
                    'protected source file changed')
            require(hashlib.sha256(read_fd(fd, MAX_FILE)).hexdigest() == self.all_pins[name],
                    'source hash changed')
        for name, module in self.modules.items():
            require(sys.modules.get(name) is module, 'trusted module alias replaced')
            filename = dict(MODULE_ORDER)[name]
            require(type(module) is types.ModuleType
                    and vars(module).get('__file__') == str(self.path/filename),
                    'trusted module source path replaced')

    def close(self):
        require(not self.unresolved, 'uncertain resources must remain owned')
        errors = []
        for fd in reversed(tuple(self.fds)):
            try: os.close(fd); self.fds.remove(fd)
            except OSError as error: errors.append(error)
        if errors:
            self.unresolved = True
            raise Uncertain(self, errors[0])
        self.closed = True


def copy_external_sources(source, destination, *, ops=None, pins=None,
                          compile_pin_path=None, compile_pin_sha256=COMPILE_PIN_SHA256):
    """Verify all source bytes before a fresh private destination is created.

    Injected owner/pin observations are DATA tests only; run_cases refuses them.
    The destination parent and every ancestor must be protected Root ownership.
    """
    ops = OwnerOps() if ops is None else ops
    pins = dict(SOURCE_PINS if pins is None else pins)
    require(set(pins) == set(SOURCE_PINS) and all(type(value) is str
            and len(value) == 64 and all(c in '0123456789abcdef' for c in value)
            for value in pins.values()), 'closed external source pins')
    require(type(compile_pin_sha256) is str and len(compile_pin_sha256) == 64
            and all(c in '0123456789abcdef' for c in compile_pin_sha256), 'compile pin digest')
    destination = Path(destination)
    require(destination.name not in ('', '.', '..'), 'fresh source destination')
    lease = SourceLease(destination, pins, ops, compile_pin_sha256)
    inputs = []
    try:
        source_fd, held, edges = directory(source)
        inputs.extend(held)
        captured = {}
        total = 0
        for name in sorted(pins):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=source_fd)
            inputs.append(fd)
            raw = read_fd(fd, MAX_FILE)
            total += len(raw)
            require(total <= MAX_SOURCE_BYTES and hashlib.sha256(raw).hexdigest() == pins[name],
                    'external source pin mismatch')
            named = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
            require(identity(named) == identity(os.fstat(fd)), 'source leaf replaced')
            captured[name] = raw
        check_edges(edges)
        pin_path = Path(compile_pin_path) if compile_pin_path is not None else Path(source).parent/'guest-reader-intake'/COMPILE_PIN
        pin_parent, held, pin_edges = directory(pin_path.parent)
        inputs.extend(held)
        pin_fd = os.open(pin_path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=pin_parent)
        inputs.append(pin_fd)
        pin_raw = read_fd(pin_fd, MAX_FILE)
        require(hashlib.sha256(pin_raw).hexdigest() == compile_pin_sha256,
                'external compile DATA pin mismatch')
        require(identity(os.stat(pin_path.name,dir_fd=pin_parent,follow_symlinks=False)) ==
                identity(os.fstat(pin_fd)), 'compile DATA pin replaced')
        check_edges(pin_edges)
        captured[COMPILE_PIN] = pin_raw
        upper, held, edges = directory(destination.parent)
        lease.fds.extend(held); lease.edges.extend(edges)
        lease.ancestor_fds = tuple(held)
        for fd in held:
            info = os.fstat(fd)
            require(ops.protected_ancestor(fd),
                    'protected Root source ancestry required')
        require(stat.S_IMODE(os.fstat(upper).st_mode) == 0o700,
                'private source parent required')
        os.mkdir(destination.name, 0o700, dir_fd=upper)
        root = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                       dir_fd=upper)
        lease.root_fd = root; lease.fds.append(root)
        lease.parent_fd = upper
        lease.edges.append((upper, destination.name, root))
        for name, raw in captured.items():
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=root)
            lease.fds.append(fd)
            at = 0
            while at < len(raw):
                count = os.write(fd, raw[at:]); require(count > 0, 'source copy write')
                at += count
            os.fsync(fd); os.fchmod(fd, 0o400)
            readonly = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
            lease.fds.append(readonly)
            require(identity(os.fstat(readonly)) == identity(os.fstat(fd)), 'source reopen changed')
            os.close(fd); lease.fds.remove(fd)
            lease.edges.append((root, name, readonly))
            lease.files[name] = (readonly, identity(os.fstat(readonly)))
        os.fchmod(root, 0o500)
        lease.recheck()
        return lease
    except BaseException as error:
        # No traversal/deletion retry on partial setup. Retain destination and
        # discoverable descriptors for the external owner's diagnostic/cleanup.
        lease.fds.extend(getattr(error, 'retained_fds', ()))
        lease.unresolved = True
        raise Uncertain(lease, error) from error
    finally:
        failed = []
        for fd in reversed(inputs):
            try: os.close(fd)
            except OSError: failed.append(fd)
        if failed:
            lease.fds.extend(failed); lease.unresolved = True
            raise Uncertain(lease, Refusal('source input descriptors retained'))


def load_external_modules(lease):
    """Execute ONLY the exact checked Root-copy bytes, never pathname loaders.

    Populate just the trusted aliases required by native_cases. No sys.path
    insertion or fallback to copied packet/checkout/pycache modules.
    """
    require(not lease.unresolved, 'uncertain source lease')
    lease.recheck()
    require(not lease.modules and all(name not in sys.modules for name, _ in MODULE_ORDER),
            'module alias already occupied')
    try:
        for name, filename in MODULE_ORDER:
            lease.recheck()
            raw = read_fd(lease.files[filename][0], MAX_FILE)
            require(hashlib.sha256(raw).hexdigest() == lease.pins[filename], 'source import pin')
            module = types.ModuleType(name)
            module.__file__ = str(lease.path / filename)
            module.__package__ = ''
            sys.modules[name] = module
            lease.modules[name] = module
            exec(compile(raw, str(lease.path / filename), 'exec'), module.__dict__)
        lease.recheck()
        return dict(lease.modules)
    except BaseException as error:
        lease.unresolved = True
        raise Uncertain(lease, error) from error


def native_guard(lease):
    require(not lease.synthetic and not lease.unresolved and sys.platform == 'linux' and os.getuid() == 0
            and os.geteuid() == 0 and sys.flags.isolated == 1 and sys.flags.no_site == 1
            and sys.dont_write_bytecode, 'isolated actual Root bootstrap required')
    lease.recheck()


def check_acquisition_metadata(metadata, now):
    require(type(metadata) is dict and len(metadata) == len(ACQUISITION_METADATA)
            and all(type(key) is str for key in metadata), 'closed acquisition metadata')
    require(set(metadata) == set(ACQUISITION_METADATA) and all(
        type(metadata[key]) is type(expected) and metadata[key] == expected
        for key, expected in ACQUISITION_METADATA.items()), 'exact acquisition metadata required')
    require(type(now) is datetime and now.tzinfo is not None
            and now.utcoffset() is not None
            and now < datetime(2026, 10, 21, 2, 45, 33, tzinfo=timezone.utc),
            'artifact expired or clock unavailable')


def check_acquisition_record(record, now):
    """Cross-check the DATA intake record, never promote it to authority."""
    keys = {'metadata','checked_at','directory','directory_identity','outer_zip_sha256',
            'outer_zip_identity','members','packet_data_validated','packet_code_imported',
            'native_execution','source_admission','execution_admission','vm_execution'}
    require(type(record) is dict and all(type(key) is str for key in record)
            and set(record) == keys, 'closed acquisition record required')
    check_acquisition_metadata(record['metadata'], now)
    require(type(record['outer_zip_sha256']) is str and record['outer_zip_sha256'] == OUTER_ZIP_SHA256
            and record['packet_data_validated'] is True and all(record[key] is False
                for key in ('packet_code_imported','native_execution','source_admission',
                            'execution_admission','vm_execution')), 'acquisition observation flags')
    require(type(record['checked_at']) is str and len(record['checked_at']) <= 64,
            'acquisition observation time')
    try:
        checked = datetime.fromisoformat(record['checked_at'].replace('Z','+00:00'))
    except ValueError as error:
        raise Refusal('acquisition observation time') from error
    require(checked.tzinfo is not None and checked.utcoffset() is not None and checked <= now,
            'acquisition observation time')
    members = record['members']
    require(type(members) in (list,tuple) and len(members) == 2, 'two acquisition members')
    seen = set()
    for member in members:
        require(type(member) is dict and set(member) == {'name','path','size','sha256','identity'}
                and type(member['name']) is str and member['name'] in ACQUISITION_MEMBERS
                and member['name'] not in seen, 'closed acquisition member')
        seen.add(member['name'])
        size, digest = ACQUISITION_MEMBERS[member['name']]
        require(type(member['size']) is int and member['size'] == size
                and type(member['sha256']) is str and member['sha256'] == digest,
                'acquisition member pin mismatch')


def run_cases(lease, packet_directory, inventory_file, launch_destination, fixture_destination,
              *, acquisition_record, now=None):
    """Unexecuted privileged orchestration, not granted by input shape.

    Exact external-parent/source/artifact/workflow admission remains required.
    On uncertainty this function retains every context; it cannot print a pass.
    """
    check_acquisition_record(acquisition_record, datetime.now(timezone.utc) if now is None else now)
    native_guard(lease)
    require(Path(launch_destination) == lease.path.parent/'runtime'
            and Path(fixture_destination) == lease.path.parent/'fixture',
            'fixed protected fixture siblings required')
    modules = load_external_modules(lease)
    parent, producer = modules['reader_parent'], modules['producer']
    data, cases = modules['reader_fixture'], modules['native_cases']
    try:
        producer.descriptor_preflight()
        pin = parent.load_pin(lease.path/COMPILE_PIN)
        lease.snapshot = parent.capture_packet(packet_directory, inventory_file, pin=pin)
        lease.runtime = parent.create_launch_root(lease.snapshot, launch_destination)
        parent.guard_root_owner(lease.runtime)
        lease.fixture = data.create_fixture(fixture_destination)
        def factory(debt, pair_factory):
            lease.recheck(); lease.fixture.recheck()
            return producer.NativeOperation(debt, lease.runtime,
                lease.fixture.fds['source'], lease.fixture.fds['shared'],
                parent.guard_root_owner, parent.recheck_runtime,
                control_pair_factory=pair_factory)
        outcomes = []
        for kind in ('same-owner', 'unexpected-parent', 'parent-exit'):
            observed = cases.run_case(kind, factory,
                data.request_bytes() if kind == 'same-owner' else b'')
            if kind == 'same-owner':
                data.verify_response(observed.observation.stdout, observed.observation.stderr)
            lease.fixture.recheck(); parent.recheck_runtime(lease.runtime); lease.recheck()
            outcomes.append({'kind': kind, 'descriptorsClosed': observed.descriptors_closed,
                             'elapsedSeconds': observed.elapsed_seconds,
                             'launcherExitCode': os.waitstatus_to_exitcode(observed.reaps.launcher_status),
                             'producerExitCode': os.waitstatus_to_exitcode(observed.reaps.producer_status),
                             'initExitCode': None if observed.reaps.init_status is None else os.waitstatus_to_exitcode(observed.reaps.init_status),
                             'nativeReapReceiptObserved': observed.observation.native_wait_status is not None,
                             'controlAndStdinHeldForParentExit': observed.keepalive_before_parent_exit})
        # Close only confirmed case resources. No directory/stage removal claim.
        lease.fixture.close(); lease.runtime.close(); lease.snapshot.close()
        lease.recheck()
        return {'kind': 'winter-reader-only-case-set', 'cases': outcomes,
                'readerCaseSetPassed': True, 'configEffectProven': False,
                'guidedGuestTurnVerified': False, 'productionActivation': False,
                'vmExecutionVerified': False, 'fixtureRemovalConfirmed': False}
    except BaseException as error:
        lease.unresolved = True; lease.case_failure = error
        raise Uncertain(lease, error) from error
