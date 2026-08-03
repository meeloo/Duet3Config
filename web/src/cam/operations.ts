// The machining pack: parameterised operations that emit a complete program.
//
// These replace hand-edited constants at the top of a macro file — the same job
// flattenSpoilboard.g and "Plane Stock.g" do today, but with the numbers in a
// form you fill in and a toolpath you can look at before it cuts.
//
// Pure functions of their parameters: no driver, no network, no controller
// dialect. That makes them trivially previewable and portable to any machine.

import { Gcode, depthLevels, n, type GeneratedProgram } from './format.js';
import { circlePolygon, cutLoopWithTabs, describeTabs, type Point, type TabSpec } from './tabs.js';

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
  /** Holding tabs. `count: 0` cuts straight through. */
  tabs: TabSpec;
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
  const tabZ = tabTop(p, p.tabs, warnings);

  const g = new Gcode();
  g.header('Rectangular contour', [
    `rect X${p.x0}..${p.x1} Y${p.y0}..${p.y1}, ${p.side} of line`,
    `tool ${p.toolDiameter}mm, ${levels.length} depth pass(es) to ${p.depth}mm`,
    p.climb ? 'climb milling' : 'conventional milling',
    describeTabs(p.tabs, tabZ),
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  // Corner order: CCW is climb for an outside cut, CW for an inside one.
  const ccw = p.side === 'inside' ? !p.climb : p.climb;
  const corners: Point[] = ccw
    ? [[xLo, yLo], [xHi, yLo], [xHi, yHi], [xLo, yHi]]
    : [[xLo, yLo], [xLo, yHi], [xHi, yHi], [xHi, yLo]];

  for (const z of levels) {
    g.blank();
    g.comment(`depth ${z.toFixed(3)}`);
    g.rapid({ z: p.safeZ });
    cutLoopWithTabs(g, corners, {
      z,
      tabZ,
      tabs: p.tabs,
      feed: p.feedRate,
      plungeFeed: p.plungeFeed,
      toolDiameter: p.toolDiameter,
    });
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'contour-rect.nc',
    gcode: g.toString(),
    summary:
      `${p.side} contour of ${Math.abs(p.x1 - p.x0).toFixed(1)} x ${Math.abs(p.y1 - p.y0).toFixed(1)}mm, ` +
      `${p.depth}mm deep, ${describeTabs(p.tabs, tabZ)}`,
    warnings,
  };
}

/**
 * Z the tool rides at across a tab, or null when tabs are off or pointless.
 *
 * Tabs taller than the cut leave the contour uncut, and tabs on a cut that
 * never reaches the bottom of the stock hold nothing — both are much more
 * likely to be a typo than an intention, so they are called out rather than
 * silently obeyed.
 */
function tabTop(
  p: { zTop: number; depth: number },
  tabs: TabSpec,
  warnings: string[],
): number | null {
  if (tabs.count <= 0 || tabs.width <= 0 || tabs.height <= 0) return null;
  if (tabs.height >= p.depth) {
    warnings.push(
      `Tab height (${n(tabs.height)}mm) is not less than the cut depth (${n(p.depth)}mm) — the contour would never be cut. Tabs ignored.`,
    );
    return null;
  }
  return p.zTop - p.depth + tabs.height;
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
  /** Holding tabs. Ignored when pocketing — a pocket has nothing to hold. */
  tabs: TabSpec;
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
  const tabZ = p.pocket ? null : tabTop(p, p.tabs, warnings);
  const g = new Gcode();

  g.header(p.pocket ? 'Circular pocket' : 'Circular contour', [
    `centre X${p.cx} Y${p.cy}, diameter ${p.diameter}mm, ${p.side} of line`,
    `tool ${p.toolDiameter}mm, ${levels.length} depth pass(es) to ${p.depth}mm`,
    ...(p.pocket ? [] : [describeTabs(p.tabs, tabZ)]),
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
    } else if (tabZ === null) {
      g.rapid({ x: p.cx + effR, y: p.cy });
      g.feed({ z, f: p.plungeFeed });
      g.fullCircle(cw, -effR, 0, p.feedRate);
    } else {
      // Tabs need Z to vary along the path, which an arc cannot express. Only
      // then is the circle traded for a polygon fine enough that the chord
      // error stays under 0.01mm.
      g.rapid({ z: p.safeZ });
      cutLoopWithTabs(g, circlePolygon(p.cx, p.cy, effR, cw), {
        z,
        tabZ,
        tabs: p.tabs,
        feed: p.feedRate,
        plungeFeed: p.plungeFeed,
        toolDiameter: p.toolDiameter,
      });
    }
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: p.pocket ? 'pocket-circle.nc' : 'contour-circle.nc',
    gcode: g.toString(),
    summary:
      `${p.pocket ? 'Pocket' : 'Contour'} ⌀${p.diameter}mm at X${p.cx} Y${p.cy}, ${p.depth}mm deep` +
      (p.pocket ? '' : `, ${describeTabs(p.tabs, tabZ)}`),
    warnings,
  };
}

export interface RectPocketParams extends CommonParams {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Fraction of tool diameter to step over, 0..1. */
  stepover: number;
  /** Raster along X or Y. */
  along: 'x' | 'y';
  /** Material left on the walls for the finishing loop, mm. */
  finishAllowance: number;
  /** Length of the descending ramp into each level, mm. 0 plunges straight down. */
  rampLength: number;
}

/**
 * Rectangular pocket: raster the interior out, then one finishing loop at the
 * wall.
 *
 * Two things separate this from running `facing` at depth.
 *
 * It never rubs the wall while roughing. The raster is inset by the finish
 * allowance as well as the tool radius, so the full-width cut and the wall
 * finish are different passes and the wall is cut once, at one depth of
 * engagement, by a tool that is not also removing the middle of the pocket.
 *
 * And it ramps in. Facing starts each level in fresh air above the stock;
 * a pocket's second and subsequent levels start buried, and driving a flat
 * end mill straight down into material at plunge feed is how end mills die.
 * The descent is split: a fast plunge through the air of the level already
 * cleared, then a ramp along the first cut line for the new depth of cut.
 */
export function rectPocket(p: RectPocketParams): GeneratedProgram {
  const warnings: string[] = [];
  const r = p.toolDiameter / 2;

  const xLo = Math.min(p.x0, p.x1);
  const xHi = Math.max(p.x0, p.x1);
  const yLo = Math.min(p.y0, p.y1);
  const yHi = Math.max(p.y0, p.y1);

  if (xHi - xLo < p.toolDiameter || yHi - yLo < p.toolDiameter) {
    warnings.push('The pocket is narrower than the tool on at least one axis — nothing can be cut.');
    return {
      name: 'pocket-rect.nc',
      gcode: new Gcode().header('Rectangular pocket', ['tool too large — no output']).toString(),
      summary: 'Tool is larger than the pocket',
      warnings,
    };
  }

  // Wall path: tool centre one radius inside the finished size.
  const wall = { xLo: xLo + r, xHi: xHi - r, yLo: yLo + r, yHi: yHi - r };
  const fa = Math.max(0, p.finishAllowance);
  // Roughing keeps the allowance off the wall; if the pocket is too small for
  // that the allowance is dropped rather than inverting the rectangle.
  const fits = wall.xHi - wall.xLo > 2 * fa && wall.yHi - wall.yLo > 2 * fa;
  if (!fits && fa > 0) {
    warnings.push('Pocket too small for the finish allowance — roughing straight to the wall.');
  }
  const inset = fits ? fa : 0;
  const rough = {
    xLo: wall.xLo + inset,
    xHi: wall.xHi - inset,
    yLo: wall.yLo + inset,
    yHi: wall.yHi - inset,
  };

  const cutLo = p.along === 'x' ? rough.xLo : rough.yLo;
  const cutHi = p.along === 'x' ? rough.xHi : rough.yHi;
  const stepLo = p.along === 'x' ? rough.yLo : rough.xLo;
  const stepHi = p.along === 'x' ? rough.yHi : rough.xHi;

  const stepover = Math.max(0.1, p.toolDiameter * p.stepover);
  const stepSpan = Math.max(0, stepHi - stepLo);
  const passes = stepSpan <= 1e-9 ? 1 : Math.ceil(stepSpan / stepover) + 1;
  const actualStep = passes > 1 ? stepSpan / (passes - 1) : 0;

  const cutSpan = Math.max(0, cutHi - cutLo);
  let ramp = Math.max(0, p.rampLength);
  if (ramp > cutSpan) {
    ramp = cutSpan;
    if (cutSpan > 0) warnings.push('Ramp is longer than the pocket — shortened to one full pass.');
  }
  if (ramp <= 0) {
    warnings.push('No ramp: the tool plunges straight down at each level. Use a centre-cutting tool.');
  }

  const levels = depthLevels(p.zTop, p.depth, p.depthPerPass);
  const g = new Gcode();
  g.header('Rectangular pocket', [
    `pocket X${xLo}..${xHi} Y${yLo}..${yHi}`,
    `tool ${p.toolDiameter}mm, stepover ${Math.round(p.stepover * 100)}% (${actualStep.toFixed(2)}mm)`,
    `${levels.length} depth pass(es) to ${p.depth}mm, ${passes} raster line(s)`,
    inset > 0 ? `${inset}mm finish allowance, cleaned up by a final wall loop` : 'no finish allowance',
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  let previousZ = p.zTop;
  for (const z of levels) {
    g.blank();
    g.comment(`depth ${z.toFixed(3)}`);

    const first = p.along === 'x' ? { x: cutLo, y: stepLo } : { x: stepLo, y: cutLo };
    g.rapid({ z: p.safeZ });
    g.rapid({ x: first.x, y: first.y });
    // Down through what the previous level already removed — air, so fast.
    if (previousZ < p.zTop) g.feed({ z: previousZ, f: p.plungeFeed });

    if (ramp > 0) {
      const rampEnd = cutLo + ramp;
      g.feed(p.along === 'x' ? { x: rampEnd, z, f: p.feedRate } : { y: rampEnd, z, f: p.feedRate });
      // Back to the line start at depth, so the raster below is uniform.
      g.feed(p.along === 'x' ? { x: cutLo, f: p.feedRate } : { y: cutLo, f: p.feedRate });
    } else {
      g.feed({ z, f: p.plungeFeed });
    }

    for (let i = 0; i < passes; i++) {
      const sPos = stepLo + actualStep * i;
      const forward = i % 2 === 0;
      const from = forward ? cutLo : cutHi;
      const to = forward ? cutHi : cutLo;
      if (p.along === 'x') {
        g.feed({ x: from, y: sPos, f: p.feedRate });
        g.feed({ x: to, f: p.feedRate });
      } else {
        g.feed({ x: sPos, y: from, f: p.feedRate });
        g.feed({ y: to, f: p.feedRate });
      }
    }

    // Finishing loop at the wall, at this level's depth.
    g.comment('wall');
    const loop: Point[] = [
      [wall.xLo, wall.yLo],
      [wall.xHi, wall.yLo],
      [wall.xHi, wall.yHi],
      [wall.xLo, wall.yHi],
    ];
    for (let i = 0; i <= 4; i++) {
      const [x, y] = loop[i % 4];
      g.feed({ x, y, f: p.feedRate });
    }

    previousZ = z;
  }

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'pocket-rect.nc',
    gcode: g.toString(),
    summary:
      `Pocket ${(xHi - xLo).toFixed(1)} x ${(yHi - yLo).toFixed(1)}mm, ` +
      `${p.depth}mm deep in ${levels.length} pass(es), ${passes} raster line(s) + wall`,
    warnings,
  };
}

/** How far above the previous peck to switch from rapid back to feed, mm. */
const PECK_CLEARANCE = 0.5;

export type DrillPattern = 'grid' | 'line' | 'bolt';

export interface DrillParams extends CommonParams {
  pattern: DrillPattern;
  /** First hole / line start / bolt-circle centre. */
  x0: number;
  y0: number;
  /** grid: hole counts and spacing. */
  countX: number;
  countY: number;
  spacingX: number;
  spacingY: number;
  /** line: end point, and how many holes including both ends. */
  x1: number;
  y1: number;
  count: number;
  /** bolt: circle the holes sit on, and where the first one goes. */
  boltDiameter: number;
  startAngle: number;
  /** Height to pull back to between pecks, in work coordinates. */
  retract: number;
  /** Pause at full depth before retracting, seconds. */
  dwellAtBottom: number;
}

/** Hole centres for a pattern, in the order they are drilled. */
function drillPoints(p: DrillParams): Point[] {
  switch (p.pattern) {
    case 'grid': {
      const out: Point[] = [];
      const nx = Math.max(1, Math.round(p.countX));
      const ny = Math.max(1, Math.round(p.countY));
      for (let j = 0; j < ny; j++) {
        // Serpentine by row so the tool doesn't fly back across the work.
        for (let i = 0; i < nx; i++) {
          const col = j % 2 === 0 ? i : nx - 1 - i;
          out.push([p.x0 + col * p.spacingX, p.y0 + j * p.spacingY]);
        }
      }
      return out;
    }
    case 'line': {
      const count = Math.max(1, Math.round(p.count));
      if (count === 1) return [[p.x0, p.y0]];
      return Array.from({ length: count }, (_, i): Point => {
        const f = i / (count - 1);
        return [p.x0 + (p.x1 - p.x0) * f, p.y0 + (p.y1 - p.y0) * f];
      });
    }
    case 'bolt': {
      const count = Math.max(1, Math.round(p.count));
      const radius = p.boltDiameter / 2;
      return Array.from({ length: count }, (_, i): Point => {
        const a = ((p.startAngle + (360 * i) / count) * Math.PI) / 180;
        return [p.x0 + radius * Math.cos(a), p.y0 + radius * Math.sin(a)];
      });
    }
  }
}

/**
 * Peck drilling over a pattern of holes.
 *
 * Written as explicit moves rather than a G81/G83 canned cycle: RepRapFirmware
 * does not implement the drilling cycles, and expanding them here means the
 * viewer shows the real motion and the same file runs anywhere.
 *
 * Each peck retracts to the retract plane rather than backing off a token
 * amount, which is what actually clears the flutes — the point of pecking.
 */
export function drillPattern(p: DrillParams): GeneratedProgram {
  const warnings: string[] = [];
  const holes = drillPoints(p);
  const levels = depthLevels(p.zTop, p.depth, p.depthPerPass);

  if (p.retract <= p.zTop) {
    warnings.push('Retract height is at or below the stock top — pecking will not clear the flutes.');
  }
  if (p.retract > p.safeZ) {
    warnings.push('Retract height is above safe Z; rapids between holes use safe Z regardless.');
  }

  const g = new Gcode();
  g.header('Drilling', [
    `${holes.length} hole(s), ${p.pattern} pattern`,
    `tool ${p.toolDiameter}mm, ${p.depth}mm deep in ${levels.length} peck(s)`,
    `retract to Z${n(p.retract)} between pecks`,
  ]);
  g.blank();
  g.spindleOn(p.rpm, p.spindleDwell);
  g.rapid({ z: p.safeZ });

  holes.forEach(([x, y], i) => {
    g.blank();
    g.comment(`hole ${i + 1} of ${holes.length}`);
    g.rapid({ z: p.safeZ });
    g.rapid({ x, y });
    g.rapid({ z: p.retract });
    let reached = p.zTop;
    levels.forEach((z, k) => {
      // Rapid back down to just above the last peck, then cut only the new
      // depth. Feeding the whole way from the retract plane each time would
      // spend most of the cycle at plunge feed through an empty hole.
      if (reached < p.zTop) g.rapid({ z: reached + PECK_CLEARANCE });
      g.feed({ z, f: p.plungeFeed });
      if (k === levels.length - 1 && p.dwellAtBottom > 0) g.dwell(p.dwellAtBottom);
      g.rapid({ z: p.retract });
      reached = z;
    });
  });

  g.blank();
  g.rapid({ z: p.safeZ });
  g.spindleOff();
  g.end();

  return {
    name: 'drill.nc',
    gcode: g.toString(),
    summary: `Drill ${holes.length} hole(s) ⌀${p.toolDiameter}mm, ${p.depth}mm deep, ${levels.length} peck(s) each`,
    warnings,
  };
}
