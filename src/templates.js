/**
 * Template preview and application.
 *
 * Generation is deliberately two steps and never overwrites: a preview states
 * exactly which files would be created, and the apply re-derives the same bytes
 * before writing. If the package or the target changed in between, the apply
 * refuses instead of guessing.
 * @module dsh-workspace-scaffolds/templates
 */
import { readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { Fault, CODES } from './errors.js';
import { MAX_RENDER_BYTES } from './scaffold.js';
import { dirname, newId, resolveInsideReal, sha256Hex, writeFileAtomic } from './util.js';

/** Bytes of text shown in a preview payload. */
const PREVIEW_TEXT_BYTES = 4096;

/**
 * @param {object} value
 * @returns {boolean}
 */
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolve the variable values for one template.
 * @param {object} descriptor
 * @param {Record<string, any>} [provided]
 * @returns {Record<string, string>}
 */
export function resolveVariables(descriptor, provided = {}) {
  if (!isPlainObject(provided)) throw new Fault(CODES.invalidRequest, { field: 'values' });
  const declared = descriptor.variables ?? {};
  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(declared, name)) throw new Fault(CODES.invalidRequest, { field: 'values', unknownVariable: name });
    if (typeof provided[name] !== 'string') throw new Fault(CODES.invalidRequest, { field: 'values', variable: name });
  }
  const values = {};
  for (const [name, definition] of Object.entries(declared)) {
    const raw = Object.hasOwn(provided, name) ? provided[name] : definition.default;
    if (raw === null || raw === undefined || raw === '') {
      if (definition.required) throw new Fault(CODES.invalidRequest, { field: 'values', requiredVariable: name });
      values[name] = '';
      continue;
    }
    if (raw.length > definition.maxLength) {
      throw new Fault(CODES.invalidRequest, { field: 'values', variable: name, maxLength: definition.maxLength });
    }
    if (raw.includes('\0')) throw new Fault(CODES.invalidRequest, { field: 'values', variable: name });
    values[name] = raw;
  }
  return values;
}

/**
 * Substitute `{{name}}` placeholders. Unknown placeholders are rejected rather
 * than left literal, so a typo surfaces at preview time.
 * @param {string} text
 * @param {Record<string, string>} values
 * @param {{target: string}} where
 * @returns {string}
 */
export function substitute(text, values, where) {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name) => {
    if (!Object.hasOwn(values, name)) {
      throw new Fault(CODES.scaffoldInvalid, { reason: 'unknown-placeholder', variable: name, target: where.target });
    }
    return values[name];
  });
}

/**
 * Find one template in a descriptor.
 * @param {object} descriptor
 * @param {string|null} templateId
 * @returns {object}
 */
export function selectTemplate(descriptor, templateId) {
  const templates = descriptor.templates ?? [];
  if (templates.length === 0) throw new Fault(CODES.scaffoldInvalid, { reason: 'package-declares-no-templates' });
  if (templateId === null || templateId === undefined) {
    if (templates.length > 1) throw new Fault(CODES.invalidRequest, { field: 'templateId', available: templates.map((t) => t.id) });
    return templates[0];
  }
  const found = templates.find((template) => template.id === templateId);
  if (found === undefined) {
    throw new Fault(CODES.invalidRequest, { field: 'templateId', templateId, available: templates.map((t) => t.id) });
  }
  return found;
}

/**
 * Render every file of one template to bytes, without touching the workspace.
 * @param {object} descriptor
 * @param {object} template
 * @param {Record<string, string>} values
 * @returns {Promise<Array<{target: string, bytes: Buffer, render: string, text: string|null}>>}
 */
export async function renderTemplate(descriptor, template, values) {
  void descriptor;
  const rendered = [];
  for (const file of template.files) {
    const source = await readFile(file.source).catch(() => {
      throw new Fault(CODES.scaffoldInvalid, { reason: 'template-source-missing', source: file.sourceRelative });
    });
    if (file.render === 'copy') {
      rendered.push({ target: file.target, bytes: source, render: 'copy', text: null });
      continue;
    }
    if (source.includes(0)) {
      throw new Fault(CODES.scaffoldInvalid, { reason: 'text-template-is-binary', source: file.sourceRelative });
    }
    const text = substitute(source.toString('utf8'), values, { target: file.target });
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_RENDER_BYTES) {
      throw new Fault(CODES.scaffoldInvalid, {
        reason: 'rendered-too-large',
        target: file.target,
        bytes: bytes.length,
        limit: MAX_RENDER_BYTES,
      });
    }
    rendered.push({ target: file.target, bytes, render: 'text', text });
  }
  return rendered;
}

/**
 * @param {string} filePath
 * @returns {Promise<{exists: boolean, isDirectory: boolean, isFile: boolean, size: number}>}
 */
async function inspectPath(filePath) {
  try {
    const info = await stat(filePath);
    return { exists: true, isDirectory: info.isDirectory(), isFile: info.isFile(), size: info.size };
  } catch {
    return { exists: false, isDirectory: false, isFile: false, size: 0 };
  }
}

/**
 * Build a preview: what would be created, what is already identical, and what
 * blocks the operation.
 * @param {{workspaceRoot: string, descriptor: object, template: object, values: Record<string, string>, packageKey: string, workspaceId: string, bindingId: string}} input
 * @returns {Promise<object>}
 */
export async function buildPreview(input) {
  const files = [];
  const blocking = [];
  for (const file of await renderTemplate(input.descriptor, input.template, input.values)) {
    // Both the spelling and the filesystem location must be inside the
    // workspace: `linked/output.txt` can be literally inside while a junction
    // puts the real file elsewhere.
    const absolute = await resolveInsideReal(input.workspaceRoot, file.target);
    const current = await inspectPath(absolute);
    const digest = sha256Hex(file.bytes);
    let status = 'create';
    if (current.exists && current.isDirectory) {
      status = 'conflict';
      blocking.push({ target: file.target, reason: 'existing-directory' });
    } else if (current.exists) {
      const existing = await readFile(absolute);
      if (sha256Hex(existing) === digest) {
        status = 'identical';
      } else {
        status = 'conflict';
        blocking.push({ target: file.target, reason: 'different-content' });
      }
    }
    files.push({
      target: file.target,
      status,
      bytes: file.bytes.length,
      sha256: digest,
      text: file.render === 'text' && file.bytes.length <= PREVIEW_TEXT_BYTES ? file.text : null,
    });
  }
  return {
    previewId: newId(),
    workspaceId: input.workspaceId,
    bindingId: input.bindingId,
    packageKey: input.packageKey,
    templateId: input.template.id,
    workspaceRoot: input.workspaceRoot,
    values: input.values,
    files,
    blocking,
    creatable: files.filter((file) => file.status === 'create').length,
  };
}

/**
 * Undo the creations of one apply attempt.
 *
 * Safety argument for deleting these paths: the check phase proved every target
 * was absent, and each file was then created by our own
 * `writeFileAtomic(..., { overwrite: false })`, which opens with the exclusive
 * `wx` flag and therefore can never replace or truncate an existing entry. So a
 * path in `created` is a file this call exclusively produced, and unlinking it
 * cannot destroy anything a user wrote — with one exception, which is checked
 * rather than assumed: if someone wrote to that file between our create and
 * this rollback, the bytes no longer match what we wrote, the file is left
 * alone and reported. Every other outcome is reported too, never swallowed.
 *
 * Directories the writes had to create are removed again, deepest first and
 * only while empty: `rmdir` refuses a directory that holds anything, which is
 * exactly the signal that the user (or someone else) put something there and
 * that the directory must be left alone.
 *
 * @param {string} workspaceRoot
 * @param {Array<{target: string, sha256: string}>} created
 * @param {string[]} directories Deepest first; reversed here so each parent is
 *   removed only after the children inside it are gone.
 * @returns {Promise<{rolledBack: string[], rollbackFailed: Array<{target: string, detail: string}>, rollbackCleanupFailed: Array<{path: string, detail: string}>}>}
 */
async function rollBackCreated(workspaceRoot, created, directories) {
  const rolledBack = [];
  const rollbackFailed = [];
  for (const entry of [...created].reverse()) {
    try {
      const file = await resolveInsideReal(workspaceRoot, entry.target);
      const current = await readFile(file).catch(() => null);
      if (current !== null && sha256Hex(current) !== entry.sha256) {
        // Not ours to delete any more: somebody rewrote it after we created it.
        rollbackFailed.push({ target: entry.target, detail: 'modified after this apply created it' });
        continue;
      }
      await unlink(file);
      rolledBack.push(entry.target);
    } catch (error) {
      rollbackFailed.push({ target: entry.target, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const rollbackCleanupFailed = [];
  for (const directory of [...directories].reverse()) {
    try {
      await rmdir(directory);
    } catch (error) {
      // ENOTEMPTY just means the directory was never ours to take back, which
      // is the expected outcome whenever someone left something inside it.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') {
        rollbackCleanupFailed.push({ path: directory, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  // `rolledBack` is reported in creation order so it reads like `created`.
  rolledBack.reverse();
  return { rolledBack, rollbackFailed, rollbackCleanupFailed };
}

/**
 * Fields every `template-conflict` fault carries. A conflict discovered while
 * checking is raised before the write phase starts, so `created` is empty by
 * construction: the batch contract is "nothing at all, or everything".
 * @param {string} target
 * @param {string} reason
 * @param {object} [extra]
 * @returns {object}
 */
function conflictDetails(target, reason, extra = {}) {
  return { target, reason, created: [], rolledBack: [], ...extra };
}

/**
 * Apply a preview. Re-renders from the package, proves nothing changed, then
 * creates only the missing files with exclusive creation.
 *
 * The apply is deliberately two-phase. Phase one inspects every target and
 * decides `create` / `skipped` without touching the filesystem, so a conflict
 * anywhere in the batch is refused before a single byte is written — a batch
 * never half-lands because of a conflict. Phase two creates the missing files;
 * if that I/O itself fails, the files this call already created are rolled back
 * (see {@link rollBackCreated}) so the same whole-batch contract holds.
 *
 * @param {{preview: object, descriptor: object, template: object}} input
 * @returns {Promise<{created: string[], skipped: string[], unchanged: boolean}>}
 */
export async function applyPreview(input) {
  const files = await renderTemplate(input.descriptor, input.template, input.preview.values);
  const expected = new Map(input.preview.files.map((file) => [file.target, file]));
  for (const file of files) {
    const record = expected.get(file.target);
    if (record === undefined) {
      throw new Fault(CODES.previewStale, { reason: 'template-changed', target: file.target });
    }
    if (record.sha256 !== sha256Hex(file.bytes)) {
      throw new Fault(CODES.previewStale, { reason: 'rendered-content-changed', target: file.target });
    }
  }
  if (files.length !== input.preview.files.length) {
    throw new Fault(CODES.previewStale, { reason: 'template-file-count-changed' });
  }

  // Phase one: check every target before writing any of them. Nothing here
  // touches the filesystem except to read, so a conflict raised below leaves
  // the workspace exactly as it was.
  const toCreate = [];
  const skipped = [];
  for (const file of files) {
    // Re-proved here, not just at preview time: a directory can be replaced by
    // a link between the preview and this write.
    const absolute = await resolveInsideReal(input.preview.workspaceRoot, file.target);
    const current = await inspectPath(absolute);
    if (current.exists) {
      if (current.isDirectory) {
        throw new Fault(CODES.templateConflict, conflictDetails(file.target, 'existing-directory'));
      }
      const existing = await readFile(absolute);
      if (sha256Hex(existing) === sha256Hex(file.bytes)) {
        skipped.push(file.target);
        continue;
      }
      // Someone wrote this file between preview and apply. Refuse the whole
      // batch; because every target is checked before the first write, nothing
      // has been created and `created` is empty for real, not by convention.
      throw new Fault(CODES.templateConflict, conflictDetails(file.target, 'modified-after-preview'));
    }
    toCreate.push({ target: file.target, absolute, bytes: file.bytes });
  }

  // Phase two: create only the missing files. Which directories are still
  // missing is decided once here, before the first write of this attempt, so a
  // failed batch knows exactly which directories were its own doing.
  const created = [];
  // Same files, with the digest this apply wrote: the rollback needs it to tell
  // its own bytes from a user's later edit. Kept separate so the returned
  // `created` stays an array of target strings.
  const createdEntries = [];
  const createdDirectories = [];
  for (const file of toCreate) {
    for (let parent = dirname(file.absolute); !(await inspectPath(parent)).exists; parent = dirname(parent)) {
      createdDirectories.push(parent);
    }
  }

  for (const file of toCreate) {
    try {
      await writeFileAtomic(file.absolute, file.bytes, { overwrite: false });
      created.push(file.target);
      createdEntries.push({ target: file.target, sha256: sha256Hex(file.bytes) });
    } catch (error) {
      const { rolledBack, rollbackFailed, rollbackCleanupFailed } = await rollBackCreated(
        input.preview.workspaceRoot,
        createdEntries,
        createdDirectories,
      );
      throw new Fault(CODES.templateConflict, {
        target: file.target,
        reason: 'create-failed',
        detail: error instanceof Error ? error.message : String(error),
        created,
        rolledBack,
        rollbackFailed,
        rollbackCleanupFailed,
        leftBehind: rollbackFailed.map((entry) => entry.target),
        partial:
          rollbackFailed.length > 0 || rollbackCleanupFailed.length > 0
            ? 'rollback-incomplete: this apply still left files or directories in the workspace'
            : 'rolled-back: this apply left no file behind',
      });
    }
  }
  return { created, skipped, unchanged: created.length === 0 };
}
