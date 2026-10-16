"""Closed executable role of NativeOperation. Pure launch-recipe DATA: no fork, namespace,
descriptor, mount or compiled output. The role may change ONLY the executable-FD slot."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
import unittest

import producer as p

READER, PROBE = 'instructionReader', 'instructionReaderDependencyProbe'
RECEIPT_FD, SOURCE_FD, SHARED_FD, ROOT_FD, LAUNCHER_FD = 40, 41, 42, 43, 44
READER_FD, PROBE_FD = 50, 51
LIBRARY_FDS = {path: 60 + index for index, path in enumerate(p.LIBRARIES)}
ROOT_PATH = Path('/run/winter-fixture/runtime')


def fake_root(**overrides):
    files = {'artifacts/instructionReader': (READER_FD,), 'artifacts/instructionReaderDependencyProbe': (PROBE_FD,),
             'artifacts/instructionReaderLauncher': (LAUNCHER_FD,),
             **{path.lstrip('/'): (fd,) for path, fd in LIBRARY_FDS.items()}}
    files.update(overrides)
    return SimpleNamespace(files=files, directories={'': (ROOT_FD,)}, path=ROOT_PATH)


UNSET = object()


def operation(role=UNSET, root=None, **kwargs):
    extra = {} if role is UNSET else {'executable_role': role}
    return p.NativeOperation(p.Debt(), root or fake_root(), SOURCE_FD, SHARED_FD, lambda _: None, lambda _: None,
                             source_path=Path('/run/winter-fixture/fixture/source'),
                             shared_path=Path('/run/winter-fixture/fixture/shared'), **extra, **kwargs)


class Role(unittest.TestCase):
    def test_default_is_the_reader_and_the_role_set_is_closed(self):
        self.assertEqual(p.DEFAULT_EXECUTABLE_ROLE, READER)
        self.assertEqual(operation().executable_role, READER)
        self.assertEqual(set(p.EXECUTABLE_ROLES), {READER, PROBE})
        for wrong in ('', 'instructionreader', 'instructionReaderLauncher', 'instructionReaderDependencyProbe ',
                      None, 1, b'instructionReader', ('instructionReader',), 'artifacts/instructionReader'):
            with self.subTest(wrong=wrong), self.assertRaises(p.Refusal):
                operation(wrong)

    def test_the_role_table_is_immutable(self):
        with self.assertRaises(TypeError):
            p.EXECUTABLE_ROLES['other'] = 'artifacts/other'
        with self.assertRaises(TypeError):
            del p.EXECUTABLE_ROLES[READER]

    def test_the_default_reader_recipe_is_the_pre_role_recipe(self):
        argv, pass_fds, root_fd, paths = operation().launch_recipe(RECEIPT_FD)
        libraries = tuple((fd, path) for path, fd in LIBRARY_FDS.items())
        self.assertEqual(argv, p.launcher_argv(READER_FD, RECEIPT_FD, SOURCE_FD, SHARED_FD, libraries))
        self.assertEqual(pass_fds, (READER_FD, RECEIPT_FD, SOURCE_FD, SHARED_FD, *LIBRARY_FDS.values()))
        self.assertEqual(root_fd, ROOT_FD)
        self.assertEqual(paths, ((ROOT_FD, ROOT_PATH), (LAUNCHER_FD, ROOT_PATH / 'artifacts/instructionReaderLauncher'),
            (READER_FD, ROOT_PATH / 'artifacts/instructionReader'),
            (SOURCE_FD, Path('/run/winter-fixture/fixture/source')), (SHARED_FD, Path('/run/winter-fixture/fixture/shared')),
            *((fd, ROOT_PATH / path.lstrip('/')) for path, fd in LIBRARY_FDS.items())))
        self.assertEqual(operation(READER).launch_recipe(RECEIPT_FD), (argv, pass_fds, root_fd, paths))

    def test_probe_and_reader_argv_differ_only_in_the_executable_slot(self):
        reader = operation(READER).launch_recipe(RECEIPT_FD)
        probe = operation(PROBE).launch_recipe(RECEIPT_FD)
        reader_argv, probe_argv = reader[0], probe[0]
        self.assertEqual(len(reader_argv), len(probe_argv))
        differing = [index for index, (a, b) in enumerate(zip(reader_argv, probe_argv)) if a != b]
        self.assertEqual(differing, [2])
        self.assertEqual((reader_argv[2], probe_argv[2]), (str(READER_FD), str(PROBE_FD)))
        # Every other argv slot, including the launcher path, UID, GROUP and VIEW, is byte-identical.
        self.assertEqual(reader_argv[:2], probe_argv[:2])
        self.assertEqual(reader_argv[3:], probe_argv[3:])
        self.assertEqual(probe_argv[5:7], [str(p.UID), str(p.GROUP)])
        self.assertEqual(probe_argv[3], p.VIEW)
        self.assertEqual(probe_argv[0], '/artifacts/instructionReaderLauncher')

    def test_probe_and_reader_inherit_the_same_descriptors_except_the_first(self):
        reader, probe = operation(READER).launch_recipe(RECEIPT_FD), operation(PROBE).launch_recipe(RECEIPT_FD)
        self.assertEqual((reader[1][0], probe[1][0]), (READER_FD, PROBE_FD))
        self.assertEqual(reader[1][1:], probe[1][1:])
        self.assertEqual(reader[2], probe[2])  # The same sealed-root descriptor.

    def test_reopen_paths_differ_only_in_the_executable_entry(self):
        reader, probe = operation(READER).launch_recipe(RECEIPT_FD)[3], operation(PROBE).launch_recipe(RECEIPT_FD)[3]
        self.assertEqual(len(reader), len(probe))
        differing = [index for index, (a, b) in enumerate(zip(reader, probe)) if a != b]
        self.assertEqual(differing, [2])
        self.assertEqual(reader[2], (READER_FD, ROOT_PATH / 'artifacts/instructionReader'))
        self.assertEqual(probe[2], (PROBE_FD, ROOT_PATH / 'artifacts/instructionReaderDependencyProbe'))
        # The launcher reopen entry is not the executable and never changes with the role.
        self.assertEqual(probe[1], (LAUNCHER_FD, ROOT_PATH / 'artifacts/instructionReaderLauncher'))

    def test_the_probe_role_never_resolves_the_reader_leaf_and_the_reader_never_the_probe_leaf(self):
        no_probe = fake_root(); del no_probe.files['artifacts/instructionReaderDependencyProbe']
        no_reader = fake_root(); del no_reader.files['artifacts/instructionReader']
        operation(READER, no_probe).launch_recipe(RECEIPT_FD)   # A reader needs no probe leaf.
        operation(PROBE, no_reader).launch_recipe(RECEIPT_FD)   # A probe needs no reader leaf.
        with self.assertRaises(KeyError):
            operation(PROBE, no_probe).launch_recipe(RECEIPT_FD)
        with self.assertRaises(KeyError):
            operation(READER, no_reader).launch_recipe(RECEIPT_FD)

    def test_role_and_environment_are_recorded_without_touching_the_selected_exec_environment(self):
        for role in (READER, PROBE):
            op = operation(role)
            self.assertEqual(dict(op.exec_environment), dict(p.FIXED_HOST_EXEC_ENV))
            self.assertEqual(op.executable_role, role)

    def test_source_start_reads_the_recipe_only_through_launch_recipe(self):
        import ast
        source = Path(p.__file__).read_text()
        start = next(node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.FunctionDef) and node.name == '_start')
        body = ast.get_source_segment(source, start)
        self.assertIn('self.launch_recipe(b.fileno())', body)
        self.assertNotIn("'artifacts/instructionReader'", body)
        self.assertNotIn('LIBRARIES', body)
        self.assertNotIn('launcher_argv', body)


class ViewContract(unittest.TestCase):
    def test_digest_is_identical_across_roles_and_equals_the_fixed_contract(self):
        reader, probe = operation(READER), operation(PROBE)
        one, two = reader.view_contract_sha256(RECEIPT_FD), probe.view_contract_sha256(RECEIPT_FD)
        self.assertEqual(one, two)
        self.assertEqual(one, p.view_contract_sha256())
        self.assertRegex(one, r'^[0-9a-f]{64}$')

    def test_digest_ignores_every_process_local_descriptor_number(self):
        other = fake_root(**{'artifacts/instructionReader': (97,), 'artifacts/instructionReaderDependencyProbe': (98,)})
        for role in (READER, PROBE):
            self.assertEqual(operation(role, other).view_contract_sha256(RECEIPT_FD + 7), p.view_contract_sha256())

    def test_masking_covers_exactly_the_descriptor_slots(self):
        libraries = tuple((10 + index, path) for index, path in enumerate(p.LIBRARIES))
        argv = p.launcher_argv(3, 4, 5, 6, libraries)
        masked = p.masked_launcher_argv(argv)
        self.assertEqual([index for index, value in enumerate(masked) if value == '<fd>'],
                         [2, 4, 7, 10, 12, 14, 16, 18, 20, 22])
        self.assertEqual(masked[:2], argv[:2])
        self.assertEqual(masked[3], p.VIEW)
        self.assertEqual([masked[13 + 2 * i] for i in range(6)], list(p.LIBRARIES))
        self.assertEqual(len(argv), p.LAUNCHER_ARGV_LENGTH)

    def test_digest_is_sensitive_to_everything_that_defines_the_view(self):
        libraries = tuple((10 + index, path) for index, path in enumerate(p.LIBRARIES))
        argv = p.launcher_argv(3, 4, 5, 6, libraries)
        env = p.selected_host_exec_environment()
        base = p.view_contract_digest(argv, env)
        def changed(index, value):
            other = list(argv); other[index] = value; return p.view_contract_digest(other, env)
        self.assertNotEqual(base, changed(3, '/run/other/view'))
        self.assertNotEqual(base, changed(5, '20003'))
        self.assertNotEqual(base, changed(6, '10001'))
        self.assertNotEqual(base, changed(8, '/workspace/other'))
        self.assertNotEqual(base, changed(13, '/lib/other'))
        self.assertNotEqual(base, changed(1, 'instruction-reader-v2'))
        self.assertNotEqual(base, changed(0, '/artifacts/other'))
        self.assertNotEqual(base, p.view_contract_digest(argv, dict(env, TZ='America/New_York')))
        self.assertNotEqual(base, p.view_contract_digest(argv, dict(env, EXTRA='1')))
        fewer = dict(env); del fewer['PATH']
        self.assertNotEqual(base, p.view_contract_digest(argv, fewer))
        # Descriptor numbers are the only masked values.
        moved = list(argv)
        for index in p.LAUNCHER_FD_SLOTS: moved[index] = str(int(moved[index]) + 100)
        self.assertEqual(base, p.view_contract_digest(moved, env))

    def test_masking_refuses_a_malformed_argv(self):
        libraries = tuple((10 + index, path) for index, path in enumerate(p.LIBRARIES))
        argv = p.launcher_argv(3, 4, 5, 6, libraries)
        for wrong in (argv[:-1], argv + ['x'], tuple(argv), [*argv[:2], 'x', *argv[3:]], [*argv[:2], '-3', *argv[3:]],
                      [*argv[:2], '٣', *argv[3:]], [*argv[:2], 3, *argv[3:]], None, 'argv'):
            with self.subTest(wrong=wrong), self.assertRaises(p.Refusal):
                p.masked_launcher_argv(wrong)

    def test_digest_matches_an_independent_canonical_serialisation(self):
        libraries = tuple((10 + index, path) for index, path in enumerate(p.LIBRARIES))
        argv = p.launcher_argv(3, 4, 5, 6, libraries)
        masked = list(argv)
        for index in (2, 4, 7, 10, 12, 14, 16, 18, 20, 22): masked[index] = '<fd>'
        contract = {'argv': masked, 'env': dict(p.FIXED_HOST_EXEC_ENV),
                    'constants': {'uid': 20002, 'group': 10000, 'view': '/run/winter/instruction-reader-views/reader-case',
                                  'source': '/workspace/folders/source', 'home': '/run/winter/instruction-reader',
                                  'libraries': list(p.LIBRARIES), 'ioMax': 320 * 1024, 'deadlineMs': 6000}}
        raw = json.dumps(contract, sort_keys=True, separators=(',', ':')).encode('ascii')
        self.assertEqual(p.view_contract_sha256(), hashlib.sha256(raw).hexdigest())


if __name__ == '__main__': unittest.main()
