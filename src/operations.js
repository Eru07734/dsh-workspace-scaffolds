/**
 * Every use case the plugin offers, in one place. The HTTP surface and the agent
 * tool are thin wrappers over {@link Operations.execute}, so the two can never
 * drift apart in behaviour.
 * @module dsh-workspace-scaffolds/operations
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Fault, CODES } from './errors.js';
import { archivePath, importFromPath } from './archive.js';
import { leasesOf, planSleep, planWake } from './coordinator.js';
import { evaluatePackage, readBundles } from './inventory.js';
import { SleepQueue } from './lifecycle.js';
import { readScaffoldDescriptor, summarizeDescriptor } from './scaffold.js';
import { readBindRequest } from './schema.js';
import { applyPreview, buildPreview, resolveVariables, selectTemplate } from './templates.js';
import { jsonSafe } from './store.js';
import {
  canonicalize,
  newId,
  nowIso,
  packageKey,
  parsePackageKey,
  pathExists,
  requestHashOf,
  resolveInside,
  samePath,
  sha256Hex,
} from './util.js';

/** Actions that never change configuration. */
export const READ_ACTIONS = new Set(['list', 'operation-status', 'scaffolds']);
/** Actions that mutate configuration and therefore require a revision guard. */
export const WRITE_ACTIONS = new Set([
  'import',
  'bind',
  'unbind',
  'update-binding',
  'set-pin',
  'wake',
  'sleep',
  'template-apply',
  'delete-archive',
]);

/** Everything the plugin accepts. */
export const ACTIONS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS, 'template-preview', 'reconcile']);

/**
 * The caller-supplied arguments of one request, without the bookkeeping fields.
 * Shared by the replay check and the revision-guarded write so both compute the
 * same request hash.
 * @param {object} request
 * @returns {object}
 */
export function canonicalArgs(request) {
  const { action, operationId, expectedRevision, ...rest } = request;
  void action;
  void operationId;
  void expectedRevision;
  return jsonSafe(rest);
}

/**
 * Owns the plugin's behaviour. One instance per applied plugin.
 */
export class Operations {
  /**
   * @param {{host: object, store: import('./store.js').Store, activity: import('./lifecycle.js').Activity}} deps
   */
  constructor(deps) {
    this.host = deps.host;
    this.store = deps.store;
    this.activity = deps.activity;
    /** @type {SleepQueue|null} */
    this.sleepQueue = null;
    /** Whether `agent/created` may attempt a restore. Updated by the caller after probing. */
    this.automaticRestore = 'enabled';
  }

  /** Wire the deferred-sleep queue to this instance. */
  init() {
    this.sleepQueue = new SleepQueue(this.activity, (workspaceId, trigger) => this.#applyDeferredSleep(workspaceId, trigger));
  }

  /** @returns {void} */
  dispose() {
    this.sleepQueue?.dispose();
  }

  /**
   * Resolve the workspace a directory belongs to, using the native registry.
   *
   * This deliberately consults the *native* registry rather than our own state:
   * a session's workspace must be resolvable before anything has been associated
   * with it, otherwise the first `bind` from an agent could never find its
   * target.
   * @param {string} cwd
   * @returns {Promise<string|null>}
   */
  async workspaceIdForPath(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    const resolved = await canonicalize(cwd);
    for (const workspace of this.host.listWorkspaces()) {
      const candidate = await canonicalize(workspace.path);
      if (samePath(candidate, resolved)) return workspace.workspaceId;
    }
    return null;
  }

  /**
   * Dispatch one request.
   * @param {object} request `{action, operationId?, expectedRevision?, ...args}`
   * @returns {Promise<any>}
   */
  async execute(request) {
    if (request === null || typeof request !== 'object') throw new Fault(CODES.invalidRequest, { field: 'request' });
    const action = request.action;
    if (typeof action !== 'string' || !ACTIONS.has(action)) {
      throw new Fault(CODES.invalidRequest, { field: 'action', action, allowed: [...ACTIONS].sort() });
    }
    if (WRITE_ACTIONS.has(action)) {
      if (typeof request.operationId !== 'string' || request.operationId.length === 0) {
        throw new Fault(CODES.invalidRequest, { field: 'operationId' });
      }
      if (!Number.isInteger(request.expectedRevision)) {
        throw new Fault(CODES.invalidRequest, { field: 'expectedRevision' });
      }
      // Both guards are applied here, once, in this order, rather than inside
      // each action:
      //
      // 1. A recorded operationId with identical arguments is a retry and must
      //    return its original outcome even though the revision has moved on.
      // 2. Otherwise a stale revision is refused *before* the action runs. An
      //    action that would have been a harmless no-op (sleep on a workspace
      //    with no association) still reports the conflict, so a caller can
      //    never mistake "your snapshot was stale" for "everything was fine".
      const replayed = this.#replayOf(action, request);
      if (replayed !== null) return replayed;
      if (request.expectedRevision !== this.store.revision) {
        throw new Fault(CODES.revisionConflict, {
          expectedRevision: request.expectedRevision,
          currentRevision: this.store.revision,
        });
      }
    }
    switch (action) {
      case 'list':
        return await this.#list();
      case 'scaffolds':
        return await this.#scaffolds(request);
      case 'operation-status':
        return this.#operationStatus(request);
      case 'import':
        return await this.#import(request);
      case 'bind':
        return await this.#bind(request);
      case 'unbind':
        return await this.#unbind(request);
      case 'update-binding':
        return await this.#updateBinding(request);
      case 'set-pin':
        return await this.#setPin(request);
      case 'wake':
        return await this.#wake(request);
      case 'sleep':
        return await this.#sleep(request);
      case 'template-preview':
        return await this.#templatePreview(request);
      case 'template-apply':
        return await this.#templateApply(request);
      case 'delete-archive':
        return await this.#deleteArchive(request);
      case 'reconcile':
        return await this.#reconcile();
      default:
        throw new Fault(CODES.invalidRequest, { field: 'action', action });
    }
  }

  /**
   * Idempotent replay: a repeated `operationId` with the same arguments returns
   * the recorded outcome instead of repeating side effects. The hash is taken
   * from the raw request, exactly as {@link Store.mutate} computed it, so the
   * two can never disagree about whether a retry is the same operation.
   * @param {string} action
   * @param {object} request
   * @returns {any|null}
   */
  #replayOf(action, request) {
    const operationId = request.operationId;
    if (operationId === undefined) return null;
    const record = this.store.operation(operationId);
    if (record === null) return null;
    const hash = requestHashOf({ action, request: canonicalArgs(request) });
    if (record.requestHash !== hash) {
      throw new Fault(CODES.operationIdReused, {
        operationId,
        recordedAction: record.action,
        requestedAction: action,
      });
    }
    return record.result;
  }

  /** @returns {Promise<object>} The complete panel/orchestration snapshot. */
  async #list() {
    const state = this.store.snapshot();
    const bundles = await readBundles(this.host).catch(() => new Map());
    const native = new Map(this.host.listWorkspaces().map((workspace) => [workspace.workspaceId, workspace]));
    const leases = leasesOf(state);
    const archives = await this.#archiveIndex(state);

    const workspaces = Object.values(state.workspaces).map((record) => {
      const registered = native.get(record.workspaceId) ?? null;
      const bindings = record.bindings.map((binding) => {
        const key = packageKey(binding.packageName, binding.version);
        const packageRecord = state.packages[key] ?? null;
        const evaluated = evaluatePackage(bundles, binding.packageName, binding.version);
        const holders = leases.get(key) ?? [];
        return {
          ...binding,
          key,
          package: {
            registered: packageRecord !== null,
            status: evaluated.status,
            installedVersion: evaluated.actualVersion,
            enabled: evaluated.enabled,
            error: evaluated.error,
            pinned: packageRecord?.pinned === true,
            ownership: packageRecord?.ownership ?? null,
            restoreCapability: packageRecord?.restoreCapability ?? null,
            archivePresent: packageRecord?.archiveSha256 ? archives.has(packageRecord.archiveSha256) : false,
            scaffold: packageRecord?.scaffold ?? null,
          },
          heldBy: holders,
          shared: holders.length > 1,
        };
      });
      const blockers = [];
      for (const binding of bindings) {
        if (!binding.enabled) continue;
        if (binding.package.status === 'absent') {
          blockers.push({ bindingId: binding.id, code: CODES.dependencyMissing, packageName: binding.packageName });
        } else if (binding.package.status === 'mismatch') {
          blockers.push({ bindingId: binding.id, code: CODES.versionConflict, packageName: binding.packageName });
        } else if (!binding.package.enabled) {
          blockers.push({ bindingId: binding.id, code: 'not-enabled', packageName: binding.packageName, required: binding.required });
        }
      }
      const requiredBlocked = blockers.some((blocker) => blocker.required !== false && blocker.code !== 'not-enabled');
      return {
        workspaceId: record.workspaceId,
        title: record.title || registered?.title || record.lastKnownPath,
        lastKnownPath: record.lastKnownPath,
        autoRestore: record.autoRestore,
        requestedState: record.requestedState,
        registered: registered !== null,
        nativePath: registered?.path ?? null,
        bindings,
        blockers,
        ready: record.requestedState === 'awake' && !requiredBlocked,
        pendingSleep: (this.sleepQueue?.peek(record.workspaceId) ?? null) !== null,
      };
    });

    const orphans = this.host
      .listWorkspaces()
      .filter((workspace) => state.workspaces[workspace.workspaceId] === undefined)
      .map((workspace) => ({ workspaceId: workspace.workspaceId, title: workspace.title, path: workspace.path }));

    return {
      revision: state.revision,
      profileName: this.host.profileName,
      profileDir: this.host.profileDir,
      automaticRestore: this.automaticRestore,
      recoveryNote: this.store.recoveryNote,
      runningAgents: this.activity.busy(),
      pendingSleeps: this.sleepQueue?.workspaces() ?? [],
      capabilities: {
        pluginManager: this.host.hasPluginManager(),
        workspaceRegistry: this.host.hasWorkspaceRegistry(),
      },
      workspaces,
      unmanagedWorkspaces: orphans,
      packages: Object.entries(state.packages)
        .map(([key, record]) => {
          const { name, version } = parsePackageKey(key);
          const evaluated = evaluatePackage(bundles, name, version);
          return {
            key,
            packageName: name,
            version,
            ...record,
            installedVersion: evaluated.actualVersion,
            enabled: evaluated.enabled,
            nativeStatus: evaluated.status,
            holders: leases.get(key) ?? [],
            archivePresent: record.archiveSha256 ? archives.has(record.archiveSha256) : false,
          };
        })
        .sort((left, right) => left.key.localeCompare(right.key)),
      archiveCount: archives.size,
    };
  }

  /**
   * @param {object} state
   * @returns {Promise<Map<string, number>>} Stored snapshot hashes and their byte size.
   */
  async #archiveIndex(state) {
    void state;
    const index = new Map();
    let names = [];
    try {
      names = await readdir(this.store.archiveDir);
    } catch {
      return index;
    }
    for (const name of names) {
      if (!name.endsWith('.tgz')) continue;
      const digest = name.slice(0, -4);
      if (!/^[0-9a-f]{64}$/.test(digest)) continue;
      const info = await stat(join(this.store.archiveDir, name)).catch(() => null);
      index.set(digest, info === null ? 0 : info.size);
    }
    return index;
  }

  /**
   * Descriptor view for one package, read from its installed directory.
   * @param {object} args `{packageName, version}`
   * @returns {Promise<object>}
   */
  async #scaffolds(args) {
    if (typeof args?.packageName !== 'string' || typeof args?.version !== 'string') {
      throw new Fault(CODES.invalidRequest, { field: 'packageName' });
    }
    const descriptor = await this.#descriptorOf(args.packageName, args.version);
    return { packageName: args.packageName, version: args.version, descriptor: publicDescriptor(descriptor) };
  }

  /**
   * @param {string} name
   * @param {string} version
   * @returns {Promise<object|null>}
   */
  async #descriptorOf(name, version) {
    const directory = this.host.packageDir(name);
    if (!(await pathExists(join(directory, 'package.json')))) {
      throw new Fault(CODES.dependencyMissing, {
        packageName: name,
        version,
        reason: 'package-not-installed',
      });
    }
    return await readScaffoldDescriptor(directory);
  }

  /** @param {object} request @returns {object} */
  #operationStatus(request) {
    const operationId = request.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'operationId' });
    }
    const record = this.store.operation(operationId);
    if (record === null) throw new Fault(CODES.packageUnknown, { operationId, reason: 'unknown-operation' });
    return {
      operationId,
      action: record.action,
      status: record.status,
      result: record.result,
      at: record.at,
      pendingSleep: (this.sleepQueue?.workspaces() ?? []).includes(operationId) ? null : undefined,
    };
  }

  /**
   * Import a package snapshot into the local warehouse and install it without
   * enabling it.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #import(request) {
    const args = { path: request.path, install: request.install !== false };
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'path' });
    }

    const imported = await importFromPath(this.store, args.path);
    const key = packageKey(imported.name, imported.version);
    const existing = this.store.snapshot().packages[key] ?? null;
    if (existing !== null && existing.archiveSha256 !== null && existing.archiveSha256 !== imported.archiveSha256) {
      throw new Fault(CODES.packageContentConflict, {
        packageKey: key,
        recordedSha256: existing.archiveSha256,
        importedSha256: imported.archiveSha256,
      });
    }

    // Read the descriptor from the snapshot's own bytes, before anything is
    // installed, so an invalid scaffold is refused without touching the profile.
    const descriptor = await this.#descriptorFromArchive(imported.archiveSha256);
    const bundles = await readBundles(this.host).catch(() => new Map());
    const before = evaluatePackage(bundles, imported.name, imported.version);
    let installOutcome = 'skipped';
    if (args.install !== false && before.status === 'absent') {
      const result = await this.host.installBundle(archivePath(this.store, imported.archiveSha256), {
        requestId: request.operationId,
      });
      installOutcome = typeof result?.application === 'string' ? result.application : 'installed';
    } else if (before.status === 'mismatch') {
      throw new Fault(CODES.versionConflict, {
        packageName: imported.name,
        requestedVersion: imported.version,
        installedVersion: before.actualVersion,
      });
    } else if (before.status === 'match') {
      installOutcome = 'already-installed';
    }

    const after = evaluatePackage(await readBundles(this.host).catch(() => before), imported.name, imported.version);
    const committed = await this.store.mutate(
      { action: 'import', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        draft.packages[key] = {
          archiveSha256: imported.archiveSha256,
          sourceKind: imported.sourceKind,
          restoreCapability: 'archived',
          initiallyEnabled: after.enabled,
          ownership: after.enabled ? 'external' : 'managed',
          pinned: after.enabled,
          title: imported.title,
          importedAt: nowIso(),
          archiveEntryCount: imported.entryCount,
          archiveBytes: imported.bytes,
          scaffold: summarizeDescriptor(descriptor),
        };
        return {
          packageKey: key,
          packageName: imported.name,
          version: imported.version,
          archiveSha256: imported.archiveSha256,
          entryCount: imported.entryCount,
          bytes: imported.bytes,
          installOutcome,
          nativeEnabled: after.enabled,
          scaffold: summarizeDescriptor(descriptor),
        };
      },
    );
    return committed.value;
  }

  /**
   * Extract an archive into a scratch directory and read its descriptor.
   * @param {string} archiveSha256
   * @returns {Promise<object|null>}
   */
  async #descriptorFromArchive(archiveSha256) {
    const { extractTarball } = await import('./tar.js');
    const buffer = await readFile(archivePath(this.store, archiveSha256));
    const staging = join(this.store.stagingDir, `inspect-${archiveSha256.slice(0, 16)}-${newId().slice(0, 8)}`);
    try {
      await extractTarball(buffer, staging, (entryPath, kind) => {
        void kind;
        return resolveInside(staging, entryPath);
      });
      if (!(await pathExists(join(staging, 'package.json')))) {
        throw new Fault(CODES.notABundle, { reason: 'archive-without-package-json' });
      }
      return await awaitDescriptor(staging);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Associate one package version with a workspace.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #bind(request) {
    const args = jsonSafe({
      workspaceId: request.workspaceId,
      packageName: request.packageName,
      version: request.version,
      archiveSha256: request.archiveSha256 ?? null,
      enabled: request.enabled !== false,
      required: request.required !== false,
      templateValues: request.templateValues ?? {},
    });
    if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'workspaceId' });
    }
    const binding = readBindRequest(args);
    const workspace = this.host.getWorkspace(args.workspaceId);
    const state = this.store.snapshot();
    const record = state.workspaces[args.workspaceId];
    if (workspace === null && record === undefined) {
      throw new Fault(CODES.workspaceNotFound, { workspaceId: args.workspaceId });
    }
    const key = packageKey(binding.packageName, binding.version);
    const bundles = await readBundles(this.host).catch(() => new Map());
    const evaluated = evaluatePackage(bundles, binding.packageName, binding.version);
    const existingPackage = state.packages[key] ?? null;
    const canRestore = (existingPackage?.archiveSha256 ?? binding.archiveSha256) !== null;
    if (evaluated.status !== 'match' && !canRestore) {
      if (evaluated.status === 'mismatch') {
        throw new Fault(CODES.versionConflict, {
          packageName: binding.packageName,
          requestedVersion: binding.version,
          installedVersion: evaluated.actualVersion,
        });
      }
      throw new Fault(CODES.dependencyMissing, { packageName: binding.packageName, version: binding.version });
    }

    const committed = await this.store.mutate(
      { action: 'bind', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[args.workspaceId] ?? {
          workspaceId: args.workspaceId,
          lastKnownPath: workspace?.path ?? '',
          title: workspace?.title ?? '',
          autoRestore: true,
          requestedState: 'sleeping',
          bindings: [],
        };
        target.lastKnownPath = workspace?.path ?? target.lastKnownPath;
        target.title = workspace?.title ?? target.title;
        target.updatedAt = nowIso();
        if (target.bindings.some((entry) => packageKey(entry.packageName, entry.version) === key)) {
          throw new Fault(CODES.invalidRequest, { field: 'packageName', reason: 'already-bound', packageKey: key });
        }
        const id = newId();
        target.bindings.push({
          id,
          packageName: binding.packageName,
          version: binding.version,
          archiveSha256: existingPackage?.archiveSha256 ?? binding.archiveSha256,
          enabled: binding.enabled,
          required: binding.required,
          templateId: null,
          templateValues: binding.templateValues,
          lastGeneratedAt: null,
          addedAt: nowIso(),
        });
        if (!Object.hasOwn(draft.packages, key)) {
          draft.packages[key] = {
            archiveSha256: binding.archiveSha256,
            sourceKind: 'installed',
            restoreCapability: canRestore ? 'archived' : 'installed-only',
            initiallyEnabled: evaluated.enabled,
            ownership: evaluated.enabled ? 'external' : 'managed',
            pinned: evaluated.enabled,
            title: null,
            importedAt: nowIso(),
            archiveEntryCount: null,
            archiveBytes: null,
            scaffold: null,
          };
        }
        draft.workspaces[args.workspaceId] = target;
        return { bindingId: id, workspaceId: args.workspaceId, packageKey: key };
      },
    );
    return committed.value;
  }

  /**
   * Remove an association. Generated files are never touched.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #unbind(request) {
    const args = { workspaceId: request.workspaceId, bindingId: request.bindingId };
    if (typeof args.workspaceId !== 'string' || typeof args.bindingId !== 'string') {
      throw new Fault(CODES.invalidRequest, { field: 'bindingId' });
    }
    const state = this.store.snapshot();
    if (state.workspaces[args.workspaceId] === undefined) {
      throw new Fault(CODES.workspaceNotFound, { workspaceId: args.workspaceId });
    }
    // The release plan is computed *before* the binding disappears: afterwards
    // the removed association is no longer visible in state, so the packages it
    // uniquely held would look like they belong to nobody.
    const plan = planSleep(state, args.workspaceId);
    const committed = await this.store.mutate(
      { action: 'unbind', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[args.workspaceId];
        const before = target.bindings.length;
        target.bindings = target.bindings.filter((binding) => binding.id !== args.bindingId);
        if (target.bindings.length === before) {
          throw new Fault(CODES.invalidRequest, { field: 'bindingId', reason: 'unknown-binding' });
        }
        target.updatedAt = nowIso();
        return { workspaceId: args.workspaceId, bindingId: args.bindingId, removed: true };
      },
    );
    // Removing an association must never take a bundle away from a workspace
    // that still needs it; `#releaseKeys` applies the same safety rules a sleep
    // uses, against the pre-removal plan.
    const released = await this.#releaseKeys(plan.release, 'unbind');
    return { ...committed.value, release: { ...released, kept: plan.keep } };
  }

  /**
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #updateBinding(request) {
    const args = jsonSafe({
      workspaceId: request.workspaceId,
      bindingId: request.bindingId,
      enabled: request.enabled,
      required: request.required,
      autoRestore: request.autoRestore,
      templateId: request.templateId,
      templateValues: request.templateValues,
    });
    if (typeof args.workspaceId !== 'string' || typeof args.bindingId !== 'string') {
      throw new Fault(CODES.invalidRequest, { field: 'bindingId' });
    }
    for (const field of ['enabled', 'required', 'autoRestore']) {
      if (args[field] !== undefined && typeof args[field] !== 'boolean') {
        throw new Fault(CODES.invalidRequest, { field });
      }
    }
    const committed = await this.store.mutate(
      { action: 'update-binding', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[args.workspaceId];
        if (target === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId: args.workspaceId });
        const binding = target.bindings.find((entry) => entry.id === args.bindingId);
        if (binding === undefined) throw new Fault(CODES.invalidRequest, { field: 'bindingId', reason: 'unknown-binding' });
        if (args.enabled !== undefined) binding.enabled = args.enabled;
        if (args.required !== undefined) binding.required = args.required;
        if (args.templateId !== undefined) binding.templateId = args.templateId;
        if (args.templateValues !== undefined) binding.templateValues = { ...args.templateValues };
        if (args.autoRestore !== undefined) target.autoRestore = args.autoRestore;
        target.updatedAt = nowIso();
        return { workspaceId: args.workspaceId, bindingId: args.bindingId };
      },
    );
    return committed.value;
  }

  /**
   * Change whether a package stays enabled outside any workspace's need.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #setPin(request) {
    const args = { packageKey: request.packageKey, pinned: request.pinned, ownership: request.ownership };
    if (typeof args.packageKey !== 'string') throw new Fault(CODES.invalidRequest, { field: 'packageKey' });
    if (typeof args.pinned !== 'boolean') throw new Fault(CODES.invalidRequest, { field: 'pinned' });
    if (args.ownership !== undefined && !['managed', 'external'].includes(args.ownership)) {
      throw new Fault(CODES.invalidRequest, { field: 'ownership' });
    }
    const committed = await this.store.mutate(
      { action: 'set-pin', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const record = draft.packages[args.packageKey];
        if (record === undefined) throw new Fault(CODES.packageUnknown, { packageKey: args.packageKey });
        record.pinned = args.pinned;
        if (args.ownership !== undefined) record.ownership = args.ownership;
        return { packageKey: args.packageKey, pinned: record.pinned, ownership: record.ownership };
      },
    );
    return committed.value;
  }

  /**
   * Prepare and enable everything one workspace needs.
   * @param {object} request `{workspaceId, install?, fast?}`
   * @returns {Promise<object>}
   */
  async #wake(request) {
    const args = { workspaceId: request.workspaceId, install: request.install !== false, fast: request.fast === true };
    if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'workspaceId' });
    }
    this.sleepQueue?.cancel(args.workspaceId);
    const outcome = await this.#enableForWorkspace(args.workspaceId, args);
    const committed = await this.store.mutate(
      { action: 'wake', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[args.workspaceId];
        if (target === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId: args.workspaceId });
        target.requestedState = 'awake';
        target.updatedAt = nowIso();
        return outcome;
      },
    );
    return committed.value;
  }

  /**
   * Enable the native bundles one workspace needs, installing first when the
   * snapshot is available. A required failure compensates the packages this call
   * newly enabled before rethrowing.
   * @param {string} workspaceId
   * @param {{install: boolean, fast: boolean}} options
   * @returns {Promise<object>}
   */
  async #enableForWorkspace(workspaceId, options) {
    const state = this.store.snapshot();
    if (state.workspaces[workspaceId] === undefined) {
      throw new Fault(CODES.workspaceNotFound, { workspaceId });
    }
    const { steps } = planWake(state, workspaceId);
    const applied = [];
    const failures = [];
    const newlyEnabled = [];
    try {
      for (const step of steps) {
        let bundles = await readBundles(this.host);
        let evaluated = evaluatePackage(bundles, step.packageName, step.version);
        const record = state.packages[step.key] ?? null;

        if (evaluated.status === 'mismatch') {
          const fault = new Fault(CODES.versionConflict, {
            packageName: step.packageName,
            requestedVersion: step.version,
            installedVersion: evaluated.actualVersion,
          });
          if (step.required) throw fault;
          failures.push({ key: step.key, code: fault.code, details: fault.details });
          continue;
        }
        if (evaluated.status === 'absent') {
          const sha = record?.archiveSha256 ?? null;
          if (sha === null) {
            const fault = new Fault(CODES.dependencyMissing, {
              packageName: step.packageName,
              version: step.version,
              reason: 'no-archive',
            });
            if (step.required) throw fault;
            failures.push({ key: step.key, code: fault.code, details: fault.details });
            continue;
          }
          if (options.fast || options.install === false) {
            const fault = new Fault(CODES.dependencyMissing, {
              packageName: step.packageName,
              version: step.version,
              reason: 'install-not-attempted',
            });
            if (step.required) throw fault;
            failures.push({ key: step.key, code: fault.code, details: fault.details });
            continue;
          }
          await this.host.installBundle(archivePath(this.store, sha), {});
          bundles = await readBundles(this.host);
          evaluated = evaluatePackage(bundles, step.packageName, step.version);
          if (evaluated.status !== 'match') {
            const fault = new Fault(CODES.nativeOperationFailed, {
              packageName: step.packageName,
              version: step.version,
              phase: 'install',
              observed: evaluated.status,
            });
            if (step.required) throw fault;
            failures.push({ key: step.key, code: fault.code, details: fault.details });
            continue;
          }
        }
        if (evaluated.enabled) {
          applied.push({ key: step.key, application: 'already-enabled' });
          continue;
        }
        const result = await this.host.setBundleEnabled(step.packageName, true);
        const application = typeof result?.application === 'string' ? result.application : 'applied';
        newlyEnabled.push(step.packageName);
        applied.push({ key: step.key, application, warnings: jsonSafe(result?.warnings ?? null) });
        if (application === 'failed' || application === 'cancelled') {
          const fault = new Fault(CODES.nativeOperationFailed, {
            packageName: step.packageName,
            application,
            error: jsonSafe(result?.error ?? null),
          });
          if (step.required) throw fault;
          failures.push({ key: step.key, code: fault.code, details: fault.details });
        }
      }
    } catch (error) {
      const compensation = await this.#compensate(newlyEnabled, workspaceId);
      if (error instanceof Fault) {
        throw new Fault(error.code, { ...error.details, compensation }, error.message);
      }
      throw error;
    }
    return {
      workspaceId,
      steps: steps.length,
      applied,
      failures,
      restartRequired: applied.some((entry) => entry.application === 'restart-required'),
      effectiveFrom: 'next-model-request',
    };
  }

  /**
   * Undo enablement this call introduced, but only for packages no other awake
   * workspace holds, that are managed and not pinned.
   * @param {string[]} names
   * @param {string} workspaceId
   * @returns {Promise<object>}
   */
  async #compensate(names, workspaceId) {
    const state = this.store.snapshot();
    const leases = leasesOf({ ...state, workspaces: { ...state.workspaces, [workspaceId]: { ...state.workspaces[workspaceId], requestedState: 'sleeping' } } });
    const disabled = [];
    const kept = [];
    for (const name of [...new Set(names)]) {
      const key = Object.keys(state.packages).find((candidate) => parsePackageKey(candidate).name === name) ?? null;
      const record = key === null ? null : state.packages[key];
      const held = key === null ? [] : (leases.get(key) ?? []);
      if (held.length > 0) {
        kept.push({ name, reason: 'other-workspace', holders: held });
        continue;
      }
      if (record !== null && (record.pinned || record.ownership === 'external')) {
        kept.push({ name, reason: record.pinned ? 'pinned' : 'external' });
        continue;
      }
      try {
        await this.host.setBundleEnabled(name, false);
        disabled.push(name);
      } catch (error) {
        kept.push({ name, reason: 'compensation-failed', detail: error instanceof Error ? error.message : String(error) });
      }
    }
    return { disabled, kept };
  }

  /**
   * Record the intent to sleep, release what this workspace uniquely held, and
   * defer when work is in flight.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #sleep(request) {
    const args = { workspaceId: request.workspaceId };
    if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'workspaceId' });
    }
    const state = this.store.snapshot();
    if (state.workspaces[args.workspaceId] === undefined) {
      return { workspaceId: args.workspaceId, status: 'no-op', reason: 'unassociated' };
    }
    const busy = this.activity.busy();
    const committed = await this.store.mutate(
      { action: 'sleep', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[args.workspaceId];
        target.requestedState = 'sleeping';
        target.updatedAt = nowIso();
        return { workspaceId: args.workspaceId, status: busy ? 'pending-idle' : 'sleeping' };
      },
    );
    if (busy) {
      const queued = this.sleepQueue.enqueue(args.workspaceId);
      return { ...committed.value, queued, release: null };
    }
    const release = await this.#releaseForWorkspace(args.workspaceId, 'immediate');
    return { ...committed.value, release };
  }

  /**
   * Apply a queued sleep.
   * @param {string} workspaceId
   * @param {string} trigger
   * @returns {Promise<object>}
   */
  async #applyDeferredSleep(workspaceId, trigger) {
    return await this.#releaseForWorkspace(workspaceId, trigger);
  }

  /**
   * Disable every package the given workspace uniquely held.
   * @param {string} workspaceId
   * @param {string} trigger
   * @returns {Promise<object>}
   */
  async #releaseForWorkspace(workspaceId, trigger) {
    const state = this.store.snapshot();
    if (state.workspaces[workspaceId] === undefined) {
      return { trigger, released: [], kept: [], failed: [] };
    }
    const plan = planSleep(state, workspaceId);
    const released = await this.#releaseKeys(plan.release, trigger);
    if (trigger !== 'immediate') {
      // Deferred work is not part of the caller's operation, so it gets its own
      // log entry rather than silently mutating state outside the log.
      await this.store
        .mutate({ action: 'reconcile', operationId: newId(), expectedRevision: this.store.revision }, () => {
          return { trigger, workspaceId, released: released.released, kept: plan.keep, failed: released.failed };
        })
        .catch(() => {});
    }
    return { trigger, released: released.released, kept: plan.keep, failed: released.failed };
  }

  /**
   * Turn off the native bundles for release candidates. A package that is not
   * currently enabled is reported as already off rather than treated as a
   * failure; a package the native manager refuses to disable is reported, never
   * silently dropped.
   * @param {string[]} keys
   * @param {string} trigger
   * @returns {Promise<{released: object[], failed: object[]}>}
   */
  async #releaseKeys(keys, trigger) {
    const bundles = await readBundles(this.host).catch(() => new Map());
    const released = [];
    const failed = [];
    for (const key of keys) {
      const { name } = parsePackageKey(key);
      const row = bundles.get(name);
      if (row === undefined || row.enabled !== true) {
        released.push({ key, outcome: 'already-off' });
        continue;
      }
      try {
        const result = await this.host.setBundleEnabled(name, false);
        const application = typeof result?.application === 'string' ? result.application : 'applied';
        released.push({ key, outcome: application });
        if (application === 'failed' || application === 'cancelled') {
          failed.push({ key, message: `native manager reported ${application}` });
        }
      } catch (error) {
        failed.push({ key, message: error instanceof Error ? error.message : String(error) });
      }
    }
    void trigger;
    return { released, failed };
  }

  /**
   * Build a preview and store it under its own identifier.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #templatePreview(request) {
    const args = {
      workspaceId: request.workspaceId,
      bindingId: request.bindingId,
      templateId: request.templateId ?? null,
      values: request.values ?? {},
    };
    if (typeof args.workspaceId !== 'string' || typeof args.bindingId !== 'string') {
      throw new Fault(CODES.invalidRequest, { field: 'bindingId' });
    }
    const state = this.store.snapshot();
    const workspace = state.workspaces[args.workspaceId];
    if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId: args.workspaceId });
    const binding = workspace.bindings.find((entry) => entry.id === args.bindingId);
    if (binding === undefined) throw new Fault(CODES.invalidRequest, { field: 'bindingId', reason: 'unknown-binding' });
    const root = await this.#workspaceRoot(args.workspaceId, workspace);
    const descriptor = await this.#descriptorOf(binding.packageName, binding.version);
    const template = selectTemplate(descriptor, args.templateId);
    const values = resolveVariables(descriptor, { ...binding.templateValues, ...args.values });
    const preview = await buildPreview({
      workspaceRoot: root,
      descriptor,
      template,
      values,
      packageKey: packageKey(binding.packageName, binding.version),
      workspaceId: args.workspaceId,
      bindingId: args.bindingId,
    });
    const stored = await this.store.putPreview({
      ...preview,
      files: preview.files.map((file) => ({ ...file, text: null })),
    });
    return { ...stored, files: preview.files, blocking: preview.blocking };
  }

  /**
   * Apply a stored preview.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #templateApply(request) {
    const args = { previewId: request.previewId };
    if (typeof args.previewId !== 'string' || args.previewId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'previewId' });
    }
    const preview = this.store.takePreview(args.previewId);
    if (preview.blocking.length > 0) {
      throw new Fault(CODES.templateConflict, { blocking: preview.blocking });
    }
    const state = this.store.snapshot();
    const workspace = state.workspaces[preview.workspaceId];
    if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId: preview.workspaceId });
    const binding = workspace.bindings.find((entry) => entry.id === preview.bindingId);
    if (binding === undefined) throw new Fault(CODES.invalidRequest, { field: 'bindingId', reason: 'unknown-binding' });
    const descriptor = await this.#descriptorOf(binding.packageName, binding.version);
    const template = selectTemplate(descriptor, preview.templateId);
    const root = await this.#workspaceRoot(preview.workspaceId, workspace);
    if (root !== preview.workspaceRoot) {
      throw new Fault(CODES.previewStale, { reason: 'workspace-path-changed', was: preview.workspaceRoot, now: root });
    }
    const outcome = await applyPreview({ preview: { ...preview, files: preview.files }, descriptor, template });
    const committed = await this.store.mutate(
      { action: 'template-apply', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      (draft) => {
        const target = draft.workspaces[preview.workspaceId];
        const entry = target.bindings.find((candidate) => candidate.id === preview.bindingId);
        if (entry !== undefined) {
          entry.templateId = preview.templateId;
          entry.templateValues = { ...preview.values };
          entry.lastGeneratedAt = nowIso();
        }
        target.updatedAt = nowIso();
        return { workspaceId: preview.workspaceId, templateId: preview.templateId, ...outcome };
      },
    );
    await this.store.dropPreview(args.previewId);
    return committed.value;
  }

  /**
   * Delete one stored snapshot. Refuses while any binding still names it.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #deleteArchive(request) {
    const args = { archiveSha256: request.archiveSha256 };
    if (typeof args.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(args.archiveSha256)) {
      throw new Fault(CODES.invalidRequest, { field: 'archiveSha256' });
    }
    const state = this.store.snapshot();
    const holders = Object.entries(state.packages)
      .filter(([, record]) => record.archiveSha256 === args.archiveSha256)
      .map(([key]) => key);
    if (holders.length > 0) throw new Fault(CODES.archiveInUse, { archiveSha256: args.archiveSha256, holders });
    const target = archivePath(this.store, args.archiveSha256);
    // Only ever remove a file inside this plugin's own archive directory, and
    // only after re-deriving the path from a validated hash.
    if (!resolveInside(this.store.archiveDir, `${args.archiveSha256}.tgz`).endsWith(`${args.archiveSha256}.tgz`)) {
      throw new Fault(CODES.invalidRequest, { field: 'archiveSha256' });
    }
    let bytes = null;
    try {
      const buffer = await readFile(target);
      if (sha256Hex(buffer) !== args.archiveSha256) {
        throw new Fault(CODES.archiveInvalid, { reason: 'archive-hash-mismatch', archiveSha256: args.archiveSha256 });
      }
      bytes = buffer.length;
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(CODES.archiveInvalid, { reason: 'archive-absent', archiveSha256: args.archiveSha256 });
    }
    await rm(target, { force: true });
    const committed = await this.store.mutate(
      { action: 'delete-archive', operationId: request.operationId, expectedRevision: request.expectedRevision, args: canonicalArgs(request) },
      () => ({ archiveSha256: args.archiveSha256, bytes, deleted: true }),
    );
    return committed.value;
  }

  /**
   * Re-read native state after a restart or an out-of-band change.
   * @returns {Promise<object>}
   */
  async #reconcile() {
    const state = this.store.snapshot();
    const bundles = await readBundles(this.host).catch(() => new Map());
    const drift = [];
    for (const [key, record] of Object.entries(state.packages)) {
      const { name, version } = parsePackageKey(key);
      const evaluated = evaluatePackage(bundles, name, version);
      if (evaluated.enabled && record.ownership === 'managed' && !record.pinned) {
        // Something enabled a package we thought was ours to manage. Treat that
        // as a global intent and stop treating it as a release candidate.
        drift.push({ key, change: 'enabled-outside-management', action: 'pinned' });
      }
      if (evaluated.status === 'absent' && record.restoreCapability === 'archived') {
        drift.push({ key, change: 'uninstalled-but-archived' });
      }
    }
    if (drift.some((entry) => entry.action === 'pinned')) {
      await this.store.mutate(
        { action: 'reconcile', operationId: newId(), expectedRevision: this.store.revision },
        (draft) => {
          for (const entry of drift) {
            if (entry.action === 'pinned' && draft.packages[entry.key] !== undefined) {
              draft.packages[entry.key].pinned = true;
            }
          }
          return { drift };
        },
      );
    }
    return { drift, pendingSleeps: this.sleepQueue?.workspaces() ?? [], runningAgents: this.activity.busy() };
  }

  /**
   * Resolve a workspace's directory, preferring the live registration.
   * @param {string} workspaceId
   * @param {object} record
   * @returns {Promise<string>}
   */
  async #workspaceRoot(workspaceId, record) {
    const registered = this.host.getWorkspace(workspaceId);
    const candidate = registered?.path ?? record.lastKnownPath;
    if (typeof candidate !== 'string' || candidate.length === 0) {
      throw new Fault(CODES.workspaceUnavailable, { workspaceId, reason: 'no-path' });
    }
    const info = await stat(candidate).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Fault(CODES.workspaceUnavailable, { workspaceId, path: candidate });
    }
    return await this.host.canonicalize(candidate);
  }
}

/**
 * @param {string} directory
 * @returns {Promise<object|null>}
 */
async function awaitDescriptor(directory) {
  return await readScaffoldDescriptor(directory);
}

/**
 * Strip absolute paths from a descriptor before it crosses to the client.
 * @param {object|null} descriptor
 * @returns {object|null}
 */
function publicDescriptor(descriptor) {
  if (descriptor === null) return null;
  return {
    packageName: descriptor.packageName,
    version: descriptor.version,
    title: descriptor.title,
    requires: descriptor.requires,
    variables: descriptor.variables,
    templates: descriptor.templates.map((template) => ({
      id: template.id,
      title: template.title,
      files: template.files.map((file) => ({ target: file.target, render: file.render })),
    })),
  };
}
