'use strict';
// Ordinary token-bearing acquisition only. No captured imports, extraction or
// native execution. The caller's GitHub client holds its action input token;
// this module never accepts, exports, stores or logs credential material.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const FIXED = Object.freeze({
  owner: 'yanlingLabs', repo: 'winter-runtime-sdk', repositoryId: 1358618589,
  runId: 38502659264, head: '29fe5cff1ea0b93d7970cfee566030f3532fdd74',
  artifactId: 11866353126, name: 'reader-compile-packet-38502659264',
  bytes: 81095921, sha256: 'bd586bafdcffeca4c4fbdfcdd65b4f8b807b2ff2b7ba8adfebbacf067874dfcd',
  expiresAt: '2026-10-21T02:45:33Z',
});
const TIMEOUT_MS = 120_000;
class DownloadRefusal extends Error {
  constructor(code) { super(code); this.name = 'DownloadRefusal'; }
}
function need(value, code) { if (!value) throw new DownloadRefusal(code); }
function identity(info) { return [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink]; }
function same(left, right) { return JSON.stringify(identity(left)) === JSON.stringify(identity(right)); }
function sameDirectory(left, right) { return JSON.stringify(identity(left).slice(0, 5)) === JSON.stringify(identity(right).slice(0, 5)); }
function heldLeaf(dir, name) {
  need(process.platform === 'linux' && name === 'artifact.zip', 'held_directory_platform_refused');
  return fs.openSync(`/proc/self/fd/${dir}/${name}`, fs.constants.O_WRONLY
    | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
}

function verifyMetadata(run, artifact, pins, time) {
  need(Number.isSafeInteger(time) && time < Date.parse(pins.expiresAt), 'artifact_expired');
  need(run && run.id === pins.runId && run.head_sha === pins.head && run.status === 'completed'
    && run.conclusion === 'success' && run.repository?.id === pins.repositoryId
    && run.head_repository?.id === pins.repositoryId, 'run_identity_refused');
  need(artifact && artifact.id === pins.artifactId && artifact.name === pins.name
    && artifact.size_in_bytes === pins.bytes && artifact.expired === false
    && artifact.expires_at === pins.expiresAt && artifact.workflow_run?.id === pins.runId
    && artifact.workflow_run?.repository_id === pins.repositoryId
    && artifact.workflow_run?.head_repository_id === pins.repositoryId
    && artifact.workflow_run?.head_sha === pins.head, 'artifact_identity_refused');
  return Object.freeze({ repository_id: pins.repositoryId, run_id: pins.runId,
    head_sha: pins.head, artifact_id: pins.artifactId, artifact_name: pins.name,
    size_in_bytes: pins.bytes, expired: false, expires_at: pins.expiresAt });
}

function storageLocation(value) {
  need(typeof value === 'string' && value.length <= 8192, 'storage_location_refused');
  let url;
  try { url = new URL(value); } catch { throw new DownloadRefusal('storage_location_refused'); }
  need(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port,
    'storage_location_refused');
  // Only GitHub artifact storage, never a loopback/LAN or arbitrary redirect.
  need(url.hostname.endsWith('.blob.core.windows.net')
    || url.hostname.endsWith('.actions.githubusercontent.com'), 'storage_location_refused');
  return url.href;
}

function freshDestination(destination) {
  need(typeof destination === 'string' && path.isAbsolute(destination)
    && destination === path.normalize(destination) && !destination.includes('\0'), 'destination_refused');
  const parent = path.dirname(destination);
  need(fs.realpathSync(parent) === parent, 'destination_ancestry_refused');
  const before = fs.lstatSync(parent);
  need(before.isDirectory() && before.uid === process.getuid() && (before.mode & 0o077) === 0,
    'destination_parent_refused');
  fs.mkdirSync(destination, { mode: 0o700 });
  const dir = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const created = fs.fstatSync(dir);
    need(created.uid === process.getuid() && (created.mode & 0o777) === 0o700, 'destination_owner_refused');
    return { parent, before, destination, dir, created };
  } catch (error) { fs.closeSync(dir); throw error; }
}

async function download({ github, context, destination, fetchImpl = globalThis.fetch, now = Date.now, pins = FIXED, timeoutMs = TIMEOUT_MS,
  monotonic = () => Number(process.hrtime.bigint() / 1_000_000n), openLeaf = heldLeaf }) {
  let directory, file, reader, response;
  const controller = new AbortController();
  need(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TIMEOUT_MS, 'download_deadline_refused');
  const started = monotonic();
  need(Number.isSafeInteger(started) && started >= 0, 'download_clock_refused');
  const checkDeadline = () => {
    const current = monotonic();
    need(Number.isSafeInteger(current) && current >= started && current - started < timeoutMs
      && !controller.signal.aborted, 'download_deadline');
  };
  const deadline = new Promise((_, reject) => controller.signal.addEventListener('abort',
    () => reject(new DownloadRefusal('download_deadline')), { once: true }));
  void deadline.catch(() => {});
  const within = async task => {
    checkDeadline();
    // Attach race rejection handlers BEFORE a dependency runs, including one
    // that changes the clock and rejects synchronously or in an immediate task.
    const value = await Promise.race([Promise.resolve().then(task), deadline]);
    checkDeadline(); return value;
  };
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    need(github && typeof github.request === 'function' && typeof fetchImpl === 'function'
      && typeof now === 'function', 'download_dependencies_refused');
    need(context?.repo?.owner?.toLowerCase() === pins.owner.toLowerCase()
      && context.repo.repo === pins.repo, 'repository_refused');
    const route = `/repos/${pins.owner}/${pins.repo}/actions/`;
    const apiBase = `https://api.github.com${route}`;
    // github-script v7's bundled Octokit does NOT forward request.redirect.
    // Its per-request fetch hook forces manual redirects before auth-bearing IO.
    const apiFetch = async (url, options) => {
      need(typeof url === 'string' && [
        `${apiBase}runs/${pins.runId}`, `${apiBase}artifacts/${pins.artifactId}`,
        `${apiBase}artifacts/${pins.artifactId}/zip`,
      ].includes(url), 'api_destination_refused');
      return fetchImpl(url, { ...options, redirect: 'manual', signal: controller.signal });
    };
    const request = { fetch: apiFetch, signal: controller.signal };
    const run = await within(() => github.request(`GET ${route}runs/${pins.runId}`, { request }));
    const artifact = await within(() => github.request(`GET ${route}artifacts/${pins.artifactId}`, { request }));
    need(run.status === 200 && artifact.status === 200, 'metadata_status_refused');
    const metadata = verifyMetadata(run.data, artifact.data, pins, now());
    const redirect = await within(() => github.request(`GET ${route}artifacts/${pins.artifactId}/zip`, {
      request: { ...request, parseSuccessResponseBody: false },
    }));
    // Cancel the small API redirect body; never consume an auto-followed ZIP.
    if (redirect.data?.cancel) await within(() => redirect.data.cancel());
    need(redirect.status === 302, 'archive_redirect_refused');
    const location = storageLocation(redirect.headers?.location);
    verifyMetadata(run.data, artifact.data, pins, now());
    response = await within(() => fetchImpl(location, { method: 'GET', headers: {}, credentials: 'omit',
      redirect: 'error', signal: controller.signal }));
    need(response.status === 200 && response.redirected !== true, 'archive_status_refused');
    const length = response.headers.get('content-length');
    need(length === null || length === String(pins.bytes), 'archive_length_refused');
    const encoding = response.headers.get('content-encoding');
    need(encoding === null || encoding === 'identity', 'archive_encoding_refused');
    need(response.body && typeof response.body.getReader === 'function', 'archive_body_refused');
    reader = response.body.getReader();
    checkDeadline(); directory = freshDestination(destination); checkDeadline();
    const archivePath = path.join(destination, 'artifact.zip');
    // Linux descriptor-relative creation survives any replacement of the name.
    // openLeaf is a trusted DATA-test seam, never an authority factory.
    file = openLeaf(directory.dir, 'artifact.zip'); checkDeadline();
    const digest = createHash('sha256');
    let bytes = 0;
    for (;;) {
      checkDeadline();
      const chunk = await within(() => reader.read());
      if (chunk.done) break;
      need(chunk.value instanceof Uint8Array && chunk.value.length > 0, 'archive_chunk_refused');
      bytes += chunk.value.length;
      need(bytes <= pins.bytes, 'archive_size_refused');
      digest.update(chunk.value);
      let at = 0;
      while (at < chunk.value.length) {
        checkDeadline();
        const written = fs.writeSync(file, chunk.value, at, chunk.value.length - at);
        need(written > 0, 'archive_write_refused'); at += written;
      }
    }
    need(bytes === pins.bytes && digest.digest('hex') === pins.sha256, 'archive_hash_refused');
    verifyMetadata(run.data, artifact.data, pins, now());
    fs.fsyncSync(file); fs.fchmodSync(file, 0o600);
    need(sameDirectory(directory.created, fs.lstatSync(destination))
      && sameDirectory(directory.before, fs.lstatSync(directory.parent)), 'destination_identity_refused');
    const info = fs.fstatSync(file);
    need(info.isFile() && info.nlink === 1 && info.uid === process.getuid()
      && (info.mode & 0o777) === 0o600 && info.size === pins.bytes
      && same(info, fs.lstatSync(archivePath)), 'archive_identity_refused');
    checkDeadline(); fs.closeSync(file); file = undefined; checkDeadline();
    return Object.freeze({ metadata, archivePath, outerZipBytes: bytes, outerZipSha256: pins.sha256,
      tokenForwardedToStorage: false, artifactCodeImported: false, outputsExecuted: false,
      nativeExecution: false, executionAdmission: false });
  } catch (error) {
    // A private partial file may remain for diagnostics, never returned as valid.
    throw new DownloadRefusal(error instanceof DownloadRefusal ? error.message : 'download_unavailable');
  } finally {
    clearTimeout(timer); controller.abort();
    if (reader) { try { void reader.cancel().catch(() => {}); } catch {} try { reader.releaseLock(); } catch {} }
    else if (response?.body?.cancel) { try { void response.body.cancel().catch(() => {}); } catch {} }
    if (file !== undefined) fs.closeSync(file);
    if (directory) fs.closeSync(directory.dir);
  }
}

module.exports = { download, FIXED, DownloadRefusal, verifyMetadata, storageLocation, heldLeaf };
