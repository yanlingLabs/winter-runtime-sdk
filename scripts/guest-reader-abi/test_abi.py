"""Synthetic ELF data tests; no compiled output, loader or native launch."""
import struct
import unittest

from abi import ABIRefusal, inspect_elf, preflight


def elf(*, soname=None, interpreter=None, needs=(), definitions=(), rpath=None, headers_first=False):
    strings = bytearray(b"\0")

    def string(value):
        at = len(strings)
        strings.extend(value.encode("ascii") + b"\0")
        return at

    needed = []
    requirements = bytearray()
    defs = bytearray()
    symbols = bytearray(24)
    indices = [0]
    for i, (library, label, names) in enumerate(needs):
        needed.append(string(library))
        requirements.extend(struct.pack("<HHIII", 1, 1, needed[-1], 16, 32 if i < len(needs) - 1 else 0))
        requirements.extend(struct.pack("<IHHII", 0, 0, 2 + i, string(label), 0))
        for name, weak in names:
            symbols.extend(struct.pack("<IBBHQQ", string(name), 0x20 if weak else 0x10, 0, 0, 0, 0))
            indices.append(2 + i)
    if headers_first and needs:
        old = bytes(requirements)
        headers, auxiliaries = bytearray(), bytearray()
        for i in range(len(needs)):
            ver, count, file, aux, nxt = struct.unpack_from("<HHIII", old, i * 32)
            headers.extend(struct.pack("<HHIII", ver, count, file, len(needs) * 16, 16 if i < len(needs) - 1 else 0))
            auxiliaries.extend(old[i * 32 + 16:i * 32 + 32])
        requirements = headers + auxiliaries
    for i, (label, names) in enumerate(definitions):
        defs.extend(struct.pack("<HHHHIII", 1, 0, 2 + i, 1, 0, 20, 28 if i < len(definitions) - 1 else 0))
        defs.extend(struct.pack("<II", string(label), 0))
        for name in names:
            symbols.extend(struct.pack("<IBBHQQ", string(name), 0x10, 0, 1, 0, 0))
            indices.append(2 + i)
    soname_at = string(soname) if soname else None
    rpath_at = string(rpath) if rpath is not None else None
    names = bytearray(b"\0")
    records = [(0, 0, 0, 0, 0, 0, 0, 0, 0, 0)]
    data = bytearray(64 + 3 * 56)
    placements = {}

    def section(name, typ, body, link=0, info=0, entsize=0):
        name_at = len(names)
        names.extend(name.encode() + b"\0")
        at = len(data)
        data.extend(body)
        records.append((name_at, typ, 2, at, at, len(body), link, info, 1, entsize))
        placements[name] = at
        return len(records) - 1

    str_index = section(".dynstr", 3, strings)
    sym_index = section(".dynsym", 11, symbols, str_index, entsize=24)
    section(".gnu.version", 0x6FFFFFFF, struct.pack("<" + "H" * len(indices), *indices), sym_index, entsize=2)
    if requirements:
        section(".gnu.version_r", 0x6FFFFFFE, requirements, str_index, len(needs))
    if defs:
        section(".gnu.version_d", 0x6FFFFFFD, defs, str_index, len(definitions))
    tags = [(5, placements[".dynstr"]), (10, len(strings)), (6, placements[".dynsym"]), (11, 24),
            (0x6FFFFFF0, placements[".gnu.version"])]
    tags += [(1, at) for at in needed]
    if soname_at is not None:
        tags.append((14, soname_at))
    if rpath_at is not None:
        tags.append((29, rpath_at))
    if requirements:
        tags += [(0x6FFFFFFE, placements[".gnu.version_r"]), (0x6FFFFFFF, len(needs))]
    if defs:
        tags += [(0x6FFFFFFC, placements[".gnu.version_d"]), (0x6FFFFFFD, len(definitions))]
    tags.append((0, 0))
    dynamic = b"".join(struct.pack("<qQ", *row) for row in tags)
    section(".dynamic", 6, dynamic, str_index, entsize=16)
    interp_at = len(data)
    if interpreter:
        data.extend(interpreter.encode() + b"\0")
    name_at = len(names)
    names.extend(b".shstrtab\0")
    at = len(data)
    data.extend(names)
    records.append((name_at, 3, 0, 0, at, len(names), 0, 0, 1, 0))
    shoff = len(data)
    data.extend(b"".join(struct.pack("<IIQQQQIIQQ", *row) for row in records))
    phnum = 3 if interpreter else 2
    struct.pack_into("<16sHHIQQQIHHHHHH", data, 0, b"\x7fELF\x02\x01\x01" + bytes(9), 3, 183, 1,
                     0, 64, shoff, 0, 64, 56, phnum, 64, len(records), len(records) - 1)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 4, 0, 0, 0, len(data), len(data), 1)
    at = placements[".dynamic"]
    struct.pack_into("<IIQQQQQQ", data, 120, 2, 4, at, at, 0, len(dynamic), len(dynamic), 8)
    if interpreter:
        size = len(interpreter) + 1
        struct.pack_into("<IIQQQQQQ", data, 176, 3, 4, interp_at, interp_at, 0, size, size, 1)
    return bytes(data), placements


class VersionPreflightTests(unittest.TestCase):
    def setUp(self):
        self.loader = "/lib/ld-linux-aarch64.so.1"
        self.runtime = elf(interpreter=self.loader, needs=(("libc.so.6", "GLIBC_2.34", (("start", False),)),))[0]
        self.libc = elf(soname="libc.so.6", definitions=(("GLIBC_2.34", ("start",)),))[0]
        self.ld = elf(soname="ld-linux-aarch64.so.1")[0]
        self.libraries = {self.loader: self.ld, "/lib/libc.so.6": self.libc}

    def run_preflight(self, libraries=None):
        return preflight({"instructionReader": self.runtime}, self.libraries if libraries is None else libraries,
                         interpreter=self.loader)

    def test_exact_version_and_symbol_match_remains_data_only(self):
        result = self.run_preflight()
        self.assertEqual(result["strongVersionedImportsChecked"], 1)
        self.assertTrue(result["declaredVersionsMatched"])
        for key in ("completeABIProven", "guestCompatibilityProven", "executionAuthorized"):
            self.assertIs(result[key], False)

    def test_older_library_refuses(self):
        libraries = dict(self.libraries)
        libraries["/lib/libc.so.6"] = elf(soname="libc.so.6", definitions=(("GLIBC_2.17", ("start",)),))[0]
        with self.assertRaisesRegex(ABIRefusal, "missing version definition"):
            self.run_preflight(libraries)

    def test_version_label_alone_does_not_prove_symbol(self):
        libraries = dict(self.libraries)
        libraries["/lib/libc.so.6"] = elf(soname="libc.so.6", definitions=(("GLIBC_2.34", ("other",)),))[0]
        with self.assertRaisesRegex(ABIRefusal, "missing versioned symbol"):
            self.run_preflight(libraries)

    def test_missing_needed_and_interpreter_refuse(self):
        with self.assertRaisesRegex(ABIRefusal, "missing NEEDED"):
            self.run_preflight({self.loader: self.ld})
        with self.assertRaisesRegex(ABIRefusal, "explicit interpreter"):
            self.run_preflight({"/lib/libc.so.6": self.libc})

    def test_identical_soname_alias_allowed_conflicting_bytes_refuse(self):
        libraries = dict(self.libraries)
        libraries["/usr/lib/libc.so.6"] = self.libc
        self.run_preflight(libraries)
        libraries["/usr/lib/libc.so.6"] = elf(soname="libc.so.6")[0]
        with self.assertRaisesRegex(ABIRefusal, "ambiguous SONAME"):
            self.run_preflight(libraries)

    def test_transitive_dependency_checked(self):
        libraries = dict(self.libraries)
        libraries["/lib/libc.so.6"] = elf(soname="libc.so.6", needs=(("absent.so", "V1", (("x", False),)),),
                                              definitions=(("GLIBC_2.34", ("start",)),))[0]
        with self.assertRaisesRegex(ABIRefusal, "missing NEEDED"):
            self.run_preflight(libraries)

    def test_weak_versioned_symbol_can_be_absent_but_version_cannot(self):
        self.runtime = elf(interpreter=self.loader, needs=(("libc.so.6", "GLIBC_2.34", (("missing", True),)),))[0]
        self.assertEqual(self.run_preflight()["strongVersionedImportsChecked"], 0)

    def test_merged_implementation_in_needed_closure_is_recorded(self):
        self.runtime = elf(interpreter=self.loader, needs=(("libdl.so.2", "GLIBC_2.17", (("dlopen", False),)),))[0]
        libc = elf(soname="libc.so.6", definitions=(("GLIBC_2.17", ("dlopen",)),))[0]
        stub = elf(soname="libdl.so.2", needs=(("libc.so.6", "GLIBC_2.17", (("dlopen", True),)),), definitions=(("GLIBC_2.17", ()),))[0]
        result = self.run_preflight({self.loader: self.ld, "/lib/libc.so.6": libc, "/lib/libdl.so.2": stub})
        rows = result["versionedSymbolCandidates"][result["roles"]["instructionReader"]["sha256"]]
        self.assertEqual(rows[0]["candidateProviders"], ["libc.so.6"])

    def test_unreachable_library_does_not_satisfy_symbol(self):
        libraries = dict(self.libraries)
        libraries["/lib/libc.so.6"] = elf(soname="libc.so.6", definitions=(("GLIBC_2.34", ("other",)),))[0]
        libraries["/lib/unrelated.so"] = elf(soname="unrelated.so", definitions=(("GLIBC_2.34", ("start",)),))[0]
        with self.assertRaisesRegex(ABIRefusal, "missing versioned symbol"):
            self.run_preflight(libraries)

    def test_search_paths_refused(self):
        with self.assertRaisesRegex(ABIRefusal, "RPATH/RUNPATH"):
            inspect_elf(elf(rpath="/ambient/lib")[0])

    def test_malformed_version_chain_refuses(self):
        blob, offsets = elf(needs=(("libc.so.6", "V1", (("x", False),)),))
        blob = bytearray(blob)
        struct.pack_into("<I", blob, offsets[".gnu.version_r"] + 12, 16)
        with self.assertRaisesRegex(ABIRefusal, "record termination"):
            inspect_elf(bytes(blob))

    def test_headers_can_precede_all_auxiliaries(self):
        blob = elf(needs=(("a.so", "V1", (("a", False),)), ("b.so", "V2", (("b", False),))), headers_first=True)[0]
        self.assertEqual(inspect_elf(blob)["requiredVersions"], [("a.so", "V1"), ("b.so", "V2")])

    def test_overlapping_version_headers_and_auxiliaries_refuse(self):
        blob, offsets = elf(needs=(("a.so", "V1", (("a", False),)), ("b.so", "V2", (("b", False),))), headers_first=True)
        blob = bytearray(blob)
        struct.pack_into("<I", blob, offsets[".gnu.version_r"] + 16 + 8, 16)
        with self.assertRaisesRegex(ABIRefusal, "overlapping version"):
            inspect_elf(bytes(blob))

    def test_version_dependency_must_be_needed(self):
        blob, offsets = elf(needs=(("libc.so.6", "V1", (("x", False),)),))
        blob = bytearray(blob)
        # Change DT_NEEDED into an unrelated ignored tag, leaving VERNEED intact.
        at = offsets[".dynamic"] + 5 * 16
        self.assertEqual(struct.unpack_from("<q", blob, at)[0], 1)
        struct.pack_into("<q", blob, at, 42)
        with self.assertRaisesRegex(ABIRefusal, "not NEEDED"):
            inspect_elf(bytes(blob))

    def test_unknown_symbol_version_refuses(self):
        blob, offsets = elf(needs=(("libc.so.6", "V1", (("x", False),)),))
        blob = bytearray(blob)
        struct.pack_into("<H", blob, offsets[".gnu.version"] + 2, 23)
        with self.assertRaisesRegex(ABIRefusal, "unknown required"):
            inspect_elf(bytes(blob))

    def test_wrong_architecture_and_truncation_refuse(self):
        blob = bytearray(self.runtime)
        struct.pack_into("<H", blob, 18, 62)
        with self.assertRaisesRegex(ABIRefusal, "ARM64"):
            inspect_elf(bytes(blob))
        with self.assertRaises(ABIRefusal):
            inspect_elf(self.runtime[:-1])


if __name__ == "__main__":
    unittest.main()
