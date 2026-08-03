// A stand-in Reolink camera.
//
// The camera panel is otherwise untestable without hardware, and the part that
// is easiest to get wrong is not the request bodies — it is the two modes the
// browser puts us in. So this serves the same endpoints twice over:
//
//   node tools/mock-camera.mjs 8090          no CORS headers  → "blind" mode,
//                                            replies unreadable, image still loads
//   node tools/mock-camera.mjs 8091 --cors   CORS headers     → "readable" mode
//
// Running both at once is the point: the same panel code has to work against
// each, and the difference is exactly what a real camera on the LAN does versus
// one behind a proxy that adds the headers.
//
// Frames are SVG rather than JPEG. An <img> renders them identically, they are
// a few hundred bytes, and having the frame number and clock drawn into the
// picture makes it obvious at a glance whether the panel is actually polling.

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8090);
const CORS = process.argv.includes('--cors');

const USER = 'admin';
const PASSWORD = 'cnc';

/** Mutable camera state, so a command can be seen to have had an effect. */
const state = {
  pan: 0,
  tilt: 0,
  zoom: 0,
  moving: 'Stop',
  ir: 'Auto',
  whiteLed: { state: 0, mode: 1, bright: 100 },
  isp: { channel: 0, dayNight: 'Auto', exposure: 'Auto', antiFlicker: 'Off', backLight: 'Off' },
  commands: [],
};

let frame = 0;

function cors(res) {
  if (!CORS) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(res, body) {
  const text = JSON.stringify(body);
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function authOk(url) {
  return url.searchParams.get('user') === USER && url.searchParams.get('password') === PASSWORD;
}

/**
 * SVG is XML, so text drawn into a frame has to be escaped.
 *
 * Not hypothetical: the day/night mode is literally "Black&White", and an
 * unescaped ampersand makes the whole frame fail to parse — which looks exactly
 * like a camera that has stopped sending.
 */
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function snapshot() {
  frame++;
  const now = new Date().toISOString().slice(11, 23);
  // Something that visibly moves with the PTZ state, so a pan command can be
  // confirmed from the picture alone.
  const cx = 320 + state.pan * 4;
  const cy = 180 + state.tilt * 4;
  const r = 40 + state.zoom * 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect width="640" height="360" fill="#101418"/>
  <g stroke="#2a3340" stroke-width="1">
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${i * 55}" y1="0" x2="${i * 55}" y2="360"/>`).join('')}
    ${Array.from({ length: 7 }, (_, i) => `<line x1="0" y1="${i * 55}" x2="640" y2="${i * 55}"/>`).join('')}
  </g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ffbe2e" stroke-width="3"/>
  <text x="16" y="30" fill="#8cc7ff" font-family="monospace" font-size="18">mock camera — frame ${frame}</text>
  <text x="16" y="54" fill="#6a7482" font-family="monospace" font-size="14">${now}</text>
  <text x="16" y="340" fill="#6a7482" font-family="monospace" font-size="13">${xml(`pan ${state.pan} tilt ${state.tilt} zoom ${state.zoom} · ir ${state.ir} · led ${state.whiteLed.mode}/${state.whiteLed.bright} · ${state.isp.dayNight}`)}</text>
</svg>`;
}

function handleCommand(entry) {
  const cmd = entry?.cmd;
  const param = entry?.param ?? {};
  state.commands.push(cmd);

  switch (cmd) {
    case 'GetDevInfo':
      return {
        cmd,
        code: 0,
        value: {
          DevInfo: {
            model: 'E1 Outdoor Pro',
            name: 'Workshop',
            firmVer: 'v3.1.0.4066_23122801',
            hardVer: 'IPC_566SD164MP',
            channelNum: 1,
          },
        },
      };

    case 'PtzCtrl': {
      const op = param.op;
      const step = Math.max(1, Math.round((param.speed ?? 16) / 16));
      if (op === 'Left') state.pan -= step;
      else if (op === 'Right') state.pan += step;
      else if (op === 'Up') state.tilt -= step;
      else if (op === 'Down') state.tilt += step;
      else if (op === 'LeftUp') (state.pan -= step), (state.tilt -= step);
      else if (op === 'RightUp') (state.pan += step), (state.tilt -= step);
      else if (op === 'LeftDown') (state.pan -= step), (state.tilt += step);
      else if (op === 'RightDown') (state.pan += step), (state.tilt += step);
      else if (op === 'ZoomInc') state.zoom = Math.min(10, state.zoom + 1);
      else if (op === 'ZoomDec') state.zoom = Math.max(0, state.zoom - 1);
      else if (op === 'ToPos') (state.pan = (param.id ?? 0) * 10), (state.tilt = 0);
      state.moving = op;
      return { cmd, code: 0, value: { rspCode: 200 } };
    }

    case 'GetPtzPreset':
      return {
        cmd,
        code: 0,
        value: {
          PtzPreset: [
            { id: 1, enable: 1, name: 'Spindle' },
            { id: 2, enable: 1, name: 'Table' },
            { id: 3, enable: 0, name: '' },
          ],
        },
      };

    case 'GetIrLights':
      return { cmd, code: 0, value: { IrLights: { channel: 0, state: state.ir } } };
    case 'SetIrLights':
      state.ir = param.IrLights?.state ?? state.ir;
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetWhiteLed':
      return { cmd, code: 0, value: { WhiteLed: { channel: 0, ...state.whiteLed } } };
    case 'SetWhiteLed':
      Object.assign(state.whiteLed, param.WhiteLed ?? {});
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetIsp':
      return { cmd, code: 0, value: { Isp: { ...state.isp } } };
    case 'SetIsp':
      // The real camera replaces the whole block; losing a field here is the
      // bug this reproduces, so record exactly what arrived.
      state.isp = { ...(param.Isp ?? {}) };
      return { cmd, code: 0, value: { rspCode: 200 } };

    case 'GetPowerLed':
      return { cmd, code: 0, value: { PowerLed: { channel: 0, state: 'On' } } };
    case 'SetPowerLed':
      return { cmd, code: 0, value: { rspCode: 200 } };

    default:
      // What a real camera does with a command this model lacks.
      return { cmd, code: 1, error: { detail: 'not support', rspCode: -9 } };
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'OPTIONS') {
    cors(res);
    // Without --cors this is the wall a preflighted request hits.
    res.writeHead(CORS ? 204 : 405);
    return res.end();
  }

  // A debug hook for the test harness: what has the camera actually been told?
  if (url.pathname === '/_state') {
    return sendJson(res, state);
  }

  if (url.pathname !== '/cgi-bin/api.cgi') {
    res.writeHead(404);
    return res.end('not found');
  }

  if (!authOk(url)) {
    cors(res);
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify([{ cmd: 'Login', code: 1, error: { detail: 'login failed', rspCode: -6 } }]));
  }

  if (url.searchParams.get('cmd') === 'Snap') {
    const svg = snapshot();
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Content-Length': Buffer.byteLength(svg),
      'Cache-Control': 'no-store',
    });
    return res.end(svg);
  }

  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }
    const list = Array.isArray(body) ? body : [body];
    return sendJson(res, list.map(handleCommand));
  }

  res.writeHead(400);
  res.end('unsupported');
});

server.listen(PORT, () => {
  console.log(`mock camera on http://localhost:${PORT} (${CORS ? 'CORS enabled → readable' : 'no CORS → blind'})`);
  console.log(`  user "${USER}" password "${PASSWORD}"`);
});
