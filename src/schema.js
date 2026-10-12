/**
 * Persistent state shape, defaults and validation. The stored document is the
 * only authority for workspace associations; everything derived (leases, ready
 * state, native runtime status) is recomputed on read rather than trusted.
 * @module dsh-workspace-scaffolds/schema
 */
import { Fault, CODES } from './errors.js';
import { nowIso } from './util.js';

/** Current on-disk schema version. A higher stored version is refused, never migrated down. */
export const SCHEMA_VERSION = 1;

/** Operation-log entries retained; older records are dropped on write. */
export const OPERATION_LOG_LIMIT = 200;

/** Preview records expire after this many milliseconds. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;

/** @returns {object} A brand-new empty state document. */
export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    workspaces: {},
    packages: {},
    previews: {},
    operations: {},
  };
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isBoolean = (value) => typeof value === 'boolean';
const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function refuse(reason, detail) {
  throw new Fault(CODES.stateCorrupt, { reason, ...(detail === undefined ? {} : { detail }) });
}

/**
 * Validate and copy a `requires` list - the dependency edges of one scaffold
 * descriptor.
 *
 * Deliberately one definition shared by the two places an edge can enter the
 * plugin: `scaffold.js` when a descriptor is read, and `normalizePackage` when
 * the summary is loaded back from disk. The
 * coordinator trusts `record.scaffold.requires`, so a malformed entry must be
 * refused rather than repaired here: silently dropping it would switch off
 * exactly the dependency ordering and cycle detection this field feeds.
 *
 * An absent field is an empty list - "declares no dependencies". That is also
 * what a package record written before this field existed normalizes to; see
 * the note in {@link normalizePackage}.
 * @param {any} value
 * @returns {Array<{name: string, version: string}>}
 */
export function readRequires(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Fault(CODES.scaffoldInvalid, { reason: 'requires-not-array' });
  return value.map((entry) => {
    if (!isPlainObject(entry) || !isNonEmptyString(entry.name) || !isNonEmptyString(entry.version)) {
      throw new Fault(CODES.scaffoldInvalid, { reason: 'bad-requirement', entry });
    }
    return { name: entry.name, version: entry.version };
  });
}

/**
 * Validate and normalize the parts of a package record that come from disk.
 * @param {any} raw
 * @param {string} key
 * @returns {object}
 */
function normalizePackage(raw, key) {
  if (!isPlainObject(raw)) refuse('package-not-object', key);
  const archiveSha256 = raw.archiveSha256 ?? null;
  if (archiveSha256 !== null && !isSha256(archiveSha256)) refuse('package-bad-hash', key);
  const sourceKind = raw.sourceKind;
  if (!['local-directory', 'tarball', 'installed'].includes(sourceKind)) refuse('package-bad-source', key);
  const restoreCapability = raw.restoreCapability;
  if (!['archived', 'installed-only'].includes(restoreCapability)) refuse('package-bad-restore', key);
  const ownership = raw.ownership;
  if (!['managed', 'external'].includes(ownership)) refuse('package-bad-ownership', key);
  return {
    archiveSha256,
    sourceKind,
    restoreCapability,
    initiallyEnabled: raw.initiallyEnabled === true,
    ownership,
    pinned: raw.pinned === true,
    // The enablement this plugin last applied or observed. `null` means the
    // provenance is unknown - a record written before this field existed - and
    // reconcile treats that as "leave it alone and report", never as proof of
    // either our own leftover or somebody else's intent.
    lastAppliedEnabled:
      raw.lastAppliedEnabled === true ? true : raw.lastAppliedEnabled === false ? false : null,
    title: typeof raw.title === 'string' ? raw.title : null,
    importedAt: typeof raw.importedAt === 'string' ? raw.importedAt : nowIso(),
    archiveEntryCount: Number.isInteger(raw.archiveEntryCount) ? raw.archiveEntryCount : null,
    archiveBytes: Number.isInteger(raw.archiveBytes) ? raw.archiveBytes : null,
    scaffold: isPlainObject(raw.scaffold)
      ? {
          title: typeof raw.scaffold.title === 'string' ? raw.scaffold.title : null,
          templateIds: Array.isArray(raw.scaffold.templateIds)
            ? raw.scaffold.templateIds.filter(isNonEmptyString)
            : [],
          variables: isPlainObject(raw.scaffold.variables) ? raw.scaffold.variables : {},
          // Carried through the state round-trip, never re-derived: the
          // coordinator reads dependency edges from this field, so a
          // normalizer that dropped it silently disabled dependency ordering,
          // missing-dependency refusal and cycle detection on the real path.
          //
          // A record written before `requires` existed has no such key and
          // normalizes to `[]` - the dependency rules simply do not apply to
          // it. The alternative, re-reading the descriptor out of the stored
          // archive, is I/O that this pure normalizer cannot perform (and it
          // would be a hidden fetch on every state load). `[]` is also the
          // honest reading of the old document: it declares no edges. Nothing
          // is lost permanently, because re-importing the same package
          // rewrites the record from its descriptor and restores the edges.
          requires: readRequires(raw.scaffold.requires),
        }
      : null,
  };
}

/**
 * Validate and normalize one binding.
 * @param {any} raw
 * @param {string} workspaceId
 * @returns {object}
 */
function normalizeBinding(raw, workspaceId) {
  if (!isPlainObject(raw)) refuse('binding-not-object', workspaceId);
  if (!isNonEmptyString(raw.id)) refuse('binding-bad-id', workspaceId);
  if (!isNonEmptyString(raw.packageName)) refuse('binding-bad-name', workspaceId);
  if (!isNonEmptyString(raw.version)) refuse('binding-bad-version', workspaceId);
  const archiveSha256 = raw.archiveSha256 ?? null;
  if (archiveSha256 !== null && !isSha256(archiveSha256)) refuse('binding-bad-hash', workspaceId);
  return {
    id: raw.id,
    packageName: raw.packageName,
    version: raw.version,
    archiveSha256,
    enabled: raw.enabled !== false,
    required: raw.required !== false,
    templateId: typeof raw.templateId === 'string' ? raw.templateId : null,
    templateValues: isPlainObject(raw.templateValues) ? { ...raw.templateValues } : {},
    lastGeneratedAt: typeof raw.lastGeneratedAt === 'string' ? raw.lastGeneratedAt : null,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : nowIso(),
  };
}

/**
 * Validate and normalize one workspace record.
 * @param {any} raw
 * @param {string} workspaceId
 * @returns {object}
 */
function normalizeWorkspace(raw, workspaceId) {
  if (!isPlainObject(raw)) refuse('workspace-not-object', workspaceId);
  const requestedState = raw.requestedState;
  if (!['awake', 'sleeping'].includes(requestedState)) refuse('workspace-bad-state', workspaceId);
  const bindings = Array.isArray(raw.bindings) ? raw.bindings.map((b) => normalizeBinding(b, workspaceId)) : [];
  const seen = new Set();
  for (const binding of bindings) {
    const key = `${binding.packageName}@${binding.version}`;
    if (seen.has(key)) refuse('workspace-duplicate-binding', `${workspaceId} ${key}`);
    seen.add(key);
  }
  return {
    workspaceId,
    lastKnownPath: typeof raw.lastKnownPath === 'string' ? raw.lastKnownPath : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    autoRestore: raw.autoRestore !== false,
    requestedState,
    bindings,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  };
}

/**
 * Validate a complete stored document.
 * @param {any} raw
 * @returns {object} A normalized, defensively copied state.
 */
export function normalizeState(raw) {
  if (!isPlainObject(raw)) refuse('state-not-object');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
      throw new Fault(CODES.unsupportedHost, {
        reason: 'future-schema',
        stored: raw.schemaVersion,
        supported: SCHEMA_VERSION,
      });
    }
    refuse('state-version-unknown', raw.schemaVersion);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 0) refuse('state-bad-revision');
  if (!isPlainObject(raw.workspaces)) refuse('state-bad-workspaces');
  if (!isPlainObject(raw.packages)) refuse('state-bad-packages');

  const workspaces = {};
  for (const [workspaceId, value] of Object.entries(raw.workspaces)) {
    if (!isNonEmptyString(workspaceId)) refuse('state-bad-workspace-id');
    workspaces[workspaceId] = normalizeWorkspace(value, workspaceId);
  }
  const packages = {};
  for (const [key, value] of Object.entries(raw.packages)) {
    if (!isNonEmptyString(key)) refuse('state-bad-package-key');
    packages[key] = normalizePackage(value, key);
  }
  const previews = {};
  if (isPlainObject(raw.previews)) {
    for (const [previewId, value] of Object.entries(raw.previews)) {
      if (isPlainObject(value) && isNonEmptyString(value.workspaceId)) previews[previewId] = value;
    }
  }
  const operations = {};
  if (isPlainObject(raw.operations)) {
    for (const [operationId, value] of Object.entries(raw.operations)) {
      if (isPlainObject(value) && isNonEmptyString(value.action)) operations[operationId] = value;
    }
  }
  return { schemaVersion: SCHEMA_VERSION, revision: raw.revision, workspaces, packages, previews, operations };
}

/**
 * Normalize one inbound binding request.
 * @param {any} args
 * @returns {{packageName: string, version: string, archiveSha256: string|null, enabled: boolean, required: boolean}}
 */
export function readBindRequest(args) {
  if (!isPlainObject(args)) throw new Fault(CODES.invalidRequest, { field: 'binding' });
  if (!isNonEmptyString(args.packageName)) throw new Fault(CODES.invalidRequest, { field: 'packageName' });
  if (!isNonEmptyString(args.version)) throw new Fault(CODES.invalidRequest, { field: 'version' });
  const archiveSha256 = args.archiveSha256 ?? null;
  if (archiveSha256 !== null && !isSha256(archiveSha256)) {
    throw new Fault(CODES.invalidRequest, { field: 'archiveSha256' });
  }
  if (args.enabled !== undefined && !isBoolean(args.enabled)) {
    throw new Fault(CODES.invalidRequest, { field: 'enabled' });
  }
  if (args.required !== undefined && !isBoolean(args.required)) {
    throw new Fault(CODES.invalidRequest, { field: 'required' });
  }
  return {
    packageName: args.packageName,
    version: args.version,
    archiveSha256,
    enabled: args.enabled !== false,
    required: args.required !== false,
  };
}

export { isPlainObject, isNonEmptyString, isSha256 };
