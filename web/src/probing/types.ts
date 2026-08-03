// Probe roles.
//
// This machine has two physically different probes wired to different inputs
// and used for completely different jobs, and a third is planned that must not
// be conflated with either. So routines declare the ROLE they need rather than
// a probe number, and a role is unusable until a probe is assigned to it.
//
// That is what stops a bore-finding routine from ever firing the tool-length
// setter, and it means the third probe drops in by assigning one more role
// rather than by editing any routine.

import { loadSetting, saveSetting } from '../core/store.js';

export type ProbeRole = 'toolLength' | 'workpiece' | 'feature';

export interface RoleInfo {
  role: ProbeRole;
  label: string;
  description: string;
}

export const ROLES: RoleInfo[] = [
  {
    role: 'toolLength',
    label: 'Tool length',
    description: 'Fixed probe that measures tool length and sets the tool Z offset.',
  },
  {
    role: 'workpiece',
    label: 'Workpiece',
    description: 'Touch probe used to find the stock surface, an edge, or a corner.',
  },
  {
    role: 'feature',
    label: 'Feature',
    description: 'Probe for finding bores, bosses and pocket centres. Must be its own probe.',
  },
];

/** Which controller probe index (the K parameter) serves each role. */
export type ProbeMap = Record<ProbeRole, number | null>;

/**
 * Defaults match this machine's config-probe.g:
 *   M558 K0 ... io5.in  — tool length
 *   M558 K1 ... io3.in  — XYZ workpiece probe
 * No probe is assigned to `feature` yet; routines needing it stay disabled
 * rather than silently borrowing one of the others.
 */
export const DEFAULT_PROBE_MAP: ProbeMap = {
  toolLength: 0,
  workpiece: 1,
  feature: null,
};

export function loadProbeMap(): ProbeMap {
  return { ...DEFAULT_PROBE_MAP, ...loadSetting<Partial<ProbeMap>>('probeMap', {}) };
}

export function saveProbeMap(map: ProbeMap): void {
  saveSetting('probeMap', map);
}

/** Which face of the stock the probe approaches from. */
export type CornerX = 'left' | 'right';
export type CornerY = 'front' | 'back';

export interface ProbeCommon {
  /** Controller probe index for the K parameter. */
  probeIndex: number;
  /** Effective probe tip diameter, used to offset the edge. */
  tipDiameter: number;
  /** Fast search feed, mm/min. */
  feedFast: number;
  /** Slow confirming feed, mm/min. */
  feedSlow: number;
  /** How far to search before giving up, mm. */
  maxTravel: number;
  /** Back-off distance between the fast and slow probe, mm. */
  backoff: number;
  /** Safe Z (work coords) for repositioning moves. */
  safeZ: number;
  /** Work coordinate system to write, 1 = G54. */
  wcs: number;
}

export interface ZProbeParams extends ProbeCommon {
  /** Thickness of a touch plate, or 0 when probing the surface directly. */
  plateThickness: number;
}

export interface EdgeProbeParams extends ProbeCommon {
  axis: 'X' | 'Y';
  /** +1 approaches in the positive direction, -1 in the negative. */
  direction: 1 | -1;
  /** Value to assign to the found edge in the work coordinate system. */
  setTo: number;
}

export interface CornerProbeParams extends ZProbeParams {
  cornerX: CornerX;
  cornerY: CornerY;
  /** How far outside the edge to stand off before probing sideways, mm. */
  clearance: number;
  /** How far below the top surface to probe the sides, mm. */
  probeDepth: number;
  /** Also probe Z on the top face and zero it. */
  includeZ: boolean;
}

export interface ToolLengthParams extends ProbeCommon {
  /** Machine coordinates of the tool setter. */
  probeX: number;
  probeY: number;
  /** Machine Z at which the setter triggers, from atcConfig.g. */
  probeZ: number;
  /** Machine Z to retract to before and after. */
  retractZ: number;
  /** Also drive the dust-shoe axis by the inverse offset. */
  dustShoeAxis: string | null;
}

/**
 * Two-point edge probe that measures how far the stock is rotated, so the
 * coordinate system can be turned to match instead of the stock being
 * re-clamped. Touching the same edge twice cancels the tip radius exactly —
 * both touches are offset by the same amount — so the angle is independent of
 * tip calibration, which the measured sizes elsewhere in this pack are not.
 */
export interface SkewProbeParams extends ProbeCommon {
  /** Which axis the edge nominally runs along. */
  edgeAxis: 'X' | 'Y';
  /** Direction the probe approaches the edge along the perpendicular axis. */
  approach: 1 | -1;
  /** Distance between the two touch points, mm. Longer is more accurate. */
  span: number;
  /** +1 travels in the positive edge-axis direction between the two touches. */
  travel: 1 | -1;
  /** Rotation centre in work coordinates — normally the work origin. */
  centreX: number;
  centreY: number;
  /** Refuse to apply a rotation larger than this, degrees. */
  maxAngle: number;
}

export interface BoreProbeParams extends ProbeCommon {
  /** Nominal diameter, used to size the search moves. */
  nominalDiameter: number;
  /** Outside feature (boss) rather than inside (bore). */
  outside: boolean;
}
