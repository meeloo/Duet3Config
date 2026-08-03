// Holding tabs on a cut-out contour.
//
// A part cut all the way through comes loose on the last pass and the tool
// throws it. Tabs are short bridges of material left under the cutter so the
// part stays put until it is knifed out by hand.
//
// The machinery here is deliberately about a closed polyline rather than about
// rectangles, so the same code serves a rectangular cut-out and a circle
// approximated as a fine polygon. Everything is parameterised by arc length
// along the loop, which is what makes "six tabs, evenly spaced" mean the same
// thing on both.

import { Gcode, n } from './format.js';

export type Point = [number, number];

export interface TabSpec {
  /** Number of tabs spaced evenly around the loop. 0 disables tabs entirely. */
  count: number;
  /** Flat length of each tab along the path, mm. */
  width: number;
  /** Material left under the tool at the tab, mm. */
  height: number;
}

/** Cumulative arc length at each vertex, plus the closing edge. */
function arcLengths(pts: Point[]): { at: number[]; total: number } {
  const at = [0];
  let total = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    at.push(total);
  }
  return { at, total };
}

/** Point at arc position `s` along the closed loop. */
function pointAt(pts: Point[], at: number[], total: number, s: number): Point {
  const t = ((s % total) + total) % total;
  let i = 0;
  while (i < pts.length - 1 && at[i + 1] < t) i++;
  const a = pts[i];
  const b = pts[(i + 1) % pts.length];
  const segment = at[i + 1] - at[i];
  const f = segment <= 1e-9 ? 0 : (t - at[i]) / segment;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Shortest distance from `s` to `centre` going either way round the loop. */
function circularDistance(s: number, centre: number, total: number): number {
  const d = (((s - centre) % total) + total) % total;
  return Math.min(d, total - d);
}

/**
 * Regular polygon approximating a circle, fine enough that the chord never
 * deviates from the true radius by more than `tolerance`.
 *
 * Used only when a circular cut-out needs tabs: without them the contour stays
 * a pair of real G2/G3 arcs, which is both shorter and rounder.
 */
export function circlePolygon(
  cx: number,
  cy: number,
  radius: number,
  clockwise: boolean,
  tolerance = 0.01,
): Point[] {
  const ratio = Math.max(-1, Math.min(1, 1 - tolerance / Math.max(radius, tolerance)));
  const segments = Math.max(24, Math.ceil(Math.PI / Math.acos(ratio)));
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = ((clockwise ? -1 : 1) * 2 * Math.PI * i) / segments;
    pts.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return pts;
}

export interface LoopCutOptions {
  /** Full depth for this pass. */
  z: number;
  /** Z to ride at across a tab, or null for no tabs. */
  tabZ: number | null;
  tabs: TabSpec;
  feed: number;
  plungeFeed: number;
  toolDiameter: number;
  /**
   * Height the descent starts from — the level above, or the stock top. With
   * `rampLength` this is the top of the ramp.
   */
  entryZ?: number;
  /**
   * Descend over this many mm of travel along the loop instead of plunging
   * straight down. A profile cut enters buried in material on every pass after
   * the first, and a flat end mill driven vertically into that at plunge feed
   * is how end mills die. 0 keeps the plunge, for a centre-cutting tool.
   */
  rampLength?: number;
}

/**
 * Cut one closed loop at depth `z`, lifting to `tabZ` across each tab.
 *
 * The loop is emitted as moves between "marks": every vertex, plus the four
 * boundaries of every tab (ramp start, flat start, flat end, ramp end). Because
 * Z is linear in arc length between consecutive marks, emitting the exact Z at
 * each mark and letting the controller interpolate gives ramps in and out of
 * the tab for free — no sampling, no stepped approximation.
 *
 * The tab ramp is what stops the tool from being asked to climb vertically out
 * of the cut at feed rate. It is one tool diameter long, or half the tab if the
 * tab is narrower than that.
 *
 * An entry ramp, when asked for, rides the same machinery: the first
 * `rampLength` of the walk interpolates from `entryZ` down to the depth that
 * position calls for, and the loop then continues past its start to level that
 * stretch off. Entry ramps and tabs never collide because tabs sit half a
 * spacing in from the seam and the entry is at it.
 */
export function cutLoopWithTabs(g: Gcode, pts: Point[], o: LoopCutOptions): void {
  const { z, tabZ, tabs, feed, plungeFeed, toolDiameter } = o;
  const { at, total } = arcLengths(pts);
  const useTabs = tabZ !== null && tabs.count > 0 && tabs.width > 0 && tabZ > z + 1e-6;
  const entryZ = o.entryZ ?? z;
  const ramp = Math.min(Math.max(0, o.rampLength ?? 0), total / 2);
  const descending = ramp > 0 && entryZ > z + 1e-6;

  if (!useTabs && !descending) {
    g.rapid({ x: pts[0][0], y: pts[0][1] });
    g.feed({ z, f: plungeFeed });
    for (let i = 1; i <= pts.length; i++) {
      const p = pts[i % pts.length];
      g.feed({ x: p[0], y: p[1], f: feed });
    }
    return;
  }

  const half = Math.min(tabs.width, total / Math.max(1, tabs.count) / 2) / 2;
  const tabRamp = Math.min(Math.max(toolDiameter, 0.5), half * 2);
  // Half a spacing in, not on the seam: on a rectangle that lands one tab in
  // the middle of each side instead of straddling the corners, and it keeps the
  // entry plunge off a tab, where it would only reach tab depth.
  const centres = Array.from({ length: tabs.count }, (_, i) => (total * (i + 0.5)) / tabs.count);

  /** Depth at arc position `s`, ignoring the entry ramp. */
  const zAt = (s: number): number => {
    let best = z;
    if (!useTabs) return best;
    for (const c of centres) {
      const d = circularDistance(s, c, total);
      if (d <= half) best = Math.max(best, tabZ!);
      else if (d <= half + tabRamp) {
        const f = 1 - (d - half) / tabRamp;
        best = Math.max(best, z + (tabZ! - z) * f);
      }
    }
    return best;
  };

  /** Depth including the entry ramp, which only affects the first pass round. */
  const zEntry = (s: number): number =>
    descending && s < ramp ? entryZ + (zAt(s) - entryZ) * (s / ramp) : zAt(s);

  const marks = new Set<number>(at.map((v) => Math.min(v, total)));
  if (useTabs) {
    for (const c of centres) {
      for (const offset of [-half - tabRamp, -half, half, half + tabRamp]) {
        marks.add((((c + offset) % total) + total) % total);
      }
    }
  }
  if (descending) marks.add(ramp);
  const ordered = [...marks]
    .sort((a, b) => a - b)
    .filter((s, i, arr) => i === 0 || s - arr[i - 1] > 1e-6);

  const start = pointAt(pts, at, total, 0);
  g.rapid({ x: start[0], y: start[1] });
  g.feed({ z: zEntry(0), f: plungeFeed });

  const stops = ordered.filter((v) => v > 1e-6);
  if (stops[stops.length - 1] < total - 1e-6) stops.push(total);
  for (const s of stops) {
    const p = pointAt(pts, at, total, s);
    g.feed({ x: p[0], y: p[1], z: zEntry(s >= total - 1e-6 ? 0 : s), f: feed });
  }

  // The stretch we ramped down over is still high. Go round it once more at the
  // depth it should have been, so the pass closes at a uniform height.
  if (descending) {
    for (const s of [...stops.filter((v) => v < ramp - 1e-6), ramp]) {
      const p = pointAt(pts, at, total, s);
      g.feed({ x: p[0], y: p[1], z: zAt(s), f: feed });
    }
  }
}

/**
 * Human-readable note about what the tabs will leave behind.
 *
 * Takes the resolved `tabZ` rather than recomputing it, so a tab spec that was
 * rejected as impossible cannot still be described as if it were going to
 * happen.
 */
export function describeTabs(tabs: TabSpec, tabZ: number | null): string {
  if (tabZ === null) return 'no tabs';
  return `${tabs.count} tabs, ${n(tabs.width)}mm wide, leaving ${n(tabs.height)}mm at Z${n(tabZ)}`;
}
