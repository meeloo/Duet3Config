// Makera Carvera / Z1 — stub driver.
//
// See README.md in this directory before implementing. The important structural
// point: this machine speaks raw TCP or USB serial, not HTTP, so it needs
// WebSerial or a small WebSocket⇄TCP bridge. The interface below is already
// transport-agnostic, so that choice stays inside this file.
//
// Every method throws rather than silently no-opping: a half-implemented driver
// that quietly does nothing is far worse to debug at the machine than one that
// says exactly what is missing.

import type { ConnectionConfig, JogOptions, MachineDriver } from '../../driver.js';
import {
  defaultCapabilities,
  emptyMachineState,
  type Capabilities,
  type FileEntry,
  type LogLine,
  type MachineState,
} from '../../types.js';

function todo(what: string): never {
  throw new Error(`Carvera driver: ${what} is not implemented yet`);
}

export class CarveraDriver implements MachineDriver {
  readonly id = 'carvera';
  readonly label = 'Makera Carvera / Z1';

  // Start conservative. Panels read this to decide whether to render, so an
  // honest capability set yields a coherent UI even while the driver is a stub.
  readonly capabilities: Capabilities = {
    ...defaultCapabilities(),
    objectModel: false,
    files: false,
    fileWrite: false,
    macros: false,
    workCoordinateSystems: 6,
    jobFilePosition: false,
    toolChanger: true,
    prompts: false,
    gcodeRoot: '/sd/gcodes',
    configRoot: null,
    macroRoot: null,
  };

  private stateSubs = new Set<(s: MachineState) => void>();
  private logSubs = new Set<(l: LogLine) => void>();

  async connect(_config: ConnectionConfig): Promise<void> {
    todo('connect (needs WebSerial or a WebSocket⇄TCP bridge — see README.md)');
  }

  async disconnect(): Promise<void> {
    // Safe to call on a never-connected driver.
  }

  onState(cb: (s: MachineState) => void): () => void {
    this.stateSubs.add(cb);
    cb(emptyMachineState());
    return () => this.stateSubs.delete(cb);
  }

  onLog(cb: (l: LogLine) => void): () => void {
    this.logSubs.add(cb);
    return () => this.logSubs.delete(cb);
  }

  async send(_command: string): Promise<void> {
    todo('send');
  }
  async query(_command: string): Promise<string> {
    todo('query');
  }
  async jog(_axis: string, _opts: JogOptions): Promise<void> {
    todo('jog');
  }
  async home(_axes?: string[]): Promise<void> {
    todo('home');
  }
  async setWorkZero(_axis: string, _value: number): Promise<void> {
    todo('setWorkZero');
  }
  async selectWcs(_index: number): Promise<void> {
    todo('selectWcs');
  }
  async emergencyStop(): Promise<void> {
    todo('emergencyStop');
  }
  async setSpindle(_rpm: number, _direction: 'forward' | 'reverse'): Promise<void> {
    todo('setSpindle');
  }
  async stopSpindle(): Promise<void> {
    todo('stopSpindle');
  }
  async listFiles(_dir: string): Promise<FileEntry[]> {
    todo('listFiles');
  }
  async readFile(_path: string): Promise<Uint8Array> {
    todo('readFile');
  }
  async writeFile(_path: string, _data: Uint8Array): Promise<void> {
    todo('writeFile');
  }
  async deleteFile(_path: string): Promise<void> {
    todo('deleteFile');
  }
  async makeDirectory(_path: string): Promise<void> {
    todo('makeDirectory');
  }
  async startJob(_path: string): Promise<void> {
    todo('startJob');
  }
  async pauseJob(): Promise<void> {
    todo('pauseJob');
  }
  async resumeJob(): Promise<void> {
    todo('resumeJob');
  }
  async cancelJob(): Promise<void> {
    todo('cancelJob');
  }
  async runMacro(_path: string): Promise<void> {
    todo('runMacro');
  }
  async answerPrompt(_seq: number, _accept: boolean, _value?: string | number): Promise<void> {
    todo('answerPrompt');
  }
}
