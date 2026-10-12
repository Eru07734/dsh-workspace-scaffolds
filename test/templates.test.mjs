/**
 * Template rules: variable resolution, placeholder strictness, preview accuracy
 * and the never-overwrite guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
