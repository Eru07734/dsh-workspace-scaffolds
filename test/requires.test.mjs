/**
 * F05 regression: the dependency edges a scaffold descriptor declares must
 * survive into the stored package record and back out of it, so the
 * coordinator's ordering, missing-dependency and cycle rules really run on the
 * import -> bind -> wake path.
 *
 * Every case drives the public `Operations.execute()` over the fake host and
 * never calls `dependencyOrder` directly. That is deliberate: the defect these
 * tests lock down was that the pure function was well tested while the wiring
 * into it was not - a hand-built record with `requires` proved nothing about
 * what `import` actually stores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { CODES } from '../src/errors.js';
import { newId, packageKey } from '../src/util.js';
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

/**
 * Build one package whose descriptor declares `requires`.
 * @param {string} root
 * @param {{name: string, version: string, requires?: any}} input
 * @returns {Promise<string>}
 */
async function requiresPackage(root, input) {
  const directory = join(root, input.name);
  const scaffold = { schemaVersion: 1, title: input.name, templates: [] };
  if (input.requires !== undefined) scaffold.requires = input.requires;
  return await writeScaffoldPackage(directory, {
    name: input.name,
    version: input.version,
    scaffold,
  });
}

/**
 * Import one package directory and associate it with a workspace.
 * @param {Operations} operations
 * @param {string} workspaceId
 * @param {string} packageDir
 * @returns {Promise<object>} The import result.
 */
async function importAndBind(operations, workspaceId, packageDir) {
  const imported = await write(operations, { action: 'import', path: packageDir });
  await write(operations, {
    action: 'bind',
    workspaceId,
    packageName: imported.packageName,
    version: imported.version,
  });
  return imported;
}

/** @param {object} fake */
function enableCalls(fake) {
  return fake.calls.filter((call) => call.kind === 'setBundleEnabled');
}

test('F05/1: a required package that is not associated refuses the wake with dependency-missing', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const packageDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-app',
      version: '1.0.0',
      requires: [{ name: 'pkg-missing', version: '1.0.0' }],
    });
    await importAndBind(operations, workspace.workspaceId, packageDir);

    await assert.rejects(
      write(operations, { action: 'wake', workspaceId: workspace.workspaceId }),
      (error) =>
        error.code === CODES.dependencyMissing &&
        error.details.missing.some(
          (entry) => entry.from === packageKey('dsh-scaffold-app', '1.0.0') && entry.name === 'pkg-missing' && entry.version === '1.0.0',
        ),
      'wake must refuse a requirement that is not among the workspace associations',
    );

    // The refusal comes from planning, so no native write happened and the
    // workspace was not left marked awake.
    assert.deepEqual(enableCalls(fake), []);
    assert.equal(fake.bundles.get('dsh-scaffold-app').enabled, false);
    const snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.workspaces[0].requestedState, 'sleeping');
  } finally {
    await fake.cleanup();
  }
});

test('F05/2: a required package is enabled before the package that requires it', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const appDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-app',
      version: '1.0.0',
      requires: [{ name: 'dsh-scaffold-lib', version: '2.0.0' }],
    });
    const libDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-lib',
      version: '2.0.0',
      requires: [],
    });
    // The dependent package is associated first, so association order alone
    // would put it in front; only a real dependency edge reverses it.
    await importAndBind(operations, workspace.workspaceId, appDir);
    await importAndBind(operations, workspace.workspaceId, libDir);

    const woken = await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(woken.failures.length, 0);
    assert.deepEqual(
      woken.applied.map((entry) => entry.key),
      [packageKey('dsh-scaffold-lib', '2.0.0'), packageKey('dsh-scaffold-app', '1.0.0')],
    );
    assert.deepEqual(
      enableCalls(fake).map((call) => call.name),
      ['dsh-scaffold-lib', 'dsh-scaffold-app'],
    );
  } finally {
    await fake.cleanup();
  }
});

test('F05/3: a dependency cycle among associated packages is refused with dependency-cycle', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const firstDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-a',
      version: '1.0.0',
      requires: [{ name: 'dsh-scaffold-b', version: '1.0.0' }],
    });
    const secondDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-b',
      version: '1.0.0',
      requires: [{ name: 'dsh-scaffold-a', version: '1.0.0' }],
    });
    await importAndBind(operations, workspace.workspaceId, firstDir);
    await importAndBind(operations, workspace.workspaceId, secondDir);

    await assert.rejects(
      write(operations, { action: 'wake', workspaceId: workspace.workspaceId }),
      (error) =>
        error.code === CODES.dependencyCycle &&
        error.details.cycle.includes(packageKey('dsh-scaffold-a', '1.0.0')) &&
        error.details.cycle.includes(packageKey('dsh-scaffold-b', '1.0.0')),
      'wake must refuse a cycle instead of picking an arbitrary order',
    );
    assert.deepEqual(enableCalls(fake), []);
  } finally {
    await fake.cleanup();
  }
});

test('F05/4: the edges survive a state reload, so a restart cannot switch the rules off', async () => {
  const { fake, store, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const packageDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-app',
      version: '1.0.0',
      requires: [{ name: 'pkg-missing', version: '1.0.0' }],
    });
    await importAndBind(operations, workspace.workspaceId, packageDir);

    // The edges are on disk, not merely in the importing process's memory.
    const onDisk = JSON.parse(await readFile(join(fake.host.storageDir, 'state.json'), 'utf8'));
    assert.deepEqual(onDisk.packages[packageKey('dsh-scaffold-app', '1.0.0')].scaffold.requires, [
      { name: 'pkg-missing', version: '1.0.0' },
    ]);

    // A restart: a fresh store re-reads state.json through normalizeState().
    await store.init();
    const revivedStore = new Store(fake.host.storageDir);
    await revivedStore.init();
    const revived = new Operations({ host: fake.host, store: revivedStore, activity: new Activity(fake.host) });
    revived.init();

    const snapshot = await revived.execute({ action: 'list' });
    const record = snapshot.packages.find((entry) => entry.key === packageKey('dsh-scaffold-app', '1.0.0'));
    assert.deepEqual(record.scaffold.requires, [{ name: 'pkg-missing', version: '1.0.0' }]);

    await assert.rejects(
      write(revived, { action: 'wake', workspaceId: workspace.workspaceId }),
      (error) => error.code === CODES.dependencyMissing,
      'normalizing the stored record must not drop the dependency edges',
    );
    assert.deepEqual(enableCalls(fake), []);
    revived.dispose();
  } finally {
    await fake.cleanup();
  }
});

test('F05/5: a package that declares no requirements wakes exactly as before', async () => {
  const { fake, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const plainDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-plain',
      version: '1.0.0',
    });
    await importAndBind(operations, workspace.workspaceId, plainDir);

    const woken = await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(woken.failures.length, 0);
    assert.deepEqual(
      woken.applied.map((entry) => entry.key),
      [packageKey('dsh-scaffold-plain', '1.0.0')],
    );
    assert.equal(fake.bundles.get('dsh-scaffold-plain').enabled, true);
  } finally {
    await fake.cleanup();
  }
});

test('F05/6: a record written before requires existed enforces nothing until it is re-imported', async () => {
  const { fake, store, operations } = await setup();
  try {
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'project'), 'project');
    const packageDir = await requiresPackage(fake.workspace.root, {
      name: 'dsh-scaffold-app',
      version: '1.0.0',
      requires: [{ name: 'pkg-missing', version: '1.0.0' }],
    });
    await importAndBind(operations, workspace.workspaceId, packageDir);

    // Rewrite the stored record into the shape the version without this field
    // wrote: same record, no `requires` key at all.
    const statePath = join(fake.host.storageDir, 'state.json');
    const stored = JSON.parse(await readFile(statePath, 'utf8'));
    delete stored.packages[packageKey('dsh-scaffold-app', '1.0.0')].scaffold.requires;
    await writeFile(statePath, `${JSON.stringify(stored, null, 2)}\n`);
    await store.init();

    // Decided behaviour: an old record declares no dependencies, so its rules
    // do not apply. Re-importing the same snapshot is the way back.
    const legacy = await write(operations, { action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(legacy.failures.length, 0);
    assert.equal(fake.bundles.get('dsh-scaffold-app').enabled, true);

    await write(operations, { action: 'import', path: packageDir });
    const rewritten = await operations.execute({ action: 'list' });
    const record = rewritten.packages.find((entry) => entry.key === packageKey('dsh-scaffold-app', '1.0.0'));
    assert.deepEqual(record.scaffold.requires, [{ name: 'pkg-missing', version: '1.0.0' }]);
    await assert.rejects(
      write(operations, { action: 'wake', workspaceId: workspace.workspaceId }),
      (error) => error.code === CODES.dependencyMissing,
      're-importing the snapshot must restore the edges the summary carries',
    );
  } finally {
    await fake.cleanup();
  }
});

test('F05/7: a malformed requires list is refused at import, never repaired into no dependencies', async () => {
  const { fake, operations } = await setup();
  try {
    const cases = [
      { label: 'not-an-array', requires: 'pkg-lib' },
      { label: 'entry-not-an-object', requires: ['pkg-lib'] },
      { label: 'empty-name', requires: [{ name: '', version: '1.0.0' }] },
      { label: 'missing-version', requires: [{ name: 'pkg-lib' }] },
    ];
    for (const [index, entry] of cases.entries()) {
      const name = `dsh-scaffold-bad-${index}`;
      const packageDir = await requiresPackage(fake.workspace.root, {
        name,
        version: '1.0.0',
        requires: entry.requires,
      });
      await assert.rejects(
        write(operations, { action: 'import', path: packageDir }),
        (error) => error.code === CODES.scaffoldInvalid,
        `${entry.label} must be refused with ${CODES.scaffoldInvalid}`,
      );
    }
    const snapshot = await operations.execute({ action: 'list' });
    assert.deepEqual(snapshot.packages, []);
  } finally {
    await fake.cleanup();
  }
});
