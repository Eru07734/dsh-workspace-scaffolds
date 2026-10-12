/**
 * Progress for operations that take real time.
 *
 * `import` runs a package manager and `wake` enables bundles one by one; both
 * are synchronous requests that would otherwise give a caller nothing to look
 * at until they finish. This keeps a small in-memory record of what the current
 * and recent operations are doing, so the HTTP surface can answer "where is it
 * now" while the work is still running.
 *
 * Progress is deliberately not persisted: it describes a live process, and a
 * stale record read after a restart would be worse than none. The durable
 * outcome stays in the operation log.
 * @module dsh-workspace-scaffolds/progress
 */

/** Steps older than this are dropped from the recent list once finished. */
const RECENT_LIMIT = 20;

/** @typedef {'pending'|'active'|'done'|'failed'|'skipped'} StepStatus */

/**
 * Build the wire form of a step.
 * @param {string} label
 * @param {StepStatus} status
 * @param {string|null} detail
 */
function step(label, status, detail = null) {
  return { label, status, ...(detail === null ? {} : { detail }) };
}

/**
 * Tracks running and recently finished operations.
 */
export class Progress {
  /** @param {{limit?: number}} [options] */
  constructor(options = {}) {
    this.limit = options.limit ?? RECENT_LIMIT;
    /** @type {Map<string, object>} */
    this.entries = new Map();
  }

  /**
   * Start tracking an operation.
   * @param {string} operationId
   * @param {string} action
   * @param {string[]} stepLabels Planned steps, in order.
   * @returns {object} The mutable entry, for the caller to drive.
   */
  begin(operationId, action, stepLabels = []) {
    const now = new Date().toISOString();
    const entry = {
      operationId,
      action,
      status: 'running',
      phase: stepLabels.length > 0 ? stepLabels[0] : 'running',
      steps: stepLabels.map((label) => step(label, 'pending')),
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      error: null,
      result: null,
    };
    this.entries.set(operationId, entry);
    this.#prune();
    return entry;
  }

  /**
   * Mark one planned step active, and by implication everything before it done.
   * @param {string} operationId
   * @param {string} label
   */
  activate(operationId, label) {
    this.#update(operationId, (entry) => {
      let seen = false;
      for (const item of entry.steps) {
        if (item.label === label) {
          item.status = 'active';
          seen = true;
          continue;
        }
        if (!seen && item.status === 'pending') item.status = 'done';
      }
      entry.phase = label;
    });
  }

  /**
   * Mark a step finished.
   * @param {string} operationId
   * @param {string} label
   * @param {{status?: StepStatus, detail?: string}} [outcome]
   */
  complete(operationId, label, outcome = {}) {
    this.#update(operationId, (entry) => {
      const item = entry.steps.find((candidate) => candidate.label === label);
      if (item === undefined) return;
      item.status = outcome.status ?? 'done';
      if (outcome.detail !== undefined) item.detail = outcome.detail;
    });
  }

  /**
   * Append a step that was not known in advance, e.g. one per package.
   * @param {string} operationId
   * @param {string} label
   * @returns {void}
   */
  addStep(operationId, label) {
    this.#update(operationId, (entry) => {
      entry.steps.push(step(label, 'pending'));
      entry.phase = label;
    });
  }

  /**
   * Set the free-text current phase.
   * @param {string} operationId
   * @param {string} phase
   */
  phase(operationId, phase) {
    this.#update(operationId, (entry) => {
      entry.phase = phase;
    });
  }

  /**
   * Finish an operation.
   * @param {string} operationId
   * @param {{ok: true, result: any} | {ok: false, code: string, details: object}} outcome
   */
  finish(operationId, outcome) {
    this.#update(operationId, (entry) => {
      entry.status = outcome.ok ? 'succeeded' : 'failed';
      entry.finishedAt = new Date().toISOString();
      entry.steps = entry.steps.map((item) =>
        item.status === 'active' || item.status === 'pending'
          ? { ...item, status: outcome.ok ? 'done' : 'failed' }
          : item,
      );
      entry.phase = outcome.ok ? 'done' : 'failed';
      if (outcome.ok) entry.result = outcome.result === undefined ? null : outcome.result;
      else entry.error = { code: outcome.code, details: outcome.details ?? {} };
    });
    this.#prune();
  }

  /**
   * @param {string} operationId
   * @returns {object|null} The entry, or null when unknown.
   */
  get(operationId) {
    const entry = this.entries.get(operationId);
    return entry === undefined ? null : cloneEntry(entry);
  }

  /**
   * Running operations first, then the most recent finished ones.
   * @returns {{running: object[], recent: object[]}}
   */
  snapshot() {
    const all = [...this.entries.values()].map(cloneEntry);
    return {
      running: all.filter((entry) => entry.status === 'running'),
      recent: all.filter((entry) => entry.status !== 'running').slice(-this.limit).reverse(),
    };
  }

  /** @returns {void} */
  clear() {
    this.entries.clear();
  }

  /**
   * @param {string} operationId
   * @param {(entry: object) => void} mutate
   */
  #update(operationId, mutate) {
    const entry = this.entries.get(operationId);
    if (entry === undefined) return;
    mutate(entry);
    entry.updatedAt = new Date().toISOString();
  }

  /** Keep only running entries plus the newest finished ones. */
  #prune() {
    const finished = [...this.entries.values()].filter((entry) => entry.status !== 'running');
    if (finished.length <= this.limit) return;
    finished.sort((left, right) => String(left.finishedAt).localeCompare(String(right.finishedAt)));
    for (const entry of finished.slice(0, finished.length - this.limit)) {
      this.entries.delete(entry.operationId);
    }
  }
}

/**
 * Deep-copy an entry so callers can never mutate what is being tracked.
 * @param {object} entry
 * @returns {object}
 */
function cloneEntry(entry) {
  return {
    ...entry,
    steps: entry.steps.map((item) => ({ ...item })),
    error: entry.error === null ? null : { ...entry.error },
  };
}
