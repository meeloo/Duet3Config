// The machining pack: parameterised operations that emit a complete program.
//
// These replace hand-edited constants at the top of a macro file — the same job
// flattenSpoilboard.g and "Plane Stock.g" do today, but with the numbers in a
// form you fill in and a toolpath you can look at before it cuts.
//
// Pure functions of their parameters: no driver, no network, no controller
// dialect. That makes them trivially previewable and portable to any machine.

import { Gcode, depthLevels, type GeneratedProgram } from './format.js';

export interface CommonParams {
  toolDiameter: number;
  /** Top of the material in work coordinates (usually 0 after probing). */
  zTop: number;
  /** Total depth to remove, positive. */
  depth: number;
  /** Maximum depth per pass, positive. */
  depthPerPass: number;
  feedRate: number;
  plungeFeed: number;
  rpm: number;
  /** Clearance height for rapids, in work coordinates. */
  safeZ: number;
  /** Seconds to wait after starting the spindle. */
  spindleDwell: number;
}

export interface FacingParams extends CommonParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Fraction of tool diameter to step over, 0..1. */
  stepover: number;
  /** Raster along X or Y. */
  along: 'x' | 'y';
}

/**
 * Raster facing / surfacing.
 *
 * The tool centre runs from (edge + radius) to (edge - radius) on both axes, so
 * the cut covers exactly the rectangle you asked for — no overhang, no missed
 * strip at the boundary. If the area is narrower than the tool on either axis,
 * a single centred pass is emitted instead.
 */
export function facing(p: FacingParams): GeneratedProgram {
  const warnings: string[] = [];
  const r = p.toolDiameter / 2;

  const xLo = Math.min(p.x0, p.x1);
  const xHi = Math.max(p.x0, p.x1);
  const yLo = Math.min(p.y0, p.y1);
  const yHi = Math.max(p.y0, p.y1);

  // Tool-centre travel limits.
  const span = (lo: number, hi: number): [number, number] => {
    const a = lo + r;
    const b = hi - r;
    if (a > b) {
      // Narrower than the tool — one centred pass.
      const mid = (lo + hi) / 2;
      return [mid, mid];
    }
    return [a, b];
  };

  const [cutLo, cutHi] = p.along === 'x' ? span(xLo, xHi) : span(yLo, yHi);
  const [stepLo, stepHi] = p.along === 'x' ? span(yLo, yHi) : span(xLo, xHi);

  if (xHi - xLo < p.toolDiameter || yHi - yLo < p.toolDiameter) {
    warnings.push('Area is narrower than the tool on at least one axis — a single pass is used there.');
  }

  const stepover = Math.max(0.1, p.toolDiameter * p.stepover);
  const stepSpan = stepHi - stepLo;
  const passes = stepSpan <= 1e-9 ? 1 : Math.ceil(stepSpan / stepover) + 1;
  const actualStep = passes > 1 ? stepSpan / (passes - 1) : 0;

  const levels = depthLevels(p.zTop, p.depth, p.depthPerPass);

  const g = new Gcode();
  g.header('Facing', [
    `area X${xLo}..${xHi} Y${yLo}..${yHi}`,
    `tool ${p.toolDiameter}mm, stepover ${Math.round(p.stepover * 100)}% (${actualStep.toFixed(2)}mm)`,
    `${levels.length} depth pass(es) to ${p.depth}mm, ${passes} pass(es) across`,
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  for (const z of levels) {
    g.blank();
    g.comment(`depth ${z.toFixed(3)}`);

    // Start each level at the first raster line.
    const first = p.along === 'x' ? { x: cutLo, y: stepLo } : { x: stepLo, y: cutLo };
    g.rapid({ x: first.x, y: first.y });
    g.feed({ z, f: p.plungeFeed });

    for (let i = 0; i < passes; i++) {
      const s = stepLo + actualStep * i;
      // Serpentine: alternate direction so we don't rapid back each line.
      const forward = i % 2 === 0;
      const from = forward ? cutLo : cutHi;
      const to = forward ? cutHi : cutLo;

      if (p.along === 'x') {
        g.feed({ x: from, y: s, f: p.feedRate });
        g.feed({ x: to, f: p.feedRate });
      } else {
        g.feed({ x: s, y: from, f: p.feedRate });
        g.feed({ y: to, f: p.feedRate });
      }
    }
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'facing.nc',
    gcode: g.toString(),
    summary:
      `Face ${(xHi - xLo).toFixed(1)} x ${(yHi - yLo).toFixed(1)}mm, ` +
      `${p.depth}mm deep in ${levels.length} pass(es), ${passes} lines`,
    warnings,
  };
}

export type ContourSide = 'inside' | 'outside' | 'on';

export interface RectContourParams extends CommonParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  side: ContourSide;
  /** Climb milling — affects direction of travel. */
  climb: boolean;
}

/** Rectangular contour, offset to the inside, outside, or cut on the line. */
export function rectContour(p: RectContourParams): GeneratedProgram {
  const warnings: string[] = [];
  const r = p.toolDiameter / 2;
  const off = p.side === 'inside' ? -r : p.side === 'outside' ? r : 0;

  const xLo = Math.min(p.x0, p.x1) - off;
  const xHi = Math.max(p.x0, p.x1) + off;
  const yLo = Math.min(p.y0, p.y1) - off;
  const yHi = Math.max(p.y0, p.y1) + off;

  if (xHi <= xLo || yHi <= yLo) {
    warnings.push('Tool is too large for an inside contour of this rectangle.');
  }

  const levels = depthLevels(p.zTop, p.depth, p.depthPerPass);
  const g = new Gcode();
  g.header('Rectangular contour', [
    `rect X${p.x0}..${p.x1} Y${p.y0}..${p.y1}, ${p.side} of line`,
    `tool ${p.toolDiameter}mm, ${levels.length} depth pass(es) to ${p.depth}mm`,
    p.climb ? 'climb milling' : 'conventional milling',
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });
  g.rapid({ x: xLo, y: yLo });

  // Corner order: CCW is climb for an outside cut, CW for an inside one.
  const ccw = p.side === 'inside' ? !p.climb : p.climb;
  const corners: Array<[number, number]> = ccw
    ? [[xLo, yLo], [xHi, yLo], [xHi, yHi], [xLo, yHi]]
    : [[xLo, yLo], [xLo, yHi], [xHi, yHi], [xHi, yLo]];

  for (const z of levels) {
    g.blank();
    g.comment(`depth ${z.toFixed(3)}`);
    g.rapid({ x: corners[0][0], y: corners[0][1] });
    g.feed({ z, f: p.plungeFeed });
    for (let i = 1; i <= 4; i++) {
      const [cx, cy] = corners[i % 4];
      g.feed({ x: cx, y: cy, f: p.feedRate });
    }
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'contour-rect.nc',
    gcode: g.toString(),
    summary: `${p.side} contour of ${Math.abs(p.x1 - p.x0).toFixed(1)} x ${Math.abs(p.y1 - p.y0).toFixed(1)}mm, ${p.depth}mm deep`,
    warnings,
  };
}

export interface CircleParams extends CommonParams {
  cx: number;
  cy: number;
  diameter: number;
  side: ContourSide;
  climb: boolean;
  /** Clear the whole interior rather than just cutting the outline. */
  pocket: boolean;
  /** Fraction of tool diameter to step over when pocketing, 0..1. */
  stepover: number;
}

/** Circular contour, or a spiral-cleared circular pocket. */
export function circle(p: CircleParams): GeneratedProgram {
  const warnings: string[] = [];
  const r = p.toolDiameter / 2;
  const target = p.diameter / 2;
  const off = p.side === 'inside' ? -r : p.side === 'outside' ? r : 0;
  const pathR = target + off;

  if (pathR <= 0) {
    warnings.push('Tool is larger than the circle — nothing to cut.');
  }
  if (p.pocket && p.side !== 'inside') {
    warnings.push('Pocketing clears the interior, so the inside offset is used.');
  }

  const levels = depthLevels(p.zTop, p.depth, p.depthPerPass);
  const stepover = Math.max(0.1, p.toolDiameter * p.stepover);
  const g = new Gcode();

  g.header(p.pocket ? 'Circular pocket' : 'Circular contour', [
    `centre X${p.cx} Y${p.cy}, diameter ${p.diameter}mm, ${p.side} of line`,
    `tool ${p.toolDiameter}mm, ${levels.length} depth pass(es) to ${p.depth}mm`,
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  const cw = !p.climb;
  const effR = p.pocket ? target - r : pathR;

  for (const z of levels) {
    g.blank();
    g.comment(`depth ${z.toFixed(3)}`);

    if (p.pocket) {
      // Plunge at the centre, then widen in steps out to the wall.
      g.rapid({ x: p.cx, y: p.cy });
      g.feed({ z, f: p.plungeFeed });
      const rings = Math.max(1, Math.ceil(effR / stepover));
      for (let i = 1; i <= rings; i++) {
        const ringR = (effR * i) / rings;
        g.feed({ x: p.cx + ringR, y: p.cy, f: p.feedRate });
        g.fullCircle(cw, -ringR, 0, p.feedRate);
      }
    } else {
      g.rapid({ x: p.cx + effR, y: p.cy });
      g.feed({ z, f: p.plungeFeed });
      g.fullCircle(cw, -effR, 0, p.feedRate);
    }
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: p.pocket ? 'pocket-circle.nc' : 'contour-circle.nc',
    gcode: g.toString(),
    summary: `${p.pocket ? 'Pocket' : 'Contour'} ⌀${p.diameter}mm at X${p.cx} Y${p.cy}, ${p.depth}mm deep`,
    warnings,
  };
}
