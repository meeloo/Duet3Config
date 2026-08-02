// Mock RepRapFirmware controller for developing without the machine.
//
//   node tools/mock-rrf.mjs [port]      (default 8081)
//
// Serves the rr_* endpoints against a synthetic object model shaped like the
// real Ultimate Bee: X/Y/Z plus the U dust-shoe axis, a 0-24000 rpm VFD
// spindle, an 8-slot RapidChange ATC, and the atc*/dustShoe* globals from
// config/sys. Also serves dist/ so you can test same-origin as well as CORS.
//
// It simulates motion, so the DRO moves and the viewer's live cutter position
// actually tracks something.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8081);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

let sessionKey = 1000;
let replySeq = 0;
let pendingReply = '';
const seqs = {
  boards: 1, directories: 1, fans: 1, global: 1, heat: 1, inputs: 1,
  job: 1, move: 1, network: 1, reply: 0, sensors: 1, spindles: 1,
  state: 1, tools: 1, volumes: 1,
};

const axes = [
  { letter: 'X', machinePosition: 260, userPosition: 260, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 523, visible: true },
  { letter: 'Y', machinePosition: 600, userPosition: 600, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 1262, visible: true },
  { letter: 'Z', machinePosition: -20, userPosition: -20, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: -180, max: 0, visible: true },
  { letter: 'U', machinePosition: 30, userPosition: 30, workplaceOffsets: [0,0,0,0,0,0,0,0,0], homed: true, min: 0, max: 60, visible: true },
];

const state = {
  status: 'idle',
  currentTool: 1,
  machineMode: 'CNC',
  messageBox: null,
  upTime: 4210,
};

const spindle = { active: 0, current: 0, min: 0, max: 24000, state: 'stopped', canReverse: true };

const job = { file: null, filePosition: 0, duration: 0, timesLeft: {} };

const globals = {
  systemSettingsVersion: 1.2,
  atcEnabled: true,
  atcProbingEnabled: true,
  atcDirection: 1,
  atcAlignment: 0,
  atcOffset: 45,
  atcCount: 8,
  atcSpindlePause: 2,
  atcRPM: 250,
  atcOriginX: 107.5,
  atcOriginY: 1260,
  atcProbeX: 3,
  atcProbeY: 1260,
  atcProbeZ: 41.3,
  atcToolHasBeenDetected: false,
  dustShoeEngaged: true,
  dustShoePrevZ: -20,
  dustShoeEngagedU: 30,
};

// Indexed by tool NUMBER, not packed — exactly like the firmware. This config
// declares M563 P1..P9 with no P0, so slot 0 is a genuine null. A mock that
// returns a packed array hides every "read a field off a hole" bug.
const tools = [
  null,
  ...Array.from({ length: 9 }, (_, i) => ({
    number: i + 1,
    name: i === 8 ? 'Manual Tool 9' : `Spindle tool ${i + 1}`,
    offsets: [0, 0, -12.5 - i * 0.7, 0],
    spindle: 0,
    state: i + 1 === state.currentTool ? 'active' : 'off',
  })),
];

// Sizes are patched from FILE_CONTENT below so job progress is consistent with
// what the viewer actually parses.
const FILES = {
  '/sys': [
    { type: 'f', name: 'config.g', size: 1042, date: '2026-07-01T10:12:00' },
    { type: 'f', name: 'atcConfig.g', size: 2310, date: '2026-07-02T18:40:00' },
    { type: 'f', name: 'dustShoeConfig.g', size: 340, date: '2026-07-02T18:41:00' },
    { type: 'f', name: 'config-axes.g', size: 900, date: '2026-06-20T09:00:00' },
    { type: 'f', name: 'homeall.g', size: 420, date: '2026-06-20T09:00:00' },
  ],
  '/macros': [
    { type: 'd', name: 'Setup', size: 0, date: '2026-06-01T09:00:00' },
    { type: 'f', name: 'Engage Dust Shoe.g', size: 120, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'ProbeZ.g', size: 260, date: '2026-07-01T10:00:00' },
    { type: 'f', name: 'Save Work State.g', size: 210, date: '2026-07-01T10:00:00' },
  ],
  '/macros/Setup': [
    { type: 'f', name: 'Plane Stock.g', size: 800, date: '2026-06-01T09:00:00' },
  ],
  '/gcodes': [
    { type: 'f', name: 'bracket_roughing.nc', size: 48210, date: '2026-07-28T14:00:00' },
    { type: 'f', name: 'spoilboard_surface.nc', size: 9100, date: '2026-07-20T11:00:00' },
  ],
};

const FILE_CONTENT = {
  '/sys/config.g': `; Configuration file for Duet\nglobal systemSettingsVersion={1.2}\nM98 P"config-network.g"\nM98 P"config-axes.g"\nM453 ; CNC mode\nM501\n`,
  '/sys/atcConfig.g': `; RapidChange globals\nglobal atcEnabled = true\nglobal atcCount = 8\nglobal atcOffset = 45\nglobal atcOriginX = 107.5\nglobal atcOriginY = 1260\n`,
  '/sys/dustShoeConfig.g': `global dustShoeEngaged    = false\nglobal dustShoePrevZ      = move.axes[2].machinePosition\nglobal dustShoeEngagedU   = 30\n`,
  '/gcodes/spoilboard_surface.nc': generateSurfacingProgram(),
  '/gcodes/bracket_roughing.nc': generateBracketProgram(),
};

// Keep listed sizes honest so filePosition/size progress means something.
for (const entries of Object.values(FILES)) {
  for (const e of entries) {
    const full = Object.keys(FILE_CONTENT).find((p) => p.endsWith(`/${e.name}`));
    if (full) e.size = Buffer.byteLength(FILE_CONTENT[full], 'utf8');
  }
}

/** A simple raster surfacing pass — exercises rapids, feeds and long paths. */
function generateSurfacingProgram() {
  const out = ['(spoilboard surfacing)', 'G21 G90', 'G17', 'T1 M6', 'M3 S18000', 'G0 Z5'];
  const stepover = 20;
  for (let i = 0, y = 20; y <= 400; y += stepover, i++) {
    const x0 = i % 2 === 0 ? 20 : 480;
    const x1 = i % 2 === 0 ? 480 : 20;
    out.push(`G0 X${x0} Y${y}`);
    out.push('G1 Z-0.5 F600');
    out.push(`G1 X${x1} F3000`);
    out.push('G0 Z5');
  }
  out.push('M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}

/** Contains arcs so the G2/G3 tessellation gets exercised. */
function generateBracketProgram() {
  const out = ['(bracket roughing)', 'G21 G90 G17', 'T2 M6', 'M3 S16000', 'G0 Z5'];
  for (let depth = 1; depth <= 6; depth++) {
    const z = -depth * 1.5;
    out.push(`G0 X60 Y60`, `G1 Z${z} F400`);
    out.push(`G1 X180 Y60 F2400`);
    out.push(`G2 X200 Y80 I0 J20`);
    out.push(`G1 X200 Y180`);
    out.push(`G2 X180 Y200 I-20 J0`);
    out.push(`G1 X60 Y200`);
    out.push(`G2 X40 Y180 I0 J-20`);
    out.push(`G1 X40 Y80`);
    out.push(`G2 X60 Y60 I20 J0`);
    out.push('G0 Z5');
  }
  // A circular pocket, to check full-circle arcs.
  out.push('G0 X120 Y130', 'G1 Z-3 F400', 'G3 X120 Y130 I30 J0 F1800', 'G0 Z5');
  out.push('M5', 'G0 X0 Y0', 'M30');
  return out.join('\n');
}

// --- Simulated motion ----------------------------------------------------

let t = 0;
setInterval(() => {
  t += 0.1;
  if (state.status === 'processing') {
    // Sweep through the loaded program so filePosition advances.
    // Pace the sweep so any file takes roughly 30 s, whatever its size.
    job.filePosition = Math.min(job.file.size, job.filePosition + job.file.size / 300);
    job.duration += 0.1;
    job.timesLeft = { file: Math.max(0, (job.file.size - job.filePosition) / 2200) };
    if (job.filePosition >= job.file.size) {
      state.status = 'idle';
      spindle.current = 0;
      spindle.active = 0;
      spindle.state = 'stopped';
      bumpSeq('job');
      bumpSeq('state');
    }
    axes[0].machinePosition = 260 + Math.sin(t * 0.7) * 180;
    axes[1].machinePosition = 600 + Math.cos(t * 0.4) * 200;
    axes[2].machinePosition = -20 + Math.sin(t * 2) * 3;
  }
  for (const a of axes) {
    a.userPosition = a.machinePosition - a.workplaceOffsets[0];
  }
  if (spindle.state !== 'stopped') {
    // Drift toward the commanded RPM, like a real VFD ramping.
    spindle.current += (spindle.active - spindle.current) * 0.2;
  }
}, 100);

function bumpSeq(key) {
  seqs[key] = (seqs[key] ?? 0) + 1;
}

function pushReply(text) {
  pendingReply += (pendingReply ? '\n' : '') + text;
  replySeq++;
  seqs.reply = replySeq;
}

// --- Object model assembly ----------------------------------------------

function buildModel(liveOnly) {
  const model = {
    boards: [{ shortName: 'MB6HC', name: 'Duet 3 MB6HC', firmwareName: 'RepRapFirmware for Duet 3 MB6HC', firmwareVersion: '3.6.0' }],
    global: globals,
    job: { ...job },
    move: {
      axes: axes.map((a) =>
        liveOnly
          ? { machinePosition: round(a.machinePosition), userPosition: round(a.userPosition) }
          : { ...a, machinePosition: round(a.machinePosition), userPosition: round(a.userPosition) },
      ),
      workplaceNumber: 0,
      speedFactor: 1,
      currentMove: { requestedSpeed: state.status === 'processing' ? 2400 : 0, topSpeed: 2400 },
    },
    network: { name: 'Sebs CNC', hostname: 'sebscnc' },
    sensors: { probes: [{ value: [0], type: 8, triggered: false }] },
    seqs,
    spindles: [{ ...spindle, current: Math.round(spindle.current) }],
    state: { ...state },
    tools,
  };
  return model;
}

const round = (n) => Math.round(n * 1000) / 1000;

// --- HTTP ----------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
};

// Deliberately as limited as the real firmware.
//
// `M586 C"*"` makes RRF send Access-Control-Allow-Origin and nothing else — it
// does NOT answer a CORS preflight with Access-Control-Allow-Headers. An
// obliging mock that sends the full permissive set hides an entire class of bug:
// any request with a custom header or non-simple Content-Type works against the
// mock and dies against the machine. So we mirror the firmware's actual
// behaviour, and preflights fail here exactly as they do on the Duet.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function sendJson(res, obj) {
  cors(res);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // RRF has no OPTIONS handler, so a preflighted request gets nothing usable and
  // the browser reports an opaque network failure. Reproduce that here.
  if (req.method === 'OPTIONS') {
    res.writeHead(405);
    return res.end();
  }

  switch (path) {
    case '/rr_connect':
      sessionKey++;
      return sendJson(res, { err: 0, sessionTimeout: 8000, boardType: 'duet3mb6hc', sessionKey, apiLevel: 1 });

    case '/rr_disconnect':
      return sendJson(res, { err: 0 });

    case '/rr_model': {
      const key = url.searchParams.get('key') ?? '';
      const flags = url.searchParams.get('flags') ?? '';

      // Asking for the WHOLE model verbose is the largest response the firmware
      // can be made to produce, and a real board can simply fail to deliver it.
      // A mock that cheerfully returns it hides that, so drop the connection
      // exactly as the board does — clients must fetch per key instead.
      if (!key && flags.includes('v')) {
        req.destroy();
        return;
      }

      const live = flags.includes('f') && !flags.includes('v');
      const model = buildModel(live);
      const result = key ? key.split('.').reduce((o, k) => (o ? o[k] : undefined), model) : model;
      return sendJson(res, { key, flags, result: result ?? null });
    }

    case '/rr_gcode': {
      const gcode = url.searchParams.get('gcode') ?? '';
      handleGcode(gcode);
      return sendJson(res, { buff: 1024 });
    }

    case '/rr_reply': {
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const out = pendingReply;
      pendingReply = '';
      return res.end(out);
    }

    case '/rr_filelist': {
      const dir = url.searchParams.get('dir') ?? '/';
      const files = FILES[dir.replace(/\/$/, '')] ?? null;
      if (!files) return sendJson(res, { dir, first: 0, files: [], next: 0, err: 2 });
      return sendJson(res, { dir, first: 0, files, next: 0, err: 0 });
    }

    case '/rr_download': {
      const name = url.searchParams.get('name') ?? '';
      const content = FILE_CONTENT[name];
      if (content === undefined) {
        cors(res);
        res.writeHead(404);
        return res.end('not found');
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(content);
    }

    case '/rr_upload': {
      const name = url.searchParams.get('name') ?? '';
      const chunks = [];
      for await (const c of req) chunks.push(c);
      FILE_CONTENT[name] = Buffer.concat(chunks).toString('utf8');
      pushReply(`Uploaded ${name}`);
      return sendJson(res, { err: 0 });
    }

    case '/rr_delete':
    case '/rr_mkdir':
    case '/rr_move':
      return sendJson(res, { err: 0 });

    default:
      break;
  }

  // Static: serve dist/ so same-origin can be tested too.
  const file = join(DIST, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  try {
    await stat(file);
    const body = await readFile(file);
    cors(res);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    cors(res);
    res.writeHead(404);
    res.end('not found');
  }
});

function handleGcode(gcode) {
  const cmds = gcode.split('\n').map((c) => c.trim()).filter(Boolean);
  for (const cmd of cmds) {
    const upper = cmd.toUpperCase();

    if (upper.startsWith('M112')) {
      state.status = 'halted';
      spindle.state = 'stopped';
      spindle.active = spindle.current = 0;
      pushReply('Emergency stop');
      bumpSeq('state');
    } else if (upper.startsWith('G28')) {
      state.status = 'idle';
      for (const a of axes) a.homed = true;
      pushReply('Homing complete');
      bumpSeq('move');
    } else if (/^M3\b/.test(upper) || /^M4\b/.test(upper)) {
      const s = /S(\d+)/.exec(upper);
      spindle.active = s ? Number(s[1]) : 12000;
      spindle.state = upper.startsWith('M4') ? 'reverse' : 'forward';
      bumpSeq('spindles');
    } else if (/^M5\b/.test(upper)) {
      spindle.active = 0;
      spindle.state = 'stopped';
      bumpSeq('spindles');
    } else if (upper.startsWith('M32')) {
      const m = /"([^"]+)"/.exec(cmd);
      if (m) {
        const size = (FILE_CONTENT[m[1]] ?? '').length || 48210;
        job.file = { fileName: m[1], size, generatedBy: 'Fusion 360' };
        job.filePosition = 0;
        job.duration = 0;
        state.status = 'processing';
        pushReply(`Started job ${m[1]}`);
        bumpSeq('job');
        bumpSeq('state');
      }
    } else if (upper.startsWith('M25')) {
      state.status = 'paused';
      bumpSeq('state');
    } else if (upper.startsWith('M24')) {
      state.status = 'processing';
      bumpSeq('state');
    } else if (upper.startsWith('M0')) {
      state.status = 'idle';
      job.file = null;
      bumpSeq('state');
      bumpSeq('job');
    } else if (upper.startsWith('G10 L20')) {
      // Set work offset so the current position reads the requested value.
      for (const a of axes) {
        const m = new RegExp(`${a.letter}(-?[\\d.]+)`).exec(upper);
        if (m) a.workplaceOffsets[0] = a.machinePosition - Number(m[1]);
      }
      pushReply('Work offset set');
      bumpSeq('move');
    } else if (upper.startsWith('G1') || upper.startsWith('G0')) {
      const relative = cmds.some((c) => c.toUpperCase() === 'G91');
      for (const a of axes) {
        const m = new RegExp(`${a.letter}(-?[\\d.]+)`).exec(upper);
        if (m) {
          const v = Number(m[1]);
          a.machinePosition = relative
            ? Math.max(a.min, Math.min(a.max, a.machinePosition + v))
            : v;
        }
      }
      bumpSeq('move');
    } else if (upper.startsWith('SET GLOBAL.')) {
      const m = /^set global\.(\w+)\s*=\s*(.+)$/i.exec(cmd);
      if (m) {
        const raw = m[2].trim();
        globals[m[1]] =
          raw === 'true' ? true : raw === 'false' ? false :
          !isNaN(Number(raw)) ? Number(raw) : raw.replace(/^"|"$/g, '');
        pushReply(`global.${m[1]} = ${globals[m[1]]}`);
        bumpSeq('global');
      }
    } else if (upper.startsWith('M291')) {
      const msg = /P"([^"]*)"/.exec(cmd);
      const title = /R"([^"]*)"/.exec(cmd);
      const mode = /S(\d+)/.exec(cmd);
      state.messageBox = {
        mode: mode ? Number(mode[1]) : 2,
        seq: (state.messageBox?.seq ?? 0) + 1,
        title: title ? title[1] : 'Message',
        message: msg ? msg[1] : '',
        timeout: 0,
        axisControls: 0,
      };
      bumpSeq('state');
    } else if (upper.startsWith('M292')) {
      state.messageBox = null;
      pushReply('Message acknowledged');
      bumpSeq('state');
    } else if (upper.startsWith('M98')) {
      pushReply(`Running macro ${cmd}`);
    } else if (upper.startsWith('M120') || upper.startsWith('M121') || upper.startsWith('G90') || upper.startsWith('G91')) {
      // Motion-stack bookkeeping; nothing to simulate.
    } else {
      pushReply(`ok (${cmd})`);
    }
  }
}

server.listen(PORT, () => {
  console.log(`mock RRF controller on http://localhost:${PORT}`);
  console.log(`serving dist/ from ${DIST}`);
});
