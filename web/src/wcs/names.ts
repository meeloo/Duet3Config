// Work coordinate system identity: the G-code that selects it, and the name the
// operator gave it.
//
// Names are a local concern — no controller stores "vise" or "fixture plate"
// anywhere — so they live in browser settings and are keyed by index. That makes
// them the one part of this panel that survives nothing but this browser, which
// is why nothing depends on them being present.

import { loadSetting, saveSetting } from '../core/store.js';

/** Selector for each system, index 0 = G54. */
export const WCS_CODES = [
  'G54',
  'G55',
  'G56',
  'G57',
  'G58',
  'G59',
  'G59.1',
  'G59.2',
  'G59.3',
] as const;

/** @param wcs 1-based, 1 = G54. */
export function wcsCode(wcs: number): string {
  return WCS_CODES[wcs - 1] ?? `G${53 + wcs}`;
}

export type WcsNames = Record<string, string>;

export function loadWcsNames(): WcsNames {
  return loadSetting<WcsNames>('wcsNames', {});
}

export function saveWcsNames(names: WcsNames): void {
  saveSetting('wcsNames', names);
}

/** Display label: the operator's name if there is one, else just the code. */
export function wcsLabel(wcs: number, names: WcsNames): string {
  const name = names[String(wcs)]?.trim();
  return name ? `${wcsCode(wcs)} · ${name}` : wcsCode(wcs);
}
