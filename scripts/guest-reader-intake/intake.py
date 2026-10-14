"""Unprivileged, standard-library-only reader packet intake. All outputs are DATA.

Nothing from the packet is imported, launched, extracted by tarfile, or queried
with ldd. Pins are caller-reviewed input, independent of packet declarations.
"""
from __future__ import annotations

import argparse
import contextlib
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import stat
import tarfile
import tempfile
import unicodedata

MAX_INVENTORY = 4 * 1024 * 1024
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_LEAF = 128 * 1024 * 1024
MAX_BYTES = 512 * 1024 * 1024
MAX_LEAVES = 20000
MAX_PATH_DEPTH = 64
MAX_PREFIX_VISITS = 60000
CHUNK = 65536
ORIGINS = frozenset(('runtime', 'sdk', 'overlay', 'builder'))
ARTIFACTS = frozenset(('instructionReader', 'instructionReaderLauncher'))
ENVIRONMENT = frozenset('/lib/' + x for x in (
    'ld-linux-aarch64.so.1', 'aarch64-linux-gnu/ld-linux-aarch64.so.1',
    'aarch64-linux-gnu/libc.so.6', 'aarch64-linux-gnu/libdl.so.2',
    'aarch64-linux-gnu/libm.so.6', 'aarch64-linux-gnu/libpthread.so.0'))
FALSE_RECEIPT_FLAGS = (
    'activationEnabled', 'autoloadExecutionVerified',
    'dependencyPackageAttestationVerified', 'dynamicRuntimeImportsVerified',
    'executedPythonSourceAuthenticated', 'globalBunConfigurationExecutionVerified',
    'linuxExecutionVerified', 'nativeOwnerVerified', 'trustedToolchainVerified',
    'vmExecutionVerified')
ROLE_MODES = dict.fromkeys(('source', 'metadata', 'environment', 'reader',
                           'readerLauncher', 'base'), 0o400)


class Refusal(ValueError):
    """Packet or destination does not satisfy the reviewed DATA contract."""


def require(condition, reason):
    if not condition:
        raise Refusal(reason)


def unprivileged():
    require(os.geteuid() != 0, 'root intake is forbidden')


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
        raise Refusal('invalid bounded JSON') from error


def name_ok(name):
    require(isinstance(name, str) and name and len(name.encode()) <= 4096,
            'invalid path length')
    require(not any(ord(c) < 32 or c == '\\' or ord(c) == 127 for c in name),
            'invalid path characters')
    parts = name.split('/')
    require(len(parts) <= MAX_PATH_DEPTH, 'path depth bound')
    require(all(p not in ('', '.', '..') for p in parts), 'noncanonical path')
    require(unicodedata.normalize('NFC', name) == name, 'noncanonical Unicode path')
    return parts


@contextlib.contextmanager
def directory_fd(path):
    """Walk every ancestor without following a symlink, then hold its fd."""
    raw = os.fspath(path)
    require('..' not in Path(raw).parts, 'parent traversal')
    absolute = Path(os.path.abspath(raw))
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in absolute.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def input_file(path, limit):
    path = Path(path)
    with directory_fd(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        identity = os.fstat(fd)
        require(stat.S_ISREG(identity.st_mode) and identity.st_nlink == 1,
                'input must be a regular single-link file')
        require(identity.st_uid == os.geteuid() and 0 <= identity.st_size <= limit,
                'input ownership/size')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            yield stream, identity
        after = os.fstat(fd)
        fields = ('st_dev', 'st_ino', 'st_mode', 'st_nlink', 'st_uid', 'st_gid',
                  'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(all(getattr(after, k) == getattr(identity, k) for k in fields),
                'input changed during read')
    finally:
        os.close(fd)


def read_bounded(path, limit):
    with input_file(path, limit) as (stream, _):
        data = stream.read(limit + 1)
        require(len(data) <= limit, 'input grew beyond bound')
        return data


def check_inventory(inv, pin):
    require(inv['kind'] == 'winter-reader-compile-packet' and inv['formatVersion'] == 1,
            'inventory format')
    for flag in ('activationEnabled', 'nativeAdmission', 'outputsExecuted', 'vmExecutionVerified'):
        require(inv[flag] is False, 'inventory authority claim')
    for key in ('archiveSha256', 'archiveBytes', 'builderHead', 'workflowHead', 'fileCount', 'fileBytes'):
        require(inv[key] == pin[key], 'inventory pin mismatch: ' + key)
    require(inv['excludedScratch'] == ['artifacts/native.d'], 'scratch exclusion')
    leaves = inv['files']
    require(isinstance(leaves, dict) and 0 < len(leaves) == inv['fileCount'] <= MAX_LEAVES,
            'leaf count bound')
    total = 0
    paths = {}
    directories = set()
    prefix_visits = 0
    for name, entry in leaves.items():
        parts = name_ok(name)
        prefix_visits += len(parts)
        require(prefix_visits <= MAX_PREFIX_VISITS, 'directory prefix visit bound')
        for i in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:i])
            folded = prefix.casefold()
            require(folded not in paths or paths[folded] == prefix, 'path alias collision')
            paths[folded] = prefix
            if i < len(parts):
                directories.add(prefix)
        require(entry.get('kind') in ('file', 'symlink'), 'unknown inventory role')
        if entry['kind'] == 'file':
            require(set(entry) == {'kind', 'bytes', 'sha256'}, 'file inventory keys')
            require(type(entry['bytes']) is int and 0 <= entry['bytes'] <= MAX_LEAF,
                    'leaf size bound')
            require(isinstance(entry['sha256'], str) and len(entry['sha256']) == 64
                    and all(c in '0123456789abcdef' for c in entry['sha256']), 'invalid digest')
            total += entry['bytes']
        else:
            require(set(entry) == {'kind', 'target'}, 'link inventory keys')
            require(isinstance(entry['target'], str) and 0 < len(entry['target'].encode()) <= 4096,
                    'link length')
    require(not (set(leaves) & directories), 'leaf is also an ancestor')
    require(total == inv['fileBytes'] and total <= MAX_BYTES, 'total payload bound')
    return leaves, directories


def resolve_alias(name, target, leaves, directories):
    require(target and not target.startswith('/') and '\\' not in target,
            'absolute or invalid alias')
    todo = list(PurePosixPath(name).parent.parts) + target.split('/')
    done = []
    seen = set()
    while todo:
        part = todo.pop(0)
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
            require(key not in seen and len(seen) < 32, 'alias cycle/depth')
            seen.add(key)
            done.pop()
            linked = entry['target']
            require(not linked.startswith('/') and '\\' not in linked, 'alias escape')
            todo = linked.split('/') + todo
        elif todo:
            require(key in directories, 'alias traverses missing/non-directory leaf')
    result = '/'.join(done)
    require(result in leaves or result in directories, 'dangling alias')
    require(result.startswith('source/sdk/packages/'), 'alias outside captured package roots')
    return result


def check_contract(inv, pin, blobs):
    leaves, directories = check_inventory(inv, pin)
    receipt = parse_json(blobs['receipt.json'])
    inputs = parse_json(blobs['inputs.json'])
    require(sha(blobs['receipt.json']) == pin['receiptSha256'], 'receipt pin')
    require(receipt['kind'] == 'winter-reader-compile' and receipt['formatVersion'] == 1,
            'receipt format')
    for flag in FALSE_RECEIPT_FLAGS:
        require(receipt[flag] is False, 'receipt authority claim')
    require(receipt['staticMetafileOnly'] is True, 'static receipt marker')
    require(sha(blobs['inputs.json']) == receipt['inputsSha256'], 'inputs binding')
    require(sha(blobs['artifacts/instructionReader.metafile.json']) == receipt['metafileSha256'],
            'metafile binding')
    origins = receipt['origins']
    require(len(origins) == 4 and {o['role'] for o in origins} == ORIGINS, 'four source origins')
    require(inputs['origins'] == origins, 'inputs origin binding')
    require([{k: v for k, v in o.items() if k != 'eligibleFiles'} for o in origins] == pin['origins'],
            'exact source origin identities')
    captured = set()
    for origin in origins:
        files = origin['eligibleFiles']
        require(sha(canonical(files)) == origin['inventorySha256'], 'origin inventory digest')
        for name, entry in files.items():
            name_ok(name)
            key = 'source/' + origin['role'] + '/' + name
            require(leaves.get(key) == entry, 'origin leaf mismatch')
            captured.add(key)
    bindings = receipt['resolverBindings']
    require(bindings == inputs['resolverBindings'] == pin['resolverBindings'], 'resolver binding pin')
    links = {n for n, v in leaves.items() if v['kind'] == 'symlink'}
    require(links == set(bindings), 'unbound alias')
    resolved = {}
    for name, binding in bindings.items():
        require(binding['origin'] == 'sdk' and binding['version'] == '0.0.53', 'package identity')
        require(leaves[name] == {'kind': 'symlink', 'target': binding['target']}, 'alias spelling pin')
        resolved[name] = resolve_alias(name, binding['target'], leaves, directories)
        captured.add(name)
    require(captured == {n for n in leaves if n.startswith('source/')}, 'extra/missing source leaf')
    require(set(receipt['artifacts']) == set(pin['artifacts']) == ARTIFACTS, 'compiled reader roles')
    for role, artifact in receipt['artifacts'].items():
        value = {k: artifact[k] for k in ('bytes', 'sha256')}
        require(value == pin['artifacts'][role], 'artifact pin')
        require(leaves['artifacts/' + role] == dict(value, kind='file'), 'artifact leaf')
    deps = receipt['runtimeDependencies']
    require(set(deps) == set(pin['runtimeDependencies']) == ENVIRONMENT, 'six declared environment paths')
    for guest, dependency in deps.items():
        value = {k: dependency[k] for k in ('bytes', 'sha256')}
        require(value == pin['runtimeDependencies'][guest], 'environment pin')
        require(leaves['environment/' + guest.lstrip('/')] == dict(value, kind='file'), 'environment leaf')
    require({n for n in leaves if n.startswith('environment/')} ==
            {'environment/' + n.lstrip('/') for n in deps}, 'extra environment leaf')
    require(receipt['base'] == pin['base'] and
            leaves['stage/linux-bun-base']['sha256'] == pin['base']['executableSha256'], 'base pin')
    for name, entry in inputs['stagedInputs'].items():
        require(leaves.get(name) == entry, 'staged input mismatch')
    require(inputs['dependencies'] == {}, 'unexpected dependency graph')
    return receipt, resolved


class ValidatedPacket:
    """Private spool lifetime; use only the result returned by validate_packet."""
    def __init__(self, temporary, inventory, pin, receipt, aliases, files):
        self._temporary = temporary
        self._inventory = inventory
        self._pin = pin
        self._receipt = receipt
        self._aliases = aliases
        self._files = files
        self._closed = False

    def __enter__(self):
        require(not self._closed, 'closed validation')
        return self

    def close(self):
        if not self._closed:
            self._temporary.cleanup()
            self._closed = True

    def __exit__(self, *_):
        self.close()


def load_pin(path=None):
    path = path or Path(__file__).with_name('compile-38502659264.pin.json')
    return parse_json(read_bounded(path, MAX_INVENTORY))


def validate_packet(archive: Path, inventory: Path, *, pin=None) -> ValidatedPacket:
    """Validate exact DATA pins into a private spool, without creating output."""
    unprivileged()
    pin = parse_json(canonical(pin if pin is not None else load_pin()))
    require(pin['formatVersion'] == 1, 'pin format')
    raw = read_bounded(inventory, MAX_INVENTORY)
    require(len(raw) == pin['inventoryBytes'] and sha(raw) == pin['inventorySha256'], 'inventory pin')
    inv = parse_json(raw)
    leaves, _ = check_inventory(inv, pin)
    temporary = tempfile.TemporaryDirectory(prefix='winter-reader-data-',
                                             dir=Path(tempfile.gettempdir()).resolve())
    spool = Path(temporary.name)
    files = {}
    controls = {}
    try:
        # A held, independently hashed archive copy prevents path replacement
        # between validation passes. Source changes never become copy authority.
        archive_copy = spool / 'archive'
        with input_file(archive, MAX_ARCHIVE) as (source, identity), archive_copy.open('xb') as output:
            digest = hashlib.sha256()
            count = 0
            while chunk := source.read(CHUNK):
                count += len(chunk)
                require(count <= MAX_ARCHIVE, 'archive bound')
                digest.update(chunk)
                output.write(chunk)
            require(count == identity.st_size == pin['archiveBytes'] and
                    digest.hexdigest() == pin['archiveSha256'], 'archive pin')
        os.chmod(archive_copy, 0o400)
        seen = set()
        total = 0
        with gzip.open(archive_copy, 'rb') as stream:
            # Parse physical headers directly: PAX/GNU longname extensions and
            # concatenated tar payloads cannot disappear behind tarfile iteration.
            while True:
                header = stream.read(512)
                require(len(header) == 512, 'truncated tar header')
                if header == b'\0' * 512:
                    require(stream.read(512) == b'\0' * 512, 'tar end marker')
                    tail = stream.read(10241)
                    require(len(tail) <= 10240 and not tail.strip(b'\0'), 'tar trailing payload/bound')
                    break
                try:
                    member = tarfile.TarInfo.frombuf(header, 'utf-8', 'strict')
                except (tarfile.TarError, UnicodeError, ValueError) as error:
                    raise Refusal('invalid physical tar header') from error
                name = member.name
                name_ok(name)
                require(name not in seen and name in leaves and len(seen) < MAX_LEAVES,
                        'duplicate or unexpected tar leaf')
                require(member.uid == member.gid == member.mtime == 0 and
                        not member.uname and not member.gname and
                        member.devmajor == member.devminor == 0, 'tar metadata')
                entry = leaves[name]
                seen.add(name)
                if member.type == tarfile.SYMTYPE:
                    require(member.mode == 0o777 and member.size == 0 and
                            entry == {'kind': 'symlink', 'target': member.linkname}, 'tar alias mismatch/mode')
                    continue
                require(member.type == tarfile.REGTYPE and not member.linkname and member.mode == 0o400,
                        'tar special, hardlink or mode')
                require(entry['kind'] == 'file' and member.size == entry['bytes'] and
                        0 <= member.size <= MAX_LEAF, 'tar file size')
                total += member.size
                require(total <= MAX_BYTES, 'tar payload bound')
                held = spool / ('leaf-' + str(len(seen)))
                remaining = member.size
                digest = hashlib.sha256()
                with held.open('xb') as output:
                    while remaining:
                        chunk = stream.read(min(CHUNK, remaining))
                        require(chunk, 'truncated tar body')
                        remaining -= len(chunk)
                        digest.update(chunk)
                        output.write(chunk)
                require(digest.hexdigest() == entry['sha256'], 'tar content digest: ' + name)
                os.chmod(held, 0o400)
                files[name] = held
                padding = stream.read((-member.size) % 512)
                require(len(padding) == (-member.size) % 512 and not padding.strip(b'\0'), 'tar body padding')
                if name in ('receipt.json', 'inputs.json', 'artifacts/instructionReader.metafile.json'):
                    require(member.size <= MAX_INVENTORY, 'control document bound')
                    controls[name] = held.read_bytes()
        require(seen == set(leaves) and total == inv['fileBytes'], 'incomplete tar inventory')
        receipt, aliases = check_contract(inv, pin, controls)
        archive_copy.unlink()
        return ValidatedPacket(temporary, inv, pin, receipt, aliases, files)
    except BaseException:
        temporary.cleanup()
        raise


def output_name(name, layout):
    if layout == 'siblings' and name.startswith('source/'):
        return name[len('source/'):]
    return name


def role_of(name):
    if name == 'artifacts/instructionReader':
        return 'reader'
    if name == 'artifacts/instructionReaderLauncher':
        return 'readerLauncher'
    if name == 'stage/linux-bun-base':
        return 'base'
    return 'source' if name.startswith('source/') else 'environment' if name.startswith('environment/') else 'metadata'


@contextlib.contextmanager
def relative_parent(root_fd, name):
    """Hold all mapped parents with no-follow opens, including mid-copy races."""
    parts = name_ok(name)
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd, parts[-1]
    finally:
        os.close(fd)


def rehydrate_packet(validated: ValidatedPacket, destination: Path, *, layout='packet') -> dict:
    """Copy validated DATA into a fresh directory; assign modes by explicit role.

    The destination is created only after validation. A copy failure removes it.
    This is unprivileged local materialization, not atomic/native launch admission
    or protection from another process owned by the same user.
    """
    unprivileged()
    require(isinstance(validated, ValidatedPacket) and not validated._closed, 'closed/invalid validation')
    require(layout in ('packet', 'siblings'), 'unknown layout')
    destination = Path(destination)
    require(destination.name not in ('', '.', '..'), 'invalid destination')
    leaves = validated._inventory['files']
    mapped = {name: output_name(name, layout) for name in leaves}
    require(len(set(mapped.values())) == len(mapped), 'layout collision')
    # Aliases are mapped from their resolved, validated captured target identity,
    # never guessed from an archive spelling or an uncaptured filesystem path.
    links = {}
    for name, resolved in validated._aliases.items():
        new_name = mapped[name]
        target = output_name(resolved, layout)
        links[new_name] = posixpath.relpath(target, posixpath.dirname(new_name))
    dirs = sorted({str(p) for name in mapped.values() for p in PurePosixPath(name).parents
                   if str(p) != '.'}, key=lambda n: (n.count('/'), n))
    with directory_fd(destination.parent) as parent:
        require(os.fstat(parent).st_uid == os.geteuid(), 'output parent ownership')
        os.mkdir(destination.name, 0o700, dir_fd=parent)
        try:
            root_fd = os.open(destination.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        except BaseException:
            # The fresh directory is still empty; opening it failed before any
            # child copy. Remove only that directory through the held parent.
            os.rmdir(destination.name, dir_fd=parent)
            raise
        try:
            for name in dirs:
                with relative_parent(root_fd, name) as (fd, leaf):
                    os.mkdir(leaf, 0o700, dir_fd=fd)
            for name, held in validated._files.items():
                target = mapped[name]
                with relative_parent(root_fd, target) as (parent_fd, leaf):
                    fd = os.open(leaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=parent_fd)
                try:
                    digest = hashlib.sha256()
                    count = 0
                    with input_file(held, MAX_LEAF) as (source, _), os.fdopen(fd, 'wb', closefd=False) as output:
                        while chunk := source.read(CHUNK):
                            count += len(chunk)
                            require(count <= leaves[name]['bytes'], 'spool copy bound')
                            digest.update(chunk)
                            output.write(chunk)
                    require(count == leaves[name]['bytes'] and digest.hexdigest() == leaves[name]['sha256'],
                            'spool changed before copy')
                    os.fchmod(fd, ROLE_MODES[role_of(name)])
                finally:
                    os.close(fd)
            for name, target in links.items():
                with relative_parent(root_fd, name) as (fd, leaf):
                    os.symlink(target, leaf, dir_fd=fd)
            for name in reversed(dirs):
                with relative_parent(root_fd, name) as (parent_fd, leaf):
                    fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                try:
                    os.fchmod(fd, 0o500)
                finally:
                    os.close(fd)
            os.fchmod(root_fd, 0o500)
        except BaseException:
            # Only fresh children made above are cleaned. Never follow aliases.
            os.fchmod(root_fd, 0o700)
            for name in dirs:
                try:
                    with relative_parent(root_fd, name) as (parent_fd, leaf):
                        fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
                        try:
                            os.fchmod(fd, 0o700)
                        finally:
                            os.close(fd)
                except FileNotFoundError:
                    pass
            shutil.rmtree(destination.name, dir_fd=parent)
            raise
        finally:
            os.close(root_fd)
    result = {'formatVersion': 1, 'kind': 'winter-reader-data-rehydration',
            'archiveSha256': validated._pin['archiveSha256'],
            'inventorySha256': validated._pin['inventorySha256'],
            'receiptSha256': validated._pin['receiptSha256'],
            'origins': validated._pin['origins'], 'artifacts': validated._pin['artifacts'],
            'runtimeDependencies': validated._pin['runtimeDependencies'], 'base': validated._pin['base'],
            'layout': layout, 'files': mapped, 'aliases': links, 'roleModes': ROLE_MODES.copy(),
            'fileCount': len(leaves), 'fileBytes': validated._inventory['fileBytes'],
            'outputExecution': False, 'nativeAdmission': False, 'activationEnabled': False,
            'outputsExecuted': False, 'linuxExecutionVerified': False, 'nativeOwnerVerified': False,
            'profileActivation': False, 'authorityGranted': False, 'vmExecutionVerified': False}
    result.update(dict.fromkeys(FALSE_RECEIPT_FLAGS, False))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--layout', choices=('packet', 'siblings'), default='packet')
    args = parser.parse_args()
    with validate_packet(args.archive, args.inventory) as validated:
        if args.destination:
            result = rehydrate_packet(validated, args.destination, layout=args.layout)
        else:
            result = {'kind': 'winter-reader-data-validation', 'fileCount': len(validated._inventory['files']),
                      'fileBytes': validated._inventory['fileBytes'], 'archiveSha256': validated._pin['archiveSha256'],
                      'inventorySha256': validated._pin['inventorySha256'], 'receiptSha256': validated._pin['receiptSha256'],
                      'outputExecution': False, 'nativeAdmission': False, 'activationEnabled': False,
                      'outputsExecuted': False, 'profileActivation': False,
                      'authorityGranted': False, 'vmExecutionVerified': False}
            result.update(dict.fromkeys(FALSE_RECEIPT_FLAGS, False))
        print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
