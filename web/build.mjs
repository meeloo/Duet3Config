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

import * as esbuild from 'esbuild';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch') || process.argv.includes('--serve');
const serve = process.argv.includes('--serve');
const prod = !watch;

mkdirSync('dist', { recursive: true });

/** Copy public/ verbatim, then gzip every text asset for the Duet. */
function emitStatic() {
  cpSync('public', 'dist', { recursive: true });
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
  entryPoints: ['src/main.ts'],
  outfile: 'dist/cnc.js',
  bundle: true,
  format: 'esm',
  target: ['es2022'],
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
