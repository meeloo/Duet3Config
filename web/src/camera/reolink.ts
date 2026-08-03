// Reolink's HTTP API.
//
// Everything is POST /cgi-bin/api.cgi with a JSON array of commands, except the
// snapshot, which is a GET that returns a JPEG — and it is the GET that matters
// most here, because it is the only part that works unconditionally from
// another origin (see types.ts).
//
// Request shapes below are taken from the reolink_aio library, which is what
// Home Assistant drives these cameras with, rather than from guesswork:
//
//   PtzCtrl      {"cmd":"PtzCtrl","action":0,"param":{"channel":0,"op":"Left","speed":32}}
//   goto preset  op "ToPos" plus "id": <preset number>
//   SetIrLights  {"cmd":"SetIrLights","action":0,"param":{"IrLights":{"channel":0,"state":"Auto"}}}
//   SetWhiteLed  {"cmd":"SetWhiteLed","param":{"WhiteLed":{"channel":0,"state":1,"bright":100,"mode":1}}}
//   SetPowerLed  {"cmd":"SetPowerLed","action":0,"param":{"PowerLed":{"channel":0,"state":"On"}}}
//   SetIsp       {"cmd":"SetIsp","action":0,"param":{"Isp":{...everything GetIsp returned..., "dayNight":"Auto"}}}
//
// Note the shape of that last one: SetIsp does not take one field, it takes the
// whole ISP block back. Sending a partial block is how you discover that the
// camera has quietly reset its exposure settings. That read-modify-write is why
// day/night is the one control that cannot work blind.
//
// Saving a preset is deliberately absent. Going *to* a preset is verified;
// creating one is not, and a wrong body written to a PTZ camera's stored
// positions is not a good way to find out. Set them in the Reolink app.

import {
  normaliseCameraUrl,
  type CameraConfig,
  type CameraCredentials,
  type CameraControls,
} from './types.js';

export type PtzOp =
  | 'Stop'
  | 'Left'
  | 'Right'
  | 'Up'
  | 'Down'
  | 'LeftUp'
  | 'LeftDown'
  | 'RightUp'
  | 'RightDown'
  | 'ZoomInc'
  | 'ZoomDec'
  | 'Auto';

/** Reolink's own spotlight modes. */
export const SPOTLIGHT_MODES = [
  { value: 0, label: 'Off' },
  { value: 1, label: 'Auto' },
  { value: 2, label: 'On at night' },
  { value: 3, label: 'Schedule' },
] as const;

export const DAY_NIGHT = [
  { value: 'Auto', label: 'Auto' },
  { value: 'Color', label: 'Colour' },
  { value: 'Black&White', label: 'Mono' },
] as const;

interface Command {
  cmd: string;
  action?: number;
  param?: Record<string, unknown>;
}

interface Reply {
  cmd: string;
  code: number;
  value?: Record<string, unknown>;
  error?: { detail?: string; rspCode?: number };
}

function apiUrl(config: CameraConfig, creds: CameraCredentials, params: Record<string, string> = {}): string {
  const base = normaliseCameraUrl(config.url);
  const u = new URL(`${base}/cgi-bin/api.cgi`);
  // Credentials go in the query string rather than a token, because obtaining a
  // token means reading a Login reply — which is exactly what we may not be
  // able to do. Every command accepts user/password directly.
  u.searchParams.set('user', creds.user);
  u.searchParams.set('password', creds.password);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/** A still image, as a URL an <img> can load from any origin. */
export function snapshotUrl(
  config: CameraConfig,
  creds: CameraCredentials,
  cacheBust: number,
): string {
  return apiUrl(config, creds, {
    cmd: 'Snap',
    channel: String(config.channel),
    snapType: config.quality,
    // Without this the browser serves the first frame forever.
    rs: String(cacheBust),
  });
}

/**
 * The RTSP URL, for pasting into VLC or a bridge.
 *
 * Present so it can be shown and copied, never used — nothing in a browser can
 * open it.
 */
export function rtspUrl(config: CameraConfig, creds: CameraCredentials): string {
  const host = normaliseCameraUrl(config.url).replace(/^https?:\/\//, '');
  const stream = config.quality === 'sub' ? 'sub' : 'main';
  return `rtsp://${encodeURIComponent(creds.user)}:${encodeURIComponent(creds.password)}@${host}/h264Preview_${String(config.channel + 1).padStart(2, '0')}_${stream}`;
}

export class ReolinkClient {
  /**
   * Whether this origin can read the camera's replies.
   *
   * Decided once, by probing, and then obeyed — never by trying a readable
   * request and retrying blind on failure. A rejected fetch was still
   * *delivered*, so retrying a PTZ command would move the camera twice.
   */
  readable = false;

  constructor(
    private config: CameraConfig,
    private creds: CameraCredentials,
  ) {}

  /** Send commands. Returns the replies, or null when they cannot be read. */
  async send(commands: Command[]): Promise<Reply[] | null> {
    const url = apiUrl(this.config, this.creds);
    const init: RequestInit = {
      method: 'POST',
      // text/plain keeps the request CORS-simple, so no preflight is issued —
      // a preflight would be answered with nothing useful and the command would
      // never leave the browser. The camera parses the body as JSON regardless.
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(commands),
      cache: 'no-store',
      credentials: 'omit',
    };

    if (!this.readable) {
      // Opaque by request: the command is delivered and obeyed, and the browser
      // is told not to expect an answer, so it does not log a CORS failure for
      // every button press.
      await fetch(url, { ...init, mode: 'no-cors' });
      return null;
    }

    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`camera returned HTTP ${res.status}`);
    const body = (await res.json()) as Reply[];
    return Array.isArray(body) ? body : [body];
  }

  /**
   * Ask the camera what it is, and find out whether it answers at all.
   *
   * Only ever called with `readable` true — the caller flips it back to false
   * when this throws, which is the signal that we are in blind mode.
   */
  async identify(): Promise<{ model: string; firmware: string; name: string }> {
    const replies = await this.send([{ cmd: 'GetDevInfo', action: 0, param: {} }]);
    const info = replies?.[0];
    if (!info || info.code !== 0) throw new Error('camera did not accept GetDevInfo');
    const dev = (info.value?.DevInfo ?? {}) as Record<string, unknown>;
    return {
      model: String(dev.model ?? 'Reolink'),
      firmware: String(dev.firmVer ?? ''),
      name: String(dev.name ?? ''),
    };
  }

  /**
   * Which controls this camera actually has.
   *
   * Established by asking for each setting and seeing which ones come back with
   * code 0, rather than by parsing GetAbility — the ability tree is large,
   * differs between firmware generations, and this answers the only question
   * that matters ("will the setter work?") more directly.
   */
  async detectControls(): Promise<CameraControls> {
    const channel = this.config.channel;
    const probes: Array<[keyof CameraControls, string]> = [
      ['irLights', 'GetIrLights'],
      ['spotlight', 'GetWhiteLed'],
      ['dayNight', 'GetIsp'],
      ['statusLed', 'GetPowerLed'],
      ['presets', 'GetPtzPreset'],
    ];
    const replies = await this.send(
      probes.map(([, cmd]) => ({ cmd, action: 0, param: { channel } })),
    );

    const controls: CameraControls = {
      // Pan and zoom have no "get" to probe; PtzCtrl is simply refused by a
      // camera that cannot move, which is harmless.
      pan: true,
      zoom: true,
      presets: false,
      irLights: false,
      spotlight: false,
      dayNight: false,
      statusLed: false,
    };
    if (!replies) return controls;

    for (const [key, cmd] of probes) {
      controls[key] = replies.some((r) => r.cmd === cmd && r.code === 0);
    }
    return controls;
  }

  // --- Motion -------------------------------------------------------------

  async ptz(op: PtzOp, speed: number): Promise<void> {
    await this.send([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op, speed } },
    ]);
  }

  async stop(): Promise<void> {
    await this.send([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op: 'Stop' } },
    ]);
  }

  async goToPreset(id: number): Promise<void> {
    await this.send([
      { cmd: 'PtzCtrl', action: 0, param: { channel: this.config.channel, op: 'ToPos', id, speed: 32 } },
    ]);
  }

  /** Named presets, when readable; empty otherwise. */
  async presets(): Promise<Array<{ id: number; name: string }>> {
    const replies = await this.send([
      { cmd: 'GetPtzPreset', action: 0, param: { channel: this.config.channel } },
    ]);
    const value = replies?.find((r) => r.cmd === 'GetPtzPreset' && r.code === 0)?.value;
    const list = (value?.PtzPreset ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(list)) return [];
    return list
      // enable 0 means the slot exists but has never been set.
      .filter((p) => Number(p.enable) === 1)
      .map((p) => ({ id: Number(p.id), name: String(p.name ?? `Preset ${p.id}`) }));
  }

  // --- Light and image ----------------------------------------------------

  async setIrLights(on: boolean): Promise<void> {
    await this.send([
      {
        cmd: 'SetIrLights',
        action: 0,
        // "Auto" rather than "On": the IR array is driven by the light sensor,
        // and the choice the camera offers is auto-or-never.
        param: { IrLights: { channel: this.config.channel, state: on ? 'Auto' : 'Off' } },
      },
    ]);
  }

  async setSpotlight(mode: number, brightness: number): Promise<void> {
    await this.send([
      {
        cmd: 'SetWhiteLed',
        param: {
          WhiteLed: {
            channel: this.config.channel,
            state: mode === 0 ? 0 : 1,
            mode,
            bright: Math.max(0, Math.min(100, Math.round(brightness))),
          },
        },
      },
    ]);
  }

  async setStatusLed(on: boolean): Promise<void> {
    await this.send([
      {
        cmd: 'SetPowerLed',
        action: 0,
        param: { PowerLed: { channel: this.config.channel, state: on ? 'On' : 'KeepOff' } },
      },
    ]);
  }

  /**
   * Day/night mode.
   *
   * Read-modify-write, because SetIsp replaces the whole ISP block: send it one
   * field and the camera takes the rest as defaults, quietly undoing exposure
   * and anti-flicker settings. So this needs readable replies, and says so
   * rather than half-working.
   */
  async setDayNight(value: string): Promise<void> {
    if (!this.readable) {
      throw new Error(
        'Day/night needs to read the camera’s current image settings first, which this ' +
          'browser cannot do from a different origin — SetIsp replaces every setting at once.',
      );
    }
    const replies = await this.send([
      { cmd: 'GetIsp', action: 0, param: { channel: this.config.channel } },
    ]);
    const isp = replies?.find((r) => r.cmd === 'GetIsp' && r.code === 0)?.value?.Isp;
    if (!isp || typeof isp !== 'object') throw new Error('could not read the camera’s image settings');

    await this.send([
      { cmd: 'SetIsp', action: 0, param: { Isp: { ...(isp as object), dayNight: value } } },
    ]);
  }

  /** Current settings, for showing real state rather than guesses. */
  async readState(): Promise<{
    ir: boolean | null;
    spotlightMode: number | null;
    spotlightBright: number | null;
    dayNight: string | null;
  }> {
    const channel = this.config.channel;
    const replies = await this.send([
      { cmd: 'GetIrLights', action: 0, param: { channel } },
      { cmd: 'GetWhiteLed', action: 0, param: { channel } },
      { cmd: 'GetIsp', action: 0, param: { channel } },
    ]);
    const pick = (cmd: string, key: string) =>
      replies?.find((r) => r.cmd === cmd && r.code === 0)?.value?.[key] as
        | Record<string, unknown>
        | undefined;

    const ir = pick('GetIrLights', 'IrLights');
    const led = pick('GetWhiteLed', 'WhiteLed');
    const isp = pick('GetIsp', 'Isp');
    return {
      ir: ir ? ir.state === 'Auto' : null,
      spotlightMode: led && led.mode != null ? Number(led.mode) : null,
      spotlightBright: led && led.bright != null ? Number(led.bright) : null,
      dayNight: isp && isp.dayNight != null ? String(isp.dayNight) : null,
    };
  }
}
