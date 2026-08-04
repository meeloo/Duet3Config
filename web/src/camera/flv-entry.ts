// The video player, as its own bundle.
//
// mpegts.js is 270KB of demuxer — larger than the rest of this app's
// dependencies together — and most sessions never open the camera panel at
// all. So it is built as a separate entry and imported at runtime, the first
// time video is actually attempted. The main bundle does not carry it, and a
// browser that cannot play video (no Media Source Extensions, which is every
// iOS before 13) never downloads it.

import mpegts from 'mpegts.js';

export default mpegts;
