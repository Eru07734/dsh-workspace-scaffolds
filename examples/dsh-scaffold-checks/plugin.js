/**
 * A scaffold package that contributes a working capability: a
 * `project_checklist` tool that reports which conventional project files exist.
 *
 * This is the shape a scaffold should take when its value is *behaviour* rather
 * than files — associating it with a workspace and waking the workspace is what
 * makes the tool available.
 * @module dsh-scaffold-checks
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const name = 'scaffold-checks';
export const inject = ['tools'];

const CONVENTIONS = [
  { path: 'README.md', label: '占位说明 README' },
  { path: 'docs', label: '文档目录' },
  { path: '.gitignore', label: '版本控制忽略文件' },
  { path: 'LICENSE', label: '许可证' },
  { path: 'package.json', label: '包清单（Node 工程）' },
];

/**
 * @param {object} ctx
 * @returns {void}
 */
export function apply(ctx) {
  ctx.tools.register({
    name: 'project_checklist',
    description:
      'Report which conventional project files exist under a directory. Read-only; it never creates or changes files. Use it after scaffolding to confirm what is still missing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Directory to inspect. Defaults to the calling session workspace.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, value: {} }, required: ['ok'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const root = typeof args?.path === 'string' && args.path.length > 0 ? args.path : exec?.agent?.session?.header?.cwd;
      if (typeof root !== 'string' || root.length === 0) {
        return { ok: false, value: { error: 'no-directory' } };
      }
      const present = [];
      const missing = [];
      for (const item of CONVENTIONS) {
        const exists = await stat(join(root, item.path)).then(() => true, () => false);
        (exists ? present : missing).push(item);
      }
      const entries = await readdir(root).then(
        (names) => names.filter((entry) => !entry.startsWith('.')).slice(0, 40),
        () => [],
      );
      return { ok: true, value: { root, present, missing, topLevelEntries: entries } };
    },
  });
}
