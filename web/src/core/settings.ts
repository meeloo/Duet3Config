// Sharing the UI's own settings between browsers, via the controller.
//
// Everything the app remembers lives in localStorage, which is per browser and
// per device — so the layout you spent an evening arranging on the workshop PC
// is not there on the tablet by the machine, or on your laptop. The controller
// is the one thing all of them can already reach, so it can hold the reference
// copy. DWC does the same thing with /sys/dwc-settings.json.
//
// Deliberately explicit rather than continuous. Two browsers open on the same
// machine with automatic two-way sync would fight: whichever one last resized a
// panel wins, and the other's layout changes under the operator's hands. Push
// and pull are buttons, and the only automatic path — apply on connect — is
// off until it is switched on, one-way, and idempotent.

import { activeDriver, capabilities, loadSetting, saveSetting } from './store.js';
import { joinPath } from './util.js';

/**
 * What is worth sharing.
 *
 * Note what is NOT here. `controllerUrl` and `driverId` are how *this* browser
 * reaches the machine: the copy served from the Duet itself uses its own
 * origin, a laptop uses a hostname, and copying one to the other breaks the
 * client that reaches it differently. `autoConnect` is a per-device habit for
 * the same reason. `mdiHistory` is a scratchpad, not a preference.
 */
export const SYNCED_KEYS = [
  'dockLayout',
  'jog',
  'probeMap',
  'wcsNames',
  'toolTable',
  'viewerProjection',
  'theme',
] as const;

/** File name under the driver's config root. */
export const SETTINGS_FILE = 'cnc-settings.json';

export interface SettingsBundle {
  version: 1;
  /** When it was written, so the UI can say how stale the machine's copy is. */
  written: string;
  settings: Record<string, unknown>;
}

export class SettingsError extends Error {}

export function collectSettings(): SettingsBundle {
  const settings: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    const value = loadSetting<unknown>(key, undefined);
    if (value !== undefined) settings[key] = value;
  }
  return { version: 1, written: new Date().toISOString(), settings };
}

export function parseSettings(text: string): SettingsBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SettingsError('the file on the machine is not valid JSON');
  }
  const bundle = raw as Partial<SettingsBundle>;
  if (!bundle || typeof bundle !== 'object' || bundle.version !== 1 || !bundle.settings) {
    throw new SettingsError('the file on the machine is not a settings bundle this app wrote');
  }
  // Only keys we know about, so a file from a newer version cannot inject
  // arbitrary localStorage entries into an older one.
  const settings: Record<string, unknown> = {};
  for (const key of SYNCED_KEYS) {
    if (key in bundle.settings) settings[key] = bundle.settings[key];
  }
  return { version: 1, written: String(bundle.written ?? ''), settings };
}

export function serialiseSettings(bundle: SettingsBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Keys where the two copies disagree.
 *
 * Compared as serialised JSON, which is exact enough: everything here went
 * through JSON.stringify to reach localStorage in the first place, so two
 * values that serialise identically ARE identical as far as this app can tell.
 */
export function differingKeys(bundle: SettingsBundle): string[] {
  const out: string[] = [];
  for (const key of SYNCED_KEYS) {
    const mine = JSON.stringify(loadSetting<unknown>(key, undefined) ?? null);
    const theirs = JSON.stringify(bundle.settings[key] ?? null);
    if (mine !== theirs) out.push(key);
  }
  return out;
}

/** Write a bundle into local settings. Returns the keys that changed. */
export function applySettings(bundle: SettingsBundle): string[] {
  const changed = differingKeys(bundle);
  for (const key of SYNCED_KEYS) {
    if (key in bundle.settings) saveSetting(key, bundle.settings[key]);
  }
  return changed;
}

/** Human name for a key, for the "this will change" list. */
export function describeKey(key: string): string {
  switch (key) {
    case 'dockLayout':
      return 'panel layout and pages';
    case 'jog':
      return 'jog rings, reach and speed';
    case 'probeMap':
      return 'probe role assignments';
    case 'wcsNames':
      return 'work coordinate system names';
    case 'toolTable':
      return 'tool names and sizes';
    case 'viewerProjection':
      return '3D view projection';
    case 'theme':
      return 'light / dark theme';
    default:
      return key;
  }
}

// --- Per-device preference ------------------------------------------------

/** Whether this browser adopts the machine's settings when it connects. */
export function followMachine(): boolean {
  return loadSetting<boolean>('followMachineSettings', false);
}

export function setFollowMachine(on: boolean): void {
  saveSetting('followMachineSettings', on);
}

// --- The machine's copy ---------------------------------------------------

/**
 * Where the bundle lives, or null when the controller has no config directory.
 *
 * Taken from the driver's `configRoot` rather than hard-coding /sys, so a
 * controller that keeps its configuration somewhere else — or nowhere — is
 * handled by the capability that already describes exactly that.
 */
export function settingsPath(): string | null {
  const root = capabilities.peek().configRoot;
  return root ? joinPath(root, SETTINGS_FILE) : null;
}

export type RemoteState =
  | { kind: 'ok'; bundle: SettingsBundle }
  | { kind: 'absent' }
  | { kind: 'error'; message: string };

/** Read the machine's copy. A missing file is not an error — it is the norm. */
export async function readRemoteSettings(): Promise<RemoteState> {
  const path = settingsPath();
  const driver = activeDriver();
  if (!path || !driver) return { kind: 'error', message: 'not connected' };

  let bytes: Uint8Array;
  try {
    bytes = await driver.readFile(path);
  } catch {
    // The driver cannot distinguish "no such file" from other read failures,
    // and the overwhelmingly common case on a machine that has never been
    // pushed to is simply that it isn't there yet.
    return { kind: 'absent' };
  }
  try {
    return { kind: 'ok', bundle: parseSettings(new TextDecoder().decode(bytes)) };
  } catch (err) {
    return { kind: 'error', message: (err as Error).message };
  }
}

/** Write this browser's settings to the machine. */
export async function writeRemoteSettings(): Promise<SettingsBundle> {
  const path = settingsPath();
  const driver = activeDriver();
  if (!path || !driver) throw new SettingsError('not connected');
  const bundle = collectSettings();
  await driver.writeFile(path, new TextEncoder().encode(serialiseSettings(bundle)));
  return bundle;
}

/**
 * Adopt the machine's settings if this browser has opted in.
 *
 * One-way and idempotent: after applying, the two copies agree, so the next
 * connection finds nothing to do and there is no reload loop. Called once per
 * successful connection.
 *
 * @returns the keys that changed, or an empty array if nothing did.
 */
export async function syncOnConnect(): Promise<string[]> {
  if (!followMachine()) return [];
  const remote = await readRemoteSettings();
  if (remote.kind !== 'ok') return [];
  const changed = applySettings(remote.bundle);
  return changed;
}
