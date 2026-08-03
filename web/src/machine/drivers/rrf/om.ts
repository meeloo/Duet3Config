// Partial typings for the RepRapFirmware object model.
//
// Only the keys this UI consumes are typed; the rest stays `unknown` and is
// still browsable through the object-model panel. Reference:
//   https://github.com/Duet3D/RepRapFirmware/wiki/Object-Model-Documentation
//
// These types are the durable asset in this driver. Endpoints rarely change;
// object-model *shapes* do move between firmware releases, so keeping them in
// one file makes a firmware upgrade a localised edit.

export interface OmAxis {
  letter: string;
  machinePosition: number;
  userPosition: number;
  workplaceOffsets: number[];
  homed: boolean;
  min: number;
  max: number;
  visible: boolean;
  babystep?: number;
  /** Maximum feed, mm/min (M203). */
  speed?: number;
}

export interface OmMove {
  axes: OmAxis[];
  workplaceNumber: number;
  speedFactor: number;
  currentMove?: {
    requestedSpeed?: number;
    topSpeed?: number;
    acceleration?: number;
  };
  /**
   * G68 coordinate rotation. Present only in firmware built with
   * SUPPORT_COORDINATE_ROTATION, so absent is "not supported", not "zero".
   * `centre` is in *machine* coordinates — G68 takes it in work coordinates and
   * the firmware adds the workplace offset before storing it.
   */
  rotation?: {
    angle: number;
    centre: number[];
  };
}

export interface OmMessageBox {
  mode: number;
  seq: number;
  title: string;
  message: string;
  timeout: number;
  axisControls: number;
  controls?: unknown[];
}

export interface OmState {
  status: string;
  currentTool: number;
  displayMessage?: string;
  messageBox?: OmMessageBox | null;
  upTime?: number;
  machineMode?: string;
}

export interface OmSpindle {
  active: number;
  current: number;
  min: number;
  max: number;
  state: string;
  canReverse?: boolean;
}

export interface OmJob {
  file?: {
    fileName?: string;
    size?: number;
    generatedBy?: string;
  } | null;
  filePosition?: number;
  duration?: number;
  timesLeft?: { file?: number; filament?: number; slicer?: number };
  lastFileName?: string;
}

export interface OmTool {
  number: number;
  name: string;
  offsets: number[];
  spindle?: number;
  state?: string;
}

/** current/min/max triple RRF uses for voltages and temperatures. */
export interface OmRange {
  current?: number;
  min?: number;
  max?: number;
}

export interface OmBoard {
  shortName?: string;
  name?: string;
  firmwareVersion?: string;
  firmwareName?: string;
  firmwareDate?: string;
  uniqueId?: string;
  canAddress?: number;
  /** Never-used RAM, bytes. */
  freeRam?: number;
  /** min/max here are the extremes *observed*, not permitted limits. */
  vIn?: OmRange;
  v12?: OmRange;
  mcuTemp?: OmRange;
}

export interface OmNetworkInterface {
  type?: string;
  state?: string;
  actualIP?: string;
  mac?: string;
  gateway?: string;
  subnet?: string;
  /** WiFi RSSI, dBm. */
  signal?: number;
  speed?: number;
  numReconnects?: number;
}

export interface OmNetwork {
  name?: string;
  hostname?: string;
  interfaces?: OmNetworkInterface[];
}

export interface OmProbe {
  type?: number;
  value?: number[];
  triggered?: boolean;
  threshold?: number;
  diveHeight?: number;
  lastStopHeight?: number;
}

export interface OmSensors {
  probes?: OmProbe[];
  [key: string]: unknown;
}

export interface OmSeqs {
  boards?: number;
  directories?: number;
  fans?: number;
  global?: number;
  heat?: number;
  inputs?: number;
  job?: number;
  move?: number;
  network?: number;
  reply?: number;
  sensors?: number;
  spindles?: number;
  state?: number;
  tools?: number;
  volumes?: number;
  [key: string]: number | undefined;
}

export interface ObjectModel {
  boards?: OmBoard[];
  global?: Record<string, unknown>;
  job?: OmJob;
  move?: OmMove;
  network?: OmNetwork;
  sensors?: OmSensors;
  seqs?: OmSeqs;
  spindles?: OmSpindle[];
  state?: OmState;
  tools?: OmTool[];
  [key: string]: unknown;
}

/** Top-level keys we re-fetch in full when their sequence number advances. */
export const TRACKED_KEYS = [
  'boards',
  'global',
  'job',
  'move',
  'network',
  'sensors',
  'spindles',
  'state',
  'tools',
] as const;

/**
 * Map RRF's status string onto the neutral model.
 * RRF values: disconnected, starting, updating, off, halted, pausing, paused,
 * resuming, cancelling, processing, simulating, busy, changingTool, idle.
 */
export function mapStatus(status: string | undefined): import('../../types.js').MachineStatus {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'processing':
    case 'simulating':
      return 'running';
    case 'paused':
      return 'paused';
    case 'pausing':
    case 'cancelling':
      return 'pausing';
    case 'resuming':
      return 'resuming';
    case 'changingTool':
      return 'tool-change';
    case 'halted':
      return 'halted';
    case 'off':
      return 'off';
    case 'busy':
      return 'busy';
    case 'starting':
    case 'updating':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'busy';
  }
}

/**
 * M291 S<mode> → neutral prompt mode.
 *   0 no buttons, 1 close, 2 OK, 3 OK+Cancel, 4 int, 5 float, 6 string,
 *   7 = string with no cancel (3.5+).
 * Modes 4-7 are answered with M292 R<value>; see driver.answerPrompt.
 */
export function mapPromptMode(mode: number): import('../../types.js').MachinePrompt['mode'] {
  switch (mode) {
    case 0:
      return 'none';
    case 1:
      return 'close';
    case 2:
      return 'ok';
    case 3:
      return 'ok-cancel';
    case 4:
      return 'input-int';
    case 5:
      return 'input-float';
    case 6:
    case 7:
      return 'input-string';
    default:
      return 'ok';
  }
}

/**
 * RRF axisControls is a bitmap over the machine's axis list.
 * Tolerates holes — object-model arrays are indexed by number, not packed.
 */
export function expandAxisControls(bitmap: number, axes: OmAxis[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < axes.length; i++) {
    const letter = axes[i]?.letter;
    if (letter && bitmap & (1 << i)) out.push(letter);
  }
  return out;
}

export function mapSpindleState(state: string | undefined): import('../../types.js').Spindle['state'] {
  switch (state) {
    case 'stopped':
      return 'stopped';
    case 'forward':
      return 'forward';
    case 'reverse':
      return 'reverse';
    default:
      return 'unknown';
  }
}
