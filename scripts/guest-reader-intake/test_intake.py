"""Portable DATA fixtures; no packet/project code or compiled output is run."""
import copy
import gzip
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import unittest
from unittest import mock

import intake


def clean(path):
    if not path.exists():
        return
    for root, dirs, _ in os.walk(path, followlinks=False):
        os.chmod(root, 0o700)
    shutil.rmtree(path)


class Fixture:
    def __init__(self, directory):
        self.directory = directory
        self.data = {}
        self.links = {}
        self.pin = intake.load_pin()
        self.origins = []
        packages = ('runtime', 'sdk', 'conformance', 'provider-catalog',
                    'provider-conformance', 'provider-runtime')
        for origin in self.pin['origins']:
            role = origin['role']
            files = ({'packages/' + package + '/package.json':
                      json.dumps({'name': package, 'version': '0.0.53'}).encode()
                      for package in packages} if role == 'sdk' else {'src/fixture.txt': b'captured DATA'})
            eligible = {}
            for name, data in files.items():
                self.data['source/' + role + '/' + name] = data
                eligible[name] = self.entry(data)
            item = dict(origin, eligibleFiles=eligible)
            item['inventorySha256'] = intake.sha(intake.canonical(eligible))
            self.origins.append(item)
        for name, binding in self.pin['resolverBindings'].items():
            self.links[name] = binding['target']
        self.data['artifacts/instructionReader'] = b'non-executable reader DATA'
        self.data['artifacts/instructionReaderLauncher'] = b'non-executable launcher DATA'
        self.data['artifacts/instructionReaderDependencyProbe'] = b'non-executable dependency probe DATA'
        self.data['artifacts/instructionReader.metafile.json'] = b'{}'
        self.data['stage/linux-bun-base'] = b'non-executable base DATA'
        self.data['stage/empty-bunfig.toml'] = b''
        for guest in self.pin['runtimeDependencies']:
            self.data['environment/' + guest.lstrip('/')] = guest.encode()
        self.refresh_controls()

    @staticmethod
    def entry(data):
        return {'kind': 'file', 'sha256': intake.sha(data), 'bytes': len(data)}

    def refresh_controls(self):
        self.pin['origins'] = [{k: v for k, v in o.items() if k != 'eligibleFiles'} for o in self.origins]
        self.pin['artifacts'] = {n: {k: v for k, v in self.entry(self.data['artifacts/' + n]).items()
                                     if k != 'kind'} for n in intake.ARTIFACTS}
        self.pin['runtimeDependencies'] = {n: {k: v for k, v in self.entry(self.data['environment/' + n.lstrip('/')]).items()
                                              if k != 'kind'} for n in intake.ENVIRONMENT}
        self.pin['base']['executableSha256'] = intake.sha(self.data['stage/linux-bun-base'])
        inputs = {'origins': self.origins, 'resolverBindings': self.pin['resolverBindings'],
                  'dependencies': {}, 'stagedInputs': {}}
        self.data['inputs.json'] = intake.canonical(inputs)
        receipt = {'kind': 'winter-reader-compile', 'formatVersion': 1,
                   'staticMetafileOnly': True, 'origins': self.origins,
                   'resolverBindings': self.pin['resolverBindings'],
                   'inputsSha256': intake.sha(self.data['inputs.json']),
                   'metafileSha256': intake.sha(self.data['artifacts/instructionReader.metafile.json']),
                   'artifacts': self.pin['artifacts'], 'runtimeDependencies': self.pin['runtimeDependencies'],
                   'base': self.pin['base']}
        receipt.update(dict.fromkeys(intake.FALSE_RECEIPT_FLAGS, False))
        self.data['receipt.json'] = intake.canonical(receipt)
        self.pin['receiptSha256'] = intake.sha(self.data['receipt.json'])

    def write(self, *, mutation=None, extra=None, missing=None, duplicate=None, trailing=b''):
        inv = {'kind': 'winter-reader-compile-packet', 'formatVersion': 1,
               'excludedScratch': ['artifacts/native.d'],
               'builderHead': self.pin['builderHead'], 'workflowHead': self.pin['workflowHead'],
               'files': {n: self.entry(b) for n, b in self.data.items()}}
        inv.update(dict.fromkeys(('activationEnabled', 'nativeAdmission', 'outputsExecuted', 'vmExecutionVerified'), False))
        inv['files'].update({n: {'kind': 'symlink', 'target': t} for n, t in self.links.items()})
        inv['fileCount'] = len(inv['files'])
        inv['fileBytes'] = sum(len(b) for b in self.data.values())
        self.pin['fileCount'] = inv['fileCount']
        self.pin['fileBytes'] = inv['fileBytes']
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for name in list(inv['files']) + ([duplicate] if duplicate else []):
                if name == missing:
                    continue
                member = tarfile.TarInfo(name)
                body = self.data.get(name, b'')
                member.mode = 0o400
                member.size = len(body)
                if name in self.links:
                    member.type = tarfile.SYMTYPE
                    member.linkname = self.links[name]
                    member.mode = 0o777
                if mutation:
                    member, body = mutation(member, body)
                tar.addfile(member, io.BytesIO(body) if member.type == tarfile.REGTYPE else None)
            if extra:
                member = tarfile.TarInfo(extra)
                member.mode = 0o400
                tar.addfile(member, io.BytesIO())
        archive = gzip.compress(raw.getvalue() + trailing, mtime=0)
        self.pin['archiveBytes'] = inv['archiveBytes'] = len(archive)
        self.pin['archiveSha256'] = inv['archiveSha256'] = intake.sha(archive)
        inventory = intake.canonical(inv)
        self.pin['inventoryBytes'] = len(inventory)
        self.pin['inventorySha256'] = intake.sha(inventory)
        self.archive = self.directory / 'packet.tar.gz'
        self.inventory = self.directory / 'inventory.json'
        self.archive.write_bytes(archive)
        self.inventory.write_bytes(inventory)
        return self

    def validate(self):
        return intake.validate_packet(self.archive, self.inventory, pin=self.pin)


@unittest.skipIf(os.geteuid() == 0, 'intake explicitly refuses privileged callers')
class IntakeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir()).resolve())
        self.root = Path(self.temporary.name)
        self.fixture = Fixture(self.root)

    def tearDown(self):
        clean(self.root)
        self.temporary.cleanup()

    def assert_refused(self):
        destination = self.root / 'output'
        with mock.patch.object(intake.tempfile, 'TemporaryDirectory', wraps=tempfile.TemporaryDirectory) as create:
            with self.assertRaises((intake.Refusal, OSError, KeyError)):
                with self.fixture.validate() as validated:
                    intake.rehydrate_packet(validated, destination)
            for call in create.mock_calls:
                self.assertNotIn(str(destination), str(call))
        self.assertFalse(destination.exists())

    def check_output(self, layout):
        self.fixture.write()
        with self.fixture.validate() as validated:
            spool = Path(validated._temporary.name)
            self.assertEqual(stat.S_IMODE(spool.stat().st_mode), 0o700)
            destination = self.root / 'output'
            report = intake.rehydrate_packet(validated, destination, layout=layout)
            for name, data in self.fixture.data.items():
                target = destination / intake.output_name(name, layout)
                self.assertEqual(target.read_bytes(), data)
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o400)
            for name in self.fixture.links:
                target = destination / intake.output_name(name, layout)
                self.assertTrue(target.is_symlink())
                self.assertTrue(target.resolve().is_relative_to(destination))
                self.assertTrue(target.resolve().is_relative_to(destination / ('sdk' if layout == 'siblings' else 'source/sdk')))
            for root, dirs, _ in os.walk(destination):
                self.assertEqual(stat.S_IMODE(Path(root).stat().st_mode), 0o500)
            for flag in ('outputExecution', 'outputsExecuted', 'nativeAdmission', 'profileActivation',
                         'authorityGranted', 'activationEnabled', 'vmExecutionVerified'):
                self.assertIs(report[flag], False)
        self.assertFalse(spool.exists())

    def test_complete_packet_layout(self):
        self.check_output('packet')

    def test_complete_sibling_layout(self):
        self.check_output('siblings')

    def test_three_compiled_artifacts_each_have_a_distinct_data_role_at_mode_0400(self):
        self.assertEqual(len(intake.ARTIFACTS), 3)
        roles = {name: intake.role_of('artifacts/' + name) for name in intake.ARTIFACTS}
        self.assertEqual(roles, {'instructionReader': 'reader', 'instructionReaderLauncher': 'readerLauncher',
                                 'instructionReaderDependencyProbe': 'readerDependencyProbe'})
        for role in roles.values():
            self.assertEqual(intake.ROLE_MODES[role], 0o400)
        self.fixture.write()
        with self.fixture.validate() as validated:
            report = intake.rehydrate_packet(validated, self.root / 'output')
        self.assertEqual(report['roleModes']['readerDependencyProbe'], 0o400)
        probe = self.root / 'output/artifacts/instructionReaderDependencyProbe'
        self.assertEqual(stat.S_IMODE(probe.stat().st_mode), 0o400)
        self.assertEqual(probe.read_bytes(), self.fixture.data['artifacts/instructionReaderDependencyProbe'])
        self.assertEqual(set(report['artifacts']), set(intake.ARTIFACTS))
        # Data is never executable: no role may carry an execute bit.
        for role, mode in intake.ROLE_MODES.items():
            self.assertEqual(mode & 0o111, 0, role)

    def test_every_artifact_leaf_is_classified_by_an_explicit_role_not_the_metadata_default(self):
        for name in intake.ARTIFACTS:
            self.assertNotEqual(intake.role_of('artifacts/' + name), 'metadata', name)
        self.assertEqual(intake.role_of('artifacts/instructionReader.metafile.json'), 'metadata')

    def test_two_artifact_packet_is_refused_by_the_exact_role_set(self):
        # The earlier packet shape: a pin and receipt that name only the reader and the launcher.
        with mock.patch.object(intake, 'ARTIFACTS', frozenset(('instructionReader', 'instructionReaderLauncher'))):
            self.fixture.refresh_controls()
        self.fixture.write()
        with self.assertRaisesRegex(intake.Refusal, 'compiled reader roles'):
            self.fixture.validate()

    def test_a_fourth_artifact_role_is_refused_by_the_exact_role_set(self):
        self.fixture.data['artifacts/instructionReaderExtra'] = b'unreviewed compiled DATA'
        with mock.patch.object(intake, 'ARTIFACTS', intake.ARTIFACTS | {'instructionReaderExtra'}):
            self.fixture.refresh_controls()
        self.fixture.write()
        with self.assertRaisesRegex(intake.Refusal, 'compiled reader roles'):
            self.fixture.validate()

    def test_missing_probe_leaf_and_probe_pin_tamper_are_refused(self):
        self.fixture.write(missing='artifacts/instructionReaderDependencyProbe')
        self.assert_refused()
        self.fixture.write()
        self.fixture.pin['artifacts']['instructionReaderDependencyProbe']['sha256'] = '0' * 64
        with self.assertRaisesRegex(intake.Refusal, 'artifact pin'):
            self.fixture.validate()

    def test_inventory_independent_pin(self):
        self.fixture.write()
        self.fixture.inventory.write_bytes(self.fixture.inventory.read_bytes() + b' ')
        self.assert_refused()

    def test_archive_independent_pin(self):
        self.fixture.write()
        self.fixture.archive.write_bytes(self.fixture.archive.read_bytes() + b'garbage')
        self.assert_refused()

    def test_content_tamper_with_archive_repin(self):
        def tamper(member, data):
            if member.name == 'artifacts/instructionReader':
                data = b'X' + data[1:]
            return member, data
        self.fixture.write(mutation=tamper)
        self.assert_refused()

    def test_extra_leaf(self):
        self.fixture.write(extra='extra.txt')
        self.assert_refused()

    def test_missing_leaf(self):
        self.fixture.write(missing='stage/linux-bun-base')
        self.assert_refused()

    def test_duplicate_leaf(self):
        self.fixture.write(duplicate='stage/linux-bun-base')
        self.assert_refused()

    def test_forbidden_archive_modes(self):
        for mode in (0o500, 0o600, 0o440, 0o4400, 0o2400):
            with self.subTest(mode=oct(mode)):
                def mutation(member, body):
                    if member.name == 'stage/linux-bun-base':
                        member.mode = mode
                    return member, body
                self.fixture.write(mutation=mutation)
                self.assert_refused()

    def test_forbidden_link_mode(self):
        def mutation(member, body):
            if member.type == tarfile.SYMTYPE:
                member.mode = 0o700
            return member, body
        self.fixture.write(mutation=mutation)
        self.assert_refused()

    def test_hardlink_and_special_headers(self):
        for kind in (tarfile.LNKTYPE, tarfile.DIRTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE,
                     tarfile.BLKTYPE, tarfile.XHDTYPE, tarfile.GNUTYPE_LONGNAME):
            with self.subTest(kind=kind):
                def mutation(member, body):
                    if member.name == 'stage/linux-bun-base':
                        member.type, member.size, member.linkname = kind, 0, 'inputs.json'
                        body = b''
                    return member, body
                self.fixture.write(mutation=mutation)
                self.assert_refused()

    def test_noncanonical_tar_names(self):
        for name in ('/absolute', '../escape', 'a/../alias', 'a//alias', './alias', 'a\\alias'):
            with self.subTest(name=name):
                def mutation(member, body):
                    if member.name == 'stage/linux-bun-base':
                        member.name = name
                    return member, body
                self.fixture.write(mutation=mutation)
                self.assert_refused()

    def test_collision_inventory(self):
        for name in ('source/sdk/packages/SDK/package.json', 'source/sdk/packages/sdk/package.json/child'):
            with self.subTest(name=name):
                self.fixture.data[name] = b'alias'
                self.fixture.write()
                self.assert_refused()
                del self.fixture.data[name]

    def test_alias_escape_cycle_and_dangling(self):
        alias = next(iter(self.fixture.links))
        for target in ('/outside', '../../../../../../outside', 'missing',
                       '../@yanlinglabs/' + alias.split('/')[-1]):
            with self.subTest(target=target):
                self.fixture.links[alias] = target
                self.fixture.pin['resolverBindings'][alias]['target'] = target
                self.fixture.refresh_controls()
                self.fixture.write()
                self.assert_refused()

    def test_unbound_extra_source_leaf(self):
        self.fixture.data['source/sdk/unbound.txt'] = b'not in origin'
        self.fixture.write()
        self.assert_refused()

    def test_source_origin_tamper(self):
        self.fixture.write()
        self.fixture.pin['origins'][0]['head'] = '0' * 40
        self.assert_refused()

    def test_receipt_pin_tamper(self):
        self.fixture.write()
        self.fixture.pin['receiptSha256'] = '0' * 64
        self.assert_refused()

    def test_authority_claim(self):
        receipt = intake.parse_json(self.fixture.data['receipt.json'])
        receipt['nativeOwnerVerified'] = True
        self.fixture.data['receipt.json'] = intake.canonical(receipt)
        self.fixture.pin['receiptSha256'] = intake.sha(self.fixture.data['receipt.json'])
        self.fixture.write()
        self.assert_refused()

    def test_trailing_payload(self):
        self.fixture.write(trailing=b'not tar padding')
        self.assert_refused()

    def test_inventory_size_bound(self):
        self.fixture.write()
        with mock.patch.object(intake, 'MAX_INVENTORY', 10):
            self.assert_refused()

    def test_path_depth_refuses_before_prefix_expansion(self):
        self.fixture.data['/'.join(['d'] * 65)] = b'deep DATA'
        self.fixture.write()
        with self.assertRaisesRegex(intake.Refusal, 'path depth bound'):
            self.fixture.validate()

    def test_prefix_visit_budget_is_independent_of_leaf_count(self):
        self.fixture.write()
        with mock.patch.object(intake, 'MAX_PREFIX_VISITS', 20):
            with self.assertRaisesRegex(intake.Refusal, 'directory prefix visit bound'):
                self.fixture.validate()

    def test_regular_input_hardlink(self):
        self.fixture.write()
        os.link(self.fixture.archive, self.root / 'alias')
        self.assert_refused()

    def test_symlink_input_and_ancestor(self):
        self.fixture.write()
        original = self.fixture.archive
        linked = self.root / 'linked.tar.gz'
        linked.symlink_to(original)
        self.fixture.archive = linked
        self.assert_refused()
        linked.unlink()
        parent = self.root / 'parent'
        parent.symlink_to(self.root, target_is_directory=True)
        self.fixture.archive = parent / original.name
        self.assert_refused()

    def test_no_existing_output_overwrite(self):
        self.fixture.write()
        destination = self.root / 'output'
        destination.mkdir()
        (destination / 'keep').write_bytes(b'keep')
        with self.fixture.validate() as validated:
            with self.assertRaises(FileExistsError):
                intake.rehydrate_packet(validated, destination)
        self.assertEqual((destination / 'keep').read_bytes(), b'keep')

    def test_output_root_open_failure_removes_fresh_directory(self):
        self.fixture.write()
        destination = self.root / 'output'
        real_open = os.open
        def fail_root(path, flags, *args, **kwargs):
            if path == 'output' and flags & os.O_DIRECTORY and kwargs.get('dir_fd') is not None:
                raise OSError('injected output root open failure')
            return real_open(path, flags, *args, **kwargs)
        with self.fixture.validate() as validated:
            with mock.patch.object(intake.os, 'open', side_effect=fail_root):
                with self.assertRaisesRegex(OSError, 'injected output root open failure'):
                    intake.rehydrate_packet(validated, destination)
            self.assertFalse(destination.exists())

    def test_symlink_output_parent(self):
        self.fixture.write()
        outside = self.root / 'outside'
        outside.mkdir()
        link = self.root / 'parent'
        link.symlink_to(outside, target_is_directory=True)
        with self.fixture.validate() as validated:
            with self.assertRaises(OSError):
                intake.rehydrate_packet(validated, link / 'output')
        self.assertEqual(list(outside.iterdir()), [])

    def test_copy_tamper_cleans_destination(self):
        self.fixture.write()
        with self.fixture.validate() as validated:
            held = next(iter(validated._files.values()))
            held.chmod(0o600)
            held.write_bytes(b'tamper')
            destination = self.root / 'output'
            with self.assertRaises(intake.Refusal):
                intake.rehydrate_packet(validated, destination)
            self.assertFalse(destination.exists())
            spool = Path(validated._temporary.name)
        self.assertFalse(spool.exists())

    def test_cleanup_directory_error_still_attempts_removal_and_preserves_original(self):
        self.fixture.write()
        destination = self.root / 'output'
        real_parent = intake.relative_parent
        state = {'cleanup': False}
        def copy_failure(*args, **kwargs):
            state['cleanup'] = True
            raise intake.Refusal('original copy failure')
        def parent_failure(*args, **kwargs):
            if state['cleanup']:
                raise NotADirectoryError('injected cleanup traversal failure')
            return real_parent(*args, **kwargs)
        with self.fixture.validate() as validated:
            with mock.patch.object(intake, 'input_file', side_effect=copy_failure), \
                 mock.patch.object(intake, 'relative_parent', side_effect=parent_failure), \
                 mock.patch.object(intake.shutil, 'rmtree', wraps=shutil.rmtree) as remove:
                with self.assertRaisesRegex(intake.Refusal, '^original copy failure$'):
                    intake.rehydrate_packet(validated, destination)
                remove.assert_called_once()
            self.assertFalse(destination.exists())

    def test_mapped_leaf_directory_collision_refuses_before_output(self):
        self.fixture.write()
        destination = self.root / 'output'
        real_name = intake.output_name
        def colliding_name(name, layout):
            return 'sdk' if name == 'inputs.json' else real_name(name, layout)
        with self.fixture.validate() as validated:
            with mock.patch.object(intake, 'output_name', side_effect=colliding_name):
                with self.assertRaisesRegex(intake.Refusal, 'layout leaf/directory collision'):
                    intake.rehydrate_packet(validated, destination, layout='siblings')
            self.assertFalse(destination.exists())

    def test_validation_cleanup_on_late_refusal(self):
        self.fixture.write(missing='receipt.json')
        real_create = tempfile.TemporaryDirectory
        created = []
        def create(*args, **kwargs):
            value = real_create(*args, **kwargs)
            created.append(Path(value.name))
            return value
        with mock.patch.object(intake.tempfile, 'TemporaryDirectory', side_effect=create):
            self.assert_refused()
        self.assertTrue(created)
        self.assertTrue(all(not p.exists() for p in created))

    def test_closed_handle(self):
        self.fixture.write()
        validated = self.fixture.validate()
        validated.close()
        with self.assertRaises(intake.Refusal):
            intake.rehydrate_packet(validated, self.root / 'output')

    def test_explicit_root_refusal(self):
        self.fixture.write()
        with mock.patch.object(intake.os, 'geteuid', return_value=0):
            self.assert_refused()


if __name__ == '__main__':
    unittest.main()
