/**
 * Template preview and application.
 *
 * Generation is deliberately two steps and never overwrites: a preview states
 * exactly which files would be created, and the apply re-derives the same bytes
 * before writing. If the package or the target changed in between, the apply
 * refuses instead of guessing.
 * @module dsh-workspace-scaffolds/templates
 */
import { readFile, stat } from 'node:fs/promises';
import { Fault, CODES } from './errors.js';
import { MAX_RENDER_BYTES } from './scaffold.js';
import { newId, resolveInside, sha256Hex, writeFileAtomic } from './util.js';

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
    const absolute = resolveInside(input.workspaceRoot, file.target);
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
 * Apply a preview. Re-renders from the package, proves nothing changed, then
 * creates only the missing files with exclusive creation.
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

  const created = [];
  const skipped = [];
  for (const file of files) {
    const absolute = resolveInside(input.preview.workspaceRoot, file.target);
    const current = await inspectPath(absolute);
    if (current.exists) {
      if (current.isDirectory) throw new Fault(CODES.templateConflict, { target: file.target, reason: 'existing-directory' });
      const existing = await readFile(absolute);
      if (sha256Hex(existing) === sha256Hex(file.bytes)) {
        skipped.push(file.target);
        continue;
      }
      // Someone wrote this file between preview and apply. Refuse the whole
      // batch; nothing has been created yet at this point in the loop only for
      // the first conflicting entry, so report everything already created.
      throw new Fault(CODES.templateConflict, {
        target: file.target,
        reason: 'modified-after-preview',
        created,
      });
    }
    try {
      await writeFileAtomic(absolute, file.bytes, { overwrite: false });
      created.push(file.target);
    } catch (error) {
      throw new Fault(CODES.templateConflict, {
        target: file.target,
        reason: 'create-failed',
        detail: error instanceof Error ? error.message : String(error),
        created,
      });
    }
  }
  return { created, skipped, unchanged: created.length === 0 };
}
