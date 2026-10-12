/**
 * The agent tool: argument validation, workspace resolution from the calling
 * session, and the requirement that writes carry a revision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { registerTool, TOOL_NAME } from '../src/tool.js';
import { CODES } from '../src/errors.js';
import { createFakeHost, writeScaffoldPackage } from './helpers/fake-host.mjs';

/** Register the tool on a capturing context. @param {Operations} operations */
function capture(operations) {
  let definition = null;
  const ctx = {
    tools: {
      register: (value) => {
        definition = value;
      },
    },
  };
  registerTool(ctx, operations);
  assert.ok(definition !== null);
  return definition;
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
  return { fake, operations, tool: capture(operations) };
}

/** An exec context whose session runs inside the given directory. @param {string} cwd */
function execIn(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: new AbortController().signal };
}

test('the tool is registered under a stable name with a read action', async () => {
  const { fake, tool } = await setup();
  try {
    assert.equal(tool.name, TOOL_NAME);
    assert.equal(tool.isConcurrencySafe(), false);
    const result = await tool.execute({ action: 'list' }, execIn(fake.workspace.root));
    assert.equal(result.ok, true);
    assert.equal(typeof result.value.revision, 'number');
  } finally {
    await fake.cleanup();
  }
});

test('a write action without a revision is refused before anything runs', async () => {
  const { fake, tool } = await setup();
  try {
    const result = await tool.execute({ action: 'sleep', workspaceId: 'ws-1' }, execIn(fake.workspace.root));
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.invalidRequest);
    assert.equal(result.details.field, 'expectedRevision');
  } finally {
    await fake.cleanup();
  }
});

test('an unknown action is refused', async () => {
  const { fake, tool } = await setup();
  try {
    const result = await tool.execute({ action: 'destroy-everything' }, execIn(fake.workspace.root));
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.invalidRequest);
  } finally {
    await fake.cleanup();
  }
});

test('a write action resolves the workspace from the calling session cwd', async () => {
  const { fake, tool } = await setup();
  try {
    const projectDir = join(fake.workspace.root, 'demo');
    const workspace = await fake.workspace.add(projectDir, 'demo');
    const packageDir = await writeScaffoldPackage(join(fake.workspace.root, 'pkg'), {
      name: 'dsh-scaffold-notes',
      version: '0.1.0',
      scaffold: { schemaVersion: 1, templates: [] },
    });
    const imported = await tool.execute({ action: 'import', path: packageDir, expectedRevision: 0 }, execIn(projectDir));
    assert.equal(imported.ok, true);
    const bound = await tool.execute(
      {
        action: 'bind',
        packageName: imported.value.packageName,
        version: imported.value.version,
        expectedRevision: 1,
      },
      execIn(projectDir),
    );
    assert.equal(bound.ok, true);
    assert.equal(bound.resolvedWorkspaceId, workspace.workspaceId);
  } finally {
    await fake.cleanup();
  }
});

test('a session outside any registered workspace is reported, not guessed', async () => {
  const { fake, tool } = await setup();
  try {
    const outside = join(fake.workspace.root, 'not-registered');
    const result = await tool.execute(
      { action: 'sleep', expectedRevision: 0 },
      execIn(outside),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, CODES.workspaceNotFound);
    assert.equal(result.details.reason, 'no-workspace-for-session-cwd');
  } finally {
    await fake.cleanup();
  }
});

test('a generated operationId makes each tool call independent', async () => {
  const { fake, tool } = await setup();
  try {
    const projectDir = join(fake.workspace.root, 'demo');
    await fake.workspace.add(projectDir, 'demo');
    const packageDir = await writeScaffoldPackage(join(fake.workspace.root, 'pkg'), {
      name: 'dsh-scaffold-notes',
      version: '0.1.0',
      scaffold: { schemaVersion: 1, templates: [] },
    });
    const first = await tool.execute({ action: 'import', path: packageDir, expectedRevision: 0 }, execIn(projectDir));
    assert.equal(first.ok, true, `first import failed: ${first.code} ${JSON.stringify(first.details)}`);
    // Same arguments, no explicit operationId: this is a second, independent
    // call, so it must succeed against the new revision rather than replay.
    const second = await tool.execute({ action: 'import', path: packageDir, expectedRevision: 1 }, execIn(projectDir));
    assert.equal(second.ok, true, `second import failed: ${second.code} ${JSON.stringify(second.details)}`);
  } finally {
    await fake.cleanup();
  }
});
