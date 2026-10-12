/**
 * The optional scaffold descriptor a package may ship alongside its native
 * `dsh.bundle` declaration. Reading it never executes package code.
 * @module dsh-workspace-scaffolds/scaffold
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, CODES } from './errors.js';
import { isNonEmptyString, isPlainObject } from './schema.js';
import { resolveInside } from './util.js';

/** Variable names allowed inside `{{...}}` placeholders. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Cap on one rendered text file, so a runaway template cannot exhaust memory. */
export const MAX_RENDER_BYTES = 8 * 1024 * 1024;

/**
 * Read and validate the scaffold descriptor of an installed package.
 * @param {string} packageDir Absolute package directory.
 * @returns {Promise<object|null>} The descriptor, or null when the package
 *   declares no templates. A package that declares one but is malformed is a
 *   refusal, not a silent null.
 */
export async function readScaffoldDescriptor(packageDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const declared = manifest?.workspaceScaffold;
  if (declared === undefined || declared === null) return null;
  if (typeof declared !== 'string') {
    throw new Fault(CODES.scaffoldInvalid, { reason: 'workspaceScaffold-must-be-string' });
  }
  const descriptorPath = resolveInside(packageDir, declared.replace(/^\.\//, ''));
  let raw;
  try {
    raw = JSON.parse(await readFile(descriptorPath, 'utf8'));
  } catch (error) {
    throw new Fault(CODES.scaffoldInvalid, {
      reason: 'descriptor-unreadable',
      path: declared,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return validateDescriptor(raw, { packageDir, manifest });
}

/**
 * Validate a scaffold descriptor and resolve every template source inside the
 * package directory.
 * @param {any} raw
 * @param {{packageDir: string, manifest: object}} context
 * @returns {object}
 */
export function validateDescriptor(raw, context) {
  if (!isPlainObject(raw)) throw new Fault(CODES.scaffoldInvalid, { reason: 'descriptor-not-object' });
  if (raw.schemaVersion !== 1) {
    throw new Fault(CODES.scaffoldInvalid, { reason: 'unsupported-schema-version', schemaVersion: raw.schemaVersion });
  }
  const variables = {};
  if (raw.variables !== undefined) {
    if (!isPlainObject(raw.variables)) throw new Fault(CODES.scaffoldInvalid, { reason: 'variables-not-object' });
    for (const [name, definition] of Object.entries(raw.variables)) {
      if (!VARIABLE_NAME.test(name)) throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-variable-name', name });
      if (!isPlainObject(definition)) throw new Fault(CODES.scaffoldInvalid, { reason: 'variable-not-object', name });
      if (definition.type !== undefined && definition.type !== 'string') {
        throw new Fault(CODES.scaffoldInvalid, { reason: 'unsupported-variable-type', name, type: definition.type });
      }
      variables[name] = {
        type: 'string',
        required: definition.required === true,
        default: typeof definition.default === 'string' ? definition.default : null,
        maxLength: Number.isInteger(definition.maxLength) && definition.maxLength > 0 ? definition.maxLength : 2000,
        description: typeof definition.description === 'string' ? definition.description : null,
      };
    }
  }
  const requires = [];
  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires)) throw new Fault(CODES.scaffoldInvalid, { reason: 'requires-not-array' });
    for (const entry of raw.requires) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.name) || !isNonEmptyString(entry.version)) {
        throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-requirement', entry });
      }
      requires.push({ name: entry.name, version: entry.version });
    }
  }
  const templates = [];
  if (raw.templates !== undefined) {
    if (!Array.isArray(raw.templates)) throw new Fault(CODES.scaffoldInvalid, { reason: 'templates-not-array' });
    for (const entry of raw.templates) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.id)) {
        throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-template' });
      }
      if (!Array.isArray(entry.files) || entry.files.length === 0) {
        throw new Fault(CODES.scaffoldInvalid, { reason: 'template-without-files', templateId: entry.id });
      }
      const seenTargets = new Set();
      const files = entry.files.map((file) => {
        if (!isPlainObject(file) || !isNonEmptyString(file.source) || !isNonEmptyString(file.target)) {
          throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-template-file', templateId: entry.id });
        }
        const render = file.render ?? 'text';
        if (render !== 'text' && render !== 'copy') {
          throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-render-mode', templateId: entry.id, render });
        }
        const normalizedTarget = file.target.replace(/\\/g, '/').replace(/^\.\//, '');
        const collisionKey = process.platform === 'win32' ? normalizedTarget.toLowerCase() : normalizedTarget;
        if (seenTargets.has(collisionKey)) {
          throw new Fault(CODES.scaffoldInvalid, { reason: 'duplicate-target', templateId: entry.id, target: file.target });
        }
        seenTargets.add(collisionKey);
        // Resolving here proves both the source stays inside the package and the
        // target stays inside the workspace before any file is touched.
        const source = resolveInside(context.packageDir, file.source.replace(/\\/g, '/').replace(/^\.\//, ''));
        return { source, sourceRelative: file.source, target: normalizedTarget, render };
      });
      for (const file of files) {
        if (file.target.startsWith('.git/') || file.target === '.git') {
          throw new Fault(CODES.scaffoldInvalid, { reason: 'target-inside-git', templateId: entry.id, target: file.target });
        }
      }
      templates.push({
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title : entry.id,
        files,
      });
    }
  }
  return {
    packageName: typeof context.manifest?.name === 'string' ? context.manifest.name : null,
    version: typeof context.manifest?.version === 'string' ? context.manifest.version : null,
    title: typeof raw.title === 'string' ? raw.title : (typeof context.manifest?.name === 'string' ? context.manifest.name : 'scaffold'),
    requires,
    variables,
    templates,
  };
}

/**
 * Summarize a descriptor for the state file, without absolute paths.
 * @param {object|null} descriptor
 * @returns {object|null}
 */
export function summarizeDescriptor(descriptor) {
  if (descriptor === null) return null;
  return {
    title: descriptor.title,
    templateIds: descriptor.templates.map((template) => template.id),
    variables: Object.fromEntries(
      Object.entries(descriptor.variables).map(([name, definition]) => [
        name,
        { required: definition.required, default: definition.default, description: definition.description },
      ]),
    ),
  };
}
