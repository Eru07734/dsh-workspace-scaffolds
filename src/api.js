/**
 * Authenticated HTTP surface. Routes register through the host's own connection
 * service, so the plugin never opens a port of its own.
 * @module dsh-workspace-scaffolds/api
 */
import { Fault, CODES, statusOf, toWireError } from './errors.js';

/** Base path of every route this plugin owns. */
export const API_PREFIX = '/api/workspace-scaffolds';

/** Largest accepted request body. */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * @param {any} value
 * @param {number} status
 * @returns {Response}
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/**
 * Register the plugin's routes on the host connection service.
 * @param {object} ctx
 * @param {import('./operations.js').Operations} operations
 * @returns {void}
 */
export function mountHttp(ctx, operations) {
  const register = (path, methods, handler, label) => {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: API_PREFIX + path,
          methods,
          requestBody: 'buffered',
          async fetch(request) {
            try {
              return json({ ok: true, value: await handler(request) });
            } catch (error) {
              return json(toWireError(error), statusOf(error));
            }
          },
        }),
      `workspace-scaffolds ${label}`,
    );
  };

  register('/state', ['GET'], async () => await operations.execute({ action: 'list' }), 'state');

  register(
    '/execute',
    ['POST'],
    async (request) => {
      const text = await request.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
        throw new Fault(CODES.invalidRequest, { reason: 'body-too-large', limit: MAX_BODY_BYTES });
      }
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Fault(CODES.invalidRequest, { reason: 'body-not-json' });
      }
      return await operations.execute(body);
    },
    'execute',
  );
}
