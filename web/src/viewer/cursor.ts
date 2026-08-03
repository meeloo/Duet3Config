// One place in the program, shared by everything that cares where you are.
//
// Three things move this cursor and they must not fight: the running job pushes
// it from `filePosition`, the time slider drags it, and clicking the toolpath
// drops it somewhere. Before this they were three unrelated notions of
// "position" — the renderer's `progress` byte offset, the picker's
// `resumePoint`, and nothing at all for time — so scrubbing could not feed
// run-from-line and picking could not move the slider.
//
// The cursor is expressed in all three currencies at once. Time is what the
// slider needs, the byte offset is what the controller and run-from-line speak,
// and the point is what gets drawn. Converting between them requires the
// toolpath, so it happens here rather than in each caller.

import { signal } from '../core/signal.js';
import type { ParsedToolpath } from './parse.js';

export type CursorSource = 'job' | 'scrub' | 'pick';

export interface ProgramCursor {
  /** Seconds from the start of the program. */
  seconds: number;
  /** Source byte offset — what the controller and run-from-line speak. */
  offset: number;
  point: [number, number, number];
  /**
   * Which of the three drivers put it here. The UI shows this, because a
   * cursor that moved on its own with no explanation reads as a bug.
   */
  source: CursorSource;
}

export const programCursor = signal<ProgramCursor | null>(null);

/**
 * Wall-clock estimate for a vertex.
 *
 * The parser deliberately leaves rapids untimed — how fast a G0 runs is a
 * property of the machine, not the file — so the rapid rate is supplied here by
 * whoever knows it, and the same toolpath scrubs at a different rate on a
 * different machine without reparsing.
 *
 * @param rapidRate mm/min
 */
function vertexSeconds(path: ParsedToolpath, vertex: number, rapidRate: number): number {
  const rapid = rapidRate > 0 ? (path.rapidMm[vertex] / rapidRate) * 60 : 0;
  return path.times[vertex] + rapid;
}

/** Total estimated run time, seconds. */
export function totalSeconds(path: ParsedToolpath, rapidRate: number): number {
  const last = path.times.length - 1;
  return last < 0 ? 0 : vertexSeconds(path, last, rapidRate);
}

/**
 * The cursor at a given time.
 *
 * Binary search rather than a scan: this runs on every animation frame while
 * the simulation plays, and a linear walk over 200k vertices at 60Hz is
 * 12 million comparisons a second for an answer that is one lookup.
 */
export function cursorAtTime(
  path: ParsedToolpath,
  seconds: number,
  rapidRate: number,
  source: CursorSource = 'scrub',
): ProgramCursor | null {
  const count = path.times.length;
  if (!count) return null;

  const total = totalSeconds(path, rapidRate);
  const t = Math.max(0, Math.min(seconds, total));

  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vertexSeconds(path, mid, rapidRate) < t) lo = mid + 1;
    else hi = mid;
  }

  // `lo` is the first vertex at or after t. Interpolate back into the segment
  // that contains it, so a slow move scrubs smoothly instead of snapping from
  // one end to the other.
  const b = lo;
  const a = Math.max(0, lo - 1);
  const ta = vertexSeconds(path, a, rapidRate);
  const tb = vertexSeconds(path, b, rapidRate);
  const f = tb > ta ? (t - ta) / (tb - ta) : 0;

  const pos = path.positions;
  const point: [number, number, number] = [
    pos[a * 3] + (pos[b * 3] - pos[a * 3]) * f,
    pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * f,
    pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * f,
  ];

  return { seconds: t, offset: path.offsets[b], point, source };
}

/**
 * The cursor at a byte offset — the direction the running job and the picker
 * come from.
 *
 * Offsets are non-decreasing through the file, so the same binary search works.
 * No interpolation: a byte offset identifies a whole G-code line, and every
 * vertex of a long arc shares one, so there is nothing finer to resolve.
 */
export function cursorAtOffset(
  path: ParsedToolpath,
  offset: number,
  rapidRate: number,
  source: CursorSource,
): ProgramCursor | null {
  const count = path.offsets.length;
  if (!count) return null;

  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.offsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }

  const pos = path.positions;
  return {
    seconds: vertexSeconds(path, lo, rapidRate),
    offset: path.offsets[lo],
    point: [pos[lo * 3], pos[lo * 3 + 1], pos[lo * 3 + 2]],
    source,
  };
}
