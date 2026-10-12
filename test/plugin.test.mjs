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

test('apply mounts both routes, the tool, and the lifecycle listeners', async () => {
  const fake = await createFakeHost();
  try {
    const mounted = mount(fake);
    assert.deepEqual(
      mounted.routes.map((route) => route.path).sort(),
      [`${API_PREFIX}/execute`, `${API_PREFIX}/state`],
    );
    assert.equal(mounted.routes.find((route) => route.path.endsWith('/execute')).methods[0], 'POST');
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
