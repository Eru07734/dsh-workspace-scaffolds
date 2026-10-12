/**
 * Local package warehouse: turn a directory or tarball into a content-addressed
 * snapshot, and read back the identity of a stored snapshot without unpacking it
 * into a profile.
 * @module dsh-workspace-scaffolds/archive
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, CODES } from './errors.js';
import { inspectTarball, packDirectory } from './tar.js';
import { isNonEmptyString, isPlainObject } from './schema.js';
import { pathExists, sha256Hex, writeFileAtomic } from './util.js';

/**
 * @param {import('./store.js').Store} store
 * @param {string} sha256
 * @returns {string} Absolute path of the stored snapshot.
 */
export function archivePath(store, sha256) {
  return join(store.archiveDir, `${sha256}.tgz`);
}

/**
 * Validate the package manifest of a candidate scaffold.
 * @param {any} manifest
 * @param {string} origin Human-readable source for diagnostics.
 * @returns {{name: string, version: string, title: string|null}}
 */
export function verifyBundleManifest(manifest, origin) {
  if (!isPlainObject(manifest)) throw new Fault(CODES.notABundle, { origin, reason: 'manifest-not-object' });
  if (!isNonEmptyString(manifest.name)) throw new Fault(CODES.notABundle, { origin, reason: 'missing-name' });
  if (!isNonEmptyString(manifest.version)) throw new Fault(CODES.notABundle, { origin, reason: 'missing-version' });
  const bundle = isPlainObject(manifest.dsh) ? manifest.dsh.bundle : undefined;
  if (!isPlainObject(bundle) && !(typeof bundle === 'string' && bundle.length > 0)) {
    throw new Fault(CODES.notABundle, { origin, name: manifest.name, reason: 'no-dsh-bundle' });
  }
  return {
    name: manifest.name,
    version: manifest.version,
    title: typeof manifest.description === 'string' && manifest.description.length > 0 ? manifest.description : null,
  };
}

/**
 * Extract `package.json` from an inspected tarball.
 * @param {Buffer} buffer
 * @param {{tarBuffer: Buffer, entries: Array<{path: string, kind: string, size: number}>}} inspected
 * @returns {any}
 */
function manifestOf(buffer, inspected) {
  void buffer;
  const { tarBuffer, entries } = inspected;
  let offset = 0;
  for (const entry of entries) {
    const block = tarBuffer.subarray(offset, offset + 512);
    const size = Number.parseInt(block.toString('latin1', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const payload = tarBuffer.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (entry.kind === 'file' && (entry.path === 'package/package.json' || entry.path === 'package.json')) {
      try {
        return JSON.parse(payload.toString('utf8'));
      } catch {
        throw new Fault(CODES.notABundle, { origin: entry.path, reason: 'package-json-malformed' });
      }
    }
  }
  throw new Fault(CODES.notABundle, { reason: 'package-json-absent' });
}

/**
 * Inspect a tarball, prove it is a DSH bundle, and store it under its hash.
 * @param {import('./store.js').Store} store
 * @param {Buffer} buffer
 * @param {string} origin
 * @returns {Promise<{archiveSha256: string, name: string, version: string, title: string|null, entryCount: number, bytes: number}>}
 */
export async function ingestTarball(store, buffer, origin) {
  const inspected = inspectTarball(buffer);
  const manifest = manifestOf(buffer, inspected);
  const identity = verifyBundleManifest(manifest, origin);
  const digest = sha256Hex(buffer);
  const destination = archivePath(store, digest);
  if (!(await pathExists(destination))) {
    await writeFileAtomic(destination, buffer);
  }
  return {
    archiveSha256: digest,
    name: identity.name,
    version: identity.version,
    title: identity.title,
    entryCount: inspected.entries.length,
    bytes: buffer.length,
  };
}

/**
 * Read an existing archive and re-derive its identity.
 * @param {import('./store.js').Store} store
 * @param {string} sha256
 * @returns {Promise<{archiveSha256: string, name: string, version: string, title: string|null, entryCount: number, bytes: number}>}
 */
export async function readArchive(store, sha256) {
  const filePath = archivePath(store, sha256);
  if (!(await pathExists(filePath))) {
    throw new Fault(CODES.archiveInvalid, { reason: 'archive-absent', archiveSha256: sha256 });
  }
  const buffer = await readFile(filePath);
  const actual = sha256Hex(buffer);
  if (actual !== sha256) {
    throw new Fault(CODES.archiveInvalid, { reason: 'archive-hash-mismatch', expected: sha256, actual });
  }
  return await ingestTarball(store, buffer, filePath);
}

/**
 * Import either an already-packed `.tgz` or a package directory.
 * A directory is packed here rather than through the package manager, so the
 * import has no network or pnpm dependency and produces a byte-stable snapshot.
 * @param {import('./store.js').Store} store
 * @param {string} sourcePath
 * @returns {Promise<object>}
 */
export async function importFromPath(store, sourcePath) {
  const info = await (await import('node:fs/promises')).stat(sourcePath).catch(() => null);
  if (info === null) throw new Fault(CODES.archiveInvalid, { reason: 'source-absent', path: sourcePath });
  if (info.isDirectory()) {
    const manifest = JSON.parse(await readFile(join(sourcePath, 'package.json'), 'utf8').catch(() => {
      throw new Fault(CODES.notABundle, { origin: sourcePath, reason: 'package-json-absent' });
    }));
    verifyBundleManifest(manifest, sourcePath);
    const packed = await packDirectory(sourcePath);
    const result = await ingestTarball(store, packed.buffer, sourcePath);
    return { ...result, sourceKind: 'local-directory', sourcePath };
  }
  if (!info.isFile()) throw new Fault(CODES.archiveInvalid, { reason: 'source-not-file', path: sourcePath });
  const buffer = await readFile(sourcePath);
  const result = await ingestTarball(store, buffer, sourcePath);
  return { ...result, sourceKind: 'tarball', sourcePath };
}
