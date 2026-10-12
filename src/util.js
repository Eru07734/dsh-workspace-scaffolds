/**
 * Filesystem, identity and serialization primitives with no DSH dependency, so
 * they stay unit-testable outside a running host.
 * @module dsh-workspace-scaffolds/util
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Fault, CODES } from './errors.js';

/** @returns {string} A fresh RFC 4122 v4 identifier. */
export function newId() {
  return randomUUID();
}

/** @returns {string} Current time as an ISO-8601 UTC timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {Buffer|string} value
 * @returns {string} Lowercase hexadecimal SHA-256 of `value`.
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** @param {string} filePath @returns {Promise<boolean>} */
export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonicalize an existing path, tolerating a missing tail so callers can
 * compare a stored workspace path with an observed directory.
 * @param {string} filePath
 * @returns {Promise<string>} Resolved absolute path; `realpath` when it exists.
 */
export async function canonicalize(filePath) {
  const absolute = resolve(filePath);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Whether `target` is `root` or sits inside it. Both sides are compared after
 * case-insensitive normalization on Windows and after resolving `..`.
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function pathInside(root, target) {
  const normalize = (value) => {
    const resolved = resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const base = normalize(root);
  const candidate = normalize(target);
  if (base === candidate) return true;
  const withSeparator = base.endsWith(sep) ? base : base + sep;
  return candidate.startsWith(withSeparator);
}

/**
 * Reject a path that escapes its root, is absolute, or names a Windows
 * alternate data stream. Used for every template target and archive entry.
 * @param {string} root
 * @param {string} relativeTarget
 * @returns {string} The resolved absolute target.
 */
export function resolveInside(root, relativeTarget) {
  if (typeof relativeTarget !== 'string' || relativeTarget.length === 0) {
    throw new Fault(CODES.pathOutsideWorkspace, { target: relativeTarget });
  }
  if (isAbsolute(relativeTarget)) {
    throw new Fault(CODES.pathOutsideWorkspace, { target: relativeTarget });
  }
  if (relativeTarget.includes('\0')) {
    throw new Fault(CODES.pathOutsideWorkspace, { target: relativeTarget });
  }
  // NTFS alternate data streams and drive-relative spellings never belong in a scaffold.
  if (/^[a-zA-Z]:/.test(relativeTarget) || /(^|[\\/])[^\\/]*:[^\\/]*$/.test(relativeTarget)) {
    throw new Fault(CODES.pathOutsideWorkspace, { target: relativeTarget });
  }
  const absolute = resolve(root, relativeTarget);
  if (!pathInside(root, absolute)) {
    throw new Fault(CODES.pathOutsideWorkspace, { target: relativeTarget });
  }
  return absolute;
}

/**
 * Read and parse a JSON document.
 * @param {string} filePath
 * @param {string} code Failure code when the file is missing or malformed.
 * @returns {Promise<any>}
 */
export async function readJson(filePath, code = CODES.stateCorrupt) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Fault(code, { path: filePath, reason: error instanceof Error ? error.message : String(error) });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Fault(code, { path: filePath, reason: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Write JSON through a temporary sibling and an atomic rename, so a crash never
 * leaves a half-written document behind.
 * @param {string} filePath
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${newId().slice(0, 8)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Write bytes atomically, refusing to replace an existing file unless
 * `overwrite` is set. The exclusive branch is what makes template application
 * safe against a concurrent writer that created the target after preview.
 * @param {string} filePath
 * @param {Buffer} bytes
 * @param {{overwrite?: boolean}} [options]
 * @returns {Promise<'created'|'replaced'>}
 */
export async function writeFileAtomic(filePath, bytes, options = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  if (options.overwrite === true) {
    const temporary = `${filePath}.${process.pid}.${newId().slice(0, 8)}.tmp`;
    await writeFile(temporary, bytes);
    try {
      await rename(temporary, filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return 'replaced';
  }
  const handle = await open(filePath, 'wx');
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return 'created';
}

const lockTails = new Map();

/**
 * Serialize asynchronous work per key inside this process. Native plugin
 * enablement is additionally serialized by the host's own profile lock, so this
 * only has to keep our own read-modify-write cycles from interleaving.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
export function withKeyLock(key, job) {
  const tail = lockTails.get(key) ?? Promise.resolve();
  const next = tail.then(job, job);
  const guard = next.then(
    () => {},
    () => {},
  );
  lockTails.set(key, guard);
  void guard.then(() => {
    if (lockTails.get(key) === guard) lockTails.delete(key);
  });
  return next;
}

/**
 * Stable JSON with sorted object keys, used for operation request hashes so an
 * equivalent retry is recognized as a repeat of the same operation.
 * @param {any} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/** @param {any} value @returns {string} */
export function requestHashOf(value) {
  return sha256Hex(stableStringify(value));
}

/**
 * @param {string} name @param {string} version
 * @returns {string} The warehouse key for one exact package version.
 */
export function packageKey(name, version) {
  return `${name}@${version}`;
}

/**
 * Split a warehouse key back into its parts. A scoped name keeps its leading
 * scope, so the split happens on the last `@` that is not the first character.
 * @param {string} key
 * @returns {{name: string, version: string}}
 */
export function parsePackageKey(key) {
  const at = key.lastIndexOf('@');
  if (at <= 0) throw new Fault(CODES.invalidRequest, { packageKey: key });
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

/**
 * Whether two directory spellings name the same place. Windows filesystems are
 * case-insensitive, so a bare string comparison would miss real matches.
 * @param {string|null|undefined} left
 * @param {string|null|undefined} right
 * @returns {boolean}
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  return process.platform === 'win32' && left.toLowerCase() === right.toLowerCase();
}

/**
 * Deep-clone through structured JSON so callers can never mutate stored state.
 * @template T @param {T} value @returns {T}
 */
export function clone(value) {
  return structuredClone(value);
}

/**
 * Compare two arrays as sets and in order.
 * @param {readonly string[]} left @param {readonly string[]} right
 * @returns {boolean}
 */
export function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export { join, dirname, resolve, relative, sep };
