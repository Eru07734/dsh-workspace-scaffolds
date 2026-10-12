/**
 * Build identity: the loaded version must come from the manifest that sits next
 * to the running module, because that is the only source that cannot lie about
 * which code is executing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ownIdentity, resetIdentityCache, restartPending } from '../src/version.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('ownIdentity reports the real package manifest', () => {
  resetIdentityCache();
  const identity = ownIdentity();
  assert.equal(identity.name, manifest.name);
  assert.equal(identity.version, manifest.version);
  assert.match(identity.version, /^\d+\.\d+\.\d+/);
});

test('ownIdentity is memoized but stable', () => {
  const first = ownIdentity();
  const second = ownIdentity();
  assert.equal(first, second, 'the same object is reused');
});

test('a local spec naming another build is reported as pending', () => {
  assert.equal(restartPending('0.1.2', 'file:C:/x/dsh-workspace-scaffolds-0.1.3.tgz'), true);
  assert.equal(restartPending('0.1.2', 'link:../dsh-workspace-scaffolds-0.1.3'), true);
});

test('a local spec naming this build is not pending', () => {
  assert.equal(restartPending('0.1.3', 'file:C:/x/dsh-workspace-scaffolds-0.1.3.tgz'), false);
});

test('a registry range is never reported as pending', () => {
  // `^0.1.0` describes an acceptable set, not a different build, so claiming a
  // restart is needed would be a false alarm.
  assert.equal(restartPending('0.1.3', '^0.1.0'), false);
  assert.equal(restartPending('0.1.3', 'latest'), false);
  assert.equal(restartPending('0.1.3', '1.x'), false);
});

test('an unknown version or absent spec is never reported as pending', () => {
  // An identity we could not read must not be mistaken for a version match, and
  // also must not be turned into a fabricated mismatch.
  assert.equal(restartPending(null, 'file:C:/x/pkg-0.1.3.tgz'), false);
  assert.equal(restartPending('', 'file:C:/x/pkg-0.1.3.tgz'), false);
  assert.equal(restartPending('0.1.3', null), false);
  assert.equal(restartPending('0.1.3', ''), false);
});
