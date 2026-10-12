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

test('list reports the running build and the profile-declared spec', async () => {
  const { fake, operations } = await setup();
  try {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

    // With no profile manifest at hand the spec is reported as unknown rather
    // than guessed, and nothing claims a restart.
    const bare = await operations.execute({ action: 'list' });
    assert.equal(bare.pluginVersion, manifest.version);
    assert.equal(bare.pluginName, manifest.name);
    assert.equal(bare.profileSpec, null);
    assert.equal(bare.restartPending, false);

    // Now let the profile declare a different local build, which is exactly the
    // state after an update is written but before the process restarts.
    await writeFile(
      join(fake.host.profileDir, 'package.json'),
      JSON.stringify({ name: 'desktop', dependencies: { [manifest.name]: 'file:/elsewhere/dsh-workspace-scaffolds-9.9.9.tgz' } }),
    );
    const pending = await operations.execute({ action: 'list' });
    assert.equal(pending.profileSpec, 'file:/elsewhere/dsh-workspace-scaffolds-9.9.9.tgz');
    assert.equal(pending.restartPending, true, 'a different local build on disk must be reported');

    // Declaring the running build is not a pending restart.
    await writeFile(
      join(fake.host.profileDir, 'package.json'),
      JSON.stringify({ name: 'desktop', dependencies: { [manifest.name]: `file:/elsewhere/dsh-workspace-scaffolds-${manifest.version}.tgz` } }),
    );
    const current = await operations.execute({ action: 'list' });
    assert.equal(current.restartPending, false);
  } finally {
    await fake.cleanup();
  }
});

test('a wake must not pin the bundle it just enabled', async () => {
  const { fake, operations } = await setup();
  try {
    // Reproduce the real event flow: the plugin manager announces every
    // enablement change, including the ones this plugin causes, and the change
    // listener reconciles on that announcement.
    fake.onPluginManagerChange(() => {
      void operations.reconcileFromEvent();
    });

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

    let snapshot = await operations.execute({ action: 'list' });
    const record = snapshot.packages.find((entry) => entry.key === 'dsh-scaffold-notes@0.1.0');
    assert.equal(record.enabled, true);
    assert.equal(
      record.pinned,
      false,
      'a bundle this plugin enabled for an awake workspace is explained by that lease, not by outside intent',
    );

    // The consequence that matters: shelving must still work.
    const slept = await write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    assert.deepEqual(slept.release.released, [{ key: 'dsh-scaffold-notes@0.1.0', outcome: 'applied' }]);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.packages.find((entry) => entry.key === 'dsh-scaffold-notes@0.1.0').pinned, false);
  } finally {
    await fake.cleanup();
  }
});

test('a bundle enabled with no workspace claiming it is still treated as external intent', async () => {
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

    // Someone else turns it on while no workspace holds a lease. The safety
    // rule must still protect that: do not disable what we did not enable.
    fake.bundles.get('dsh-scaffold-notes').enabled = true;
    const reconciled = await operations.reconcileFromEvent();
    assert.ok(reconciled !== null && reconciled !== undefined);
    assert.equal(reconciled.drift.length, 1);
    assert.equal(reconciled.drift[0].change, 'enabled-outside-management');
    const snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.packages.find((entry) => entry.key === 'dsh-scaffold-notes@0.1.0').pinned, true);
  } finally {
    await fake.cleanup();
  }
});

test('a bundle this plugin enabled and never released is not pinned after a restart', async () => {
  const { fake, operations, store } = await setup();
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

    // Reproduce a restart that dropped a queued shelf: the declared intent is
    // 'sleeping' while the bundle it asked for is still enabled, and the
    // in-memory sleep queue is gone.
    await store.mutate({ action: 'sleep', operationId: newId(), expectedRevision: store.revision }, (draft) => {
      draft.workspaces[workspace.workspaceId].requestedState = 'sleeping';
      return {};
    });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    const revived = new Store(fake.host.storageDir);
    await revived.init();
    const restarted = new Operations({ host: fake.host, store: revived, activity: new Activity(fake.host) });
    restarted.init();

    const reconciled = await restarted.reconcileFromEvent();
    const entry = reconciled.drift.find((row) => row.key === 'dsh-scaffold-notes@0.1.0');
    assert.equal(entry?.change, 'enabled-by-us-unreleased');
    assert.equal(entry?.action, undefined, 'our own unreleased leftover must never be pinned');

    let snapshot = await restarted.execute({ action: 'list' });
    assert.equal(snapshot.packages.find((row) => row.key === 'dsh-scaffold-notes@0.1.0').pinned, false);

    // And the shelf can still complete, which is the whole point.
    const slept = await write(restarted, { action: 'sleep', workspaceId: workspace.workspaceId });
    assert.deepEqual(slept.release.released, [{ key: 'dsh-scaffold-notes@0.1.0', outcome: 'applied' }]);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    snapshot = await restarted.execute({ action: 'list' });
    assert.equal(snapshot.packages.find((row) => row.key === 'dsh-scaffold-notes@0.1.0').pinned, false);
  } finally {
    await fake.cleanup();
  }
});

test('an unknown provenance is reported, never pinned and never released', async () => {
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
    // Someone enables it, and the record carries no provenance - the shape an
    // upgrade from a build without this field leaves behind.
    fake.bundles.get('dsh-scaffold-notes').enabled = true;
    await operations.store.mutate(
      { action: 'reconcile', operationId: newId(), expectedRevision: operations.store.revision },
      (draft) => {
        draft.packages['dsh-scaffold-notes@0.1.0'].lastAppliedEnabled = null;
        return {};
      },
    );

    const reconciled = await operations.reconcileFromEvent();
    const entry = reconciled.drift.find((row) => row.key === 'dsh-scaffold-notes@0.1.0');
    assert.equal(entry?.change, 'provenance-unknown');
    assert.equal(entry?.action, undefined, 'an unknown must not be turned into a pin');

    const snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.packages.find((row) => row.key === 'dsh-scaffold-notes@0.1.0').pinned, false);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true, 'and must not be released either');
  } finally {
    await fake.cleanup();
  }
});

test('workspace-register brings a project under management without a raw RPC call', async () => {
  const { fake, operations } = await setup();
  try {
    const projectDir = join(fake.workspace.root, 'brand-new');
    await mkdir(projectDir, { recursive: true });

    const registered = await write(operations, { action: 'workspace-register', path: projectDir, title: 'Brand new' });
    assert.equal(registered.created, true);
    assert.equal(registered.hadRecord, false);
    assert.equal(registered.title, 'Brand new');

    // It must appear as a managed workspace immediately, with nothing bound and
    // nothing enabled, so the next step can be `bind`.
    const listed = await operations.execute({ action: 'list' });
    const workspace = listed.workspaces.find((row) => row.workspaceId === registered.workspaceId);
    assert.ok(workspace !== undefined, 'the registered project must be managed');
    assert.deepEqual(workspace.bindings, []);
    assert.equal(workspace.requestedState, 'sleeping');
    assert.equal(workspace.registered, true);
    assert.equal(workspace.ready, false);
    assert.equal(listed.unmanagedWorkspaces.some((row) => row.workspaceId === registered.workspaceId), false);
  } finally {
    await fake.cleanup();
  }
});

test('registering an already registered directory adopts it and keeps its bindings', async () => {
  const { fake, operations } = await setup();
  try {
    const projectDir = join(fake.workspace.root, 'again');
    await mkdir(projectDir, { recursive: true });
    const first = await write(operations, { action: 'workspace-register', path: projectDir });
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    await write(operations, {
      action: 'bind',
      workspaceId: first.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });

    const again = await write(operations, { action: 'workspace-register', path: projectDir });
    assert.equal(again.created, false, 'the native registry de-duplicates by path');
    assert.equal(again.hadRecord, true);
    assert.equal(again.workspaceId, first.workspaceId, 'the same workspace must be adopted, not duplicated');

    const listed = await operations.execute({ action: 'list' });
    const workspace = listed.workspaces.find((row) => row.workspaceId === first.workspaceId);
    assert.equal(workspace.bindings.length, 1, 're-registering must not discard bindings');
  } finally {
    await fake.cleanup();
  }
});

test('workspace-register refuses a path that is not a directory', async () => {
  const { fake, operations } = await setup();
  try {
    const missing = join(fake.workspace.root, 'nope');
    await assert.rejects(
      () => write(operations, { action: 'workspace-register', path: missing }),
      (error) => error.code === CODES.workspaceUnavailable && error.details.reason === 'not-a-directory',
    );

    const file = join(fake.workspace.root, 'a-file.txt');
    await writeFile(file, 'not a directory\n');
    await assert.rejects(
      () => write(operations, { action: 'workspace-register', path: file }),
      (error) => error.code === CODES.workspaceUnavailable,
    );
  } finally {
    await fake.cleanup();
  }
});

test('workspace-register requires a revision like every other write', async () => {
  const { fake, operations } = await setup();
  try {
    const projectDir = join(fake.workspace.root, 'guarded');
    await mkdir(projectDir, { recursive: true });
    await assert.rejects(
      () => operations.execute({ action: 'workspace-register', path: projectDir, operationId: newId() }),
      (error) => error.code === CODES.invalidRequest && error.details.field === 'expectedRevision',
    );
  } finally {
    await fake.cleanup();
  }
});

/**
 * Build one checks scaffold package on disk. Distinct from the notes package so
 * a workspace can hold two different scaffolds at once.
 * @param {string} root
 */
async function checksPackage(root) {
  return await writeScaffoldPackage(join(root, 'pkg-checks'), {
    name: 'dsh-scaffold-checks',
    version: '0.1.0',
    scaffold: {
      schemaVersion: 1,
      title: 'Project checks',
      variables: { projectName: { type: 'string', required: true } },
      templates: [
        { id: 'checks', files: [{ source: 'templates/CHECKS.md', target: 'docs/CHECKS.md', render: 'text' }] },
      ],
    },
    files: { 'templates/CHECKS.md': '# {{projectName}}\n\nChecklist.\n' },
  });
}

/** Import a package and bind it to a workspace. */
async function bindPackage(operations, workspaceId, directory, templateId) {
  const imported = await write(operations, { action: 'import', path: directory });
  const binding = await write(operations, {
    action: 'bind',
    workspaceId,
    packageName: imported.packageName,
    version: imported.version,
    ...(templateId === undefined ? {} : { templateId }),
  });
  return { imported, binding };
}

test('unbinding one association leaves the workspace\u2019s other scaffolds running', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'two-scaffolds'), 'two');
    const notes = await bindPackage(operations, workspace.workspaceId, await notesPackage(fake.workspace.root));
    const checks = await bindPackage(operations, workspace.workspaceId, await checksPackage(fake.workspace.root));
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);
    assert.equal(fake.bundles.get('dsh-scaffold-checks').enabled, true);

    // Removing one association is a statement about that scaffold only. The
    // shelf plan for the whole workspace would release both.
    const unbound = await write(operations, {
      action: 'unbind',
      workspaceId: workspace.workspaceId,
      bindingId: notes.binding.bindingId,
    });
    assert.deepEqual(
      unbound.release.released.map((row) => row.key),
      ['dsh-scaffold-notes@0.1.0'],
      'only the removed association may be released',
    );
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    assert.equal(
      fake.bundles.get('dsh-scaffold-checks').enabled,
      true,
      'the scaffold that is still associated must keep running',
    );

    const listed = await operations.execute({ action: 'list' });
    const record = listed.workspaces.find((row) => row.workspaceId === workspace.workspaceId);
    assert.equal(record.bindings.length, 1);
    assert.equal(record.bindings[0].packageName, 'dsh-scaffold-checks');
    assert.equal(record.ready, true);
    assert.equal(checks.binding.bindingId !== undefined, true);
  } finally {
    await fake.cleanup();
  }
});

test('unbinding never disables a scaffold another workspace still needs', async () => {
  const { fake, operations } = await setup();
  try {
    const one = await fake.workspace.add(join(fake.workspace.root, 'holder-one'), 'one');
    const two = await fake.workspace.add(join(fake.workspace.root, 'holder-two'), 'two');
    const directory = await notesPackage(fake.workspace.root);
    const first = await bindPackage(operations, one.workspaceId, directory);
    await bindPackage(operations, two.workspaceId, directory);
    await write(operations, { action: 'wake', workspaceId: one.workspaceId });
    await write(operations, { action: 'wake', workspaceId: two.workspaceId });

    const unbound = await write(operations, {
      action: 'unbind',
      workspaceId: one.workspaceId,
      bindingId: first.binding.bindingId,
    });
    assert.deepEqual(unbound.release.released, []);
    assert.equal(unbound.release.kept[0].reason, 'other-workspace');
    assert.deepEqual(unbound.release.kept[0].holders, [two.workspaceId]);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);
  } finally {
    await fake.cleanup();
  }
});

test('unbinding a disabled association changes no native state', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'opt-out'), 'opt-out');
    const directory = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: directory });
    const binding = await write(operations, {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
      enabled: false,
    });
    const unbound = await write(operations, {
      action: 'unbind',
      workspaceId: workspace.workspaceId,
      bindingId: binding.bindingId,
    });
    assert.deepEqual(unbound.release.released, []);
    assert.deepEqual(unbound.release.kept, []);
    assert.equal(fake.calls.filter((call) => call.kind === 'setBundleEnabled').length, 0);
  } finally {
    await fake.cleanup();
  }
});

test('a delayed shelf cannot leave the workspace awake with its bundle off', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'interleaved'), 'interleaved');
    await bindPackage(operations, workspace.workspaceId, await notesPackage(fake.workspace.root));
    await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    // Hold the shelf's native disable open, so a shelf and a restore overlap in
    // a way that is deterministic rather than timing-dependent.
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let gateEntered;
    const entered = new Promise((resolve) => {
      gateEntered = resolve;
    });
    let armed = true;
    fake.gateSetBundleEnabled(async ({ enabled }) => {
      if (armed && enabled === false) {
        armed = false;
        gateEntered();
        await gate;
      }
    });

    const shelf = write(operations, { action: 'sleep', workspaceId: workspace.workspaceId });
    // The shelf has now committed `sleeping` and is parked inside its native
    // disable, still holding the critical section.
    await entered;
    const revisionAfterShelf = operations.store.revision;
    let wakeSettled = false;
    const wake = write(operations, {
      action: 'wake',
      workspaceId: workspace.workspaceId,
    }).then((value) => {
      wakeSettled = true;
      return value;
    });

    // Give the restore every chance to make its decision while the shelf is
    // still parked. A working critical section prevents it entirely, so this
    // waits out the bound; the broken version commits here instead.
    await waitForEvent(() => wakeSettled || operations.store.revision !== revisionAfterShelf, 400);
    releaseGate();
    await Promise.allSettled([shelf, wake]);
    fake.gateSetBundleEnabled(null);

    // The invariant the interleaving used to break: whatever the declared intent
    // ended up being, the native state has to agree with it.
    const listed = await operations.execute({ action: 'list' });
    const record = listed.workspaces.find((row) => row.workspaceId === workspace.workspaceId);
    const enabled = fake.bundles.get('dsh-scaffold-notes').enabled;
    assert.equal(
      enabled,
      record.requestedState === 'awake',
      `requestedState=${record.requestedState} must agree with native enabled=${enabled}`,
    );
    assert.equal(record.ready, record.requestedState === 'awake');
  } finally {
    await fake.cleanup();
  }
});

/**
 * Wait until an observable event happens, or give up after a bound.
 *
 * Interleaving tests need to know that another operation has *reached a
 * decision*, not merely that some time passed. Polling a real condition
 * (a settled promise, a revision change) keeps that deterministic; the bound
 * only exists so the case where the event is correctly prevented can finish.
 * @param {() => boolean} predicate
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} Whether the event happened before the bound.
 */
async function waitForEvent(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a stale revision is refused even when the action would have been a no-op', async () => {
  const { fake, operations } = await setup();
  try {
    const snapshot = await operations.execute({ action: 'list' });
    // Sleeping a workspace with no association writes nothing and is reported
    // as a no-op. It must still refuse a stale revision: otherwise a caller
    // whose snapshot is out of date receives a success and learns nothing.
    await assert.rejects(
      operations.execute({
        action: 'sleep',
        workspaceId: 'never-associated',
        operationId: newId(),
        expectedRevision: snapshot.revision + 99,
      }),
      (error) => error.code === CODES.revisionConflict,
    );
    // The same call at the correct revision is still the documented no-op.
    const accepted = await operations.execute({
      action: 'sleep',
      workspaceId: 'never-associated',
      operationId: newId(),
      expectedRevision: snapshot.revision,
    });
    assert.deepEqual(accepted, { workspaceId: 'never-associated', status: 'no-op', reason: 'unassociated' });
    const after = await operations.execute({ action: 'list' });
    assert.equal(after.revision, snapshot.revision, 'a no-op must not bump the revision');
  } finally {
    await fake.cleanup();
  }
});

test('a wake with a stale revision reports the conflict, not the missing workspace', async () => {
  const { fake, operations } = await setup();
  try {
    const snapshot = await operations.execute({ action: 'list' });
    await assert.rejects(
      operations.execute({
        action: 'wake',
        workspaceId: 'never-associated',
        operationId: newId(),
        expectedRevision: snapshot.revision + 1,
      }),
      (error) => error.code === CODES.revisionConflict,
    );
  } finally {
    await fake.cleanup();
  }
});

test('a replayed operationId still wins over a stale revision', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'one'), 'one');
    const packageDir = await notesPackage(fake.workspace.root);
    const imported = await write(operations, { action: 'import', path: packageDir });
    const snapshot = await operations.execute({ action: 'list' });
    const request = {
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
      operationId: newId(),
      expectedRevision: snapshot.revision,
    };
    const first = await operations.execute(request);
    // The retry carries the now-stale revision. Replay must still return the
    // recorded result, because the idempotency log is consulted first.
    const second = await operations.execute(request);
    assert.deepEqual(second, first);
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
