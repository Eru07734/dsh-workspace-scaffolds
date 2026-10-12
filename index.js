/**
 * Host entry point: builds the services, wires the agent lifecycle, and mounts
 * the HTTP surface and the agent tool. All behaviour lives in `src/`.
 * @module dsh-workspace-scaffolds
 */
import { mountHttp } from './src/api.js';
import { CODES } from './src/errors.js';
import { createHost } from './src/host.js';
import { Activity } from './src/lifecycle.js';
import { Operations } from './src/operations.js';
import { Store } from './src/store.js';
import { registerTool } from './src/tool.js';
import { canonicalize, newId } from './src/util.js';

export const name = 'workspace-scaffolds';

/**
 * Only services this plugin cannot work without are injected. The optional
 * peers (plugin manager, workspace registry, agent registry) are resolved
 * lazily so a late or missing mount degrades to a reported capability instead
 * of blocking the whole plugin.
 */
export const inject = ['connection', 'tools'];

/** How long `agent/created` may spend restoring before it gives up and reports. */
const AUTO_RESTORE_BUDGET_MS = 15_000;

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{settled: true, value: T} | {settled: false}>}
 */
async function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ settled: true, value })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx
 * @returns {void}
 */
export function apply(ctx) {
  const host = createHost(ctx);
  const store = new Store(host.storageDir);
  const activity = new Activity(host);
  const operations = new Operations({ host, store, activity });
  operations.init();
  activity.attach(ctx);

  /** @type {Promise<void>|null} */
  let booting = null;
  /** @type {Error|null} */
  let bootError = null;

  const bootstrap = async () => {
    try {
      await store.init();
      const reconciliation = await withBudget(operations.execute({ action: 'reconcile' }), 20_000);
      if (!reconciliation.settled) {
        host.logger.warn?.('workspace-scaffolds: startup reconciliation exceeded its budget');
      }
    } catch (error) {
      bootError = error instanceof Error ? error : new Error(String(error));
      host.logger.warn?.(`workspace-scaffolds: startup failed: ${bootError.message}`);
    }
  };
  const ensureReady = async () => {
    booting ??= bootstrap();
    await booting;
    if (bootError !== null) throw bootError;
  };

  // Every entry point waits for the store, so a request that arrives during
  // startup cannot observe a half-loaded state.
  const guarded = {
    /**
     * @param {object} request
     * @returns {Promise<any>}
     */
    async execute(request) {
      await ensureReady();
      return await operations.execute(request);
    },
  };

  ctx.provide('workspaceScaffolds', guarded);
  ctx.effect(() => () => {
    operations.dispose();
    activity.detach();
  }, 'workspace-scaffolds: release listeners and queued work');

  mountHttp(ctx, guarded);
  registerTool(ctx, guarded);

  /**
   * Resolve the workspace a live agent belongs to, by canonical directory.
   * @param {object} agent
   * @returns {Promise<string|null>}
   */
  const workspaceOf = async (agent) => {
    const cwd = agent?.session?.header?.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) return null;
    const canonical = await canonicalize(cwd);
    let snapshot;
    try {
      snapshot = await guarded.execute({ action: 'list' });
    } catch {
      return null;
    }
    const match = snapshot.workspaces.find((workspace) => workspace.nativePath === canonical);
    return match?.workspaceId ?? null;
  };

  const restoreFor = async (workspaceId) => {
    const snapshot = await guarded.execute({ action: 'list' });
    const workspace = snapshot.workspaces.find((entry) => entry.workspaceId === workspaceId);
    if (workspace === undefined || !workspace.autoRestore) return null;
    if (snapshot.capabilities.pluginManager !== true) return null;
    if (workspace.bindings.length === 0) return null;
    const wanted = workspace.bindings.filter((binding) => binding.enabled);
    if (wanted.length > 0 && wanted.every((binding) => binding.package.enabled)) return null;
    // The automatic path never installs: a package manager run inside agent
    // creation would stall startup for an unbounded time. Missing packages are
    // reported instead, and the explicit "restore and open" action performs them.
    return await guarded.execute({
      action: 'wake',
      operationId: newId(),
      expectedRevision: snapshot.revision,
      workspaceId,
      install: false,
      fast: true,
    });
  };

  ctx.on('agent/created', async ({ agent }) => {
    if (operations.automaticRestore !== 'enabled') return;
    try {
      const workspaceId = await workspaceOf(agent);
      if (workspaceId === null) return;
      const outcome = await withBudget(restoreFor(workspaceId), AUTO_RESTORE_BUDGET_MS);
      if (!outcome.settled) {
        operations.automaticRestore = 'degraded';
        host.logger.warn?.(`workspace-scaffolds: automatic restore for workspace ${workspaceId} exceeded its budget`);
        return;
      }
      if (outcome.value !== null) {
        const failures = Array.isArray(outcome.value.failures) ? outcome.value.failures : [];
        if (failures.length > 0) {
          operations.automaticRestore = 'degraded';
          host.logger.warn?.(
            `workspace-scaffolds: workspace ${workspaceId} restored with ${failures.length} unmet package(s); open the panel to prepare them`,
          );
        }
      }
    } catch (error) {
      // A failed automatic restore must never fail agent creation; the panel and
      // the tool both surface the real state.
      operations.automaticRestore = 'degraded';
      host.logger.warn?.(
        `workspace-scaffolds: automatic restore failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  ctx.on('plugin-manager/changed', () => {
    // Another surface changed enablement - or this plugin itself just did. The
    // operations layer holds back the events its own writes cause, so a change
    // it applied is never mistaken for intent from somewhere else. Reconciling
    // on the raw event made a wake pin the very bundle it had enabled, which
    // permanently stopped that bundle from being shelved.
    void ensureReady()
      .then(() => operations.reconcileFromEvent())
      .catch(() => {});
  });

  ctx.logger?.debug?.(`workspace-scaffolds: mounted; state directory ${host.storageDir}`);
}

export { CODES };
