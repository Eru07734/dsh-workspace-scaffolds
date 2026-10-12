/**
 * Progress reporting: a long operation has to be observable *while* it runs,
 * because that is the only time a viewer needs it. These tests assert the shape
 * a progress view polls, not merely that the call eventually returns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Progress } from '../src/progress.js';
import { Store } from '../src/store.js';
import { API_PREFIX } from '../src/api.js';
import { apply } from '../index.js';
import { createFakeHost, writeScaffoldPackage } from './helpers/fake-host.mjs';
import { newId } from '../src/util.js';

/** Build one notes scaffold package on disk. @param {string} root */
async function notesPackage(root) {
  return await writeScaffoldPackage(join(root, 'pkg-notes'), {
    name: 'dsh-scaffold-notes',
    version: '0.1.0',
    scaffold: {
      schemaVersion: 1,
      title: 'Project notes',
      variables: { projectName: { type: 'string', required: true } },
      templates: [
        { id: 'notes', files: [{ source: 'templates/NOTES.md', target: 'docs/NOTES.md', render: 'text' }] },
      ],
    },
    files: { 'templates/NOTES.md': '# {{projectName}}\n\nScaffolded notes.\n' },
  });
}

/** @param {(fake: object) => Promise<void>} [prepare] */
async function setup(prepare) {
  const fake = await createFakeHost();
  if (prepare !== undefined) await prepare(fake);
  const store = new Store(fake.host.storageDir);
  await store.init();
  const activity = new Activity(fake.host);
  const operations = new Operations({ host: fake.host, store, activity });
  operations.init();
  return { fake, operations, store };
}

/**
 * A context that captures what `apply` mounts. Built on the fake host's own
 * services so `bootstrap()` can actually run, exactly as the real mount does.
 * @param {object} fake
 */
function captureContext(fake) {
  const routes = [];
  const state = { provided: null, tool: null, listeners: new Map() };
  const ctx = {
    get: fake.ctx.get,
    logger: fake.ctx.logger,
    connection: { fetch: { register: (route) => routes.push(route) } },
    tools: {
      register: (tool) => {
        state.tool = tool;
      },
    },
    provide(name, value) {
      state.provided = { name, value };
    },
    effect(fn) {
      return fn();
    },
    on(event, handler) {
      state.listeners.set(event, handler);
      return () => {};
    },
  };
  return { ctx, routes, state };
}

test('the registry records a plan, advances steps, and keeps a finished summary', () => {
  const progress = new Progress();
  progress.begin('op-1', 'import', ['one', 'two']);
  let entry = progress.get('op-1');
  assert.equal(entry.status, 'running');
  assert.deepEqual(entry.steps.map((step) => step.status), ['pending', 'pending']);

  progress.activate('op-1', 'one');
  entry = progress.get('op-1');
  assert.deepEqual(entry.steps.map((step) => step.status), ['active', 'pending']);
  assert.equal(entry.phase, 'one');

  progress.complete('op-1', 'one', { detail: 'fine' });
  progress.activate('op-1', 'two');
  entry = progress.get('op-1');
  assert.deepEqual(entry.steps.map((step) => step.status), ['done', 'active']);

  progress.finish('op-1', { ok: true, result: { packageKey: 'x@1' } });
  entry = progress.get('op-1');
  assert.equal(entry.status, 'succeeded');
  assert.deepEqual(entry.steps.map((step) => step.status), ['done', 'done']);
  assert.deepEqual(entry.result, { packageKey: 'x@1' });
  assert.equal(entry.finishedAt !== null, true);
});

test('a failed operation marks the remaining steps failed and keeps the code', () => {
  const progress = new Progress();
  progress.begin('op-2', 'wake', ['plan', 'enable', 'commit']);
  progress.activate('op-2', 'enable');
  progress.finish('op-2', { ok: false, code: 'native-operation-failed', details: { packageName: 'x' } });
  const entry = progress.get('op-2');
  assert.equal(entry.status, 'failed');
  assert.deepEqual(entry.steps.map((step) => step.status), ['done', 'failed', 'failed']);
  assert.equal(entry.error.code, 'native-operation-failed');
  assert.deepEqual(entry.error.details, { packageName: 'x' });
});

test('callers cannot mutate the tracked entry through a snapshot', () => {
  const progress = new Progress();
  progress.begin('op-3', 'sleep', ['plan']);
  const snapshot = progress.get('op-3');
  snapshot.steps[0].status = 'done';
  snapshot.status = 'succeeded';
  const fresh = progress.get('op-3');
  assert.equal(fresh.steps[0].status, 'pending');
  assert.equal(fresh.status, 'running');
});

test('steps added during the run are appended and appear in the snapshot', () => {
  const progress = new Progress();
  progress.begin('op-4', 'wake', ['plan packages', 'commit intent']);
  progress.activate('op-4', 'plan packages');
  progress.addStep('op-4', 'enable a');
  progress.addStep('op-4', 'enable b');
  progress.complete('op-4', 'enable a', { detail: 'applied' });
  const entry = progress.get('op-4');
  assert.deepEqual(
    entry.steps.map((step) => [step.label, step.status]),
    [
      ['plan packages', 'active'],
      ['commit intent', 'pending'],
      ['enable a', 'done'],
      ['enable b', 'pending'],
    ],
  );
});

test('an import reports progress through its phases while it runs', async () => {
  const { fake, operations } = await setup();
  try {
    const packageDir = await notesPackage(fake.workspace.root);
    // Watch the registry from inside the install, which is the only moment a
    // viewer of a running import can observe it.
    let during = null;
    const realInstall = fake.host.installBundle.bind(fake.host);
    fake.host.installBundle = async (path, options) => {
      during = operations.progress.snapshot();
      return await realInstall(path, options);
    };

    const state = await operations.execute({ action: 'list' });
    const operationId = newId();
    await operations.execute({ action: 'import', path: packageDir, operationId, expectedRevision: state.revision });

    assert.ok(during !== null, 'expected to observe the registry during the install');
    const running = during.running.find((entry) => entry.operationId === operationId);
    assert.ok(running !== undefined, 'the running import must be listed as running');
    assert.equal(running.action, 'import');
    assert.equal(running.status, 'running');
    const byLabel = new Map(running.steps.map((step) => [step.label, step.status]));
    assert.equal(byLabel.get('validate package'), 'done');
    assert.equal(byLabel.get('install without enabling'), 'active');
    assert.equal(byLabel.get('record in warehouse'), 'pending');

    const after = await operations.execute({ action: 'progress' });
    const finished = after.recent.find((entry) => entry.operationId === operationId);
    assert.ok(finished !== undefined, 'a finished operation must remain inspectable');
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.result.installOutcome, 'applied');
    assert.deepEqual(finished.steps.map((step) => step.status), finished.steps.map(() => 'done'));
  } finally {
    await fake.cleanup();
  }
});

test('operation-status answers for an operation that is still running', async () => {
  const { fake, operations } = await setup();
  try {
    const packageDir = await notesPackage(fake.workspace.root);
    const state = await operations.execute({ action: 'list' });
    const operationId = newId();

    let status = null;
    const realInstall = fake.host.installBundle.bind(fake.host);
    fake.host.installBundle = async (path, options) => {
      // No durable log entry exists yet, so this must come from live progress.
      status = await operations.execute({ action: 'operation-status', operationId });
      return await realInstall(path, options);
    };

    await operations.execute({ action: 'import', path: packageDir, operationId, expectedRevision: state.revision });
    assert.equal(status?.status, 'running');
    assert.equal(status?.action, 'import');
    assert.equal(status?.progress.status, 'running');

    const later = await operations.execute({ action: 'operation-status', operationId });
    assert.equal(later.status, 'committed');
  } finally {
    await fake.cleanup();
  }
});

test('background mode answers immediately and the work still commits', async () => {
  const { fake, operations } = await setup();
  try {
    const packageDir = await notesPackage(fake.workspace.root);
    const state = await operations.execute({ action: 'list' });
    const operationId = newId();

    const ack = await operations.execute({
      action: 'import',
      path: packageDir,
      operationId,
      expectedRevision: state.revision,
      background: true,
    });
    assert.equal(ack.status, 'running');
    assert.equal(ack.background, true);
    assert.equal(ack.operationId, operationId);
    // A caller must be able to poll from the acknowledgement alone.
    assert.equal(ack.progress.operationId, operationId);

    let entry = operations.progress.get(operationId);
    for (let attempt = 0; attempt < 400 && entry !== null && entry.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      entry = operations.progress.get(operationId);
    }
    assert.equal(entry.status, 'succeeded');
    const listed = await operations.execute({ action: 'list' });
    assert.ok(listed.packages.some((row) => row.key === 'dsh-scaffold-notes@0.1.0'));
  } finally {
    await fake.cleanup();
  }
});

test('GET /progress returns the registry and one operation on request', async () => {
  const fake = await createFakeHost();
  try {
    const { ctx, routes } = captureContext(fake);
    apply(ctx);
    const route = routes.find((entry) => entry.path === `${API_PREFIX}/progress`);
    assert.ok(route !== undefined, 'expected GET /progress to be mounted');

    const all = await (await route.fetch(new Request('http://localhost/progress'))).json();
    assert.equal(all.ok, true);
    assert.ok(Array.isArray(all.value.running));
    assert.ok(Array.isArray(all.value.recent));

    const missing = await (await route.fetch(new Request('http://localhost/progress?operationId=nope'))).json();
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'package-unknown');
  } finally {
    await fake.cleanup();
  }
});

test('the full state payload carries progress so one poll is enough', async () => {
  const { fake, operations } = await setup();
  try {
    const listed = await operations.execute({ action: 'list' });
    assert.ok(listed.progress !== undefined);
    assert.ok(Array.isArray(listed.progress.running));
    assert.ok(Array.isArray(listed.progress.recent));
  } finally {
    await fake.cleanup();
  }
});
