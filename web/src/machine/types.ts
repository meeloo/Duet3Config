// Vendor-neutral machine model.
//
// Every panel in the UI reads *only* these types. Nothing above the driver layer
// may import RepRapFirmware object-model types, `rr_*` endpoint names, or any
// other controller-specific vocabulary. That constraint is the whole point: a
// second controller (Makera Z1, GRBL, Smoothie…) becomes a new implementation of
// MachineDriver rather than a fork of the UI.
//
// Where a controller has a concept the model lacks, expose it through
// `capabilities` + the driver's `native` escape hatch instead of widening these
// types. The object-model browser panel does exactly that for RRF.

export type MachineStatus =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'busy'
  | 'running'
  | 'paused'
  | 'pausing'
  | 'resuming'
  | 'homing'
  | 'tool-change'
  | 'halted'
  | 'off';

/** Statuses in which it is unsafe to start a new motion command. */
export const BUSY_STATES: ReadonlySet<MachineStatus> = new Set<MachineStatus>([
  'disconnected',
  'connecting',
  'busy',
  'running',
  'pausing',
  'resuming',
  'homing',
  'tool-change',
  'halted',
  'off',
]);

export interface Axis {
  /** X, Y, Z, U, A… — the controller's own letter. */
  letter: string;
  /** Position in machine coordinates (mm). */
  machine: number;
  /** Position in the active work coordinate system (mm). */
  work: number;
  homed: boolean;
  min: number;
  max: number;
  /** True for axes that participate in the toolpath (X/Y/Z), false for aux axes. */
  visible: boolean;
  /** Per-WCS offsets, index 0 = G54. Empty if the controller doesn't expose them. */
  workOffsets: number[];
  /** Maximum feed for this axis in mm/min, 0 when the controller doesn't say. */
  maxFeed: number;
  /** Live offset applied on top of the work offset (RRF babystep), mm. */
  babystep: number;
}

export interface Spindle {
  /** Commanded RPM. */
  active: number;
  /** Measured/actual RPM if the controller reports it, else same as active. */
  current: number;
  min: number;
  max: number;
  state: 'stopped' | 'forward' | 'reverse' | 'unknown';
}

export interface JobState {
  fileName: string | null;
  /** Byte offset into the running file — used to locate the cutter in the toolpath. */
  filePosition: number | null;
  fileSize: number | null;
  /** 0..1, best available estimate. */
  progress: number | null;
  elapsed: number | null;
  remaining: number | null;
}

export interface ToolState {
  number: number;
  name: string | null;
  offsets: number[];
}

/** A prompt the controller is blocking on (RRF M291, and equivalents elsewhere). */
export interface MachinePrompt {
  /** Stable identifier so we only render/answer each prompt once. */
  seq: number;
  title: string;
  message: string;
  /** none = informational; ok = single button; ok-cancel = two; input-* = needs a value. */
  mode: 'none' | 'close' | 'ok' | 'ok-cancel' | 'input-int' | 'input-float' | 'input-string';
  /** Show jog controls inside the dialog (RRF axisControls bitmap, expanded). */
  axisControls: string[];
  timeout: number | null;
  defaultValue?: string | number;
}

export interface MachineState {
  status: MachineStatus;
  /** Human-readable controller identity, e.g. "Duet 3 MB6HC / RRF 3.6.0". */
  identity: string | null;
  axes: Axis[];
  /** Active work coordinate system, 1 = G54. */
  wcs: number;
  /** How many work coordinate systems the controller exposes. */
  wcsCount: number;
  spindle: Spindle | null;
  job: JobState | null;
  tool: ToolState | null;
  prompt: MachinePrompt | null;
  /** Feed rate of the current move, mm/min. */
  feedRate: number | null;
  /** Speed/feed override factor, 1.0 = 100%. */
  feedMultiplier: number;
  /** Free-form key/value state the driver wants surfaced but the model doesn't name. */
  extras: Record<string, unknown>;
}

export function emptyMachineState(): MachineState {
  return {
    status: 'disconnected',
    identity: null,
    axes: [],
    wcs: 1,
    wcsCount: 1,
    spindle: null,
    job: null,
    tool: null,
    prompt: null,
    feedRate: null,
    feedMultiplier: 1,
    extras: {},
  };
}

export interface FileEntry {
  name: string;
  /** Controller-absolute path. */
  path: string;
  directory: boolean;
  size: number;
  modified: Date | null;
}

export type LogLevel = 'command' | 'reply' | 'warning' | 'error' | 'info';

export interface LogLine {
  level: LogLevel;
  text: string;
  time: Date;
}

/**
 * What a given controller can actually do. Panels consult this to decide whether
 * to render themselves at all, so adding a less capable driver degrades the UI
 * gracefully instead of producing dead buttons.
 */
export interface Capabilities {
  /** Exposes a browsable/editable structured state tree (RRF object model). */
  objectModel: boolean;
  /** Supports listing/reading/writing files on the controller. */
  files: boolean;
  /** Supports writing files back (config editing). */
  fileWrite: boolean;
  /** Runs macro files stored on the controller. */
  macros: boolean;
  /** Number of work coordinate systems (0 = unsupported). */
  workCoordinateSystems: number;
  /** Reports byte offset into the running file, enabling live toolpath tracking. */
  jobFilePosition: boolean;
  /** Supports an automatic tool changer workflow. */
  toolChanger: boolean;
  /** Can answer blocking prompts (M291-style). */
  prompts: boolean;
  /** Directory the driver considers the natural root for G-code jobs. */
  gcodeRoot: string;
  /** Directory holding controller configuration, if browsable. */
  configRoot: string | null;
  /** Directory holding macros, if any. */
  macroRoot: string | null;
}

export function defaultCapabilities(): Capabilities {
  return {
    objectModel: false,
    files: false,
    fileWrite: false,
    macros: false,
    workCoordinateSystems: 0,
    jobFilePosition: false,
    toolChanger: false,
    prompts: false,
    gcodeRoot: '/gcodes',
    configRoot: null,
    macroRoot: null,
  };
}
