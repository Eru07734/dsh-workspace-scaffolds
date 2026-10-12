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
import { extractLocales, serializeLocale } from '../scripts/locales.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, '..');
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

test('the generated locale files match what the bundle actually registers', async () => {
  // The host loads locale/*.json while client.js holds the source of truth, so
  // the two can drift without anything failing. Generating them from the real
  // bundle and asserting here is what keeps a new label from shipping untranslated.
  const locales = await extractLocales();
  for (const language of ['zh', 'en']) {
    const target = join(root, 'locale', `${language}.json`);
    const onDisk = await readFile(target, 'utf8').catch(() => null);
    assert.ok(onDisk !== null, `locale/${language}.json must exist`);
    assert.equal(
      onDisk,
      serializeLocale(locales[language]),
      `locale/${language}.json is out of date; run: node scripts/locales.mjs`,
    );
  }
  const zhKeys = Object.keys(locales.zh).sort();
  const enKeys = Object.keys(locales.en).sort();
  assert.deepEqual(zhKeys, enKeys, 'both languages must define the same keys');
});

test('progress labels are translated, not left as raw keys', async () => {
  const locales = await extractLocales();
  for (const key of ['stepPending', 'stepActive', 'stepDone', 'stepFailed', 'stepSkipped']) {
    assert.equal(typeof locales.zh[key], 'string', `zh must define ${key}`);
    assert.equal(typeof locales.en[key], 'string', `en must define ${key}`);
  }
  for (const key of ['status_running', 'status_succeeded', 'status_failed']) {
    assert.equal(typeof locales.zh[key], 'string', `zh must define ${key}`);
    assert.equal(typeof locales.en[key], 'string', `en must define ${key}`);
  }
});

test('the panel shows the steps of a running operation, not just a spinner', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    // useState order in the panel: state, error, notice, busy, selected, package,
    // importPath, preview, values, progress.
    const progress = {
      running: [
        {
          operationId: 'op-running',
          action: 'import',
          status: 'running',
          phase: 'install without enabling',
          startedAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:01.000Z',
          finishedAt: null,
          error: null,
          result: null,
          steps: [
            { label: 'validate package', status: 'done', detail: 'dsh-scaffold-notes@0.1.0' },
            { label: 'install without enabling', status: 'active' },
            { label: 'record in warehouse', status: 'pending' },
          ],
        },
      ],
      recent: [],
    };
    const tree = await renderPanel([snapshot, null, null, true, '', '', '', null, {}, progress]);
    const rendered = texts(tree).join(' | ');
    assert.match(rendered, /status_running/, 'the running state must be labelled');
    assert.match(rendered, /import/, 'the action must be named');
    assert.match(rendered, /install without enabling/, 'the current phase must be shown');
    assert.match(rendered, /validate package/, 'completed steps must be listed');
    assert.match(rendered, /record in warehouse/, 'pending steps must be listed');
    assert.match(rendered, /dsh-scaffold-notes@0\.1\.0/, 'step detail must be shown');
  } finally {
    await fake.cleanup();
  }
});

test('the panel falls back to the last finished operation when nothing is running', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const progress = {
      running: [],
      recent: [
        {
          operationId: 'op-done',
          action: 'wake',
          status: 'succeeded',
          phase: 'done',
          startedAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:02.000Z',
          finishedAt: '2026-10-12T00:00:02.000Z',
          error: null,
          result: { steps: 2 },
          steps: [{ label: 'enable dsh-scaffold-notes', status: 'done', detail: 'applied' }],
        },
      ],
    };
    const rendered = texts(await renderPanel([snapshot, null, null, false, '', '', '', null, {}, progress])).join(' | ');
    assert.match(rendered, /status_succeeded/);
    assert.match(rendered, /enable dsh-scaffold-notes/);
  } finally {
    await fake.cleanup();
  }
});

test('a failed step is rendered as failed with its error code', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const progress = {
      running: [],
      recent: [
        {
          operationId: 'op-failed',
          action: 'import',
          status: 'failed',
          phase: 'failed',
          startedAt: '2026-10-12T00:00:00.000Z',
          updatedAt: '2026-10-12T00:00:02.000Z',
          finishedAt: '2026-10-12T00:00:02.000Z',
          error: { code: 'package-content-conflict', details: {} },
          result: null,
          steps: [
            { label: 'validate package', status: 'done' },
            { label: 'hash and archive', status: 'failed', detail: 'hash mismatch' },
          ],
        },
      ],
    };
    const rendered = texts(await renderPanel([snapshot, null, null, false, '', '', '', null, {}, progress])).join(' | ');
    assert.match(rendered, /status_failed/);
    assert.match(rendered, /package-content-conflict/, 'the failure code must replace the phase');
    assert.match(rendered, /hash and archive/);
  } finally {
    await fake.cleanup();
  }
});
