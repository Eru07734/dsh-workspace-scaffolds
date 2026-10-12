/**
 * Regenerate `locale/zh.json` and `locale/en.json` from the shipped client
 * bundle.
 *
 * The generated files are what the host loads, while `client.js` holds the
 * source of truth, so they can drift silently. Rather than parsing the source
 * as text - which is easy to get wrong and fails quietly - this evaluates the
 * real bundle and captures what it registers with the locale service, so the
 * output cannot disagree with what the browser actually runs.
 *
 * Usage: node scripts/locales.mjs [--check]
 *   --check exits non-zero when the files on disk differ from what would be generated.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Load the client bundle and capture the locales it registers. */
export async function extractLocales() {
  const source = await readFile(join(root, 'client.js'), 'utf8');
  let descriptor = null;
  const previousWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        descriptor = value;
      },
    },
  };
  try {
    // The bundle is an expression statement that calls `window.__ModuleLoader__.load`
    // with a descriptor holding the factory; evaluating it is enough to capture that.
    new Function('window', source)(globalThis.window);
  } finally {
    globalThis.window = previousWindow;
  }
  if (descriptor === null) throw new Error('client.js did not register itself with the module loader');
  if (typeof descriptor.factory !== 'function') throw new Error('the registered descriptor has no factory');

  // Only what the factory touches at apply time; components are not rendered here.
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: () => null,
  };
  const plugin = descriptor.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`client.js required an unexpected module: ${name}`);
  });

  let registered = null;
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: (_namespace, locales) => {
        registered = locales;
        return () => {};
      },
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: () => () => {},
    },
  };
  plugin.apply(ctx);
  if (registered === null) throw new Error('client.js did not register any locales');
  return registered;
}

/** Stable key order, so regeneration is byte-identical when nothing changed. */
export function ordered(value) {
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return sorted;
}

/** Serialize one language exactly as it is written to disk. */
export function serializeLocale(values) {
  return `${JSON.stringify(ordered(values), null, 2)}\n`;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const locales = await extractLocales();
  const check = process.argv.includes('--check');
  let drifted = false;

  for (const language of ['zh', 'en']) {
    const values = locales[language];
    if (values === undefined) throw new Error(`client.js registers no "${language}" locale`);
    const serialized = serializeLocale(values);
    const target = join(root, 'locale', `${language}.json`);
    const existing = await readFile(target, 'utf8').catch(() => null);
    if (existing === serialized) {
      process.stdout.write(`${language}.json: unchanged (${Object.keys(values).length} keys)\n`);
      continue;
    }
    drifted = true;
    if (check) {
      process.stdout.write(`${language}.json: DIFFERS from the client bundle\n`);
      continue;
    }
    await writeFile(target, serialized);
    process.stdout.write(`${language}.json: written (${Object.keys(values).length} keys)\n`);
  }

  if (check && drifted) {
    process.stderr.write('locale files are out of date; run: node scripts/locales.mjs\n');
    process.exitCode = 1;
  }
}
