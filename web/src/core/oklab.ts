// sRGB ↔ OKLab, and perceptual interpolation built on it.
//
// Interpolating two colours in sRGB drags the midpoint through a muddy,
// desaturated band — the classic reason a blue→red heat map goes brown in the
// middle. OKLab is perceptually uniform, so a straight line through it steps
// evenly to the eye, which is the whole requirement for a colour ramp that has
// to be read as a measurement.
//
// Ottosson's coefficients, unmodified.

export type Rgb = [number, number, number];
export type Lab = [number, number, number];

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${((1 << 24) | (c(r) << 16) | (c(g) << 8) | c(b)).toString(16).slice(1)}`;
}

export function rgbToOklab([r, g, b]: Rgb): Lab {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, A, B]: Lab): Rgb {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** Blend two hex colours in OKLab. `t` 0 = a, 1 = b. */
export function mixOklab(a: string, b: string, t: number): string {
  const x = rgbToOklab(hexToRgb(a));
  const y = rgbToOklab(hexToRgb(b));
  return rgbToHex(oklabToRgb([
    x[0] + (y[0] - x[0]) * t,
    x[1] + (y[1] - x[1]) * t,
    x[2] + (y[2] - x[2]) * t,
  ]));
}

/**
 * Diverging ramp: cool pole ← neutral → warm pole.
 *
 * Two hues with a neutral midpoint, equal steps per arm, which is the only
 * correct encoding for a signed quantity — a rainbow invents boundaries where
 * the data has none, and a single-hue ramp hides which side of zero a value is
 * on. `t` runs −1 … 0 … +1.
 */
export interface DivergingRamp {
  cool: string;
  neutral: string;
  warm: string;
}

export function diverging(ramp: DivergingRamp, t: number): string {
  const clamped = Math.max(-1, Math.min(1, t));
  return clamped < 0
    ? mixOklab(ramp.neutral, ramp.cool, -clamped)
    : mixOklab(ramp.neutral, ramp.warm, clamped);
}
