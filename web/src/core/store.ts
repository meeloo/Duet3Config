// Application store: owns the active driver and mirrors its state into signals.
//
// This is the only place that touches a MachineDriver's lifecycle. Panels read
// signals and call the thin action helpers at the bottom; they never hold a
// driver reference or subscribe to it directly, which is what keeps swapping
// controllers a one-line change.

import { batch, signal } from './signal.js';
import type { MachineDriver } from '../machine/driver.js';
import { driverInfo } from '../machine/registry.js';
import {
  defaultCapabilities,
  emptyMachineState,
  type Capabilities,
  type LogLine,
  type MachineState,
} from '../machine/types.js';

const LOG_LIMIT = 500;

export const machine = signal<MachineState>(emptyMachineState(), () => false);
export const capabilities = signal<Capabilities>(defaultCapabilities());
export const connected = signal(false);
export const connecting = signal(false);
export const connectionError = signal<string | null>(null);
export const log = signal<LogLine[]>([], () => false);
export const driverId = signal<string>(loadSetting('driverId', 'rrf'));
export const controllerUrl = signal<string>(
  loadSetting('controllerUrl', defaultControllerUrl()),
);

let driver: MachineDriver | null = null;
let unsubState: (() => void) | null = null;
let unsubLog: (() => void) | null = null;

export function activeDriver(): MachineDriver | null {
  return driver;
}

export function appendLog(line: LogLine): void {
  const next = log.peek();
  next.push(line);
  if (next.length > LOG_LIMIT) next.splice(0, next.length - LOG_LIMIT);
  log.touch();
}

export async function connect(url: string, id: string, password = ''): Promise<void> {
  await disconnect();

  const info = driverInfo(id);
  if (!info) throw new Error(`unknown driver: ${id}`);

  connecting.set(true);
  connectionError.set(null);
  saveSetting('driverId', id);
  saveSetting('controllerUrl', url);
  driverId.set(id);
  controllerUrl.set(url);

  const d = info.create();
  driver = d;
  capabilities.set(d.capabilities);

  unsubState = d.onState((s) => {
    batch(() => {
      machine.set(s);
      connected.set(s.status !== 'disconnected' && s.status !== 'connecting');
    });
  });
  unsubLog = d.onLog(appendLog);

  try {
    await d.connect({ url, password });
    connected.set(true);
    appendLog({ level: 'info', text: `Connected to ${url}`, time: new Date() });
  } catch (err) {
    const message = (err as Error).message;
    connectionError.set(message);
    appendLog({ level: 'error', text: `Connection failed: ${message}`, time: new Date() });
    await disconnect();
    throw err;
  } finally {
    connecting.set(false);
  }
}

export async function disconnect(): Promise<void> {
  unsubState?.();
  unsubLog?.();
  unsubState = null;
  unsubLog = null;

  const d = driver;
  driver = null;
  if (d) {
    try {
      await d.disconnect();
    } catch {
      // Already gone; nothing useful to report.
    }
  }
  batch(() => {
    connected.set(false);
    machine.set(emptyMachineState());
  });
}

// --- Action helpers ------------------------------------------------------
// Every panel action funnels through here so failures land in the console
// rather than an unhandled rejection in the devtools.

export async function run<T>(what: string, fn: (d: MachineDriver) => Promise<T>): Promise<T | undefined> {
  if (!driver) {
    appendLog({ level: 'error', text: `${what}: not connected`, time: new Date() });
    return undefined;
  }
  try {
    return await fn(driver);
  } catch (err) {
    appendLog({ level: 'error', text: `${what}: ${(err as Error).message}`, time: new Date() });
    return undefined;
  }
}

export const actions = {
  send: (cmd: string) => run(`send ${cmd}`, (d) => d.send(cmd)),
  jog: (deltas: Record<string, number>, feedRate: number) =>
    run(`jog ${Object.keys(deltas).join('')}`, (d) => d.jog(deltas, { feedRate })),
  home: (axes?: string[]) => run('home', (d) => d.home(axes)),
  setWorkZero: (axis: string, value = 0, wcs?: number) =>
    run(`zero ${axis}`, (d) => d.setWorkZero(axis, value, wcs)),
  setWorkOffset: (wcs: number, axis: string, machineValue: number) =>
    run(`set G${53 + wcs} ${axis} offset`, (d) => d.setWorkOffset(wcs, axis, machineValue)),
  selectWcs: (i: number) => run('select WCS', (d) => d.selectWcs(i)),
  setRotation: (angle: number, centreX: number, centreY: number) =>
    run('set rotation', (d) => d.setRotation(angle, centreX, centreY)),
  clearRotation: () => run('clear rotation', (d) => d.clearRotation()),
  estop: () => run('emergency stop', (d) => d.emergencyStop()),
  setSpindle: (rpm: number, dir: 'forward' | 'reverse') =>
    run('set spindle', (d) => d.setSpindle(rpm, dir)),
  stopSpindle: () => run('stop spindle', (d) => d.stopSpindle()),
  startJob: (path: string) => run('start job', (d) => d.startJob(path)),
  pauseJob: () => run('pause', (d) => d.pauseJob()),
  resumeJob: () => run('resume', (d) => d.resumeJob()),
  cancelJob: () => run('cancel', (d) => d.cancelJob()),
  runMacro: (path: string) => run(`run ${path}`, (d) => d.runMacro(path)),
  answerPrompt: (seq: number, accept: boolean, value?: string | number) =>
    run('answer prompt', (d) => d.answerPrompt(seq, accept, value)),
};

// --- Settings persistence -------------------------------------------------

function defaultControllerUrl(): string {
  // When served from the controller itself, talk to the same origin.
  if (typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    return location.origin;
  }
  return 'http://sebscnc.local';
}

export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`cnc.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(`cnc.${key}`, JSON.stringify(value));
  } catch {
    // Private mode / quota — settings just don't persist.
  }
}
