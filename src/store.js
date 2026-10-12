/**
 * Durable state: load, backup recovery, revision-guarded mutation and the
 * idempotency log. Nothing here touches DSH services, so the store is testable
 * against a plain temporary directory.
 * @module dsh-workspace-scaffolds/store
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, CODES } from './errors.js';
import {
  OPERATION_LOG_LIMIT,
  PREVIEW_TTL_MS,
  emptyState,
  normalizeState,
} from './schema.js';
import {
  clone,
  nowIso,
  pathExists,
  readJson,
  requestHashOf,
  stableStringify,
  withKeyLock,
  writeJsonAtomic,
} from './util.js';

/**
 * Owns `state.json` inside one directory. Every write is revision-guarded and
 * logged, so a repeated `operationId` returns the original outcome instead of
 * applying the change twice.
 */
export class Store {
  /** @param {string} directory The `<profileDir>/workspace-scaffolds` directory. */
  constructor(directory) {
    this.directory = directory;
    this.statePath = join(directory, 'state.json');
    this.backupPath = join(directory, 'state.json.bak');
    this.archiveDir = join(directory, 'archives');
    this.operationDir = join(directory, 'operations');
    this.stagingDir = join(directory, 'staging');
    /** @type {object|null} */
    this.state = null;
    /** @type {string|null} */
    this.recoveryNote = null;
  }

  /** Create the directory layout and load state, recovering from the backup when needed. */
  async init() {
    await mkdir(this.directory, { recursive: true });
    await mkdir(this.archiveDir, { recursive: true });
    await mkdir(this.operationDir, { recursive: true });
    await mkdir(this.stagingDir, { recursive: true });
    this.state = await this.#load();
    return this.state;
  }

  async #load() {
    if (!(await pathExists(this.statePath))) {
      if (await pathExists(this.backupPath)) {
        const recovered = await this.#loadFrom(this.backupPath, 'restored-from-backup');
        if (recovered !== null) return recovered;
      }
      return emptyState();
    }
    const primary = await this.#loadFrom(this.statePath, null);
    if (primary !== null) return primary;
    // A malformed primary is never treated as an empty state: that would silently
    // drop every association. The verified backup is used, or startup fails.
    const backupExists = await pathExists(this.backupPath);
    if (!backupExists) {
      throw new Fault(CODES.stateCorrupt, { path: this.statePath, reason: 'malformed-and-no-backup' });
    }
    const recovered = await this.#loadFrom(this.backupPath, 'restored-from-backup');
    if (recovered === null) {
      throw new Fault(CODES.stateCorrupt, { path: this.statePath, reason: 'malformed-and-backup-malformed' });
    }
    return recovered;
  }

  async #loadFrom(filePath, note) {
    try {
      const raw = await readJson(filePath);
      const normalized = normalizeState(raw);
      if (note !== null) this.recoveryNote = note;
      return normalized;
    } catch (error) {
      if (error instanceof Fault && error.code === CODES.unsupportedHost) throw error;
      return null;
    }
  }

  /** @returns {number} Current committed revision. */
  get revision() {
    if (this.state === null) throw new Fault(CODES.stateCorrupt, { reason: 'not-initialized' });
    return this.state.revision;
  }

  /** @returns {object} A defensive copy of the committed state. */
  snapshot() {
    if (this.state === null) throw new Fault(CODES.stateCorrupt, { reason: 'not-initialized' });
    return clone(this.state);
  }

  /**
   * Read-only access without copying, for internal callers that must not write.
   * @returns {object}
   */
  peek() {
    if (this.state === null) throw new Fault(CODES.stateCorrupt, { reason: 'not-initialized' });
    return this.state;
  }

  /**
   * Apply one revision-guarded change.
   *
   * Ordering matters: the idempotency log is consulted *before* the revision
   * check, so a successful call retried with the same `operationId` returns its
   * original result even though the revision has since moved on.
   *
   * @param {{action: string, operationId?: string, expectedRevision?: number}} request
   * @param {(draft: object, context: {operationId: string|undefined, action: string}) => any} apply
   *   Mutates `draft` and optionally returns the operation's value.
   * @returns {Promise<{value: any, revision: number, replayed: boolean}>}
   */
  async mutate(request, apply) {
    const action = request.action;
    return await withKeyLock(`state:${this.directory}`, async () => {
      const operationId = request.operationId;
      const hash = requestHashOf({ action, request: this.#requestArguments(request) });
      if (operationId !== undefined) {
        const existing = this.peek().operations[operationId];
        if (existing !== undefined) {
          if (existing.requestHash !== hash) {
            throw new Fault(CODES.operationIdReused, {
              operationId,
              recordedAction: existing.action,
              requestedAction: action,
            });
          }
          return { value: existing.result, revision: this.revision, replayed: true };
        }
      }
      if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision) {
        throw new Fault(CODES.revisionConflict, {
          expectedRevision: request.expectedRevision,
          currentRevision: this.revision,
        });
      }
      const draft = clone(this.state);
      const value = await apply(draft, { operationId, action });
      draft.schemaVersion = this.state.schemaVersion;
      draft.revision = this.revision + 1;
      draft.previews = prunePreviews(draft.previews);
      if (operationId !== undefined) {
        draft.operations[operationId] = {
          operationId,
          action,
          requestHash: hash,
          status: 'committed',
          result: value === undefined ? null : jsonSafe(value),
          at: nowIso(),
        };
        draft.operations = pruneOperations(draft.operations);
      }
      await this.#commit(draft);
      return { value, revision: draft.revision, replayed: false };
    });
  }

  /**
   * The arguments a replay compares: the caller-supplied `args` when present,
   * otherwise every request field except the bookkeeping ones. Callers that
   * build their own normalized argument object pass it as `args`, so the request
   * hash and the caller's replay hash can never disagree.
   * @returns {object}
   */
  #requestArguments(request) {
    const { action, operationId, expectedRevision, args, ...rest } = request;
    void action;
    void operationId;
    void expectedRevision;
    return jsonSafe(args ?? rest);
  }

  async #commit(draft) {
    const previous = this.state;
    const normalized = normalizeState(draft);
    await writeJsonAtomic(this.statePath, normalized);
    if (previous !== null) {
      await writeJsonAtomic(this.backupPath, previous).catch(() => {});
    }
    this.state = normalized;
  }

  /**
   * Record a preview produced by a read-shaped action. Previews live in their
   * own map so they never bump the workspace revision that callers guard on.
   * @param {object} preview
   * @returns {Promise<object>} The stored preview.
   */
  async putPreview(preview) {
    // Same lock key as mutate(): a preview write and a configuration write both
    // rewrite the whole document, so they must not interleave.
    return await withKeyLock(`state:${this.directory}`, async () => {
      const draft = clone(this.state);
      draft.previews[preview.previewId] = {
        ...preview,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS).toISOString(),
      };
      draft.previews = prunePreviews(draft.previews);
      // Deliberately no revision bump: a preview is not a configuration change.
      await writeJsonAtomic(this.statePath, normalizeState(draft));
      this.state = normalizeState(draft);
      return clone(this.state.previews[preview.previewId]);
    });
  }

  /**
   * @param {string} previewId
   * @returns {object} The live preview.
   * @throws {Fault} `preview-expired` when absent or past its TTL.
   */
  takePreview(previewId) {
    const preview = this.peek().previews[previewId];
    if (preview === undefined) throw new Fault(CODES.previewExpired, { previewId });
    if (Date.parse(preview.expiresAt) <= Date.now()) throw new Fault(CODES.previewExpired, { previewId });
    return clone(preview);
  }

  /** @param {string} previewId @returns {Promise<void>} */
  async dropPreview(previewId) {
    await withKeyLock(`state:${this.directory}`, async () => {
      const draft = clone(this.state);
      if (draft.previews[previewId] === undefined) return;
      delete draft.previews[previewId];
      await writeJsonAtomic(this.statePath, normalizeState(draft));
      this.state = normalizeState(draft);
    });
  }

  /**
   * @param {string} operationId
   * @returns {object|null} The recorded outcome, or null.
   */
  operation(operationId) {
    return this.peek().operations[operationId] ?? null;
  }

  /**
   * Remember the native enablement state this plugin last applied for a package.
   *
   * Written outside the caller's operation because it has to survive a restart:
   * a later reconciliation needs it to tell a bundle this plugin turned on and
   * has not released from one somebody else turned on. It cannot be folded into
   * the caller's mutate, because the native write happens before that mutate
   * commits.
   *
   * A no-op when the value is unchanged, so ordinary operation counts are not
   * inflated by writes that carry no information.
   *
   * The revision is deliberately *not* bumped, exactly as for preview records:
   * this is bookkeeping about what the native side was observed to be, not a
   * configuration change a caller guards with `expectedRevision`. Bumping it
   * would invalidate the revision of the very operation performing the native
   * write, since that write happens before the caller's own mutation commits.
   * The state lock still serializes this against every other writer.
   * @param {string} key Package key `name@version`.
   * @param {boolean} enabled The state just applied.
   * @returns {Promise<boolean>} Whether the stored record changed.
   */
  async recordApplied(key, enabled) {
    return await withKeyLock(`state:${this.directory}`, async () => {
      const draft = clone(this.state);
      const record = draft.packages[key];
      if (record === undefined) return false;
      if (record.lastAppliedEnabled === enabled) return false;
      record.lastAppliedEnabled = enabled;
      const normalized = normalizeState(draft);
      await writeJsonAtomic(this.statePath, normalized);
      this.state = normalized;
      return true;
    });
  }

  /** @param {object} value @returns {any} A JSON round-trip copy safe to persist and return. */
  static jsonSafe(value) {
    return jsonSafe(value);
  }
}

/**
 * Drop stale preview records.
 * @param {Record<string, object>} previews
 * @returns {Record<string, object>}
 */
function prunePreviews(previews) {
  const cutoff = Date.now();
  const kept = {};
  for (const [id, preview] of Object.entries(previews)) {
    if (typeof preview?.expiresAt === 'string' && Date.parse(preview.expiresAt) > cutoff) kept[id] = preview;
  }
  return kept;
}

/**
 * Keep the operation log bounded, oldest first.
 * @param {Record<string, object>} operations
 * @returns {Record<string, object>}
 */
function pruneOperations(operations) {
  const entries = Object.entries(operations);
  if (entries.length <= OPERATION_LOG_LIMIT) return operations;
  entries.sort((left, right) => String(left[1].at).localeCompare(String(right[1].at)));
  return Object.fromEntries(entries.slice(entries.length - OPERATION_LOG_LIMIT));
}

/**
 * Convert a value to something JSON can hold. Cycles, functions and symbols are
 * replaced rather than throwing, because these values land in the operation log
 * and in HTTP responses where a throw would corrupt a successful operation.
 * @param {any} value
 * @returns {any}
 */
export function jsonSafe(value, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null) return null;
  const type = typeof value;
  if (type === 'function' || type === 'symbol' || type === 'bigint') return String(value);
  if (type !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => jsonSafe(entry, seen));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'function') continue;
    out[key] = jsonSafe(entry, seen);
  }
  return out;
}
