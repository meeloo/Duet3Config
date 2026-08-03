// Preflight: everything worth knowing before pressing start.
//
// Every fact needed is already in hand — the file is parsed, the machine's
// limits and offsets are in the object model, the tool table is local. Nobody
// checks these together, so the mistakes they catch (a job that runs off the
// bed, a tool that isn't in the changer, a Z zero nobody set) get found by the
// machine instead.
//
// Deliberately advisory, not a gate. It reports; the operator decides. A
// preflight that blocks on a check it got subtly wrong is worse than no
// preflight, because the next thing anyone does is learn to bypass it.

import type { MachineState } from '../machine/types.js';
import type { ParsedToolpath } from '../viewer/parse.js';
import { formatDiameter, getTool, type ToolInfo } from '../tools/table.js';

export type CheckLevel = 'ok' | 'warn' | 'error' | 'info';

export interface Check {
  level: CheckLevel;
  title: string;
  detail: string;
}

export interface PreflightInput {
  path: ParsedToolpath;
  state: MachineState;
  tools: Record<number, ToolInfo>;
  /** ATC slot count, 0 when there is no changer. */
  slotCount: number;
}

const fmt = (v: number, p = 1) => v.toFixed(p);

/** Machine travel limits expressed in work coordinates, like the toolpath. */
function envelope(state: MachineState): { min: number[]; max: number[]; letters: string[] } | null {
  const wanted = ['X', 'Y', 'Z'];
  const axes = wanted.map((l) => state.axes.find((a) => a.letter === l));
  if (axes.some((a) => !a)) return null;
  const min: number[] = [];
  const max: number[] = [];
  for (const a of axes) {
    const offset = a!.machine - a!.work;
    min.push(a!.min - offset);
    max.push(a!.max - offset);
  }
  return { min, max, letters: wanted };
}

export function preflight(input: PreflightInput): Check[] {
  const { path, state, tools, slotCount } = input;
  const checks: Check[] = [];

  // --- Homing ------------------------------------------------------------
  const unhomed = state.axes.filter((a) => !a.homed).map((a) => a.letter);
  checks.push(
    unhomed.length
      ? {
          level: 'error',
          title: 'Axes not homed',
          detail: `${unhomed.join(', ')} ${unhomed.length === 1 ? 'is' : 'are'} not homed. Machine coordinates are meaningless until they are, so the envelope check below cannot be trusted either.`,
        }
      : { level: 'ok', title: 'All axes homed', detail: '' },
  );

  // --- Envelope ----------------------------------------------------------
  const env = envelope(state);
  if (!env) {
    checks.push({ level: 'warn', title: 'Envelope unknown', detail: 'The controller did not report X/Y/Z limits.' });
  } else {
    const over: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (path.min[i] < env.min[i] - 1e-6) {
        over.push(`${env.letters[i]} min by ${fmt(env.min[i] - path.min[i])}mm`);
      }
      if (path.max[i] > env.max[i] + 1e-6) {
        over.push(`${env.letters[i]} max by ${fmt(path.max[i] - env.max[i])}mm`);
      }
    }
    checks.push(
      over.length
        ? {
            level: 'error',
            title: 'Toolpath leaves the work envelope',
            detail: `Exceeds ${over.join(', ')} from the current ${wcsName(state.wcs)} origin. Either the origin is wrong or the job does not fit where it is placed.`,
          }
        : {
            level: 'ok',
            title: 'Fits the envelope',
            detail: `X ${fmt(path.min[0])}..${fmt(path.max[0])}  Y ${fmt(path.min[1])}..${fmt(path.max[1])}  Z ${fmt(path.min[2])}..${fmt(path.max[2])}`,
          },
    );
  }

  // --- Work origin -------------------------------------------------------
  const zAxis = state.axes.find((a) => a.letter === 'Z');
  const originSet = state.axes.some((a) => Math.abs(a.machine - a.work) > 1e-6);
  if (!originSet) {
    checks.push({
      level: 'warn',
      title: `${wcsName(state.wcs)} origin is zero`,
      detail: 'No work offset is set on any axis. If you meant to probe the stock, that has not happened yet.',
    });
  } else if (zAxis && Math.abs(zAxis.machine - zAxis.work) < 1e-6) {
    checks.push({
      level: 'warn',
      title: 'Z origin not set',
      detail: `X and Y have offsets but Z does not. Cutting depth will be measured from machine zero.`,
    });
  } else {
    checks.push({ level: 'ok', title: `${wcsName(state.wcs)} origin set`, detail: '' });
  }

  // --- Tools -------------------------------------------------------------
  if (path.tools.length === 0) {
    checks.push({ level: 'info', title: 'No tool change in the file', detail: 'The job runs with whatever is already loaded.' });
  } else {
    const problems: string[] = [];
    const described: string[] = [];
    for (const t of path.tools) {
      const info = getTool(tools, t);
      const named = info.name || info.diameter > 0;
      if (slotCount > 0 && t > slotCount + 1) {
        problems.push(`T${t} is beyond the ${slotCount}-slot changer`);
      } else if (!named) {
        problems.push(`T${t} has no entry in the tool table`);
      }
      described.push(`T${t}${info.diameter > 0 ? ` ⌀${formatDiameter(info.diameter)}` : ''}${info.name ? ` ${info.name}` : ''}`);
    }
    checks.push(
      problems.length
        ? {
            level: 'warn',
            title: `${path.tools.length} tool(s) required`,
            detail: `${problems.join('; ')}. Check the right cutters are actually in the changer.`,
          }
        : { level: 'ok', title: `${path.tools.length} tool(s) required`, detail: described.join(', ') },
    );
  }

  // --- Spindle -----------------------------------------------------------
  if (state.spindle && path.spindleSpeeds.length) {
    const max = state.spindle.max || 0;
    const min = state.spindle.min || 0;
    const tooFast = path.spindleSpeeds.filter((s) => max > 0 && s > max);
    const tooSlow = path.spindleSpeeds.filter((s) => min > 0 && s < min);
    checks.push(
      tooFast.length || tooSlow.length
        ? {
            level: 'error',
            title: 'Spindle speed out of range',
            detail: `File asks for ${[...tooFast, ...tooSlow].join(', ')} rpm; the spindle runs ${min}–${max}.`,
          }
        : {
            level: 'ok',
            title: 'Spindle speeds in range',
            detail: `${path.spindleSpeeds.join(', ')} rpm`,
          },
    );
  }

  // --- Feed rate ---------------------------------------------------------
  if (path.maxFeed > 0) {
    // Compare against X/Y only. Programmed feeds overwhelmingly govern XY
    // motion, and including Z would flag every ordinary file on a router whose
    // Z is deliberately slower than its gantry — which is every router.
    const planar = state.axes
      .filter((a) => ['X', 'Y'].includes(a.letter) && a.maxFeed > 0);
    const slowest = planar.length ? Math.min(...planar.map((a) => a.maxFeed)) : 0;
    if (slowest > 0 && path.maxFeed > slowest) {
      checks.push({
        level: 'info',
        title: 'Feed exceeds an axis limit',
        detail: `File asks for up to ${fmt(path.maxFeed, 0)} mm/min; X/Y top out at ${fmt(slowest, 0)}. The controller will clamp it — the job just runs slower than programmed.`,
      });
    } else {
      checks.push({ level: 'ok', title: 'Feed rates within limits', detail: `max ${fmt(path.maxFeed, 0)} mm/min` });
    }
  }

  // --- Rapids below the top of stock -------------------------------------
  if (path.rapidLength > 0 && path.minRapidZ < -1e-6) {
    checks.push({
      level: 'warn',
      title: 'Rapids go below Z0',
      detail: `A rapid crosses the work at Z${fmt(path.minRapidZ, 2)}, below the surface. Sometimes intentional, but it is also exactly what a wrong Z origin looks like — worth a glance at the toolpath.`,
    });
  }

  // --- Estimate ----------------------------------------------------------
  const feeds = state.axes.map((a) => a.maxFeed).filter((f) => f > 0);
  const rapidRate = feeds.length ? Math.max(...feeds) : 6000;
  const seconds = path.cutSeconds + (rapidRate > 0 ? (path.rapidLength / rapidRate) * 60 : 0);
  checks.push({
    level: 'info',
    title: 'Estimated run time',
    detail: `${formatSpan(seconds)} — cutting ${formatSpan(path.cutSeconds)}, rapids ${fmt(path.rapidLength / 1000, 1)}m. Ignores acceleration, so treat it as a floor.`,
  });

  // --- Parser warnings ---------------------------------------------------
  if (path.warnings.length) {
    checks.push({
      level: 'warn',
      title: `${path.warnings.length} parser warning(s)`,
      detail: path.warnings.slice(0, 3).join(' · '),
    });
  }

  return checks;
}

function wcsName(wcs: number): string {
  return wcs <= 6 ? `G${53 + wcs}` : `G59.${wcs - 6}`;
}

function formatSpan(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
}

/** Worst level present, for a single overall verdict. */
export function verdict(checks: Check[]): CheckLevel {
  if (checks.some((c) => c.level === 'error')) return 'error';
  if (checks.some((c) => c.level === 'warn')) return 'warn';
  return 'ok';
}
