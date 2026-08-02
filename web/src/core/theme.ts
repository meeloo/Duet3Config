// Theme handling.
//
// Light is the default: this runs on a shop floor where the ambient light is
// usually bright, and a dark UI on a screen next to a window is hard to read.
// Dark stays available for anyone working in a dim space.
//
// The theme is applied as `data-theme` on <html> so CSS custom properties can
// switch wholesale, and mirrored into a signal so the WebGL viewer — which
// cannot read CSS variables — can recolour itself.

import { signal } from './signal.js';
import { loadSetting, saveSetting } from './store.js';

export type Theme = 'light' | 'dark';

export const theme = signal<Theme>(loadSetting<Theme>('theme', 'light'));

export function applyTheme(next: Theme): void {
  theme.set(next);
  saveSetting('theme', next);
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
}

export function toggleTheme(): void {
  applyTheme(theme.peek() === 'light' ? 'dark' : 'light');
}

/** Call before first render so there is no flash of the wrong theme. */
export function initTheme(): void {
  applyTheme(theme.peek());
}

/** Colours for the WebGL toolpath view, which can't consult the stylesheet. */
export interface ViewerPalette {
  background: [number, number, number];
  /** Cutting moves not yet reached. */
  cut: [number, number, number];
  /** Cutting moves already executed. */
  done: [number, number, number];
  rapid: [number, number, number];
  /** Machine work envelope. */
  envelope: [number, number, number];
  /** Bounding box of the loaded toolpath. */
  bounds: [number, number, number];
  grid: [number, number, number];
  cutter: [number, number, number];
  axisX: [number, number, number];
  axisY: [number, number, number];
  axisZ: [number, number, number];
}

const rgb = (hex: number): [number, number, number] => [
  ((hex >> 16) & 0xff) / 255,
  ((hex >> 8) & 0xff) / 255,
  (hex & 0xff) / 255,
];

const LIGHT: ViewerPalette = {
  background: rgb(0xfbfcfd),
  cut: rgb(0x1565c0),
  done: rgb(0x2e7d32),
  rapid: rgb(0x9aa5b1),
  envelope: rgb(0x94a1b2),
  bounds: rgb(0xc2cad4),
  grid: rgb(0xdde3ea),
  cutter: rgb(0xe65100),
  axisX: rgb(0xc62828),
  axisY: rgb(0x2e7d32),
  axisZ: rgb(0x1565c0),
};

const DARK: ViewerPalette = {
  background: rgb(0x12151a),
  cut: rgb(0x8cc7ff),
  done: rgb(0x59d97a),
  rapid: rgb(0x99a0ad),
  envelope: rgb(0x5c6675),
  bounds: rgb(0x39414d),
  grid: rgb(0x252b34),
  cutter: rgb(0xffbe2e),
  axisX: rgb(0xd94a3d),
  axisY: rgb(0x59bf6a),
  axisZ: rgb(0x5a8fe6),
};

export function viewerPalette(t: Theme = theme.peek()): ViewerPalette {
  return t === 'dark' ? DARK : LIGHT;
}
