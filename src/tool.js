/**
 * The agent-facing tool. It is a thin adapter over {@link Operations.execute}:
 * all rules live in the operations layer so the tool and the panel cannot
 * disagree about what an action does.
 * @module dsh-workspace-scaffolds/tool
 */
import { Fault, CODES } from './errors.js';
import { ACTIONS, READ_ACTIONS, WRITE_ACTIONS } from './operations.js';
import { newId } from './util.js';

export const TOOL_NAME = 'workspace_scaffolds';

const DESCRIPTION = [
  'Associate DSH workspaces with scaffold plugin bundles, so a workspace can prepare, restore, and shelve them.',
  'start-before-work: import or bind packages, preview templates, apply them, then wake the workspace.',
  'during-work: bind and wake add capabilities for the NEXT model request; tools already sent to the model are unchanged.',
  'shelve: sleep releases bundles the workspace uniquely held; the package stays installed on disk and the workspace files are never touched.',
  'Read `list` first: every write action needs its `revision` as expectedRevision and a fresh UUID operationId.',
  'Native bundles are shared by the whole DSH profile, so a bundle another workspace still holds stays enabled.',
  'Template generation is a separate, explicit step: bind alone never writes files.',
].join(' ');

const parameters = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: [...ACTIONS].sort() },
    workspaceId: { description: 'Target workspace id. Omit to use the calling session\'s own workspace.' },
    expectedRevision: { type: 'integer', description: 'Required for write actions; the revision returned by `list`.' },
    operationId: { type: 'string', description: 'Required for write actions; a fresh UUID. Reusing it with identical arguments replays the recorded result instead of repeating the work. For progress, pass one to report only that operation.' },
    path: { description: 'For import: absolute path to a scaffold package directory or .tgz file. For workspace-register: absolute path to the project directory to bring under management.' },
    title: { type: 'string', description: 'For workspace-register: display name for the project; defaults to the native registry title.' },
    install: { description: 'For import/wake: whether the native package manager may install the stored snapshot. Defaults to true.' },
    packageName: { type: 'string' },
    version: { type: 'string' },
    archiveSha256: { description: 'Optional stored snapshot hash to pin the association to.' },
    bindingId: { type: 'string' },
    enabled: { type: 'boolean' },
    required: { type: 'boolean' },
    autoRestore: { type: 'boolean' },
    packageKey: { description: 'Warehouse key in the form name@version.' },
    pinned: { type: 'boolean', description: 'Keep a package enabled even when no awake workspace needs it.' },
    ownership: { type: 'string', enum: ['managed', 'external'] },
    templateId: { type: 'string' },
    templateValues: { type: 'object', additionalProperties: true },
    values: { type: 'object', additionalProperties: true },
    previewId: { type: 'string' },
    background: {
      type: 'boolean',
      description:
        'For import/wake/sleep/template-apply: return as soon as the work starts instead of waiting for it, then follow it with action=progress. Useful when the call would otherwise run long enough to time out.',
    },
  },
  required: ['action'],
};

/**
 * Resolve the workspace a call targets, from an explicit id or the calling
 * session's own directory.
 * @param {object} operations
 * @param {object} args
 * @param {object} exec
 * @returns {Promise<string|null>}
 */
async function resolveWorkspaceId(operations, args, exec) {
  if (typeof args.workspaceId === 'string' && args.workspaceId.length > 0) return args.workspaceId;
  const cwd = exec?.agent?.session?.header?.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  return await operations.workspaceIdForPath(cwd);
}

/**
 * Register the tool on the plugin context.
 * @param {object} ctx
 * @param {import('./operations.js').Operations} operations
 * @returns {void}
 */
export function registerTool(ctx, operations) {
  ctx.tools.register({
    name: TOOL_NAME,
    description: DESCRIPTION,
    parameters,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, value: {}, code: { type: 'string' }, details: { type: 'object', additionalProperties: true } },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const request = { ...args };
        if (WRITE_ACTIONS.has(request.action)) {
          if (typeof request.operationId !== 'string' || request.operationId.length === 0) {
            request.operationId = newId();
          }
          if (!Number.isInteger(request.expectedRevision)) {
            throw new Fault(CODES.invalidRequest, {
              field: 'expectedRevision',
              reason: 'write-actions-require-the-revision-returned-by-list',
            });
          }
        }
        if (!READ_ACTIONS.has(request.action) || request.action === 'list') {
          const needsWorkspace = ['bind', 'unbind', 'update-binding', 'wake', 'sleep', 'template-preview', 'template-apply'];
          if (needsWorkspace.includes(request.action) && (request.workspaceId === undefined || request.workspaceId === '')) {
            const resolved = await resolveWorkspaceId(operations, args, exec);
            if (resolved === null) {
              throw new Fault(CODES.workspaceNotFound, { reason: 'no-workspace-for-session-cwd' });
            }
            request.workspaceId = resolved;
          }
        }
        const value = await operations.execute(request);
        return {
          ok: true,
          value: request.action === 'list' ? summarizeList(value) : value,
          resolvedWorkspaceId: request.workspaceId ?? null,
        };
      } catch (error) {
        if (error instanceof Fault) return { ok: false, code: error.code, details: error.details };
        return { ok: false, code: CODES.nativeOperationFailed, details: { message: error instanceof Error ? error.message : String(error) } };
      }
    },
  });
}

/**
 * Keep the list payload small enough for a tool result while preserving the
 * facts a caller needs to act: ids, revisions and statuses.
 * @param {object} snapshot
 * @returns {object}
 */
function summarizeList(snapshot) {
  return {
    revision: snapshot.revision,
    // Which build is answering, and what the profile asks for. These disagree
    // while a package update sits on disk but the process still holds old code.
    pluginVersion: snapshot.pluginVersion,
    profileSpec: snapshot.profileSpec,
    restartPending: snapshot.restartPending,
    automaticRestore: snapshot.automaticRestore,
    runningAgents: snapshot.runningAgents,
    pendingSleeps: snapshot.pendingSleeps,
    capabilities: snapshot.capabilities,
    workspaces: snapshot.workspaces,
    unmanagedWorkspaces: snapshot.unmanagedWorkspaces,
    packages: snapshot.packages,
  };
}
