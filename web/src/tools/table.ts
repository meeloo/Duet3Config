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

/**
 * Enough shape to draw the cutter, all in mm.
 *
 * Optional as a whole and field-by-field zero-means-unknown, because almost
 * every tool in a real table was typed in by hand from the packaging and has
 * nothing but a diameter. A drawing that needs a shank diameter can guess one;
 * it must not require the operator to measure one.
 */
export interface ToolGeometry {
  /** Shank diameter. 0 = assume the cutting diameter. */
  shank: number;
  /** Length of cut, tip to the top of the flutes. 0 = unknown. */
  flute: number;
  /** Overall length, tip to where the holder grips it. 0 = unknown. */
  length: number;
  /** Corner radius. Half the diameter means a ball nose. */
  cornerRadius: number;
  /** Included tip angle for V-bits, chamfers and drills. 0 = none. */
  tipAngle: number;
  /** Flat left on the point of a truncated V-bit. 0 = comes to a point. */
  tipDiameter: number;
}

export interface ToolInfo {
  number: number;
  name: string;
  /** Cutting diameter in mm. 0 when unset. */
  diameter: number;
  type: ToolType;
  flutes: number;
  notes: string;
  /** Absent on every tool entered before the 3D view wanted a shape. */
  geometry?: ToolGeometry;
}

export function emptyTool(number: number): ToolInfo {
  return { number, name: '', diameter: 0, type: 'endmill', flutes: 2, notes: '' };
}

export function emptyGeometry(): ToolGeometry {
  return { shank: 0, flute: 0, length: 0, cornerRadius: 0, tipAngle: 0, tipDiameter: 0 };
}

export type Table = Record<number, ToolInfo>;

export function getTool(table: Table, number: number): ToolInfo {
  return table[number] ?? emptyTool(number);
}

/**
 * A diameter, to three decimal places at most, with nothing added and nothing
 * dropped: 8 stays "8", 28.5 stays "28.5", 0.584 stays "0.584".
 *
 * Three rather than two because of the imperial cutters. An eighth of an inch
 * is 3.175mm exactly, and two decimals turns that into 3.18 — a rounding of a
 * number that was not approximate to begin with, on the one label an operator
 * uses to tell two similar cutters apart.
 *
 * Rounded rather than cut, and the `* (1 + EPSILON)` is what makes that true at
 * a tie. A sixteenth is 1.5875mm, but the nearest double is a hair below it, so
 * `toFixed(3)` reports 1.587. Arithmetically defensible; wrong on a tool row.
 * Nudging by one ulp first puts the tie back on the side the number was
 * written on.
 */
export function formatDiameter(mm: number): string {
  if (!isFinite(mm)) return '0';
  const rounded = Math.round(Math.abs(mm) * 1000 * (1 + Number.EPSILON)) / 1000;
  return String(mm < 0 ? -rounded : rounded);
}

// --- Libraries ------------------------------------------------------------
//
// One table is not enough, because the carousel holds one set of tools at a
// time and which set that is depends on the work. Guitar work and metal work
// share a machine, an ATC and a numbering scheme, and share almost no cutters
// — so T4 is a 6mm compression bit on one day and a carbide slot drill the
// next. Keeping both in one table means every tool is described wrong half the
// time, which is worse than describing none of them.
//
// Switching library is therefore a claim about the physical machine: "the
// pockets now hold these". It is stored alongside the libraries and shared
// with the other browsers, because they are all looking at the same carousel.

export interface ToolLibrary {
  id: string;
  name: string;
  tools: Table;
}

export interface LibraryState {
  /** id of the library the carousel is currently loaded with. */
  active: string;
  libraries: ToolLibrary[];
}

/** Superseded by `toolLibraries`; still read once, to carry a table forward. */
const LEGACY_KEY = 'toolTable';
const KEY = 'toolLibraries';

const DEFAULT_NAME = 'Default';

function newId(): string {
  // randomUUID needs a secure context, and this app is routinely served over
  // plain HTTP from the controller itself.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `lib-${Math.random().toString(36).slice(2, 10)}`;
}

function isTable(value: unknown): value is Table {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // A tool table is keyed by number; anything else is a different shape that
  // happened to survive JSON.
  return Object.entries(value).every(
    ([key, tool]) => /^\d+$/.test(key) && !!tool && typeof tool === 'object',
  );
}

/**
 * The stored state, repaired into something usable.
 *
 * Tolerant on purpose. This key is shared between browsers through the
 * controller, so a copy written by a different version — or a hand-edited
 * settings file — has to degrade into a working table rather than into an
 * empty tool list on a machine that is about to cut something.
 */
function normalise(raw: unknown): LibraryState {
  const state = raw as Partial<LibraryState> | null;
  const libraries: ToolLibrary[] = [];

  if (state && Array.isArray(state.libraries)) {
    for (const entry of state.libraries) {
      if (!entry || typeof entry !== 'object') continue;
      const tools = isTable(entry.tools) ? entry.tools : {};
      libraries.push({
        id: typeof entry.id === 'string' && entry.id ? entry.id : newId(),
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : DEFAULT_NAME,
        tools,
      });
    }
  }

  if (!libraries.length) {
    // First run under the new scheme: whatever single table existed becomes the
    // first library, so an operator who spent an evening filling one in does
    // not find it gone.
    const legacy = loadSetting<unknown>(LEGACY_KEY, null);
    libraries.push({
      id: newId(),
      name: DEFAULT_NAME,
      tools: isTable(legacy) ? legacy : {},
    });
  }

  const active =
    typeof state?.active === 'string' && libraries.some((l) => l.id === state.active)
      ? state.active
      : libraries[0].id;

  return { active, libraries };
}

export function loadLibraries(): LibraryState {
  const raw = loadSetting<unknown>(KEY, null);
  const state = normalise(raw);
  // Write the migration out the first time rather than re-deriving it on every
  // load: until it is stored it is not a real setting, so it would not be part
  // of a push to the machine and the other browsers would never see the table
  // that was carried forward.
  if (raw === null) saveSetting(KEY, state);
  return state;
}

export function saveLibraries(state: LibraryState): void {
  saveSetting(KEY, normalise(state));
}

export function activeLibrary(state: LibraryState = loadLibraries()): ToolLibrary {
  return state.libraries.find((l) => l.id === state.active) ?? state.libraries[0];
}

/** The tools in the carousel right now. */
export function loadTools(): Table {
  return activeLibrary().tools;
}

/** Write the carousel's tools back, leaving the other libraries alone. */
export function saveTools(table: Table): void {
  const state = loadLibraries();
  const library = activeLibrary(state);
  library.tools = table;
  saveLibraries(state);
}

export function setActiveLibrary(id: string): void {
  const state = loadLibraries();
  if (!state.libraries.some((l) => l.id === id)) return;
  saveLibraries({ ...state, active: id });
}

/** Add a library and make it the active one. Returns its id. */
export function createLibrary(name: string, tools: Table = {}): string {
  const state = loadLibraries();
  const id = newId();
  state.libraries.push({ id, name: uniqueName(state, name), tools });
  saveLibraries({ ...state, active: id });
  return id;
}

export function renameLibrary(id: string, name: string): void {
  const state = loadLibraries();
  const library = state.libraries.find((l) => l.id === id);
  if (!library) return;
  library.name = uniqueName(state, name, id);
  saveLibraries(state);
}

export function duplicateLibrary(id: string): string | null {
  const state = loadLibraries();
  const source = state.libraries.find((l) => l.id === id);
  if (!source) return null;
  // Structured copy, so editing a tool in the copy cannot reach back into the
  // original through a shared object.
  const tools: Table = {};
  for (const [number, tool] of Object.entries(source.tools)) {
    tools[Number(number)] = { ...tool, geometry: tool.geometry ? { ...tool.geometry } : undefined };
  }
  return createLibrary(`${source.name} copy`, tools);
}

/**
 * Remove a library. Refuses to remove the last one — there is always a
 * carousel, so there is always a table describing it, even an empty one.
 */
export function deleteLibrary(id: string): boolean {
  const state = loadLibraries();
  if (state.libraries.length < 2) return false;
  const remaining = state.libraries.filter((l) => l.id !== id);
  if (remaining.length === state.libraries.length) return false;
  saveLibraries({
    active: state.active === id ? remaining[0].id : state.active,
    libraries: remaining,
  });
  return true;
}

/**
 * A name no other library is using.
 *
 * Two libraries called "Guitars" would be indistinguishable in the one place
 * it matters — the switcher — and picking the wrong one mislabels every tool
 * in the machine.
 */
function uniqueName(state: LibraryState, name: string, exclude?: string): string {
  const wanted = name.trim() || DEFAULT_NAME;
  const taken = (candidate: string) =>
    state.libraries.some(
      (l) => l.id !== exclude && l.name.toLowerCase() === candidate.toLowerCase(),
    );
  if (!taken(wanted)) return wanted;
  for (let n = 2; n < 100; n++) {
    if (!taken(`${wanted} ${n}`)) return `${wanted} ${n}`;
  }
  return `${wanted} ${newId().slice(0, 4)}`;
}

/** Short one-line description for a tool, falling back to the machine's name. */
export function describeTool(info: ToolInfo, machineName: string | null): string {
  // Flute count alone is not a description — "2fl" tells an operator nothing
  // about what is in the spindle. It is only added once there is something
  // identifying to attach it to, so an unconfigured slot falls back to the
  // controller's own tool name instead of a meaningless fragment.
  const identity: string[] = [];
  if (info.diameter > 0) identity.push(`⌀${formatDiameter(info.diameter)}`);
  const typeLabel = TOOL_TYPES.find((t) => t.value === info.type)?.label;
  if (info.name) identity.push(info.name);
  else if (typeLabel && info.diameter > 0) identity.push(typeLabel.toLowerCase());

  if (identity.length === 0) return machineName || 'not configured';

  if (info.flutes > 0 && info.type !== 'surfacing' && info.type !== 'vbit') {
    identity.push(`${info.flutes}fl`);
  }
  return identity.join(' ');
}
