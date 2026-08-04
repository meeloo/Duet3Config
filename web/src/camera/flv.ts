// Live video, over HTTP-FLV.
//
// This is the same H.264 the Reolink app plays, and it is worth being precise
// about why it is reachable when RTSP and RTMP are not. All three carry the
// same stream; the difference is the transport. RTSP and RTMP are their own
// TCP protocols on their own ports, and a browser cannot open a TCP socket —
// there is no API for it and never has been. HTTP-FLV is that same RTMP
// stream handed back over an ordinary HTTP response, which a page *can*
// fetch. Hence the `port=1935&app=bcs` in the URL: it is asking the camera's
// HTTP server to proxy its own RTMP.
//
// What a browser still cannot do is decode FLV. So the bytes are demuxed in
// JavaScript and fed to Media Source Extensions as fragmented MP4, which is
// what mpegts.js is for.
//
// The catch, and the reason none of this is assumed to work: **this is a
// fetch**, so unlike the <img> the snapshots use, it is subject to CORS. A
// camera that sends no Access-Control-Allow-Origin cannot be played from a
// page served by the Duet, however capable the camera is. That is not
// knowable in advance, so it is not guessed at — video is attempted, and
// whatever happens decides the answer.

import { normaliseCameraUrl, type CameraConfig, type CameraCredentials } from './types.js';

/** Minimal shape of what the lazily-loaded bundle provides. */
interface MpegtsPlayer {
  attachMediaElement(el: HTMLMediaElement): void;
  load(): void;
  play(): Promise<void> | void;
  destroy(): void;
  unload(): void;
  detachMediaElement(): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
  get buffered(): TimeRanges;
}

interface MpegtsModule {
  isSupported(): boolean;
  createPlayer(source: Record<string, unknown>, config?: Record<string, unknown>): MpegtsPlayer;
  Events: Record<string, string>;
}

/**
 * Can this browser play video at all?
 *
 * Media Source Extensions is the whole requirement, and it is exactly what an
 * iPad on iOS 12 does not have. Checked before anything is downloaded, so that
 * device never pays for a player it cannot use.
 */
export function videoSupported(): boolean {
  return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function';
}

let loader: Promise<MpegtsModule> | null = null;

/**
 * Fetch the player bundle, once.
 *
 * The URL is built at runtime rather than written as a literal so the bundler
 * leaves the import alone — a static specifier would be resolved and inlined,
 * which is the opposite of the point.
 */
async function loadPlayer(): Promise<MpegtsModule> {
  if (!loader) {
    const url = new URL('flv-entry.js', document.baseURI).href;
    loader = import(/* @vite-ignore */ url)
      .then((mod: { default?: MpegtsModule } & MpegtsModule) => mod.default ?? mod)
      .catch((err: Error) => {
        loader = null; // let a later attempt retry
        throw new Error(`could not load the video player: ${err.message}`);
      });
  }
  return loader;
}

/**
 * Reolink's HTTP-FLV URL.
 *
 * `port=1935&app=bcs` is not decoration — it names the RTMP endpoint the
 * camera's HTTP server is being asked to relay.
 */
export function flvUrl(config: CameraConfig, creds: CameraCredentials): string {
  const base = normaliseCameraUrl(config.url);
  const stream = `channel${config.channel}_${config.quality === 'sub' ? 'sub' : 'main'}.bcs`;
  const u = new URL(`${base}/flv`);
  u.searchParams.set('port', '1935');
  u.searchParams.set('app', 'bcs');
  u.searchParams.set('stream', stream);
  u.searchParams.set('user', creds.user);
  u.searchParams.set('password', creds.password);
  return u.toString();
}

export interface VideoSession {
  stop(): void;
}

export interface VideoHandlers {
  /** Called once, when frames are genuinely arriving. */
  onPlaying: () => void;
  /** Called on any failure, including one after playback has started. */
  onError: (message: string) => void;
}

/**
 * The player's error categories, in terms of what to do about them.
 *
 * mpegts reports "NetworkError" and "MediaError", which are accurate and
 * useless: both of them mean "no picture" to anyone reading the panel. The
 * distinction that matters is whether the camera could be reached at all,
 * because that is the difference between a wrong address, a stream this page
 * is not allowed to read, and a codec the browser cannot decode.
 */
function explain(type: string, detail: string): string {
  if (/network/i.test(type)) {
    return (
      'the video stream could not be fetched. Unlike the snapshots, this is a ' +
      'normal request, so the camera has to allow this page to read it — a camera ' +
      'that sends no CORS headers can only be watched as stills from another origin.'
    );
  }
  if (/media/i.test(type)) {
    return (
      'the stream arrived but could not be decoded, which usually means the camera ' +
      'is set to H.265. HTTP-FLV carries H.264; switch the stream to H.264 in the ' +
      'camera settings to use video.'
    );
  }
  return detail ? `${type}: ${detail}` : type;
}

/** How long to wait for a first frame before calling it a failure. */
const FIRST_FRAME_TIMEOUT_MS = 9000;

/**
 * Start playing, and report which way it went.
 *
 * Deliberately reports success only on actual playback rather than on the
 * player accepting the URL: a CORS refusal, a 404 and an H.265 stream all look
 * like a fine start and produce no picture, and the caller's decision to fall
 * back to snapshots has to be driven by frames, not by optimism.
 */
export async function playVideo(
  video: HTMLVideoElement,
  url: string,
  handlers: VideoHandlers,
): Promise<VideoSession> {
  const mpegts = await loadPlayer();
  if (!mpegts.isSupported()) throw new Error('this browser cannot play video streams');

  const player = mpegts.createPlayer(
    { type: 'flv', url, isLive: true, hasAudio: false },
    {
      // A live camera view that is thirty seconds behind is not a camera view.
      // The stash buffer trades latency for smoothness, which is the wrong way
      // round here; the latency chaser drops the difference when it drifts.
      enableStashBuffer: false,
      stashInitialSize: 128,
      liveBufferLatencyChasing: true,
      liveBufferLatencyMaxLatency: 1.5,
      liveBufferLatencyMinRemain: 0.3,
      lazyLoad: false,
    },
  );

  let settled = false;
  let timer: number | null = null;

  const finish = (ok: boolean, message = ''): void => {
    if (settled) return;
    settled = true;
    if (timer != null) clearTimeout(timer);
    if (ok) handlers.onPlaying();
    else handlers.onError(message);
  };

  const stop = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = null;
    settled = true;
    // In this order, and each step on its own. Going straight to destroy()
    // while a load is in flight leaves mpegts emitting into a torn-down
    // player, which surfaces as "cannot read properties of null" from inside
    // the library — noise from our teardown, not from anything the camera did.
    for (const step of [
      () => player.unload(),
      () => player.detachMediaElement(),
      () => player.destroy(),
    ]) {
      try {
        step();
      } catch {
        // Already gone, or never fully started.
      }
    }
  };

  player.on(mpegts.Events.ERROR, (type: unknown, detail: unknown) => {
    const text = explain(String(type), String(detail ?? ''));
    if (settled) {
      // A stream that dies after it started is still a failure the caller
      // needs to hear about, so it can go back to stills.
      handlers.onError(text);
      return;
    }
    finish(false, text);
  });

  video.addEventListener('playing', () => finish(true), { once: true });

  timer = window.setTimeout(() => {
    finish(
      false,
      'no video arrived. The camera may not offer HTTP-FLV, may be set to H.265, ' +
        'or may not allow this page to read its stream.',
    );
  }, FIRST_FRAME_TIMEOUT_MS);

  player.attachMediaElement(video);
  player.load();
  try {
    await player.play();
  } catch (err) {
    // Autoplay refusal is not fatal on a muted element, but report anything
    // else rather than sitting on a black rectangle.
    if (!settled) finish(false, (err as Error).message);
  }

  return { stop };
}
