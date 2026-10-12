/**
 * Template rules: variable resolution, placeholder strictness, preview accuracy
 * and the never-overwrite guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODES } from '../src/errors.js';
import { resolveVariables, selectTemplate, substitute, buildPreview, applyPreview } from '../src/templates.js';

/**
 * Build a package directory plus descriptor for one template.
 * @param {Record<string, string>} files
 * @param {object} [variableDefinition]
 */
async function fixture(files, variableDefinition = { projectName: { required: true, type: 'string', default: null, maxLength: 100 } }) {
  const packageDir = await mkdtemp(join(tmpdir(), 'wss-tpl-'));
  const templateFiles = [];
  for (const [relative, content] of Object.entries(files)) {
    const source = join(packageDir, ...relative.split('/'));
    await mkdir(join(source, '..'), { recursive: true });
    await writeFile(source, content);
    templateFiles.push({ source, sourceRelative: relative, target: relative.replace(/^templates\//, ''), render: 'text' });
  }
  return {
    packageDir,
    descriptor: { title: 't', requires: [], variables: variableDefinition, templates: [{ id: 't1', title: 't1', files: templateFiles }] },
    cleanup: async () => await rm(packageDir, { recursive: true, force: true }),
  };
}

/**
 * Create a directory link. Windows uses a junction, which needs no elevation;
 * other platforms get a plain directory symlink.
 * @param {string} target @param {string} linkPath
 */
async function linkDirectory(target, linkPath) {
  await symlink(target, linkPath, 'junction');
}

/**
 * The preview input for the single template of a fixture.
 * @param {string} workspaceRoot @param {object} descriptor
 */
function previewInput(workspaceRoot, descriptor) {
  return {
    workspaceRoot,
    descriptor,
    template: descriptor.templates[0],
    values: { projectName: 'demo' },
    packageKey: 'p@1.0.0',
    workspaceId: 'ws-1',
    bindingId: 'b1',
  };
}

test('required variables must be supplied and unknown ones are refused', async () => {
  const { descriptor, cleanup } = await fixture({});
  try {
    assert.throws(
      () => resolveVariables(descriptor, {}),
      (error) => error.code === CODES.invalidRequest && error.details.requiredVariable === 'projectName',
    );
    assert.throws(
      () => resolveVariables(descriptor, { projectName: 'x', nope: 'y' }),
      (error) => error.code === CODES.invalidRequest && error.details.unknownVariable === 'nope',
    );
    assert.deepEqual(resolveVariables(descriptor, { projectName: 'x' }), { projectName: 'x' });
  } finally {
    await cleanup();
  }
});

test('a value longer than maxLength is refused', async () => {
  const { descriptor, cleanup } = await fixture({});
  try {
    assert.throws(
      () => resolveVariables(descriptor, { projectName: 'x'.repeat(101) }),
      (error) => error.code === CODES.invalidRequest && error.details.maxLength === 100,
    );
  } finally {
    await cleanup();
  }
});

test('an undeclared placeholder fails instead of rendering literally', () => {
  const values = { projectName: 'demo' };
  assert.equal(substitute('a {{projectName}} b', values, { target: 'x' }), 'a demo b');
  assert.equal(substitute('{{ projectName }}', values, { target: 'x' }), 'demo');
  assert.throws(
    () => substitute('{{missing}}', values, { target: 'x' }),
    (error) => error.code === CODES.scaffoldInvalid && error.details.variable === 'missing',
  );
});

test('selectTemplate resolves the only template or requires an explicit id', () => {
  const one = { templates: [{ id: 'only', files: [] }] };
  assert.equal(selectTemplate(one, null).id, 'only');
  const many = { templates: [{ id: 'a', files: [] }, { id: 'b', files: [] }] };
  assert.throws(() => selectTemplate(many, null), (error) => error.code === CODES.invalidRequest);
  assert.equal(selectTemplate(many, 'b').id, 'b');
  assert.throws(() => selectTemplate(many, 'zzz'), (error) => error.code === CODES.invalidRequest);
});

test('preview reports create/identical/conflict and apply creates only the missing files', async () => {
  const { descriptor, cleanup } = await fixture({
    'templates/docs/NOTES.md': '# {{projectName}}\n',
    'templates/docs/KEEP.md': 'keep\n',
  });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'KEEP.md'), 'keep\n');
    const values = resolveVariables(descriptor, { projectName: 'demo' });
    const preview = await buildPreview({
      workspaceRoot: workspace,
      descriptor,
      template: descriptor.templates[0],
      values,
      packageKey: 'p@1.0.0',
      workspaceId: 'ws-1',
      bindingId: 'b1',
    });
    const byTarget = new Map(preview.files.map((file) => [file.target, file.status]));
    assert.equal(byTarget.get('docs/NOTES.md'), 'create');
    assert.equal(byTarget.get('docs/KEEP.md'), 'identical');
    assert.equal(preview.blocking.length, 0);

    const applied = await applyPreview({ preview, descriptor, template: descriptor.templates[0] });
    assert.deepEqual(applied.created, ['docs/NOTES.md']);
    assert.deepEqual(applied.skipped, ['docs/KEEP.md']);
    assert.equal(await readFile(join(workspace, 'docs', 'NOTES.md'), 'utf8'), '# demo\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a conflicting existing file blocks the preview', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/docs/NOTES.md': '# {{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    await mkdir(join(workspace, 'docs'), { recursive: true });
    await writeFile(join(workspace, 'docs', 'NOTES.md'), 'user wrote this\n');
    const preview = await buildPreview({
      workspaceRoot: workspace,
      descriptor,
      template: descriptor.templates[0],
      values: { projectName: 'demo' },
      packageKey: 'p@1.0.0',
      workspaceId: 'ws-1',
      bindingId: 'b1',
    });
    assert.equal(preview.blocking.length, 1);
    assert.equal(preview.blocking[0].reason, 'different-content');
    // Applying anyway must refuse rather than replace what the user wrote.
    await assert.rejects(
      applyPreview({ preview, descriptor, template: descriptor.templates[0] }),
      (error) => error.code === CODES.templateConflict && error.details.reason === 'modified-after-preview',
    );
    assert.equal(await readFile(join(workspace, 'docs', 'NOTES.md'), 'utf8'), 'user wrote this\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a template whose bytes changed since the preview is refused', async () => {
  const { packageDir, descriptor, cleanup } = await fixture({ 'templates/docs/NOTES.md': '# {{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const preview = await buildPreview({
      workspaceRoot: workspace,
      descriptor,
      template: descriptor.templates[0],
      values: { projectName: 'demo' },
      packageKey: 'p@1.0.0',
      workspaceId: 'ws-1',
      bindingId: 'b1',
    });
    await writeFile(join(packageDir, 'templates', 'docs', 'NOTES.md'), '# CHANGED {{projectName}}\n');
    await assert.rejects(
      applyPreview({ preview, descriptor, template: descriptor.templates[0] }),
      (error) => error.code === CODES.previewStale,
    );
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a target that escapes the workspace is refused', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/ok.txt': 'x' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const escaping = {
      ...descriptor,
      templates: [{ id: 't1', title: 't1', files: [{ ...descriptor.templates[0].files[0], target: '../outside.txt' }] }],
    };
    await assert.rejects(
      buildPreview({
        workspaceRoot: workspace,
        descriptor: escaping,
        template: escaping.templates[0],
        values: {},
        packageKey: 'p@1.0.0',
        workspaceId: 'ws-1',
        bindingId: 'b1',
      }),
      (error) => error.code === CODES.pathOutsideWorkspace,
    );
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a workspace directory link that leads outside is refused at preview and nothing is written', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/linked/output.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'wss-outside-'));
  try {
    // The literal target `linked/output.txt` is inside the workspace; the link
    // makes the filesystem object it names live somewhere else entirely.
    await linkDirectory(outside, join(workspace, 'linked'));
    // Prove the fixture is a genuine link rather than a plain directory, so a
    // passing test cannot be an artifact of the link never having been made.
    assert.equal((await lstat(join(workspace, 'linked'))).isSymbolicLink(), true);

    await assert.rejects(
      buildPreview(previewInput(workspace, descriptor)),
      (error) => error.code === CODES.pathOutsideWorkspace,
    );
    assert.deepEqual(await readdir(outside), [], 'the preview must not create anything outside the workspace');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a link that leaves the workspace is caught even below existing subdirectories', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/linked/sub/deep.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'wss-outside-'));
  try {
    // `outside/sub` exists, so the target's nearest existing ancestor sits
    // below the link rather than being the link itself.
    await mkdir(join(outside, 'sub'), { recursive: true });
    await linkDirectory(outside, join(workspace, 'linked'));

    await assert.rejects(
      buildPreview(previewInput(workspace, descriptor)),
      (error) => error.code === CODES.pathOutsideWorkspace,
    );
    assert.deepEqual(await readdir(join(outside, 'sub')), [], 'nothing may be written through the link');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a target under a link whose destination does not exist is refused, not crashed on', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/linked/output.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    // A link to a missing path still exists as an entry, so `realpath` cannot
    // prove where a write would land. Refusing is the only honest answer.
    await linkDirectory(join(workspace, 'not-created-yet'), join(workspace, 'linked'));
    await assert.rejects(
      buildPreview(previewInput(workspace, descriptor)),
      (error) => error.code === CODES.pathOutsideWorkspace,
    );
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a workspace root that is itself reached through a link still accepts ordinary targets', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/docs/deep/output.txt': '{{projectName}}\n' });
  const real = await mkdtemp(join(tmpdir(), 'wss-real-'));
  const holder = await mkdtemp(join(tmpdir(), 'wss-holder-'));
  const workspace = join(holder, 'ws-link');
  try {
    await linkDirectory(real, workspace);
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.equal(preview.files[0].status, 'create');
    const applied = await applyPreview({ preview, descriptor, template: descriptor.templates[0] });
    assert.deepEqual(applied.created, ['docs/deep/output.txt']);
    assert.equal(await readFile(join(real, 'docs', 'deep', 'output.txt'), 'utf8'), 'demo\n');
  } finally {
    await cleanup();
    await rm(real, { recursive: true, force: true });
    await rm(holder, { recursive: true, force: true });
  }
});

test('a directory swapped for an outside link after preview is refused at apply', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/docs/output.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  const outside = await mkdtemp(join(tmpdir(), 'wss-outside-'));
  try {
    await mkdir(join(workspace, 'docs'), { recursive: true });
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.equal(preview.files[0].status, 'create');

    // Swap the real directory for a link between preview and apply: the literal
    // path is unchanged, so only a real-path check can catch this.
    await rm(join(workspace, 'docs'), { recursive: true, force: true });
    await linkDirectory(outside, join(workspace, 'docs'));

    await assert.rejects(
      applyPreview({ preview, descriptor, template: descriptor.templates[0] }),
      (error) => error.code === CODES.pathOutsideWorkspace,
    );
    assert.deepEqual(await readdir(outside), [], 'the apply must not create anything outside the workspace');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('an in-workspace target whose parent directories do not exist yet is still created', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/docs/deep/output.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.equal(preview.files[0].status, 'create');
    const applied = await applyPreview({ preview, descriptor, template: descriptor.templates[0] });
    assert.deepEqual(applied.created, ['docs/deep/output.txt']);
    assert.equal(await readFile(join(workspace, 'docs', 'deep', 'output.txt'), 'utf8'), 'demo\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a workspace directory link that stays inside is resolved, not blanket-refused', async () => {
  const { descriptor, cleanup } = await fixture({ 'templates/linked/output.txt': '{{projectName}}\n' });
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    await mkdir(join(workspace, 'actual'), { recursive: true });
    await linkDirectory(join(workspace, 'actual'), join(workspace, 'linked'));

    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.equal(preview.files[0].status, 'create');
    const applied = await applyPreview({ preview, descriptor, template: descriptor.templates[0] });
    assert.deepEqual(applied.created, ['linked/output.txt']);
    assert.equal(await readFile(join(workspace, 'actual', 'output.txt'), 'utf8'), 'demo\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});
