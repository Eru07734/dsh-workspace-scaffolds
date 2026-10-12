/**
 * Fixed failure vocabulary shared by the host operations, the HTTP surface and
 * the agent tool. Every rejection the caller can act on carries one of these
 * codes, so the UI and the tool never have to parse prose.
 * @module dsh-workspace-scaffolds/errors
 */

/** Enumerated failure codes. Keep this list in sync with README and locale files. */
export const CODES = {
  invalidRequest: 'invalid-request',
  workspaceNotFound: 'workspace-not-found',
  workspaceUnavailable: 'workspace-unavailable',
  revisionConflict: 'revision-conflict',
  operationIdReused: 'operation-id-reused',
  packageContentConflict: 'package-content-conflict',
  versionConflict: 'version-conflict',
  dependencyMissing: 'dependency-missing',
  dependencyCycle: 'dependency-cycle',
  protectedBundle: 'protected-bundle',
  restartRequired: 'restart-required',
  nativeOverridden: 'native-overridden',
  nativeOperationFailed: 'native-operation-failed',
  templateConflict: 'template-conflict',
  previewExpired: 'preview-expired',
  previewStale: 'preview-stale',
  pathOutsideWorkspace: 'path-outside-workspace',
  archiveInUse: 'archive-in-use',
  stateCorrupt: 'state-corrupt',
  unsupportedHost: 'unsupported-host',
  notABundle: 'not-a-bundle',
  packageUnknown: 'package-unknown',
  scaffoldInvalid: 'scaffold-invalid',
  archiveInvalid: 'archive-invalid',
};

/**
 * The single error type crossing every internal boundary.
 * `code` is a stable contract; `details` stays JSON-serializable.
 */
export class Fault extends Error {
  /**
   * @param {string} code One {@link CODES} value.
   * @param {object} [details] Extra machine-readable context.
   * @param {string} [message] Human-facing detail; never replaces `code`.
   */
  constructor(code, details = {}, message = code) {
    super(message);
    this.name = 'Fault';
    this.code = code;
    this.details = details;
  }
}

/**
 * HTTP status for a failure. Revision, identity and lifecycle conflicts are
 * 409 because the caller can retry after re-reading state; malformed input is
 * 400; everything else is an operation failure.
 * @param {unknown} error
 * @returns {number}
 */
export function statusOf(error) {
  if (!(error instanceof Fault)) return 500;
  switch (error.code) {
    case CODES.invalidRequest:
    case CODES.scaffoldInvalid:
    case CODES.archiveInvalid:
      return 400;
    case CODES.workspaceNotFound:
    case CODES.packageUnknown:
      return 404;
    case CODES.revisionConflict:
    case CODES.operationIdReused:
    case CODES.packageContentConflict:
    case CODES.versionConflict:
    case CODES.templateConflict:
    case CODES.previewExpired:
    case CODES.previewStale:
    case CODES.archiveInUse:
    case CODES.restartRequired:
    case CODES.nativeOverridden:
    case CODES.protectedBundle:
    case CODES.stateCorrupt:
      return 409;
    default:
      return 500;
  }
}

/**
 * Wire representation of a failure. Diagnostics are cleaned: only the message
 * of an unexpected error is exposed, never a stack or a raw native object.
 * @param {unknown} error
 * @returns {{ok: false, code: string, details: object}}
 */
export function toWireError(error) {
  if (error instanceof Fault) return { ok: false, code: error.code, details: error.details };
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, code: CODES.nativeOperationFailed, details: { message } };
}
