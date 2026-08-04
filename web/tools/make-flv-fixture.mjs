// Build the FLV the mock camera serves.
//
//   node tools/make-flv-fixture.mjs
//
// Not committed: it is 800KB of H.264 and reproducible in a second from
// ffmpeg, which anyone testing the video path will have. The mock runs
// happily without it — only the HTTP-FLV endpoint needs it.
//
// It has to be genuine H.264 in a genuine FLV container. The point of the
// video test is that mpegts.js can demux what arrives and hand it to Media
// Source Extensions, and a stub that is not really either proves nothing.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const out = fileURLToPath(new URL('fixtures/test-stream.flv', import.meta.url));
mkdirSync(dirname(out), { recursive: true });

/** ffmpeg from PATH, or the one imageio ships, which is easier to install. */
function ffmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    try {
      return execFileSync('python3', ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'])
        .toString()
        .trim();
    } catch {
      throw new Error('no ffmpeg found — install it, or `pip install imageio-ffmpeg`');
    }
  }
}

execFileSync(
  ffmpeg(),
  [
    '-y',
    '-f', 'lavfi',
    '-i', 'testsrc=size=640x360:rate=15',
    '-t', '30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    // What a camera sends: no B-frames, frequent keyframes, low latency.
    '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-g', '15',
    '-f', 'flv',
    out,
  ],
  { stdio: 'inherit' },
);

console.log(`wrote ${out}${existsSync(out) ? '' : ' (missing?)'}`);
