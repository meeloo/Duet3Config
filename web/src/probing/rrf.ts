// Probe routine generators, RepRapFirmware dialect.
//
// Unlike the machining operations — which are plain RS-274 and portable —
// probing has to read where the machine stopped and act on it. That is exactly
// what the controller's own expression language is for, and doing it on the
// controller rather than round-tripping through the browser means a dropped
// connection mid-probe cannot strand the machine half way through a sequence.
//
// The cost is that these are RRF-specific. A second controller needs a sibling
// file; probing/index.ts picks the dialect by driver id, so nothing above the
// generator changes.
//
// Every routine is a two-stage probe: a fast search to find the surface, a
// back-off, then a slow confirming touch. Single-speed probing on a router
// trades repeatability for nothing.

import { Gcode, n, type GeneratedProgram } from '../cam/format.js';
import type {
  BoreProbeParams,
  CornerProbeParams,
  EdgeProbeParams,
  SkewProbeParams,
  ToolLengthParams,
  ZProbeParams,
} from './types.js';

/** Fast probe, back off, slow probe. Leaves the machine at the trigger point. */
function twoStage(g: Gcode, p: { probeIndex: number; feedFast: number; feedSlow: number; backoff: number }, axis: string, distance: number): void {
  const dir = Math.sign(distance) || 1;
  g.raw('G91');
  g.raw(`G38.2 K${p.probeIndex} ${axis}${n(distance)} F${n(p.feedFast, 1)}`);
  g.raw(`G1 ${axis}${n(-dir * p.backoff)} F${n(p.feedFast, 1)}`);
  g.raw(`G38.2 K${p.probeIndex} ${axis}${n(dir * p.backoff * 2)} F${n(p.feedSlow, 1)}`);
  g.raw('G90');
}

/** Probe straight down and zero Z on the surface (or on a touch plate). */
export function probeZ(p: ZProbeParams): GeneratedProgram {
  const g = new Gcode();
  g.header('Probe Z surface', [
    `probe K${p.probeIndex}`,
    p.plateThickness > 0 ? `touch plate ${p.plateThickness}mm` : 'probing the surface directly',
    `sets Z in G${53 + p.wcs}`,
  ]);
  g.blank();
  g.comment('Position the probe over the surface before running');
  twoStage(g, p, 'Z', -Math.abs(p.maxTravel));
  g.raw(`G10 L20 P${p.wcs} Z${n(p.plateThickness)}`);
  g.feed({ z: p.safeZ, f: p.feedFast });
  g.raw(`M291 P"Z zeroed on the surface." R"Probe complete" S1`);
  g.end('macro');

  return {
    name: 'probe-z.g',
    gcode: g.toString(),
    summary: `Probe Z with K${p.probeIndex} and set Z=${p.plateThickness} in G${53 + p.wcs}`,
    warnings: ['Jog the probe over the surface, within ' + p.maxTravel + 'mm, before running.'],
  };
}

/** Probe a single edge along one axis and assign it a coordinate. */
export function probeEdge(p: EdgeProbeParams): GeneratedProgram {
  const r = p.tipDiameter / 2;
  // Approaching in +dir, the probe centre stops one tip-radius short of the
  // edge, so the centre must read (target - dir*r) for the edge to read target.
  const setValue = p.setTo - p.direction * r;

  const g = new Gcode();
  g.header(`Probe ${p.axis} edge`, [
    `probe K${p.probeIndex}, approaching ${p.direction > 0 ? '+' : '-'}${p.axis}`,
    `tip ⌀${p.tipDiameter}mm`,
    `sets ${p.axis}=${p.setTo} in G${53 + p.wcs}`,
  ]);
  g.blank();
  g.comment('Position the probe beside the edge, at cutting depth, before running');
  twoStage(g, p, p.axis, p.direction * Math.abs(p.maxTravel));
  g.raw(`G10 L20 P${p.wcs} ${p.axis}${n(setValue)}`);
  g.raw('G91');
  g.raw(`G1 ${p.axis}${n(-p.direction * p.backoff)} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  g.raw(`M291 P"${p.axis} edge found." R"Probe complete" S1`);
  g.end('macro');

  return {
    name: `probe-edge-${p.axis.toLowerCase()}.g`,
    gcode: g.toString(),
    summary: `Probe ${p.axis} edge with K${p.probeIndex}, set ${p.axis}=${p.setTo}`,
    warnings: ['The probe must start beside the edge and below the top surface.'],
  };
}

/**
 * Corner find: Z on the top face, then both side faces, then set the WCS origin
 * to the corner. This is the parameterised replacement for XYZprobe.g, whose
 * -35.3 / -10.3 offsets were measured for one specific probe and plate.
 */
export function probeCorner(p: CornerProbeParams): GeneratedProgram {
  const r = p.tipDiameter / 2;
  // 'left' means the probe stands on the stock's -X side and approaches in +X.
  const xDir = p.cornerX === 'left' ? 1 : -1;
  const yDir = p.cornerY === 'front' ? 1 : -1;

  const g = new Gcode();
  g.header('Probe corner', [
    `probe K${p.probeIndex}, ${p.cornerY}-${p.cornerX} corner`,
    `tip ⌀${p.tipDiameter}mm, side probing ${p.probeDepth}mm below the top face`,
    `sets X0 Y0${p.includeZ ? ' Z0' : ''} in G${53 + p.wcs}`,
  ]);
  g.blank();
  g.comment('Position the probe above the stock, just inside the corner, before running');

  if (p.includeZ) {
    g.blank();
    g.comment('--- top face ---');
    twoStage(g, p, 'Z', -Math.abs(p.maxTravel));
    g.raw(`G10 L20 P${p.wcs} Z${n(p.plateThickness)}`);
    g.feed({ z: p.safeZ, f: p.feedFast });
  }

  // Stand off outside the X face, drop below the surface, probe back in.
  //
  // The Z moves here are only safe because the Z probe above left us at a known
  // height with Z0 on the top face. Without that step we have no idea where the
  // probe is vertically, so we must not move Z at all — the operator is told to
  // position at side-probing depth themselves.
  g.blank();
  g.comment('--- X face ---');
  g.raw('G91');
  g.raw(`G1 X${n(-xDir * p.clearance)} F${n(p.feedFast, 1)}`);
  if (p.includeZ) g.raw(`G1 Z${n(-(p.safeZ + p.probeDepth))} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  twoStage(g, p, 'X', xDir * Math.abs(p.maxTravel));
  g.raw(`G10 L20 P${p.wcs} X${n(-xDir * r)}`);

  // Retract, cross to the Y face, repeat.
  g.blank();
  g.comment('--- Y face ---');
  g.raw('G91');
  g.raw(`G1 X${n(-xDir * p.backoff)} F${n(p.feedFast, 1)}`);
  if (p.includeZ) g.raw(`G1 Z${n(p.safeZ + p.probeDepth)} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  // Absolute on purpose: X0 is now the edge we just found, so moving to
  // X = ±clearance puts us exactly that far onto the stock, ready to come at
  // the Y face from outside.
  g.raw(`G1 X${n(xDir * p.clearance)} F${n(p.feedFast, 1)}`);
  g.raw('G91');
  g.raw(`G1 Y${n(-yDir * p.clearance)} F${n(p.feedFast, 1)}`);
  if (p.includeZ) g.raw(`G1 Z${n(-(p.safeZ + p.probeDepth))} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  twoStage(g, p, 'Y', yDir * Math.abs(p.maxTravel));
  g.raw(`G10 L20 P${p.wcs} Y${n(-yDir * r)}`);

  g.blank();
  g.raw('G91');
  g.raw(`G1 Y${n(-yDir * p.backoff)} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  if (p.includeZ) g.feed({ z: p.safeZ, f: p.feedFast });
  g.raw(`M291 P"Corner found. Origin set in G${53 + p.wcs}." R"Probe complete" S1`);
  g.end('macro');

  return {
    name: 'probe-corner.g',
    gcode: g.toString(),
    summary: `Find the ${p.cornerY}-${p.cornerX} corner with K${p.probeIndex} and set the G${53 + p.wcs} origin`,
    warnings: p.includeZ
      ? [
          'Start with the probe above the stock, inside the corner by more than the standoff.',
          'Check the standoff and side depth suit your stock thickness before the first run.',
        ]
      : [
          'Z is not being probed, so this routine will not move Z at all.',
          'Position the probe beside the corner at side-probing depth before running.',
        ],
  };
}

/**
 * Tool length against the fixed setter.
 *
 * Mirrors atcProbeZ.g, including driving the dust-shoe axis by the inverse of
 * the tool offset so the shoe follows the tool — without that the shoe height
 * is wrong for every tool but the one it was set with.
 */
export function probeToolLength(p: ToolLengthParams): GeneratedProgram {
  const g = new Gcode();
  g.header('Probe tool length', [
    `setter K${p.probeIndex} at machine X${p.probeX} Y${p.probeY}, trigger Z${p.probeZ}`,
    p.dustShoeAxis ? `dust shoe axis ${p.dustShoeAxis} follows the offset` : 'no dust-shoe compensation',
  ]);
  g.blank();
  g.raw(`G53 G0 Z${n(p.retractZ)}`);
  g.raw(`G53 G0 X${n(p.probeX)} Y${n(p.probeY)}`);
  g.comment('clear the current tool offset before measuring');
  g.raw('G10 L1 X0 Y0 Z0');
  g.blank();
  // The search distance is the gap between the retract height and the setter's
  // trigger height, NOT the shared maxTravel — on this machine that gap is
  // ~94mm while maxTravel defaults to 30, which would stop short of the setter
  // and fail every time. atcProbeZ.g computes it the same way.
  const reach = Math.abs(p.retractZ - p.probeZ) + Math.abs(p.maxTravel);
  twoStage(g, p, 'Z', -reach);
  g.blank();
  g.comment('offset = how far the tool tip sits above the known trigger height');
  g.raw(`var newOffset = {-(move.axes[2].machinePosition - ${n(p.probeZ)})}`);
  g.raw(
    p.dustShoeAxis
      ? `G10 L1 Z{var.newOffset} ${p.dustShoeAxis}{-var.newOffset}`
      : 'G10 L1 Z{var.newOffset}',
  );
  g.raw('echo "Tool offset set to " ^ {var.newOffset}');
  g.raw(`G53 G0 Z${n(p.retractZ)}`);
  g.end('macro');

  return {
    name: 'probe-tool-length.g',
    gcode: g.toString(),
    summary: `Measure tool length on K${p.probeIndex} and set the tool Z offset`,
    warnings: [
      'Runs in machine coordinates — the machine must be homed.',
      `Searches ${reach.toFixed(1)}mm down from Z${p.retractZ} to reach the setter at Z${p.probeZ}.`,
    ],
  };
}

/**
 * Skew: touch one edge twice, work out its angle, rotate the coordinate system
 * onto it with G68.
 *
 * The geometry, once, because getting the sign wrong here silently machines the
 * part crooked. RRF's rotation maps user coordinates to machine coordinates by
 *
 *     machine = R(a) · (user − centre) + centre        R = anticlockwise by a
 *
 * so the user's +X axis points along machine direction (cos a, sin a) and the
 * user's +Y along (−sin a, cos a). To put the user axis on the measured edge we
 * therefore want:
 *
 *     X-parallel edge:  a = atan2( Δperp, span)
 *     Y-parallel edge:  a = atan2(−Δperp, span)
 *
 * where Δperp is the second touch minus the first, both in *machine*
 * coordinates so any rotation already in force cannot contaminate them, and
 * `span` is positive. Travelling in the negative direction between touches
 * samples the edge vector backwards, which flips the sign — hence the `travel`
 * factor folded into k below.
 */
export function probeSkew(p: SkewProbeParams): GeneratedProgram {
  const perpAxis = p.edgeAxis === 'X' ? 'Y' : 'X';
  const perpIndex = p.edgeAxis === 'X' ? 1 : 0;
  const span = Math.abs(p.span);
  const k = (p.edgeAxis === 'X' ? 1 : -1) * p.travel;
  const sign = k > 0 ? '' : '-';

  const g = new Gcode();
  g.header('Probe skew', [
    `probe K${p.probeIndex}, edge along ${p.edgeAxis}, approaching ${p.approach > 0 ? '+' : '-'}${perpAxis}`,
    `two touches ${span}mm apart, travelling ${p.travel > 0 ? '+' : '-'}${p.edgeAxis}`,
    `rotates G${53 + p.wcs} about X${p.centreX} Y${p.centreY}`,
  ]);
  g.blank();
  g.comment('Position the probe beside the edge at probing depth, near the first point');
  g.blank();
  // Square the machine up before measuring: with a rotation in force the moves
  // below would run along the rotated axes rather than along the edge, and the
  // span between touches would not be the span we think it is.
  g.comment('cancel any rotation so the traverse between touches is square');
  g.raw('G69');

  g.blank();
  g.comment('--- first touch ---');
  twoStage(g, p, perpAxis, p.approach * Math.abs(p.maxTravel));
  g.raw(`var p1 = move.axes[${perpIndex}].machinePosition`);

  g.blank();
  g.comment('--- move along the edge and touch again ---');
  g.raw('G91');
  g.raw(`G1 ${perpAxis}${n(-p.approach * p.backoff)} F${n(p.feedFast, 1)}`);
  g.raw(`G1 ${p.edgeAxis}${n(p.travel * span)} F${n(p.feedFast, 1)}`);
  g.raw('G90');
  twoStage(g, p, perpAxis, p.approach * Math.abs(p.maxTravel));
  g.raw(`var p2 = move.axes[${perpIndex}].machinePosition`);

  g.blank();
  g.raw('G91');
  g.raw(`G1 ${perpAxis}${n(-p.approach * p.backoff)} F${n(p.feedFast, 1)}`);
  g.raw('G90');

  g.blank();
  g.raw(`var skew = {degrees(atan2(${sign}(var.p2 - var.p1), ${n(span)}))}`);
  g.raw(`echo "Skew " ^ var.skew ^ " deg over ${n(span)}mm"`);
  // A missed touch reads as a huge angle, and applying it would rotate the
  // whole coordinate system into the fixture. Refuse rather than apply.
  g.raw(`if {abs(var.skew) > ${n(p.maxAngle)}}`);
  g.raw(
    `  abort "Measured skew " ^ var.skew ^ " deg exceeds the ${n(p.maxAngle)} deg limit - check the probe reached both points"`,
  );
  g.raw(`G68 X${n(p.centreX)} Y${n(p.centreY)} R{var.skew}`);
  g.raw('M291 P{"Coordinate system rotated by " ^ var.skew ^ " deg."} R"Skew applied" S1');
  g.end('macro');

  return {
    name: 'probe-skew.g',
    gcode: g.toString(),
    summary: `Measure the ${p.edgeAxis} edge over ${span}mm with K${p.probeIndex} and rotate G${53 + p.wcs} to match`,
    warnings: [
      'Set the work origin first — the rotation pivots about it, so moving the origin afterwards re-skews the part.',
      'Z is never moved: position the probe at side-probing depth before running.',
      `The edge must be reachable at both points, ${span}mm apart along ${p.edgeAxis}.`,
      'G68 is experimental in RepRapFirmware and applies to the XY plane only.',
    ],
  };
}

/**
 * Bore or boss centre: probe both ways on each axis and split the difference.
 * Reserved for the `feature` role, so it cannot run on the tool setter or the
 * corner probe.
 */
export function probeBore(p: BoreProbeParams): GeneratedProgram {
  const reach = p.outside
    ? p.nominalDiameter / 2 + p.maxTravel
    : Math.min(p.maxTravel, p.nominalDiameter);

  const g = new Gcode();
  g.header(p.outside ? 'Probe boss centre' : 'Probe bore centre', [
    `probe K${p.probeIndex}, nominal ⌀${p.nominalDiameter}mm`,
    `sets X0 Y0 at the centre in G${53 + p.wcs}`,
  ]);
  g.blank();
  g.comment(
    p.outside
      ? 'Position the probe outside the boss, at probing depth, roughly on centre'
      : 'Position the probe inside the bore, at probing depth, roughly on centre',
  );

  const axisPair = (axis: 'X' | 'Y', idx: number) => {
    g.blank();
    g.comment(`--- ${axis} ---`);
    twoStage(g, p, axis, reach);
    g.raw(`var ${axis.toLowerCase()}Plus = move.axes[${idx}].machinePosition`);
    g.raw('G91');
    g.raw(`G1 ${axis}${n(-p.backoff)} F${n(p.feedFast, 1)}`);
    g.raw('G90');
    twoStage(g, p, axis, -reach * 2);
    g.raw(`var ${axis.toLowerCase()}Minus = move.axes[${idx}].machinePosition`);
    g.raw(
      `var ${axis.toLowerCase()}Centre = {(var.${axis.toLowerCase()}Plus + var.${axis.toLowerCase()}Minus) / 2}`,
    );
    g.raw(`G53 G1 ${axis}{var.${axis.toLowerCase()}Centre} F${n(p.feedFast, 1)}`);
  };

  axisPair('X', 0);
  axisPair('Y', 1);

  g.blank();
  g.raw(`G10 L20 P${p.wcs} X0 Y0`);
  g.raw(
    `echo "Measured size X " ^ {abs(var.xPlus - var.xMinus) + ${n(p.tipDiameter)}} ^ " Y " ^ {abs(var.yPlus - var.yMinus) + ${n(p.tipDiameter)}}`,
  );
  g.raw(`M291 P"Centre found and set as origin." R"Probe complete" S1`);
  g.end('macro');

  return {
    name: p.outside ? 'probe-boss.g' : 'probe-bore.g',
    gcode: g.toString(),
    summary: `Find the ${p.outside ? 'boss' : 'bore'} centre with K${p.probeIndex} and set it as the origin`,
    warnings: [
      'The measured size includes the tip diameter — calibrate the tip before trusting it.',
      'Start roughly centred; a badly off-centre start can miss the wall entirely.',
    ],
  };
}
