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
import { leasesOf, planSleep, planUnbind, planWake } from './coordinator.js';
import { evaluatePackage, readBundles } from './inventory.js';
import { SleepQueue } from './lifecycle.js';
import { readScaffoldDescriptor, summarizeDescriptor } from './scaffold.js';
import { readBindRequest } from './schema.js';
import { applyPreview, buildPreview, resolveVariables, selectTemplate } from './templates.js';
import { jsonSafe } from './store.js';
import { Progress } from './progress.js';
import { ownIdentity, restartPending } from './version.js';
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
export const READ_ACTIONS = new Set(['list', 'operation-status', 'scaffolds', 'progress']);
/** Actions that mutate configuration and therefore require a revision guard. */
export const WRITE_ACTIONS = new Set([
  'workspace-register',
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
 * Actions slow enough that a caller needs something to watch. These are the
 * ones that run a package manager or perform several native enablements.
 */
export const TRACKED_ACTIONS = new Set(['import', 'wake', 'sleep', 'template-apply']);

/** The steps each tracked action is expected to run, in order. */
const PLAN = {
  import: ['validate package', 'hash and archive', 'read scaffold descriptor', 'install without enabling', 'record in warehouse'],
  wake: ['plan packages', 'enable packages', 'commit intent'],
  sleep: ['plan release', 'release packages'],
  'template-apply': ['re-render and verify', 'create files'],
};

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
  /** Depth of in-flight native writes whose change events must be held back. */
  #nativeDepth = 0;

  /** Whether a change event arrived during a native write and still needs a pass. */
  #reconcileWanted = false;

  /** Tail of the chain that serializes whole mutating operations. */
  #writeChain = Promise.resolve();

  /**
   * Run a whole mutating operation exclusively, from its revision check through
   * its native side effects to its commit.
   *
   * The store's own lock only makes a single state write atomic. That is not
   * enough for these operations, which read a revision, perform native
   * enable/disable calls, and only then commit: two of them can interleave so
   * that the last state written contradicts the native reality. Two concrete
   * failures that follow:
   *
   * - a shelf commits `sleeping`, a wake then sees the package still enabled and
   *   skips enabling it, and the shelf's delayed disable lands afterwards,
   *   leaving `requestedState=awake` with the package off;
   * - a wake enables natively, a concurrent write commits first, and the wake's
   *   own commit fails with `revision-conflict` - the caller is told nothing
   *   happened while the native side has already changed.
   *
   * Holding this for the duration removes both, because the revision can no
   * longer move between the check and the commit.
   *
   * MUST NOT be entered recursively: a nested call would wait for a chain that
   * only the current holder can advance and would hang. Every entry point below
   * takes it exactly once, at the outermost level.
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  async #critical(job) {
    const previous = this.#writeChain;
    let done;
    this.#writeChain = new Promise((resolve) => {
      done = resolve;
    });
    await previous;
    try {
      return await job();
    } finally {
      done();
    }
  }

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
    /** Live and recent operation progress, exposed over HTTP while work runs. */
    this.progress = new Progress();
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
   * The dependency spec the profile manifest declares for this plugin.
   *
   * Diagnostic only: this is what the profile *asks* for, which is not
   * necessarily what is running. Any failure yields `null` rather than a guess,
   * because a guessed spec would silently defeat the comparison it exists for.
   * @param {string|null} packageName
   * @returns {Promise<string|null>}
   */
  async #profileSpec(packageName) {
    if (typeof packageName !== 'string' || packageName.length === 0) return null;
    if (typeof this.host.profileDir !== 'string' || this.host.profileDir.length === 0) return null;
    try {
      const manifest = JSON.parse(await readFile(join(this.host.profileDir, 'package.json'), 'utf8'));
      const spec = manifest?.dependencies?.[packageName];
      return typeof spec === 'string' ? spec : null;
    } catch {
      return null;
    }
  }

  /**
   * Run a native enable/disable/install while this plugin's own change events
   * are held back, and record the enablement this plugin just applied.
   *
   * The plugin manager emits `plugin-manager/changed` for every write,
   * including ours. Without this guard the reconciliation triggered by our own
   * wake would observe a bundle that no workspace claims yet (the awake intent
   * is committed afterwards) and conclude it was enabled externally, pinning
   * it - which permanently defeats shelving for exactly the bundles this plugin
   * turned on.
   *
   * The recorded flag is what lets a *later* reconciliation - including one
   * after a restart, where no in-memory state survives - still tell this
   * plugin's own unreleased leftover from intent that came from outside.
   * @template T
   * @param {{key: string, enabled: boolean}|null} applied What this write sets, or null when it sets nothing.
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  async #nativeWrite(applied, operation) {
    this.#nativeDepth += 1;
    try {
      const result = await operation();
      if (applied !== null) await this.store.recordApplied(applied.key, applied.enabled);
      return result;
    } finally {
      this.#nativeDepth -= 1;
    }
  }

  /**
   * Run a reconciliation that arrived during a native write, once the operation
   * that caused it has finished committing its own state.
   *
   * Draining this at the end of the *operation* rather than at the end of the
   * native write is what makes the lease-aware check effective: by then `wake`
   * has committed the awake intent, so a lease explains the bundle this plugin
   * just enabled.
   * @returns {Promise<void>}
   */
  async #drainReconcile() {
    if (this.#nativeDepth > 0 || !this.#reconcileWanted) return;
    this.#reconcileWanted = false;
    await this.#reconcile().catch(() => {});
  }

  /**
   * Entry point for the plugin-manager change listener.
   *
   * A change this plugin caused is deferred until the operation that caused it
   * has finished, so reconciliation always judges a settled state rather than a
   * half-applied one.
   * @returns {Promise<object|null>} The reconciliation, or null when deferred.
   */
  async reconcileFromEvent() {
    if (this.#nativeDepth > 0) {
      this.#reconcileWanted = true;
      return null;
    }
    // Reconciliation writes state, so it belongs to the same exclusive section
    // as the operations it may be observing rather than racing them.
    return await this.#critical(async () => await this.#reconcile());
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
      // The whole mutating operation runs exclusively, so the revision it was
      // checked against is still the revision it commits against. Both guards
      // are applied once, in this order, inside the critical section:
      //
      // 1. A recorded operationId with identical arguments is a retry and must
      //    return its original outcome even though the revision has moved on.
      // 2. Otherwise a stale revision is refused *before* the action runs. An
      //    action that would have been a harmless no-op (sleep on a workspace
      //    with no association) still reports the conflict, so a caller can
      //    never mistake "your snapshot was stale" for "everything was fine".
      //
      // Checking before taking the lock is not enough: a caller whose revision
      // was current on arrival can find it stale once it owns the section, and
      // refusing here means refusing before any native side effect.
      const run = async () => {
        const replayed = this.#replayOf(action, request);
        if (replayed !== null) return replayed;
        if (request.expectedRevision !== this.store.revision) {
          throw new Fault(CODES.revisionConflict, {
            expectedRevision: request.expectedRevision,
            currentRevision: this.store.revision,
          });
        }
        try {
          return await this.#dispatch(action, request);
        } finally {
          // Drained inside the section: reconciliation mutates state, and doing
          // that after releasing the lock would reintroduce the conflict this
          // section exists to prevent.
          await this.#drainReconcile();
        }
      };

      if (request.background === true && TRACKED_ACTIONS.has(action)) {
        // Long work over HTTP: answer immediately with the id to poll, rather
        // than holding the connection open through a package-manager run.
        //
        // The entry is registered here rather than inside `#dispatch`, because
        // the work now queues behind the critical section and may not have
        // started when this returns. Because the acknowledgement can therefore
        // be sent before the revision is re-checked or any step runs, a failure
        // is reported through the progress entry instead of the response - the
        // caller polls `/progress` or `operation-status` and sees it.
        this.progress.begin(request.operationId, action, PLAN[action] ?? []);
        void this.#critical(run).catch((error) => {
          const entry = this.progress.get(request.operationId);
          if (entry !== null && entry.status === 'running') {
            this.progress.finish(request.operationId, {
              ok: false,
              code: error instanceof Fault ? error.code : CODES.nativeOperationFailed,
              details:
                error instanceof Fault
                  ? error.details
                  : { message: error instanceof Error ? error.message : String(error) },
            });
          }
        });
        return {
          operationId: request.operationId,
          action,
          status: 'running',
          background: true,
          progress: await this.#progressFor(request.operationId),
        };
      }
      return await this.#critical(run);
    }
    try {
      return await this.#dispatch(action, request);
    } finally {
      await this.#drainReconcile();
    }
  }

  /**
   * @param {string} operationId
   * @returns {Promise<object|null>}
   */
  async #progressFor(operationId) {
    return this.progress.get(operationId);
  }

  /**
   * Route one validated action to its handler, tracking progress for the
   * actions that take real time.
   * @param {string} action
   * @param {object} request
   * @returns {Promise<any>}
   */
  async #dispatch(action, request) {
    if (!TRACKED_ACTIONS.has(action)) return await this.#route(action, request, null);

    const operationId = request.operationId;
    // A background request already registered its entry so the acknowledgement
    // could carry it; re-registering here would reset the steps it has begun.
    if (this.progress.get(operationId)?.status !== 'running') {
      this.progress.begin(operationId, action, PLAN[action]);
    }
    const report = {
      activate: (label) => this.progress.activate(operationId, label),
      complete: (label, outcome) => this.progress.complete(operationId, label, outcome),
      addStep: (label) => this.progress.addStep(operationId, label),
      phase: (text) => this.progress.phase(operationId, text),
    };
    try {
      const value = await this.#route(action, request, report);
      this.progress.finish(operationId, { ok: true, result: summarizeProgressResult(value) });
      return value;
    } catch (error) {
      this.progress.finish(operationId, {
        ok: false,
        code: error instanceof Fault ? error.code : CODES.nativeOperationFailed,
        details: error instanceof Fault ? error.details : { message: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /**
   * @param {string} action
   * @param {object} request
   * @param {{activate: Function, complete: Function, addStep: Function, phase: Function}|null} report
   * @returns {Promise<any>}
   */
  async #route(action, request, report) {
    switch (action) {
      case 'list':
        return await this.#list();
      case 'scaffolds':
        return await this.#scaffolds(request);
      case 'operation-status':
        return this.#operationStatus(request);
      case 'progress':
        return this.#progress(request);
      case 'import':
        return await this.#import(request, report);
      case 'workspace-register':
        return await this.#workspaceRegister(request);
      case 'bind':
        return await this.#bind(request);
      case 'unbind':
        return await this.#unbind(request);
      case 'update-binding':
        return await this.#updateBinding(request);
      case 'set-pin':
        return await this.#setPin(request);
      case 'wake':
        return await this.#wake(request, report);
      case 'sleep':
        return await this.#sleep(request, report);
      case 'template-preview':
        return await this.#templatePreview(request);
      case 'template-apply':
        return await this.#templateApply(request, report);
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

    const identity = ownIdentity();
    const profileSpec = await this.#profileSpec(identity.name);

    return {
      revision: state.revision,
      // The running build's own identity, so a caller can tell which code is
      // answering without probing behaviour. `profileSpec` is what the profile
      // asks for; when the two disagree the process is holding older code.
      pluginName: identity.name,
      pluginVersion: identity.version,
      profileSpec,
      restartPending: restartPending(identity.version, profileSpec),
      profileName: this.host.profileName,
      profileDir: this.host.profileDir,
      automaticRestore: this.automaticRestore,
      recoveryNote: this.store.recoveryNote,
      runningAgents: this.activity.busy(),
      pendingSleeps: this.sleepQueue?.workspaces() ?? [],
      // Included so a single poll answers "what is it doing right now" as well
      // as "what is the state"; a progress view needs no second request.
      progress: this.progress.snapshot(),
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
  #progress(request) {
    if (typeof request.operationId === 'string' && request.operationId.length > 0) {
      const entry = this.progress.get(request.operationId);
      if (entry === null) throw new Fault(CODES.packageUnknown, { operationId: request.operationId, reason: 'unknown-operation' });
      return { operation: entry };
    }
    return this.progress.snapshot();
  }

  /** @param {object} request @returns {object} */
  #operationStatus(request) {
    const operationId = request.operationId;
    if (typeof operationId !== 'string' || operationId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'operationId' });
    }
    // A running operation has no durable log entry yet, so consult the live
    // progress first; otherwise polling a long import would report "unknown"
    // for exactly as long as the caller needs to watch it.
    const live = this.progress.get(operationId);
    if (live !== null) {
      return {
        operationId,
        action: live.action,
        status: live.status === 'running' ? 'running' : live.status === 'succeeded' ? 'committed' : 'failed',
        result: live.result,
        error: live.error,
        at: live.updatedAt,
        progress: live,
      };
    }
    const record = this.store.operation(operationId);
    if (record === null) throw new Fault(CODES.packageUnknown, { operationId, reason: 'unknown-operation' });
    return {
      operationId,
      action: record.action,
      status: record.status,
      result: record.result,
      at: record.at,
      progress: null,
    };
  }

  /**
   * Register an existing directory as a workspace and bring it under management.
   *
   * Without this the plugin could only manage workspaces that something else had
   * already registered, so bringing a project in meant dropping to the native
   * RPC surface first. It registers natively and creates the management record
   * with nothing bound and nothing enabled, which is exactly the state a project
   * is in before its first scaffold.
   *
   * Registering a path that is already registered is not an error: the native
   * registry de-duplicates by path, so the existing workspace is adopted and
   * `created` reports which case happened.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #workspaceRegister(request) {
    const args = jsonSafe({ path: request.path, title: request.title ?? null });
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'path' });
    }
    if (args.title !== null && (typeof args.title !== 'string' || args.title.length === 0)) {
      throw new Fault(CODES.invalidRequest, { field: 'title' });
    }

    const info = await stat(args.path).catch(() => null);
    if (info === null || !info.isDirectory()) {
      throw new Fault(CODES.workspaceUnavailable, { path: args.path, reason: 'not-a-directory' });
    }
    const canonical = await this.host.canonicalize(args.path);
    const before = this.host.listWorkspaces().find((workspace) => samePath(workspace.path, canonical)) ?? null;
    const entity = await this.host.createWorkspace(canonical, args.title ?? undefined);

    const committed = await this.store.mutate(
      {
        action: 'workspace-register',
        operationId: request.operationId,
        expectedRevision: request.expectedRevision,
        args: canonicalArgs(request),
      },
      (draft) => {
        const existing = draft.workspaces[entity.workspaceId] ?? null;
        const target = existing ?? {
          workspaceId: entity.workspaceId,
          lastKnownPath: entity.path,
          title: entity.title,
          autoRestore: true,
          requestedState: 'sleeping',
          bindings: [],
        };
        // Adopt whatever the native registry says now; it is the source of truth
        // for the path, and a re-register must not discard existing bindings.
        target.lastKnownPath = entity.path;
        target.title = entity.title || target.title;
        target.updatedAt = nowIso();
        draft.workspaces[entity.workspaceId] = target;
        return {
          workspaceId: entity.workspaceId,
          path: entity.path,
          title: entity.title,
          created: before === null,
          hadRecord: existing !== null,
        };
      },
    );
    return committed.value;
  }

  /**
   * Import a package snapshot into the local warehouse and install it without
   * enabling it.
   * @param {object} request
   * @returns {Promise<object>}
   */
  async #import(request, report) {
    const args = { path: request.path, install: request.install !== false };
    if (typeof args.path !== 'string' || args.path.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'path' });
    }

    report?.activate('validate package');
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
    report?.complete('validate package', { detail: `${imported.name}@${imported.version}` });
    report?.complete('hash and archive', { detail: imported.archiveSha256.slice(0, 12) });

    // Read the descriptor from the snapshot's own bytes, before anything is
    // installed, so an invalid scaffold is refused without touching the profile.
    report?.activate('read scaffold descriptor');
    const descriptor = await this.#descriptorFromArchive(imported.archiveSha256);
    report?.complete('read scaffold descriptor', {
      detail: descriptor === null ? 'no templates' : `${descriptor.templates.length} template(s)`,
    });

    const bundles = await readBundles(this.host).catch(() => new Map());
    const before = evaluatePackage(bundles, imported.name, imported.version);
    let installOutcome = 'skipped';
    if (args.install !== false && before.status === 'absent') {
      report?.activate('install without enabling');
      const result = await this.#nativeWrite(null, () =>
        this.host.installBundle(archivePath(this.store, imported.archiveSha256), {
          requestId: request.operationId,
        }),
      );
      installOutcome = typeof result?.application === 'string' ? result.application : 'installed';
      report?.complete('install without enabling', { detail: installOutcome });
    } else if (before.status === 'mismatch') {
      throw new Fault(CODES.versionConflict, {
        packageName: imported.name,
        requestedVersion: imported.version,
        installedVersion: before.actualVersion,
      });
    } else if (before.status === 'match') {
      installOutcome = 'already-installed';
      report?.complete('install without enabling', { status: 'skipped', detail: 'already installed' });
    }
    report?.activate('record in warehouse');

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
          lastAppliedEnabled: after.enabled,
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
    report?.complete('record in warehouse', { detail: key });
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
            lastAppliedEnabled: evaluated.enabled,
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
    // Only the package behind the removed association is ever a candidate, and
    // never the workspace's whole shelf plan: `planUnbind` simulates this one
    // removal against the pre-removal state, so the workspace's remaining
    // associations and every other workspace are still visible when deciding
    // whether anything is still claimed. Using `planSleep` here would release
    // every package the workspace uniquely held - removing one scaffold would
    // take away the others too.
    //
    // The release is deliberately immediate, without the shelf's busy guard.
    // Unbinding is an explicit reconfiguration: the user just said this project
    // no longer needs the scaffold, and a tool list is fixed per model request,
    // so the in-flight turn is not interrupted. A shelf is different - it is a
    // background intent about a project that is actively in use, which is why
    // that path queues instead.
    const plan = planUnbind(state, args.workspaceId, args.bindingId);
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
    // `#releaseKeys` applies the same safety rules a shelf uses, against the
    // plan for the single removed association.
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
  async #wake(request, report) {
    const args = { workspaceId: request.workspaceId, install: request.install !== false, fast: request.fast === true };
    if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'workspaceId' });
    }
    this.sleepQueue?.cancel(args.workspaceId);
    report?.activate('plan packages');
    const outcome = await this.#enableForWorkspace(args.workspaceId, args, report);
    report?.activate('commit intent');
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
    report?.complete('commit intent', { detail: `revision ${committed.revision}` });
    return committed.value;
  }

  /**
   * Enable the native bundles one workspace needs, installing first when the
   * snapshot is available. A required failure compensates the packages this call
   * newly enabled before rethrowing.
   * @param {string} workspaceId
   * @param {{install: boolean, fast: boolean}} options
   * @param {{addStep: Function, activate: Function, complete: Function}|null} [report]
   * @returns {Promise<object>}
   */
  async #enableForWorkspace(workspaceId, options, report = null) {
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
        report?.addStep(`enable ${step.packageName}`);
        if (evaluated.enabled) {
          report?.complete(`enable ${step.packageName}`, { status: 'skipped', detail: 'already enabled' });
        }

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
          await this.#nativeWrite(null, () => this.host.installBundle(archivePath(this.store, sha), {}));
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
          report?.complete(`enable ${step.packageName}`, { status: 'skipped', detail: 'already enabled' });
          continue;
        }
        const result = await this.#nativeWrite({ key: step.key, enabled: true }, () => this.host.setBundleEnabled(step.packageName, true));
        const application = typeof result?.application === 'string' ? result.application : 'applied';
        newlyEnabled.push(step.packageName);
        applied.push({ key: step.key, application, warnings: jsonSafe(result?.warnings ?? null) });
        report?.complete(`enable ${step.packageName}`, {
          status: application === 'failed' || application === 'cancelled' ? 'failed' : 'done',
          detail: application,
        });
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
        await this.#nativeWrite({ key, enabled: false }, () => this.host.setBundleEnabled(name, false));
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
  async #sleep(request, report) {
    const args = { workspaceId: request.workspaceId };
    if (typeof args.workspaceId !== 'string' || args.workspaceId.length === 0) {
      throw new Fault(CODES.invalidRequest, { field: 'workspaceId' });
    }
    const state = this.store.snapshot();
    if (state.workspaces[args.workspaceId] === undefined) {
      return { workspaceId: args.workspaceId, status: 'no-op', reason: 'unassociated' };
    }
    const busy = this.activity.busy();
    report?.activate('plan release');
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
      report?.complete('plan release', { status: 'skipped', detail: 'deferred until idle' });
      return { ...committed.value, queued, release: null };
    }
    report?.complete('plan release', { detail: 'immediate' });
    const release = await this.#releaseForWorkspace(args.workspaceId, 'immediate', report);
    return { ...committed.value, release };
  }

  /**
   * Apply a queued sleep.
   * @param {string} workspaceId
   * @param {string} trigger
   * @returns {Promise<object>}
   */
  async #applyDeferredSleep(workspaceId, trigger) {
    // Deferred work runs outside `execute()`, so it takes the critical section
    // itself: it performs the same native releases and state commits as a
    // caller-driven shelf, and must not interleave with one.
    return await this.#critical(async () => {
      try {
        return await this.#releaseForWorkspace(workspaceId, trigger);
      } finally {
        await this.#drainReconcile();
      }
    });
  }

  /**
   * Disable every package the given workspace uniquely held.
   * @param {string} workspaceId
   * @param {string} trigger
   * @returns {Promise<object>}
   */
  async #releaseForWorkspace(workspaceId, trigger, report = null) {
    const state = this.store.snapshot();
    if (state.workspaces[workspaceId] === undefined) {
      return { trigger, released: [], kept: [], failed: [] };
    }
    const plan = planSleep(state, workspaceId);
    report?.activate('release packages');
    for (const key of plan.release) report?.addStep(`disable ${parsePackageKey(key).name}`);
    const released = await this.#releaseKeys(plan.release, trigger, report);
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
  async #releaseKeys(keys, trigger, report = null) {
    const bundles = await readBundles(this.host).catch(() => new Map());
    const released = [];
    const failed = [];
    for (const key of keys) {
      const { name } = parsePackageKey(key);
      const row = bundles.get(name);
      if (row === undefined || row.enabled !== true) {
        released.push({ key, outcome: 'already-off' });
        report?.complete(`disable ${name}`, { status: 'skipped', detail: 'already off' });
        continue;
      }
      try {
        const result = await this.#nativeWrite({ key, enabled: false }, () => this.host.setBundleEnabled(name, false));
        const application = typeof result?.application === 'string' ? result.application : 'applied';
        released.push({ key, outcome: application });
        report?.complete(`disable ${name}`, {
          status: application === 'failed' || application === 'cancelled' ? 'failed' : 'done',
          detail: application,
        });
        if (application === 'failed' || application === 'cancelled') {
          failed.push({ key, message: `native manager reported ${application}` });
        }
      } catch (error) {
        failed.push({ key, message: error instanceof Error ? error.message : String(error) });
        report?.complete(`disable ${name}`, { status: 'failed', detail: error instanceof Error ? error.message : String(error) });
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
  async #templateApply(request, report) {
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
    report?.activate('re-render and verify');
    const descriptor = await this.#descriptorOf(binding.packageName, binding.version);
    const template = selectTemplate(descriptor, preview.templateId);
    const root = await this.#workspaceRoot(preview.workspaceId, workspace);
    if (root !== preview.workspaceRoot) {
      throw new Fault(CODES.previewStale, { reason: 'workspace-path-changed', was: preview.workspaceRoot, now: root });
    }
    report?.complete('re-render and verify', { detail: `${preview.files.length} file(s)` });
    report?.activate('create files');
    for (const file of preview.files) report?.addStep(`write ${file.path}`);
    const outcome = await applyPreview({ preview: { ...preview, files: preview.files }, descriptor, template });
    for (const file of preview.files) {
      report?.complete(`write ${file.path}`, { detail: file.action ?? 'create' });
    }
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
   *
   * The question this answers is whether an enabled bundle should survive the
   * next shelf. Three answers, because there are three situations:
   *
   * - a lease explains it (an awake workspace asked for it) - nothing to report;
   * - this plugin applied the current state and has not released it - its own
   *   leftover, safe to release later, so it is *not* pinned;
   * - this plugin knows it last left the bundle off, or the provenance is
   *   unknown - somebody else may want it, so it is left alone and reported.
   *   Only the definite "we left it off" case pins, because pinning is what
   *   protects outside intent, and it must never be applied on a guess: a wrong
   *   pin silently welds the bundle on and stops shelving from ever working.
   * @returns {Promise<object>}
   */
  async #reconcile() {
    const state = this.store.snapshot();
    const bundles = await readBundles(this.host).catch(() => new Map());
    const leases = leasesOf(state);
    const drift = [];
    for (const [key, record] of Object.entries(state.packages)) {
      const { name, version } = parsePackageKey(key);
      const evaluated = evaluatePackage(bundles, name, version);
      const leased = (leases.get(key) ?? []).length > 0;
      const managed = record.ownership === 'managed' && !record.pinned;

      if (managed && evaluated.enabled && !leased) {
        if (record.lastAppliedEnabled === true) {
          // Ours, and no workspace is holding it: a shelf that did not finish, or
          // a restart that dropped the queued one. Releasable, never pinned.
          drift.push({ key, change: 'enabled-by-us-unreleased' });
        } else if (record.lastAppliedEnabled === false) {
          drift.push({ key, change: 'enabled-outside-management', action: 'pinned' });
        } else {
          // Written before provenance was recorded. Report rather than guess:
          // pinning on an unknown would wedge the bundle, and releasing on an
          // unknown would disable something this plugin never enabled.
          drift.push({ key, change: 'provenance-unknown' });
        }
      }
      if (managed && !evaluated.enabled && record.lastAppliedEnabled === true) {
        drift.push({ key, change: 'disabled-outside-management' });
      }
      if (evaluated.status === 'absent' && record.restoreCapability === 'archived') {
        drift.push({ key, change: 'uninstalled-but-archived' });
      }
    }
    if (drift.some((entry) => entry.action === 'pinned')) {
      await this.store.mutate(
        { action: 'reconcile', operationId: newId(), expectedRevision: this.store.revision },
        (draft) => {
          // Re-check inside the write: a lease may have appeared between the
          // read above and this commit.
          const currentLeases = leasesOf(draft);
          for (const entry of drift) {
            if (entry.action !== 'pinned') continue;
            if ((currentLeases.get(entry.key) ?? []).length > 0) continue;
            if (draft.packages[entry.key] !== undefined) draft.packages[entry.key].pinned = true;
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


/**
 * A compact, JSON-safe summary of an operation's outcome, for the progress
 * record. The full result can be large; this keeps only the fields a progress
 * view shows, so polling stays cheap.
 * @param {any} value
 * @returns {any}
 */
function summarizeProgressResult(value) {
  if (value === null || typeof value !== 'object') return value ?? null;
  const summary = {};
  for (const field of [
    'workspaceId',
    'status',
    'reason',
    'packageKey',
    'packageName',
    'version',
    'installOutcome',
    'templateId',
    'steps',
    'applied',
    'failures',
    'released',
    'kept',
    'failed',
    'created',
    'skipped',
    'queued',
    'release',
  ]) {
    if (value[field] !== undefined) summary[field] = value[field];
  }
  return jsonSafe(summary);
}