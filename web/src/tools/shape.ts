// What the cutter looks like, as lines.
//
// A crosshair at the tool tip tells you where the machine thinks it is; it does
// not tell you whether the 28mm slab flattener is going to reach the clamp.
// Drawing the actual cutter is what makes clearance readable at a glance, and
// since a tool is a solid of revolution the whole shape is one 2D profile spun
// around Z — a few dozen line segments, which the overlay renderer already
// draws without needing lighting, materials, or anything else it doesn't have.
//
// Everything here is tip-at-the-origin and +Z up the tool, matching the machine
// frame, so the caller places it by translating to the tool tip and nothing else.
//
// Missing dimensions are guessed rather than refused. A table where seven tools
// out of eight came from a Fusion library and the eighth was typed in from the
// packaging is the normal case, and a tool drawn at a plausible length is far
// more use than a tool not drawn at all.

import type { ToolInfo, ToolType } from './table.js';

export interface ToolShape {
  /** LINES vertices, xyz triples, tip at the origin. */
  vertices: Float32Array;
  /** Per-vertex section: 0 cutting, 1 shank. */
  kinds: Uint8Array;
  /** How far up the tool the drawing reaches, mm. */
  height: number;
  /** Widest radius drawn, mm. */
  radius: number;
}

/** Enough to read as round without spending vertices nobody looks at. */
const MERIDIANS = 8;
const RING_SEGMENTS = 32;
/** Arc subdivision for ball ends and corner radii. */
const ARC_STEPS = 8;

/**
 * Included tip angles to assume when the table has none, by type.
 *
 * These are the common grinds, not universal truths — a 60° V-bit is the usual
 * sign-carving cutter, 118° the usual jobber drill. Anything imported from a
 * library carries its real angle and never reaches these.
 */
const DEFAULT_TIP_ANGLE: Partial<Record<ToolType, number>> = {
  vbit: 60,
  engraver: 30,
  chamfer: 90,
  drill: 118,
};

interface ProfilePoint {
  r: number;
  z: number;
  /** Draw a full circle here, not just the silhouette. */
  ring: boolean;
  /** 0 cutting, 1 shank. */
  kind: 0 | 1;
}

/**
 * The tool's silhouette, from the tip upward.
 *
 * Exported for its own sake: it is the part worth checking against a drawing,
 * and it is far easier to assert on than a flat vertex buffer.
 */
export function toolProfile(info: ToolInfo): ProfilePoint[] | null {
  const diameter = info.diameter;
  if (!(diameter > 0)) return null;

  const g = info.geometry;
  const radius = diameter / 2;
  const shankRadius = g && g.shank > 0 ? g.shank / 2 : radius;
  const flute = g && g.flute > 0 ? g.flute : defaultFlute(diameter, info.type);
  const cornerRadius = Math.min(g?.cornerRadius ?? 0, radius);
  const tipAngle = g && g.tipAngle > 0 ? g.tipAngle : (DEFAULT_TIP_ANGLE[info.type] ?? 0);
  const tipRadius = g && g.tipDiameter > 0 ? Math.min(g.tipDiameter / 2, radius) : 0;

  const points: ProfilePoint[] = [];
  const push = (r: number, z: number, ring = false, kind: 0 | 1 = 0) =>
    points.push({ r, z, ring, kind });

  // --- The end of the tool ------------------------------------------------

  let tipHeight = 0;
  if (info.type === 'ballnose' || cornerRadius >= radius - 1e-6) {
    // A hemisphere: the centre sits one radius up, and the profile is the
    // quarter arc from the pole out to the full diameter.
    for (let i = 0; i <= ARC_STEPS; i++) {
      const a = (Math.PI / 2) * (i / ARC_STEPS);
      push(radius * Math.sin(a), radius - radius * Math.cos(a));
    }
    tipHeight = radius;
  } else if (tipAngle > 0 && tipAngle < 180) {
    // A cone. The angle is the included angle, so half of it is measured from
    // the axis; a truncated V-bit starts at its flat rather than at a point.
    const half = (tipAngle / 2) * (Math.PI / 180);
    tipHeight = (radius - tipRadius) / Math.tan(half);
    push(tipRadius, 0);
    push(radius, tipHeight);
  } else if (cornerRadius > 0) {
    // Bull nose: flat across the middle, then a quarter arc out to full size.
    push(0, 0);
    push(radius - cornerRadius, 0);
    for (let i = 1; i <= ARC_STEPS; i++) {
      const a = (Math.PI / 2) * (i / ARC_STEPS);
      push(radius - cornerRadius + cornerRadius * Math.sin(a), cornerRadius - cornerRadius * Math.cos(a));
    }
    tipHeight = cornerRadius;
  } else {
    push(0, 0);
    push(radius, 0);
  }

  // Ring at the widest point of the end, which is where the tool's footprint
  // actually is — the most useful single circle on the whole drawing.
  points[points.length - 1].ring = true;

  // --- Flutes and shank ---------------------------------------------------

  // A library can report a length of cut shorter than the point it is ground
  // on — a 90° V-bit measured across its flat, for instance. Trust the grind.
  const fluteTop = Math.max(flute, tipHeight * 1.05);
  push(radius, fluteTop, true);

  const length = g && g.length > 0 ? g.length : fluteTop + Math.max(2 * diameter, 20);
  const shankTop = Math.max(length, fluteTop + Math.max(diameter, 3));
  if (Math.abs(shankRadius - radius) > 1e-6) push(shankRadius, fluteTop, false, 1);
  push(shankRadius, shankTop, true, 1);

  return points;
}

/**
 * How long the cutting edge is, when nothing says.
 *
 * Three diameters is the usual proportion for an end mill and holds well from
 * 1mm to 12mm. It falls apart at both extremes — a 28mm slab cutter has a 6mm
 * edge, not an 85mm one — so it is capped, and surfacing cutters get the
 * shallow flute they actually have.
 */
function defaultFlute(diameter: number, type: ToolType): number {
  if (type === 'surfacing') return Math.max(diameter * 0.2, 3);
  return Math.min(diameter * 3, 40);
}

/** The profile spun around Z: silhouette meridians, plus a circle per ring. */
export function toolShape(info: ToolInfo): ToolShape | null {
  const profile = toolProfile(info);
  if (!profile) return null;

  const vertices: number[] = [];
  const kinds: number[] = [];
  const line = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    kind: number,
  ) => {
    vertices.push(ax, ay, az, bx, by, bz);
    kinds.push(kind, kind);
  };

  for (let m = 0; m < MERIDIANS; m++) {
    const a = (2 * Math.PI * m) / MERIDIANS;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    for (let i = 0; i < profile.length - 1; i++) {
      const p = profile[i];
      const q = profile[i + 1];
      line(p.r * cos, p.r * sin, p.z, q.r * cos, q.r * sin, q.z, q.kind);
    }
  }

  for (const p of profile) {
    if (!p.ring || p.r <= 0) continue;
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const a0 = (2 * Math.PI * i) / RING_SEGMENTS;
      const a1 = (2 * Math.PI * (i + 1)) / RING_SEGMENTS;
      line(
        p.r * Math.cos(a0), p.r * Math.sin(a0), p.z,
        p.r * Math.cos(a1), p.r * Math.sin(a1), p.z,
        p.kind,
      );
    }
  }

  return {
    vertices: new Float32Array(vertices),
    kinds: new Uint8Array(kinds),
    height: profile[profile.length - 1].z,
    radius: profile.reduce((max, p) => Math.max(max, p.r), 0),
  };
}
