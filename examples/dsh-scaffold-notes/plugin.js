/**
 * A scaffold package that contributes no tools of its own: its value is the
 * template set it ships. Mounting it proves the bundle is live and lets a
 * workspace pin the version it was scaffolded with.
 * @module dsh-scaffold-notes
 */
export const name = 'scaffold-notes';

/**
 * @param {object} ctx
 * @returns {void}
 */
export function apply(ctx) {
  ctx.logger?.debug?.('scaffold-notes: template bundle loaded');
}
