/**
 * The shipped examples, driven through the whole loop.
 *
 * These are the artifacts a user is told to import first, so they are tested the
 * same way a user would use them: import, associate, preview, generate, restore,
 * shelve — plus the capability example's own tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Activity } from '../src/lifecycle.js';
import { Operations } from '../src/operations.js';
import { Store } from '../src/store.js';
import { readScaffoldDescriptor } from '../src/scaffold.js';
import { newId } from '../src/util.js';
import { createFakeHost } from './helpers/fake-host.mjs';

const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));

/** @param {object} fake */
async function build(fake) {
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
  return { operations, write };
}

test('the notes example declares the templates it ships', async () => {
  const descriptor = await readScaffoldDescriptor(join(examplesDir, 'dsh-scaffold-notes'));
  assert.equal(descriptor.packageName, 'dsh-scaffold-notes');
  assert.equal(descriptor.version, '0.1.0');
  assert.deepEqual(descriptor.templates.map((template) => template.id), ['notes']);
  assert.ok(descriptor.variables.projectName.required);
  assert.equal(descriptor.variables.owner.required, false);
  assert.deepEqual(
    descriptor.templates[0].files.map((file) => file.target).sort(),
    ['docs/DECISIONS.md', 'docs/PROJECT-NOTES.md'],
  );
});

test('the checks example declares one template and a valid bundle manifest', async () => {
  const descriptor = await readScaffoldDescriptor(join(examplesDir, 'dsh-scaffold-checks'));
  assert.equal(descriptor.packageName, 'dsh-scaffold-checks');
  assert.deepEqual(descriptor.templates[0].files.map((file) => file.target), ['docs/CHECKS.md']);
  const manifest = JSON.parse(await readFile(join(examplesDir, 'dsh-scaffold-checks', 'package.json'), 'utf8'));
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(manifest.workspaceScaffold, './scaffold.json');
});

test('the notes example survives the full associate → generate → shelve loop', async () => {
  const fake = await createFakeHost();
  try {
    const { operations, write } = await build(fake);
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'demo'), 'demo');
    const imported = await write({ action: 'import', path: join(examplesDir, 'dsh-scaffold-notes') });
    assert.equal(imported.nativeEnabled, false, 'import must not enable the bundle');
    const bound = await write({
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });

    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: '示例工程', owner: '团队' },
    });
    assert.equal(preview.blocking.length, 0);
    assert.equal(preview.creatable, 2);

    const applied = await write({ action: 'template-apply', previewId: preview.previewId });
    assert.deepEqual(applied.created.sort(), ['docs/DECISIONS.md', 'docs/PROJECT-NOTES.md']);
    const notes = await readFile(join(workspace.path, 'docs', 'PROJECT-NOTES.md'), 'utf8');
    assert.match(notes, /示例工程/);
    assert.match(notes, /团队/);
    assert.doesNotMatch(notes, /\{\{/, 'every placeholder must be substituted');

    const woken = await write({ action: 'wake', workspaceId: workspace.workspaceId });
    assert.equal(woken.failures.length, 0);
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, true);

    const snapshot = await operations.execute({ action: 'list' });
    assert.equal(snapshot.workspaces[0].ready, true);

    const slept = await write({ action: 'sleep', workspaceId: workspace.workspaceId });
    assert.equal(slept.status, 'sleeping');
    assert.deepEqual(slept.release.released, [{ key: 'dsh-scaffold-notes@0.1.0', outcome: 'applied' }]);
    // Shelving keeps every artifact on disk and every generated file untouched.
    assert.equal(fake.bundles.get('dsh-scaffold-notes').enabled, false);
    assert.match(await readFile(join(workspace.path, 'docs', 'PROJECT-NOTES.md'), 'utf8'), /示例工程/);
    assert.deepEqual((await operations.execute({ action: 'list' })).workspaces[0].bindings.length, 1);
  } finally {
    await fake.cleanup();
  }
});

test('the checks example generates its checklist and its tool is loadable', async () => {
  const fake = await createFakeHost();
  try {
    const { operations, write } = await build(fake);
    const workspace = await fake.workspace.add(join(fake.workspace.root, 'demo'), 'demo');
    const imported = await write({ action: 'import', path: join(examplesDir, 'dsh-scaffold-checks') });
    const bound = await write({
      action: 'bind',
      workspaceId: workspace.workspaceId,
      packageName: imported.packageName,
      version: imported.version,
    });
    const preview = await operations.execute({
      action: 'template-preview',
      workspaceId: workspace.workspaceId,
      bindingId: bound.bindingId,
      values: { projectName: '自检工程' },
    });
    await write({ action: 'template-apply', previewId: preview.previewId });
    assert.match(await readFile(join(workspace.path, 'docs', 'CHECKS.md'), 'utf8'), /自检工程/);

    // The example's own host entry must register exactly one read-only tool.
    const tools = [];
    const module = await import(new URL('../examples/dsh-scaffold-checks/plugin.js', import.meta.url).href);
    module.apply({ tools: { register: (definition) => tools.push(definition) } });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'project_checklist');
    assert.equal(tools[0].isConcurrencySafe(), true);

    const outcome = await tools[0].execute({ path: workspace.path }, { agent: { session: { header: { cwd: workspace.path } } } });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.value.missing.some((item) => item.path === 'README.md'));
  } finally {
    await fake.cleanup();
  }
});
