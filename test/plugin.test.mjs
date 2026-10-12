/**
 * Plugin wiring: `apply()` against a fake context, the HTTP routes it mounts,
 * the tool it registers, the lifecycle subscriptions it takes, and teardown.
 *
 * This exercises `index.js` itself rather than the operations layer, so a
 * broken mount or a missing disposer is caught here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { apply, inject, name } from '../index.js';
import { API_PREFIX } from '../src/api.js';
import { CODES } from '../src/errors.js';
import { newId } from '../src/util.js';
import { TOOL_NAME } from '../src/tool.js';
import { createFakeHost, writeScaffoldPackage } from './helpers/fake-host.mjs';

/**
 * Mount the plugin on a fake context.
 * @param {object} fake
 */
function mount(fake) {
  const routes = [];
  const tools = [];
  const listeners = new Map();
  const disposers = [];
  const provided = new Map();
  const ctx = {
    get: fake.ctx.get,
    logger: fake.ctx.logger,
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route);
          return () => {};
        },
      },
    },
    tools: {
      register: (definition) => {
        tools.push(definition);
        return () => {};
      },
    },
    on: (event, handler) => {
      listeners.set(event, handler);
      return () => {};
    },
    effect: (fn) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
      return disposer;
    },
    provide: (key, value) => {
      provided.set(key, value);
    },
  };
  apply(ctx);
  return { routes, tools, listeners, disposers, provided, ctx };
}

test('the plugin declares a stable name and the services it cannot run without', () => {
  assert.equal(name, 'workspace-scaffolds');
  assert.deepEqual(inject, ['connection', 'tools']);
});

test('apply mounts the routes, the tool, and the lifecycle listeners', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    assert.deepEqual(
      mounted.routes.map((route) => route.path).sort(),
      [`${API_PREFIX}/execute`, `${API_PREFIX}/progress`, `${API_PREFIX}/state`],
    );
    assert.equal(mounted.routes.find((route) => route.path.endsWith('/execute')).methods[0], 'POST');
    // Progress is readable with a plain GET so a viewer can poll it cheaply.
    assert.equal(mounted.routes.find((route) => route.path.endsWith('/progress')).methods[0], 'GET');
    assert.equal(mounted.tools.length, 1);
    assert.equal(mounted.tools[0].name, TOOL_NAME);
    assert.ok(mounted.provided.has('workspaceScaffolds'));
    for (const event of ['agent/created', 'agent/status', 'agent/disposed', 'plugin-manager/changed']) {
      assert.ok(mounted.listeners.has(event), `expected a listener for ${event}`);
    }
  } finally {
    await fake.cleanup();
  }
});

test('GET /state answers with an ok envelope', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const route = mounted.routes.find((entry) => entry.path === `${API_PREFIX}/state`);
    const response = await route.fetch(new Request('http://localhost/state'));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.value.revision, 'number');
    assert.equal(body.value.capabilities.pluginManager, true);
  } finally {
    await fake.cleanup();
  }
});

test('POST /execute runs an action and rejects malformed input with 400', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const route = mounted.routes.find((entry) => entry.path === `${API_PREFIX}/execute`);

    const list = await (await route.fetch(jsonRequest({ action: 'list' }))).json();
    assert.equal(list.ok, true);
    const revision = list.value.revision;

    const workspace = await fake.workspace.add(join(fake.workspace.root, 'demo'), 'demo');
    const packageDir = await writeScaffoldPackage(join(fake.workspace.root, 'pkg'), {
      name: 'dsh-scaffold-notes',
      version: '0.1.0',
      scaffold: { schemaVersion: 1, templates: [] },
    });
    const imported = await (
      await route.fetch(jsonRequest({ action: 'import', path: packageDir, operationId: 'op-1', expectedRevision: revision }))
    ).json();
    assert.equal(imported.ok, true);

    const bound = await (
      await route.fetch(
        jsonRequest({
          action: 'bind',
          workspaceId: workspace.workspaceId,
          packageName: imported.value.packageName,
          version: imported.value.version,
          operationId: 'op-2',
          expectedRevision: revision + 1,
        }),
      )
    ).json();
    assert.equal(bound.ok, true);
    assert.equal(bound.value.packageKey, 'dsh-scaffold-notes@0.1.0');

    const stale = await route.fetch(jsonRequest({ action: 'sleep', workspaceId: workspace.workspaceId, operationId: 'op-3', expectedRevision: revision }));
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.ok, false);
    assert.equal(staleBody.code, CODES.revisionConflict);

    const malformed = await route.fetch(
      new Request('http://localhost/execute', { method: 'POST', body: '{ not json', headers: { 'Content-Type': 'application/json' } }),
    );
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, CODES.invalidRequest);
  } finally {
    await fake.cleanup();
  }
});

test('an unknown action over HTTP is a 400, not a crash', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const route = mounted.routes.find((entry) => entry.path === `${API_PREFIX}/execute`);
    const response = await route.fetch(jsonRequest({ action: 'nope' }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, CODES.invalidRequest);
  } finally {
    await fake.cleanup();
  }
});

test('the tool mounted by apply resolves the session workspace through its facade', async () => {
  const fake = await createFakeHost();
  try {
    const projectDir = join(fake.workspace.root, 'demo');
    const workspace = await fake.workspace.add(projectDir, 'demo');
    const mounted = mount(fake);
    const tool = mounted.tools.find((definition) => definition.name === TOOL_NAME);
    assert.ok(tool !== undefined, 'apply must register the agent tool');

    const exec = { agent: { session: { header: { cwd: projectDir } } } };
    const listed = await tool.execute({ action: 'list' }, exec);
    assert.equal(listed.ok, true, `list failed: ${listed.code} ${JSON.stringify(listed.details)}`);

    // Omitting workspaceId is the documented default and the path an agent
    // actually takes, so it has to work through the *real* facade rather than
    // through a directly injected operations instance. Injecting the instance
    // is what let a missing facade method ship.
    const resolved = await tool.execute({ action: 'sleep', expectedRevision: listed.value.revision }, exec);
    assert.equal(resolved.ok, true, `sleep failed: ${resolved.code} ${JSON.stringify(resolved.details)}`);
    assert.equal(resolved.resolvedWorkspaceId, workspace.workspaceId);
  } finally {
    await fake.cleanup();
  }
});

test('automatic restore records the workspace even when the bundle is already on', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const api = mounted.provided.get('workspaceScaffolds');
    const revision = async () => (await api.execute({ action: 'list' })).revision;

    const dirA = join(fake.workspace.root, 'shared-holder');
    const dirB = join(fake.workspace.root, 'shared-joiner');
    const a = await fake.workspace.add(dirA, 'holder');
    const b = await fake.workspace.add(dirB, 'joiner');
    const packageDir = await writeScaffoldPackage(join(fake.workspace.root, 'pkg'), {
      name: 'dsh-scaffold-notes',
      version: '0.1.0',
      scaffold: {
        schemaVersion: 1,
        title: 'Notes',
        variables: { projectName: { type: 'string', required: true } },
        templates: [{ id: 'notes', files: [{ source: 'templates/N.md', target: 'docs/N.md', render: 'text' }] }],
      },
      files: { 'templates/N.md': '# {{projectName}}\n' },
    });
    const imported = await api.execute({
      action: 'import',
      path: packageDir,
      operationId: newId(),
      expectedRevision: await revision(),
    });
    for (const workspaceId of [a.workspaceId, b.workspaceId]) {
      await api.execute({
        action: 'bind',
        workspaceId,
        packageName: imported.packageName,
        version: imported.version,
        operationId: newId(),
        expectedRevision: await revision(),
      });
    }

    // A wakes the shared bundle; B is still recorded as sleeping.
    await api.execute({
      action: 'wake',
      workspaceId: a.workspaceId,
      operationId: newId(),
      expectedRevision: await revision(),
    });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    // An agent starts in B. The bundle is already on, so nothing needs enabling -
    // but B must still be recorded as awake and holding it, or A's shelf will
    // take the bundle away from the agent that just started here.
    const handler = mounted.listeners.get('agent/created');
    await handler({ agent: { id: 'agent-b', session: { header: { cwd: dirB } } } });

    let listed = await api.execute({ action: 'list' });
    const recordB = listed.workspaces.find((row) => row.workspaceId === b.workspaceId);
    assert.equal(recordB.requestedState, 'awake', 'the automatically restored workspace must be awake');
    assert.equal(recordB.ready, true);
    const pkg = listed.packages.find((row) => row.key === imported.packageKey);
    assert.deepEqual(
      [...pkg.holders].sort(),
      [a.workspaceId, b.workspaceId].sort(),
      'both workspaces must hold the shared bundle',
    );

    // The payoff: shelving the first workspace must leave the bundle running for
    // the second one.
    const slept = await api.execute({
      action: 'sleep',
      workspaceId: a.workspaceId,
      operationId: newId(),
      expectedRevision: await revision(),
    });
    assert.deepEqual(slept.release.released, []);
    assert.equal(slept.release.kept[0].reason, 'other-workspace');
    assert.equal(
      fake.bundles.get('dsh-scaffold-notes').enabled,
      true,
      'a shelf must not disable a bundle another workspace still needs',
    );

    listed = await api.execute({ action: 'list' });
    assert.equal(listed.workspaces.find((row) => row.workspaceId === b.workspaceId).ready, true);
  } finally {
    await fake.cleanup();
  }
});

test('the agent/created listener tolerates an agent without a workspace', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const handler = mounted.listeners.get('agent/created');
    // No session header at all: this must resolve to "no workspace" and return,
    // not throw, so agent creation is never failed by this plugin.
    await handler({ agent: { id: 'a1' } });
    await handler({ agent: { id: 'a2', session: { header: { cwd: join(fake.workspace.root, 'unregistered') } } } });
  } finally {
    await fake.cleanup();
  }
});

test('the agent/status listener tracks running work', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const handler = mounted.listeners.get('agent/status');
    const agent = { id: 'a1', status: 'running' };
    fake.agents.push(agent);
    handler({ agent, status: 'running' });
    const snapshot = await mounted.provided.get('workspaceScaffolds').execute({ action: 'list' });
    assert.equal(snapshot.runningAgents, true);
    agent.status = 'idle';
    handler({ agent, status: 'idle' });
    const after = await mounted.provided.get('workspaceScaffolds').execute({ action: 'list' });
    assert.equal(after.runningAgents, false);
  } finally {
    await fake.cleanup();
  }
});

test('a hot load seeds in-flight agents, so a sleep queued for one still drains (F13)', async () => {
  const fake = await createFakeHost();
  try {
    // The agent has been running since before this plugin was applied: its
    // `agent/created` and `agent/status: running` events belong to a previous
    // mount, so the only way to know it is mid-turn is the live registry.
    const agent = { id: 'hot-1', status: 'running' };
    fake.agents.push(agent);
    const mounted = mount(fake);
    const api = mounted.provided.get('workspaceScaffolds');
    const workspaceId = await prepareSleepableWorkspace(fake, api, 'hot');

    const queued = await sleep(api, workspaceId);
    assert.equal(queued.status, 'pending-idle', 'work in flight has to defer the shelf');
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    // DSH updates the agent before it emits the event, so by the time the
    // plugin hears `idle` the live agent is already idle. Without a seeded
    // cache there is nothing left to compare against and the boundary is lost.
    agent.status = 'idle';
    mounted.listeners.get('agent/status')({ agent, status: 'idle' });

    assert.equal(
      await waitFor(() => fake.bundles.get('dsh-scaffold-notes').enabled === false),
      true,
      'the sleep queued behind an agent that predates the mount must drain when it goes idle',
    );
    assert.deepEqual((await api.execute({ action: 'list' })).pendingSleeps, []);
  } finally {
    await cleanupFake(fake);
  }
});

test('two in-flight agents keep the queued sleep until the last one is idle', async () => {
  const fake = await createFakeHost();
  try {
    const first = { id: 'pair-1', status: 'running' };
    const second = { id: 'pair-2', status: 'running' };
    fake.agents.push(first, second);
    const mounted = mount(fake);
    const api = mounted.provided.get('workspaceScaffolds');
    const workspaceId = await prepareSleepableWorkspace(fake, api, 'pair');
    await sleep(api, workspaceId);

    first.status = 'idle';
    mounted.listeners.get('agent/status')({ agent: first, status: 'idle' });
    await settle();
    assert.equal(
      fake.bundles.get('dsh-scaffold-notes').enabled,
      true,
      'one agent going idle must not release while another is still running',
    );
    let snapshot = await api.execute({ action: 'list' });
    assert.deepEqual(snapshot.pendingSleeps, [workspaceId], 'the sleep must still be queued');
    assert.equal(snapshot.runningAgents, true);

    second.status = 'idle';
    mounted.listeners.get('agent/status')({ agent: second, status: 'idle' });
    assert.equal(
      await waitFor(() => fake.bundles.get('dsh-scaffold-notes').enabled === false),
      true,
      'the last agent going idle must drain the queue',
    );
    snapshot = await api.execute({ action: 'list' });
    assert.deepEqual(snapshot.pendingSleeps, []);
  } finally {
    await cleanupFake(fake);
  }
});

test('agent/disposed still drains a sleep that was waiting on that agent', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const api = mounted.provided.get('workspaceScaffolds');
    const workspaceId = await prepareSleepableWorkspace(fake, api, 'disposed');
    const agent = { id: 'gone-1', status: 'running' };
    fake.agents.push(agent);
    mounted.listeners.get('agent/status')({ agent, status: 'running' });
    await sleep(api, workspaceId);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    // A disposed agent is gone from the registry before the event is emitted.
    fake.agents.splice(fake.agents.indexOf(agent), 1);
    mounted.listeners.get('agent/disposed')({ agent });

    assert.equal(
      await waitFor(() => fake.bundles.get('dsh-scaffold-notes').enabled === false),
      true,
      'disposal of the last running agent must still drain the queue',
    );
  } finally {
    await cleanupFake(fake);
  }
});

test('a status event for an agent whose running event was missed still drains the queue', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    const api = mounted.provided.get('workspaceScaffolds');
    const workspaceId = await prepareSleepableWorkspace(fake, api, 'racy');

    // The agent is live in the registry and genuinely running, but its
    // `agent/status: running` event never reached this plugin - it started
    // after the mount but before this instance's subscription, or the event was
    // simply lost. Only the host knows it is busy, so the cache is empty when
    // the transition out of that work arrives.
    const agent = { id: 'late-1', status: 'running' };
    fake.agents.push(agent);
    const queued = await sleep(api, workspaceId);
    assert.equal(queued.status, 'pending-idle');

    agent.status = 'idle';
    mounted.listeners.get('agent/status')({ agent, status: 'idle' });

    assert.equal(
      await waitFor(() => fake.bundles.get('dsh-scaffold-notes').enabled === false),
      true,
      'an idle boundary must drain the queue even when the cache never saw the agent running',
    );
  } finally {
    await cleanupFake(fake);
  }
});

test('teardown releases every effect without throwing', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    assert.ok(mounted.disposers.length >= 1);
    for (const dispose of mounted.disposers) dispose();
  } finally {
    await fake.cleanup();
  }
});

/**
 * @param {object} body
 * @returns {Request}
 */
function jsonRequest(body) {
  return new Request('http://localhost/execute', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Bring one workspace to the state a deferred sleep is observable from: a bound
 * package this workspace alone holds, already enabled by a wake. Everything is
 * driven through the real `apply()` assembly, so the lifecycle wiring under test
 * is the one the plugin actually installs.
 * @param {object} fake
 * @param {object} api The `workspaceScaffolds` facade `apply` provided.
 * @param {string} label Distinguishes the temp directories of parallel cases.
 * @returns {Promise<string>} The workspace id.
 */
async function prepareSleepableWorkspace(fake, api, label) {
  const workspace = await fake.workspace.add(join(fake.workspace.root, label), label);
  const packageDir = await writeScaffoldPackage(join(fake.workspace.root, `pkg-${label}`), {
    name: 'dsh-scaffold-notes',
    version: '0.1.0',
    scaffold: { schemaVersion: 1, templates: [] },
  });
  const revision = async () => (await api.execute({ action: 'list' })).revision;
  const imported = await api.execute({
    action: 'import',
    path: packageDir,
    operationId: newId(),
    expectedRevision: await revision(),
  });
  await api.execute({
    action: 'bind',
    workspaceId: workspace.workspaceId,
    packageName: imported.packageName,
    version: imported.version,
    operationId: newId(),
    expectedRevision: await revision(),
  });
  await api.execute({
    action: 'wake',
    workspaceId: workspace.workspaceId,
    operationId: newId(),
    expectedRevision: await revision(),
  });
  assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true, 'the fixture must start with the bundle on');
  return workspace.workspaceId;
}

/**
 * Ask the real facade to shelf a workspace, which defers while an agent runs.
 * @param {object} api
 * @param {string} workspaceId
 * @returns {Promise<object>}
 */
async function sleep(api, workspaceId) {
  const revision = (await api.execute({ action: 'list' })).revision;
  return await api.execute({ action: 'sleep', workspaceId, operationId: newId(), expectedRevision: revision });
}

/**
 * Wait for something a background chain produces.
 *
 * The idle notification runs `void drain()`, so the deferred release is not
 * finished when the event handler returns; a test that asserts on its effect
 * has to wait for it rather than assume it already happened.
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Give any background chain an event started the chance to finish, so an
 * assertion that something did *not* happen means "did not", not "not yet".
 * @returns {Promise<void>}
 */
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Tear a fake host down without racing the tail of a deferred sleep.
 *
 * `SleepQueue` applies a queued sleep from a fire-and-forget idle notification,
 * so the native release these tests assert on lands before the operation logs
 * its own `reconcile` commit. Deleting the profile while that trailing write is
 * still creating files is what makes Windows answer `rm -rf` with ENOTEMPTY;
 * that is a scheduling artifact of the deferred design, not a failure of the
 * behaviour under test, so the teardown waits it out instead of turning it into
 * a red test.
 * @param {object} fake
 * @returns {Promise<void>}
 */
async function cleanupFake(fake) {
  const retryable = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fake.cleanup();
      return;
    } catch (error) {
      if (attempt >= 10 || !retryable.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
