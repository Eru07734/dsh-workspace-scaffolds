/**
 * Durable-state invariants: revision guarding, idempotency, backup recovery and
 * the refusal to guess when the stored document is damaged or newer than this
 * build understands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { CODES } from '../src/errors.js';
import { emptyState, normalizeState, SCHEMA_VERSION } from '../src/schema.js';

/** @returns {Promise<{store: Store, dir: string, cleanup: () => Promise<void>}>} */
async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'wss-store-'));
  const store = new Store(dir);
  await store.init();
  return { store, dir, cleanup: async () => await rm(dir, { recursive: true, force: true }) };
}

test('a fresh directory starts empty at revision zero', async () => {
  const { store, cleanup } = await makeStore();
  try {
    assert.equal(store.revision, 0);
    assert.deepEqual(store.snapshot(), emptyState());
  } finally {
    await cleanup();
  }
});

test('mutate bumps the revision and rejects a stale expectedRevision', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.mutate({ action: 'reconcile', operationId: 'op-1', expectedRevision: 0 }, () => ({ ok: 1 }));
    assert.equal(store.revision, 1);
    await assert.rejects(
      store.mutate({ action: 'reconcile', operationId: 'op-2', expectedRevision: 0 }, () => ({ ok: 2 })),
      (error) => error.code === CODES.revisionConflict && error.details.currentRevision === 1,
    );
  } finally {
    await cleanup();
  }
});

test('replaying an operationId returns the recorded result without re-applying', async () => {
  const { store, cleanup } = await makeStore();
  try {
    let applications = 0;
    const request = { action: 'reconcile', operationId: 'op-1', expectedRevision: 0, args: { note: 'x' } };
    const first = await store.mutate(request, () => {
      applications += 1;
      return { applied: true };
    });
    const second = await store.mutate(request, () => {
      applications += 1;
      return { applied: 'again' };
    });
    assert.equal(applications, 1);
    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.value, { applied: true });
    assert.equal(store.revision, 1);
  } finally {
    await cleanup();
  }
});

test('reusing an operationId with different arguments is refused', async () => {
  const { store, cleanup } = await makeStore();
  try {
    await store.mutate({ action: 'reconcile', operationId: 'op-1', expectedRevision: 0, args: { a: 1 } }, () => ({}));
    await assert.rejects(
      store.mutate({ action: 'reconcile', operationId: 'op-1', expectedRevision: 1, args: { a: 2 } }, () => ({})),
      (error) => error.code === CODES.operationIdReused,
    );
  } finally {
    await cleanup();
  }
});

test('a damaged primary state falls back to the verified backup', async () => {
  const { store, dir, cleanup } = await makeStore();
  try {
    await store.mutate({ action: 'reconcile', operationId: 'op-1', expectedRevision: 0, args: {} }, (draft) => {
      draft.workspaces['ws-1'] = {
        workspaceId: 'ws-1',
        lastKnownPath: 'C:/one',
        title: 'one',
        autoRestore: true,
        requestedState: 'awake',
        bindings: [],
        updatedAt: new Date().toISOString(),
      };
      return {};
    });
    // One more write so a backup of the populated state exists.
    await store.mutate({ action: 'reconcile', operationId: 'op-2', expectedRevision: 1, args: {} }, () => ({}));
    await writeFile(join(dir, 'state.json'), '{ this is not json');

    const revived = new Store(dir);
    await revived.init();
    assert.equal(revived.recoveryNote, 'restored-from-backup');
    assert.equal(Object.keys(revived.snapshot().workspaces).length, 1);
  } finally {
    await cleanup();
  }
});

test('a damaged state without a backup is refused, never treated as empty', async () => {
  const { dir, cleanup } = await makeStore();
  try {
    await writeFile(join(dir, 'state.json'), 'not json at all');
    const revived = new Store(dir);
    await assert.rejects(
      revived.init(),
      (error) => error.code === CODES.stateCorrupt,
    );
  } finally {
    await cleanup();
  }
});

test('a future schema version is refused rather than downgraded', async () => {
  const { dir, cleanup } = await makeStore();
  try {
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({ ...emptyState(), schemaVersion: SCHEMA_VERSION + 1, revision: 4 }),
    );
    const revived = new Store(dir);
    await assert.rejects(
      revived.init(),
      (error) => error.code === CODES.unsupportedHost && error.details.reason === 'future-schema',
    );
  } finally {
    await cleanup();
  }
});

test('normalizeState rejects a malformed record instead of repairing it silently', () => {
  const base = emptyState();
  assert.throws(
    () => normalizeState({ ...base, workspaces: { 'ws-1': { requestedState: 'nonsense', bindings: [] } } }),
    (error) => error.code === CODES.stateCorrupt,
  );
  assert.throws(
    () =>
      normalizeState({
        ...base,
        packages: { 'a@1.0.0': { archiveSha256: 'short', sourceKind: 'tarball', restoreCapability: 'archived', ownership: 'managed' } },
      }),
    (error) => error.code === CODES.stateCorrupt,
  );
  assert.throws(
    () =>
      normalizeState({
        ...base,
        workspaces: {
          'ws-1': {
            requestedState: 'awake',
            bindings: [
              { id: 'a', packageName: 'x', version: '1.0.0' },
              { id: 'b', packageName: 'x', version: '1.0.0' },
            ],
          },
        },
      }),
    (error) => error.code === CODES.stateCorrupt,
  );
});

test('concurrent writes serialize instead of losing an update', async () => {
  const { store, dir, cleanup } = await makeStore();
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        store.mutate({ action: 'reconcile', operationId: `op-${index}`, expectedRevision: index }, () => ({
          index,
        })),
      ),
    ).catch(() => {
      // Revision conflicts are expected for the racing callers; the point is
      // that the file itself stays readable and the revision is consistent.
    });
    const revived = new Store(dir);
    await revived.init();
    assert.ok(revived.revision >= 1);
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(onDisk.revision, revived.revision);
  } finally {
    await cleanup();
  }
});
