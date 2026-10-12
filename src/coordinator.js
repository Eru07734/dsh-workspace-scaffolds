/**
 * Pure decision logic: which packages a workspace needs, which may be turned
 * off when it sleeps, and which must stay running for someone else.
 *
 * Nothing here performs I/O, so every rule below is directly unit-testable.
 * @module dsh-workspace-scaffolds/coordinator
 */
import { Fault, CODES } from './errors.js';
import { packageKey } from './util.js';

/**
 * @param {{packageName: string, version: string}} binding
 * @returns {string}
 */
export function keyOf(binding) {
  return packageKey(binding.packageName, binding.version);
}

/**
 * Workspaces that currently claim each package.
 *
 * A lease is a *declared need*, derived from state rather than stored: a
 * workspace holds a lease exactly while it is awake and the binding is enabled.
 * Deriving it removes the whole class of bugs where a stored lease and the
 * bindings disagree.
 * @param {object} state
 * @returns {Map<string, string[]>} Package key to claiming workspace ids, sorted.
 */
export function leasesOf(state) {
  const leases = new Map();
  for (const workspace of Object.values(state.workspaces)) {
    if (workspace.requestedState !== 'awake') continue;
    for (const binding of workspace.bindings) {
      if (!binding.enabled) continue;
      const key = keyOf(binding);
      const holders = leases.get(key) ?? [];
      holders.push(workspace.workspaceId);
      leases.set(key, holders);
    }
  }
  for (const holders of leases.values()) holders.sort();
  return leases;
}

/**
 * Workspaces that would claim each package if `workspaceId` went to sleep.
 * @param {object} state
 * @param {string} workspaceId
 * @returns {Map<string, string[]>}
 */
export function leasesWithout(state, workspaceId) {
  const simulated = {
    ...state,
    workspaces: {
      ...state.workspaces,
      [workspaceId]: { ...state.workspaces[workspaceId], requestedState: 'sleeping' },
    },
  };
  return leasesOf(simulated);
}

/**
 * Required package keys reachable from one binding, following the descriptor's
 * `requires` edges. Missing targets are reported instead of silently ignored.
 * @param {object} state
 * @param {string} workspaceId
 * @returns {{order: string[], missing: Array<{from: string, name: string, version: string}>}}
 */
export function dependencyOrder(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId });
  const requested = workspace.bindings.filter((binding) => binding.enabled);
  const byKey = new Map(requested.map((binding) => [keyOf(binding), binding]));
  const missing = [];
  const edges = new Map();
  for (const binding of requested) {
    const key = keyOf(binding);
    const record = state.packages[key];
    const requires = Array.isArray(record?.scaffold?.requires) ? record.scaffold.requires : [];
    const dependencies = [];
    for (const requirement of requires) {
      const dependencyKey = packageKey(requirement.name, requirement.version);
      if (!byKey.has(dependencyKey)) {
        missing.push({ from: key, name: requirement.name, version: requirement.version });
        continue;
      }
      dependencies.push(dependencyKey);
    }
    edges.set(key, dependencies);
  }
  if (missing.length > 0) {
    throw new Fault(CODES.dependencyMissing, { workspaceId, missing });
  }
  const order = [];
  const state_ = new Map();
  const visit = (key, trail) => {
    const mark = state_.get(key);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new Fault(CODES.dependencyCycle, { workspaceId, cycle: [...trail, key] });
    }
    state_.set(key, 'visiting');
    for (const dependency of edges.get(key) ?? []) visit(dependency, [...trail, key]);
    state_.set(key, 'done');
    order.push(key);
  };
  for (const key of byKey.keys()) visit(key, []);
  return { order, missing: [] };
}

/**
 * The steps needed to make a workspace's packages available.
 * @param {object} state
 * @param {string} workspaceId
 * @returns {{steps: Array<{key: string, packageName: string, version: string, required: boolean, restoreCapability: string|null, isNew: boolean}>}}
 */
export function planWake(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId });
  const { order } = dependencyOrder(state, workspaceId);
  const bindings = new Map(workspace.bindings.map((binding) => [keyOf(binding), binding]));
  const steps = order.map((key) => {
    const binding = bindings.get(key);
    const record = state.packages[key] ?? null;
    return {
      key,
      packageName: binding.packageName,
      version: binding.version,
      required: binding.required !== false,
      restoreCapability: record === null ? null : record.restoreCapability,
      isNew: record === null,
    };
  });
  return { steps };
}

/**
 * Which packages a sleeping workspace releases, and which stay for a stated
 * reason. A package is only ever a release candidate when this workspace was the
 * last declared holder; anything pinned or externally owned is kept.
 * @param {object} state
 * @param {string} workspaceId
 * @returns {{release: string[], keep: Array<{key: string, reason: string, holders: string[]}>}}
 */
export function planSleep(state, workspaceId) {
  const workspace = state.workspaces[workspaceId];
  if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId });
  const remaining = leasesWithout(state, workspaceId);
  const release = [];
  const keep = [];
  const seen = new Set();
  for (const binding of workspace.bindings) {
    const key = keyOf(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    const record = state.packages[key] ?? null;
    const holders = remaining.get(key) ?? [];
    if (holders.length > 0) {
      keep.push({ key, reason: 'other-workspace', holders });
      continue;
    }
    if (record === null) {
      keep.push({ key, reason: 'unrecorded', holders: [] });
      continue;
    }
    if (record.pinned) {
      keep.push({ key, reason: 'pinned', holders: [] });
      continue;
    }
    if (record.ownership === 'external') {
      keep.push({ key, reason: 'external', holders: [] });
      continue;
    }
    release.push(key);
  }
  return { release, keep };
}

/**
 * Which packages one removed association releases.
 *
 * Unbinding removes a single declared need, not all of a workspace's needs, so
 * this cannot reuse {@link planSleep}: that answers "what may go when the whole
 * workspace sleeps" and would release every package the workspace uniquely
 * holds. Here only the package behind the removed binding is a candidate, and
 * only when nobody else - including this workspace's remaining associations -
 * still claims it.
 * @param {object} state
 * @param {string} workspaceId
 * @param {string} bindingId
 * @returns {{release: string[], keep: Array<{key: string, reason: string, holders: string[]}>}}
 */
export function planUnbind(state, workspaceId, bindingId) {
  const workspace = state.workspaces[workspaceId];
  if (workspace === undefined) throw new Fault(CODES.workspaceNotFound, { workspaceId });
  const binding = workspace.bindings.find((entry) => entry.id === bindingId);
  if (binding === undefined) {
    throw new Fault(CODES.invalidRequest, { field: 'bindingId', reason: 'unknown-binding' });
  }
  const key = keyOf(binding);
  // A disabled association never claimed anything, so removing it must not
  // change native state at all.
  if (binding.enabled === false) return { release: [], keep: [] };

  const simulated = {
    ...state,
    workspaces: {
      ...state.workspaces,
      [workspaceId]: {
        ...workspace,
        bindings: workspace.bindings.filter((entry) => entry.id !== bindingId),
      },
    },
  };
  const holders = leasesOf(simulated).get(key) ?? [];
  if (holders.length > 0) return { release: [], keep: [{ key, reason: 'other-workspace', holders }] };

  const record = state.packages[key] ?? null;
  if (record === null) return { release: [], keep: [{ key, reason: 'unrecorded', holders: [] }] };
  if (record.pinned) return { release: [], keep: [{ key, reason: 'pinned', holders: [] }] };
  if (record.ownership === 'external') return { release: [], keep: [{ key, reason: 'external', holders: [] }] };
  return { release: [key], keep: [] };
}

/**
 * Describe why a package is retained, for the panel.
 * @param {string} reason
 * @returns {string} A stable identifier the client maps to localized text.
 */
export function keepReasonCode(reason) {
  return `keep.${reason}`;
}
