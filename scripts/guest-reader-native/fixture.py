"""Fixed reader fixture DATA and result oracle; neither grants native admission."""
import hashlib
import json
import os
from pathlib import Path
import stat

SOURCE = '/workspace/folders/source'
SHARED = '/run/winter/shared-instructions'
CONTENTS = {'source': b'fixture source guidance\n', 'shared': b'fixture shared guidance\n'}


def require(value, reason):
    if not value:
        raise ValueError(reason)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


class Fixture:
    def __init__(self, path):
        self.path = Path(path)
        self.fds = {}
        self.files = {}

    def close(self):
        for fd in self.fds.values():
            os.close(fd)
        self.fds.clear()

    def recheck(self):
        for role, fd in self.fds.items():
            info = os.fstat(fd)
            require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o555,
                    'fixture directory seal changed')
            named = os.stat(self.path / role, follow_symlinks=False)
            require((named.st_dev, named.st_ino) == (info.st_dev, info.st_ino),
                    'fixture directory replaced')
        for (role, name), (identity, raw) in self.files.items():
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=self.fds[role])
            try:
                info = os.fstat(fd)
                require((info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
                         info.st_nlink) == identity, 'fixture file identity changed')
                require(os.read(fd, len(raw) + 1) == raw, 'fixture file bytes changed')
            finally:
                os.close(fd)


def create_fixture(path):
    """Unprivileged fixture preparation is DATA. Actual launcher checks Root scopes.

    Creates only a fresh directory and retains held source/shared descriptors.
    No successful deletion/cleanup claim; caller retains failed fixtures.
    """
    result = Fixture(path)
    os.mkdir(result.path, 0o700)
    try:
        for role in ('source', 'shared', 'hidden-store', 'hidden-home'):
            os.mkdir(result.path / role, 0o700)
            result.fds[role] = os.open(result.path / role,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            files = {'WINTER.md': CONTENTS[role]} if role in CONTENTS else {
                'canary': ('NEVER-READER-' + role + '\n').encode('ascii')}
            for name, raw in files.items():
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=result.fds[role])
                try:
                    require(os.write(fd, raw) == len(raw), 'fixture write incomplete')
                    os.fsync(fd)
                    os.fchmod(fd, 0o444)
                    info = os.fstat(fd)
                    identity = (info.st_dev, info.st_ino, info.st_uid, info.st_gid,
                                info.st_mode, info.st_nlink)
                    require(info.st_nlink == 1, 'independent fixture file required')
                    result.files[role, name] = (identity, raw)
                finally:
                    os.close(fd)
            os.fchmod(result.fds[role], 0o555)
        result.recheck()
        return result
    except BaseException:
        result.close()
        raise


def request():
    return {'version': 1, 'readId': '12345678-1234-4234-8234-123456789abc',
        'owner': {'logicalSessionId': 'reader-fixture-parent',
            'backendSessionId': 'reader-fixture-backend', 'generation': 1,
            'bootId': 'reader-fixture-boot', 'incarnationId': 'reader-fixture-incarnation',
            'leaseEpoch': 1},
        'views': {'sourceRoot': SOURCE, 'sourceCwd': SOURCE, 'sharedRoot': SHARED,
                  'sharedPath': SHARED + '/WINTER.md'},
        'limits': {'maxFileBytes': 131072, 'maxReadBytes': 262144,
                   'maxReadOccurrences': 256, 'maxExpandedBytes': 131072}}


def request_bytes():
    # Pinned RuntimeSDK0394 parseRequest requires JSON.stringify(parsed) ===
    # original text: compact literal UTF8, no LF; EOF terminates the request.
    return json.dumps(request(), separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def expected_snapshot():
    blocks, files, provenance = [], [], []
    for role, root, tier in (('shared', SHARED, 'workspace'), ('source', SOURCE, 'project')):
        text = CONTENTS[role].decode('ascii')
        path = root + '/WINTER.md'
        block = {'requestedPath': path, 'admittedPath': path, 'text': text,
                 'textSha256': digest(CONTENTS[role]), 'tier': tier}
        blocks.append(block)
        provenance.append(dict(block, depth=0))
        files.append({'path': path, 'tier': tier, 'sha256': digest(CONTENTS[role]),
                      'imported': False})
    text = '\n'.join('# ' + block['requestedPath'] + '\n\n' + block['text']
                     for block in blocks)
    return {'text': text, 'digest': digest(text.encode('ascii')), 'tiers': 'admitted-only',
            'files': files, 'blocks': blocks, 'provenance': provenance,
            'skippedLinks': [], 'droppedImports': []}


def verify_response(stdout, stderr):
    require(type(stdout) is bytes and 0 < len(stdout) <= 320 * 1024
            and stdout.endswith(b'\n') and stdout.count(b'\n') == 1,
            'one bounded reader frame required')
    require(stderr == b'', 'unexpected reader stderr')
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, 'duplicate reader key')
            result[key] = value
        return result
    response = json.loads(stdout.decode('utf-8', 'strict'), object_pairs_hook=pairs)
    expected = dict(request(), snapshot=expected_snapshot())
    # Exact bounded fixture, not a general schema accepting arbitrary guidance.
    require(type(response) is dict and
            json.dumps(response, sort_keys=True, allow_nan=False) ==
            json.dumps(expected, sort_keys=True, allow_nan=False),
            'reader fixture/correlation mismatch')
    require(b'NEVER-READER-' not in stdout, 'hidden canary leaked')
    return {'readerFrameVerified': True, 'guidanceSnapshotDigest': response['snapshot']['digest'],
            'configEffectProven': False, 'nativeAuthorityCreated': False,
            'perRootRaceAttributionProven': False, 'toolCanonicalAliasProven': False}
