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
 * Build one USTAR entry block from raw `name`-field bytes. Taking bytes rather
 * than a string lets a test present a spelling this plugin's own writer would
 * never produce (a legacy single-byte name, say).
 * @param {Buffer} nameBytes @param {Buffer} payload @param {string} typeflag
 */
function entryFromBytes(nameBytes, payload, typeflag = '0') {
  const block = Buffer.alloc(512, 0);
  nameBytes.subarray(0, 100).copy(block, 0);
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

/**
 * Build one USTAR entry block from a path name, UTF-8 encoded the way both this
 * plugin and the rest of the ecosystem write it.
 * @param {string} name @param {Buffer} payload @param {string} typeflag
 */
function entry(name, payload, typeflag = '0') {
  return entryFromBytes(Buffer.from(name, 'utf8'), payload, typeflag);
}

/** @param {Array<Buffer>} parts */
function tarball(...parts) {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024, 0)]));
}

/**
 * The raw `name` (bytes 0..99) and `prefix` (bytes 345..499) fields of every
 * entry, taken straight out of the tar bytes rather than through the parser
 * under test.
 * @param {Buffer} tar @returns {Array<{offset: number, nameBytes: Buffer, prefixBytes: Buffer}>}
 */
function rawHeaderFields(tar) {
  const fields = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    fields.push({ offset, nameBytes: block.subarray(0, 100), prefixBytes: block.subarray(345, 500) });
    offset += 512 + Math.ceil(readOctal(tar, offset + 124, 12) / 512) * 512;
  }
  return fields;
}

/** @param {Buffer} field @returns {Buffer} The field bytes before its NUL padding. */
function upToNul(field) {
  const end = field.indexOf(0);
  return end === -1 ? field : field.subarray(0, end);
}

/**
 * The exact path bytes stored for one entry, reassembled from its raw prefix and
 * name fields. A trailing slash (directory entries carry one) is ignored when
 * matching.
 * @param {Buffer} tar @param {string} spelling
 * @returns {{name: Buffer, prefix: Buffer, full: Buffer}|null}
 */
function storedPathBytes(tar, spelling) {
  const wanted = spelling.replace(/\/+$/, '');
  for (const field of rawHeaderFields(tar)) {
    const name = upToNul(field.nameBytes);
    const prefix = upToNul(field.prefixBytes);
    const full = prefix.length === 0 ? name : Buffer.concat([prefix, Buffer.from('/'), name]);
    if (full.toString('utf8').replace(/\/+$/, '') === wanted) return { name, prefix, full };
  }
  return null;
}

/**
 * Assert the archive stores `spelling` as exactly its UTF-8 bytes.
 * @param {Buffer} tar @param {string} spelling
 * @returns {{name: Buffer, prefix: Buffer, full: Buffer}}
 */
function assertStoredPath(tar, spelling) {
  const stored = storedPathBytes(tar, spelling);
  assert.ok(stored, `no header stores the path ${spelling}`);
  assert.equal(
    stored.full.equals(Buffer.from(spelling, 'utf8')),
    true,
    `header bytes for ${spelling} must be its UTF-8 encoding, got ${JSON.stringify([...stored.full])}`,
  );
  return stored;
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

// ---------------------------------------------------------------------------
// Non-ASCII path names. USTAR keeps `name`/`prefix` as UTF-8 bytes; the reader
// used to decode them as Latin-1, so every one of the checks below came back
// mojibake before the fix.
// ---------------------------------------------------------------------------

test('non-ASCII file and directory names round-trip byte-for-byte through pack, inspect and extract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
  try {
    await mkdir(join(dir, '模板'), { recursive: true });
    await writeFile(join(dir, '模板-说明.md'), '# 说明\n模板正文\n');
    await writeFile(join(dir, '模板', '内容.txt'), '中文内容');

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);
    assert.deepEqual(
      entries.map((entry_) => entry_.path).sort(),
      ['package', 'package/模板', 'package/模板-说明.md', 'package/模板/内容.txt'].sort(),
      'inspected paths must be the original names, not a Latin-1 reading of their UTF-8 bytes',
    );
    // The archive bytes themselves must be exactly the UTF-8 encoding.
    assertStoredPath(tarBuffer, 'package/模板-说明.md');
    assertStoredPath(tarBuffer, 'package/模板/');

    await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
    const listed = (await listFiles(restored)).sort();
    assert.deepEqual(listed, ['模板-说明.md', '模板/内容.txt'].sort());
    assert.deepEqual(
      listed.map((name) => Buffer.from(name, 'utf8')),
      ['模板-说明.md', '模板/内容.txt'].sort().map((name) => Buffer.from(name, 'utf8')),
      'the names on disk must be the same bytes as the source names',
    );
    assert.equal(await readFile(join(restored, '模板-说明.md'), 'utf8'), '# 说明\n模板正文\n');
    assert.equal(await readFile(join(restored, '模板', '内容.txt'), 'utf8'), '中文内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test('a long non-ASCII path survives the USTAR name/prefix split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
  try {
    // 10 CJK characters: 30 UTF-8 bytes per segment, so four levels put the
    // path past the 100-byte `name` field while the prefix stays under 155.
    const deep = '很长的中文目录名称一';
    const file = '说明文档.md';
    assert.equal(Buffer.byteLength(deep, 'utf8'), 30);
    const relative = `${deep}/${deep}/${deep}/${deep}/${file}`;
    await mkdir(join(dir, ...relative.split('/').slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...relative.split('/')), '深层内容');

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);
    const full = `package/${relative}`;
    assert.ok(Buffer.byteLength(full, 'utf8') > 100, 'fixture must exceed the 100-byte name field');
    assert.deepEqual(entries.map((entry_) => entry_.path), [
      'package',
      `package/${deep}`,
      `package/${deep}/${deep}`,
      `package/${deep}/${deep}/${deep}`,
      `package/${deep}/${deep}/${deep}/${deep}`,
      full,
    ]);

    // Directory entries carry a trailing slash, so the two-level one still fits
    // the name field alone while the deeper entries need the prefix field. (The
    // three-level one is 101 bytes with its slash, hence already split.)
    assert.equal(storedPathBytes(tarBuffer, `package/${deep}/${deep}`).prefix.length, 0);
    const storedDir = assertStoredPath(tarBuffer, `package/${deep}/${deep}/${deep}/${deep}/`);
    assert.deepEqual(storedDir.prefix, Buffer.from(`package/${deep}/${deep}/${deep}/${deep}`, 'utf8'));
    assert.equal(storedDir.name.length, 0, 'the trailing slash comes from the prefix/name join, not from the name field');

    const stored = assertStoredPath(tarBuffer, full);
    assert.deepEqual(stored.prefix, Buffer.from(`package/${deep}/${deep}/${deep}/${deep}`, 'utf8'));
    assert.deepEqual(stored.name, Buffer.from(file, 'utf8'));

    await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
    assert.deepEqual(await listFiles(restored), [relative]);
    assert.equal(await readFile(join(restored, ...relative.split('/')), 'utf8'), '深层内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test('paths with 4-byte UTF-8 characters round-trip byte-for-byte, with and without a prefix split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
  try {
    const emojiDir = '📦-归档';
    const longEmojiDir = '🚀'.repeat(20); // 80 UTF-8 bytes, so the file below is split
    const shortFile = '🚀-数据.md';
    const longFile = '🎉-记录.md';
    await mkdir(join(dir, emojiDir), { recursive: true });
    await mkdir(join(dir, longEmojiDir), { recursive: true });
    await writeFile(join(dir, emojiDir, shortFile), '内容 🎉');
    await writeFile(join(dir, longEmojiDir, longFile), '另一个内容 🚀');

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);
    const short = `package/${emojiDir}/${shortFile}`;
    const long = `package/${longEmojiDir}/${longFile}`;
    assert.deepEqual(entries.map((entry_) => entry_.path).sort(), [
      'package',
      `package/${emojiDir}`,
      `package/${longEmojiDir}`,
      short,
      long,
    ].sort());
    assert.ok(Buffer.byteLength(long, 'utf8') > 100, 'the long emoji path must force a prefix split');
    assert.equal(assertStoredPath(tarBuffer, short).prefix.length, 0);
    assert.ok(assertStoredPath(tarBuffer, long).prefix.length > 0);
    assert.deepEqual(assertStoredPath(tarBuffer, long).name, Buffer.from(longFile, 'utf8'));

    await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
    assert.deepEqual((await listFiles(restored)).sort(), [`${emojiDir}/${shortFile}`, `${longEmojiDir}/${longFile}`].sort());
    assert.equal(await readFile(join(restored, emojiDir, shortFile), 'utf8'), '内容 🎉');
    assert.equal(await readFile(join(restored, longEmojiDir, longFile), 'utf8'), '另一个内容 🚀');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test('a pure ASCII path is unaffected by the path-field decoding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
  try {
    await mkdir(join(dir, 'templates'), { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"name":"x"}');
    await writeFile(join(dir, 'templates', 'a.txt'), 'hello');

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);
    assert.deepEqual(entries.map((entry_) => entry_.path).sort(), [
      'package',
      'package/package.json',
      'package/templates',
      'package/templates/a.txt',
    ]);
    const stored = assertStoredPath(tarBuffer, 'package/templates/a.txt');
    // For ASCII the UTF-8 bytes and the Latin-1 reading agree, so the old
    // decoder and the new one must produce the identical field here.
    assert.deepEqual(stored.name, Buffer.from(stored.name.toString('utf8'), 'utf8'));
    assert.equal(stored.name.toString('latin1'), stored.name.toString('utf8'));

    await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
    assert.deepEqual((await listFiles(restored)).sort(), ['package.json', 'templates/a.txt']);
    assert.equal(await readFile(join(restored, 'templates', 'a.txt'), 'utf8'), 'hello');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test('multi-block file contents keep their exact bytes when the paths are non-ASCII too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  const restored = await mkdtemp(join(tmpdir(), 'wss-restore-'));
  try {
    // Comfortably past one 512-byte block, so a content-encoding slip could not
    // hide behind a single-block copy.
    const body = Buffer.from(`${'# 中文内容\n'.repeat(120)}🎉 结束\n`, 'utf8');
    assert.ok(body.length > 1024);
    await mkdir(join(dir, '中文'), { recursive: true });
    await writeFile(join(dir, '中文', '内容-载荷.md'), body);

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);

    // Content first, and independently of the path decoding: read the payload
    // straight out of the tar bytes and compare. This assertion holds both
    // before and after the path fix, so it proves the change touched only the
    // path fields and left the content blocks alone.
    const header = rawHeaderFields(tarBuffer).find((field) =>
      upToNul(field.nameBytes).toString('utf8').replace(/\/+$/, '').endsWith('内容-载荷.md'),
    );
    assert.ok(header, 'the content entry must be present in the archive');
    const payload = tarBuffer.subarray(header.offset + 512, header.offset + 512 + body.length);
    assert.equal(payload.equals(body), true, 'archived payload bytes must equal the source bytes');

    // The paths themselves, which is what the UTF-8 read fix changes.
    assertStoredPath(tarBuffer, 'package/中文/内容-载荷.md');
    const fileEntry = entries.find((entry_) => entry_.path.endsWith('内容-载荷.md'));
    assert.ok(fileEntry, `path was not decoded as written: ${JSON.stringify(entries.map((entry_) => entry_.path))}`);
    assert.equal(fileEntry.size, body.length);

    await extractTarball(packed.buffer, restored, (entryPath) => resolveInside(restored, entryPath));
    const restoredBytes = await readFile(join(restored, '中文', '内容-载荷.md'));
    assert.equal(restoredBytes.equals(body), true, 'content bytes must be identical, not re-encoded');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test('a name field that is not valid UTF-8 decodes deterministically, without a Latin-1 guess', () => {
  // "é.txt" as a legacy single-byte spelling: 0xe9 is not a valid UTF-8 lead
  // byte followed by '.', so strict UTF-8 replaces it.
  const legacy = Buffer.from([0xe9, 0x2e, 0x74, 0x78, 0x74]);
  const buffer = tarball(entryFromBytes(legacy, Buffer.from('boom')));
  const paths = inspectTarball(buffer).entries.map((entry_) => entry_.path);
  assert.deepEqual(paths, ['\uFFFD.txt']);
  // The rejected heuristic would have produced this instead; the module
  // documents that it does not guess, and this pins that choice.
  assert.notEqual(paths[0], legacy.toString('latin1'));
});

test('a name that legitimately contains U+FFFD is not mistaken for a legacy encoding', () => {
  // The reason the "saw U+FFFD, retry as Latin-1" fallback was rejected: this
  // name is valid UTF-8 that a writer can legitimately emit.
  const buffer = tarball(entry('package/\uFFFD.txt', Buffer.from('x')));
  assert.deepEqual(inspectTarball(buffer).entries.map((entry_) => entry_.path), ['package/\uFFFD.txt']);
});

// ---------------------------------------------------------------------------
// USTAR path-length limits. `name` holds 100 bytes and `prefix` 155; a path can
// exceed both together, and one that does must be refused. The writer used to
// pop directory segments off the end and store the shortened path instead, so a
// deep package packed into an archive that contradicted itself: the deep
// directory and the file inside it both collapsed onto the shallower directory's
// path, and `inspectTarball` - the gate every import passes - then rejected the
// tarball `packDirectory` had just produced, reporting `duplicate-path` for a
// package that contained no duplicate. Refusing the entry is the only honest
// outcome: the caller sees the real reason (`path-too-long`), and no unusable
// archive reaches the disk.
// ---------------------------------------------------------------------------

/** A CJK segment: every character is 3 UTF-8 bytes, so `chars * 3` is exact. */
const cjk = (char, chars) => char.repeat(chars);

/** The UTF-8 byte length of a path, which is what the USTAR fields count. */
const pathBytes = (spelling) => Buffer.byteLength(spelling, 'utf8');

/** The `prefix` half of a path: everything before its final `/`. */
const prefixBytes = (spelling) => pathBytes(spelling.slice(0, spelling.lastIndexOf('/')));

test('a path too long for the USTAR prefix is refused, not silently truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    // Ten CJK characters are 30 bytes, so seven levels are 210 bytes of
    // directories. With `package/` in front, the deepest prefix a split can
    // offer is the first six levels (8 + 6*30 = 188 > 155); every shallower
    // split only lengthens `name`, and the 15-byte filename already rules out
    // folding a level into it (30 + 1 + 15 > 100). No split fits.
    const deep = cjk('一', 10);
    assert.equal(Buffer.byteLength(deep, 'utf8'), 30);
    const file = '说明文档.md';
    const levels = Array(7).fill(deep);
    await mkdir(join(dir, ...levels), { recursive: true });
    await writeFile(join(dir, ...levels, file), '深层内容');

    const full = `package/${levels.join('/')}/${file}`;
    assert.equal(pathBytes(`${levels.join('/')}/`), 217, 'seven 30-byte levels, joined by six slashes');
    assert.equal(prefixBytes(full), 224, 'the prefix alone must be past the 155-byte field');
    assert.equal(pathBytes(full), 240);
    await assert.rejects(
      () => packDirectory(dir),
      (error) => {
        assert.equal(error.code, CODES.archiveInvalid);
        // The real reason. Before the fix this call succeeded and the archive
        // failed later with `duplicate-path` instead.
        assert.equal(error.details.reason, 'path-too-long');
        assert.equal(error.details.path, full);
        assert.equal(error.details.bytes, pathBytes(full));
        assert.equal(error.details.field, 'prefix');
        assert.equal(error.details.nameLimit, 100);
        assert.equal(error.details.prefixLimit, 155);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a path too long in total is not reported as a duplicate path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    // Every segment here is short enough for `name` on its own, so the old code
    // had nothing to pop towards a valid split and stored the level-7 directory
    // and the file inside it as the level-6 path. `inspectTarball` then saw the
    // same path twice and blamed a duplicate the package never contained.
    const deep = cjk('一', 10);
    const levels = Array(7).fill(deep);
    const file = '说明文档.md';
    await mkdir(join(dir, ...levels), { recursive: true });
    await writeFile(join(dir, ...levels, file), '深层内容');

    let packed = null;
    try {
      packed = await packDirectory(dir);
    } catch (error) {
      assert.equal(error.code, CODES.archiveInvalid);
      assert.equal(error.details.reason, 'path-too-long', 'the error must name the real defect');
      assert.notEqual(error.details.reason, 'duplicate-path');
    }
    assert.equal(packed, null, 'a path that cannot be split must not be archived at all');

    // Independently: no archive this scenario can produce may look like it holds
    // a duplicate, and nothing that reaches `inspectTarball` may be refused.
    if (packed !== null) {
      const entries = inspectTarball(packed.buffer).entries;
      const seen = new Set();
      for (const entry_ of entries) {
        const key = process.platform === 'win32' ? entry_.path.toLowerCase() : entry_.path;
        assert.equal(seen.has(key), false, `collapsed path stored twice: ${entry_.path}`);
        seen.add(key);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a deep path right at the USTAR limits still packs and inspects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    // Sized so the deepest split that fits puts exactly 155 bytes - the prefix
    // field's full capacity - in `prefix`. The path is `package/` + 30 + 30 + 30
    // + 54 + 100 = 256 bytes; the deepest candidate prefix (256 - 100 = 156) is
    // one byte over the field, so the next candidate is exactly 155. The 100-byte
    // filename is also what makes the limit bite one level down: folding that
    // extra directory into `name` would need 3 + 1 + 100 bytes, so there is no
    // fallback split and the path is refused outright.
    const deep = cjk('一', 10);
    const mid = cjk('二', 10);
    const last = cjk('三', 10);
    const pad = cjk('一', 18);
    const levels = [deep, mid, last, pad];
    const file = `${cjk('四', 32)}${'-'.repeat(4)}`;
    const deeper = '五';
    assert.equal([deep, mid, last, pad].map((s) => Buffer.byteLength(s, 'utf8')).join(','), '30,30,30,54');
    assert.equal(Buffer.byteLength(file, 'utf8'), 100);
    await mkdir(join(dir, ...levels), { recursive: true });
    await writeFile(join(dir, ...levels, file), '深层内容');

    const full = `package/${levels.join('/')}/${file}`;
    assert.equal(prefixBytes(full), 155, 'the deepest split that fits must be the field capacity');
    assert.equal(pathBytes(full), 256);
    const tooDeep = [...levels, deeper];
    const tooDeepFile = `package/${tooDeep.join('/')}/${file}`;
    assert.ok(prefixBytes(tooDeepFile) > 155, 'one level deeper must be past the boundary');
    assert.ok(pathBytes(`${deeper}/${file}`) > 100, 'one level deeper must have no split at all');

    const packed = await packDirectory(dir);
    const { entries, tarBuffer } = inspectTarball(packed.buffer);
    assert.deepEqual(
      entries.map((entry_) => entry_.path),
      [
        'package',
        `package/${deep}`,
        `package/${deep}/${mid}`,
        `package/${deep}/${mid}/${last}`,
        `package/${levels.join('/')}`,
        full,
      ],
      'every entry of a legal near-limit path must survive packing intact',
    );

    const storedDir = assertStoredPath(tarBuffer, `package/${levels.join('/')}/`);
    assert.equal(Buffer.byteLength(storedDir.prefix, 'utf8'), 155, 'the prefix field must be used to its full capacity');
    assert.equal(storedDir.name.length, 0, 'a directory whose prefix is the whole path has an empty name field');
    const storedFile = assertStoredPath(tarBuffer, full);
    assert.equal(Buffer.byteLength(storedFile.prefix, 'utf8'), 155);
    assert.deepEqual(storedFile.name, Buffer.from(file, 'utf8'));

    // One directory deeper, holding a file, leaves no split at all and is
    // refused - which is what makes the case above the boundary.
    const deeperDir = join(dir, ...tooDeep);
    await mkdir(deeperDir, { recursive: true });
    await writeFile(join(deeperDir, file), '更深的文件');
    await assert.rejects(
      () => packDirectory(dir),
      (error) => {
        assert.equal(error.code, CODES.archiveInvalid);
        assert.equal(error.details.reason, 'path-too-long');
        assert.equal(error.details.path, tooDeepFile);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a single path segment over the 100-byte name field is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wss-tar-'));
  try {
    // 34 CJK characters: 102 bytes in one segment, so no split can help.
    const longSegment = cjk('目', 34);
    assert.equal(Buffer.byteLength(longSegment, 'utf8'), 102);
    const full = `package/${longSegment}`;
    await writeFile(join(dir, longSegment), 'x');

    await assert.rejects(
      () => packDirectory(dir),
      (error) => {
        assert.equal(error.code, CODES.archiveInvalid);
        assert.equal(error.details.reason, 'path-too-long');
        assert.equal(error.details.path, full);
        // This refusal existed before the fix too; what the fix adds is the
        // field-level detail, so the message names the name field rather than
        // leaving the caller to infer which limit a 102-byte segment broke.
        assert.equal(error.details.field, 'name', 'the failing field is the name field');
        assert.equal(error.details.nameBytes, 102);
        assert.equal(error.details.nameLimit, 100);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
