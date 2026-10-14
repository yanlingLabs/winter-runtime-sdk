"""Unprivileged, local-only ZIP DATA intake; no download, import or execution.

The caller supplies trusted acquisition metadata and an already downloaded ZIP.
Injected pins are for ordinary temporary DATA tests, never provenance authority.
Successful DATA validation does not admit source, ELF, a native run or a VM.
"""
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import os
from pathlib import Path
import secrets
import stat
import struct
import zlib


CHUNK = 128 * 1024
MAX_CENTRAL_BYTES = 16 * 1024
MAX_EOCD_BYTES = 22 + 65535
NAMES = ("reader-packet.tar.gz", "packet-inventory.json")


class AcquisitionError(ValueError):
    """Closed reason code; never include packet contents or environment data."""


@dataclass(frozen=True)
class ArtifactMetadata:
    repository_id: int
    run_id: int
    head_sha: str
    artifact_id: int
    artifact_name: str
    size_in_bytes: int
    expired: bool
    expires_at: str


@dataclass(frozen=True)
class MemberPin:
    name: str
    size: int
    sha256: str


@dataclass(frozen=True)
class AcquisitionPins:
    metadata: ArtifactMetadata
    members: tuple[MemberPin, MemberPin]
    outer_sha256: str


PRODUCTION_PINS = AcquisitionPins(
    ArtifactMetadata(1358618589, 38502659264,
                     "29fe5cff1ea0b93d7970cfee566030f3532fdd74", 11866353126,
                     "reader-compile-packet-38502659264", 81095921, False,
                     "2026-10-21T02:45:33Z"),
    (MemberPin(NAMES[0], 81359155,
               "e3863c0ebe91a7cbe4efc0c63cf5adb232dbb5bddd1c897cd447045b8c96482b"),
     MemberPin(NAMES[1], 243499,
               "21e790a4c3564510398f8630581493eb606b078b408cf880bb833485290b7c5f")),
    "bd586bafdcffeca4c4fbdfcdd65b4f8b807b2ff2b7ba8adfebbacf067874dfcd")


@dataclass(frozen=True)
class FileIdentity:
    device: int
    inode: int
    mode: int
    links: int
    uid: int
    gid: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True)
class CopiedMember:
    name: str
    path: str
    size: int
    sha256: str
    identity: FileIdentity


@dataclass(frozen=True)
class AcquisitionRecord:
    metadata: ArtifactMetadata
    checked_at: str
    directory: str
    directory_identity: FileIdentity
    outer_zip_sha256: str
    outer_zip_identity: FileIdentity
    members: tuple[CopiedMember, CopiedMember]
    packet_data_validated: bool = True
    packet_code_imported: bool = False
    native_execution: bool = False
    source_admission: bool = False
    execution_admission: bool = False
    vm_execution: bool = False

    def to_dict(self):
        return asdict(self)


def _refuse(code):
    raise AcquisitionError(code)


def _identity(fd):
    s = os.fstat(fd)
    return FileIdentity(s.st_dev, s.st_ino, s.st_mode, s.st_nlink, s.st_uid,
                        s.st_gid, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def _same(fd, identity):
    if _identity(fd) != identity:
        _refuse("identity-changed")


def _file(fd, size=None, mode=None):
    identity = _identity(fd)
    if not stat.S_ISREG(identity.mode) or identity.links != 1:
        _refuse("not-single-link-regular-file")
    if size is not None and identity.size != size:
        _refuse("file-size")
    if mode is not None and (stat.S_IMODE(identity.mode) != mode or
                             identity.uid != os.geteuid()):
        _refuse("file-owner-mode")
    return identity


def _path_parts(path):
    path = os.fspath(path)
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        _refuse("absolute-path-required")
    parts = path.split("/")[1:]
    if not parts or any(p in ("", ".", "..") for p in parts):
        _refuse("noncanonical-path")
    return parts


class _HeldPath:
    """Hold and recheck every pathname component without following links."""
    def __init__(self, path, *, directory=False):
        self.fds = []
        self.edges = []
        try:
            parts = _path_parts(path)
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            fd = os.open("/", flags | os.O_DIRECTORY)
            self.fds.append(fd)
            for index, part in enumerate(parts):
                is_dir = directory or index < len(parts) - 1
                child = os.open(part, flags | (os.O_DIRECTORY if is_dir else 0),
                                dir_fd=fd)
                self.fds.append(child)
                s = os.fstat(child)
                if is_dir and not stat.S_ISDIR(s.st_mode):
                    _refuse("not-directory")
                self.edges.append((fd, part, child, s.st_dev, s.st_ino))
                fd = child
            self.fd = fd
            self.recheck()
        except BaseException:
            self.close()
            raise

    def recheck(self):
        for parent, name, child, dev, ino in self.edges:
            s = os.stat(name, dir_fd=parent, follow_symlinks=False)
            held = os.fstat(child)
            if (s.st_dev, s.st_ino) != (dev, ino) or (
                    held.st_dev, held.st_ino) != (dev, ino) or stat.S_ISLNK(s.st_mode):
                _refuse("path-identity-changed")

    def close(self):
        for fd in reversed(self.fds):
            os.close(fd)
        self.fds.clear()


def _metadata(metadata, pins, now):
    if not isinstance(metadata, ArtifactMetadata) or metadata != pins.metadata:
        _refuse("metadata-pin")
    if any(type(getattr(metadata, name)) is not int for name in (
            "repository_id", "run_id", "artifact_id", "size_in_bytes")) or any(
            type(getattr(metadata, name)) is not str for name in (
                "head_sha", "artifact_name", "expires_at")):
        _refuse("metadata-type")
    if metadata.expired is not False:
        _refuse("artifact-expired")
    if not isinstance(now, datetime) or now.tzinfo is None or now.utcoffset() is None:
        _refuse("aware-time-required")
    expiry = datetime.strptime(metadata.expires_at, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc)
    if now >= expiry:
        _refuse("artifact-expired")
    if tuple(p.name for p in pins.members) != NAMES:
        _refuse("member-pin-shape")
    for p in pins.members:
        if type(p.size) is not int or p.size < 0 or len(p.sha256) != 64 or any(
                c not in "0123456789abcdef" for c in p.sha256):
            _refuse("member-pin-shape")
    if type(metadata.size_in_bytes) is not int or metadata.size_in_bytes < 22:
        _refuse("outer-size-pin")
    if len(pins.outer_sha256) != 64 or any(c not in "0123456789abcdef"
                                        for c in pins.outer_sha256):
        _refuse("outer-hash-pin-shape")


def _read_at(fd, offset, size):
    if offset < 0 or size < 0:
        _refuse("zip-bounds")
    result = bytearray()
    while len(result) < size:
        data = os.pread(fd, size - len(result), offset + len(result))
        if not data:
            _refuse("zip-truncated")
        result.extend(data)
    return bytes(result)


def _hash_fd(fd, size):
    digest = hashlib.sha256()
    offset = 0
    while offset < size:
        data = _read_at(fd, offset, min(CHUNK, size - offset))
        digest.update(data)
        offset += len(data)
    return digest.hexdigest()


def _zip_directory(fd, size, pins):
    """Capture only two bounded member ranges; never reparse mutable metadata.

    Closed format: two contiguous local entries, one bounded central directory,
    comment-free EOCD; stored/deflated regular DATA only. ZIP64, extras, comments,
    encrypted flags, multi-disk archives, prefixes and trailing bytes refuse.
    """
    tail_size = min(size, MAX_EOCD_BYTES)
    tail = _read_at(fd, size - tail_size, tail_size)
    # A comment-free EOCD must be exactly the final 22 bytes. Do not search for
    # attacker-selected earlier signatures or trust advertised directory counts.
    if len(tail) < 22 or tail[-22:-18] != b"PK\x05\x06":
        _refuse("zip-eocd")
    (_, disk, start_disk, disk_count, count, central_size,
     central_offset, comment_size) = struct.unpack("<4s4H2IH", tail[-22:])
    eocd_offset = size - 22
    if disk or start_disk or disk_count != 2 or count != 2 or comment_size:
        _refuse("zip-count-or-disk")
    if not 92 <= central_size <= MAX_CENTRAL_BYTES or (
            central_offset + central_size != eocd_offset):
        _refuse("zip-central-bounds")
    central = _read_at(fd, central_offset, central_size)
    records = []
    cursor = 0
    names = set()
    for _ in range(2):
        if cursor + 46 > len(central):
            _refuse("zip-central-shape")
        fields = struct.unpack_from("<4s6H3I5H2I", central, cursor)
        (signature, made, needed, flags, method, _time, _date, crc,
         compressed, uncompressed, name_len, extra_len, comment_len,
         disk_number, internal, external, local_offset) = fields
        if signature != b"PK\x01\x02" or needed > 20 or made >> 8 not in (0, 3):
            _refuse("zip-version-type")
        if flags & ~(0x800 | 0x8) or method not in (0, 8):
            _refuse("zip-encryption-or-method")
        if extra_len or comment_len or disk_number or internal not in (0, 1):
            _refuse("zip-extra-metadata")
        if max(compressed, uncompressed, local_offset) == 0xffffffff:
            _refuse("zip64")
        if not 1 <= name_len <= 64 or cursor + 46 + name_len > len(central):
            _refuse("zip-name-bounds")
        raw_name = central[cursor + 46:cursor + 46 + name_len]
        try:
            name = raw_name.decode("ascii")
        except UnicodeError:
            _refuse("zip-name")
        if name not in NAMES or name in names:
            _refuse("zip-name")
        names.add(name)
        pin = next(p for p in pins.members if p.name == name)
        if uncompressed != pin.size or compressed > central_offset or (
                method == 0 and compressed != uncompressed):
            _refuse("zip-member-size")
        unix_mode = external >> 16
        if external & 0x10 or stat.S_IFMT(unix_mode) not in (0, stat.S_IFREG):
            _refuse("zip-member-type")
        if made >> 8 == 0 and external >> 16:
            _refuse("zip-member-type")
        records.append((name, flags, method, crc, compressed, uncompressed,
                        local_offset, raw_name))
        cursor += 46 + name_len
    if cursor != len(central) or names != set(NAMES):
        _refuse("zip-central-shape")
    local_cursor = 0
    for name, flags, method, crc, compressed, uncompressed, offset, raw_name in sorted(
            records, key=lambda r: r[6]):
        if offset != local_cursor or offset + 30 > central_offset:
            _refuse("zip-local-bounds")
        (signature, needed, local_flags, local_method, _time, _date, local_crc,
         local_compressed, local_uncompressed, name_len,
         extra_len) = struct.unpack("<4s5H3I2H", _read_at(fd, offset, 30))
        if signature != b"PK\x03\x04" or needed > 20 or (
                local_flags, local_method, name_len, extra_len) != (
                flags, method, len(raw_name), 0):
            _refuse("zip-local-shape")
        if offset + 30 + name_len + compressed > central_offset:
            _refuse("zip-local-bounds")
        if _read_at(fd, offset + 30, name_len) != raw_name:
            _refuse("zip-local-name")
        if flags & 0x8:
            if (local_crc, local_compressed, local_uncompressed) not in (
                    (0, 0, 0), (crc, compressed, uncompressed)):
                _refuse("zip-local-size")
        elif (local_crc, local_compressed, local_uncompressed) != (
                crc, compressed, uncompressed):
            _refuse("zip-local-size")
        local_cursor = offset + 30 + name_len + compressed
        if flags & 0x8:
            if local_cursor + 12 > central_offset:
                _refuse("zip-descriptor-bounds")
            descriptor_size = 16 if _read_at(fd, local_cursor, 4) == b"PK\x07\x08" else 12
            if local_cursor + descriptor_size > central_offset:
                _refuse("zip-descriptor-bounds")
            descriptor = _read_at(fd, local_cursor, descriptor_size)[-12:]
            if struct.unpack("<3I", descriptor) != (crc, compressed, uncompressed):
                _refuse("zip-descriptor")
            local_cursor += descriptor_size
    if local_cursor != central_offset:
        _refuse("zip-local-shape")
    return tuple(_MemberRange(name, method, crc, compressed, uncompressed,
                              offset + 30 + len(raw_name))
                 for name, _flags, method, crc, compressed, uncompressed, offset,
                 raw_name in records)


@dataclass(frozen=True)
class _MemberRange:
    name: str
    method: int
    crc: int
    compressed_size: int
    size: int
    data_offset: int


@dataclass(frozen=True)
class _BoundedArchive:
    fd: int
    members: tuple[_MemberRange, _MemberRange]


def _stream_member(archive, pin, output_fd=None):
    """Read only captured compressed ranges, with bounded output and exact CRC.

    No EOCD, directory, local header or descriptor is reread. Raw DEFLATE output
    is capped on every decoder call; EOF must consume the entire declared range.
    """
    member = next(record for record in archive.members if record.name == pin.name)
    digest = hashlib.sha256()
    count = 0
    crc = 0

    def accept(data):
        nonlocal count, crc
        count += len(data)
        if count > pin.size:
            _refuse("member-stream-size")
        digest.update(data)
        crc = zlib.crc32(data, crc)
        if output_fd is not None:
            view = memoryview(data)
            while view:
                written = os.write(output_fd, view)
                if written <= 0:
                    _refuse("copy-write")
                view = view[written:]

    decoder = zlib.decompressobj(-zlib.MAX_WBITS) if member.method == 8 else None
    offset = member.data_offset
    remaining = member.compressed_size
    while remaining:
        raw = _read_at(archive.fd, offset, min(CHUNK, remaining))
        offset += len(raw)
        remaining -= len(raw)
        if decoder is None:
            accept(raw)
            continue
        pending = raw
        while pending:
            if decoder.eof:
                _refuse("member-deflate-trailing")
            data = decoder.decompress(pending, min(CHUNK, pin.size - count + 1))
            accept(data)
            if decoder.unused_data:
                _refuse("member-deflate-trailing")
            tail = decoder.unconsumed_tail
            if tail and len(tail) == len(pending) and not data:
                _refuse("member-deflate-progress")
            pending = tail
        if decoder.eof and remaining:
            _refuse("member-deflate-trailing")
    if decoder is not None and not decoder.eof:
        _refuse("member-deflate-truncated")
    if count != member.size or count != pin.size:
        _refuse("member-stream-size")
    if crc & 0xffffffff != member.crc:
        _refuse("member-stream-crc")
    if digest.hexdigest() != pin.sha256:
        _refuse("member-stream-hash")


def acquire_local_zip(zip_path, destination_parent, metadata, *, now,
                      pins=PRODUCTION_PINS):
    """Validate held local DATA, then copy into a new 0700 directory/0600 files.

    Paths must be absolute with no symlink ancestors or dot components. The
    destination parent must already be caller-owned and not group/world writable.
    On a copying failure a private incomplete directory can remain; it is never
    returned as validated. There are no archive extraction or cleanup effects.
    """
    _metadata(metadata, pins, now)
    source = destination = None
    directory_fd = None
    try:
        source = _HeldPath(zip_path)
        outer_identity = _file(source.fd, pins.metadata.size_in_bytes)
        outer_hash = _hash_fd(source.fd, outer_identity.size)
        if outer_hash != pins.outer_sha256:
            _refuse("outer-hash-pin")
        _same(source.fd, outer_identity)
        archive = _BoundedArchive(source.fd, _zip_directory(source.fd, outer_identity.size, pins))
        # Crucially, verify BOTH streams before any destination bytes.
        for pin in pins.members:
            _stream_member(archive, pin)
        source.recheck()
        _same(source.fd, outer_identity)
        if _hash_fd(source.fd, outer_identity.size) != outer_hash:
            _refuse("outer-hash-changed")
        _same(source.fd, outer_identity)
        destination = _HeldPath(destination_parent, directory=True)
        parent_stat = os.fstat(destination.fd)
        if parent_stat.st_uid != os.geteuid() or stat.S_IMODE(parent_stat.st_mode) & 0o022:
            _refuse("destination-parent-owner-mode")
        name = "reader-data-" + secrets.token_hex(16)
        os.mkdir(name, 0o700, dir_fd=destination.fd)
        directory_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY |
                               os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=destination.fd)
        os.fchmod(directory_fd, 0o700)
        directory_path = str(Path(destination_parent) / name)
        members = []
        for pin in pins.members:
            fd = os.open(pin.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                         os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory_fd)
            try:
                os.fchmod(fd, 0o600)
                _file(fd, mode=0o600)
                _stream_member(archive, pin, fd)
                os.fsync(fd)
                copy_identity = _file(fd, pin.size, 0o600)
            finally:
                os.close(fd)
            read_fd = os.open(pin.name, os.O_RDONLY | os.O_NOFOLLOW |
                              os.O_NONBLOCK, dir_fd=directory_fd)
            try:
                _same(read_fd, copy_identity)
                if _hash_fd(read_fd, pin.size) != pin.sha256:
                    _refuse("copy-hash")
                _same(read_fd, copy_identity)
            finally:
                os.close(read_fd)
            members.append(CopiedMember(pin.name, str(Path(directory_path) / pin.name),
                                        pin.size, pin.sha256, copy_identity))
        source.recheck()
        destination.recheck()
        _same(source.fd, outer_identity)
        directory_identity = _identity(directory_fd)
        link_stat = os.stat(name, dir_fd=destination.fd, follow_symlinks=False)
        if (link_stat.st_dev, link_stat.st_ino) != (
                directory_identity.device, directory_identity.inode) or (
                not stat.S_ISDIR(directory_identity.mode) or
                stat.S_IMODE(directory_identity.mode) != 0o700 or
                directory_identity.uid != os.geteuid()):
            _refuse("destination-directory-identity")
        for member in members:
            fd = os.open(member.name, os.O_RDONLY | os.O_NOFOLLOW |
                         os.O_NONBLOCK, dir_fd=directory_fd)
            try:
                _same(fd, member.identity)
                if _hash_fd(fd, member.size) != member.sha256:
                    _refuse("copy-hash")
                _same(fd, member.identity)
            finally:
                os.close(fd)
        if _hash_fd(source.fd, outer_identity.size) != outer_hash:
            _refuse("outer-hash-changed")
        _same(source.fd, outer_identity)
        source.recheck()
        destination.recheck()
        _same(directory_fd, directory_identity)
        final_link = os.stat(name, dir_fd=destination.fd, follow_symlinks=False)
        if (final_link.st_dev, final_link.st_ino) != (
                directory_identity.device, directory_identity.inode) or (
                not stat.S_ISDIR(final_link.st_mode)):
            _refuse("destination-directory-identity")
        if sorted(os.listdir(directory_fd)) != sorted(NAMES):
            _refuse("destination-inventory")
        return AcquisitionRecord(metadata, now.astimezone(timezone.utc).isoformat(),
                                 directory_path, directory_identity, outer_hash,
                                 outer_identity, tuple(members))
    except AcquisitionError:
        raise
    except (OSError, RuntimeError, NotImplementedError, EOFError,
            struct.error, zlib.error) as error:
        raise AcquisitionError("local-data-refused") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
