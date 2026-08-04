// Watching the machine from the other end of the workshop.
//
// Three browser facts shape everything here, and they are worth stating plainly
// because they are the whole design:
//
//  1. **A browser cannot play RTSP.** Not with a flag, not with a codec — no
//     engine implements it. A camera's RTSP URL is useless to this page. What
//     *is* usable is the still-image endpoint nearly every IP camera also
//     exposes, polled a couple of times a second, and multipart MJPEG where a
//     camera offers it. For real RTSP video the answer is a bridge (go2rtc,
//     MediaMTX) that re-publishes as MJPEG or HLS — whose URL can be pasted in
//     here as a generic camera.
//
//  2. **An <img> is not subject to CORS.** The page can display an image from
//     any origin; it just cannot read its pixels back. So the picture works
//     with no proxy and no cooperation from the camera, which is what makes
//     this feature possible at all from a page served by the Duet.
//
//  3. **A fetch is.** IP cameras do not send Access-Control-Allow-Origin, so
//     from another origin the *reply* to a control command cannot be read —
//     although the request is still delivered, as long as it stays inside the
//     CORS-simple envelope (no custom headers, no application/json). Commands
//     therefore work blind: they are sent and obeyed, and the camera's "yes"
//     is invisible.
//
// That last point is not a detail. Anything that needs to read state — the
// exact model, or a setting that must be read-modified-written back — only
// works when the replies are readable, which means either the page is served
// from the camera or the camera has been put behind something that adds CORS
// headers. Those features are detected and disabled rather than offered and
// silently broken.

export type CameraKind = 'reolink' | 'generic';

export interface CameraConfig {
  /** 'auto' asks the detector; the others force it. */
  kind: CameraKind | 'auto';
  /** Base URL of the camera, e.g. http://192.168.1.40 */
  url: string;
  /** Reolink channel; 0 on a standalone camera. */
  channel: number;
  /** Generic cameras: the exact image or stream URL to show. */
  imageUrl: string;
  /**
   * True for a multipart MJPEG endpoint, which the browser streams from a
   * single unchanging <img>. False polls stills instead.
   */
  stream: boolean;
  /** Stills per second when polling; 0 means as fast as the camera manages. */
  fps: number;
  /** Reolink substream is a fraction of the size — 4K stills at 2fps are not. */
  quality: 'sub' | 'main';
}

/** Kept out of the settings shared with the machine. */
export interface CameraCredentials {
  user: string;
  password: string;
}

export function defaultCameraConfig(): CameraConfig {
  // 10 rather than 2: with pipelined requests this is a rate a camera on the
  // same LAN can actually hold, and 2 is a slideshow.
  return { kind: 'auto', url: '', channel: 0, imageUrl: '', stream: false, fps: 10, quality: 'sub' };
}

export function defaultCredentials(): CameraCredentials {
  return { user: 'admin', password: '' };
}

/** What this camera lets us do, as far as could be established. */
export interface CameraControls {
  pan: boolean;
  zoom: boolean;
  presets: boolean;
  irLights: boolean;
  spotlight: boolean;
  /** Needs the current ISP block read back before it can be written. */
  dayNight: boolean;
  statusLed: boolean;
}

export const NO_CONTROLS: CameraControls = {
  pan: false,
  zoom: false,
  presets: false,
  irLights: false,
  spotlight: false,
  dayNight: false,
  statusLed: false,
};

export interface CameraProbe {
  kind: CameraKind;
  /** Only knowable when replies are readable. */
  model: string | null;
  firmware: string | null;
  name: string | null;
  /** False when the camera's answers are invisible to this origin. */
  readable: boolean;
  controls: CameraControls;
  /** What the operator needs to know about the mode we ended up in. */
  note: string | null;
}

export class CameraError extends Error {}

/** Trim a trailing slash so URL building never doubles up. */
export function normaliseCameraUrl(url: string): string {
  let u = url.trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}
