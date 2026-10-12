/**
 * Decision rules: leases, dependency order, and which packages a sleeping
 * workspace is allowed to release.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES } from '../src/errors.js';
import { dependencyOrder, leasesOf, planSleep, planWake } from '../src/coordinator.js';
import { emptyState } from '../src/schema.js';
import { readBundles, evaluatePackage } from '../src/inventory.js';

/**
 * Build a state document with the given shape.
 * @param {object} input
 */
function stateWith({ packages = {}, workspaces = {} }) {
  const state = emptyState();
  state.packages = packages;
  state.workspaces = workspaces;
  return state;
}

/** @param {string} id @param {object[]} bindings @param {string} requestedState */
function workspace(id, bindings, requestedState = 'awake') {
  return {
    workspaceId: id,
    lastKnownPath: `/proj/${id}`,
    title: id,
    autoRestore: true,
    requestedState,
    bindings: bindings.map((binding, index) => ({
      id: `${id}-b${index}`,
      packageName: binding.name,
      version: binding.version,
      archiveSha256: null,
      enabled: binding.enabled !== false,
      required: binding.required !== false,
      templateId: null,
      templateValues: {},
      lastGeneratedAt: null,
      addedAt: new Date().toISOString(),
    })),
    updatedAt: new Date().toISOString(),
  };
}

/** @param {string} ownership @param {boolean} pinned */
function record(ownership, pinned) {
  return {
    archiveSha256: null,
    sourceKind: 'installed',
    restoreCapability: 'installed-only',
    initiallyEnabled: false,
    ownership,
    pinned,
    title: null,
    importedAt: new Date().toISOString(),
    archiveEntryCount: null,
    archiveBytes: null,
    scaffold: null,
  };
}

test('a lease exists exactly while a workspace is awake and the binding enabled', () => {
  const state = stateWith({
    packages: { 'a@1.0.0': record('managed', false) },
    workspaces: {
      one: workspace('one', [{ name: 'a', version: '1.0.0' }], 'awake'),
      two: workspace('two', [{ name: 'a', version: '1.0.0' }], 'sleeping'),
      three: workspace('three', [{ name: 'a', version: '1.0.0', enabled: false }], 'awake'),
    },
  });
  const leases = leasesOf(state);
  assert.deepEqual(leases.get('a@1.0.0'), ['one']);
});

test('the last holder releases; an earlier holder does not', () => {
  const state = stateWith({
    packages: { 'a@1.0.0': record('managed', false) },
    workspaces: {
      one: workspace('one', [{ name: 'a', version: '1.0.0' }], 'awake'),
      two: workspace('two', [{ name: 'a', version: '1.0.0' }], 'awake'),
    },
  });
  const first = planSleep(state, 'one');
  assert.deepEqual(first.release, []);
  assert.equal(first.keep[0].reason, 'other-workspace');
  assert.deepEqual(first.keep[0].holders, ['two']);

  const sleeping = stateWith({
    packages: { 'a@1.0.0': record('managed', false) },
    workspaces: {
      one: workspace('one', [{ name: 'a', version: '1.0.0' }], 'sleeping'),
      two: workspace('two', [{ name: 'a', version: '1.0.0' }], 'awake'),
    },
  });
  assert.deepEqual(planSleep(sleeping, 'two').release, ['a@1.0.0']);
});

test('pinned and external packages are never release candidates', () => {
  const state = stateWith({
    packages: { 'a@1.0.0': record('managed', true), 'b@1.0.0': record('external', false) },
    workspaces: { one: workspace('one', [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }]) },
  });
  const plan = planSleep(state, 'one');
  assert.deepEqual(plan.release, []);
  assert.deepEqual(plan.keep.map((entry) => entry.reason).sort(), ['external', 'pinned']);
});

test('dependency order puts requirements first and detects a cycle', () => {
  const state = stateWith({
    packages: {
      'app@1.0.0': { ...record('managed', false), scaffold: { requires: [{ name: 'lib', version: '1.0.0' }] } },
      'lib@1.0.0': { ...record('managed', false), scaffold: { requires: [{ name: 'app', version: '1.0.0' }] } },
    },
    workspaces: { one: workspace('one', [{ name: 'app', version: '1.0.0' }, { name: 'lib', version: '1.0.0' }]) },
  });
  assert.throws(
    () => dependencyOrder(state, 'one'),
    (error) => error.code === CODES.dependencyCycle,
  );

  const ordered = stateWith({
    packages: {
      'app@1.0.0': { ...record('managed', false), scaffold: { requires: [{ name: 'lib', version: '1.0.0' }] } },
      'lib@1.0.0': record('managed', false),
    },
    workspaces: { one: workspace('one', [{ name: 'app', version: '1.0.0' }, { name: 'lib', version: '1.0.0' }]) },
  });
  assert.deepEqual(dependencyOrder(ordered, 'one').order, ['lib@1.0.0', 'app@1.0.0']);
});

test('a missing requirement is reported, not ignored', () => {
  const state = stateWith({
    packages: {
      'app@1.0.0': { ...record('managed', false), scaffold: { requires: [{ name: 'lib', version: '9.9.9' }] } },
    },
    workspaces: { one: workspace('one', [{ name: 'app', version: '1.0.0' }]) },
  });
  assert.throws(
    () => planWake(state, 'one'),
    (error) => error.code === CODES.dependencyMissing && error.details.missing[0].name === 'lib',
  );
});

test('evaluatePackage distinguishes absent, matching and mismatched versions', () => {
  const bundles = new Map([['a', { name: 'a', version: '1.0.0', enabled: true }]]);
  assert.deepEqual(evaluatePackage(bundles, 'a', '1.0.0'), {
    status: 'match',
    actualVersion: '1.0.0',
    enabled: true,
    error: null,
  });
  assert.equal(evaluatePackage(bundles, 'a', '2.0.0').status, 'mismatch');
  assert.equal(evaluatePackage(bundles, 'missing', '1.0.0').status, 'absent');
  assert.equal(evaluatePackage(new Map([['a', { name: 'a', error: { code: 'not-bundle' } }]]), 'a', '1.0.0').status, 'error');
});

test('readBundles indexes by name and tolerates malformed rows', async () => {
  const host = { listBundles: async () => [{ name: 'a', version: '1.0.0', enabled: false }, { nope: true }] };
  const bundles = await readBundles(host);
  assert.equal(bundles.size, 1);
  assert.equal(bundles.get('a').version, '1.0.0');
});
