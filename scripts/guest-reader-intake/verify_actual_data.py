"""Retain actual packet DATA verification; never execute/import captured code."""
import argparse
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

import intake


def clean(path):
    if not path.exists():
        return
    for root, _, _ in os.walk(path, followlinks=False):
        os.chmod(root, 0o700)
    shutil.rmtree(path)


def verify(archive, inventory):
    evidence = {'kind': 'winter-reader-actual-data-check', 'layouts': {},
                'outputsExecuted': False, 'nativeAdmission': False,
                'authorityGranted': False, 'profileActivation': False,
                'activationEnabled': False, 'vmExecutionVerified': False}
    with intake.validate_packet(archive, inventory) as validated:
        spool = Path(validated._temporary.name)
        pin = validated._pin
        evidence.update({k: pin[k] for k in ('archiveSha256', 'inventorySha256', 'receiptSha256',
                                            'fileCount', 'fileBytes', 'origins')})
        for layout in ('packet', 'siblings'):
            temporary = tempfile.TemporaryDirectory(prefix='winter-reader-data-check-',
                                                     dir=Path(tempfile.gettempdir()).resolve())
            parent = Path(temporary.name)
            output = parent / 'packet'
            try:
                receipt = intake.rehydrate_packet(validated, output, layout=layout)
                files = 0
                aliases = 0
                total = 0
                dirs = 0
                for name, leaf in validated._inventory['files'].items():
                    target = output / receipt['files'][name]
                    if leaf['kind'] == 'file':
                        with intake.input_file(target, intake.MAX_LEAF) as (stream, identity):
                            intake.require(stat.S_IMODE(identity.st_mode) == 0o400, 'output mode')
                            digest = intake.hashlib.sha256()
                            count = 0
                            while chunk := stream.read(intake.CHUNK):
                                digest.update(chunk)
                                count += len(chunk)
                        intake.require(digest.hexdigest() == leaf['sha256'] and count == leaf['bytes'],
                                       'actual copied content')
                        files += 1
                        total += count
                    else:
                        intake.require(target.is_symlink(), 'actual copied alias')
                        expected = output / intake.output_name(validated._aliases[name], layout)
                        intake.require(target.resolve() == expected.resolve() and
                                       target.resolve().is_relative_to(output), 'actual copied alias target')
                        aliases += 1
                for root, _, _ in os.walk(output, followlinks=False):
                    intake.require(stat.S_IMODE(Path(root).stat().st_mode) == 0o500, 'actual directory mode')
                    dirs += 1
                evidence['layouts'][layout] = {'regularFiles': files, 'aliases': aliases, 'directories': dirs,
                                               'bodyBytes': total, 'regularMode': '0400', 'directoryMode': '0500',
                                               'allHashesVerified': True, 'allAliasTargetsCaptured': True}
            finally:
                clean(output)
                temporary.cleanup()
    intake.require(not spool.exists(), 'actual private spool cleanup')
    evidence['privateSpoolRemoved'] = True
    evidence['materializedDataRemoved'] = True
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.inventory), sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
