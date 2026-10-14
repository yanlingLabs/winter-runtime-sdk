"""Closed crash-report-family classifier. Synthetic whole-buffer DATA only: no native
execution, no real crash output, no secrets. Every fixture is built from the fixed grammar
documented beside native_cases.classify_report_family."""
import ast
import base64
import hashlib
import json
from dataclasses import replace
import inspect
from pathlib import Path
import random
import re
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch
import bootstrap as b
import native_cases as cases
import producer as p
import wrapper as w
import fixture as f
from test_cases import InertEffects

FAMILIES = ('bun_report_shape', 'webkit_assertion_shape', 'loader_error_shape')
CLOSED = cases.REPORT_FAMILIES
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
URL = b' https://bun.report/1.3.14/La10d9b296izhgEqko4C_mo0zmBmo0zmBm0guqB29zjtBmp7goB+tqwHuurgUuz/vT+mzvT2wuvT__A2sn38opC2o30suD'
SEND = [b'', b"To send a redacted crash report to Bun's team,", b'please file a GitHub issue using the link below:', b'']
OH_NO = b'oh no: Bun has crashed. This indicates a bug in Bun, not your code.'


def join(lines): return b'\n'.join(lines) + b'\n'


def bun_lines(*, cpu=b'CPU: neon fp aes crc32 atomics', args=b'Args: "/instruction-reader"', features=b'Features: jsc ',
              builtins=None, usage=True, avx=False, arch=b'arm64', version=b'Bun v1.3.14 (0d9b296a) Linux ',
              kernel=b'Linux Kernel v6.11.0 | glibc v2.39', panic=b'panic(main thread): Segmentation fault at address 0x0',
              action=None, memory=False, url=URL):
    lines = [b'=' * 60, version + arch, kernel]
    if cpu: lines.append(cpu)
    lines.append(args)
    if features: lines.append(features)
    if builtins: lines.append(builtins)
    if usage:
        lines += [b'Elapsed: 41ms | User: 22ms | Sys: 17ms',
                  b'RSS: 52.30MB | Peak: 52.30MB | Commit: 38.10MB | Faults: 1204 | Machine: 15.61GB']
    lines.append(b'')
    if avx: lines.append(b'CPU lacks AVX support. Please consider upgrading to a newer CPU.')
    if not memory: lines.append(panic)
    if action: lines.append(action)
    lines.append(b'oh no: Bun has run out of memory.' if memory else OH_NO)
    return lines + SEND + [url, b'']


def bun(**options): return join(bun_lines(**options))


def webkit(kind='assert', frames=3, no_stack=False, message=None):
    first = {'assert': b'ASSERTION FAILED: vm.isEntered()', 'never': b'SHOULD NEVER BE REACHED',
             'message': b'ASSERTION FAILED: unexpected state 7'}[kind]
    lines = [first] + ([b'm_state == State::Ready'] if kind == 'message' else [])
    lines.append(b'/src/Source/JavaScriptCore/runtime/VM.cpp(650) : void JSC::VM::run(int)')
    for number in range(1, frames + 1):
        address = b'(nil)' if number == 2 else b'0xffff9b2c%04x' % number
        lines.append(b'%-3d ' % number + address + b' /lib/aarch64-linux-gnu/libc.so.6(+0x1234) [0xffff]')
    raw = b'\n'.join(lines) + b'\n'
    return raw + b'no stacktrace available' if no_stack else raw


LOADER = b'/instruction-reader: error while loading shared libraries: libfoo.so.1: cannot open shared object file: No such file or directory\n'
VERSION_LINE = b"/instruction-reader: /lib/aarch64-linux-gnu/libc.so.6: version `GLIBC_2.38' not found (required by /instruction-reader)\n"


def line_ends(raw):
    return [match.end() for match in re.finditer(b'\n', raw)]


def fixtures():
    """(name, bytes, family, commit length, lengths at which a prefix is itself a whole report).

    Bun and loader reports end at a fixed frame. WebKit text has no end marker (see the
    grammar comment): a cut right after the call site or after any frame line is a valid
    shorter trace, so those boundaries are listed explicitly and are the only exceptions."""
    out = []
    for name, raw in (('bun', bun()), ('bun-bare', bun(cpu=None, features=None, usage=False)),
                      ('bun-memory', bun(memory=True, action=b'Crashed while parsing /fixture.js')),
                      ('bun-x64', bun(arch=b'x64 (baseline)', cpu=b'CPU: sse42 popcnt', avx=True, kernel=b'Linux Kernel v6.8.0 | musl',
                                      builtins=b'Builtins: "bun:ffi" "node:fs" ', features=b'Features: fetch(12) jsc spawn(3) ',
                                      panic=b'panic: reached unreachable code', args=b'Args: "a" "b c"...'))):
        out.append((name, raw, 'bun_report_shape', 61, {len(raw)}))
    for name, raw, call_site_line in (('webkit-assert', webkit('assert'), 1), ('webkit-never', webkit('never'), 1), ('webkit-message', webkit('message'), 2),
                                      ('webkit-bare', webkit(frames=0), 1), ('webkit-nostack', webkit(frames=0, no_stack=True), 1)):
        out.append((name, raw, 'webkit_assertion_shape', raw.index(b'\n') + 1, set(line_ends(raw)[call_site_line:]) | {len(raw)}))
    out.append(('loader', LOADER, 'loader_error_shape', len(b'/instruction-reader: error while loading shared libraries: '), {len(LOADER)}))
    out.append(('loader-versions', VERSION_LINE * 2, 'loader_error_shape', len(b"/instruction-reader: /lib/aarch64-linux-gnu/libc.so.6: version `"),
                set(line_ends(VERSION_LINE * 2))))
    return out


class Capture:
    """The wrapper's real exporter bound to inert lease DATA (as test_fixture_stderr does)."""
    @staticmethod
    def export(raw, kind='same-owner'):
        lease = object.__new__(w.SourceLease)
        lease.path = Path('/run/fixed/sources'); lease.synthetic = False; lease.closed = False; lease.unresolved = False
        lease.snapshot = object(); lease.runtime = object(); lease.fixture = SimpleNamespace(path=lease.path.parent / 'fixture')
        modules = {'reader_fixture': f, 'producer': p, 'reader_parent': object(), 'control': object(), 'native_cases': cases}
        lease.modules = modules
        export = w._fixture_stderr_exporter(lease, SimpleNamespace(sha256=w.COMPILE_PIN_SHA256), modules, p.selected_host_exec_environment())
        return export(SimpleNamespace(handles=SimpleNamespace(fixture_stderr_capture=raw)), kind)


def failed_case(stderr, kind='same-owner'):
    fx = InertEffects(kind)
    if kind == 'same-owner': fx.observation = replace(fx.observation, stderr=stderr)
    with unittest.TestCase().assertRaises(cases.CaseUncertain) as caught:
        cases.run_case(kind, None, b'{}' if kind == 'same-owner' else b'', effects=fx)
    return fx, caught.exception


class Grammar(unittest.TestCase):
    def test_exact_whole_buffer_fixtures_are_recognised(self):
        for name, raw, family, _, _ in fixtures():
            with self.subTest(name=name):
                self.assertEqual(cases.classify_report_family(raw), family)

    def test_every_cpu_flag_subset_and_optional_line_combination(self):
        for names in (('neon', 'fp', 'aes', 'crc32', 'atomics', 'sve'), ('sse42', 'popcnt', 'avx', 'avx2', 'avx512')):
            for mask in range(1, 1 << len(names)):
                line = b'CPU: ' + b' '.join(n.encode() for bit, n in enumerate(names) if mask >> bit & 1)
                self.assertEqual(cases.classify_report_family(bun(cpu=line)), 'bun_report_shape', line)
        for mask in range(64):
            options = dict(cpu=None if mask & 1 else b'CPU: fp', features=None if mask & 2 else b'Features: jsc ',
                           builtins=b'Builtins: "bun:ffi" ' if mask & 4 else None, usage=bool(mask & 8),
                           avx=bool(mask & 16), action=b'Crashed while visiting x.ts' if mask & 32 else None)
            self.assertEqual(cases.classify_report_family(bun(**options)), 'bun_report_shape', options)
        for line in (b'CPU: fp neon', b'CPU: ', b'CPU: neon  fp', b'CPU: avx512 sse42', b'CPU: neon sse42'):
            self.assertEqual(cases.classify_report_family(bun(cpu=line)), 'unknown', line)

    def test_free_text_slots_accept_only_single_line_printable_ascii(self):
        for panic in (b'panic: integer overflow', b'panic(main thread): ', b'panic: error.OutOfMemory', b'panic: ' + b'x' * 1024):
            self.assertEqual(cases.classify_report_family(bun(panic=panic)), 'bun_report_shape')
        for panic in (b'panic: ' + b'x' * 1025, b'panic: caf\xc3\xa9', b'panic: tab\there', b'panic: a\rb', b'panic(thread 7): x', b'Panic: x',
                      b'panic(main thread):x', b'panic', b''):
            self.assertEqual(cases.classify_report_family(bun(panic=panic)), 'unknown', panic)
        for action in (b'Crashed while parsing /a b/c.js', b'Crashed while loading native module: x.node'):
            self.assertEqual(cases.classify_report_family(bun(action=action)), 'bun_report_shape')
        for action in (b'Crashed while ', b'crashed while parsing x', b'Crashed while generating bundler chunk', b'Crashed while parsing caf\xc3\xa9'):
            self.assertEqual(cases.classify_report_family(bun(action=action)), 'unknown', action)

    def test_url_and_version_lines_have_fixed_frames(self):
        base = b' https://bun.report/1.3.14/La10d9b296'
        for url in (base + b'AAAA', b' https://bun.report/1.3.14/Lt1unknownAAAA', b' https://bun.report/1.3.14/lB1' + b'0123abc' + b'+/_-'):
            self.assertEqual(cases.classify_report_family(bun(url=url)), 'bun_report_shape', url)
        for url in (b'https://bun.report/1.3.14/La10d9b296AAAA', base + b'AA AA', base + b'AA.AA', base + b'', b' http://bun.report/1.3.14/La10d9b296AA',
                    b' https://bun.report/1.3/La10d9b296AA', b' https://evil.example/1.3.14/La10d9b296AA', b' https://bun.report/1.3.14/Ma10d9b296AA',
                    b' https://bun.report/1.3.14/La30d9b296AA', b' https://bun.report/1.3.14/La10d9b29AA', b' https://bun.report/1.3.14/La10d9b296' + b'A' * 1025,
                    b'  https://bun.report/1.3.14/La10d9b296AA', URL + b' '):
            self.assertEqual(cases.classify_report_family(bun(url=url)), 'unknown', url)
        for version in (b'Bun v1.3.14 (0d9b296a) macOS ', b'Bun v1.3.14 Windows ', b'Bun Debug v1.3.14-debug Linux ', b'bun v1.3.14 Linux ', b'Bun v1.3.14 (0d9b296a)Linux '):
            self.assertEqual(cases.classify_report_family(bun(version=version)), 'unknown', version)
        self.assertEqual(cases.classify_report_family(bun(version=b'Bun Canary v1.3.15-canary.7 (0d9b296a) Linux ')), 'bun_report_shape')
        self.assertEqual(cases.classify_report_family(bun(version=b'Bun v1.3.14 Linux ')), 'bun_report_shape')

    def test_webkit_forms_and_frame_numbering(self):
        for raw in (webkit(frames=31), webkit('message', 0), webkit('never', 5), webkit(frames=0, no_stack=True)):
            self.assertEqual(cases.classify_report_family(raw), 'webkit_assertion_shape')
        bad = [webkit(frames=32), webkit().replace(b'2   (nil)', b'3   (nil)'), webkit().replace(b'1   0x', b'1 0x', 1),
               webkit().replace(b'1   0x', b'1    0x', 1), webkit().replace(b'ASSERTION FAILED', b'assertion failed'),
               webkit().replace(b' : void', b': void'), webkit().replace(b'650)', b'six)'), webkit().replace(b'(650)', b'(650'),
               webkit().replace(b'0xffff9b2c0001', b'ffff9b2c0001'), webkit().replace(b'0xffff9b2c0001', b'0XFFFF9B2C0001'),
               webkit(frames=0, no_stack=True) + b'\n', webkit(no_stack=True),
               b'NOT IMPLEMENTED YET\nf.cpp(1) : g\n', b'ASSERTION FAILED: x\ny\nz\nf.cpp(1) : g\n', b'SHOULD NEVER BE REACHED\ny\nf.cpp(1) : g\n',
               webkit().replace(b'1   0x', b'0   0x', 1)]
        for index, raw in enumerate(bad):
            self.assertIn(cases.classify_report_family(raw), ('unknown', 'incomplete'), index)
            self.assertNotIn(cases.classify_report_family(raw), FAMILIES, index)

    def test_loader_forms_and_occasions(self):
        for occasion in (b'error while loading shared libraries', b'symbol lookup error', b'version lookup error'):
            raw = b'/lib/ld-linux-aarch64.so.1: ' + occasion + b': /lib/libx.so: undefined symbol: foo\n'
            self.assertEqual(cases.classify_report_family(raw), 'loader_error_shape')
        self.assertEqual(cases.classify_report_family(b'<program name unknown>: error while loading shared libraries: x: y\n'), 'loader_error_shape')
        self.assertEqual(cases.classify_report_family(VERSION_LINE * 16), 'loader_error_shape')
        self.assertEqual(cases.classify_report_family(b'x: <main program>: version `GLIBC_2.38\' not found (required by x)\n'), 'loader_error_shape')
        for raw in (VERSION_LINE * 17, LOADER * 2, b'x: error while loading shared libraries: \n', b'x: error while loading shared libraries:\n',
                    b'my prog: error while loading shared libraries: y\n', b'a:b: error while loading shared libraries: y\n',
                    b': error while loading shared libraries: y\n', b'x: Error while loading shared libraries: y\n',
                    b'x: error while loading shared library: y\n', b'x: error while loading shared libraries: caf\xc3\xa9\n',
                    b'x: error while loading shared libraries: y\r\n', b'x: error while loading shared libraries: ' + b'y' * 2049 + b'\n',
                    b'warning\n' + LOADER, LOADER + b'warning\n', b'x: error while loading shared libraries: y\n\n', b'\n' + LOADER,
                    VERSION_LINE + LOADER, LOADER + VERSION_LINE, b"x: y: version `' not found (required by z)\n",
                    b'x: y: version `A\' not found (required by )\n', b'x: y: weak version `A\' not found (required by z)\n'):
            self.assertIn(cases.classify_report_family(raw), ('unknown', 'incomplete'), raw)
            self.assertNotIn(cases.classify_report_family(raw), FAMILIES, raw)

    def test_truncation_at_every_byte_boundary(self):
        for name, raw, family, commit, positive in fixtures():
            labels = [cases.classify_report_family(raw[:length]) for length in range(len(raw) + 1)]
            for length, label in enumerate(labels):
                want = family if length in positive else 'incomplete' if length >= commit else 'unknown'
                self.assertEqual(label, want, (name, length))
            self.assertEqual({length for length, label in enumerate(labels) if label in FAMILIES}, positive, name)
            self.assertEqual(labels[0], 'unknown'); self.assertEqual(labels[-1], family); self.assertIn('incomplete', labels)
            self.assertEqual(labels.index('incomplete'), commit if commit not in positive else commit, name)

    def test_nothing_after_or_before_a_report_and_no_second_report(self):
        reports = {name: raw for name, raw, _, _, _ in fixtures()}
        after = (b'x', b'\n', b' ', b'\x00', b'\xff', b'x\n', b'bun_report_shape\n', json.dumps({'reportFamily': 'bun_report_shape'}).encode())
        before = (b'x\n', b'\n', b' \n', b'\x00', b'\xff\n', b'bun_report_shape\n', b'[1] 123 trace trap\n', b'<', b':')
        for name, raw in reports.items():
            for extra in after:
                self.assertNotIn(cases.classify_report_family(raw + extra), FAMILIES, (name, extra))
            for extra in before:
                self.assertNotIn(cases.classify_report_family(extra + raw), FAMILIES, (name, extra))
        singles = [reports[n] for n in ('bun', 'bun-memory', 'webkit-assert', 'webkit-nostack', 'loader', 'loader-versions')]
        for first in singles:
            for second in singles:
                if not (first is reports['loader-versions'] and second is first):  # Missing-version lines are one group by design.
                    self.assertNotIn(cases.classify_report_family(first + second), FAMILIES, (first[:12], second[:12]))
                self.assertNotIn(cases.classify_report_family(first + b'\n' + second), FAMILIES, (first[:12], second[:12]))
        self.assertEqual(cases.classify_report_family(VERSION_LINE * 2 + VERSION_LINE * 2), 'loader_error_shape')
        self.assertEqual(cases.classify_report_family(webkit(frames=0) + bun()), 'unknown')
        self.assertEqual(cases.classify_report_family(bun() + b'panic: x\npanicked during a panic. Aborting.\n'), 'unknown')
        self.assertEqual(cases.classify_report_family(bun().replace(OH_NO, b'oh no: multiple threads are crashing')), 'unknown')

    def test_every_single_line_edit_to_a_report_is_refused(self):
        lines = bun_lines(builtins=b'Builtins: "bun:ffi" ', avx=True)
        # banner, version, kernel, args, the Elapsed/RSS pair, blank, panic, oh no, blank, two sentences, blank, url, final blank
        required = (0, 1, 2, 4, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18)
        self.assertEqual(len(lines), 19)
        self.assertEqual(cases.classify_report_family(join(lines)), 'bun_report_shape')
        for index in range(len(lines) + 1):
            for label in (b'bun_report_shape', b'loader_error_shape', b'webkit_assertion_shape', b'ASSERTION FAILED: x', b'x: error while loading shared libraries: y', b''):
                inserted = lines[:index] + [label] + lines[index:]
                if inserted != lines:  # An empty line beside an existing blank can only repeat it.
                    self.assertEqual(cases.classify_report_family(join(inserted)), 'unknown', (index, label))
        for index in range(len(lines)):
            self.assertEqual(cases.classify_report_family(join(lines[:index + 1] + lines[index:])), 'unknown', index)
            if index in required:  # Losing the closing blank line is a truncated report, not a different one.
                self.assertEqual(cases.classify_report_family(join(lines[:index] + lines[index + 1:])), 'incomplete' if index == 18 else 'unknown', index)
            else:  # CPU, Features, Builtins and the x64 AVX warning are optional lines.
                self.assertEqual(cases.classify_report_family(join(lines[:index] + lines[index + 1:])), 'bun_report_shape', index)
        for index in range(len(lines) - 1):
            swapped = list(lines); swapped[index], swapped[index + 1] = swapped[index + 1], swapped[index]
            if swapped != lines: self.assertEqual(cases.classify_report_family(join(swapped)), 'unknown', index)
        for count in (59, 61, 0, 120):
            self.assertEqual(cases.classify_report_family(bun().replace(b'=' * 60, b'=' * count, 1)), 'unknown', count)
        for raw in (bun().replace(b'oh no', b'Oh no'), bun().replace(b'\n', b'\r\n'), bun().replace(b'Bun has', b'Bun  has'), bun().replace(b'a bug', b'a bug '),
                    bun().replace(b'to Bun', b'to bun'), bun().replace(b"Bun's team,", b"Bun's team.")):
            self.assertEqual(cases.classify_report_family(raw), 'unknown')

    def test_ansi_coloured_report_is_not_in_the_plain_grammar(self):
        esc = b'\x1b[0m\x1b[2m'
        coloured = bun().replace(b'Bun v1', esc + b'Bun v1', 1).replace(b'panic(main thread)', b'\x1b[31mpanic\x1b[0m\x1b[2m(main thread)', 1)
        self.assertEqual(cases.classify_report_family(coloured), 'unknown')
        self.assertEqual(cases.classify_report_family(bun().replace(b'jsc', b'\x1b[31mjsc')), 'unknown')

    def test_non_printable_and_malformed_utf8_never_label_a_report(self):
        for name, raw, family, _, _ in fixtures():
            for index in range(len(raw)):
                for byte in (0x00, 0x0d, 0x1b, 0x7f, 0x80, 0xc3, 0xff):
                    mutated = raw[:index] + bytes((byte,)) + raw[index + 1:]
                    self.assertEqual(cases.classify_report_family(mutated), 'unknown', (name, index, byte))
        for junk in (b'\xff\xfe', b'\xc3\x28', b'\xf0\x28\x8c\x28', b'\xed\xa0\x80', b'\xef\xbb\xbf', b'\xc0\xaf', b'\x00', b'\x1b[31m'):
            self.assertEqual(cases.classify_report_family(junk), 'unknown')
            self.assertEqual(cases.classify_report_family(junk + bun()), 'unknown')
            self.assertEqual(cases.classify_report_family(bun(panic=b'panic: ' + junk)), 'unknown')
            self.assertEqual(cases.classify_report_family(LOADER[:-1] + junk + b'\n'), 'unknown')

    def test_empty_oversized_and_non_bytes_inputs(self):
        self.assertEqual(cases.classify_report_family(b''), 'unknown')
        for raw in (b'\n', b'\n' * 16384, b'=' * 16384, b'A' * 16384, b'ASSERTION FAILED: ' + b'x' * 16000, b' ' * 16384):
            self.assertEqual(cases.classify_report_family(raw), 'unknown')
        for raw in (None, 'text', 0, 1.5, True, [], {}, bytearray(bun()), memoryview(bun()), type('B', (bytes,), {})(bun()), b'x' * 16385, bun() * 25):
            self.assertEqual(cases.classify_report_family(raw), 'classification_error')

    def test_enum_only_output_and_no_decode_hash_or_extraction(self):
        rng = random.Random(20261014)
        samples = [raw for _, raw, _, _, _ in fixtures()]
        corpus = list(samples)
        for _ in range(4000):
            raw = bytearray(rng.choice(samples))
            for _ in range(rng.choice((1, 1, 2, 3))):
                index = rng.randrange(len(raw) + 1)
                action = rng.choice(('flip', 'insert', 'delete', 'cut', 'dup'))
                byte = rng.choice((0, 10, 13, 27, 32, 58, 61, 126, 127, 128, 255, rng.randrange(256)))
                if action == 'flip' and raw: raw[min(index, len(raw) - 1)] = byte
                elif action == 'insert': raw.insert(index, byte)
                elif action == 'delete' and raw: del raw[min(index, len(raw) - 1)]
                elif action == 'cut': del raw[index:]
                else: raw[index:index] = raw[:index]
            corpus.append(bytes(raw[:16384]))
        corpus += [rng.randbytes(rng.randrange(0, 900)) for _ in range(1500)]
        started = time.monotonic()
        for raw in corpus:
            label = cases.classify_report_family(raw)
            self.assertIn(label, CLOSED); self.assertIsNot(type(label), bytes)
            self.assertNotEqual(label, 'classification_error')
        self.assertLess(time.monotonic() - started, 30)
        source = ''.join(inspect.getsource(function) for function in (cases.classify_report_family, cases.report_family_for_case, cases._walk))
        for forbidden in ('decode', 'hashlib', 'sha256', 'base64', 'json', 'print', 'str(', 'hex(', 'repr('):
            self.assertNotIn(forbidden, source)
        returned = [node for node in ast.walk(ast.parse(inspect.getsource(cases.classify_report_family))) if isinstance(node, ast.Return)]
        for node in returned:
            self.assertIn(type(node.value), (ast.Constant, ast.IfExp, ast.Name), ast.dump(node))

    def test_adversarial_inputs_are_bounded_in_time(self):
        head = b'=' * 60 + b'\nBun v1.3.14 (0d9b296a) Linux arm64\nLinux Kernel v1.2.3 | glibc v2.39\n'
        cases_ = [head + b'Args: "' + b'a "b' * 3000, head + b'Args: "x"\nFeatures: ' + b'tok(12) ' * 1500, head + b'Args: "x"\nBuiltins: ' + b'"bun:x" ' * 1800,
                  head + b'CPU: ' + b'neon fp ' * 2000, b'ASSERTION FAILED: x\n' + b'a(1) : b' * 1500, b'a' * 16000 + b': error while loading shared libraries: q\n',
                  b'ASSERTION FAILED: x\nf.cpp(1) : g\n' + b''.join(b'%-3d 0x1 n\n' % i for i in range(1, 700)), b'(' * 16384, b'= ' * 8192,
                  b'ASSERTION FAILED: ' + b'(' * 4000 + b'\n' + b'x' * 4000 + b'\n' + b'(' * 4000]
        started = time.monotonic()
        for raw in cases_: cases.classify_report_family(raw[:16384])
        self.assertLess(time.monotonic() - started, 10)


class Exceptions(unittest.TestCase):
    def test_any_exception_is_the_closed_error_value(self):
        for target in ('_walk', '_better'):
            with patch.object(cases, target, side_effect=RuntimeError('private /secret')):
                self.assertEqual(cases.classify_report_family(bun()), 'classification_error')
        with patch.object(cases, '_GRAMMAR', None): self.assertEqual(cases.classify_report_family(bun()), 'classification_error')
        with patch.object(cases, '_GRAMMAR', (('x', ((), re.compile(b'')),),)): self.assertEqual(cases.classify_report_family(bun()), 'classification_error')
        with patch.object(cases, '_walk', side_effect=RecursionError()): self.assertEqual(cases.classify_report_family(b''), 'classification_error')

    def test_classifier_failure_does_not_touch_diagnostics_cause_or_cleanup_and_the_converse(self):
        raw = bun()
        with patch.object(cases, 'classify_report_family', side_effect=ValueError('private classifier text')):
            fx, error = failed_case(raw)
        self.assertEqual(fx.h.postinit_report_family, 'classification_error')
        self.assertTrue(fx.h.postinit_diagnostics['available']); self.assertIs(fx.h.fixture_stderr_capture, raw)
        self.assertEqual(str(error.cause), 'same-owner native control outcome'); self.assertTrue(fx.h.retained)
        self.assertEqual(fx.events[-1], 'actual-reaps'); self.assertNotIn('close-after-proof', fx.events)
        with patch.object(cases, 'report_family_for_case', side_effect=RuntimeError('private')):
            fx, error = failed_case(raw)
        self.assertEqual(fx.h.postinit_report_family, 'classification_error'); self.assertTrue(fx.h.postinit_diagnostics['available'])
        with patch.object(cases, 'postinit_diagnostics', side_effect=ValueError('private')):
            fx, error = failed_case(raw)
        self.assertEqual(fx.h.postinit_diagnostics, {'available': False}); self.assertEqual(fx.h.postinit_report_family, 'bun_report_shape')
        self.assertIs(fx.h.fixture_stderr_capture, raw); self.assertTrue(fx.h.retained)
        with patch.object(cases, 'classify_report_family', side_effect=ValueError('x')), patch.object(cases, 'postinit_diagnostics', side_effect=ValueError('y')):
            fx, error = failed_case(raw)
        self.assertEqual(str(error.cause), 'same-owner native control outcome'); self.assertTrue(fx.h.retained)


class Gating(unittest.TestCase):
    def test_family_is_computed_only_for_the_same_owner_failure_with_complete_capture(self):
        raw = bun()
        fx, error = failed_case(raw)
        self.assertEqual(fx.h.postinit_report_family, 'bun_report_shape')
        self.assertIs(fx.h.fixture_stderr_capture, raw); self.assertIs(error.handles, fx.h)
        self.assertEqual(fx.h.postinit_diagnostics['stderrSha256'], hashlib.sha256(raw).hexdigest())
        for kind in ('parent-exit', 'unexpected-parent'):
            fx = InertEffects(kind)
            def fail(*_): raise cases.Refusal('original injected failure')
            fx.receive_handles = fail
            with self.assertRaises(cases.CaseUncertain): cases.run_case(kind, None, effects=fx)
            self.assertEqual(fx.h.postinit_report_family, 'not_same_owner_failure'); self.assertIsNone(fx.h.postinit_diagnostics)
        fx = InertEffects('parent-exit'); fx.reaps = replace(fx.reaps, launcher_status=0)
        with self.assertRaises(cases.CaseUncertain): cases.run_case('parent-exit', None, effects=fx)
        self.assertEqual(fx.h.postinit_report_family, 'not_same_owner_failure')
        fx = InertEffects('same-owner')
        def fail_before_observation(*_): raise cases.Refusal('original injected failure')
        fx.receive_handles = fail_before_observation
        with self.assertRaises(cases.CaseUncertain): cases.run_case('same-owner', None, b'{}', effects=fx)
        self.assertEqual(fx.h.postinit_report_family, 'capture_absent'); self.assertIsNone(fx.h.postinit_diagnostics); self.assertIsNone(fx.h.fixture_stderr_capture)
        fx = InertEffects('same-owner')
        def fail_in_reap(*_): raise cases.Refusal('original injected failure')
        fx.reap = fail_in_reap
        with self.assertRaises(cases.CaseUncertain): cases.run_case('same-owner', None, b'{}', effects=fx)
        self.assertEqual(fx.h.postinit_report_family, 'capture_absent')
        fx = InertEffects('same-owner')
        cases.run_case('same-owner', None, b'{}', effects=fx)
        self.assertIsNone(fx.h.postinit_report_family)  # A passing case reports no failure family.

    def test_captures_outside_the_existing_bound_or_type_have_no_family(self):
        for stderr in ('text', b'x' * 16385, None, bytearray(b'x')):
            fx = InertEffects('same-owner'); fx.observation = replace(fx.observation, stderr=stderr)
            with self.assertRaises(cases.CaseUncertain): cases.run_case('same-owner', None, b'{}', effects=fx)
            self.assertIsNone(fx.h.fixture_stderr_capture); self.assertEqual(fx.h.postinit_report_family, 'capture_absent')
        fx, _ = failed_case(b'x' * 16384)
        self.assertEqual(fx.h.postinit_report_family, 'unknown')
        fx, _ = failed_case(b'\xff\xfe malformed')
        self.assertEqual(fx.h.postinit_report_family, 'unknown'); self.assertTrue(fx.h.postinit_diagnostics['available'])
        fx = InertEffects('same-owner'); fx.observation = replace(fx.observation, native_wait_status=77 << 8)
        with self.assertRaises(cases.CaseUncertain): cases.run_case('same-owner', None, b'{}', effects=fx)
        self.assertEqual(fx.h.fixture_stderr_capture, b'')
        self.assertEqual(fx.h.postinit_report_family, 'unknown')  # Empty stderr is a complete capture with no report.


class Projection(unittest.TestCase):
    def record(self, family, *, diagnostics=None, sample=None):
        chain_error = w.Uncertain(SimpleNamespace(stage='case:same-owner:run', **({'fixture_stderr_sample': sample} if sample else {})),
                                  SimpleNamespace(handles=SimpleNamespace(postinit_report_family=family, postinit_diagnostics=diagnostics), cause=None))
        return b.failure_record(chain_error)

    def test_constants_match_the_classifier_and_markers_mirror_sample_reasons(self):
        self.assertEqual(b.REPORT_FAMILIES, cases.REPORT_FAMILIES)
        self.assertEqual(b.REPORT_FAMILIES, ('bun_report_shape', 'webkit_assertion_shape', 'loader_error_shape', 'unknown', 'incomplete', 'classification_error'))
        self.assertEqual(b.REPORT_FAMILY_ABSENT, ('not_same_owner_failure', 'capture_absent'))
        self.assertTrue(set(b.REPORT_FAMILY_ABSENT) <= set(b.SAMPLE_REASONS))
        self.assertFalse(set(b.REPORT_FAMILY_ABSENT) & set(b.REPORT_FAMILIES))

    def test_failure_record_validates_strictly_and_never_echoes_foreign_values(self):
        for value in b.REPORT_FAMILIES + b.REPORT_FAMILY_ABSENT:
            self.assertEqual(self.record(value)['postInitReportFamily'], value)
        for value in ('/private/path', 'Bun_report_shape', 'bun_report_shape ', '', 'missing_urandom', 'missing_maps', b'bun_report_shape', 1, True, 0.5, [], {}, ('unknown',),
                      {'reportFamily': 'unknown'}, 'bun_report_shape\n', 'unknown\x00', 'Kunknown', 'ＵＮＫＮＯＷＮ'):
            record = self.record(value)
            self.assertEqual(record['postInitReportFamily'], 'classification_error', value)
            if isinstance(value, str) and value: self.assertNotIn(json.dumps(value), json.dumps(record))
        self.assertEqual(b.failure_record(w.Refusal('x'))['postInitReportFamily'], 'not_same_owner_failure')
        self.assertEqual(self.record(None)['postInitReportFamily'], 'not_same_owner_failure')
        chain = [SimpleNamespace(handles=SimpleNamespace(postinit_report_family=None)), SimpleNamespace(handles=SimpleNamespace(postinit_report_family='unknown')),
                 SimpleNamespace(handles=SimpleNamespace(postinit_report_family='incomplete'))]
        self.assertEqual(b.report_family_record(chain), 'unknown')
        self.assertEqual(b.report_family_record([]), 'not_same_owner_failure')
        with patch.object(b, 'report_family_record', side_effect=ValueError('private')):
            self.assertEqual(self.record('unknown')['postInitReportFamily'], 'classification_error')

    def test_recognised_family_needs_a_nonempty_complete_capture(self):
        raw = bun(); fx, error = failed_case(raw)
        lease = SimpleNamespace(stage='case:same-owner:run')
        record = b.failure_record(w.Uncertain(lease, error))
        self.assertEqual(record['postInitReportFamily'], 'bun_report_shape'); self.assertTrue(record['postInitDiagnostics']['available'])
        fx.h.postinit_diagnostics = cases.postinit_diagnostics(replace(fx.observation, stderr=b''), fx.reaps)
        for family in ('bun_report_shape', 'webkit_assertion_shape', 'loader_error_shape', 'incomplete'):
            fx.h.postinit_report_family = family
            self.assertEqual(b.failure_record(w.Uncertain(lease, error))['postInitReportFamily'], 'classification_error', family)
        for family in ('unknown', 'classification_error', 'capture_absent'):
            fx.h.postinit_report_family = family
            self.assertEqual(b.failure_record(w.Uncertain(lease, error))['postInitReportFamily'], family)

    def test_original_fields_flags_and_keys_are_unchanged_and_family_is_additive(self):
        fx, error = failed_case(bun())
        lease = SimpleNamespace(stage='case:same-owner:run')
        record = b.failure_record(w.Uncertain(lease, error))
        old = dict(record); del old['postInitReportFamily']
        fx.h.postinit_report_family = 'unknown'
        other = b.failure_record(w.Uncertain(lease, error))
        self.assertEqual({k: v for k, v in other.items() if k != 'postInitReportFamily'}, old)
        self.assertEqual(set(record), {'readerCaseSetPassed', 'stage', 'reason', 'exceptionClass', 'errnoSymbol', 'causeClass', 'causeReason', 'causeErrnoSymbol',
                                       'preInitDiagnostics', 'postInitDiagnostics', 'postInitStderrSample', 'postInitReportFamily', 'nativeCleanupConfirmed',
                                       'configEffectProven', 'vmExecutionVerified', 'productionActivation'})
        self.assertEqual(set(record['postInitDiagnostics']), set(b.POSTINIT_KEYS))
        for flag in ('readerCaseSetPassed', 'nativeCleanupConfirmed', 'configEffectProven', 'vmExecutionVerified', 'productionActivation'): self.assertIs(record[flag], False)
        self.assertEqual(record['stage'], 'case:same-owner:run'); self.assertEqual(record['causeReason'], 'same-owner native control outcome')
        # The family never needs, replaces or changes the post-init record: it can fail alone.
        fx.h.postinit_report_family = {'x': 1}
        self.assertEqual({k: v for k, v in b.failure_record(w.Uncertain(lease, error)).items() if k != 'postInitReportFamily'}, old)

    def test_log_projection_keeps_only_closed_family_values_and_never_sample_bytes(self):
        for value in b.REPORT_FAMILIES + b.REPORT_FAMILY_ABSENT:
            self.assertEqual(b.log_result_projection({'postInitReportFamily': value})['postInitReportFamily'], value)
        for value in ('/private/path', 'Bun has crashed', b'x', None, 7, ['unknown'], {'a': 'b'}, 'unknown '):
            self.assertEqual(b.log_result_projection({'postInitReportFamily': value})['postInitReportFamily'], 'classification_error')
        self.assertNotIn('postInitReportFamily', b.log_result_projection({'kind': 'winter-reader-only-case-set'}))
        sample = Capture.export(b'fixture!')
        record = self.record('webkit_assertion_shape', sample=sample)
        record['postInitStderrSample'] = sample
        projected = b.log_result_projection(record)
        self.assertEqual(projected['postInitReportFamily'], 'webkit_assertion_shape'); self.assertNotIn('bytesBase64', json.dumps(projected))
        self.assertEqual(set(projected['postInitStderrSample']), {'available', 'truncated', 'sampleSha256'})


class Scrub(unittest.TestCase):
    def test_the_motivating_standard_report_is_labelled_while_the_sample_stays_rejected(self):
        raw = bun()
        self.assertRegex(raw, rb'[A-Za-z0-9+/=_-]{40,}')  # The 60-equals banner alone trips the unchanged long-run scrub.
        self.assertEqual(Capture.export(raw), {'available': False, 'reason': 'scrub_rejected'})
        self.assertEqual(cases.classify_report_family(raw), 'bun_report_shape')
        fx, error = failed_case(raw)
        lease = SimpleNamespace(stage='case:same-owner:run', fixture_stderr_sample=Capture.export(raw))
        record = b.failure_record(w.Uncertain(lease, error))
        self.assertEqual(record['postInitReportFamily'], 'bun_report_shape')
        self.assertEqual(record['postInitStderrSample'], {'available': False, 'reason': 'scrub_rejected'})
        text = json.dumps(record) + json.dumps(b.log_result_projection(record))
        for fragment in (b'Segmentation fault', b'bun.report', b'instruction-reader', b'=' * 60, b'Bun v1.3.14', b'jsc'):
            self.assertNotIn(fragment.decode(), text); self.assertNotIn(fragment.hex(), text)
        self.assertNotIn(base64.b64encode(raw[:60]).decode(), text)
        self.assertNotIn('bytesBase64', text)
        self.assertIn(hashlib.sha256(raw).hexdigest(), json.dumps(record['postInitDiagnostics']))  # The pre-existing full-capture hash is unchanged.

    def test_a_recognised_report_with_any_forbidden_secret_reports_the_family_but_exports_no_bytes(self):
        secrets = (b'ghp_' + b'a' * 36, b'gho_x', b'ghu_x', b'ghs_x', b'ghr_x', b'github_pat_x', b'Authorization: x', b'Bearer abc', b'AKIAIOSFODNN7EXAMPLE', b'-----BEGIN KEY',
                   b'A' * 40, b'a+/=_-' * 7)
        alphabet = re.compile(rb'[A-Za-z0-9+/_-]*')
        placements = {
            'bun-args': (lambda s: bun(args=b'Args: "' + s + b'"'), None), 'bun-panic': (lambda s: bun(panic=b'panic: ' + s), None),
            'bun-action': (lambda s: bun(action=b'Crashed while parsing ' + s), None), 'bun-url': (lambda s: bun(url=URL + b'AAAA' + s), alphabet),
            'webkit-expr': (lambda s: webkit().replace(b'vm.isEntered()', s), None), 'webkit-file': (lambda s: webkit().replace(b'/src/Source', b'/' + s), None),
            'webkit-function': (lambda s: webkit().replace(b'void JSC::VM::run(int)', s), None), 'webkit-frame': (lambda s: webkit().replace(b'libc.so.6', s), None),
            'loader': (lambda s: LOADER[:-1] + b' ' + s + b'\n', None)}
        for name, (build, allowed) in placements.items():
            for secret in secrets:
                if allowed is not None and not allowed.fullmatch(secret): continue
                raw = build(secret)
                family = cases.classify_report_family(raw)
                self.assertEqual(family, {'b': 'bun_report_shape', 'w': 'webkit_assertion_shape', 'l': 'loader_error_shape'}[name[0]], (name, secret))
                self.assertEqual(Capture.export(raw), {'available': False, 'reason': 'scrub_rejected'}, (name, secret))
                fx, error = failed_case(raw)
                lease = SimpleNamespace(stage='case:same-owner:run', fixture_stderr_sample=Capture.export(raw))
                text = json.dumps(b.failure_record(w.Uncertain(lease, error)))
                self.assertIn(family, text); self.assertNotIn(secret.decode(), text)
        clean = webkit()
        self.assertTrue(Capture.export(clean)['available'])  # The scrub itself is unchanged: clean text still exports its prefix.
        self.assertEqual(Capture.export(clean)['truncated'], len(clean) > 4096)

    def test_wrapper_scrub_and_exporter_do_not_consult_the_classifier(self):
        source = (HERE / 'wrapper.py').read_text()
        for name in ('classify_report_family', 'report_family', 'postinit_report_family', 'REPORT_FAMILIES'):
            self.assertNotIn(name, source)
        self.assertIn("rb'gh[pousr]_|github_pat_|Authorization|Bearer |AKIA|-----BEGIN|[A-Za-z0-9+/=_-]{40,}'", source)
        for raw in (bun(), webkit(), LOADER, b'', b'x' * 16384):  # The exporter's outputs are unchanged by a classifier outcome.
            before = Capture.export(raw)
            with patch.object(cases, 'classify_report_family', side_effect=RuntimeError('private')):
                self.assertEqual(Capture.export(raw), before)


class Pins(unittest.TestCase):
    """Every source-hash pin must name the bytes actually present."""
    def digest(self, name): return hashlib.sha256((HERE / name).read_bytes()).hexdigest()

    def test_wrapper_pins_name_the_actual_harness_modules(self):
        for name, pin in w.SOURCE_PINS.items(): self.assertEqual(self.digest(name), pin, name)

    def test_workflow_and_gate_pins_name_the_actual_bootstrap_and_wrapper(self):
        workflow = (ROOT / '.github/workflows/cowork-reader-native-reviewed.yml').read_text()
        gate = (ROOT / 'test/gates/release-gates.test.ts').read_text()
        bootstrap, wrapper = self.digest('bootstrap.py'), self.digest('wrapper.py')
        self.assertEqual(workflow.count(bootstrap), 4); self.assertEqual(workflow.count(wrapper), 1)
        self.assertEqual(gate.count('"' + bootstrap + '"'), 1); self.assertEqual(gate.count('"' + wrapper + '"'), 1)
        self.assertEqual(set(re.findall(r"hexdigest\(\)!='([0-9a-f]{64})'", workflow)) - {'65f78b2219a17d0fe7bddc44d58558ab94e8817c371fcc87c2dc25229366ee99'}, {bootstrap})
        self.assertEqual(set(re.findall(r"data,'([0-9a-f]{64})'", workflow)), {wrapper})


if __name__ == '__main__': unittest.main()
