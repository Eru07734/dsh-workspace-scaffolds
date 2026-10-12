/**
 * Build the release tarball.
 *
 * Uses this plugin's own USTAR writer rather than a package manager, so the
 * release artifact is produced by the same code path the plugin uses to accept
 * scaffold packages, and building it needs no network or third-party tool.
 *
 * Usage: node scripts/pack.mjs [output-directory]
 * @module scripts/pack
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectTarball, packDirectory } from '../src/tar.js';
import { sha256Hex } from '../src/util.js';

const packageRoot = resolve(dirname(fileURLToPath(new URL(import.meta.url))), '..');

/** Paths that must never appear in the release archive. */
const EXCLUDED = ['node_modules', '.git', 'test', 'scripts', 'staging', 'state.json'];

/**
 * Read the package manifest.
 * @returns {Promise<any>}
 */
async function manifest() {
  return JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
}

/**
 * @param {any} info
 * @returns {Promise<void>}
 */
async function main(info) {
  const staging = join(packageRoot, '.pack-staging');
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  const listed = info.files ?? [];
  for (const entry of listed) {
    await copyEntry(join(packageRoot, entry), join(staging, entry));
  }
  await writeFile(join(staging, 'package.json'), `${JSON.stringify(info, null, 2)}\n`);

  const packed = await packDirectory(staging);
  const outDir = resolve(process.argv[2] ?? packageRoot);
  await mkdir(outDir, { recursive: true });
  const fileName = `${info.name}-${info.version}.tgz`;
  const target = join(outDir, fileName);
  await writeFile(target, packed.buffer);
  await rm(staging, { recursive: true, force: true });

  const inspected = inspectTarball(packed.buffer);
  const bytes = (await stat(target)).size;
  process.stdout.write(
    JSON.stringify(
      {
        file: target,
        bytes,
        sha256: sha256Hex(packed.buffer),
        entries: inspected.entries.length,
        unpackedBytes: inspected.totalBytes,
        excluded: EXCLUDED,
      },
      null,
      2,
    ) + '\n',
  );
}

/**
 * Copy one declared release path, recursively for directories.
 * @param {string} from
 * @param {string} to
 */
async function copyEntry(from, to) {
  const info = await stat(from).catch(() => null);
  if (info === null) return;
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (EXCLUDED.includes(name)) continue;
      await copyEntry(join(from, name), join(to, name));
    }
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
  void relative(packageRoot, from);
}

await main(await manifest());
