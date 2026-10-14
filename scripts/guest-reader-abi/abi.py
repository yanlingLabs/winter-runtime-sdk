"""Bounded ARM64 ELF version preflight. Input bytes are data, never executed.

This checks declared dynamic dependencies and strong versioned symbol imports.
It is not a loader, a complete ABI proof, or authority to stage/launch a packet.
Callers must independently bind input bytes to their image/packet inventories.
"""
from __future__ import annotations

import hashlib
import struct

MAX_ELF = 128 * 1024 * 1024
MAX_SYMBOLS = 65536
MAX_VERSIONS = 4096


class ABIRefusal(ValueError):
    pass


def need(condition, message):
    if not condition:
        raise ABIRefusal(message)


def inspect_elf(data: bytes) -> dict:
    need(type(data) is bytes and 64 <= len(data) <= MAX_ELF, "ELF byte bound")
    need(data[:7] == b"\x7fELF\x02\x01\x01", "ELF64 little endian")
    kind, machine, version = struct.unpack_from("<HHI", data, 16)
    need(kind in (2, 3) and machine == 183 and version == 1, "ARM64 ELF type")
    phoff, shoff = struct.unpack_from("<QQ", data, 32)
    ehsize, phsize, phnum, shsize, shnum, shstr = struct.unpack_from("<HHHHHH", data, 52)
    need(ehsize == 64 and phsize == 56 and 0 < phnum <= 256, "program headers")
    need(shsize == 64 and 0 < shnum <= 4096 and shstr < shnum, "section headers")

    def span(at, size):
        need(0 <= at <= len(data) and 0 <= size <= len(data) - at, "ELF range")
        return data[at:at + size]

    span(phoff, phnum * phsize)
    span(shoff, shnum * shsize)
    loads, dynamic, interpreter = [], None, None
    for i in range(phnum):
        ptype, flags, at, va, _, size, memory, align = struct.unpack_from("<IIQQQQQQ", data, phoff + i * 56)
        span(at, size)
        if ptype == 1:
            need(size <= memory, "load file/memory bound")
            loads.append((va, at, size))
        elif ptype == 2:
            need(dynamic is None and size <= 65536 and size % 16 == 0, "dynamic table")
            dynamic = (at, size, va)
        elif ptype == 3:
            need(interpreter is None and 1 < size <= 4096, "interpreter")
            raw = span(at, size)
            need(raw[-1:] == b"\0" and b"\0" not in raw[:-1], "interpreter terminator")
            try:
                interpreter = raw[:-1].decode("ascii")
            except UnicodeDecodeError as exc:
                raise ABIRefusal("interpreter encoding") from exc

    def mapped(va, size):
        matches = [(at + va - base) for base, at, length in loads
                   if base <= va and size <= length and va - base <= length - size]
        need(len(matches) == 1, "unique load mapping")
        return matches[0]

    sections = []
    for i in range(shnum):
        name, typ, flags, va, at, size, link, info, align, entsize = struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * 64)
        if typ != 8:  # NOBITS has no file bytes.
            span(at, size)
        sections.append(dict(name=name, type=typ, va=va, at=at, size=size, link=link, info=info, entsize=entsize))
    names = sections[shstr]
    need(names["type"] == 3 and names["size"] <= 1024 * 1024, "section names")

    def text(table, at):
        need(0 <= at < len(table), "string offset")
        end = table.find(b"\0", at)
        need(end >= at and end - at <= 4096, "string bound")
        try:
            value = table[at:end].decode("ascii")
        except UnicodeDecodeError as exc:
            raise ABIRefusal("string encoding") from exc
        need(all(32 <= ord(c) <= 126 for c in value), "string control character")
        return value

    section_names = span(names["at"], names["size"])
    by_name = {}
    for i, section in enumerate(sections):
        name = text(section_names, section["name"])
        if name:
            need(name not in by_name, "duplicate section name")
            by_name[name] = (i, section)
    need(dynamic is not None, "dynamic ELF required")
    tags, needed_offsets = {}, []
    terminated = False
    at, size, va = dynamic
    need(mapped(va, size) == at, "dynamic mapping")
    relevant = {5, 6, 10, 11, 14, 15, 29, 0x6FFFFFF0, 0x6FFFFFFC, 0x6FFFFFFD, 0x6FFFFFFE, 0x6FFFFFFF}
    for pos in range(at, at + size, 16):
        tag, value = struct.unpack_from("<qQ", data, pos)
        if tag == 0:
            terminated = True
            break
        if tag == 1:
            needed_offsets.append(value)
        elif tag in relevant:
            need(tag not in tags, "duplicate dynamic key")
            tags[tag] = value
    need(terminated and len(needed_offsets) <= 32, "dynamic bounds")
    need(15 not in tags and 29 not in tags, "RPATH/RUNPATH refused")
    need({5, 6, 10, 11} <= tags.keys() and tags[11] == 24, "dynamic symbols")
    need(0 < tags[10] <= 4 * 1024 * 1024, "dynamic string bound")
    strings_at = mapped(tags[5], tags[10])
    strings = span(strings_at, tags[10])
    need(".dynstr" in by_name and ".dynsym" in by_name, "symbol sections required")
    str_index, str_section = by_name[".dynstr"]
    sym_index, sym_section = by_name[".dynsym"]
    need(str_section["type"] == 3 and str_section["at"] == strings_at and str_section["size"] == len(strings), "dynamic strings corroboration")
    need(sym_section["type"] == 11 and sym_section["link"] == str_index and sym_section["entsize"] == 24,
         "dynamic symbol section")
    need(sym_section["size"] % 24 == 0 and 0 < sym_section["size"] // 24 <= MAX_SYMBOLS, "symbol count")
    need(sym_section["at"] == mapped(tags[6], sym_section["size"]), "dynamic symbols mapping")

    def dependency(at):
        value = text(strings, at)
        need(value and all(c not in value for c in ("/", "\\")) and ".." not in value and " " not in value, "dependency name")
        return value

    needed = [dependency(at) for at in needed_offsets]
    need(len(needed) == len(set(needed)), "duplicate dependency")
    soname = dependency(tags[14]) if 14 in tags else None

    def version_section(name, typ, address_tag, count_tag):
        present = name in by_name
        need(present == (address_tag in tags) == (count_tag in tags), "version table presence")
        if not present:
            return None, 0
        _, s = by_name[name]
        count = tags[count_tag]
        need(s["type"] == typ and s["link"] == str_index and 0 < count <= MAX_VERSIONS and s["info"] == count, "version table metadata")
        need(s["at"] == mapped(tags[address_tag], s["size"]), "version table mapping")
        return span(s["at"], s["size"]), count

    needs, need_count = version_section(".gnu.version_r", 0x6FFFFFFE, 0x6FFFFFFE, 0x6FFFFFFF)
    defs, def_count = version_section(".gnu.version_d", 0x6FFFFFFD, 0x6FFFFFFC, 0x6FFFFFFD)
    required, defined = {}, {}
    auxiliary_count = 0

    version_ranges = {id(needs): [], id(defs): []}

    def unpack(blob, fmt, at):
        size = struct.calcsize(fmt)
        need(0 <= at <= len(blob) and size <= len(blob) - at, "version record range")
        ranges = version_ranges[id(blob)]
        need(all(at + size <= start or at >= end for start, end in ranges), "overlapping version records")
        ranges.append((at, at + size))
        return struct.unpack_from(fmt, blob, at)

    if needs is not None:
        pos = 0
        for i in range(need_count):
            ver, count, file, aux, nxt = unpack(needs, "<HHIII", pos)
            need(ver == 1 and 0 < count <= MAX_VERSIONS and aux >= 16, "version requirement record")
            library = dependency(file)
            need(library in needed, "version dependency not NEEDED")
            auxiliary_count += count
            need(auxiliary_count <= MAX_VERSIONS, "version auxiliary count")
            part = pos + aux
            for j in range(count):
                _, flags, index, name, following = unpack(needs, "<IHHII", part)
                need(flags & ~2 == 0 and 2 <= index < 0x8000 and index not in required, "version requirement index")
                label = text(strings, name)
                need(label, "empty version label")
                required[index] = (library, label)
                need((following == 0) == (j == count - 1), "version auxiliary termination")
                if following:
                    need(following >= 16, "version auxiliary advance")
                    part += following
            need((nxt == 0) == (i == need_count - 1), "version record termination")
            if nxt:
                need(nxt >= 16, "version record advance")
                pos += nxt
    if defs is not None:
        pos = 0
        for i in range(def_count):
            ver, flags, index, count, _, aux, nxt = unpack(defs, "<HHHHIII", pos)
            need(ver == 1 and flags & ~3 == 0 and 0 < index < 0x8000 and index not in defined,
                 "version definition record")
            need(0 < count <= MAX_VERSIONS and aux >= 20, "version definition auxiliary")
            auxiliary_count += count
            need(auxiliary_count <= MAX_VERSIONS, "version auxiliary count")
            part, labels = pos + aux, []
            for j in range(count):
                name, following = unpack(defs, "<II", part)
                label = text(strings, name)
                need(label, "empty version definition")
                labels.append(label)
                need((following == 0) == (j == count - 1), "definition auxiliary termination")
                if following:
                    need(following >= 8, "definition auxiliary advance")
                    part += following
            defined[index] = labels[0]
            need((nxt == 0) == (i == def_count - 1), "definition record termination")
            if nxt:
                need(nxt >= 20, "definition record advance")
                pos += nxt

    symbols = sym_section["size"] // 24
    version_indices = [1] * symbols
    need((".gnu.version" in by_name) == (0x6FFFFFF0 in tags), "symbol versions presence")
    if ".gnu.version" in by_name:
        _, s = by_name[".gnu.version"]
        need(s["type"] == 0x6FFFFFFF and s["link"] == sym_index and s["size"] == symbols * 2,
             "symbol versions section")
        need(s["at"] == mapped(tags[0x6FFFFFF0], s["size"]), "symbol versions mapping")
        version_indices = struct.unpack_from("<" + "H" * symbols, data, s["at"])
    else:
        need(not required and not defined, "versioned tables without symbol indices")

    imports, exports = [], []
    for i in range(symbols):
        name, info, other, section, value, size = struct.unpack_from("<IBBHQQ", data, sym_section["at"] + i * 24)
        binding, visibility = info >> 4, other & 3
        label_index = version_indices[i] & 0x7FFF
        if not name or binding not in (1, 2) or visibility not in (0, 3):
            continue
        symbol = text(strings, name)
        need(symbol, "empty symbol")
        if section == 0:
            if label_index > 1:
                need(label_index in required, "unknown required symbol version")
                library, label = required[label_index]
                imports.append({"symbol": symbol, "library": library, "version": label, "weak": binding == 2})
        elif label_index > 1:
            need(label_index in defined, "unknown defined symbol version")
            exports.append({"symbol": symbol, "version": defined[label_index]})
    return {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "interpreter": interpreter,
            "soname": soname, "needed": needed,
            "requiredVersions": sorted({pair for pair in required.values()}),
            "definedVersions": sorted(set(defined.values())),
            "versionedImports": imports, "versionedExports": exports}


def preflight(roles: dict[str, bytes], libraries: dict[str, bytes], *, interpreter: str) -> dict:
    """Compare measured roles with an explicit image-library map, without fallback."""
    need(type(roles) is dict and 0 < len(roles) <= 4 and type(libraries) is dict and 0 < len(libraries) <= 32,
         "preflight inventory bound")
    need(all(type(name) is str and name and len(name) <= 128 and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in name) for name in roles), "role name")
    need(all(type(data) is bytes for data in [*roles.values(), *libraries.values()]), "input bytes")
    need(sum(map(len, [*roles.values(), *libraries.values()])) <= 512 * 1024 * 1024, "preflight aggregate")
    need(type(interpreter) is str and interpreter.startswith("/") and interpreter in libraries, "explicit interpreter")
    role_info = {name: inspect_elf(data) for name, data in roles.items()}
    lib_info = {name: inspect_elf(data) for name, data in libraries.items()}
    providers = {}
    for path, info in lib_info.items():
        need(type(path) is str and path.startswith("/") and all(p not in ("", ".", "..") for p in path[1:].split("/")), "library path")
        if info["soname"]:
            previous = providers.get(info["soname"])
            need(previous is None or previous["sha256"] == info["sha256"], "ambiguous SONAME")
            providers[info["soname"]] = info
    provider_exports = {name: {(row["symbol"], row["version"]) for row in info["versionedExports"]}
                        for name, info in providers.items()}
    checked_imports = 0
    symbol_candidates = {}
    for info in [*role_info.values(), *lib_info.values()]:
        need(info["interpreter"] in (None, interpreter), "interpreter mismatch")
        need(all(name in providers for name in info["needed"]), "missing NEEDED library")
        reachable, queue = set(), list(info["needed"])
        while queue:
            library = queue.pop()
            need(library in providers, "missing NEEDED library")
            if library in reachable:
                continue
            reachable.add(library)
            queue.extend(providers[library]["needed"])
        for library, label in info["requiredVersions"]:
            need(label in providers[library]["definedVersions"], "missing version definition")
        matches = []
        for row in info["versionedImports"]:
            if row["weak"]:
                continue
            # ELF lookup may find a symbol in a different loaded dependency than
            # VERNEED's file. For example, glibc >=2.34 merged libdl/libpthread
            # implementations into libc, retaining the old version namespaces.
            pair = (row["symbol"], row["version"])
            candidates = sorted(name for name in reachable if pair in provider_exports[name])
            need(candidates, "missing versioned symbol")
            matches.append({**row, "candidateProviders": candidates})
            checked_imports += 1
        symbol_candidates[info["sha256"]] = matches
    return {"kind": "winter-reader-elf-version-preflight-v1", "roles": role_info, "libraries": lib_info,
            "versionedSymbolCandidates": symbol_candidates,
            "strongVersionedImportsChecked": checked_imports, "declaredVersionsMatched": True,
            "completeABIProven": False, "guestCompatibilityProven": False, "executionAuthorized": False}
