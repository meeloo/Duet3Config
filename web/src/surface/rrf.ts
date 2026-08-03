// Surface scanning, RepRapFirmware dialect.
//
// RRF calls this mesh bed compensation, which is a 3D-printer name for a CNC
// problem: a spoilboard that is not flat, or a sheet that is not flat, and an
// engraving that has to follow it. G29 probes a grid and stores a height map;
// G29 S1 loads it and every subsequent move is Z-corrected against it.
//
// The critical parameter is K. `G29 K<n>` selects which probe does the scanning
// — RRF's ProbeGrid calls SetZProbeNumber(gb, 'K') before anything else — so the
// scan runs on the probe assigned to the `workpiece` role, not on whatever probe
// happens to be number 0. On this machine probe 0 is the tool-length setter, and
// a grid scan that fired it would drive the spindle at the setter N times.
// Nothing here may ever emit a bare G29.

import { n } from '../cam/format.js';

/** Where RRF stores the height map by default. */
export const HEIGHTMAP_PATH = '/sys/heightmap.csv';

export interface ScanArea {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Point spacing, mm. Separate per axis because a long bed rarely needs the
   *  same density along both. */
  spacingX: number;
  spacingY: number;
}

/** Number of points a scan of this area will probe. */
export function scanPointCount(area: ScanArea): { x: number; y: number; total: number } {
  const span = (a: number, b: number, s: number) =>
    Math.max(2, Math.floor(Math.abs(b - a) / Math.max(0.1, s)) + 1);
  const x = span(area.x0, area.x1, area.spacingX);
  const y = span(area.y0, area.y1, area.spacingY);
  return { x, y, total: x * y };
}

/**
 * Define the probing grid.
 *
 * M557 takes the area in *machine* coordinates on a printer, but RRF applies it
 * in the current workplace like every other coordinate, so the numbers here are
 * the same work coordinates the rest of the UI speaks.
 */
export function defineGridCommand(area: ScanArea): string {
  const lo = (a: number, b: number) => Math.min(a, b);
  const hi = (a: number, b: number) => Math.max(a, b);
  return (
    `M557 X${n(lo(area.x0, area.x1))}:${n(hi(area.x0, area.x1))} ` +
    `Y${n(lo(area.y0, area.y1))}:${n(hi(area.y0, area.y1))} ` +
    `S${n(area.spacingX)}:${n(area.spacingY)}`
  );
}

/** Probe the grid and save the height map. K selects the probe — never omit it. */
export function scanCommand(probeIndex: number): string {
  return `G29 K${probeIndex} S0`;
}

/** Load the stored map and switch compensation on. */
export function applyCommand(path = HEIGHTMAP_PATH): string {
  return `G29 S1 P"${path}"`;
}

/** Switch compensation off. The map file is left alone. */
export const CLEAR_COMMAND = 'G29 S2';

/**
 * How long a scan will take, very roughly.
 *
 * Every point is a dive and a retract at probing speed plus a traverse, and
 * RRF's own overheads per point are not small. This is a floor, offered only so
 * "300 points" turns into "about half an hour" before someone starts one.
 */
export function estimateScanSeconds(
  points: number,
  diveHeight: number,
  probeFeed: number,
  travelFeed: number,
  spacing: number,
): number {
  const dive = (2 * diveHeight) / Math.max(1, probeFeed / 60);
  const travel = spacing / Math.max(1, travelFeed / 60);
  return points * (dive + travel + 0.6);
}
