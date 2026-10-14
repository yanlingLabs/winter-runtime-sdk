"""Ordinary temporary ZIP DATA and injected pins only; no native execution."""
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import io
import os
from pathlib import Path
import stat
import struct
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

import acquisition as a


NOW = datetime(2026, 10, 14, tzinfo=timezone.utc)
DATA = {a.NAMES[0]: b"tiny archive DATA, deliberately not a tar file",
        a.NAMES[1]: b'{"synthetic":true}'}


def build(entries=None, *, method=zipfile.ZIP_DEFLATED, descriptor=False):
    class NonSeeking(io.BytesIO):
        def seekable(self):
            return False

        def seek(self, *args):
            raise io.UnsupportedOperation("no seek")

    buffer = NonSeeking() if descriptor else io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # Deliberate duplicate fixture.
        with zipfile.ZipFile(buffer, "w", compression=method) as archive:
            for name, data in (entries if entries is not None else DATA.items()):
                archive.writestr(name, data)
    return buffer.getvalue()


class Tests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        # macOS /var and /tmp are aliases. Resolve only the trusted fixture root;
        # the API never resolves attacker-controlled paths or follows aliases.
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "input.zip"
        self.destination = self.root / "destination"
        self.destination.mkdir(mode=0o700)
        self.install(build())

    def tearDown(self):
        self.temporary.cleanup()

    def install(self, raw):
        self.source.write_bytes(raw)
        self.metadata = replace(a.PRODUCTION_PINS.metadata, size_in_bytes=len(raw))
        self.pins = a.AcquisitionPins(self.metadata, tuple(
            a.MemberPin(name, len(data), hashlib.sha256(data).hexdigest())
            for name, data in DATA.items()), hashlib.sha256(raw).hexdigest())

    def acquire(self, **kwargs):
        parameters = dict(now=NOW, pins=self.pins)
        parameters.update(kwargs)
        return a.acquire_local_zip(self.source, self.destination, self.metadata, **parameters)

    def refuse(self, code=None):
        with self.assertRaises(a.AcquisitionError) as caught:
            self.acquire()
        if code:
            self.assertEqual(str(caught.exception), code)

    def test_success_independent_outer_and_inner_records_private_data_only(self):
        record = self.acquire()
        self.assertEqual(record.outer_zip_sha256, self.pins.outer_sha256)
        self.assertEqual(record.outer_zip_identity.size, self.source.stat().st_size)
        self.assertEqual(stat.S_IMODE(Path(record.directory).stat().st_mode), 0o700)
        self.assertEqual({p.name for p in Path(record.directory).iterdir()}, set(a.NAMES))
        for member in record.members:
            path = Path(member.path)
            self.assertEqual(path.read_bytes(), DATA[member.name])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(member.identity.links, 1)
            self.assertNotEqual(member.sha256, record.outer_zip_sha256)
        report = record.to_dict()
        self.assertTrue(report["packet_data_validated"])
        for flag in ("packet_code_imported", "native_execution", "source_admission",
                     "execution_admission", "vm_execution"):
            self.assertIs(report[flag], False)
        self.assertEqual(self.source.read_bytes(), build())

    def test_production_pins_are_frozen_and_separate_from_injected_data(self):
        self.assertEqual(a.PRODUCTION_PINS.metadata.repository_id, 1358618589)
        self.assertEqual(a.PRODUCTION_PINS.metadata.size_in_bytes, 81095921)
        self.assertEqual(a.PRODUCTION_PINS.members[0].size, 81359155)
        self.assertEqual(a.PRODUCTION_PINS.members[1].size, 243499)
        with self.assertRaises(a.AcquisitionError):
            a.acquire_local_zip(self.source, self.destination, self.metadata, now=NOW)
        with self.assertRaises(AttributeError):
            a.PRODUCTION_PINS.outer_sha256 = "0" * 64

    def test_every_provenance_field_and_expired_refuse_before_zip_open(self):
        mutations = dict(repository_id=2, run_id=2, head_sha="0" * 40,
                         artifact_id=2, artifact_name="foreign", size_in_bytes=22,
                         expires_at="2026-10-22T02:45:33Z", expired=True)
        for field, value in mutations.items():
            with self.subTest(field=field), patch.object(a.zipfile, "ZipFile") as parser:
                with self.assertRaises(a.AcquisitionError):
                    a.acquire_local_zip(self.source, self.destination,
                                        replace(self.metadata, **{field: value}),
                                        now=NOW, pins=self.pins)
                parser.assert_not_called()
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_expiry_boundary_strictly_refuses_and_requires_aware_time(self):
        for now in (datetime(2026, 10, 21, 2, 45, 33, tzinfo=timezone.utc),
                    datetime(2026, 10, 22, tzinfo=timezone.utc), datetime(2026, 10, 14)):
            with self.subTest(now=now), self.assertRaises(a.AcquisitionError):
                self.acquire(now=now)
        # One microsecond before expiry remains within the injected DATA gate.
        self.acquire(now=datetime(2026, 10, 21, 2, 45, 32, 999999, tzinfo=timezone.utc))

    def test_metadata_does_not_coerce_equal_floats_or_boolean_expiry(self):
        for field in ("repository_id", "run_id", "artifact_id", "size_in_bytes"):
            value = float(getattr(self.metadata, field))
            with self.subTest(field=field), self.assertRaises(a.AcquisitionError):
                a.acquire_local_zip(self.source, self.destination,
                                    replace(self.metadata, **{field: value}),
                                    now=NOW, pins=self.pins)
        with self.assertRaises(a.AcquisitionError):
            a.acquire_local_zip(self.source, self.destination,
                                replace(self.metadata, expired=0), now=NOW, pins=self.pins)

    def test_outer_hash_and_both_inner_hashes_before_destination_creation(self):
        self.refuse_with_pins(replace(self.pins, outer_sha256="0" * 64), "outer-hash-pin")
        for index in range(2):
            members = list(self.pins.members)
            members[index] = replace(members[index], sha256="0" * 64)
            self.refuse_with_pins(replace(self.pins, members=tuple(members)), "member-stream-hash")
        self.assertEqual(list(self.destination.iterdir()), [])

    def refuse_with_pins(self, pins, code):
        with self.assertRaises(a.AcquisitionError) as caught:
            self.acquire(pins=pins)
        self.assertEqual(str(caught.exception), code)

    def test_stored_and_signed_data_descriptor_formats(self):
        for method, descriptor in ((zipfile.ZIP_STORED, False),
                                   (zipfile.ZIP_DEFLATED, True)):
            with self.subTest(method=method, descriptor=descriptor):
                self.install(build(method=method, descriptor=descriptor))
                self.acquire()

    def test_extra_duplicate_directory_traversal_names_refuse(self):
        entries = list(DATA.items())
        variants = [entries + [("extra", b"x")], [entries[0], entries[0]],
                    [("../reader-packet.tar.gz", entries[0][1]), entries[1]],
                    [("nested/reader-packet.tar.gz", entries[0][1]), entries[1]],
                    [("reader-packet.tar.gz/", entries[0][1]), entries[1]]]
        for items in variants:
            with self.subTest(names=[x[0] for x in items]):
                self.install(build(items))
                self.refuse()
        self.assertEqual(list(self.destination.iterdir()), [])

    def mutate(self, target, offset, fmt, value):
        raw = bytearray(self.source.read_bytes())
        start = raw.index(target)
        struct.pack_into(fmt, raw, start + offset, value)
        self.install(raw)

    def test_eocd_count_bytes_offset_and_comment_bounded_before_parser(self):
        cases = [(8, "<H", 65535), (10, "<H", 65535),
                 (12, "<I", a.MAX_CENTRAL_BYTES + 1),
                 (16, "<I", 0xffffffff), (20, "<H", 1), (4, "<H", 1)]
        for offset, fmt, value in cases:
            with self.subTest(offset=offset):
                self.install(build())
                self.mutate(b"PK\x05\x06", offset, fmt, value)
                with patch.object(a.zipfile, "ZipFile") as parser:
                    self.refuse()
                    parser.assert_not_called()

    def test_closed_metadata_types_encryption_methods_zip64_and_local_shapes(self):
        cases = [(b"PK\x01\x02", 8, "<H", 1),  # encryption
                 (b"PK\x01\x02", 10, "<H", 12),  # unsupported method
                 (b"PK\x01\x02", 20, "<I", 0xffffffff),
                 (b"PK\x01\x02", 30, "<H", 4),  # extra
                 (b"PK\x01\x02", 32, "<H", 4),  # comment
                 (b"PK\x01\x02", 38, "<I", (stat.S_IFLNK | 0o777) << 16),
                 (b"PK\x01\x02", 38, "<I", (stat.S_IFIFO | 0o600) << 16),
                 (b"PK\x01\x02", 38, "<I", 0x10),
                 (b"PK\x01\x02", 6, "<H", 45),  # ZIP64 required version
                 (b"PK\x03\x04", 28, "<H", 4),
                 (b"PK\x03\x04", 14, "<I", 0),
                 (b"PK\x03\x04", 26, "<H", 64)]
        for signature, offset, fmt, value in cases:
            with self.subTest(signature=signature, offset=offset, value=value):
                self.install(build())
                self.mutate(signature, offset, fmt, value)
                with patch.object(a.zipfile, "ZipFile") as parser:
                    self.refuse()
                    parser.assert_not_called()

    def test_trailing_bytes_preamble_and_crc_damage_refuse(self):
        for raw in (build() + b"tail", b"prefix" + build()):
            self.install(raw)
            self.refuse()
        raw = bytearray(build(method=zipfile.ZIP_STORED))
        raw[30 + len(a.NAMES[0])] ^= 1
        self.install(raw)  # Trust only test outer pin; inner CRC/hash still refuse.
        self.refuse()
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_corrupt_deflate_has_closed_refusal_before_destination(self):
        raw = bytearray(build())
        # Raw deflate block header BTYPE=3 is reserved and cannot be decoded.
        start = 30 + len(a.NAMES[0])
        raw[start] = (raw[start] & ~6) | 6
        self.install(raw)
        self.refuse("local-data-refused")
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_symlink_file_ancestor_destination_and_dot_paths_refuse(self):
        link = self.root / "link.zip"
        link.symlink_to(self.source)
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for source, dest in ((link, self.destination), (alias / self.source.name, self.destination),
                             (self.source, alias / self.destination.name),
                             (str(self.root) + "/../" + self.root.name + "/input.zip", self.destination)):
            with self.subTest(source=source, dest=dest), self.assertRaises(a.AcquisitionError):
                a.acquire_local_zip(source, dest, self.metadata, now=NOW, pins=self.pins)
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_hardlink_fifo_directory_size_and_writable_destination_refuse(self):
        hardlink = self.root / "hardlink"
        os.link(self.source, hardlink)
        self.refuse("not-single-link-regular-file")
        hardlink.unlink()
        self.source.unlink()
        os.mkfifo(self.source)
        self.refuse("not-single-link-regular-file")  # NONBLOCK cannot hang opening FIFO.
        self.source.unlink()
        self.source.mkdir()
        self.refuse("not-single-link-regular-file")
        self.source.rmdir()
        self.install(build())
        self.source.write_bytes(self.source.read_bytes() + b"x")
        self.refuse("file-size")
        self.install(build())
        os.chmod(self.destination, 0o777)
        self.refuse("destination-parent-owner-mode")
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_source_mutation_and_path_replacement_refuse_before_copy(self):
        original = a._stream_member
        for action in ("bytes", "path"):
            self.install(build())
            changed = False

            def stream(archive, pin, output_fd=None):
                nonlocal changed
                original(archive, pin, output_fd)
                if not changed:
                    changed = True
                    if action == "bytes":
                        with self.source.open("r+b") as handle:
                            handle.seek(0)
                            handle.write(b"XX")
                    else:
                        saved = self.root / "old.zip"
                        self.source.rename(saved)
                        self.source.write_bytes(saved.read_bytes())

            with self.subTest(action=action), patch.object(a, "_stream_member", stream):
                self.refuse()
            self.assertEqual(list(self.destination.iterdir()), [])

    def test_held_source_ancestor_replacement_refuses(self):
        parent = self.root / "source-parent"
        parent.mkdir()
        self.source.rename(parent / self.source.name)
        self.source = parent / self.source.name
        original = a._stream_member
        changed = False

        def stream(archive, pin, output_fd=None):
            nonlocal changed
            original(archive, pin, output_fd)
            if not changed:
                changed = True
                parent.rename(self.root / "old-parent")
                parent.mkdir()
                self.source.write_bytes((self.root / "old-parent" / self.source.name).read_bytes())

        with patch.object(a, "_stream_member", stream):
            self.refuse("path-identity-changed")
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_copied_bytes_mode_and_read_identity_refuse(self):
        original_stream = a._stream_member
        for mutation in ("bytes", "mode", "read-identity"):
            self.install(build())
            changed = False

            def stream(archive, pin, output_fd=None):
                nonlocal changed
                original_stream(archive, pin, output_fd)
                if output_fd is not None and not changed:
                    changed = True
                    if mutation == "bytes":
                        os.write(output_fd, b"extra")
                    elif mutation == "mode":
                        os.fchmod(output_fd, 0o644)

            original_open = os.open

            def open_changed(path, flags, *args, **kwargs):
                fd = original_open(path, flags, *args, **kwargs)
                if mutation == "read-identity" and path == a.NAMES[0] and flags & os.O_ACCMODE == os.O_RDONLY:
                    os.chmod(path, 0o644, dir_fd=kwargs["dir_fd"], follow_symlinks=False)
                return fd

            with self.subTest(mutation=mutation), patch.object(a, "_stream_member", stream), \
                    patch.object(a.os, "open", open_changed):
                self.refuse()

    def test_descriptor_ownership_closed_on_success_and_intake_failure(self):
        opened = set()
        original_open, original_close = os.open, os.close

        def tracked_open(*args, **kwargs):
            fd = original_open(*args, **kwargs)
            opened.add(fd)
            return fd

        def tracked_close(fd):
            opened.discard(fd)
            return original_close(fd)

        # fdopen owns its dup and closes internally, so track only direct os.open
        # descriptors whose cleanup is the intake implementation's responsibility.
        with patch.object(a.os, "open", tracked_open), patch.object(a.os, "close", tracked_close):
            self.acquire()
            self.assertEqual(opened, set())
            bad = replace(self.pins, outer_sha256="0" * 64)
            self.refuse_with_pins(bad, "outer-hash-pin")
            self.assertEqual(opened, set())

    def test_destination_extra_leaf_and_replaced_directory_refuse(self):
        original_hash = a._hash_fd
        for mutation in ("extra-leaf", "directory-replacement"):
            self.install(build())
            previous_directories = set(self.destination.iterdir())
            outer_reads = 0

            def hash_changed(fd, size):
                nonlocal outer_reads
                digest = original_hash(fd, size)
                if size == self.metadata.size_in_bytes:
                    outer_reads += 1
                    if outer_reads == 3:
                        admitted = next(p for p in self.destination.iterdir()
                                        if p not in previous_directories)
                        if mutation == "extra-leaf":
                            (admitted / "unexpected").write_bytes(b"extra DATA")
                        else:
                            admitted.rename(self.root / "detached")
                            admitted.mkdir(mode=0o700)
                            (admitted / "replacement").write_bytes(b"replacement DATA")
                return digest

            with self.subTest(mutation=mutation), patch.object(a, "_hash_fd", hash_changed):
                self.refuse()


if __name__ == "__main__":
    unittest.main()
