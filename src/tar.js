/**
 * Minimal USTAR reader/writer used to snapshot a scaffold package directory and
 * to inspect an imported tarball before it is trusted.
 *
 * A private implementation is deliberate: the plugin must work with no third
 * party dependency, and every entry that enters a profile passes the same
 * safety checks here.
 * @module dsh-workspace-scaffolds/tar
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';
import { Fault, CODES } from './errors.js';

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const MAX_ENTRIES = 10_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Directories never included in a scaffold snapshot. */
const EXCLUDED_SEGMENTS = new Set(['node_modules', '.git', '.svn', '.hg']);

/**
 * @param {number} value @param {number} length
 * @returns {Buffer} Octal field, NUL-terminated.
 */
function octal(value, length) {
  const text = value.toString(8).padStart(length - 1, '0');
  return Buffer.from(`${text}\0`, 'latin1');
}

/**
 * Split a POSIX relative path into USTAR name/prefix fields.
 * @param {string} relativePath
 * @returns {{name: string, prefix: string}}
 */
function splitName(relativePath) {
  if (Buffer.byteLength(relativePath, 'utf8') <= NAME_MAX) return { name: relativePath, prefix: '' };
  const segments = relativePath.split('/');
  let prefix = '';
  while (segments.length > 1) {
    const candidate = segments.slice(0, -1).join('/');
    const name = segments.at(-1);
    if (Buffer.byteLength(candidate, 'utf8') <= PREFIX_MAX && Buffer.byteLength(name, 'utf8') <= NAME_MAX) {
      prefix = candidate;
      return { name, prefix };
    }
    segments.pop();
  }
  void prefix;
  throw new Fault(CODES.archiveInvalid, { reason: 'path-too-long', path: relativePath });
}

/**
 * Build one USTAR header block.
 * @param {{name: string, prefix: string, size: number, mode: number, mtime: number, type: string}} entry
 * @returns {Buffer}
 */
function header(entry) {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(entry.name, 0, NAME_MAX, 'utf8');
  octal(entry.mode, 8).copy(block, 100);
  octal(0, 8).copy(block, 108);
  octal(0, 8).copy(block, 116);
  octal(entry.size, 12).copy(block, 124);
  octal(entry.mtime, 12).copy(block, 136);
  block.write('        ', 148, 8, 'latin1');
  block.write(entry.type, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  block.write('root', 265, 32, 'latin1');
  block.write('root', 297, 32, 'latin1');
  octal(0, 8).copy(block, 329);
  octal(0, 8).copy(block, 337);
  block.write(entry.prefix, 345, PREFIX_MAX, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  block.write('\0 ', 154, 2, 'latin1');
  return block;
}

/**
 * Walk a directory into archive entries, skipping excluded segments and never
 * following symbolic links.
 * @param {string} root
 * @param {string} relativePath
 * @param {Array<{path: string, relative: string, kind: 'file'|'directory', mode: number, mtime: number, size: number}>} out
 */
async function walk(root, relativePath, out) {
  const absolute = relativePath === '' ? root : join(root, relativePath);
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (EXCLUDED_SEGMENTS.has(entry.name)) continue;
    const relative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`;
    const child = join(root, ...relative.split('/'));
    const info = await stat(child);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      out.push({ path: child, relative, kind: 'directory', mode: 0o755, mtime: Math.floor(info.mtimeMs / 1000), size: 0 });
      await walk(root, relative, out);
      continue;
    }
    if (!info.isFile()) continue;
    out.push({ path: child, relative, kind: 'file', mode: 0o644, mtime: Math.floor(info.mtimeMs / 1000), size: info.size });
  }
}

/** Prefix every entry with this segment, matching npm's pack layout so the
 * resulting tarball can be handed straight to a package manager. */
const PACK_PREFIX = 'package';

/**
 * Package a directory as a gzipped USTAR tarball whose entries live under
 * `package/`, the layout `npm pack` produces.
 * @param {string} directory
 * @returns {Promise<{buffer: Buffer, entryCount: number, bytes: number}>}
 */
export async function packDirectory(directory) {
  const collected = [];
  await walk(directory, '', collected);
  if (collected.length > MAX_ENTRIES) {
    throw new Fault(CODES.archiveInvalid, { reason: 'too-many-entries', count: collected.length, limit: MAX_ENTRIES });
  }
  const chunks = [];
  let total = 0;
  // The synthetic `package/` entry takes its timestamp from the packed
  // directory, never from the clock. Reading the clock here would make the
  // archive hash depend on *when* the pack ran, so packing one unchanged
  // directory across a second boundary would produce two different hashes and
  // a legitimate re-import would be rejected as a content conflict.
  const rootInfo = await stat(directory);
  chunks.push(
    header({
      ...splitName(`${PACK_PREFIX}/`),
      size: 0,
      mode: 0o755,
      mtime: Math.floor(rootInfo.mtimeMs / 1000),
      type: '5',
    }),
  );
  for (const entry of collected) {
    if (entry.kind === 'directory') {
      const { name, prefix } = splitName(`${PACK_PREFIX}/${entry.relative}/`);
      chunks.push(header({ name, prefix, size: 0, mode: entry.mode, mtime: entry.mtime, type: '5' }));
      continue;
    }
    const bytes = await readFile(entry.path);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) {
      throw new Fault(CODES.archiveInvalid, { reason: 'too-large', bytes: total, limit: MAX_TOTAL_BYTES });
    }
    const { name, prefix } = splitName(`${PACK_PREFIX}/${entry.relative}`);
    chunks.push(header({ name, prefix, size: bytes.length, mode: entry.mode, mtime: entry.mtime, type: '0' }));
    chunks.push(bytes);
    const padding = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  return { buffer: gzipSync(tar, { level: 9 }), entryCount: collected.length, bytes: total };
}

/**
 * @param {Buffer} buffer @param {number} offset @param {number} length
 * @returns {number} Parsed octal field.
 */
function readOctal(buffer, offset, length) {
  const text = buffer.toString('latin1', offset, offset + length).replace(/\0.*$/, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * Parse a tarball's entries and enforce the safety contract. Nothing is written
 * to disk here; this is the gate every imported archive must pass.
 * @param {Buffer} buffer Gzipped or plain tar bytes.
 * @returns {{entries: Array<{path: string, kind: string, size: number}>, totalBytes: number, tarBuffer: Buffer}}
 */
export function inspectTarball(buffer) {
  let tar = buffer;
  try {
    tar = gunzipSync(buffer);
  } catch {
    // Already-uncompressed tar input is accepted; gzip failure is not fatal here.
  }
  const entries = [];
  let offset = 0;
  let totalBytes = 0;
  while (offset + BLOCK <= tar.length) {
    const block = tar.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const size = readOctal(block, 124, 12);
    const typeflag = block.toString('latin1', 156, 157);
    const prefix = block.toString('latin1', 345, 345 + PREFIX_MAX).replace(/\0.*$/, '');
    const name = block.toString('latin1', 0, NAME_MAX).replace(/\0.*$/, '');
    const full = prefix === '' ? name : `${prefix}/${name}`;
    const payload = offset + BLOCK;
    const next = payload + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === '1' || typeflag === '2') {
      throw new Fault(CODES.archiveInvalid, { reason: 'link-entry', path: full });
    }
    if (!['0', '\0', '5', '7'].includes(typeflag)) {
      throw new Fault(CODES.archiveInvalid, { reason: 'unsupported-entry-type', path: full, typeflag });
    }
    const normalized = full.replace(/\/+$/, '');
    if (
      normalized.length === 0 ||
      normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized) ||
      normalized.split('/').some((segment) => segment === '..')
    ) {
      throw new Fault(CODES.archiveInvalid, { reason: 'unsafe-path', path: full });
    }
    const kind = typeflag === '5' || full.endsWith('/') ? 'directory' : 'file';
    if (kind === 'file') totalBytes += size;
    entries.push({ path: normalized, kind, size });
    if (entries.length > MAX_ENTRIES) {
      throw new Fault(CODES.archiveInvalid, { reason: 'too-many-entries', limit: MAX_ENTRIES });
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Fault(CODES.archiveInvalid, { reason: 'too-large', limit: MAX_TOTAL_BYTES });
    }
    offset = next;
  }
  const seen = new Set();
  for (const entry of entries) {
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (seen.has(key)) {
      throw new Fault(CODES.archiveInvalid, { reason: 'duplicate-path', path: entry.path });
    }
    seen.add(key);
  }
  return { entries, totalBytes, tarBuffer: tar };
}

/**
 * Extract a validated tarball into a directory.
 * @param {Buffer} buffer
 * @param {string} targetDirectory
 * @param {(path: string, kind: string) => string} resolveTarget Maps an entry to its absolute destination.
 * @param {{stripPackPrefix?: boolean}} [options] Drops the leading `package/`
 *   segment (default) so extraction reproduces the packed directory itself.
 * @returns {Promise<{files: string[], entries: number}>}
 */
export async function extractTarball(buffer, targetDirectory, resolveTarget, options = {}) {
  const strip = options.stripPackPrefix !== false;
  const { entries, tarBuffer } = inspectTarball(buffer);
  const { mkdir, writeFile } = await import('node:fs/promises');
  const files = [];
  let offset = 0;
  for (const entry of entries) {
    const block = tarBuffer.subarray(offset, offset + BLOCK);
    const size = readOctal(block, 124, 12);
    const payload = tarBuffer.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    const entryPath = strip && entry.path.startsWith(`${PACK_PREFIX}/`) ? entry.path.slice(PACK_PREFIX.length + 1) : entry.path;
    if (entryPath.length === 0) continue;
    const destination = resolveTarget(entryPath, entry.kind);
    if (entry.kind === 'directory') {
      await mkdir(destination, { recursive: true });
      continue;
    }
    await mkdir(join(destination, '..'), { recursive: true });
    await writeFile(destination, payload);
    files.push(destination);
  }
  void targetDirectory;
  return { files, entries: entries.length };
}

/**
 * @param {string} relativePath
 * @returns {string} The same path in POSIX spelling.
 */
export function toPosix(relativePath) {
  return relativePath.split(sep).join(posix.sep);
}
