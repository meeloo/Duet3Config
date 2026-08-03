// G-code emission helpers shared by the machining and probing generators.
//
// Everything these produce is plain RS-274 that any controller understands —
// no RepRapFirmware expressions, no macro calls. That keeps generated programs
// inspectable, portable to the Makera when its driver lands, and previewable in
// the same viewer that renders files off the machine.

export interface GeneratedProgram {
  /** Suggested filename, without a directory. */
  name: string;
  gcode: string;
  /** One-line human description shown before running. */
  summary: string;
  /** Anything the operator should read before pressing go. */
  warnings: string[];
}

/** Trim a number to a sane number of decimals without trailing zeros. */
export function n(v: number, places = 3): string {
  if (!isFinite(v)) return '0';
  const s = v.toFixed(places);
  return s.replace(/\.?0+$/, '') || '0';
}

export class Gcode {
  private lines: string[] = [];

  comment(text: string): this {
    this.lines.push(`( ${text.replace(/[()]/g, '')} )`);
    return this;
  }

  blank(): this {
    this.lines.push('');
    return this;
  }

  raw(line: string): this {
    this.lines.push(line);
    return this;
  }

  /** Preamble common to every generated program. */
  header(title: string, notes: string[] = []): this {
    this.comment(title);
    for (const note of notes) this.comment(note);
    this.raw('G21 G90 G17 G94');
    return this;
  }

  rapid(p: { x?: number; y?: number; z?: number }): this {
    return this.move('G0', p);
  }

  feed(p: { x?: number; y?: number; z?: number; f?: number }): this {
    return this.move('G1', p);
  }

  private move(code: string, p: { x?: number; y?: number; z?: number; f?: number }): this {
    let s = code;
    if (p.x !== undefined) s += ` X${n(p.x)}`;
    if (p.y !== undefined) s += ` Y${n(p.y)}`;
    if (p.z !== undefined) s += ` Z${n(p.z)}`;
    if (p.f !== undefined) s += ` F${n(p.f, 1)}`;
    this.lines.push(s);
    return this;
  }

  /** Arc in the XY plane. `cw` selects G2 vs G3; i/j are centre offsets. */
  arc(cw: boolean, to: { x: number; y: number }, centre: { i: number; j: number }, f?: number): this {
    let s = `${cw ? 'G2' : 'G3'} X${n(to.x)} Y${n(to.y)} I${n(centre.i)} J${n(centre.j)}`;
    if (f !== undefined) s += ` F${n(f, 1)}`;
    this.lines.push(s);
    return this;
  }

  /** Full circle at the current position, centre offset i/j. */
  fullCircle(cw: boolean, i: number, j: number, f?: number): this {
    let s = `${cw ? 'G2' : 'G3'} I${n(i)} J${n(j)}`;
    if (f !== undefined) s += ` F${n(f, 1)}`;
    this.lines.push(s);
    return this;
  }

  spindleOn(rpm: number, dwellSeconds = 3): this {
    this.raw(`M3 S${Math.round(rpm)}`);
    if (dwellSeconds > 0) this.raw(`G4 S${n(dwellSeconds, 1)}`);
    return this;
  }

  spindleOff(): this {
    return this.raw('M5');
  }

  dwell(seconds: number): this {
    return this.raw(`G4 S${n(seconds, 1)}`);
  }

  /**
   * End of program.
   *
   * Deliberately NOT M30. Most CNC posts end a file with it, but in
   * RepRapFirmware M30 is *delete file* and takes a filename — a bare M30
   * throws "expected a non-empty string" and every generated file would finish
   * on an error. M2 is what RRF treats as end-of-job (GCodes2.cpp handles M0,
   * M1 and M2 together, calling StopPrint when the command came from a file).
   *
   * A macro invoked with M98 must emit neither: it ends by running out of
   * lines, and an M2 inside it would stop the job that called it.
   */
  end(kind: 'program' | 'macro' = 'program'): this {
    if (kind === 'program') this.raw('M2');
    return this;
  }

  toString(): string {
    return this.lines.join('\n') + '\n';
  }
}

/** Depth levels from the top surface down to `total`, at most `perPass` each. */
export function depthLevels(zTop: number, total: number, perPass: number): number[] {
  const depth = Math.abs(total);
  const step = Math.max(0.01, Math.abs(perPass));
  const out: number[] = [];
  for (let d = step; d < depth - 1e-6; d += step) out.push(zTop - d);
  out.push(zTop - depth);
  return out;
}
