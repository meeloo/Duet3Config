// The contract every controller implementation satisfies.
//
// Adding a machine means implementing this interface and registering a factory
// in machine/registry.ts. Nothing in ui/ or panels/ changes.
//
// Design notes for future drivers:
//  - `connect()` should resolve only once state is flowing, and must be safe to
//    call again after `disconnect()`.
//  - State is pushed, not pulled: drivers own their own update cadence (HTTP
//    polling for RRF, a socket stream for others) and call the state callback.
//    Panels never poll.
//  - Every method may reject; the shell surfaces failures in the console panel
//    and marks the connection degraded rather than tearing it down.

import type {
  Capabilities,
  FileEntry,
  LogLine,
  MachineState,
} from './types.js';

export interface ConnectionConfig {
  /** Base URL or host of the controller, e.g. "http://sebscnc.local". */
  url: string;
  password?: string;
}

export interface JogOptions {
  /** Relative distance in mm (signed). */
  distance: number;
  /** Feed rate in mm/min. */
  feedRate: number;
  /** Machine coordinates rather than work coordinates. */
  machineCoords?: boolean;
}

export interface MachineDriver {
  /** Stable identifier, e.g. "rrf". */
  readonly id: string;
  /** Display name, e.g. "RepRapFirmware (Duet)". */
  readonly label: string;
  readonly capabilities: Capabilities;

  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): Promise<void>;

  /** Subscribe to state snapshots. Returns an unsubscribe function. */
  onState(cb: (state: MachineState) => void): () => void;
  /** Subscribe to console output. Returns an unsubscribe function. */
  onLog(cb: (line: LogLine) => void): () => void;

  // --- Motion & commands -------------------------------------------------
  /** Send a raw command in the controller's own dialect. */
  send(command: string): Promise<void>;
  /** Send a command and resolve with the controller's reply text. */
  query(command: string): Promise<string>;

  jog(axis: string, opts: JogOptions): Promise<void>;
  home(axes?: string[]): Promise<void>;
  /** Set the work offset for `axis` so the current position reads `value`. */
  setWorkZero(axis: string, value: number): Promise<void>;
  /** Select work coordinate system (1 = G54). */
  selectWcs(index: number): Promise<void>;
  emergencyStop(): Promise<void>;

  // --- Spindle -----------------------------------------------------------
  setSpindle(rpm: number, direction: 'forward' | 'reverse'): Promise<void>;
  stopSpindle(): Promise<void>;

  // --- Files -------------------------------------------------------------
  listFiles(dir: string): Promise<FileEntry[]>;
  /**
   * @param onProgress receives (bytesLoaded, totalBytes|null). Optional so a
   *   driver that cannot report it simply doesn't, and callers show an
   *   indeterminate bar instead.
   */
  readFile(path: string, onProgress?: (loaded: number, total: number | null) => void): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  deleteFile(path: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;

  // --- Jobs --------------------------------------------------------------
  startJob(path: string): Promise<void>;
  pauseJob(): Promise<void>;
  resumeJob(): Promise<void>;
  cancelJob(): Promise<void>;
  /** Run a macro file on the controller. */
  runMacro(path: string): Promise<void>;

  // --- Prompts -----------------------------------------------------------
  /** Answer a blocking prompt. `value` is supplied for input-mode prompts. */
  answerPrompt(seq: number, accept: boolean, value?: string | number): Promise<void>;

  // --- Escape hatch ------------------------------------------------------
  /**
   * Controller-specific surface for panels that opt in via `capabilities`.
   * The object-model browser casts this to RrfNative; other panels must not
   * touch it. Anything promoted to general use belongs in MachineState instead.
   */
  readonly native?: unknown;
}
