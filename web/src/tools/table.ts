// Tool table.
//
// Geometry and type cannot be read from the machine — the controller knows a
// tool exists and what its Z offset measured, but not that slot 3 holds a 6mm
// three-flute compression bit. So that lives here, entered once by the operator
// and persisted locally.
//
// Deliberately NOT written back to the controller. Renaming a tool there means
// re-issuing M563, which also carries the spindle mapping and would silently
// rewrite working config if a parameter were dropped. Local metadata is
// reversible and cannot break a machine that is otherwise running fine.

import { loadSetting, saveSetting } from '../core/store.js';

export type ToolType =
  | 'endmill'
  | 'ballnose'
  | 'vbit'
  | 'chamfer'
  | 'drill'
  | 'surfacing'
  | 'engraver'
  | 'other';

export const TOOL_TYPES: Array<{ value: ToolType; label: string }> = [
  { value: 'endmill', label: 'End mill' },
  { value: 'ballnose', label: 'Ball nose' },
  { value: 'vbit', label: 'V-bit' },
  { value: 'chamfer', label: 'Chamfer' },
  { value: 'drill', label: 'Drill' },
  { value: 'surfacing', label: 'Surfacing' },
  { value: 'engraver', label: 'Engraver' },
  { value: 'other', label: 'Other' },
];

export interface ToolInfo {
  number: number;
  name: string;
  /** Cutting diameter in mm. 0 when unset. */
  diameter: number;
  type: ToolType;
  flutes: number;
  notes: string;
}

export function emptyTool(number: number): ToolInfo {
  return { number, name: '', diameter: 0, type: 'endmill', flutes: 2, notes: '' };
}

type Table = Record<number, ToolInfo>;

export function loadTools(): Table {
  return loadSetting<Table>('toolTable', {});
}

export function saveTools(table: Table): void {
  saveSetting('toolTable', table);
}

export function getTool(table: Table, number: number): ToolInfo {
  return table[number] ?? emptyTool(number);
}

/** Short one-line description for a tool, falling back to the machine's name. */
export function describeTool(info: ToolInfo, machineName: string | null): string {
  // Flute count alone is not a description — "2fl" tells an operator nothing
  // about what is in the spindle. It is only added once there is something
  // identifying to attach it to, so an unconfigured slot falls back to the
  // controller's own tool name instead of a meaningless fragment.
  const identity: string[] = [];
  if (info.diameter > 0) identity.push(`⌀${info.diameter}`);
  const typeLabel = TOOL_TYPES.find((t) => t.value === info.type)?.label;
  if (info.name) identity.push(info.name);
  else if (typeLabel && info.diameter > 0) identity.push(typeLabel.toLowerCase());

  if (identity.length === 0) return machineName || 'not configured';

  if (info.flutes > 0 && info.type !== 'surfacing' && info.type !== 'vbit') {
    identity.push(`${info.flutes}fl`);
  }
  return identity.join(' ');
}
