/**
 * Archive safety. Every entry that can reach a profile or a workspace passes
 * through these checks, so they are tested against hand-built tarballs rather
 * than only against archives this code produced itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { lstat, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractTarball, inspectTarball, packDirectory } from '../src/tar.js';
import { CODES } from '../src/errors.js';
import { pathInside, resolveInside, sha256Hex } from '../src/util.js';

/**
 * Read one octal header field from a raw tar buffer.
 * @param {Buffer} tar @param {number} offset @param {number} length
 * @returns {number}
 */
function readOctal(tar, offset, length) {
  const text = tar.toString('latin1', offset, offset + length).replace(/\0.*$/, '').trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/**
 * Build one USTAR entry block.
 * @param {string} name @param {Buffer} payload @param {string} typeflag
 */
function entry(name, payload, typeflag = '0') {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'latin1');
  block.write('0000000\0', 108, 8, 'latin1');
  block.write('0000000\0', 116, 8, 'latin1');
  block.write(payload.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  block.write('00000000000\0', 136, 12, 'latin1');
  block.write('        ', 148, 8, 'latin1');
  block.write(typeflag, 156, 1, 'latin1');
  block.write('ustar\0', 257, 6, 'latin1');
  block.write('00', 263, 2, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0'), 148, 6, 'latin1');
  block.write('\0 ', 154, 2, 'latin1');
  const padding = (512 - (payload.length % 512)) % 512;
  return Buffer.concat([block, payload, Buffer.alloc(padding, 0)]);
}

/** @param {Array<Buffer>} parts */
function tarball(...parts) {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
}

/**
 * Every file below `dir` as a slash-separated relative path.
 * @param {string} dir @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function listFiles(dir, prefix = '') {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await listFiles(join(dir, entry.name), relative)));
    else found.push(relative);
  }
  return found;
}

/**
 * Create a directory link. Windows uses a junction, which needs no elevation;
 * other platforms get a plain directory symlink.
 * @param {string} target @param {string} linkPath
 */
async function linkDirectory(target, linkPath) {
  await symlink(target, linkPath, 'junction');
}

test('packDirectory round-trips a package under the npm `package/` prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    await writeFile(join(dir, 'templates', 'a.txt'), 'hello');
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(1500, 7));
    const packed = await packDirectory(dir);
    const inspected = inspectTarball(packed.buffer);
    const paths = inspected.entries.map((entry_) => entry_.path).sort();
    assert.deepEqual(paths, ['package', 'package/big.bin', 'package/package.json', 'package/templates', 'package/templates/a.txt']);
    assert.equal(inspected.totalBytes, packed.bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('packDirectory skips node_modules and .git', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true });
    await mkdir(join(dir, '.git'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{}');
    await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    await writeFile(join(dir, '.git', 'config'), 'x');
    const packed = await packDirectory(dir);
    const paths = inspectTarball(packed.buffer).entries.map((entry_) => entry_.path);
    assert.deepEqual(paths, ['package', 'package/package.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('packDirectory never follows a directory link into content outside the package', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const outside = await mkdtemp(join(tmpdir(), 'wss-outside-'));
  try {
    await writeFile(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    await mkdir(join(outside, 'nested'), { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'EXTERNAL-SECRET');
    await writeFile(join(outside, 'nested', 'deep.txt'), 'EXTERNAL-DEEP');
    // A real directory link inside the package: the pack must refuse to reach
    // through it, exactly as its contract claims.
    await linkDirectory(outside, join(dir, 'linked'));
    // Prove the fixture is a genuine link rather than a plain directory, so a
    // passing test cannot be an artifact of the link never having been made.
    assert.equal((await lstat(join(dir, 'linked'))).isSymbolicLink(), true);
    assert.equal((await stat(join(dir, 'linked'))).isDirectory(), true);

    const packed = await packDirectory(dir);
    const paths = inspectTarball(packed.buffer).entries.map((entry_) => entry_.path).sort();
    assert.deepEqual(paths, ['package', 'package/package.json'], 'nothing behind the link may be archived');

    // Unpacking the archive must not reproduce the external files either.
    const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
    try {
      await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
      assert.deepEqual(await listFiles(restored), ['package.json']);
      assert.equal(await readFile(join(restored, 'package.json'), 'utf8'), '{"name":"x","version":"1.0.0"}');
    } finally {
      await rm(restored, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('packing embeds no wall-clock time, so an unchanged directory always hashes the same', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
    await writeFile(join(dir, 'templates', 'a.txt'), 'hello');

    // Pin the directory to a known past instant. A pack that reached for the
    // current time would embed roughly "now" here and fail this assertion
    // deterministically, rather than only when a test happened to straddle a
    // second boundary.
    const past = new Date('2001-02-03T04:05:06Z');
    await utimes(dir, past, past);

    const first = await packDirectory(dir);
    const second = await packDirectory(dir);
    assert.equal(
      sha256Hex(first.buffer),
      sha256Hex(second.buffer),
      'packing the same unchanged directory twice must produce identical bytes',
    );

    const { tarBuffer } = inspectTarball(first.buffer);
    assert.equal(
      readOctal(tarBuffer, 136, 12),
      Math.floor(past.getTime() / 1000),
      'the synthetic package/ entry must carry the source directory timestamp, not the pack time',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a parent-directory escape is refused', () => {
  const buffer = tarball(entry('package/../../evil.txt', Buffer.from('boom')));
  assert.throws(
    () => inspectTarball(buffer),
    (error) => error.code === CODES.archiveInvalid && error.details.reason === 'unsafe-path',
  );
});

test('an absolute path is refused', () => {
  const buffer = tarball(entry('/etc/passwd', Buffer.from('boom')));
  assert.throws(
    () => inspectTarball(buffer),
    (error) => error.code === CODES.archiveInvalid && error.details.reason === 'unsafe-path',
  );
});

test('a symlink entry is refused rather than followed', () => {
  const buffer = tarball(entry('package/link', Buffer.alloc(0), '2'));
  assert.throws(
    () => inspectTarball(buffer),
    (error) => error.code === CODES.archiveInvalid && error.details.reason === 'link-entry',
  );
});

test('a hardlink entry is refused', () => {
  const buffer = tarball(entry('package/link', Buffer.alloc(0), '1'));
  assert.throws(
    () => inspectTarball(buffer),
    (error) => error.code === CODES.archiveInvalid && error.details.reason === 'link-entry',
  );
});

test('a duplicated entry is refused', () => {
  const buffer = tarball(entry('package/a.txt', Buffer.from('one')), entry('package/a.txt', Buffer.from('two')));
  assert.throws(
    () => inspectTarball(buffer),
    (error) => error.code === CODES.archiveInvalid && error.details.reason === 'duplicate-path',
  );
});

test('extraction strips the pack prefix and lands inside the target', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    const buffer = tarball(
      entry('package/package.json', Buffer.from('{"name":"x"}')),
      entry('package/templates/a.txt', Buffer.from('hi')),
    );
    const result = await extractTarball(buffer, dir, (entryPath) => resolveInside(dir, entryPath));
    assert.equal(result.files.length, 2);
    assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), '{"name":"x"}');
    assert.equal(await readFile(join(dir, 'templates', 'a.txt'), 'utf8'), 'hi');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveInside refuses escapes, absolute targets and data streams', () => {
  const root = process.platform === 'win32' ? 'C:\\workspace\\proj' : '/workspace/proj';
  assert.throws(() => resolveInside(root, '../outside.txt'), (error) => error.code === CODES.pathOutsideWorkspace);
  assert.throws(() => resolveInside(root, 'a/../../outside.txt'), (error) => error.code === CODES.pathOutsideWorkspace);
  assert.throws(() => resolveInside(root, ''), (error) => error.code === CODES.pathOutsideWorkspace);
  assert.throws(() => resolveInside(root, 'docs/notes.txt:secret'), (error) => error.code === CODES.pathOutsideWorkspace);
  if (process.platform === 'win32') {
    assert.throws(() => resolveInside(root, 'C:\\Windows\\system32\\evil.dll'), (error) => error.code === CODES.pathOutsideWorkspace);
  }
  const inside = resolveInside(root, 'docs/notes.md');
  assert.equal(pathInside(root, inside), true);
});
