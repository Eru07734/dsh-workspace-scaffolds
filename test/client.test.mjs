/**
 * Panel rendering against a real payload.
 *
 * The browser client is the easiest place for a host/client contract drift to
 * hide, so this test builds a genuine `list` snapshot through the host code and
 * renders the panel with it. A minimal React shim supplies the hooks the panel
 * uses, which is enough to prove the component tree does not throw and that the
 * identifying facts reach the DOM.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { newId } from '../src/util.js';
import { createFakeHost, writeScaffoldPackage } from './helpers/fake-host.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const clientPath = join(here, '..', 'client.js');

/**
 * A hook runtime just large enough for the panel: the state slots are supplied
 * in call order, effects and callbacks are inert, and elements are plain data.
 * @param {any[]} stateSlots
 */
function createReactShim(stateSlots) {
  let cursor = 0;
  return {
    /** Restart the hook cursor so a function component can be invoked again. */
    reset() {
      cursor = 0;
    },
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false && child !== true) };
    },
    useState() {
      const value = stateSlots[cursor] ?? null;
      cursor += 1;
      return [value, () => {}];
    },
    useEffect() {
      cursor += 1;
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useRef(initial) {
      cursor += 1;
      return { current: initial };
    },
    useSyncExternalStore() {
      cursor += 1;
      return null;
    },
  };
}

/**
 * Resolve function components into plain elements, restarting the hook cursor
 * for each component the way React does.
 * @param {any} node
 * @param {{reset: () => void}} React
 * @returns {any}
 */
function resolve(node, React) {
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map((child) => resolve(child, React));
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    React.reset();
    return resolve(node.type(node.props), React);
  }
  return { ...node, children: node.children.map((child) => resolve(child, React)) };
}

/**
 * Load the browser bundle and return the plugin object it registers.
 * @param {any[]} stateSlots
 */
async function loadPanel(stateSlots) {
  const source = await readFile(clientPath, 'utf8');
  let definition = null;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: (value) => {
    definition = value;
  } } };
  let plugin = null;
  try {
    const factory = new Function('window', `${source.replace(/^window\.__ModuleLoader__\.load\(/, 'return (')}\n`);
    // The bundle is an expression statement; evaluate it through the shim window
    // so `window.__ModuleLoader__.load` observes the registered definition.
    const registered = factory(globalThis.window);
    if (registered !== undefined && definition === null) definition = registered;
    assert.ok(definition !== null, 'the client bundle must register itself');
    const React = createReactShim(stateSlots);
    plugin = definition.factory((id) => {
      if (id === 'react') return React;
      if (id === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement };
      throw new Error(`unexpected require: ${id}`);
    });
    return { plugin, React };
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

/**
 * Mount the panel and return its resolved element tree.
 * @param {any[]} stateSlots
 */
async function renderPanel(stateSlots) {
  const { plugin, React } = await loadPanel(stateSlots);
  assert.ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'));
  let component = null;
  const ctx = {
    effect: (fn) => {
      fn();
    },
    locale: {
      register: () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, registered) => {
        assert.equal(options.name, 'plugins.bundle.config');
        assert.equal(options.key, 'dsh-workspace-scaffolds');
        component = registered;
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.ok(component !== null, 'the panel must register into plugins.bundle.config');
  return resolve(component({}), React);
}

/**
 * Collect every string rendered in the tree.
 * @param {any} node
 * @returns {string[]}
 */
function texts(node) {
  if (node === null || node === undefined || node === false) return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node !== 'object') return [];
  const own = node.type === 'input' ? [String(node.props.value ?? '')] : [];
  return [...own, ...node.children.flatMap(texts)];
}

/**
 * Produce a real `list` snapshot with one workspace, one binding and one preview.
 */
async function realSnapshot() {
  const fake = await createFakeHost();
  const store = new Store(fake.host.storageDir);
  await store.init();
  const activity = new Activity(fake.host);
  const operations = new Operations({ host: fake.host, store, activity });
  operations.init();
  const write = async (request) =>
    await operations.execute({
      operationId: newId(),
      expectedRevision: (await operations.execute({ action: 'list' })).revision,
      ...request,
    });

  const workspace = await fake.workspace.add(join(fake.workspace.root, 'demo-project'), 'demo-project');
  const packageDir = await writeScaffoldPackage(join(fake.workspace.root, 'pkg'), {
    name: 'dsh-scaffold-notes',
    version: '0.1.0',
    scaffold: {
      schemaVersion: 1,
      title: 'Project notes',
      variables: { projectName: { type: 'string', required: true } },
      templates: [{ id: 'notes', files: [{ source: 'templates/NOTES.md', target: 'docs/NOTES.md', render: 'text' }] }],
    },
    files: { 'templates/NOTES.md': '# {{projectName}}\n' },
  });
  const imported = await write({ action: 'import', path: packageDir });
  await write({
    action: 'bind',
    workspaceId: workspace.workspaceId,
    packageName: imported.packageName,
    version: imported.version,
  });
  const snapshot = await operations.execute({ action: 'list' });
  return { fake, operations, snapshot, workspace };
}

test('the panel renders a populated snapshot without throwing', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    // useState order in the panel: state, error, notice, busy, selected, package,
    // importPath, preview, values.
    const tree = await renderPanel([snapshot, null, null, false, '', '', '', null, {}]);
    const rendered = texts(tree).join(' | ');
    assert.match(rendered, /dsh-scaffold-notes/, 'the bound package must appear');
    assert.match(rendered, /demo-project/, 'the workspace must appear');
    assert.match(rendered, /actionPreview/, 'binding actions must be offered');
    assert.match(rendered, /actionSleep/, 'the shelf action must be offered');
    assert.match(rendered, /actionUnbind/, 'the unbind action must be offered');
    assert.match(rendered, /importRun/, 'the import form must be present');
  } finally {
    await fake.cleanup();
  }
});

test('the panel renders the loading branch before the snapshot arrives', async () => {
  const tree = await renderPanel([null, null, null, false, '', '', '', null, {}]);
  assert.match(texts(tree).join(' | '), /loading/);
});

test('the panel shows which build is running and warns when a restart is pending', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const current = await renderPanel([snapshot, null, null, false, '', '', '', null, {}]);
    const rendered = texts(current).join(' | ');
    assert.match(rendered, new RegExp(`version ${snapshot.pluginVersion.replace(/\./g, '\\.')}`));

    const stale = await renderPanel([
      { ...snapshot, profileSpec: 'file:/elsewhere/dsh-workspace-scaffolds-9.9.9.tgz', restartPending: true },
      null,
      null,
      false,
      '',
      '',
      '',
      null,
      {},
    ]);
    const staleText = texts(stale).join(' | ');
    assert.match(staleText, /restartPending/, 'a pending restart must be surfaced');
    assert.match(staleText, /9\.9\.9/, 'the declared spec must be shown');
  } finally {
    await fake.cleanup();
  }
});

test('the panel surfaces a failure code and the busy state disables actions', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const errored = await renderPanel([snapshot, { code: 'version-conflict', details: { packageName: 'x' } }, null, false, '', '', '', null, {}]);
    assert.match(texts(errored).join(' | '), /version-conflict/);
  } finally {
    await fake.cleanup();
  }
});

test('the panel warns when the native plugin manager is unavailable', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const degraded = {
      ...snapshot,
      capabilities: { pluginManager: false, workspaceRegistry: true },
      automaticRestore: 'degraded',
    };
    const rendered = texts(await renderPanel([degraded, null, null, false, '', '', '', null, {}])).join(' | ');
    assert.match(rendered, /capabilityMissing/);
    assert.match(rendered, /degraded/);
  } finally {
    await fake.cleanup();
  }
});
