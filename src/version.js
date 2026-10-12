/**
 * The identity of the build that is actually loaded in memory.
 *
 * This deliberately reads the manifest that sits next to the running module,
 * not the version the profile asks for. Those two differ exactly when an update
 * has been written to disk but the process still holds the previous code, and
 * that is the state a caller most needs to be able to see.
 * @module dsh-workspace-scaffolds/version
 */
import { readFileSync } from 'node:fs';

/** Resolves to this package's own manifest wherever it was installed from. */
const manifestUrl = new URL('../package.json', import.meta.url);

/** @type {{name: string|null, version: string|null}|null} */
let cached = null;

/**
 * Read this package's name and version once.
 *
 * A failure is reported as `null` rather than guessed: an absent identity must
 * never be mistaken for a version match.
 * @returns {{name: string|null, version: string|null}}
 */
export function ownIdentity() {
  if (cached !== null) return cached;
  try {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    cached = {
      name: typeof manifest.name === 'string' ? manifest.name : null,
      version: typeof manifest.version === 'string' ? manifest.version : null,
    };
  } catch {
    cached = { name: null, version: null };
  }
  return cached;
}

/**
 * Whether the profile is asking for something other than the loaded build.
 *
 * This is a narrow, deliberately conservative heuristic. Only local specifiers
 * (`file:` / `link:`) are judged, because those embed the exact artifact in the
 * string and a mismatch is unambiguous. A registry range such as `^0.1.0` is a
 * statement about an acceptable set, not a different build, so it is never
 * reported as pending.
 *
 * @param {string|null} pluginVersion Version of the running build.
 * @param {string|null} profileSpec Raw dependency spec the profile declares.
 * @returns {boolean}
 */
export function restartPending(pluginVersion, profileSpec) {
  if (typeof pluginVersion !== 'string' || pluginVersion.length === 0) return false;
  if (typeof profileSpec !== 'string' || profileSpec.length === 0) return false;
  if (!/^(file|link):/.test(profileSpec)) return false;
  return !profileSpec.includes(pluginVersion);
}

/**
 * @returns {void} Resets the memoized identity. Test-only.
 */
export function resetIdentityCache() {
  cached = null;
}
