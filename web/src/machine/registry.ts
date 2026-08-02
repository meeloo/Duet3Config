import type { MachineDriver } from './driver.js';
import { RrfDriver } from './drivers/rrf/driver.js';
import { CarveraDriver } from './drivers/carvera/driver.js';

export interface DriverInfo {
  id: string;
  label: string;
  /** Placeholder shown in the connection field. */
  urlHint: string;
  /** False while a driver is still a stub — the UI marks it unavailable. */
  ready: boolean;
  create(): MachineDriver;
}

export const DRIVERS: DriverInfo[] = [
  {
    id: 'rrf',
    label: 'RepRapFirmware (Duet)',
    urlHint: 'http://sebscnc.local',
    ready: true,
    create: () => new RrfDriver(),
  },
  {
    id: 'carvera',
    label: 'Makera Carvera / Z1',
    urlHint: 'ws://localhost:8088/bridge  (or "serial:" for USB)',
    ready: false,
    create: () => new CarveraDriver(),
  },
];

export function driverInfo(id: string): DriverInfo | undefined {
  return DRIVERS.find((d) => d.id === id);
}
