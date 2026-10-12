/**
 * An in-memory stand-in for the DSH services this plugin talks to.
 *
 * The fake supplies *services* (a `pluginManager`, a `workspaceRegistry`, an
 * agent registry) plus a minimal context, and the tests then build the real
 * `src/host.js` adapter on top. That way the adapter's own contract — most
 * importantly `installBundle(..., {enabled:false})` — is exercised rather than
 * stubbed out.
 * @module test/helpers/fake-host
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHost } from '../../src/host.js';
import { extractTarball, inspectTarball } from '../../src/tar.js';
import { canonicalize, resolveInside, samePath } from '../../src/util.js';

/**
 * Read `package.json` out of an in-memory tarball.
 * @param {Buffer} buffer
 * @returns {any}
 */
function manifestOf(buffer) {
  const inspected = inspectTarball(buffer);
  let tar = buffer;
  try {
    tar = gunzipSync(buffer);
  } catch {
    // plain tar input
  }
  let offset = 0;
  for (const entry of inspected.entries) {
    const block = tar.subarray(offset, offset + 512);
    const size = Number.parseInt(block.toString('latin1', 124, 136).replace(/\0.*$/, '').trim() || '0', 8);
    const payload = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (entry.path === 'package/package.json') return JSON.parse(payload.toString('utf8'));
  }
  throw new Error('fake install: archive has no package/package.json');
}

/**
 * Build a fake host rooted at a fresh temporary directory.
 * @param {{profileName?: string}} [options]
 */
export async function createFakeHost(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wss-fake-'));
  const profileDir = join(root, 'profile');
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });

  /** @type {Map<string, {workspaceId: string, path: string, title: string}>} */
  const workspaces = new Map();
  /** @type {Map<string, object>} */
  const bundles = new Map();
  /** @type {object[]} */
  const agents = [];
  /** @type {Map<string, string>} */
  const packageDirs = new Map();
  const calls = [];

  /** Called after every native enablement change, like the real plugin manager. */
  let onPluginManagerChange = null;

  /**
   * Optional async gate awaited before a native enable/disable takes effect.
   *
   * Interleaving regressions need a deterministic boundary rather than a sleep:
   * this lets a test hold one native call open while another operation runs.
   */
  let gateSetEnabled = null;

  /**
   * One-shot override for the next `installBundle` call. See
   * `installBundleOutcome` on the returned object for the two shapes.
   * @type {object|((installed: object) => object)|null}
   */
  let nextInstallOutcome = null;

  /**
   * The ordinary install: unpack the archive into the profile's `node_modules`
   * and register the bundle, like the real manager.
   * @param {string} spec
   * @param {{enabled?: boolean}} installOptions
   * @returns {Promise<object>}
   */
  async function installBundleForReal(spec, installOptions) {
    const buffer = await readFile(spec);
    const manifest = manifestOf(buffer);
    const directory = join(profileDir, 'node_modules', ...manifest.name.split('/'));
    await extractTarball(buffer, directory, (entryPath) => resolveInside(directory, entryPath));
    packageDirs.set(manifest.name, directory);
    bundles.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      enabled: installOptions.enabled !== false,
      installed: true,
      removable: true,
    });
    return { application: 'applied', bundle: manifest.name, target: manifest.name, stage: 'install' };
  }

  const pluginManager = {
    async listBundles() {
      return [...bundles.values()].map((row) => ({
        name: row.name,
        version: row.version,
        enabled: row.enabled,
        installed: row.installed,
        removable: row.removable,
        ...(row.error === undefined ? {} : { error: row.error }),
      }));
    },
    async setBundleEnabled(name, enabled) {
      if (gateSetEnabled !== null) await gateSetEnabled({ name, enabled });
      calls.push({ kind: 'setBundleEnabled', name, enabled });
      const row = bundles.get(name);
      if (row === undefined) throw new Error(`unknown bundle ${name}`);
      row.enabled = enabled;
      // The real manager emits `plugin-manager/changed` for every write,
      // including the ones this plugin performs. Reproducing that here is what
      // makes the self-attribution race testable at all.
      if (onPluginManagerChange !== null) onPluginManagerChange({ name, enabled });
      return { application: 'applied', changed: true };
    },
    /**
     * Mirrors the native contract: `options.enabled !== false` activates the
     * bundle. The adapter is what passes `enabled:false`.
     *
     * The attempt is recorded in `calls` before any override applies, because
     * the adapter's decision to call at all is itself under test.
     */
    async installBundle(spec, installOptions = {}) {
      calls.push({ kind: 'installBundle', spec, enabled: installOptions.enabled });
      const override = nextInstallOutcome;
      nextInstallOutcome = null;
      if (typeof override === 'function') return override(await installBundleForReal(spec, installOptions));
      if (override !== null) return override;
      return await installBundleForReal(spec, installOptions);
    },
  };

  const workspaceRegistry = {
    list: () => [...workspaces.values()].map((workspace) => ({
      id: workspace.workspaceId,
      path: workspace.path,
      title: workspace.title,
      sessionIds: [],
    })),
    get: (id) => {
      const workspace = workspaces.get(id);
      if (workspace === undefined) return undefined;
      return { id: workspace.workspaceId, path: workspace.path, title: workspace.title, sessionIds: [] };
    },
    async create(path, title) {
      const canonical = await canonicalize(path);
      // The real registry de-duplicates by path: registering the same directory
      // twice returns the existing workspace. A fake that always created a new
      // one would let a "register is idempotent" test pass while the real thing
      // behaved differently.
      for (const workspace of workspaces.values()) {
        if (samePath(workspace.path, canonical)) {
          if (title !== undefined) workspace.title = title;
          return { id: workspace.workspaceId, path: workspace.path, title: workspace.title, sessionIds: [] };
        }
      }
      const workspaceId = `ws-${workspaces.size + 1}`;
      workspaces.set(workspaceId, { workspaceId, path: canonical, title: title ?? 'workspace' });
      return { id: workspaceId, path: canonical, title: title ?? 'workspace', sessionIds: [] };
    },
  };

  const ctx = {
    get: (name) => {
      if (name === 'profileContext') return { dir: profileDir, name: options.profileName ?? 'fake' };
      if (name === 'pluginManager') return pluginManager;
      if (name === 'workspaceRegistry') return workspaceRegistry;
      if (name === 'agents') return { list: () => [...agents] };
      return undefined;
    },
    logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  };

  return {
    ctx,
    host: createHost(ctx),
    services: { pluginManager, workspaceRegistry },
    bundles,
    agents,
    calls,
    /**
     * Subscribe to enablement changes the way `plugin-manager/changed` does.
     * @param {(event: {name: string, enabled: boolean}) => void} listener
     */
    onPluginManagerChange(listener) {
      onPluginManagerChange = listener;
    },
    /**
     * Install a gate awaited before every native enable/disable.
     * @param {((event: {name: string, enabled: boolean}) => Promise<void>)|null} gate
     */
    gateSetBundleEnabled(gate) {
      gateSetEnabled = gate;
    },
    /**
     * Control what the next native install reports.
     *
     * The native `application` decides whether an install actually happened, so
     * the two accepted shapes differ on purpose:
     *
     * - an object is returned verbatim and *nothing* is installed. That is the
     *   real contract for `application: 'failed' | 'cancelled'`: such a package
     *   reaches neither the profile's dependencies nor its `node_modules`.
     * - a function receives the result of a real install and returns what to
     *   report instead, for outcomes that still install (e.g.
     *   `restart-required`).
     *
     * The override is one-shot, so the call after it takes the ordinary path -
     * which is exactly what a retry after a failure has to exercise.
     * @param {object|((installed: object) => object)|null} outcome
     */
    installBundleOutcome(outcome) {
      nextInstallOutcome = outcome;
    },
    workspace: {
      /** Register a directory as a workspace. @param {string} path @param {string} [title] */
      async add(path, title) {
        await mkdir(path, { recursive: true });
        const record = await workspaceRegistry.create(path, title);
        return { workspaceId: record.id, path: record.path, title: record.title };
      },
      root,
    },
    /** Pre-register an installed bundle. @param {string} name @param {string} version */
    async preinstall(name, version, enabled = false) {
      bundles.set(name, { name, version, enabled, installed: true, removable: true });
      const directory = join(profileDir, 'node_modules', ...name.split('/'));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }));
      packageDirs.set(name, directory);
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Write a minimal scaffold package directory.
 * @param {string} directory
 * @param {{name: string, version: string, scaffold?: object, files?: Record<string, string>}} input
 * @returns {Promise<string>}
 */
export async function writeScaffoldPackage(directory, input) {
  await mkdir(join(directory, 'templates'), { recursive: true });
  const manifest = {
    name: input.name,
    version: input.version,
    type: 'module',
    main: 'plugin.js',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...(input.scaffold === undefined ? {} : { workspaceScaffold: './scaffold.json' }),
  };
  await writeFile(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(directory, 'plugin.js'), 'export const name = 1;\n');
  await writeFile(
    join(directory, 'cordis.patch.yml'),
    `- insert:\n    - id: ${input.name}\n      name: ${input.name}\n      config: {}\n`,
  );
  if (input.scaffold !== undefined) {
    await writeFile(join(directory, 'scaffold.json'), `${JSON.stringify(input.scaffold, null, 2)}\n`);
  }
  for (const [relative, content] of Object.entries(input.files ?? {})) {
    const target = join(directory, ...relative.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}
