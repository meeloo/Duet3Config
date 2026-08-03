// Build script. Single dependency: esbuild (one static binary, no transitive tree).
//
//   node build.mjs              -> production bundle in dist/
//   node build.mjs --watch      -> rebuild on change
//   node build.mjs --serve      -> dev server on :8080 (implies --watch)
//
// Production output is written twice: `cnc.js` and `cnc.js.gz`. The Duet's web
// server prefers a `.gz` sibling when the client sends Accept-Encoding: gzip,
// which is how DWC's own bundles are shipped. Serving the gzipped copy matters
// because the board reads it off the SD card single-threaded.

import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');
const prod = !watch;

// Everything is relative to this file, not to wherever the build was invoked
// from, so `node web/build.mjs` from the repo root behaves the same as
// `npm run build` inside web/.
const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

const require = createRequire(import.meta.url);

/**
 * Locate a file inside an installed dependency.
 *
 * Resolved through the package's own entry rather than by assuming
 * `node_modules/<name>/...`, which breaks under pnpm, workspaces, and hoisting.
 * A missing dependency reports what to do instead of an ENOENT stack trace —
 * `git pull` brings in a new dependency but does not install it, and that is
 * exactly when this fires.
 */
function depFile(pkg, relative) {
  let base;
  try {
    base = dirname(require.resolve(`${pkg}/package.json`));
  } catch {
    fail(`dependency "${pkg}" is not installed`);
  }
  const path = join(base, relative);
  if (!existsSync(path)) {
    fail(`"${pkg}" is installed but ${relative} is missing (unexpected version?)`);
  }
  return path;
}

function fail(message) {
  console.error(`\n[build] ${message}`);
  console.error(`[build] run \`npm install\` in ${root} and try again\n`);
  process.exit(1);
}

if (!existsSync(resolve(root, 'node_modules'))) {
  fail('node_modules is missing');
}

/**
 * Check every declared dependency before esbuild gets a chance to.
 *
 * Guarding only the packages this script itself opens is not enough: a
 * dependency imported by `src/` fails inside the bundler, as a resolution error
 * with a stack trace and no mention of npm. Reading the manifest means a package
 * added later is covered without anyone remembering to add it here — which is
 * the whole failure mode, since `git pull` brings in a new dependency but never
 * installs it.
 */
function checkDependencies() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  const missing = declared.filter((pkg) => {
    try {
      require.resolve(`${pkg}/package.json`);
      return false;
    } catch {
      // Some packages don't export their package.json; fall back to the entry.
      try {
        require.resolve(pkg);
        return false;
      } catch {
        return true;
      }
    }
  });
  if (missing.length) {
    fail(`not installed: ${missing.join(', ')}`);
  }
}

checkDependencies();

// Imported dynamically so a missing install is reported by fail() above rather
// than as an ERR_MODULE_NOT_FOUND stack trace before any of it runs.
const esbuild = await import('esbuild');

mkdirSync('dist', { recursive: true });

/** Copy public/ verbatim, then gzip every text asset for the Duet. */
function emitStatic() {
  cpSync('public', 'dist', { recursive: true });
  // dockview ships its own stylesheet; serve it beside ours rather than
  // inlining it, so it caches separately and stays easy to diff on upgrade.
  cpSync(depFile('dockview-core', 'dist/styles/dockview.css'), 'dist/dockview.css');
}

/** Write .gz siblings for anything the Duet will serve compressed. */
function gzipDist() {
  const compressible = /\.(js|css|html|svg|json|map)$/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (compressible.test(p) && !p.endsWith('.gz')) {
        writeFileSync(p + '.gz', gzipSync(readFileSync(p), { level: 9 }));
      }
    }
  };
  walk('dist');
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  // The parser worker is a separate entry: it is loaded by URL at runtime, so
  // it must exist as its own file rather than being inlined into the bundle.
  entryPoints: { cnc: 'src/main.ts', 'parse-worker': 'src/viewer/parse-worker.ts' },
  outdir: 'dist',
  // esbuild captures process.cwd() when its module is loaded, which is before
  // the chdir above — so the paths in this object need the root spelled out.
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  // Safari 12 is the floor because an iPad mini 2 cannot go past iOS 12, and a
  // superseded tablet propped next to the machine is a good use for it. Nothing
  // subtle happens when the target is too high: the bundle uses syntax the
  // engine cannot parse, the module is rejected whole, and the page is blank.
  target: ['es2019', 'safari12'],
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  loader: { '.css': 'text', '.glsl': 'text' },
  define: { 'process.env.NODE_ENV': prod ? '"production"' : '"development"' },
};

emitStatic();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[build] watching…');
  if (serve) {
    const { host, port } = await ctx.serve({ servedir: 'dist', port: 8080 });
    console.log(`[build] dev server → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log('[build] point the UI at your controller via the connect bar (CORS is enabled by M586 C"*")');
  }
} else {
  await esbuild.build(options);
  gzipDist();
  console.log('[build] wrote dist/ (with .gz siblings)');
}
