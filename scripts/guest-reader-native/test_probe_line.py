"""Reader dependency probe line, grammar reader-v2: DATA only. The parser, its closed scalars and
the bootstrap projection of the probe record. No native execution, no real probe output."""
import hashlib
import json
from dataclasses import replace
from pathlib import Path
import random
import time
import unittest

import bootstrap as b
import native_cases as cases
import producer as p
import wrapper as w
from types import SimpleNamespace

HEALTHY = (b'probe=reader-v2 stack_rc=0 stack_bounds=1 stack_contains=1 urandom_open=0 urandom_read=1 '
           b'getrandom=0 proc_list=0 proc_numeric=1 proc_root=1 canary_open=2\n')
KEYS = (b'stack_rc', b'stack_bounds', b'stack_contains', b'urandom_open', b'urandom_read',
        b'getrandom', b'proc_list', b'proc_numeric', b'proc_root', b'canary_open')
BITS = (b'stack_bounds', b'stack_contains', b'urandom_read', b'proc_root')
UNKNOWN = {'line': 'unknown', 'fields': None, 'outsideCanary': {'process': 'unknown', 'file': 'unknown'}}
MAX_VALID = (b'probe=reader-v2 stack_rc=4294967295 stack_bounds=0 stack_contains=0 urandom_open=4294967295 '
             b'urandom_read=0 getrandom=4294967295 proc_list=4294967295 proc_numeric=0 proc_root=1 '
             b'canary_open=4294967295\n')


def line(**values):
    """HEALTHY with the named fields replaced; values are ints or raw bytes."""
    base = {key.decode(): value for key, value in zip(KEYS, (b'0', b'1', b'1', b'0', b'1', b'0', b'0', b'1', b'1', b'2'))}
    for name, value in values.items():
        base[name] = value if type(value) is bytes else str(value).encode()
    return b'probe=reader-v2 ' + b' '.join(key + b'=' + base[key.decode()] for key in KEYS) + b'\n'


def reference(raw):
    """An independent token-based oracle for the grammar and its cross-field rules."""
    if type(raw) is not bytes or len(raw) > 256 or not raw.endswith(b'\n'): return False
    body = raw[:-1]
    if any(byte < 0x20 or byte > 0x7e for byte in body): return False
    parts = body.decode('ascii').split(' ')
    if len(parts) != 11 or parts[0] != 'probe=reader-v2': return False
    values = {}
    for part, key in zip(parts[1:], KEYS):
        name = key.decode()
        if not part.startswith(name + '='): return False
        text = part[len(name) + 1:]
        if not text or not text.isdigit() or (len(text) > 1 and text[0] == '0') or len(text) > 10: return False
        number = int(text)
        if number > 4294967295 or (key in BITS and number > 1): return False
        values[name] = number
    if values['stack_rc'] != 0 and (values['stack_bounds'] or values['stack_contains']): return False
    if values['stack_contains'] and not values['stack_bounds']: return False
    if values['urandom_open'] != 0 and values['urandom_read']: return False
    if values['proc_list'] != 0 and values['proc_numeric'] != 0: return False
    return values['proc_numeric'] <= 65535


class Golden(unittest.TestCase):
    def test_the_preregistered_healthy_line(self):
        result = cases.parse_probe_line(HEALTHY, init_bound=True)
        self.assertEqual(result, {
            'line': 'valid',
            'fields': {'stackRc': 'OK', 'stackBounds': True, 'stackContains': True, 'urandomOpen': 'OK',
                       'urandomRead': True, 'getrandom': 'OK', 'procList': 'OK', 'procNumeric': 1,
                       'procRoot': True, 'canaryOpen': 'ENOENT'},
            'outsideCanary': {'process': 'not_visible', 'file': 'not_visible'}})
        self.assertEqual(HEALTHY, line())

    def test_the_init_binding_is_a_separate_keyword_and_defaults_to_not_held(self):
        result = cases.parse_probe_line(HEALTHY)
        self.assertEqual(result['line'], 'valid')
        self.assertEqual(result['outsideCanary'], {'process': 'unknown', 'file': 'not_visible'})
        for bound in (False, 1, 'yes', None, object()):
            self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=bound)['outsideCanary']['process'], 'unknown', bound)
        self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=True)['outsideCanary']['process'], 'not_visible')
        with self.assertRaises(TypeError): cases.parse_probe_line(HEALTHY, True)

    def test_an_unhealthy_line_is_still_a_valid_line(self):
        raw = line(stack_rc=22, stack_bounds=0, stack_contains=0, urandom_open=2, urandom_read=0, getrandom=38,
                   proc_list=13, proc_numeric=0, proc_root=0, canary_open=13)
        self.assertEqual(cases.parse_probe_line(raw, init_bound=True), {
            'line': 'valid',
            'fields': {'stackRc': 'EINVAL', 'stackBounds': False, 'stackContains': False, 'urandomOpen': 'ENOENT',
                       'urandomRead': False, 'getrandom': 'ENOSYS', 'procList': 'EACCES', 'procNumeric': 0,
                       'procRoot': False, 'canaryOpen': 'EACCES'},
            'outsideCanary': {'process': 'unknown', 'file': 'unknown'}})

    def test_the_longest_valid_line_fits_with_room_under_the_cap(self):
        self.assertEqual(len(MAX_VALID), 199)
        result = cases.parse_probe_line(MAX_VALID, init_bound=True)
        self.assertEqual(result['line'], 'valid')
        self.assertEqual({name: result['fields'][name] for name in cases.PROBE_ERRNO_FIELDS},
                         {name: 'unknown' for name in cases.PROBE_ERRNO_FIELDS})  # 4294967295 is in no table.
        self.assertEqual(result['fields']['procNumeric'], 0)
        # Even the longest line the bare grammar admits (cross-field rules ignored) is below the cap.
        loose = line(stack_rc=4294967295, urandom_open=4294967295, getrandom=4294967295, proc_list=4294967295,
                     proc_numeric=4294967295, canary_open=4294967295)
        self.assertLess(len(loose), cases.PROBE_MAX_LINE)
        self.assertEqual(cases.parse_probe_line(loose), UNKNOWN)  # Cross-field and proc_numeric bound.

    def test_canary_file_outcomes(self):
        for code, want in ((2, 'not_visible'), (0, 'visible'), (13, 'unknown'), (6, 'unknown'), (20, 'unknown'), (40, 'unknown'),
                           (999, 'unknown'), (4294967295, 'unknown'), (1, 'unknown')):
            with self.subTest(code=code):
                result = cases.parse_probe_line(line(canary_open=code), init_bound=True)
                self.assertEqual(result['outsideCanary']['file'], want)
                self.assertEqual(result['fields']['canaryOpen'], cases.probe_errno_symbol(code))
        self.assertEqual(cases.parse_probe_line(line(canary_open=6))['fields']['canaryOpen'], 'ENXIO')

    def test_process_outcomes_need_the_exact_listing_and_the_binding(self):
        def process(bound=True, **values): return cases.parse_probe_line(line(**values), init_bound=bound)['outsideCanary']['process']
        self.assertEqual(process(), 'not_visible')
        self.assertEqual(process(False), 'unknown')
        self.assertEqual(process(proc_numeric=2), 'visible')
        self.assertEqual(process(False, proc_numeric=2), 'visible')   # Another pid listed is a signal regardless.
        self.assertEqual(process(proc_numeric=65535), 'visible')
        self.assertEqual(process(proc_numeric=0), 'unknown')
        self.assertEqual(process(proc_root=0), 'unknown')
        self.assertEqual(process(proc_list=13, proc_numeric=0), 'unknown')
        self.assertEqual(process(proc_list=0, proc_numeric=1, proc_root=0), 'unknown')
        self.assertEqual(process(proc_numeric=65536), 'unknown')       # Not a line at all.

    def test_every_field_boundary_value(self):
        for key in KEYS:
            name = key.decode()
            for text in (b'0', b'1', b'9', b'10', b'65535', b'65536', b'4294967295', b'4294967296', b'2'):
                raw = line(**{name: text})
                with self.subTest(field=name, value=text):
                    self.assertEqual(cases.parse_probe_line(raw)['line'] == 'valid', reference(raw), raw)


class Mutations(unittest.TestCase):
    def refuse(self, raw):
        self.assertEqual(cases.parse_probe_line(raw, init_bound=True), UNKNOWN, raw)
        self.assertFalse(reference(raw), raw)

    def test_reordered_fields(self):
        parts = HEALTHY[:-1].split(b' ')
        for first in range(1, 10):
            for second in range(first + 1, 11):
                swapped = list(parts); swapped[first], swapped[second] = swapped[second], swapped[first]
                self.refuse(b' '.join(swapped) + b'\n')
        self.refuse(b' '.join([parts[0], *reversed(parts[1:])]) + b'\n')

    def test_missing_extra_duplicate_and_renamed_fields(self):
        parts = HEALTHY[:-1].split(b' ')
        for index in range(1, 11):
            self.refuse(b' '.join(parts[:index] + parts[index + 1:]) + b'\n')
            self.refuse(b' '.join(parts[:index] + [parts[index]] + parts[index:]) + b'\n')  # Duplicated.
            self.refuse(b' '.join(parts[:index] + [b'x' + parts[index]] + parts[index + 1:]) + b'\n')
            self.refuse(b' '.join(parts[:index] + [parts[index].upper()] + parts[index + 1:]) + b'\n')
            self.refuse(b' '.join(parts[:index] + [parts[index].split(b'=')[0]] + parts[index + 1:]) + b'\n')  # No value.
            self.refuse(b' '.join(parts[:index] + [parts[index].split(b'=')[0] + b'='] + parts[index + 1:]) + b'\n')
        self.refuse(HEALTHY[:-1] + b' extra=1\n')
        self.refuse(HEALTHY[:-1] + b' canary_open=2\n')
        self.refuse(HEALTHY[:-1] + b' \n')
        self.refuse(b'probe=reader-v1' + HEALTHY[len(b'probe=reader-v2'):])
        self.refuse(b'probe=reader-v22' + HEALTHY[len(b'probe=reader-v2'):])
        self.refuse(b'Probe=reader-v2' + HEALTHY[len(b'probe=reader-v2'):])
        self.refuse(HEALTHY[len(b'probe=reader-v2 '):])
        self.refuse(b'probe=reader-v2\n')

    def test_leading_zeros_signs_and_non_decimal_numbers(self):
        for name in (key.decode() for key in KEYS):
            for bad in (b'00', b'01', b'002', b'+1', b'-1', b'-0', b'+0', b'1.0', b'0x1', b'1e1', b' 1', b'1 ', b'1_0', b'', b'a', b'\xd9\xa1'):
                self.refuse(line(**{name: bad}))

    def test_line_endings_and_framing(self):
        body = HEALTHY[:-1]
        for bad in (body, body + b'\r\n', body + b'\n\n', body + b'\r', body + b'\n\r', b'\n' + body + b'\n',
                    body + b'\nprobe=reader-v2', HEALTHY + HEALTHY, HEALTHY + b'x', b' ' + HEALTHY, b'\t' + HEALTHY,
                    body.replace(b' stack_bounds', b'\nstack_bounds') + b'\n', HEALTHY.replace(b' ', b'  ', 1),
                    HEALTHY.replace(b' ', b'\t', 1), HEALTHY.replace(b' ', b'\xa0', 1), b'\n', b'\r\n', b' '):
            self.refuse(bad)

    def test_nul_and_non_ascii_bytes_at_every_position(self):
        for index in range(len(HEALTHY) - 1):
            for byte in (b'\x00', b'\x80', b'\xff', b'\x7f', b'\x1b'):
                self.refuse(HEALTHY[:index] + byte + HEALTHY[index:])
                self.refuse(HEALTHY[:index] + byte + HEALTHY[index + 1:])
        self.refuse(HEALTHY[:-1] + b'\x00\n')
        self.refuse(HEALTHY + b'\x00')
        self.refuse('probe=reader-v2 ｓtack_rc=0'.encode())
        self.refuse(HEALTHY.replace(b'canary_open=2', 'canary_open=２'.encode()))   # Full-width digit.
        self.refuse(HEALTHY.replace(b'canary_open=2', 'canary_open=٢'.encode()))     # Arabic-Indic digit.

    def test_the_length_cap_is_applied_before_parsing(self):
        for pad in (b'x' * 60, b' ' * 60, b'0' * 60, b'\n' * 60):
            self.refuse(HEALTHY[:-1] + pad + b'\n')
        for size in (257, 300, 4096, 16384, 1 << 20):
            self.refuse(b'probe=reader-v2 ' + b'0' * size)
        self.assertEqual(len(HEALTHY), 154)
        self.assertEqual(cases.parse_probe_line(HEALTHY)['line'], 'valid')
        from unittest.mock import patch
        calls = []
        class Count:
            def fullmatch(self, raw): calls.append(len(raw)); return None
        with patch.object(cases, '_PROBE_LINE', Count()):   # The cap is a gate BEFORE the pattern runs.
            for size in (257, 1000, 1 << 20): cases.parse_probe_line(b'x' * size)
            self.assertEqual(calls, [])
            for size in (1, 100, 256): cases.parse_probe_line(b'x' * size)
            self.assertEqual(calls, [1, 100, 256])
        start = time.monotonic()
        for payload in (b'probe=reader-v2 ' + b'stack_rc=1 ' * 20000, b'0' * 200000, b' ' * 200000, b'probe=reader-v2 stack_rc=' + b'9' * 200000):
            self.refuse(payload)
        self.assertLess(time.monotonic() - start, 1.0)

    def test_overflow_and_bool_values(self):
        for name in ('stack_rc', 'urandom_open', 'getrandom', 'proc_list', 'proc_numeric', 'canary_open'):
            for bad in (4294967296, 4294967297, 9999999999, 10000000000, 99999999999, 18446744073709551616):
                self.refuse(line(**{name: bad, **({'proc_list': 0} if name == 'proc_numeric' else {})}))
        for name in (key.decode() for key in BITS):
            for bad in (2, 3, 10, 11, 9):
                self.refuse(line(**{name: bad}))
        self.refuse(line(proc_numeric=65536))
        self.refuse(line(proc_numeric=100000))
        self.assertEqual(cases.parse_probe_line(line(proc_numeric=65535))['line'], 'valid')
        self.assertEqual(cases.parse_probe_line(line(stack_rc=4294967295, stack_bounds=0, stack_contains=0))['line'], 'valid')

    def test_each_cross_field_violation_and_its_allowed_neighbours(self):
        for violation in (line(stack_rc=1, stack_bounds=1, stack_contains=0), line(stack_rc=22, stack_bounds=0, stack_contains=1),
                          line(stack_rc=4294967295, stack_bounds=1, stack_contains=1),
                          line(stack_bounds=0, stack_contains=1),
                          line(urandom_open=2, urandom_read=1), line(urandom_open=4294967295, urandom_read=1),
                          line(proc_list=13, proc_numeric=1), line(proc_list=1, proc_numeric=65535),
                          line(proc_list=4294967295, proc_numeric=2)):
            self.refuse(violation)
        for allowed in (line(stack_rc=22, stack_bounds=0, stack_contains=0), line(stack_bounds=1, stack_contains=0),
                        line(stack_bounds=0, stack_contains=0), line(urandom_open=2, urandom_read=0),
                        line(urandom_open=0, urandom_read=0), line(proc_list=13, proc_numeric=0), line(proc_list=0, proc_numeric=0),
                        line(stack_rc=0, stack_bounds=0, stack_contains=0)):
            self.assertEqual(cases.parse_probe_line(allowed)['line'], 'valid', allowed)
            self.assertTrue(reference(allowed), allowed)

    def test_every_single_edit_agrees_with_the_independent_oracle(self):
        rng = random.Random(0x7265616465722d76)
        pool = b'0123456789 \n\r\x00\xff=_+-abcxyz.,:probe'
        sources = [HEALTHY, MAX_VALID, line(proc_list=13, proc_numeric=0, canary_open=13),
                   line(urandom_open=2, urandom_read=0, stack_rc=3, stack_bounds=0, stack_contains=0)]
        checked = valid = 0
        for _ in range(40000):
            raw = bytearray(rng.choice(sources))
            for _ in range(rng.choice((1, 1, 1, 2, 3))):
                action = rng.randrange(6)
                at = rng.randrange(len(raw) + 1)
                if action == 0 and raw: del raw[min(at, len(raw) - 1)]
                elif action == 1: raw.insert(at, rng.choice(pool))
                elif action == 2 and raw: raw[min(at, len(raw) - 1)] = rng.choice(pool)
                elif action == 3 and len(raw) > 1:
                    other = rng.randrange(len(raw)); raw[min(at, len(raw) - 1)], raw[other] = raw[other], raw[min(at, len(raw) - 1)]
                elif action == 4: del raw[at:]
                else: raw.extend(rng.choice(sources)[:rng.randrange(40)])
            raw = bytes(raw)
            result = cases.parse_probe_line(raw, init_bound=True)
            checked += 1
            if raw == b'':
                self.assertEqual(result['line'], 'absent'); continue
            self.assertEqual(result['line'] == 'valid', reference(raw), raw)
            self.assertIn(result['line'], ('valid', 'unknown'))
            valid += result['line'] == 'valid'
        self.assertEqual(checked, 40000)
        self.assertGreater(valid, 200)   # The corpus really does hit valid lines, not only refusals.


class Absent(unittest.TestCase):
    def test_empty_is_absent(self):
        self.assertEqual(cases.parse_probe_line(b''), {'line': 'absent', 'fields': None,
                                                       'outsideCanary': {'process': 'unknown', 'file': 'unknown'}})
        self.assertEqual(cases.parse_probe_line(b'', init_bound=True)['line'], 'absent')

    def test_anything_that_is_not_bytes_is_unknown_and_never_raises(self):
        for bad in ('', HEALTHY.decode(), None, 0, 1.5, [], {}, bytearray(HEALTHY), memoryview(HEALTHY), (HEALTHY,),
                    object(), Ellipsis, True, False, float('nan')):
            self.assertEqual(cases.parse_probe_line(bad), UNKNOWN, repr(bad))

    def test_bytes_subclasses_and_hostile_buffers_never_raise(self):
        class Evil(bytes):
            def __len__(self): raise RuntimeError('hostile length')
        self.assertEqual(cases.parse_probe_line(Evil(HEALTHY)), UNKNOWN)   # type(raw) is not bytes.
        self.assertEqual(cases.parse_probe_line(b'\n'), UNKNOWN)           # Non-empty, not the grammar.
        self.assertEqual(cases.parse_probe_line(b'\x00'), UNKNOWN)

    def test_an_exception_inside_the_parser_maps_to_unknown(self):
        from unittest.mock import patch
        class Boom:
            def fullmatch(self, raw): raise RuntimeError('simulated regex failure')
        with patch.object(cases, '_PROBE_LINE', Boom()):
            self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=True), UNKNOWN)
        with patch.object(cases, 'probe_errno_symbol', side_effect=ValueError('simulated mapping failure')):
            self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=True), UNKNOWN)
        with patch.object(cases, 'probe_outside_canary', side_effect=KeyError('simulated derive failure')):
            self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=True), UNKNOWN)

    def test_a_base_exception_is_not_swallowed(self):
        from unittest.mock import patch
        class Stop:
            def fullmatch(self, raw): raise KeyboardInterrupt
        with patch.object(cases, '_PROBE_LINE', Stop()):
            with self.assertRaises(KeyboardInterrupt): cases.parse_probe_line(HEALTHY)


class Symbols(unittest.TestCase):
    def test_the_linux_numbers_are_fixed_and_host_independent(self):
        want = {1: 'EPERM', 2: 'ENOENT', 3: 'ESRCH', 4: 'EINTR', 5: 'EIO', 6: 'ENXIO', 9: 'EBADF', 11: 'EAGAIN', 13: 'EACCES',
                20: 'ENOTDIR', 22: 'EINVAL', 38: 'ENOSYS', 40: 'ELOOP', 75: 'EOVERFLOW', 95: 'ENOTSUP', 104: 'ECONNRESET', 110: 'ETIMEDOUT'}
        for number, symbol in want.items(): self.assertEqual(cases.probe_errno_symbol(number), symbol)
        self.assertEqual(cases.probe_errno_symbol(0), 'OK')
        for number in (-1, 7000, 15, 25, 27, 29, 31, 33, 35, 4294967295, 4294967296):
            self.assertEqual(cases.probe_errno_symbol(number), 'unknown')
        self.assertEqual(len(set(cases.PROBE_LINUX_ERRNO_SYMBOLS.values())), len(cases.PROBE_LINUX_ERRNO_SYMBOLS))

    def test_the_symbol_set_equals_the_bootstrap_set_apart_from_the_alias(self):
        import bootstrap as b
        table = set(cases.PROBE_LINUX_ERRNO_SYMBOLS.values())
        self.assertLessEqual(table, set(b.ERRNO_SYMBOLS))
        self.assertEqual(set(b.ERRNO_SYMBOLS) - table, {'EOPNOTSUPP'})   # Same number 95 as ENOTSUP.
        self.assertIn('ENXIO', b.ERRNO_SYMBOLS)
        self.assertNotIn(cases.PROBE_ERRNO_OK, b.ERRNO_SYMBOLS)
        self.assertNotIn(cases.PROBE_ERRNO_UNKNOWN, b.ERRNO_SYMBOLS)
        self.assertEqual(cases.PROBE_LINUX_ERRNO_SYMBOLS[95], 'ENOTSUP')

    def test_linux_numbers_agree_with_the_hosted_errno_module_on_linux_only(self):
        import errno, sys
        if sys.platform != 'linux': self.skipTest('the host errno module is the Linux numbering only on Linux')
        for number, symbol in cases.PROBE_LINUX_ERRNO_SYMBOLS.items():
            self.assertEqual(getattr(errno, symbol), number, symbol)

    def test_every_number_up_to_200_maps_to_a_closed_symbol(self):
        closed = set(cases.PROBE_LINUX_ERRNO_SYMBOLS.values()) | {'OK', 'unknown'}
        for number in range(0, 201): self.assertIn(cases.probe_errno_symbol(number), closed)


class Closed(unittest.TestCase):
    def scalars(self, value):
        if isinstance(value, dict):
            for key, item in value.items():
                self.assertIs(type(key), str)
                yield from self.scalars(item)
        else: yield value

    def test_a_parsed_result_holds_only_closed_scalars_and_never_the_raw_line(self):
        for raw in (HEALTHY, MAX_VALID, line(canary_open=0), line(proc_numeric=3), b'', b'junk\n'):
            for bound in (False, True):
                result = cases.parse_probe_line(raw, init_bound=bound)
                self.assertEqual(set(result), {'line', 'fields', 'outsideCanary'})
                self.assertIn(result['line'], cases.PROBE_LINE_STATES)
                self.assertIn(result['outsideCanary']['process'], cases.PROBE_CANARY_STATES)
                self.assertIn(result['outsideCanary']['file'], cases.PROBE_CANARY_STATES)
                self.assertEqual(set(result['outsideCanary']), {'process', 'file'})
                if result['line'] == 'valid':
                    self.assertEqual(set(result['fields']), {name for _, name, _ in cases.PROBE_FIELDS})
                    for name in cases.PROBE_ERRNO_FIELDS:
                        self.assertIn(result['fields'][name], set(cases.PROBE_LINUX_ERRNO_SYMBOLS.values()) | {'OK', 'unknown'})
                    for name in ('stackBounds', 'stackContains', 'urandomRead', 'procRoot'):
                        self.assertIs(type(result['fields'][name]), bool)
                    self.assertIs(type(result['fields']['procNumeric']), int)
                    self.assertLessEqual(result['fields']['procNumeric'], 65535)
                else: self.assertIsNone(result['fields'])
                for scalar in self.scalars({'a': result['fields'] or {}, 'b': result['outsideCanary']}):
                    self.assertIn(type(scalar), (str, bool, int))
                self.assertNotIn(b'reader-v2', json.dumps(result).encode())
                self.assertNotIn(raw.decode('latin-1') if raw else '\x00unlikely', json.dumps(result))

    def test_the_parser_is_pure(self):
        before = (cases.PROBE_FIELDS, dict(cases.PROBE_LINUX_ERRNO_SYMBOLS))
        first = cases.parse_probe_line(HEALTHY, init_bound=True)
        first['fields']['stackRc'] = 'mutated'
        self.assertEqual(cases.parse_probe_line(HEALTHY, init_bound=True)['fields']['stackRc'], 'OK')
        self.assertEqual((cases.PROBE_FIELDS, dict(cases.PROBE_LINUX_ERRNO_SYMBOLS)), before)

    def test_adversarial_inputs_are_bounded_in_time(self):
        start = time.monotonic()
        for _ in range(2000): cases.parse_probe_line(HEALTHY, init_bound=True)
        for _ in range(200): cases.parse_probe_line(b'probe=reader-v2 ' + b'1' * 250)
        self.assertLess(time.monotonic() - start, 2.0)



# --------------------------------------------------------------------------------------------------
# The bootstrap projection of the probe record: strict, closed, and equal to the artifact record.
# --------------------------------------------------------------------------------------------------
VIEW = p.view_contract_sha256()
BUN_REPORT = None


def observed_for(stdout=HEALTHY, stderr=b'', native=0):
    return cases.Observation(True, True, True, True, True, stdout, stderr, native)


def record_for(stdout=HEALTHY, stderr=b'', native=0, launcher=0, producer=0, *, reaps=True, observed=True, bound=True):
    return cases.build_probe_record(observed_for(stdout, stderr, native) if observed else None,
                                    cases.Reaps(producer, launcher, None) if reaps else None,
                                    init_bound=bound, view_contract=VIEW)


def failure_for(record, *, via='lease', stage='case:same-owner:run'):
    lease = SimpleNamespace(stage=stage, **({'dependency_probe': record} if via == 'lease' else {}))
    handles = SimpleNamespace(**({'dependency_probe': record} if via == 'handles' else {}))
    return b.failure_record(w.Uncertain(lease, SimpleNamespace(handles=handles, cause=None)))


class Constants(unittest.TestCase):
    def test_bootstrap_constants_mirror_the_case_module(self):
        self.assertEqual(b.PROBE_FIELD_KEYS, tuple(name for _, name, _ in cases.PROBE_FIELDS))
        self.assertEqual(b.PROBE_ERRNO_FIELDS, cases.PROBE_ERRNO_FIELDS)
        self.assertEqual(b.PROBE_BIT_FIELDS, tuple(name for _, name, kind in cases.PROBE_FIELDS if kind == 'b'))
        self.assertEqual(b.PROBE_LINES, cases.PROBE_LINE_STATES)
        self.assertEqual(b.PROBE_CANARY_STATES, cases.PROBE_CANARY_STATES)
        self.assertEqual(b.PROBE_MAX_LINE, cases.PROBE_MAX_LINE)
        self.assertEqual(b.PROBE_ERRNO_VALUES, b.ERRNO_SYMBOLS + (cases.PROBE_ERRNO_OK, cases.PROBE_ERRNO_UNKNOWN))
        self.assertEqual(set(b.PROBE_KEYS), {'ran', 'line', 'fields', 'observation', 'stderrFamily', 'outsideCanary',
                                             'viewContractSha256', 'readerSuccessImplied', 'bunCompatibilityProven'})
        self.assertEqual(set(record_for()), set(b.PROBE_KEYS))

    def test_the_new_stages_are_registered_and_agree_with_the_report_family_gate(self):
        stages = ('case:dependency-probe:run', 'case:dependency-probe:verify', 'case:dependency-probe:recheck')
        self.assertEqual(tuple(stage for stage in b.FAILURE_STAGES if 'dependency-probe' in stage), stages)
        self.assertEqual(len(set(b.FAILURE_STAGES)), len(b.FAILURE_STAGES))
        for stage in stages:
            self.assertIn(stage, b.NOT_SAME_OWNER_STAGES)
            record = b.failure_record(w.Refusal('x'), stage=stage)   # A stage argument is only a default.
            self.assertEqual(record['stage'], stage)
            error = w.Uncertain(SimpleNamespace(stage=stage), w.Refusal('injected'))
            self.assertEqual(b.failure_record(error)['stage'], stage)
            self.assertEqual(b.failure_record(error)['postInitReportFamily'], 'not_same_owner_failure')
        self.assertIn('ENXIO', b.ERRNO_SYMBOLS)
        self.assertEqual(b.failure_record(OSError(6, 'private /secret'))['errnoSymbol'], 'ENXIO')   # Number 6 on Linux and macOS.
        self.assertNotIn('/secret', str(b.failure_record(OSError(6, 'private /secret'))))


class Closed(unittest.TestCase):
    def test_every_record_the_case_can_build_is_accepted_unchanged(self):
        from test_report_family import bun
        loader = b'/instruction-reader: error while loading shared libraries: libc.so.6: cannot open shared object file\n'
        stdouts = (HEALTHY, MAX_VALID, line(canary_open=0), line(proc_numeric=3), line(stack_rc=22, stack_bounds=0, stack_contains=0, urandom_open=2, urandom_read=0),
                   b'', b'garbage\n', HEALTHY + HEALTHY, HEALTHY[:-1], b'\xff' * 300, line(proc_list=13, proc_numeric=0, canary_open=13))
        stderrs = (b'', bun(), loader, b'junk', b'x\n', b'x' * 4097, b'x' * 16384, b'reader root: ' + __import__('os').strerror(2).encode() + b'\n')
        count = 0
        for stdout in stdouts:
            for stderr in stderrs:
                for native in (None, 0, 9, 77 << 8, 11 | 128, 0xffff):
                    for launcher, producer in ((0, 0), (64 << 8, 0), (9, 0), (0, 78 << 8)):
                        for reaps in (True, False):
                            for observed in (True, False):
                                for bound in (True, False):
                                    record = record_for(stdout, stderr, native, launcher, producer, reaps=reaps, observed=observed, bound=bound)
                                    self.assertEqual(b.probe_projection(record), record, (stdout, stderr, native))
                                    self.assertEqual(b.log_result_projection({'dependencyProbe': record})['dependencyProbe'], record)
                                    count += 1
        self.assertGreater(count, 5000)

    def test_the_failure_record_carries_the_same_closed_record_from_either_holder(self):
        record = record_for()
        for via in ('lease', 'handles'):
            result = failure_for(record, via=via)
            self.assertEqual(result['dependencyProbe'], record)
            self.assertEqual(b.log_result_projection(result)['dependencyProbe'], result['dependencyProbe'])
            self.assertEqual(json.loads(json.dumps(result))['dependencyProbe'], record)
        self.assertEqual(failure_for(None)['dependencyProbe'], {'ran': False})
        self.assertEqual(b.failure_record(w.Refusal('x'))['dependencyProbe'], {'ran': False})
        self.assertEqual(b.probe_record([]), {'ran': False})

    def test_a_healthy_probe_beside_a_failing_reader_keeps_both_facts(self):
        record = record_for()
        reader = SimpleNamespace(handles=SimpleNamespace(postinit_diagnostics=None, dependency_probe=None),
                                 cause=cases.Refusal('same-owner native control outcome'))
        error = w.Uncertain(SimpleNamespace(stage='case:same-owner:run', dependency_probe=record), reader)
        result = b.failure_record(error)
        self.assertIs(result['readerCaseSetPassed'], False)
        self.assertEqual(result['stage'], 'case:same-owner:run')
        self.assertEqual(result['causeReason'], 'same-owner native control outcome')
        self.assertEqual(result['dependencyProbe'], record)
        self.assertIs(result['dependencyProbe']['readerSuccessImplied'], False)
        for flag in ('readerCaseSetPassed', 'nativeCleanupConfirmed', 'configEffectProven', 'vmExecutionVerified', 'productionActivation'):
            self.assertIs(result[flag], False)

    def test_the_cases_own_handles_win_over_the_lease_and_the_first_holder_decides(self):
        mine, theirs = record_for(), record_for(stdout=b'')
        error = w.Uncertain(SimpleNamespace(stage='case:dependency-probe:run', dependency_probe=theirs),
                            SimpleNamespace(handles=SimpleNamespace(dependency_probe=mine), cause=None))
        self.assertEqual(b.failure_record(error)['dependencyProbe'], theirs)   # chain order: the lease is the first item
        chain = [SimpleNamespace(handles=SimpleNamespace(dependency_probe=mine), lease=SimpleNamespace(dependency_probe=theirs))]
        self.assertEqual(b.probe_record(chain), mine)
        chain = [SimpleNamespace(handles=SimpleNamespace(dependency_probe=None)), SimpleNamespace(lease=SimpleNamespace(dependency_probe=theirs))]
        self.assertEqual(b.probe_record(chain), theirs)
        broken = [SimpleNamespace(handles=SimpleNamespace(dependency_probe={'ran': 'maybe'})), SimpleNamespace(lease=SimpleNamespace(dependency_probe=mine))]
        self.assertEqual(b.probe_record(broken), {'ran': False})   # An invalid record is never replaced by a later one.

    def test_the_default_and_the_explicit_not_run_record(self):
        self.assertEqual(b.probe_projection({'ran': False}), {'ran': False})
        for bad in (None, [], 'ran', 0, {}, {'ran': True}, {'ran': 'False'}, {'ran': 0}, {'ran': None}, {'ran': False, 'extra': 1},
                    {'RAN': False}, b'ran', ('ran', False)):
            self.assertEqual(b.probe_projection(bad), {'ran': False}, bad)

    def test_the_log_projection_equals_the_artifact_record_and_adds_nothing(self):
        record = record_for()
        artifact = failure_for(record)
        projected = b.log_result_projection(artifact)
        self.assertEqual(projected['dependencyProbe'], artifact['dependencyProbe'])
        self.assertEqual({key: value for key, value in projected.items() if key != 'postInitStderrSample'},
                         {key: value for key, value in artifact.items() if key != 'postInitStderrSample'})
        self.assertNotIn('dependencyProbe', b.log_result_projection({'kind': 'winter-reader-only-case-set'}))
        self.assertEqual(b.log_result_projection({'dependencyProbe': {'ran': False}})['dependencyProbe'], {'ran': False})
        for value in (None, 7, 'probe', ['ran'], {'ran': True}, record | {'line': 'private'}, {**record, 'fields': {'x': 1}}):
            self.assertEqual(b.log_result_projection({'dependencyProbe': value})['dependencyProbe'], {'ran': False})
        a = dict(artifact); b.log_result_projection(a); self.assertEqual(a, artifact)   # The input is not mutated.

    def mutated(self, key, value, base=None):
        record = json.loads(json.dumps(base or record_for()))
        record[key] = value
        return record

    def test_every_key_must_be_present_and_nothing_else_is_allowed(self):
        record = record_for()
        for key in record:
            gone = dict(record); del gone[key]
            self.assertEqual(b.probe_projection(gone), {'ran': False}, key)
        self.assertEqual(b.probe_projection(dict(record, rawLine=HEALTHY.decode())), {'ran': False})
        self.assertEqual(b.probe_projection(dict(record, extra=None)), {'ran': False})

    def test_type_confusion_and_foreign_values_never_escape(self):
        marker = '/private/secret-marker'
        for key, values in {
                'ran': (1, 'True', None, 0), 'line': ('VALID', 'valid ', marker, None, b'valid', 1, True),
                'stderrFamily': ('not_same_owner_failure', 'Unknown', marker, None, 1, b'unknown', 'bun_report_shape '),
                'viewContractSha256': ('A' * 64, 'a' * 63, 'a' * 65, marker, None, 1, 'g' * 64, b'a' * 64),
                'readerSuccessImplied': (True, 1, 0, None, 'False'), 'bunCompatibilityProven': (True, 1, 0, None, 'False'),
                'observation': (None, [], marker, {'available': True}, {'available': 1}, {'raw': marker}),
                'outsideCanary': (None, [], {'process': 'visible'}, {'process': marker, 'file': 'unknown'},
                                  {'process': 'unknown', 'file': 'unknown', 'extra': 1}, {'process': True, 'file': 'unknown'},
                                  {'process': 'VISIBLE', 'file': 'unknown'})}.items():
            for value in values:
                result = b.probe_projection(self.mutated(key, value))
                self.assertEqual(result, {'ran': False}, (key, value))
                self.assertNotIn(marker, json.dumps(result))

    def test_fields_are_closed_scalars(self):
        record = record_for()
        marker = '/private/secret-marker'
        for name in b.PROBE_ERRNO_FIELDS:
            for bad in (marker, 'ENOENT ', 'enoent', 0, 2, None, True, b'ENOENT', 'ok', 'Unknown', ''):
                fields = dict(record['fields'], **{name: bad})
                self.assertEqual(b.probe_projection(dict(record, fields=fields)), {'ran': False}, (name, bad))
        for name in b.PROBE_BIT_FIELDS:
            for bad in (0, 1, 'True', None, 2):
                fields = dict(record['fields'], **{name: bad})
                self.assertEqual(b.probe_projection(dict(record, fields=fields)), {'ran': False}, (name, bad))
        for bad in (True, -1, 65536, 1.0, '1', None, 4294967295):
            fields = dict(record['fields'], procNumeric=bad)
            self.assertEqual(b.probe_projection(dict(record, fields=fields)), {'ran': False}, bad)
        for fields in (None, [], {}, dict(record['fields'], extra=1), {k: v for k, v in record['fields'].items() if k != 'procRoot'}):
            self.assertEqual(b.probe_projection(dict(record, fields=fields)), {'ran': False})
        self.assertEqual(b.probe_projection(dict(record, line='absent')), {'ran': False})    # fields must be None unless valid
        self.assertEqual(b.probe_projection(dict(record, line='unknown')), {'ran': False})
        for symbol in b.ERRNO_SYMBOLS + ('OK', 'unknown'):
            fields = dict(record['fields'], canaryOpen=symbol)
            canary = {'process': 'not_visible', 'file': 'not_visible' if symbol == 'ENOENT' else 'visible' if symbol == 'OK' else 'unknown'}
            self.assertEqual(b.probe_projection(dict(record, fields=fields, outsideCanary=canary))['fields']['canaryOpen'], symbol)

    def test_every_cross_field_rule_is_re_checked_on_the_symbols(self):
        record = record_for()
        def fields(**changes): return dict(record['fields'], **changes)
        bad = (fields(stackRc='EINVAL'), fields(stackRc='unknown', stackBounds=True, stackContains=False),
               fields(stackBounds=False, stackContains=True), fields(urandomOpen='ENOENT'), fields(urandomOpen='unknown'),
               fields(procList='EACCES'), fields(procList='unknown', procNumeric=1), fields(procList='EACCES', procNumeric=2))
        # The canary half is set consistently with the (violating) fields, so only the cross-field rule can refuse them.
        for item in bad:
            canary = {'process': 'visible' if item['procNumeric'] > 1 else 'unknown', 'file': 'not_visible'}
            self.assertEqual(b.probe_projection(dict(record, fields=item, outsideCanary=canary)), {'ran': False}, item)
        good = (fields(stackRc='EINVAL', stackBounds=False, stackContains=False), fields(stackBounds=True, stackContains=False),
                fields(urandomOpen='ENOENT', urandomRead=False), fields(procList='EACCES', procNumeric=0))
        for item in good:
            canary = {'process': 'unknown', 'file': 'not_visible'}
            self.assertEqual(b.probe_projection(dict(record, fields=item, outsideCanary=canary))['ran'], True, item)

    def test_the_derived_canary_halves_must_match_the_fields(self):
        record = record_for()
        for process, file in (('visible', 'not_visible'), ('unknown', 'visible'), ('unknown', 'unknown'), ('not_checked', 'not_checked'),
                              ('visible', 'visible'), ('not_visible', 'unknown')):
            if (process, file) == ('not_visible', 'not_visible'): continue
            self.assertEqual(b.probe_projection(dict(record, outsideCanary={'process': process, 'file': file})), {'ran': False}, (process, file))
        # Without the init binding the process half is only `unknown`; with it, `not_visible`.
        self.assertEqual(b.probe_projection(record_for(bound=False))['outsideCanary'], {'process': 'unknown', 'file': 'not_visible'})
        self.assertEqual(b.probe_projection(record_for(bound=True))['outsideCanary'], {'process': 'not_visible', 'file': 'not_visible'})
        many = record_for(stdout=line(proc_numeric=2))
        self.assertEqual(many['outsideCanary']['process'], 'visible')
        self.assertEqual(b.probe_projection(dict(many, outsideCanary={'process': 'unknown', 'file': 'not_visible'})), {'ran': False})
        self.assertEqual(b.probe_projection(dict(many, outsideCanary={'process': 'not_visible', 'file': 'not_visible'})), {'ran': False})

    def test_not_checked_is_only_for_a_record_that_observed_nothing(self):
        nothing = record_for(observed=False, reaps=False)
        self.assertEqual((nothing['line'], nothing['stderrFamily'], nothing['observation']), ('unknown', 'capture_absent', {'available': False}))
        self.assertEqual(nothing['outsideCanary'], {'process': 'not_checked', 'file': 'not_checked'})
        self.assertEqual(b.probe_projection(nothing), nothing)
        for change in ({'line': 'absent'}, {'stderrFamily': 'unknown'}, {'observation': record_for()['observation']}):
            self.assertEqual(b.probe_projection(dict(nothing, **change)), {'ran': False}, change)
        seen = record_for(stdout=b'junk\n')
        self.assertEqual(seen['outsideCanary'], {'process': 'unknown', 'file': 'unknown'})
        self.assertEqual(b.probe_projection(dict(seen, outsideCanary={'process': 'not_checked', 'file': 'not_checked'})), {'ran': False})

    def test_the_observation_must_be_the_exact_postinit_record_and_agree_with_the_line(self):
        record = record_for()
        for key in b.POSTINIT_KEYS[1:]:
            broken = dict(record['observation']); broken[key] = 'private' if key not in ('stdoutBytes',) else -1
            self.assertEqual(b.probe_projection(dict(record, observation=broken)), {'ran': False}, key)
        extra = dict(record['observation'], rawOutput='/private')
        self.assertEqual(b.probe_projection(dict(record, observation=extra)), {'ran': False})
        # A valid line needs one LF of at most 256 bytes; an absent line an empty stdout; the converse too.
        two = record_for(stdout=HEALTHY + HEALTHY)
        self.assertEqual(two['line'], 'unknown')
        self.assertEqual(b.probe_projection(dict(two, line='valid', fields=record['fields'], outsideCanary=record['outsideCanary'])), {'ran': False})
        silent = record_for(stdout=b'')
        self.assertEqual(silent['line'], 'absent')
        self.assertEqual(b.probe_projection(dict(silent, line='unknown')), {'ran': False})
        self.assertEqual(b.probe_projection(dict(record, line='absent', fields=None, outsideCanary={'process': 'unknown', 'file': 'unknown'})), {'ran': False})

    def test_a_recognised_report_needs_a_non_empty_stderr_in_the_observation(self):
        record = record_for()
        for family in ('bun_report_shape', 'webkit_assertion_shape', 'loader_error_shape', 'incomplete'):
            self.assertEqual(b.probe_projection(dict(record, stderrFamily=family)), {'ran': False}, family)
        for family in ('unknown', 'classification_error', 'capture_absent'):
            self.assertEqual(b.probe_projection(dict(record, stderrFamily=family))['stderrFamily'], family)
        from test_report_family import bun
        crashed = record_for(stdout=b'', stderr=bun(), native=11 | 128)
        self.assertEqual(crashed['stderrFamily'], 'bun_report_shape')
        self.assertEqual(b.probe_projection(crashed), crashed)

    def test_projection_returns_a_copy_never_the_input_object(self):
        record = record_for()
        result = b.probe_projection(record)
        self.assertIsNot(result, record)
        self.assertIsNot(result['fields'], record['fields'])
        self.assertIsNot(result['outsideCanary'], record['outsideCanary'])
        self.assertIsNot(result['observation'], record['observation'])

    def test_projection_failure_cannot_replace_the_original_failure_record(self):
        record = record_for()
        error = w.Uncertain(SimpleNamespace(stage='case:same-owner:run', dependency_probe=record), w.Refusal('same-owner native control outcome'))
        baseline = b.failure_record(error)
        with patch_object(b, 'probe_record', ValueError('private projection failure')):
            refused = b.failure_record(error)
        self.assertEqual(refused['dependencyProbe'], {'ran': False})
        self.assertEqual({k: v for k, v in refused.items() if k != 'dependencyProbe'}, {k: v for k, v in baseline.items() if k != 'dependencyProbe'})
        with patch_object(b, 'probe_projection', RecursionError('private')):
            self.assertEqual(b.log_result_projection({'dependencyProbe': record})['dependencyProbe'], {'ran': False})

    def test_hostile_data_is_refused_without_an_exception(self):
        class Hostile(dict):
            def __getitem__(self, key): raise RuntimeError('hostile')
        class Deep(dict): pass
        record = record_for()
        for value in (Hostile(record), 'x' * 100000, {'ran': True, 'line': 'valid', 'fields': 'x' * 100000}, [record], (record,), 10 ** 100):
            try: result = b.probe_projection(value)
            except BaseException as error: self.fail('projection raised %r' % (error,))
            self.assertEqual(result, {'ran': False})
        self.assertEqual(b.failure_record(w.Uncertain(SimpleNamespace(stage='case:same-owner:run', dependency_probe=Hostile(record)), w.Refusal('x')))['dependencyProbe'], {'ran': False})


def patch_object(target, name, error):
    from unittest.mock import patch
    return patch.object(target, name, side_effect=error)


if __name__ == '__main__': unittest.main()
