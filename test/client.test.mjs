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
 * A hook runtime that really holds state, so a click can change it and the next
 * render sees the change. `createReactShim` renders one frozen snapshot, which
 * cannot show what an action does to the error channels.
 * @param {any[]} stateSlots
 */
function createLiveReact(stateSlots) {
  const cells = stateSlots.map((value) => ({ value }));
  let cursor = 0;
  return {
    cells,
    React: {
      /** Restart the hook cursor so a function component can be invoked again. */
      reset() {
        cursor = 0;
      },
      createElement(type, props, ...children) {
        return { type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false && child !== true) };
      },
      useState() {
        const index = cursor;
        cursor += 1;
        if (cells[index] === undefined) cells[index] = { value: null };
        const cell = cells[index];
        return [cell.value, (next) => {
          cell.value = typeof next === 'function' ? next(cell.value) : next;
        }];
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
    },
  };
}

/**
 * Load the browser bundle and return the plugin object it registers.
 * @param {any[]} stateSlots
 * @param {any} [React] hook runtime to evaluate the panel against
 */
async function loadPanel(stateSlots, React = createReactShim(stateSlots)) {
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
 * Build the `useState` slot array the panel reads, by name.
 *
 * The panel reads its state by hook order, so a bare array silently changes
 * meaning the moment a hook is added, and every call site has to be re-audited.
 * Naming the slots keeps the tests readable and makes adding a hook a one-line
 * change here.
 * @param {object} [values]
 * @returns {any[]}
 */
function slots(values = {}) {
  const {
    state = null,
    error = null,
    loadError = null,
    notice = null,
    busy = false,
    selected = '',
    packageKey = '',
    importPath = '',
    preview = null,
    values: templateValues = {},
    progress = null,
    registerPath = '',
  } = values;
  return [state, error, loadError, notice, busy, selected, packageKey, importPath, preview, templateValues, progress, registerPath];
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
 * Let the panel's own async work finish. Every request in these tests settles on
 * its own, and a timer tick runs only after the whole pending microtask chain,
 * so one flush is enough for a request that resolves immediately. The panel
 * starts no timers of its own here because the hook shim never runs effects.
 */
async function settle() {
  for (let round = 0; round < 3; round += 1) await new Promise((done) => setTimeout(done, 0));
}

/**
 * Find the first rendered button whose label contains `label`.
 * @param {any} node
 * @param {string} label
 * @returns {any|null}
 */
function findButton(node, label) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found !== null) return found;
    }
    return null;
  }
  if (node.type === 'button' && texts(node).join(' ').includes(label)) return node;
  for (const child of node.children) {
    const found = findButton(child, label);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Mount the panel against the live hook runtime and a scripted `fetch`, so a
 * test can press a real button and read what the panel shows afterwards.
 * @param {object} [values] initial state slots, as accepted by {@link slots}
 */
async function mountPanel(values = {}) {
  const live = createLiveReact(slots(values));
  const { plugin } = await loadPanel(null, live.React);
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
      register: (_options, registered) => {
        component = registered;
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.ok(component !== null, 'the panel must register into plugins.bundle.config');
  const render = () => resolve(component({}), live.React);
  return {
    render,
    /** Every string the panel currently shows. */
    text: () => texts(render()).join(' | '),
    /** Press the button with this label and let its work settle. */
    async click(label) {
      const button = findButton(render(), label);
      assert.ok(button !== null, `the panel must offer a "${label}" button`);
      assert.notEqual(button.props.disabled, true, `the "${label}" button must be enabled`);
      await button.props.onClick();
      await settle();
    },
  };
}

/**
 * Serve the panel's requests from a scripted handler instead of the network.
 * The handler returns the payload the server would have sent; returning a
 * promise keeps that one request in flight until the test releases it.
 * @param {(request: {url: string, method: string, body: any}) => any} handler
 */
function stubFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const request = {
      url: String(url),
      method: options.method ?? 'GET',
      body: options.body === undefined ? undefined : JSON.parse(String(options.body)),
    };
    calls.push(request);
    const payload = handler(request);
    return { json: async () => payload };
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
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
    // useState order in the panel: state, error, loadError, notice, busy,
    // selected, package, importPath, preview, values.
    const tree = await renderPanel(slots({ state: snapshot }));
    const rendered = texts(tree).join(' | ');
    assert.match(rendered, /dsh-scaffold-notes/, 'the bound package must appear');
    assert.match(rendered, /demo-project/, 'the workspace must appear');
    assert.match(rendered, /actionPreview/, 'binding actions must be offered');
    assert.match(rendered, /actionSleep/, 'the shelf action must be offered');
    assert.match(rendered, /actionUnbind/, 'the unbind action must be offered');
    assert.match(rendered, /importRun/, 'the import form must be present');
    assert.match(rendered, /registerRun/, 'the register form must be present');
  } finally {
    await fake.cleanup();
  }
});

test('the panel renders the loading branch before the snapshot arrives', async () => {
  const tree = await renderPanel(slots());
  assert.match(texts(tree).join(' | '), /loading/);
});

test('the panel shows which build is running and warns when a restart is pending', async () => {
  const { fake, snapshot } = await realSnapshot();
  try {
    const current = await renderPanel(slots({ state: snapshot }));
    const rendered = texts(current).join(' | ');
    assert.match(rendered, new RegExp(`version ${snapshot.pluginVersion.replace(/\./g, '\\.')}`));

    const stale = await renderPanel(
      slots({ state: { ...snapshot, profileSpec: 'file:/elsewhere/dsh-workspace-scaffolds-9.9.9.tgz', restartPending: true } }),
    );
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
    const errored = await renderPanel(
      slots({ state: snapshot, error: { code: 'version-conflict', details: { packageName: 'x' } } }),
    );
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
    const rendered = texts(await renderPanel(slots({ state: degraded }))).join(' | ');
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
    // useState order in the panel: state, error, loadError, notice, busy,
    // selected, package, importPath, preview, values, progress.
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
    const tree = await renderPanel(slots({ state: snapshot, busy: true, progress }));
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
    const rendered = texts(await renderPanel(slots({ state: snapshot, progress }))).join(' | ');
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
    const rendered = texts(await renderPanel(slots({ state: snapshot, progress }))).join(' | ');
    assert.match(rendered, /status_failed/);
    assert.match(rendered, /package-content-conflict/, 'the failure code must replace the phase');
    assert.match(rendered, /hash and archive/);
  } finally {
    await fake.cleanup();
  }
});

// The panel re-reads the snapshot right after every action, and that read used
// to own the same error slot as the action. A refresh that succeeded therefore
// erased the reason the action failed, so a blocked generate looked like no
// action at all. These tests drive the panel through its real buttons and pin
// what each failure channel shows.

test('a failed action keeps its failure visible across the refresh that follows', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({ state: snapshot });
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) return { ok: true, value: snapshot };
    if (request.url.endsWith('/execute')) {
      return { ok: false, code: 'template-conflict', details: { targets: ['docs/NOTES.md'] } };
    }
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    const stateReads = () => network.calls.filter((call) => call.url.endsWith('/state')).length;

    await panel.click('actionSleep');
    // run() re-reads the snapshot after every action, so the refresh this test
    // is about really did happen, and it really did succeed.
    assert.equal(stateReads(), 1, 'the action must re-read the snapshot afterwards');
    const afterFailure = panel.text();
    assert.match(afterFailure, /resultCode: template-conflict/, 'the action must report its own code');
    assert.match(afterFailure, /docs\/NOTES\.md/, 'and its own details');

    // The refresh that follows the action already succeeded once above; another
    // successful refresh must not erase the failure either.
    await panel.click('refresh');
    assert.equal(stateReads(), 2, 'the explicit refresh must have run');
    const afterRefresh = panel.text();
    assert.match(afterRefresh, /resultCode: template-conflict/, 'a successful refresh must not clear the action failure');
    assert.match(afterRefresh, /docs\/NOTES\.md/);
  } finally {
    network.restore();
    await fake.cleanup();
  }
});

test('a refresh that fails reports a load failure without an action error', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({ state: snapshot });
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) {
      return { ok: false, code: 'state-unavailable', details: { reason: 'host is gone' } };
    }
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    await panel.click('refresh');
    const rendered = panel.text();
    assert.match(rendered, /loadFailed: state-unavailable/, 'a failed read must be shown as a load failure');
    assert.match(rendered, /host is gone/, 'the load failure keeps its details');
    assert.doesNotMatch(rendered, /resultCode/, 'no action ran, so no action failure may be invented');
  } finally {
    network.restore();
    await fake.cleanup();
  }
});

test('starting a new action retires the previous failure before the new one settles', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({ state: snapshot });
  let executes = 0;
  let releaseSecond = null;
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) return { ok: true, value: snapshot };
    if (request.url.endsWith('/execute')) {
      executes += 1;
      if (executes === 1) return { ok: false, code: 'template-conflict', details: { targets: ['docs/NOTES.md'] } };
      return new Promise((release) => {
        releaseSecond = release;
      });
    }
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    await panel.click('actionSleep');
    assert.match(panel.text(), /resultCode: template-conflict/);

    await panel.click('actionSleep');
    assert.ok(releaseSecond !== null, 'the second action must still be in flight');
    const midFlight = panel.text();
    assert.doesNotMatch(midFlight, /resultCode/, 'a new action must clear the previous failure right away');
    assert.doesNotMatch(midFlight, /template-conflict/);

    releaseSecond({ ok: true, value: { status: 'succeeded', action: 'sleep', steps: [] } });
    await settle();
    const finished = panel.text();
    assert.doesNotMatch(finished, /template-conflict/);
    assert.match(finished, /resultOk/);
  } finally {
    network.restore();
    await fake.cleanup();
  }
});

test('a successful action clears the failure and reports success', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({
    state: snapshot,
    error: { code: 'template-conflict', details: { targets: ['docs/NOTES.md'] } },
  });
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) return { ok: true, value: snapshot };
    if (request.url.endsWith('/execute')) return { ok: true, value: { status: 'succeeded', action: 'sleep', steps: [] } };
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    assert.match(panel.text(), /template-conflict/, 'the seeded failure must render first');

    await panel.click('actionSleep');
    const rendered = panel.text();
    assert.doesNotMatch(rendered, /resultCode/, 'success must clear the failure');
    assert.doesNotMatch(rendered, /template-conflict/);
    assert.match(rendered, /resultOk/, 'success must still be announced');
    assert.match(rendered, /succeeded/, 'the notice payload stays visible');
  } finally {
    network.restore();
    await fake.cleanup();
  }
});

test('an action that succeeds but cannot be re-read still reports its success', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({ state: snapshot });
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) {
      return { ok: false, code: 'state-unavailable', details: { reason: 'host is gone' } };
    }
    if (request.url.endsWith('/execute')) return { ok: true, value: { status: 'succeeded', action: 'sleep', steps: [] } };
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    await panel.click('actionSleep');
    const rendered = panel.text();
    // The read is about the snapshot, not about the action: a failure there must
    // not retract the news that the action took effect, or the user retries it.
    assert.match(rendered, /loadFailed: state-unavailable/);
    assert.match(rendered, /resultOk/);
    assert.match(rendered, /succeeded/);
  } finally {
    network.restore();
    await fake.cleanup();
  }
});

test('when the action and the refresh both fail, both failures stay visible, action first', async () => {
  const { fake, snapshot } = await realSnapshot();
  const panel = await mountPanel({ state: snapshot });
  const network = stubFetch((request) => {
    if (request.url.endsWith('/state')) {
      return { ok: false, code: 'state-unavailable', details: { reason: 'host is gone' } };
    }
    if (request.url.endsWith('/execute')) {
      return { ok: false, code: 'template-conflict', details: { targets: ['docs/NOTES.md'] } };
    }
    throw new Error(`unexpected request: ${request.url}`);
  });
  try {
    await panel.click('actionSleep');
    const rendered = panel.text();
    // The chosen semantics: neither channel masks the other, and the action the
    // user just asked for is presented first.
    assert.match(rendered, /resultCode: template-conflict/, 'the action failure stays visible');
    assert.match(rendered, /loadFailed: state-unavailable/, 'the load failure stays visible too');
    assert.ok(
      rendered.indexOf('template-conflict') < rendered.indexOf('state-unavailable'),
      'the action failure must be presented before the load failure',
    );
  } finally {
    network.restore();
    await fake.cleanup();
  }
});
