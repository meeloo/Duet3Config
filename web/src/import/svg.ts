// SVG import.
//
// This does NOT parse path data. Writing a correct `d` parser means arcs,
// implicit repeated commands, smooth-curve reflection and relative/absolute
// pairs for nine command letters — several hundred lines of code whose only job
// is to reproduce something already sitting in the browser, correctly, at
// native speed.
//
// Instead every shape is walked with SVGGeometryElement.getPointAtLength(),
// which covers <path>, <rect>, <circle>, <ellipse>, <line>, <polyline> and
// <polygon> identically, and getCTM() folds in every nested <g transform>. The
// output is dense, so it goes straight through the simplifier.
//
// The price is that this needs a live DOM: the geometry methods return zeroes
// on a document that was parsed but never attached. The element is therefore
// attached hidden and removed in a finally block.

import { simplify } from './geometry.js';
import type { ImportedDrawing, Point, Polyline } from './types.js';

/** CSS reference pixel: 96 per inch, which is what an unsuffixed length means. */
const MM_PER_PX = 25.4 / 96;

/** Shapes with the geometry interface. Everything else is ignored. */
const SHAPES = 'path, rect, circle, ellipse, line, polyline, polygon';

function isHidden(el: Element): boolean {
  // Construction lines are routinely left in the file with display:none, and
  // cutting them would be a nasty surprise.
  const style = (el.getAttribute('style') ?? '').replace(/\s/g, '');
  return (
    el.getAttribute('display') === 'none' ||
    style.includes('display:none') ||
    el.getAttribute('visibility') === 'hidden'
  );
}

/** True when any ancestor up to the <svg> is hidden. */
function hiddenInTree(el: Element, root: Element): boolean {
  for (let node: Element | null = el; node && node !== root.parentElement; node = node.parentElement) {
    if (isHidden(node)) return true;
  }
  return false;
}

/**
 * Millimetres per unit of the coordinate space getCTM() maps into.
 *
 * getCTM() returns viewport coordinates — user units with the viewBox transform
 * already applied — so the question is only how big a viewport pixel is. If the
 * root width carries a real unit, the browser will convert it and the ratio
 * against the pixel value gives the answer exactly. Without one, the file is
 * in px and the CSS 96-per-inch convention is the only available reading.
 */
function millimetresPerPixel(svg: SVGSVGElement, warnings: string[]): { mm: number; declared: boolean } {
  const attr = svg.getAttribute('width');
  if (!attr || attr.trim().endsWith('%')) {
    warnings.push('The file gives no physical size, so it is read as CSS pixels at 96 per inch. Check the size below and set the scale if it is wrong.');
    return { mm: MM_PER_PX, declared: false };
  }
  try {
    const length = svg.width.baseVal;
    const px = length.value;
    if (!(px > 0)) throw new Error('zero width');
    // SVGLength.SVG_LENGTHTYPE_MM === 7
    length.convertToSpecifiedUnits(7);
    const mm = length.valueInSpecifiedUnits;
    length.convertToSpecifiedUnits(5); // back to px, so nothing downstream is surprised
    if (!(mm > 0)) throw new Error('zero width');
    return { mm: mm / px, declared: /[a-z%]/i.test(attr.trim()) };
  } catch {
    warnings.push('Could not read the drawing size; assuming CSS pixels at 96 per inch.');
    return { mm: MM_PER_PX, declared: false };
  }
}

export interface SvgOptions {
  /** Chord tolerance for flattening curves, mm. */
  tolerance: number;
  name: string;
}

export function importSvg(text: string, opts: SvgOptions): ImportedDrawing {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error(`SVG is not well-formed: ${parseError.textContent?.slice(0, 120)}`);

  const svg = doc.documentElement as unknown as SVGSVGElement;
  if (svg.tagName.toLowerCase() !== 'svg') throw new Error('file does not contain an <svg> root');

  // Off-screen but laid out: visibility:hidden or display:none would make the
  // geometry methods return nothing, so it is moved out of view instead.
  const holder = document.createElement('div');
  holder.setAttribute(
    'style',
    'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden',
  );
  const imported = document.importNode(svg, true) as SVGSVGElement;
  holder.appendChild(imported);
  document.body.appendChild(holder);

  try {
    const { mm: mmPerUnit, declared } = millimetresPerPixel(imported, warnings);
    // Sample in source units at a step that yields the requested chord
    // tolerance once scaled to mm. Curvature is unknown, so this oversamples and
    // lets the simplifier take the slack out.
    const step = Math.max(0.05, opts.tolerance / 4 / mmPerUnit);

    const paths: Polyline[] = [];
    let skipped = 0;

    for (const el of Array.from(imported.querySelectorAll(SHAPES))) {
      if (hiddenInTree(el, imported)) continue;
      const geom = el as SVGGeometryElement;
      if (typeof geom.getTotalLength !== 'function') {
        skipped++;
        continue;
      }

      let total = 0;
      try {
        total = geom.getTotalLength();
      } catch {
        skipped++;
        continue;
      }
      if (!(total > 0)) continue;

      const matrix = geom.getCTM();
      const count = Math.max(2, Math.ceil(total / step) + 1);
      const points: Point[] = [];
      for (let i = 0; i < count; i++) {
        const p = geom.getPointAtLength((total * i) / (count - 1));
        points.push(matrix ? [matrix.a * p.x + matrix.c * p.y + matrix.e, matrix.b * p.x + matrix.d * p.y + matrix.f] : [p.x, p.y]);
      }

      // A shape whose ends meet is closed even though nothing in the DOM says
      // so — that is how a `Z`-terminated path and a <rect> both arrive.
      const first = points[0];
      const last = points[points.length - 1];
      const closed = Math.hypot(last[0] - first[0], last[1] - first[1]) <= step;
      if (closed) points.pop();

      const simplified = simplify(points, opts.tolerance / mmPerUnit);
      if (simplified.length >= 2) {
        paths.push({
          points: simplified,
          closed,
          layer: el.getAttribute('id') ?? el.getAttribute('class') ?? undefined,
        });
      }
    }

    if (skipped) warnings.push(`${skipped} shape(s) could not be measured and were skipped.`);
    if (imported.querySelector('text, image, use')) {
      warnings.push('Text, images and <use> references are ignored. Convert text to paths before exporting.');
    }
    if (!paths.length) warnings.push('No usable geometry found.');

    return {
      source: 'svg',
      name: opts.name,
      paths,
      units: declared ? 'mm' : 'unknown',
      mmPerUnit,
      warnings,
    };
  } finally {
    holder.remove();
  }
}
