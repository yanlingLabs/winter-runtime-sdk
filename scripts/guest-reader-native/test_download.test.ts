import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, readFileSync, rmSync, existsSync, statSync, openSync, renameSync, mkdirSync, symlinkSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { download, FIXED, storageLocation, heldLeaf } = createRequire(import.meta.url)('./download.cjs');

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(options: any = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'winter-download-source-'))); roots.push(root);
  const body = Buffer.from('synthetic ZIP DATA');
  const pins = { ...FIXED, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') };
  const run = { id: pins.runId, head_sha: pins.head, status: 'completed', conclusion: 'success',
    repository: { id: pins.repositoryId }, head_repository: { id: pins.repositoryId } };
  const artifact = { id: pins.artifactId, name: pins.name, size_in_bytes: pins.bytes,
    expired: false, expires_at: pins.expiresAt, workflow_run: { id: pins.runId,
      repository_id: pins.repositoryId, head_repository_id: pins.repositoryId, head_sha: pins.head } };
  const calls: any[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.startsWith('https://api.github.com/')) {
      expect(init.redirect).toBe('manual');
      expect(init.headers.authorization).toBe('Bearer TOKEN-CANARY');
      if (url.endsWith('/zip')) return new Response(null, { status: options.redirectStatus ?? 302,
        headers: { location: options.location ?? 'https://fixture.blob.core.windows.net/packet?sig=URL-CANARY' } });
      return Response.json(url.includes('/runs/') ? (options.run ?? run) : (options.artifact ?? artifact));
    }
    expect(init.headers).toEqual({}); expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
    return new Response(options.body ?? body, { status: options.storageStatus ?? 200,
      headers: options.storageHeaders ?? {} });
  };
  // Like the action's bundled client, this intentionally ignores request.redirect.
  const github = { async request(route: string, options: any) {
    const response = await options.request.fetch(`https://api.github.com${route.slice(4)}`, {
      method: 'GET', headers: { authorization: 'Bearer TOKEN-CANARY' }, signal: options.request.signal,
    });
    return { status: response.status, headers: Object.fromEntries(response.headers),
      data: options.request.parseSuccessResponseBody === false ? response.body : await response.json() };
  } };
  const destination = join(root, 'download');
  const args = { github, context: { repo: { owner: pins.owner, repo: pins.repo } }, destination,
    pins, fetchImpl, now: () => Date.parse('2026-10-14T00:00:00Z'),
    // Production uses Linux heldLeaf. Darwin source tests use a trusted temporary
    // DATA seam; it cannot attest descriptor-relative creation on Linux.
    ...(process.platform === 'linux' ? {} : { openLeaf: (_dir: number, name: string) => openSync(join(destination, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }),
  };
  return { root, body, pins, run, artifact, calls, destination, args };
}

test('manual authenticated redirect and independent unauthenticated bounded ZIP DATA', async () => {
  const f = fixture(); const result = await download(f.args);
  expect(f.calls).toHaveLength(4);
  expect(result.outerZipBytes).toBe(f.body.length); expect(result.outerZipSha256).toBe(f.pins.sha256);
  expect(readFileSync(result.archivePath)).toEqual(f.body);
  expect(statSync(result.archivePath).mode & 0o777).toBe(0o600);
  expect(statSync(f.destination).mode & 0o777).toBe(0o700);
  for (const key of ['tokenForwardedToStorage', 'artifactCodeImported', 'outputsExecuted', 'nativeExecution', 'executionAdmission']) expect(result[key]).toBe(false);
  expect(JSON.stringify(result)).not.toContain('TOKEN-CANARY'); expect(JSON.stringify(result)).not.toContain('URL-CANARY');
});

test('repository and expired metadata refuse before any output', async () => {
  const f = fixture();
  await expect(download({ ...f.args, context: { repo: { owner: 'foreign', repo: f.pins.repo } } })).rejects.toThrow('repository_refused');
  expect(f.calls).toHaveLength(0); expect(existsSync(f.destination)).toBe(false);
  await expect(download({ ...f.args, now: () => Date.parse(f.pins.expiresAt) })).rejects.toThrow('artifact_expired');
  expect(existsSync(f.destination)).toBe(false);
});

test('all pinned run and artifact relationships reject independently', async () => {
  for (const patch of [{ id: 1 }, { head_sha: 'f'.repeat(40) }, { status: 'in_progress' }, { conclusion: 'failure' }, { repository: { id: 1 } }, { head_repository: { id: 1 } }]) {
    const f = fixture(); f.args.fetchImpl = fixture({ run: { ...f.run, ...patch } }).args.fetchImpl;
    await expect(download(f.args)).rejects.toThrow('run_identity_refused'); expect(existsSync(f.destination)).toBe(false);
  }
  for (const patch of [{ id: 1 }, { name: 'other' }, { size_in_bytes: 1 }, { expired: true }, { expires_at: '2027-01-01T00:00:00Z' }, { workflow_run: { id: 1 } }]) {
    const f = fixture(); f.args.fetchImpl = fixture({ artifact: { ...f.artifact, ...patch } }).args.fetchImpl;
    await expect(download(f.args)).rejects.toThrow('artifact_identity_refused'); expect(existsSync(f.destination)).toBe(false);
  }
});

test('storage destinations, redirect responses and unsafe encoding never produce an admitted file', async () => {
  for (const url of ['http://fixture.blob.core.windows.net/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://user:password@fixture.blob.core.windows.net/x', 'https://fixture.blob.core.windows.net:444/x', 'https://fixture.blob.core.windows.net/x#fragment']) {
    expect(() => storageLocation(url)).toThrow('storage_location_refused');
  }
  for (const options of [{ redirectStatus: 200 }, { storageStatus: 302 }, { storageHeaders: { 'content-encoding': 'gzip' } }, { storageHeaders: { 'content-length': '999' } }]) {
    const f = fixture(options); await expect(download(f.args)).rejects.toThrow(); expect(existsSync(f.destination)).toBe(false);
  }
});

test('overflow, short data and wrong digest never return a valid acquisition', async () => {
  for (const body of [Buffer.from('short'), Buffer.from('x'.repeat(100)), Buffer.from('z'.repeat(18))]) {
    const f = fixture({ body }); await expect(download(f.args)).rejects.toThrow();
  }
});

test('timeout bounds a dependency that ignores abort, without leaking its diagnostics', async () => {
  const f = fixture();
  await expect(download({ ...f.args, timeoutMs: 5, github: { request: () => new Promise(() => {}) } })).rejects.toThrow('download_deadline');
  await expect(download({ ...f.args, github: { request() { throw new Error('TOKEN-CANARY URL-CANARY'); } } })).rejects.toThrow('download_unavailable');
  expect(existsSync(f.destination)).toBe(false);
});

test('monotonic expiry refuses a synchronous dependency delay before timers can run', async () => {
  const f = fixture(); let time = 0;
  const fetchImpl = async (url: string, init: any) => {
    const result = await f.args.fetchImpl(url, init);
    if (!url.startsWith('https://api.github.com/')) time = 20;
    return result;
  };
  await expect(download({ ...f.args, fetchImpl, timeoutMs: 10, monotonic: () => time })).rejects.toThrow('download_deadline');
  expect(existsSync(f.destination)).toBe(false);
});

test('a folder swap cannot redirect the held-directory write into the replacement', async () => {
  const f = fixture(), original = join(f.root, 'original'), outside = join(f.root, 'outside');
  mkdirSync(outside, { mode: 0o700 });
  const openLeaf = (dir: number, name: string) => {
    renameSync(f.destination, original); symlinkSync(outside, f.destination);
    return process.platform === 'linux' ? heldLeaf(dir, name)
      : openSync(join(original, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  };
  await expect(download({ ...f.args, openLeaf })).rejects.toThrow('destination_identity_refused');
  expect(existsSync(join(outside, 'artifact.zip'))).toBe(false);
  expect(readFileSync(join(original, 'artifact.zip'))).toEqual(f.body);
});

test('a dependency that advances time and rejects cannot produce an unhandled raw diagnostic', async () => {
  const f = fixture(); let time = 0;
  const unhandled: unknown[] = [];
  const listener = (value: unknown) => { unhandled.push(value); };
  process.on('unhandledRejection', listener);
  try {
    await expect(download({ ...f.args, timeoutMs: 10, monotonic: () => time,
      github: { async request() { time = 20; throw new Error('SYNTHETIC-TOKEN-CANARY'); } },
    })).rejects.toThrow('download_unavailable');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(unhandled).toEqual([]);
    expect(existsSync(f.destination)).toBe(false);
  } finally { process.removeListener('unhandledRejection', listener); }
});
