/**
 * Native bundle facts, reduced to what the coordinator and the panel need.
 * @module dsh-workspace-scaffolds/inventory
 */
import { Fault, CODES } from './errors.js';

/**
 * @typedef {object} BundleRow
 * @property {string} name
 * @property {string} [version]
 * @property {boolean} enabled
 * @property {boolean} installed
 * @property {boolean} removable
 * @property {string} [readOnlyReason]
 * @property {object} [error]
 */

/**
 * Read and index the profile's bundles.
 * @param {object} host
 * @returns {Promise<Map<string, BundleRow>>} Bundle rows by package name.
 */
export async function readBundles(host) {
  const rows = await host.listBundles();
  const index = new Map();
  for (const row of rows) {
    if (typeof row?.name !== 'string') continue;
    index.set(row.name, row);
  }
  return index;
}

/**
 * Decide how one exact package version stands in the profile.
 * @param {Map<string, BundleRow>} bundles
 * @param {string} name
 * @param {string} version
 * @returns {{status: 'absent'|'match'|'mismatch'|'error', actualVersion: string|null, enabled: boolean, error: object|null}}
 */
export function evaluatePackage(bundles, name, version) {
  const row = bundles.get(name);
  if (row === undefined) {
    return { status: 'absent', actualVersion: null, enabled: false, error: null };
  }
  if (row.error !== undefined) {
    return {
      status: 'error',
      actualVersion: typeof row.version === 'string' ? row.version : null,
      enabled: row.enabled === true,
      error: row.error,
    };
  }
  const actualVersion = typeof row.version === 'string' ? row.version : null;
  return {
    status: actualVersion === version ? 'match' : 'mismatch',
    actualVersion,
    enabled: row.enabled === true,
    error: null,
  };
}

/**
 * Reject an operation that would need a version the profile does not hold.
 * The native manager has no multi-version support for one package name, so a
 * mismatch is always a refusal rather than an upgrade.
 * @param {string} name
 * @param {string} requested
 * @param {{status: string, actualVersion: string|null}} evaluated
 */
export function assertVersion(name, requested, evaluated) {
  if (evaluated.status === 'match') return;
  if (evaluated.status === 'absent') {
    throw new Fault(CODES.dependencyMissing, { packageName: name, version: requested });
  }
  throw new Fault(CODES.versionConflict, {
    packageName: name,
    requestedVersion: requested,
    installedVersion: evaluated.actualVersion,
  });
}
