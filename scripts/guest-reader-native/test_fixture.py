"""Ordinary temporary DATA files and synthetic response oracles only."""
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
import fixture as f


class Tests(unittest.TestCase):
    def test_fresh_held_fixture_and_changed_file_refusal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'fixture'
            fixture = f.create_fixture(root)
            try:
                fixture.recheck()
                with self.assertRaises(FileExistsError): f.create_fixture(root)
                source = root / 'source' / 'WINTER.md'
                os.chmod(source, 0o600)
                source.write_bytes(b'changed')
                with self.assertRaises(ValueError): fixture.recheck()
            finally:
                fixture.close()
                # Ordinary test DATA cleanup, not native mount cleanup evidence.
                for child in root.iterdir(): os.chmod(child, 0o700)

    def test_exact_response_with_correlated_fixture_snapshot(self):
        response = dict(f.request(), snapshot=f.expected_snapshot())
        raw = json.dumps(response, separators=(',', ':')).encode() + b'\n'
        self.assertTrue(f.verify_response(raw, b'')['readerFrameVerified'])
        self.assertFalse(f.verify_response(raw, b'')['configEffectProven'])
        self.assertLess(len(f.request_bytes()), 16 * 1024)

    def test_actual_transport_required_compact_json_without_lf_grammar(self):
        raw=f.request_bytes()
        self.assertFalse(raw.endswith(b'\n'))
        self.assertEqual(raw,json.dumps(json.loads(raw.decode('utf-8')),
            separators=(',',':'),ensure_ascii=False).encode('utf-8'))
        self.assertEqual(json.loads(raw),f.request())
        # Same exact roundtrip grammar as RuntimeSDK0394 parseRequest. Adding
        # LF is valid generic JSON but must fail this transport's wire contract.
        self.assertNotEqual(raw+b'\n',json.dumps(json.loads(raw+b'\n'),
            separators=(',',':'),ensure_ascii=False).encode('utf-8'))

    def test_foreign_extra_bool_missing_wrong_digest_and_stderr_refuse(self):
        good = dict(f.request(), snapshot=f.expected_snapshot())
        cases = []
        for mutation in ('foreign', 'extra', 'bool', 'missing', 'digest', 'hidden'):
            wrong = copy.deepcopy(good)
            if mutation == 'foreign': wrong['readId'] = 'foreign'
            elif mutation == 'extra': wrong['unexpected'] = True
            elif mutation == 'bool': wrong['version'] = True
            elif mutation == 'missing': wrong['snapshot']['blocks'].pop()
            elif mutation == 'digest': wrong['snapshot']['digest'] = '0' * 64
            else: wrong['snapshot']['text'] += 'NEVER-READER-hidden-store'
            cases.append(json.dumps(wrong).encode() + b'\n')
        cases.extend([b'{}\n{}\n', b'{"version":1,"version":1}\n', b'\xff\n'])
        for raw in cases:
            with self.assertRaises((ValueError, UnicodeError)): f.verify_response(raw, b'')
        with self.assertRaises(ValueError):
            f.verify_response(json.dumps(good).encode() + b'\n', b'failure')


if __name__ == '__main__': unittest.main()
