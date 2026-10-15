"""Portable stdlib DATA tests. No Root/native launch or packet imports."""
import ast
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest import mock

import parent


def clean(path):
    if path.is_dir() and not path.is_symlink():
        for root, _, _ in os.walk(path, followlinks=False):
            os.chmod(root, 0o700)
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


class Fixture:
    def __init__(self, root):
        self.root = root
        self.tree = root / 'packet'
        self.inventory = root / 'inventory.json'
        self.pin_path = root / 'pin.json'
        self.pin_data = parent.load_pin().data
        self.data, self.links, self.origins = {}, {}, []
        packages = ('runtime', 'sdk', 'conformance', 'provider-catalog',
                    'provider-conformance', 'provider-runtime')
        for origin in self.pin_data['origins']:
            role = origin['role']
            source = ({'packages/' + p + '/package.json': b'captured JSON DATA'
                       for p in packages} if role == 'sdk' else
                      {'src/fixture.py': b'raise RuntimeError("MUST NOT IMPORT")'})
            eligible = {}
            for name, data in source.items():
                self.data['source/' + role + '/' + name] = data
                eligible[name] = self.entry(data)
            self.origins.append(dict(origin, eligibleFiles=eligible,
                                     inventorySha256=parent.sha(parent.canonical(eligible))))
        self.links = {n: binding['target'] for n, binding in self.pin_data['resolverBindings'].items()}
        for role in parent.ARTIFACTS:
            self.data['artifacts/' + role] = b'non-ELF synthetic DATA: ' + role.encode()
        self.data['artifacts/instructionReader.metafile.json'] = b'{}'
        self.data['stage/linux-bun-base'] = b'base DATA'
        self.data['stage/empty-bunfig.toml'] = b''
        self.data.update({name: b'{}' for name in parent.ADDITIONAL_METADATA})
        for guest in parent.ENVIRONMENT:
            self.data['environment/' + guest.lstrip('/')] = b'library DATA: ' + guest.encode()
        self.refresh()
        self.write()

    @staticmethod
    def entry(data):
        return {'kind': 'file', 'bytes': len(data), 'sha256': parent.sha(data)}

    def refresh(self, mutate_inputs=None, mutate_receipt=None):
        pin = self.pin_data
        pin['origins'] = [{k: v for k, v in o.items() if k != 'eligibleFiles'} for o in self.origins]
        pin['artifacts'] = {r: {k: v for k, v in self.entry(self.data['artifacts/' + r]).items()
                                  if k != 'kind'} for r in parent.ARTIFACTS}
        pin['runtimeDependencies'] = {p: {k: v for k, v in self.entry(self.data['environment/' + p.lstrip('/')]).items()
                                            if k != 'kind'} for p in parent.ENVIRONMENT}
        pin['base']['executableSha256'] = parent.sha(self.data['stage/linux-bun-base'])
        staged = {n: self.entry(b) for n, b in self.data.items() if n.startswith('source/')}
        staged.update({n: {'kind': 'symlink', 'target': t} for n, t in self.links.items()})
        inputs = dict.fromkeys(parent.INPUT_KEYS, {})
        inputs.update(kind='winter-reader-inputs', formatVersion=1, origins=self.origins,
                      resolverBindings=pin['resolverBindings'], dependencies={}, stagedInputs=staged,
                      stagedInventorySha256=parent.sha(parent.canonical(staged)),
                      bareReferencesPendingMetafile=True)
        for flag in ('executedPythonSourceAuthenticated', 'dependencyInstallationPerformed',
                     'nativeOwnerVerified', 'linuxExecutionVerified', 'vmExecutionVerified', 'activationEnabled'):
            inputs[flag] = False
        if mutate_inputs:
            mutate_inputs(inputs)
        self.data['inputs.json'] = parent.canonical(inputs)
        receipt = dict.fromkeys(parent.RECEIPT_KEYS, {})
        receipt.update(kind='winter-reader-compile', formatVersion=1, origins=self.origins,
                       resolverBindings=pin['resolverBindings'], artifacts=pin['artifacts'],
                       runtimeDependencies=pin['runtimeDependencies'], base=pin['base'],
                       inputsSha256=parent.sha(self.data['inputs.json']),
                       metafileSha256=parent.sha(self.data['artifacts/instructionReader.metafile.json']),
                       recipe={'outputsExecuted': False}, staticMetafileOnly=True)
        receipt.update(dict.fromkeys(parent.FALSE_FLAGS, False))
        if mutate_receipt:
            mutate_receipt(receipt)
        self.data['receipt.json'] = parent.canonical(receipt)
        pin['receiptSha256'] = parent.sha(self.data['receipt.json'])

    def write(self, mutate_inventory=None):
        clean(self.tree)
        self.tree.mkdir()
        leaves = {n: self.entry(data) for n, data in self.data.items()}
        leaves.update({n: {'kind': 'symlink', 'target': t} for n, t in self.links.items()})
        inv = dict.fromkeys(parent.INVENTORY_KEYS, False)
        inv.update(kind='winter-reader-compile-packet', formatVersion=1,
                   excludedScratch=['artifacts/native.d'], files=leaves,
                   fileCount=len(leaves), fileBytes=sum(len(b) for b in self.data.values()),
                   builderHead=self.pin_data['builderHead'], workflowHead=self.pin_data['workflowHead'],
                   archiveSha256=self.pin_data['archiveSha256'], archiveBytes=self.pin_data['archiveBytes'])
        if mutate_inventory:
            mutate_inventory(inv)
            inv['fileCount'] = len(inv['files'])
            inv['fileBytes'] = sum(v['bytes'] for v in inv['files'].values() if v['kind'] == 'file')
        for name, data in self.data.items():
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            path.chmod(0o400)
        for name, target in self.links.items():
            path = self.tree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
        for directory, _, _ in os.walk(self.tree, followlinks=False):
            Path(directory).chmod(0o500)
        raw = parent.canonical(inv)
        self.inventory.write_bytes(raw)
        for key in ('fileCount', 'fileBytes'):
            self.pin_data[key] = inv[key]
        self.pin_data['inventoryBytes'] = len(raw)
        self.pin_data['inventorySha256'] = parent.sha(raw)
        self.pin_path.write_bytes(parent.canonical(self.pin_data))
        self.pin = parent.load_pin(self.pin_path, expected_sha256=parent.sha(self.pin_path.read_bytes()))

    def capture(self):
        return parent.capture_packet(self.tree, self.inventory, self.pin)


class SyntheticOwnerOps(parent.FilesystemOps):
    def owner(self, fd):
        return 0


class ParentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temporary.name)
        self.fixture = Fixture(self.root)

    def tearDown(self):
        clean(self.root)
        self.temporary.cleanup()

    def refused(self):
        with self.assertRaises((parent.Refusal, OSError, KeyError)):
            with self.fixture.capture():
                pass

    def test_complete_snapshot_and_exact_independent_runtime_copies(self):
        with self.fixture.capture() as snapshot:
            self.assertEqual(len(snapshot.files) + len(snapshot.links), len(self.fixture.data) + 12)
            self.assertEqual(len(snapshot.links), 12)
            with parent.create_launch_root(snapshot, self.root / 'sealed', SyntheticOwnerOps()) as sealed:
                copies = {'artifacts/' + r for r in parent.ARTIFACTS} | {p.lstrip('/') for p in parent.ENVIRONMENT}
                self.assertEqual(len(parent.ARTIFACTS), 3)
                self.assertEqual(len(copies), 9)
                # Nine copied objects plus the one Root-created canary leaf.
                self.assertEqual(set(sealed.files), copies | {parent.CANARY_LEAF})
                self.assertEqual(len(sealed.files), 10)
                self.assertEqual(sealed.measurements['copiedFiles'], 9)
                self.assertEqual(sealed.measurements['createdLeaves'], 1)
                for name, (fd, _, _) in sealed.files.items():
                    self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), parent.runtime_file_mode(name))
                    with self.assertRaises(OSError):
                        os.write(fd, b'x')
                    if name == parent.CANARY_LEAF:
                        continue
                    self.assertEqual(stat.S_IMODE(os.fstat(fd).st_mode), 0o555)
                    source = name if name.startswith('artifacts/') else 'environment/' + name
                    self.assertNotEqual(os.fstat(fd).st_ino, os.fstat(snapshot.files[source][0]).st_ino)
                self.assertEqual(list((sealed.path / 'run/winter/instruction-reader-views/reader-case').iterdir()), [])
                self.assertEqual(stat.S_IMODE((sealed.path / 'run/winter/instruction-reader-views/reader-case').stat().st_mode), 0o700)
                for measurement in (snapshot.measurements, sealed.measurements, parent.recheck_runtime(sealed)):
                    for flag in ('outputsExecuted', 'nativeAdmission', 'nativeOwnerVerified',
                                 'linuxExecutionVerified', 'vmExecutionVerified', 'activationEnabled'):
                        self.assertIs(measurement[flag], False)
                with self.assertRaisesRegex(parent.Refusal, 'real filesystem'):
                    parent.guard_root_owner(sealed)
        self.assertTrue(snapshot.closed)
        self.assertTrue(sealed.closed)

    def canary_path(self, sealed):
        return sealed.path / parent.CANARY_LEAF

    def test_outside_canary_is_a_root_created_0444_leaf_at_the_top_and_not_a_copied_artifact(self):
        self.assertEqual(parent.CANARY_LEAF, 'winter-outside-canary')
        self.assertEqual(parent.CANARY_CONTENT, b'NEVER-READER-OUTSIDE-CANARY\n')
        self.assertEqual(parent.CANARY_MODE, 0o444)
        self.assertNotIn(parent.CANARY_LEAF, {r.rsplit('/', 1)[-1] for r in parent.ARTIFACTS})
        with self.fixture.capture() as snapshot:
            self.assertNotIn(parent.CANARY_LEAF, snapshot.files)
            with parent.create_launch_root(snapshot, self.root / 'sealed', SyntheticOwnerOps()) as sealed:
                canary = self.canary_path(sealed)
                self.assertEqual(canary.parent, sealed.path)
                info = canary.lstat()
                self.assertTrue(stat.S_ISREG(info.st_mode))
                self.assertEqual(stat.S_IMODE(info.st_mode), 0o444)
                self.assertEqual((info.st_uid, info.st_gid, info.st_nlink), (os.geteuid(), os.getegid(), 1))
                self.assertEqual(canary.read_bytes(), parent.CANARY_CONTENT)
                self.assertIn(parent.CANARY_LEAF, os.listdir(sealed.path))
                held_fd, expected, observed = sealed.files[parent.CANARY_LEAF]
                self.assertEqual(expected, {'bytes': len(parent.CANARY_CONTENT), 'sha256': parent.sha(parent.CANARY_CONTENT)})
                self.assertEqual(os.fstat(held_fd).st_ino, info.st_ino)
                with self.assertRaises(OSError):
                    os.write(held_fd, b'x')
                self.assertIn(parent.CANARY_LEAF, sealed.directories[''][1])
                # The 0444 file is readable by an unrelated reader uid; the sealed 0555 objects are not writable.
                self.assertTrue(info.st_mode & stat.S_IROTH)
                parent.recheck_runtime(sealed)

    def test_canary_mode_expectations_guard_the_canary_apart_from_the_runtime_objects(self):
        self.assertEqual(parent.runtime_file_mode(parent.CANARY_LEAF), 0o444)
        self.assertEqual(parent.runtime_file_mode('artifacts/instructionReaderDependencyProbe'), 0o555)
        self.assertEqual(parent.runtime_file_mode('lib/aarch64-linux-gnu/libc.so.6'), 0o555)
        from types import SimpleNamespace
        def info(**changes):
            fields = dict(st_mode=stat.S_IFREG | 0o444, st_uid=0, st_gid=0, st_nlink=1)
            fields.update(changes)
            return SimpleNamespace(**fields)
        self.assertTrue(parent.canary_ok(info()))
        for changes in ({'st_uid': 1000}, {'st_gid': 1000}, {'st_mode': stat.S_IFREG | 0o400},
                        {'st_mode': stat.S_IFREG | 0o644}, {'st_mode': stat.S_IFREG | 0o555},
                        {'st_mode': stat.S_IFLNK | 0o444}, {'st_mode': stat.S_IFDIR | 0o444}, {'st_nlink': 2}):
            with self.subTest(changes=changes):
                self.assertFalse(parent.canary_ok(info(**changes)))

    def test_pre_existing_canary_name_refuses_and_leaves_no_destination(self):
        real_mkdir = os.mkdir
        def plant(path, mode=0o777, *, dir_fd=None):
            real_mkdir(path, mode, dir_fd=dir_fd)
            if path == 'sealed':
                root_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY, dir_fd=dir_fd)
                try:
                    os.close(os.open(parent.CANARY_LEAF, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=root_fd))
                finally:
                    os.close(root_fd)
        with self.fixture.capture() as snapshot:
            with mock.patch.object(parent.os, 'mkdir', side_effect=plant):
                with self.assertRaisesRegex(parent.Refusal, 'launch root canary leaf occupied'):
                    parent.create_launch_root(snapshot, self.root / 'sealed')
            self.assertFalse((self.root / 'sealed').exists())

    def test_canary_symlink_at_the_name_is_never_followed(self):
        outside = self.root / 'outside-target'
        real_mkdir = os.mkdir
        def plant(path, mode=0o777, *, dir_fd=None):
            real_mkdir(path, mode, dir_fd=dir_fd)
            if path == 'sealed':
                root_fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY, dir_fd=dir_fd)
                try:
                    os.symlink(str(outside), parent.CANARY_LEAF, dir_fd=root_fd)
                finally:
                    os.close(root_fd)
        with self.fixture.capture() as snapshot:
            with mock.patch.object(parent.os, 'mkdir', side_effect=plant):
                with self.assertRaisesRegex(parent.Refusal, 'launch root canary leaf occupied'):
                    parent.create_launch_root(snapshot, self.root / 'sealed')
            self.assertFalse(outside.exists())
            self.assertFalse((self.root / 'sealed').exists())

    def test_late_failure_after_the_canary_exists_removes_it_with_the_whole_root(self):
        with self.fixture.capture() as snapshot:
            with mock.patch.object(parent.SealedRoot, 'recheck', side_effect=parent.Refusal('injected late failure')):
                with self.assertRaisesRegex(parent.Refusal, 'injected late failure'):
                    parent.create_launch_root(snapshot, self.root / 'sealed')
            self.assertFalse((self.root / 'sealed').exists())

    def test_missing_extra_or_altered_canary_fails_the_post_case_recheck(self):
        for mutation in ('missing', 'extra', 'content', 'mode', 'replaced', 'moved'):
            with self.subTest(mutation=mutation):
                with self.fixture.capture() as snapshot:
                    with parent.create_launch_root(snapshot, self.root / 'sealed') as sealed:
                        parent.recheck_runtime(sealed)
                        canary = self.canary_path(sealed)
                        sealed.path.chmod(0o700)
                        if mutation == 'missing':
                            canary.unlink()
                        elif mutation == 'extra':
                            (sealed.path / 'second-leaf').write_bytes(b'')
                        elif mutation == 'content':
                            canary.chmod(0o600)
                            canary.write_bytes(b'X' * len(parent.CANARY_CONTENT))
                            canary.chmod(0o444)
                        elif mutation == 'mode':
                            canary.chmod(0o400)
                        elif mutation == 'replaced':
                            canary.unlink()
                            canary.write_bytes(parent.CANARY_CONTENT)
                            canary.chmod(0o444)
                        else:
                            canary.rename(sealed.path / 'moved-canary')
                        sealed.path.chmod(0o555)
                        with self.assertRaises((parent.Refusal, OSError)):
                            parent.recheck_runtime(sealed)
                clean(self.root / 'sealed')

    def test_a_planted_second_top_level_leaf_is_an_extra_directory_entry(self):
        with self.fixture.capture() as snapshot:
            with parent.create_launch_root(snapshot, self.root / 'sealed') as sealed:
                sealed.path.chmod(0o700)
                (sealed.path / 'other').write_bytes(b'')
                sealed.path.chmod(0o555)
                with self.assertRaisesRegex(parent.Refusal, 'sealed directory changed|extra physical directory entry'):
                    parent.recheck_runtime(sealed)

    def test_external_pin_and_inventory_bytes_bound(self):
        with self.assertRaisesRegex(parent.Refusal, 'external compile pin hash'):
            parent.load_pin(self.fixture.pin_path)
        self.fixture.inventory.write_bytes(self.fixture.inventory.read_bytes() + b' ')
        self.refused()

    def test_pin_cannot_be_mutated_via_returned_dict(self):
        data = self.fixture.pin.data
        data['fileCount'] = 1
        with self.fixture.capture() as snapshot:
            self.assertGreater(snapshot.measurements['fileCount'], 1)

    def test_reviewed_file_count_is_one_named_measured_constant(self):
        # The count the reviewed pin is held to lives in one named constant, replaced together with the pin at repin.
        self.assertEqual(parent.REVIEWED_FILE_COUNT, 1472)
        self.assertEqual(parent.load_pin().data['fileCount'], parent.REVIEWED_FILE_COUNT)

    def test_requires_reviewed_pin_not_packet_dict(self):
        with self.assertRaisesRegex(parent.Refusal, 'separately reviewed'):
            parent.capture_packet(self.fixture.tree, self.fixture.inventory, self.fixture.pin.data)

    def test_packet_layout_only(self):
        with self.assertRaisesRegex(parent.Refusal, 'packet layout only'):
            parent.capture_packet(self.fixture.tree, self.fixture.inventory, self.fixture.pin,
                                  layout='siblings')

    def test_held_external_pin_changes_are_rejected(self):
        with self.fixture.capture() as snapshot:
            self.fixture.pin_path.write_bytes(self.fixture.pin_path.read_bytes() + b' ')
            with self.assertRaisesRegex(parent.Refusal, 'external control changed'):
                snapshot.recheck()

    def test_no_missing_library_fallback_to_host(self):
        guest = next(iter(parent.ENVIRONMENT))
        path = self.fixture.tree / 'environment' / guest.lstrip('/')
        path.parent.chmod(0o700)
        path.unlink()
        path.parent.chmod(0o500)
        self.refused()

    def test_directory_mode_changes_after_capture(self):
        with self.fixture.capture() as snapshot:
            (self.fixture.tree / 'source').chmod(0o700)
            with self.assertRaises(parent.Refusal):
                snapshot.recheck()

    def test_missing_extra_and_empty_extra_directory(self):
        for mutation in ('missing', 'extra', 'directory'):
            with self.subTest(mutation=mutation):
                self.fixture.write()
                self.fixture.tree.chmod(0o700)
                if mutation == 'missing':
                    (self.fixture.tree / 'receipt.json').unlink()
                elif mutation == 'extra':
                    (self.fixture.tree / 'unexpected').write_bytes(b'')
                else:
                    (self.fixture.tree / 'unexpected').mkdir()
                self.fixture.tree.chmod(0o500)
                self.refused()

    def test_changed_source_content(self):
        path = self.fixture.tree / 'source/runtime/src/fixture.py'
        path.chmod(0o600)
        path.write_bytes(b'changed DATA')
        path.chmod(0o400)
        self.refused()

    def test_hardlink_leaf(self):
        os.link(self.fixture.tree / 'receipt.json', self.root / 'duplicate')
        self.refused()

    def test_leaf_and_ancestor_symlink(self):
        self.fixture.tree.chmod(0o700)
        path = self.fixture.tree / 'receipt.json'
        path.unlink()
        path.symlink_to(self.fixture.inventory)
        self.fixture.tree.chmod(0o500)
        self.refused()
        self.fixture.write()
        alias = self.root / 'alias-tree'
        alias.symlink_to(self.fixture.tree, target_is_directory=True)
        with self.assertRaises(OSError):
            parent.capture_packet(alias, self.fixture.inventory, self.fixture.pin)

    def test_wrong_alias_and_symlink_cycle_escape_dangling(self):
        name = next(iter(self.fixture.links))
        for target in ('/lib/libc.so.6', '../../../../../../outside', name.rsplit('/', 1)[1],
                       '../../../sdk/packages/missing'):
            with self.subTest(target=target):
                self.fixture.links[name] = target
                self.fixture.pin_data['resolverBindings'][name]['target'] = target
                self.fixture.refresh()
                self.fixture.write()
                self.refused()

    def test_alias_ancestor_casefold_and_noncanonical_inventory(self):
        for name, reason in (('source/runtime', 'leaf ancestor collision'),
                             ('SOURCE/runtime/extra', 'casefold alias collision'),
                             ('../bad', 'path traversal'), ('/bad', 'path traversal')):
            with self.subTest(name=name):
                self.fixture.write(lambda inv: inv['files'].update({name: Fixture.entry(b'')}))
                with self.assertRaisesRegex(parent.Refusal, reason):
                    self.fixture.capture()

    def test_inventory_leaf_size_bound(self):
        def mutate(inv):
            inv['files']['receipt.json']['bytes'] = parent.MAX_LEAF + 1
        self.fixture.write(mutate)
        with self.assertRaisesRegex(parent.Refusal, 'file bounds'):
            self.fixture.capture()

    def test_fifo_leaf_refused_without_blocking(self):
        self.fixture.tree.chmod(0o700)
        path = self.fixture.tree / 'receipt.json'
        path.unlink()
        os.mkfifo(path, 0o400)
        self.fixture.tree.chmod(0o500)
        with self.assertRaisesRegex(parent.Refusal, 'file type/link/size'):
            self.fixture.capture()

    def test_metadata_schema_source_inventory_and_false_flags(self):
        mutations = [lambda r: r.update(unreviewedKey=True),
                     lambda r: r.update(linuxExecutionVerified=True),
                     lambda r: r['recipe'].update(outputsExecuted=True),
                     lambda r: r['origins'][0].update(head='0' * 40)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                fixture = self.fixture
                original_origins = copy.deepcopy(fixture.origins)
                fixture.refresh(mutate_receipt=mutate)
                fixture.write()
                self.refused()
                fixture.origins = original_origins
        self.fixture.refresh(mutate_inputs=lambda i: i['stagedInputs'].pop('source/runtime/src/fixture.py'))
        self.fixture.write()
        self.refused()

    def test_duplicate_json_keys(self):
        raw = b'{"kind":1,"kind":2}'
        with self.assertRaisesRegex(parent.Refusal, 'duplicate'):
            parent.parse_json(raw)

    def test_descriptor_preflight(self):
        with mock.patch.object(parent.resource, 'getrlimit', return_value=(10, 10)):
            self.refused()

    def test_capture_failure_closes_every_held_fd(self):
        original = parent.Handles.hold
        held = []
        def record(instance, fd):
            held.append(fd)
            return original(instance, fd)
        (self.fixture.tree / 'receipt.json').chmod(0o600)
        with mock.patch.object(parent.Handles, 'hold', record):
            self.refused()
        for fd in held:
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_rename_replacement_and_same_inode_write_after_capture(self):
        with self.fixture.capture() as snapshot:
            path = self.fixture.tree / 'receipt.json'
            self.fixture.tree.chmod(0o700)
            path.rename(self.fixture.tree / 'old-receipt')
            path.write_bytes(self.fixture.data['receipt.json'])
            path.chmod(0o400)
            self.fixture.tree.chmod(0o500)
            with self.assertRaises(parent.Refusal):
                snapshot.recheck()
            with self.assertRaises(parent.Refusal):
                parent.create_launch_root(snapshot, self.root / 'never-created')
            self.assertFalse((self.root / 'never-created').exists())
        self.fixture.write()
        with self.fixture.capture() as snapshot:
            path = self.fixture.tree / 'source/runtime/src/fixture.py'
            path.chmod(0o600)
            path.write_bytes(b'x' * len(self.fixture.data['source/runtime/src/fixture.py']))
            path.chmod(0o400)
            with self.assertRaises(parent.Refusal):
                snapshot.recheck()

    def test_runtime_recheck_after_drain_detects_copy_and_packet_changes(self):
        with self.fixture.capture() as snapshot:
            with parent.create_launch_root(snapshot, self.root / 'sealed') as sealed:
                parent.recheck_runtime(sealed)
                path = sealed.path / 'artifacts/instructionReader'
                path.chmod(0o600)
                path.write_bytes(b'x' * path.stat().st_size)
                path.chmod(0o555)
                with self.assertRaises(parent.Refusal):
                    parent.recheck_runtime(sealed)
        clean(self.root / 'sealed')
        with self.fixture.capture() as snapshot:
            with parent.create_launch_root(snapshot, self.root / 'sealed') as sealed:
                self.fixture.inventory.write_bytes(self.fixture.inventory.read_bytes() + b' ')
                with self.assertRaises(parent.Refusal):
                    parent.recheck_runtime(sealed)

    def test_fresh_destination_and_copy_failure_cleanup(self):
        with self.fixture.capture() as snapshot:
            destination = self.root / 'existing'
            destination.mkdir()
            (destination / 'sentinel').write_bytes(b'unchanged')
            with self.assertRaises(FileExistsError):
                parent.create_launch_root(snapshot, destination)
            self.assertEqual((destination / 'sentinel').read_bytes(), b'unchanged')
            with mock.patch.object(parent.os, 'write', side_effect=OSError('injected copy failure')):
                with self.assertRaisesRegex(OSError, 'injected'):
                    parent.create_launch_root(snapshot, self.root / 'failed')
            self.assertFalse((self.root / 'failed').exists())

    def test_source_imports_only_stdlib_and_has_no_execution_api(self):
        source = Path(parent.__file__).read_text()
        imports = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imports.update(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                imports.add(node.module.split('.')[0])
        self.assertEqual(imports, {'__future__', 'hashlib', 'json', 'os', 'pathlib',
                                   'resource', 'stat', 'sys', 'unicodedata'})
        self.assertNotIn('subprocess', source)
        self.assertNotIn('import intake', source)


if __name__ == '__main__':
    unittest.main()
