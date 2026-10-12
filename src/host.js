/**
 * The only module that talks to DSH services. Everything above it works against
 * this narrow surface, which keeps the decision logic unit-testable with a fake
 * host and confines every native-interface assumption to one file.
 * @module dsh-workspace-scaffolds/host
 */
import { join } from 'node:path';
import { Fault, CODES } from './errors.js';
import { canonicalize } from './util.js';

/** Directory name this plugin owns inside the active profile directory. */
export const STORAGE_DIRNAME = 'workspace-scaffolds';

/**
 * Wrap the running context in the operations this plugin needs.
 * @param {object} ctx The Cordis context the plugin was applied to.
 * @returns {object} The host surface consumed by store, coordinator and lifecycle code.
 */
export function createHost(ctx) {
  const profileContext = ctx.get('profileContext');
  if (profileContext === undefined || typeof profileContext.dir !== 'string') {
    throw new Fault(CODES.unsupportedHost, { reason: 'profileContext-unavailable' });
  }
  // Services are looked up on every call rather than captured here: a peer that
  // mounts after this plugin must still be usable, and one that is absent has to
  // surface as a capability flag instead of a load-time crash.
  const manager = () => ctx.get('pluginManager');
  const registry = () => ctx.get('workspaceRegistry');
  const agents = () => ctx.get('agents');
  const logger = ctx.logger ?? console;

  return {
    profileDir: profileContext.dir,
    profileName: typeof profileContext.name === 'string' ? profileContext.name : null,
    storageDir: join(profileContext.dir, STORAGE_DIRNAME),
    logger,

    /** @returns {boolean} Whether the native plugin manager is reachable. */
    hasPluginManager: () => manager() !== undefined,
    /** @returns {boolean} Whether the native workspace registry is reachable. */
    hasWorkspaceRegistry: () => registry() !== undefined,

    /**
     * @returns {Array<{workspaceId: string, path: string, title: string}>} Registered workspaces.
     */
    listWorkspaces() {
      const service = registry();
      if (service === undefined) return [];
      return service.list().map((entity) => ({
        workspaceId: String(entity.id),
        path: String(entity.path),
        title: typeof entity.title === 'string' ? entity.title : '',
      }));
    },

    /**
     * @param {string} workspaceId
     * @returns {{workspaceId: string, path: string, title: string}|null}
     */
    getWorkspace(workspaceId) {
      const service = registry();
      if (service === undefined) return null;
      const entity = service.get(workspaceId);
      if (entity === undefined) return null;
      return {
        workspaceId: String(entity.id),
        path: String(entity.path),
        title: typeof entity.title === 'string' ? entity.title : '',
      };
    },

    /**
     * Register an existing directory as a workspace.
     * @param {string} path
     * @param {string} [title]
     * @returns {Promise<{workspaceId: string, path: string, title: string}>}
     */
    async createWorkspace(path, title) {
      const service = registry();
      if (service === undefined) throw new Fault(CODES.unsupportedHost, { reason: 'workspaceRegistry-unavailable' });
      const entity = await service.create(path, title);
      return {
        workspaceId: String(entity.id),
        path: String(entity.path),
        title: typeof entity.title === 'string' ? entity.title : '',
      };
    },

    /** @param {string} path @returns {Promise<string>} */
    canonicalize,

    /**
     * Locate an installed package inside the profile's node_modules. The package
     * manager's symlink layout is followed by the filesystem, so this works for
     * both hoisted and isolated installations.
     * @param {string} name Package name.
     * @returns {string} Absolute candidate directory.
     */
    packageDir(name) {
      return join(profileContext.dir, 'node_modules', ...name.split('/'));
    },

    /**
     * @returns {Promise<Array<object>>} Native bundle rows.
     */
    async listBundles() {
      const service = manager();
      if (service === undefined) throw new Fault(CODES.unsupportedHost, { reason: 'pluginManager-unavailable' });
      return await service.listBundles();
    },

    /**
     * Enable or disable one bundle without removing its installation.
     * @param {string} name Package name.
     * @param {boolean} enabled
     * @returns {Promise<{application?: string, warnings?: unknown, error?: unknown, changed?: boolean}>}
     */
    async setBundleEnabled(name, enabled) {
      const service = manager();
      if (service === undefined) throw new Fault(CODES.unsupportedHost, { reason: 'pluginManager-unavailable' });
      return await service.setBundleEnabled(name, enabled);
    },

    /**
     * Install one package spec without enabling it, so enablement stays a
     * separate, reportable step.
     * @param {string} spec
     * @param {{requestId?: string}} [options]
     * @returns {Promise<object>}
     */
    async installBundle(spec, options = {}) {
      const service = manager();
      if (service === undefined) throw new Fault(CODES.unsupportedHost, { reason: 'pluginManager-unavailable' });
      return await service.installBundle(spec, { ...options, enabled: false });
    },

    /** @returns {Array<object>} Live agents. */
    listAgents() {
      const service = agents();
      if (service === undefined) return [];
      return service.list();
    },

    /**
     * @param {object} agent
     * @returns {'idle'|'running'|'unknown'} The agent's own status when readable.
     */
    agentStatus(agent) {
      const status = agent?.status;
      return status === 'idle' || status === 'running' ? status : 'unknown';
    },
  };
}
