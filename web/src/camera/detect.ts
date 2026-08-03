// Working out what is at the other end, with one hand tied behind our back.
//
// Three outcomes, in descending order of how much we get to know:
//
//  1. **Readable.** The camera's replies come back — the page is served from
//     the camera, or something in front of it adds CORS headers. We get the
//     model, the firmware, and an exact list of which controls exist.
//
//  2. **Blind.** Replies are invisible, but a still image loads. That single
//     fact proves rather a lot: the address is right, the credentials are
//     right, and it is answering Reolink's snapshot API — so it is a Reolink,
//     and control commands will be delivered even though the acknowledgements
//     are not. Everything except day/night is offered.
//
//  3. **Nothing.** No image. Wrong address, wrong password, camera off, or not
//     a Reolink at all.
//
// The image probe in (2) is the interesting one. An <img> that loads is the
// only signal a cross-origin page can get from a camera that ignores CORS, and
// it happens to be a signal that answers the question completely.

import { ReolinkClient, snapshotUrl } from './reolink.js';
import {
  NO_CONTROLS,
  normaliseCameraUrl,
  type CameraConfig,
  type CameraCredentials,
  type CameraProbe,
} from './types.js';

/** Long enough for a 4K sensor to wake up and produce a frame. */
const IMAGE_PROBE_MS = 8000;

/**
 * Can this URL be loaded as an image?
 *
 * Resolves true/false rather than throwing, because "no" is an ordinary answer
 * here and the browser gives no detail either way — an <img> error event says
 * nothing about whether it was DNS, a refusal, or a 401.
 */
export function imageLoads(url: string, timeoutMs = IMAGE_PROBE_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      // Stop a slow response still arriving after we have given up.
      img.src = '';
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    img.onload = () => finish(img.naturalWidth > 0);
    img.onerror = () => finish(false);
    img.src = url;
  });
}

export async function detectCamera(
  config: CameraConfig,
  creds: CameraCredentials,
): Promise<CameraProbe> {
  if (config.kind === 'generic') {
    const url = config.imageUrl.trim();
    if (!url) throw new Error('Enter the image or stream URL for this camera.');
    // A multipart MJPEG stream never fires load until the first part arrives,
    // which is the same signal, so this covers both.
    const ok = await imageLoads(url);
    if (!ok) {
      throw new Error(
        `Nothing loaded from that URL. If it is an RTSP address, no browser can play it — ` +
          `put a bridge such as go2rtc or MediaMTX in front of the camera and use the ` +
          `MJPEG or snapshot URL it publishes.`,
      );
    }
    return {
      kind: 'generic',
      model: null,
      firmware: null,
      name: null,
      readable: false,
      controls: { ...NO_CONTROLS },
      note: 'Picture only — a plain image URL says nothing about how to control the camera.',
    };
  }

  if (!normaliseCameraUrl(config.url)) throw new Error('Enter the camera’s address.');

  const client = new ReolinkClient(config, creds);

  // 1. Try for real answers.
  client.readable = true;
  try {
    const info = await client.identify();
    const controls = await client.detectControls();
    return {
      kind: 'reolink',
      model: info.model,
      firmware: info.firmware || null,
      name: info.name || null,
      readable: true,
      controls,
      note: null,
    };
  } catch {
    client.readable = false;
  }

  // 2. Fall back to the one thing that always works cross-origin.
  const ok = await imageLoads(snapshotUrl(config, creds, Date.now()));
  if (ok) {
    return {
      kind: 'reolink',
      model: null,
      firmware: null,
      name: null,
      readable: false,
      controls: {
        ...NO_CONTROLS,
        pan: true,
        zoom: true,
        presets: true,
        irLights: true,
        spotlight: true,
        // The only one that genuinely cannot work without reading first.
        dayNight: false,
        statusLed: true,
      },
      note:
        'The camera answers, but not to this page’s origin, so its replies are invisible: ' +
        'controls are sent without confirmation, the model is unknown, and day/night is ' +
        'unavailable because it has to read the current image settings first.',
    };
  }

  if (config.kind === 'auto') {
    throw new Error(
      'No picture from that address. Check the address, user and password, and that HTTP ' +
        'is enabled on the camera. If it is not a Reolink, choose “Other camera” and give ' +
        'the snapshot or MJPEG URL directly.',
    );
  }
  throw new Error(
    'No picture from that address. Check the address, user and password, and that HTTP is ' +
      'enabled on the camera (Settings → Network → Advanced → Port Settings).',
  );
}
