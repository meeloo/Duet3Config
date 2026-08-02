// G-code → line segments, with byte offsets preserved.
//
// The byte offset is the whole point. RepRapFirmware reports `job.filePosition`
// as a byte offset into the running file, so keeping the source offset on every
// vertex is what lets the viewer show where the cutter actually is. Any parser
// that throws away offsets can draw the path but can never track the job.
//
// Scope: G0/G1 linear moves, G2/G3 arcs in any plane, G20/G21 units,
// G90/G91 positioning, G90.1/G91.1 arc-centre modes. That covers what Fusion
// posts. Canned cycles are not interpreted — they are rare in router work and
// would need a full state machine to do correctly rather than approximately.

export interface ParsedToolpath {
  /** xyz per vertex, GL_LINES pairs. */
  positions: Float32Array;
  /** Source byte offset per vertex. */
  offsets: Float32Array;
  /** 0 = rapid, 1 = cutting. Per vertex. */
  kinds: Uint8Array;
  min: [number, number, number];
  max: [number, number, number];
  /** Byte length of the source, for progress mapping. */
  byteLength: number;
  lineCount: number;
  /** Tool numbers seen, in order of first appearance. */
  tools: number[];
  warnings: string[];
}

const ARC_TOLERANCE = 0.02; // mm of chord deviation

export function parseGcode(source: string): ParsedToolpath {
  const positions: number[] = [];
  const offsets: number[] = [];
  const kinds: number[] = [];
  const tools: number[] = [];
  const warnings: string[] = [];

  // Machine state
  let x = 0, y = 0, z = 0;
  let absolute = true;
  let arcAbsolute = false; // G90.1 = centre is absolute; default incremental
  let unitScale = 1; // 1 = mm, 25.4 = inch
  let plane: 0 | 1 | 2 = 0; // 0 = XY (G17), 1 = XZ (G18), 2 = YZ (G19)
  let motion = 0; // modal motion mode: 0/1/2/3
  let feedActive = false;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const track = (px: number, py: number, pz: number) => {
    if (px < min[0]) min[0] = px;
    if (py < min[1]) min[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (px > max[0]) max[0] = px;
    if (py > max[1]) max[1] = py;
    if (pz > max[2]) max[2] = pz;
  };

  const emit = (
    fromX: number, fromY: number, fromZ: number,
    toX: number, toY: number, toZ: number,
    cutting: boolean, byteOffset: number,
  ) => {
    positions.push(fromX, fromY, fromZ, toX, toY, toZ);
    offsets.push(byteOffset, byteOffset);
    const k = cutting ? 1 : 0;
    kinds.push(k, k);
    track(fromX, fromY, fromZ);
    track(toX, toY, toZ);
  };

  const lines = source.split('\n');
  let byteOffset = 0;
  // Byte length per line, computed without re-encoding the whole file: ASCII is
  // the overwhelming case, so only pay for TextEncoder when a line isn't.
  const encoder = new TextEncoder();

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const rawLine = lines[lineNo];
    const lineStart = byteOffset;
    byteOffset += isAscii(rawLine) ? rawLine.length + 1 : encoder.encode(rawLine).length + 1;

    const line = stripComments(rawLine);
    if (!line) continue;

    const words = parseWords(line);
    if (!words.length) continue;

    // Modal state changes first, so a G-word and its axis words in the same
    // block are interpreted consistently.
    let hasMotionWord = false;
    for (const [letter, value] of words) {
      if (letter === 'G') {
        switch (value) {
          case 0: motion = 0; hasMotionWord = true; break;
          case 1: motion = 1; hasMotionWord = true; break;
          case 2: motion = 2; hasMotionWord = true; break;
          case 3: motion = 3; hasMotionWord = true; break;
          case 17: plane = 0; break;
          case 18: plane = 1; break;
          case 19: plane = 2; break;
          case 20: unitScale = 25.4; break;
          case 21: unitScale = 1; break;
          case 90: absolute = true; break;
          case 91: absolute = false; break;
          case 90.1: arcAbsolute = true; break;
          case 91.1: arcAbsolute = false; break;
          default: break;
        }
      } else if (letter === 'T') {
        if (!tools.includes(value)) tools.push(value);
      } else if (letter === 'F') {
        feedActive = true;
      }
    }

    const get = (letter: string): number | undefined => {
      for (const [l, v] of words) if (l === letter) return v;
      return undefined;
    };

    const wx = get('X');
    const wy = get('Y');
    const wz = get('Z');
    const hasAxisWord = wx !== undefined || wy !== undefined || wz !== undefined;
    if (!hasAxisWord && !hasMotionWord) continue;
    if (!hasAxisWord && (motion === 0 || motion === 1)) continue;

    const nx = resolve(x, wx, absolute, unitScale);
    const ny = resolve(y, wy, absolute, unitScale);
    const nz = resolve(z, wz, absolute, unitScale);

    if (motion === 0 || motion === 1) {
      const cutting = motion === 1;
      if (nx !== x || ny !== y || nz !== z) {
        emit(x, y, z, nx, ny, nz, cutting, lineStart);
        x = nx; y = ny; z = nz;
      }
    } else {
      // Arc. I/J/K are centre offsets; R is radius form.
      const i = get('I');
      const j = get('J');
      const k = get('K');
      const r = get('R');

      const arc = tessellateArc(
        { x, y, z }, { x: nx, y: ny, z: nz },
        { i, j, k, r }, plane, motion === 2, arcAbsolute, unitScale,
      );

      if (!arc) {
        warnings.push(`line ${lineNo + 1}: unusable arc, drawn as a straight move`);
        emit(x, y, z, nx, ny, nz, true, lineStart);
      } else {
        let px = x, py = y, pz = z;
        for (const p of arc) {
          emit(px, py, pz, p.x, p.y, p.z, true, lineStart);
          px = p.x; py = p.y; pz = p.z;
        }
      }
      x = nx; y = ny; z = nz;
    }
  }

  if (!positions.length) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  if (feedActive === false && positions.length) {
    warnings.push('no feed rate found — file may not be a milling program');
  }

  return {
    positions: new Float32Array(positions),
    offsets: new Float32Array(offsets),
    kinds: new Uint8Array(kinds),
    min,
    max,
    byteLength: byteOffset,
    lineCount: lines.length,
    tools,
    warnings,
  };
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}

function resolve(
  current: number,
  word: number | undefined,
  absolute: boolean,
  scale: number,
): number {
  if (word === undefined) return current;
  return absolute ? word * scale : current + word * scale;
}

/** Strip `;` line comments and `( … )` inline comments. */
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

/** Split a block into [letter, value] pairs. Tolerates missing whitespace. */
function parseWords(line: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = /([A-Za-z])\s*([-+]?[0-9]*\.?[0-9]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    out.push([m[1].toUpperCase(), parseFloat(m[2])]);
  }
  return out;
}

interface Pt { x: number; y: number; z: number }

/**
 * Tessellate G2/G3 into points (excluding the start point).
 * Handles the three planes and both centre-offset and radius forms.
 */
function tessellateArc(
  from: Pt,
  to: Pt,
  params: { i?: number; j?: number; k?: number; r?: number },
  plane: 0 | 1 | 2,
  clockwise: boolean,
  arcAbsolute: boolean,
  scale: number,
): Pt[] | null {
  // Map the active plane onto (u, v) with `w` as the helical axis.
  const axes: Array<['x' | 'y' | 'z', 'x' | 'y' | 'z', 'x' | 'y' | 'z']> = [
    ['x', 'y', 'z'], // G17
    ['x', 'z', 'y'], // G18
    ['y', 'z', 'x'], // G19
  ];
  const [ua, va, wa] = axes[plane];
  const offsetWords: Record<'x' | 'y' | 'z', number | undefined> = {
    x: params.i,
    y: params.j,
    z: params.k,
  };

  const u0 = from[ua], v0 = from[va], w0 = from[wa];
  const u1 = to[ua], v1 = to[va], w1 = to[wa];

  let cu: number;
  let cv: number;

  if (params.r !== undefined) {
    // Radius form: centre lies on the perpendicular bisector of the chord.
    const radius = params.r * scale;
    const du = u1 - u0;
    const dv = v1 - v0;
    const chord = Math.hypot(du, dv);
    if (chord === 0 || chord > Math.abs(radius) * 2) return null;

    const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    // Sign selects the minor/major arc; negative R means "the long way round".
    const sign = clockwise === radius > 0 ? -1 : 1;
    cu = mu + (sign * h * -dv) / chord;
    cv = mv + (sign * h * du) / chord;
  } else {
    const ou = offsetWords[ua];
    const ov = offsetWords[va];
    if (ou === undefined && ov === undefined) return null;
    if (arcAbsolute) {
      cu = (ou ?? 0) * scale;
      cv = (ov ?? 0) * scale;
    } else {
      cu = u0 + (ou ?? 0) * scale;
      cv = v0 + (ov ?? 0) * scale;
    }
  }

  const r0 = Math.hypot(u0 - cu, v0 - cv);
  const r1 = Math.hypot(u1 - cu, v1 - cv);
  if (r0 < 1e-6) return null;
  // A large radius mismatch means the block is malformed; caller falls back.
  if (Math.abs(r0 - r1) > Math.max(0.05, r0 * 0.01)) return null;

  let a0 = Math.atan2(v0 - cv, u0 - cu);
  let a1 = Math.atan2(v1 - cv, u1 - cu);

  // G18 (XZ) is handed the other way round from G17/G19 under the usual
  // right-hand-rule convention, so the sweep direction flips.
  const cw = plane === 1 ? !clockwise : clockwise;

  if (cw) {
    if (a1 >= a0) a1 -= 2 * Math.PI;
  } else {
    if (a1 <= a0) a1 += 2 * Math.PI;
  }
  // Full circle: start and end coincide.
  if (Math.abs(a1 - a0) < 1e-9) a1 = a0 + (cw ? -2 * Math.PI : 2 * Math.PI);

  const sweep = Math.abs(a1 - a0);
  const maxStep = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOLERANCE / r0)));
  const steps = Math.max(2, Math.min(2048, Math.ceil(sweep / Math.max(maxStep, 0.01))));

  const out: Pt[] = [];
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const a = a0 + (a1 - a0) * t;
    const p = { x: 0, y: 0, z: 0 } as Pt;
    p[ua] = cu + r0 * Math.cos(a);
    p[va] = cv + r0 * Math.sin(a);
    p[wa] = w0 + (w1 - w0) * t;
    out.push(p);
  }
  return out;
}
