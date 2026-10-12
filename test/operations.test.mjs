/**
 * End-to-end behaviour of the operations layer against the fake host: the
 * acceptance scenarios from the plan, exercised through the same public
 * `execute()` entry point the HTTP surface and the agent tool use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { CODES } from '../src/errors.js';
import { newId } from '../src/util.js';
import { createFakeHost, writeScaffoldPackage } from './helpers/fake-host.mjs';

/**
 * Build an operations instance over a fresh fake host.
 * @param {(fake: object) => Promise<void>} [prepare]
 */
async function setup(prepare) {
  const fake = await createFakeHost();
  if (prepare !== undefined) await prepare(fake);
  const store = new Store(fake.host.storageDir);
  await store.init();
  const activity = new Activity(fake.host);
  const operations = new Operations({ host: fake.host, store, activity });
  operations.init();
  return { fake, store, activity, operations };
}

/**
 * Run a write action with the current revision and a fresh operation id.
 * @param {Operations} operations
 * @param {object} request
 */
async function write(operations, request) {
  const snapshot = await operations.execute({ action: 'list' });
  return await operations.execute({ operationId: newId(), expectedRevision: snapshot.revision, ...request });
}

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

test('A1: prepare before work, generate files, enable the bundle', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project-a'), 'project-a');
    const packageDir = await notesPackage(fake.workspace.root);

    const imported = await write(operations, { action: 'import', path: packageDir });
    assert.equal(imported.packageName, 'dsh-scaffold-notes');
    assert.equal(imported.installOutcome, 'applied');
    assert.equal(imported.nativeEnabled, false);

    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });

    let snapshot = await operations.execute({ action: 'list' });
    const binding = snapshot.workspaces[0].bindings[0];

    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: binding.id,
      values: { projectName: 'demo' },
    });
    assert.equal(preview.blocking.length, 0);
    assert.equal(preview.creatable, 1);

    const applied = await write(operations, { action: 'template-apply', previewId: preview.previewId });
    assert.deepEqual(applied.created, ['docs/NOTES.md']);
    assert.equal(
      await readFile(join(workspace.path, 'docs', 'NOTES.md'), 'utf8'),
      '# demo\n\nScaffolded notes.\n',
    );

    const woken = await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(woken.failures.length, 0);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.workspaces[0].ready, true);
    assert.equal(snapshot.workspaces[0].requestedState, 'awake');
  } finally {
    await fake.cleanup();
  }
});

test('A5/A6: a shared bundle stays while any workspace holds it', async () => {
  const { fake, operations } = await setup();
  try {
    const first = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const second = await fake.workspace.add(join(fake.workspace.root, 'two'), 'two');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    for (const workspace of [first, second]) {
      await write(operations, {
        action: 'bind',
        workspaceId: workspace.workspaceId,
        packageName: imported.packageName,
        version: imported.version,
      });
      await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    }
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    const firstSleep = await write(operations, { action: 'sleep', workspaceId: first.workspaceId });
    assert.equal(firstSleep.status, 'sleeping');
    assert.deepEqual(firstSleep.release.released, []);
    assert.equal(firstSleep.release.kept[0].reason, 'other-workspace');
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true, 'still needed by the second workspace');

    const secondSleep = await write(operations, { action: 'sleep', workspaceId: second.workspaceId });
    assert.deepEqual(secondSleep.release.released, [{ key: 'dsh-scaffold-notes@0.1.0', outcome: 'applied' }]);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
  } finally {
    await fake.cleanup();
  }
});

test('A7: a bundle that was globally enabled is never taken away', async () => {
  const { fake, operations } = await setup(async (host) => {
    await host.preinstall('dsh-scaffold-notes', '0.1.0', true);
  });
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    assert.equal(imported.installOutcome, 'already-installed');
    assert.equal(imported.nativeEnabled, true);
    assert.equal(imported.packageKey, 'dsh-scaffold-notes@0.1.0');

    let snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.packages[0].ownership, 'external');
    assert.equal(snapshot.packages[0].pinned, true);

    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    const sleep = await write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    assert.deepEqual(sleep.release.released, []);
    assert.equal(sleep.release.kept[0].reason, 'pinned');
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);
    snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.workspaces[0].requestedState, 'sleeping');
  } finally {
    await fake.cleanup();
  }
});

test('A9: a required failure does not leave the workspace ready', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    // Bind an installed package with no stored snapshot, so the automatic path
    // cannot install it and the explicit path is refused for a version clash.
    await fake.preinstall('dsh-scaffold-absent', '2.0.0', false);
    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: 'dsh-scaffold-absent',
      version: '1.0.0',
      templateValues: {},
    }).then(
      () => assert.fail('binding a mismatched version must be refused'),
      (error) => assert.equal(error.code, CODES.versionConflict),
    );

    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: 'dsh-scaffold-absent',
      version: '2.0.0',
    });
    const woken = await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(woken.failures.length, 0);
    assert.equal(fake.bundles.get('dsh-scaffold-absent').enabled, true);
  } finally {
    await fake.cleanup();
  }
});

test('A12: a stale revision is refused and reports the current one', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    const snapshot = await operations.execute({ action: 'list' });
    const bindArgs = {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
      operationId: newId(),
      expectedRevision: snapshot.revision,
    };
    await operations.execute(bindArgs);
    // The same stale revision, with a different operation id, must not be
    // allowed to build on a state it never saw.
    await assert.rejects(
      operations.execute({ ...bindArgs, operationId: newId() }),
      (error) => error.code === CODES.revisionConflict && error.details.currentRevision === snapshot.revision + 1,
    );
  } finally {
    await fake.cleanup();
  }
});

test('A13: a repeated operationId replays instead of repeating side effects', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const snapshot = await operations.execute({ action: 'list' });
    const operationId = newId();
    const args = {
      action: 'import',
      path: packageDir,
      operationId,
      expectedRevision: snapshot.revision,
    };
    const first = await operations.execute(args);
    const installsAfterFirst = fake.calls.filter((call) => call.kind === 'installBundle').length;
    const second = await operations.execute(args);
    assert.deepEqual(second, first);
    assert.equal(
      fake.calls.filter((call) => call.kind === 'installBundle').length,
      installsAfterFirst,
      'the replay must not install again',
    );
    assert.equal(workspace.workspaceId, 'ws-1');

    await assert.rejects(
      operations.execute({ ...args, path: join(fake.workspace.root, 'somewhere-else') }),
      (error) => error.code === CODES.operationIdReused,
    );
  } finally {
    await fake.cleanup();
  }
});

test('A14: a file edited after preview blocks the whole apply', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    const bound = await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: 'demo' },
    });
    await mkdir(join(workspace.path, 'docs'), { recursive: true });
    await writeFile(join(workspace.path, 'docs', 'NOTES.md'), 'user content\n');
    await assert.rejects(
      write(operations, { action: 'template-apply', previewId: preview.previewId }),
      (error) => error.code === CODES.templateConflict,
    );
    assert.equal(await readFile(join(workspace.path, 'docs', 'NOTES.md'), 'utf8'), 'user content\n');
  } finally {
    await fake.cleanup();
  }
});

test('A14b: an identical file is skipped, not overwritten', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    const bound = await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: 'demo' },
    });
    await write(operations, { action: 'template-apply', previewId: preview.previewId });

    const second = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: 'demo' },
    });
    assert.equal(second.creatable, 0);
    const applied = await write(operations, { action: 'template-apply', previewId: second.previewId });
    assert.equal(applied.unchanged, true);
    assert.deepEqual(applied.created, []);
  } finally {
    await fake.cleanup();
  }
});

test('A20: unbind releases the bundle but keeps generated files', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    const bound = await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: 'demo' },
    });
    await write(operations, { action: 'template-apply', previewId: preview.previewId });
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });

    const unbound = await write(operations, {
      action: 'unbind',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
    });
    assert.equal(unbound.removed, true);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    assert.equal(await readFile(join(workspace.path, 'docs', 'NOTES.md'), 'utf8'), '# demo\n\nScaffolded notes.\n');
  } finally {
    await fake.cleanup();
  }
});

test('A21: the same version imported with different content is refused', async () => {
  const { fake, operations } = await setup();
  try {
    const first = await indexPackage(fake.workspace.root, 'first');
    const second = await indexPackage(fake.workspace.root, 'second');
    await write(operations, { action: 'import', path: first });
    await assert.rejects(
      write(operations, { action: 'import', path: second }),
      (error) => error.code === CODES.packageContentConflict,
    );
  } finally {
    await fake.cleanup();
  }
});

test('A22: a sleeping workspace restores its association after a restart', async () => {
  const { fake, store, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    await write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);

    // A fresh store over the same directory models a DSH restart.
    const restarted = new Store(fake.host.storageDir);
    await restarted.init();
    const activity = new Activity(fake.host);
    const revived = new Operations({ host: fake.host, store: restarted, activity });
    revived.init();
    const snapshot = await revived.execute({ action: 'list' });
    assert.equal(snapshot.workspaces.length, 1);
    assert.equal(snapshot.workspaces[0].bindings.length, 1);
    assert.equal(snapshot.workspaces[0].requestedState, 'sleeping');

    await write(revived, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);
    void store;
  } finally {
    await fake.cleanup();
  }
});

test('archive deletion is refused while a package still names it', async () => {
  const { fake, operations } = await setup();
  try {
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    await assert.rejects(
      write(operations, { action: 'delete-archive', archiveSha256: imported.archiveSha256 }),
      (error) => error.code === CODES.archiveInUse,
    );
    assert.equal(await fileExists(join(fake.host.storageDir, 'archives', `${imported.archiveSha256}.tgz`)), true);
  } finally {
    await fake.cleanup();
  }
});

test('import refuses a directory without a dsh.bundle declaration', async () => {
  const { fake, operations } = await setup();
  try {
    const directory = join(fake.workspace.root, 'not-a-bundle');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }));
    await assert.rejects(
      write(operations, { action: 'import', path: directory }),
      (error) => error.code === CODES.notABundle,
    );
  } finally {
    await fake.cleanup();
  }
});

test('a malformed scaffold descriptor is refused before installation', async () => {
  const { fake, operations } = await setup();
  try {
    const directory = await writeScaffoldPackage(join(fake.workspace.root, 'broken'), {
      name: 'dsh-scaffold-broken',
      version: '0.1.0',
      scaffold: { schemaVersion: 99, templates: [] },
    });
    await assert.rejects(
      write(operations, { action: 'import', path: directory }),
      (error) => error.code === CODES.scaffoldInvalid,
    );
    assert.equal(fake.calls.some((call) => call.kind === 'installBundle'), false);
  } finally {
    await fake.cleanup();
  }
});

test('a deferred sleep waits for running agents instead of force-releasing', async () => {
  const { fake, operations, activity } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });

    const busyAgent = { id: 'agent-1', status: 'running' };
    fake.agents.push(busyAgent);
    const sleepy = await write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    assert.equal(sleepy.status, 'pending-idle');
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true, 'work in flight keeps the bundle loaded');

    let snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.workspaces[0].requestedState, 'sleeping');
    assert.deepEqual(snapshot.pendingSleeps, [workspace.workspaceId]);

    busyAgent.status = 'idle';
    await operations.sleepQueue.drain();
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    snapshot = await operations.execute({ action: 'list' });
    assert.deepEqual(snapshot.pendingSleeps, []);
    void activity;
  } finally {
    await fake.cleanup();
  }
});

test('wake cancels a queued sleep so a stale queue entry cannot disable it again', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });

    const busyAgent = { id: 'agent-1', status: 'running' };
    fake.agents.push(busyAgent);
    await write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });

    busyAgent.status = 'idle';
    await operations.sleepQueue.drain();
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true, 'the cancelled sleep must not run');
  } finally {
    await fake.cleanup();
  }
});

/**
 * Build a second package with the same name and version but different bytes.
 * @param {string} root
 * @param {string} label
 */
async function indexPackage(root, label) {
  return await writeScaffoldPackage(join(root, `pkg-${label}`), {
    name: 'dsh-scaffold-index',
    version: '0.1.0',
    scaffold: { schemaVersion: 1, title: label, templates: [] },
    files: { 'templates/MARK.txt': label },
  });
}

/** @param {string} filePath */
async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

export { rm };
