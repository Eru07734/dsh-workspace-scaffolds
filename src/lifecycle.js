/**
 * Live-work tracking and the deferred-sleep queue.
 *
 * Disabling a shared bundle while any agent is mid-turn would pull tools out
 * from under a running request, so a sleep that arrives during work is queued
 * and applied at the next idle boundary instead of being refused or forced.
 * @module dsh-workspace-scaffolds/lifecycle
 */

/** How long a caller waits for an idle boundary before it is told to keep going. */
export const DEFAULT_IDLE_WAIT_MS = 0;

/**
 * Tracks which agents are running and exposes an idle notification.
 */
export class Activity {
  /** @param {object} host */
  constructor(host) {
    this.host = host;
    /** @type {Map<string, 'idle'|'running'|'unknown'>} */
    this.statuses = new Map();
    /** @type {Set<() => void>} */
    this.idleListeners = new Set();
    this.disposers = [];
  }

  /**
   * Subscribe to the native agent lifecycle. Every subscription is registered
   * through `ctx.effect`, so disabling this plugin removes them.
   * @param {object} ctx
   */
  attach(ctx) {
    const remember = (agent) => {
      if (agent === undefined || agent === null) return;
      const id = String(agent.id ?? '');
      if (id === '') return;
      this.statuses.set(id, this.host.agentStatus(agent));
    };
    this.disposers.push(
      ctx.on('agent/created', ({ agent }) => {
        remember(agent);
      }),
    );
    this.disposers.push(
      ctx.on('agent/status', ({ agent, status }) => {
        if (agent === undefined || agent === null) return;
        const id = String(agent.id ?? '');
        if (id === '') return;
        const before = this.busy();
        this.statuses.set(id, status === 'running' ? 'running' : 'idle');
        if (before && !this.busy()) this.#notifyIdle();
      }),
    );
    this.disposers.push(
      ctx.on('agent/disposed', ({ agent }) => {
        if (agent === undefined || agent === null) return;
        const id = String(agent.id ?? '');
        const before = this.busy();
        this.statuses.delete(id);
        if (before && !this.busy()) this.#notifyIdle();
      }),
    );
  }

  /** @returns {() => void} Removes every subscription. */
  detach() {
    const disposers = this.disposers.splice(0, this.disposers.length);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // A failing disposer must not stop the remaining ones.
      }
    }
    this.statuses.clear();
    this.idleListeners.clear();
    return undefined;
  }

  /**
   * Whether any agent is currently executing work. Live agents are re-read from
   * the host so an event missed during startup cannot leave this permanently
   * convinced that work is in flight.
   * @returns {boolean}
   */
  busy() {
    for (const agent of this.host.listAgents()) {
      if (this.host.agentStatus(agent) === 'running') return true;
    }
    for (const status of this.statuses.values()) {
      if (status === 'running') return true;
    }
    return false;
  }

  /**
   * @param {() => void} listener Called when the last running agent goes idle.
   * @returns {() => void} Removes the listener.
   */
  onIdle(listener) {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }

  #notifyIdle() {
    for (const listener of [...this.idleListeners]) {
      try {
        listener();
      } catch {
        // One broken listener must not starve the others.
      }
    }
  }
}

/**
 * Holds one deferred sleep per workspace and applies it when work drains.
 */
export class SleepQueue {
  /**
   * @param {Activity} activity
   * @param {(workspaceId: string, trigger: string) => Promise<object>} apply
   */
  constructor(activity, apply) {
    this.activity = activity;
    this.apply = apply;
    /** @type {Map<string, {workspaceId: string, requestedAt: string, era: number}>} */
    this.pending = new Map();
    this.era = 0;
    /** @type {Promise<void>|null} */
    this.draining = null;
    this.unsubscribe = activity.onIdle(() => {
      void this.drain();
    });
  }

  /** @returns {void} */
  dispose() {
    this.unsubscribe();
    this.pending.clear();
  }

  /**
   * Queue a sleep, or supersede an earlier request for the same workspace.
   * @param {string} workspaceId
   * @returns {{queued: true, era: number}}
   */
  enqueue(workspaceId) {
    this.era += 1;
    const entry = { workspaceId, requestedAt: new Date().toISOString(), era: this.era };
    this.pending.set(workspaceId, entry);
    return { queued: true, era: entry.era };
  }

  /**
   * Cancel a queued sleep. Called when the workspace wakes again, so a stale
   * queue entry can never disable a package the workspace just asked for.
   * @param {string} workspaceId
   * @returns {boolean} Whether something was cancelled.
   */
  cancel(workspaceId) {
    this.era += 1;
    return this.pending.delete(workspaceId);
  }

  /** @param {string} workspaceId @returns {object|null} The queued request, if any. */
  peek(workspaceId) {
    return this.pending.get(workspaceId) ?? null;
  }

  /** @returns {string[]} Workspaces with a deferred sleep. */
  workspaces() {
    return [...this.pending.keys()];
  }

  /**
   * Apply every queued sleep that can run now. Re-entrant calls join the first
   * drain instead of starting a second one.
   * @returns {Promise<void>}
   */
  async drain() {
    if (this.draining !== null) return await this.draining;
    if (!this.activity.busy()) {
      this.draining = this.#drainOnce().finally(() => {
        this.draining = null;
      });
      return await this.draining;
    }
    return undefined;
  }

  async #drainOnce() {
    while (!this.activity.busy()) {
      const next = [...this.pending.values()].sort((left, right) => left.era - right.era)[0];
      if (next === undefined) return;
      this.pending.delete(next.workspaceId);
      try {
        await this.apply(next.workspaceId, 'deferred');
      } catch {
        // The operation log holds the failure; a queued sleep never throws into
        // the event that triggered it.
      }
    }
  }
}
