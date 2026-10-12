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

// ---------------------------------------------------------------------------
// Whole-batch application: a conflict anywhere must leave zero files behind.
// Before the two-phase apply these tests fail, because the loop wrote file one
// before it discovered the conflict on file two or three.
// ---------------------------------------------------------------------------

/** Template of three files, in a fixed order, under one fresh target directory. */
const BATCH_FILES = {
  'templates/conflict/a.txt': 'A {{projectName}}\n',
  'templates/conflict/b.txt': 'B {{projectName}}\n',
  'templates/conflict/c.txt': 'C {{projectName}}\n',
};

/** Two files whose second target sits behind a regular file, so its write fails. */
const BLOCKED_FILES = {
  'templates/conflict/deep/a.txt': 'A\n',
  'templates/conflict/blocked/b.txt': 'B\n',
};

/**
 * Make the write of the second target of {@link BLOCKED_FILES} fail for real,
 * deterministically and on every platform: `conflict/blocked` is a regular file,
 * so the `mkdir` that `writeFileAtomic` performs for `conflict/blocked/b.txt`
 * fails with EEXIST. The check phase only stats the target itself, which is
 * genuinely missing, so this is an I/O failure the checks cannot predict — with
 * the filesystem as the oracle rather than a stubbed dependency.
 * @param {string} workspace
 */
async function blockSecondWrite(workspace) {
  await writeFile(join(workspace, 'conflict', 'blocked'), 'a plain file where a directory would go\n');
}

/**
 * Recursive spelling of a directory tree: every file's path and bytes, plus
 * every directory. Sorting makes it comparable with `deepEqual`, and including
 * directories is what catches an apply that left an empty folder behind.
 * @param {string} root @param {string} [prefix]
 * @returns {Promise<string[]>}
 */
async function snapshotTree(root, prefix = '') {
  const entries = [];
  for (const name of await readdir(root)) {
    const child = join(root, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if ((await lstat(child)).isDirectory()) {
      entries.push(`dir ${relative}`);
      entries.push(...(await snapshotTree(child, relative)));
      continue;
    }
    entries.push(`file ${relative} ${(await readFile(child)).toString('hex')}`);
  }
  return entries.sort();
}

/**
 * Preview the three-file template, change the target at `index` as if a user
 * wrote over it after the preview, then apply and assert that the whole batch
 * was blocked with nothing left on disk.
 * @param {number} index
 */
async function assertConflictCreatesNothing(index) {
  const { descriptor, cleanup } = await fixture(BATCH_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const template = descriptor.templates[0];
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.deepEqual(
      preview.files.map((file) => file.status),
      ['create', 'create', 'create'],
      'the fixture must be conflict-free at preview time',
    );
    // Recorded before the user's edit, so the assertion below proves the apply
    // added nothing beyond that one edit: with the old single-loop apply, the
    // siblings that sorted before the conflict were already on disk.
    const beforeEdit = await snapshotTree(workspace);

    const target = template.files[index].target;
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    const userBytes = 'user wrote this after the preview\n';
    await writeFile(join(workspace, ...target.split('/')), userBytes);
    const afterEdit = await snapshotTree(workspace);

    await assert.rejects(
      applyPreview({ preview, descriptor, template }),
      (error) => {
        assert.equal(error.code, CODES.templateConflict, 'the refusal must be a template conflict');
        assert.equal(error.details.reason, 'modified-after-preview');
        assert.equal(error.details.target, target, 'the conflict must name the file the user changed');
        assert.deepEqual(error.details.created, [], 'a blocked batch must report zero created files');
        return true;
      },
    );
    assert.deepEqual(
      await snapshotTree(workspace),
      afterEdit,
      `conflict on ${target} must not add or remove any file`,
    );
    assert.deepEqual(beforeEdit, [], 'the workspace must have been empty before the user wrote');
    assert.equal(await readFile(join(workspace, ...target.split('/')), 'utf8'), userBytes);
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
}

test('a conflict on the third of three files writes nothing at all', async () => {
  await assertConflictCreatesNothing(2);
});

test('a conflict writes nothing whether it lands on the first, middle or last file', async () => {
  for (const index of [0, 1, 2]) await assertConflictCreatesNothing(index);
});

test('a target that already holds identical content is skipped while the rest is created', async () => {
  const { descriptor, cleanup } = await fixture(BATCH_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.equal(preview.files[0].status, 'create');
    // Written after the preview but with exactly the bytes the apply renders:
    // not a conflict, an already-satisfied target.
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    await writeFile(join(workspace, 'conflict', 'b.txt'), 'B demo\n');

    const applied = await applyPreview({ preview, descriptor, template: descriptor.templates[0] });
    assert.deepEqual(applied.created, ['conflict/a.txt', 'conflict/c.txt']);
    assert.deepEqual(applied.skipped, ['conflict/b.txt']);
    assert.equal(applied.unchanged, false);
    assert.equal(await readFile(join(workspace, 'conflict', 'a.txt'), 'utf8'), 'A demo\n');
    assert.equal(await readFile(join(workspace, 'conflict', 'b.txt'), 'utf8'), 'B demo\n');
    assert.equal(await readFile(join(workspace, 'conflict', 'c.txt'), 'utf8'), 'C demo\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a target whose content differs is a conflict and writes nothing', async () => {
  const { descriptor, cleanup } = await fixture(BATCH_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const preview = await buildPreview(previewInput(workspace, descriptor));
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    await writeFile(join(workspace, 'conflict', 'c.txt'), 'not what the template renders\n');
    const before = await snapshotTree(workspace);

    await assert.rejects(
      applyPreview({ preview, descriptor, template: descriptor.templates[0] }),
      (error) => {
        assert.equal(error.code, CODES.templateConflict);
        assert.equal(error.details.reason, 'modified-after-preview');
        assert.deepEqual(error.details.created, []);
        return true;
      },
    );
    assert.deepEqual(await snapshotTree(workspace), before, 'the sibling files must not be created');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a target that is an existing directory is a conflict and writes nothing', async () => {
  const { descriptor, cleanup } = await fixture(BATCH_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const preview = await buildPreview(previewInput(workspace, descriptor));
    await rm(join(workspace, 'conflict'), { recursive: true, force: true });
    await mkdir(join(workspace, 'conflict', 'b.txt'), { recursive: true });
    const before = await snapshotTree(workspace);

    await assert.rejects(
      applyPreview({ preview, descriptor, template: descriptor.templates[0] }),
      (error) => {
        assert.equal(error.code, CODES.templateConflict);
        assert.equal(error.details.reason, 'existing-directory');
        assert.equal(error.details.target, 'conflict/b.txt');
        assert.deepEqual(error.details.created, []);
        return true;
      },
    );
    assert.deepEqual(await snapshotTree(workspace), before);
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('an I/O failure while writing rolls the already-created files back', async () => {
  const { descriptor, cleanup } = await fixture(BLOCKED_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const template = descriptor.templates[0];
    const preview = await buildPreview(previewInput(workspace, descriptor));
    assert.deepEqual(
      preview.files.map((file) => file.status),
      ['create', 'create'],
      'the failure must be one the preview could not see',
    );
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    await blockSecondWrite(workspace);
    const before = await snapshotTree(workspace);

    await assert.rejects(
      applyPreview({ preview, descriptor, template }),
      (error) => {
        assert.equal(error.code, CODES.templateConflict);
        assert.equal(error.details.reason, 'create-failed');
        assert.equal(error.details.target, 'conflict/blocked/b.txt');
        assert.deepEqual(error.details.created, ['conflict/deep/a.txt']);
        assert.deepEqual(
          error.details.rolledBack,
          ['conflict/deep/a.txt'],
          'the file this attempt created must be rolled back',
        );
        assert.deepEqual(error.details.rollbackFailed, []);
        assert.deepEqual(error.details.leftBehind, []);
        assert.match(error.details.partial, /rolled-back/);
        return true;
      },
    );
    assert.deepEqual(
      await snapshotTree(workspace),
      before,
      'a failed batch must leave nothing behind but what was already there',
    );
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a failed batch removes the directories it created', async () => {
  const { descriptor, cleanup } = await fixture(BLOCKED_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const template = descriptor.templates[0];
    const preview = await buildPreview(previewInput(workspace, descriptor));
    // `conflict/deep/a.txt` lands first and its `mkdir` creates `conflict/deep`;
    // failing the second write must take those fresh directories back down
    // rather than littering the workspace with an empty `conflict/`.
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    await blockSecondWrite(workspace);

    await assert.rejects(applyPreview({ preview, descriptor, template }), (error) => {
      assert.equal(error.code, CODES.templateConflict);
      assert.equal(error.details.reason, 'create-failed');
      assert.equal(error.details.target, 'conflict/blocked/b.txt');
      assert.deepEqual(error.details.rolledBack, ['conflict/deep/a.txt']);
      assert.deepEqual(error.details.rollbackCleanupFailed, []);
      return true;
    });
    assert.deepEqual(await readdir(workspace), ['conflict'], 'the created subtree must be gone');
    assert.deepEqual(await readdir(join(workspace, 'conflict')), ['blocked']);
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a failed batch leaves a directory the user already populated alone', async () => {
  const { descriptor, cleanup } = await fixture(BLOCKED_FILES);
  const workspace = await mkdtemp(join(tmpdir(), 'wss-ws-'));
  try {
    const template = descriptor.templates[0];
    // `conflict/` exists and holds a file of the user's before the apply, so the
    // rollback must not delete it even though this apply wrote through it.
    await mkdir(join(workspace, 'conflict'), { recursive: true });
    await writeFile(join(workspace, 'conflict', 'owned.txt'), 'mine\n');
    await blockSecondWrite(workspace);

    const preview = await buildPreview(previewInput(workspace, descriptor));
    await assert.rejects(applyPreview({ preview, descriptor, template }), (error) => {
      assert.equal(error.code, CODES.templateConflict);
      assert.deepEqual(error.details.rolledBack, ['conflict/deep/a.txt']);
      return true;
    });
    assert.deepEqual(await readdir(join(workspace, 'conflict')), ['blocked', 'owned.txt']);
    assert.equal(await readFile(join(workspace, 'conflict', 'owned.txt'), 'utf8'), 'mine\n');
  } finally {
    await cleanup();
    await rm(workspace, { recursive: true, force: true });
  }
});
