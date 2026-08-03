// Run-from-line: restart a job partway through.
//
// This is what you want after a broken cutter, and almost nothing in the hobby
// world does it. The hard part is not seeking the file — RRF does that with
// M26 — it is that starting mid-file drops the machine into a program whose
// modal state was established by lines it will never execute. Units, plane,
// distance mode, work offset, tool, spindle and feed are all set once near the
// top and then relied on for thousands of lines.
//
// So we scan from the start to the resume point, collect the state the program
// would have been in, and emit a preamble that puts the machine back into it
// before handing control to the file.
//
// RRF requires the M26 offset to be the start of a G-code command; the parser
// records the byte offset of each line's first character, so any offset it
// produced is already aligned.

import { Gcode, n } from '../cam/format.js';

export interface ModalState {
  /** 'mm' or 'inch' — G21 / G20. */
  units: 'mm' | 'inch';
  /** G90 / G91. */
  distance: 'absolute' | 'relative';
  /** 17, 18 or 19. */
  plane: 17 | 18 | 19;
  /** 1 = G54 … 9 = G59.3. */
  wcs: number;
  /** Last selected tool, or null if the program never selected one. */
  tool: number | null;
  /** Commanded spindle speed and direction at the resume point. */
  spindleRpm: number;
  spindleDir: 'off' | 'forward' | 'reverse';
  /** Modal feed rate in mm/min. */
  feed: number;
  /** Coolant M7/M8 seen and not cancelled. */
  mist: boolean;
  flood: boolean;
  /** Position the program would be at, in work coordinates. */
  x: number;
  y: number;
  z: number;
  /** 1-based line number containing the resume offset. */
  line: number;
}

/**
 * Replay the file from the start up to `byteOffset`, tracking only modal state.
 *
 * Deliberately separate from the toolpath parser: that one builds geometry and
 * is optimised for it, while this needs the words the geometry pass discards
 * (M3/M4/M5, coolant, tool selection) and none of the vertices.
 */
export function modalStateAt(source: string, byteOffset: number): ModalState {
  const state: ModalState = {
    units: 'mm',
    distance: 'absolute',
    plane: 17,
    wcs: 1,
    tool: null,
    spindleRpm: 0,
    spindleDir: 'off',
    feed: 0,
    mist: false,
    flood: false,
    x: 0,
    y: 0,
    z: 0,
    line: 1,
  };

  const lines = source.split('\n');
  let offset = 0;
  let scale = 1;
  let pendingS = 0;

  for (let i = 0; i < lines.length; i++) {
    if (offset >= byteOffset) {
      state.line = i + 1;
      return state;
    }
    const raw = lines[i];
    offset += byteLength(raw) + 1;

    const line = stripComments(raw);
    if (!line) continue;

    const words = [...line.matchAll(/([A-Za-z])\s*([-+]?[0-9]*\.?[0-9]+)/g)].map(
      (m) => [m[1].toUpperCase(), parseFloat(m[2])] as [string, number],
    );

    let motion: number | null = null;
    for (const [letter, value] of words) {
      switch (letter) {
        case 'G':
          if (value === 20) { state.units = 'inch'; scale = 25.4; }
          else if (value === 21) { state.units = 'mm'; scale = 1; }
          else if (value === 90) state.distance = 'absolute';
          else if (value === 91) state.distance = 'relative';
          else if (value === 17 || value === 18 || value === 19) state.plane = value;
          else if (value >= 54 && value <= 59) state.wcs = Math.round(value) - 53;
          else if (value === 59.1) state.wcs = 7;
          else if (value === 59.2) state.wcs = 8;
          else if (value === 59.3) state.wcs = 9;
          else if (value <= 3) motion = value;
          break;
        case 'M':
          if (value === 3) state.spindleDir = 'forward';
          else if (value === 4) state.spindleDir = 'reverse';
          else if (value === 5) state.spindleDir = 'off';
          else if (value === 7) state.mist = true;
          else if (value === 8) state.flood = true;
          else if (value === 9) { state.mist = false; state.flood = false; }
          break;
        case 'T':
          state.tool = value;
          break;
        case 'F':
          state.feed = value * scale;
          break;
        case 'S':
          pendingS = value;
          break;
        default:
          break;
      }
    }
    // S is only a spindle speed when a spindle command is in play.
    if (state.spindleDir !== 'off' && pendingS > 0) state.spindleRpm = pendingS;

    // Track position so the preamble knows where to put the machine back.
    if (motion !== null || words.some(([l]) => 'XYZ'.includes(l))) {
      for (const [letter, value] of words) {
        if (letter === 'X') state.x = state.distance === 'absolute' ? value * scale : state.x + value * scale;
        if (letter === 'Y') state.y = state.distance === 'absolute' ? value * scale : state.y + value * scale;
        if (letter === 'Z') state.z = state.distance === 'absolute' ? value * scale : state.z + value * scale;
      }
    }
  }

  state.line = lines.length;
  return state;
}

/** Same comment rules as the toolpath parser: `;` to end of line, `( … )` inline. */
function stripComments(line: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (c === ';') break;
      out += c;
    }
  }
  return out.trim();
}

const encoder = new TextEncoder();

/** Byte length, avoiding the encoder for the overwhelmingly common ASCII case. */
function byteLength(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) return encoder.encode(s).length;
  }
  return s.length;
}

export interface ResumeOptions {
  /** Machine Z to retract to before any XY move. */
  safeMachineZ: number;
  /** Feed for the final descent to cutting depth, mm/min. */
  plungeFeed: number;
  /** Re-run the tool change (which on this machine also re-probes tool length). */
  changeTool: boolean;
  /** Restart the spindle and wait for it to spin up. */
  startSpindle: boolean;
  spindleDwell: number;
}

/**
 * G-code that puts the machine back into `state` and positions it at the
 * resume point, ready for the file to take over.
 *
 * Order matters and is not negotiable: retract in MACHINE coordinates first
 * (the work offset may be anything, and we may be starting from anywhere),
 * then change tool, then travel in XY at height, and only then descend.
 */
export function buildResumePreamble(state: ModalState, opts: ResumeOptions): string {
  const g = new Gcode();
  const wcs = wcsCode(state.wcs);

  g.comment(`Resume at line ${state.line}`);
  g.comment(`restores ${wcs}, G${state.plane}, ${state.units === 'mm' ? 'G21' : 'G20'}, ${state.distance === 'absolute' ? 'G90' : 'G91'}`);
  g.comment(state.tool !== null ? `tool T${state.tool}` : 'no tool selected by the program');
  g.comment(state.spindleDir !== 'off' ? `spindle ${state.spindleRpm} rpm ${state.spindleDir}` : 'spindle off');
  g.comment(`resume point X${n(state.x)} Y${n(state.y)} Z${n(state.z)} (mm)`);
  g.blank();

  // EVERY coordinate below is millimetres, because that is how modalStateAt
  // stores them regardless of the file's units. So mm mode and absolute
  // positioning are forced first, and the file's own units and distance mode
  // are restored at the very end, after the last move.
  //
  // Getting this wrong is not cosmetic: emitting G20 first and then a position
  // held in mm would read 101.6 as 101.6 INCHES — two and a half metres, into
  // the end of the machine.
  g.comment('all moves below are in mm and absolute, whatever the file used');
  g.raw('G21');
  g.raw('G90');
  g.raw(`G${state.plane}`);
  g.raw(wcs);
  g.blank();

  g.comment('retract in machine coordinates before moving anywhere');
  g.raw(`G53 G0 Z${n(opts.safeMachineZ)}`);

  if (opts.changeTool && state.tool !== null) {
    g.blank();
    g.comment('full tool change — re-measures tool length on this machine');
    g.raw(`T${state.tool}`);
    g.raw(`G53 G0 Z${n(opts.safeMachineZ)}`);
  }

  if (opts.startSpindle && state.spindleDir !== 'off' && state.spindleRpm > 0) {
    g.blank();
    g.raw(`${state.spindleDir === 'forward' ? 'M3' : 'M4'} S${Math.round(state.spindleRpm)}`);
    if (opts.spindleDwell > 0) g.dwell(opts.spindleDwell);
  }
  if (state.flood) g.raw('M8');
  if (state.mist) g.raw('M7');

  g.blank();
  g.comment('travel at height, then descend to the resume depth');
  g.raw(`G0 X${n(state.x)} Y${n(state.y)}`);
  g.raw(`G1 Z${n(state.z)} F${n(opts.plungeFeed, 1)}`);

  g.blank();
  g.comment('hand the modal state back to the file');
  // The feed is stored in mm/min, so it must be set while still in G21.
  if (state.feed > 0) g.raw(`F${n(state.feed, 1)}`);
  if (state.units === 'inch') g.raw('G20');
  if (state.distance === 'relative') g.raw('G91');

  g.blank();
  g.comment('the job resumes from here');
  return g.toString();
}

/** G54–G59 then G59.1–G59.3 — NOT G53+n, which runs off the end into G60. */
export function wcsCode(wcs: number): string {
  return wcs <= 6 ? `G${53 + wcs}` : `G59.${wcs - 6}`;
}
