// Reading a Fusion 360 tool library.
//
// The tool table is the one part of this app that cannot be learned from the
// machine — the controller knows a tool exists and what its length probed, not
// that it is a three-flute 0.6mm fret cutter. Typing eight of those in by hand
// is exactly the sort of chore that gets done once, badly, and then rots. But
// the information already exists in Fusion, in the same library that posted the
// job, *including the tool number* — so the table can just be read from there
// and stay in step with what the CAM actually emits.
//
// Two shapes of file are in the wild and both turn up:
//
//   - `.tools`, which is a zip holding one `tools.json`
//   - the same JSON exported directly
//
// and inside, two generations of schema. Version 1 keeps its feeds under
// `start-values["*"]`; version 36 (current) keeps them in `start-values.presets`.
// Both are handled, because a library file is something an operator has had
// sitting on disk for years.
//
// The two traps worth knowing about, both present in real libraries:
//
//   - `data` holds more than cutting tools. Holders live in the same array,
//     with no `geometry` and no `post-process`.
//   - `unit` is **per tool**, not per file. A library can hold an imperial bit
//     next to a metric one, and reading one as the other is a 25.4x error.

import { looksLikeZip, unzip } from '../core/zip.js';
import { emptyTool, type ToolInfo, type ToolType } from './table.js';

export interface ImportedTool {
  info: ToolInfo;
  /** Fusion's own type string, shown so a wrong guess is visible. */
  sourceType: string;
  /** Set when something had to be inferred rather than read. */
  note: string | null;
}

export interface ToolLibrary {
  tools: ImportedTool[];
  /** Entries that were not cutting tools, or carried no tool number. */
  skipped: string[];
  warnings: string[];
  /** The library schema version, for the "read N tools" line. */
  version: number | null;
  /**
   * Numbers claimed by more than one tool.
   *
   * Common enough to be worth reporting rather than resolving: a library
   * downloaded from a cutter vendor typically leaves every tool on T1, because
   * Fusion only assigns numbers when a library is set up against a machine.
   * Importing that as-is would quietly collapse ten tools into one, so the
   * caller is told and can offer to number them instead.
   */
  duplicateNumbers: number[];
}

export class ToolLibraryError extends Error {}

const MM_PER_INCH = 25.4;

/**
 * Read a `.tools` archive or a raw `.json` export.
 *
 * Async only because inflating is — the parsing itself is synchronous.
 */
export async function readToolLibrary(bytes: Uint8Array): Promise<ToolLibrary> {
  return parseToolLibrary(await textOf(bytes));
}

async function textOf(bytes: Uint8Array): Promise<string> {
  if (!looksLikeZip(bytes)) return new TextDecoder().decode(bytes);

  const entries = await unzip(bytes);
  const json =
    entries.find((e) => e.name === 'tools.json') ??
    entries.find((e) => /\.json$/i.test(e.name)) ??
    null;
  if (!json) {
    throw new ToolLibraryError(
      `the archive holds no JSON (${entries.map((e) => e.name).join(', ') || 'it is empty'})`,
    );
  }
  return new TextDecoder().decode(json.bytes);
}

export function parseToolLibrary(text: string): ToolLibrary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ToolLibraryError('this is not a JSON file');
  }

  // A library is `{data: [...], version: n}`; be willing to take a bare array
  // too, since that is what falls out of hand-editing one.
  const container = raw as { data?: unknown; version?: unknown };
  const data = Array.isArray(raw) ? raw : Array.isArray(container?.data) ? container.data : null;
  if (!data) throw new ToolLibraryError('this is not a Fusion 360 tool library');

  const version = typeof container?.version === 'number' ? container.version : null;
  const tools: ImportedTool[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const counts = new Map<number, number>();

  for (const entry of data as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== 'object') continue;
    const label = describeEntry(entry);
    const geometry = entry.geometry as Record<string, unknown> | undefined;
    const post = entry['post-process'] as Record<string, unknown> | undefined;

    if (!geometry || !post) {
      // Holders, and anything else sharing the array with the tools.
      skipped.push(`${label} — ${String(entry.type ?? 'entry')}, not a cutting tool`);
      continue;
    }
    const number = post.number;
    if (typeof number !== 'number' || !isFinite(number) || number < 0) {
      skipped.push(`${label} — no tool number in the library`);
      continue;
    }

    const rounded = Math.round(number);
    counts.set(rounded, (counts.get(rounded) ?? 0) + 1);
    tools.push(convert(entry, geometry, post, rounded, label, warnings));
  }

  const duplicateNumbers = [...counts].filter(([, n]) => n > 1).map(([number]) => number);
  if (duplicateNumbers.length) {
    const worst = duplicateNumbers.map((n) => `T${n} (${counts.get(n)}×)`).join(', ');
    warnings.push(`The library reuses tool numbers — ${worst}. Number them below, or fix it in Fusion.`);
  }

  // A stable sort, so a library that assigns no numbers at all keeps the order
  // it was written in — which is the order the renumbering offer will use.
  tools.sort((a, b) => a.info.number - b.info.number);
  return { tools, skipped, warnings, version, duplicateNumbers };
}

function describeEntry(entry: Record<string, unknown>): string {
  const description = typeof entry.description === 'string' ? entry.description.trim() : '';
  return description || String(entry.type ?? 'unnamed');
}

function convert(
  entry: Record<string, unknown>,
  geometry: Record<string, unknown>,
  post: Record<string, unknown>,
  number: number,
  label: string,
  warnings: string[],
): ImportedTool {
  const scale = unitScale(entry.unit, label, warnings);
  const mm = (value: unknown, places = 3): number => {
    const n = num(value);
    return n == null ? 0 : round(n * scale, places);
  };

  const sourceType = String(entry.type ?? '').toLowerCase();
  const diameter = mm(geometry.DC);
  const cornerRadius = mm(geometry.RE);
  const tipDiameter = mm(geometry['tip-diameter']);
  const { type, note } = classify(sourceType, label, diameter, cornerRadius);

  const info: ToolInfo = {
    ...emptyTool(number),
    name: shortName(label),
    diameter,
    type,
    flutes: Math.max(0, Math.round(num(geometry.NOF) ?? 0)),
    notes: notesFor(entry, post, label, scale),
    geometry: {
      shank: mm(geometry.SFDM),
      flute: mm(geometry.LCF),
      // Below the holder is what matters for a drawing, and OAL is the honest
      // measure of it; the body length LB is measured to the shoulder and
      // leaves a stub of shank unaccounted for.
      length: mm(geometry.OAL) || mm(geometry.LB),
      cornerRadius,
      tipAngle: tipAngleOf(geometry),
      // Libraries routinely set the tip diameter equal to the cutting diameter
      // on tools that have no taper at all — which is Fusion's way of saying
      // "no tip", not a flat as wide as the cutter. Recorded as none, so the
      // drawing does not try to truncate a cone that isn't there.
      tipDiameter: tipDiameter > 0 && tipDiameter < diameter - 1e-6 ? tipDiameter : 0,
    },
  };

  return { info, sourceType: String(entry.type ?? 'unknown'), note };
}

/**
 * The included angle of the point, in degrees.
 *
 * Fusion keeps this in two different fields with two different conventions,
 * and the difference is a factor of two:
 *
 *   - `SIG` is the *included* point angle, used by drills, countersinks and
 *     the V-bits that get entered as countersinks. A 90° V-bit reads SIG 90.
 *   - `TA` is the *taper* angle of a tapered mill, measured from the axis —
 *     so half of the included angle, and 0 on everything that isn't tapered.
 *
 * Reading TA as an included angle draws a 90° V-bit as a 45° one, which looks
 * plausible and is wrong by a factor of two in depth-per-width. Angles are
 * degrees regardless of the library's unit, so nothing here is ever scaled.
 */
function tipAngleOf(geometry: Record<string, unknown>): number {
  const included = num(geometry.SIG) ?? 0;
  if (included > 0 && included < 180) return round(included, 2);
  const taper = num(geometry.TA) ?? 0;
  return taper > 0 && taper < 90 ? round(taper * 2, 2) : 0;
}

/** Millimetres per library unit. Per tool — a library can mix the two. */
function unitScale(unit: unknown, label: string, warnings: string[]): number {
  const text = String(unit ?? '').toLowerCase();
  if (text.startsWith('inch') || text === 'in') return MM_PER_INCH;
  if (text.startsWith('milli') || text === 'mm') return 1;
  warnings.push(`“${label}” does not say what units it is in — read as millimetres`);
  return 1;
}

/**
 * Fusion's type vocabulary onto ours.
 *
 * Matched by keyword rather than by an exhaustive table: Fusion has upwards of
 * forty type strings across milling, drilling and turning, they gain new ones
 * between releases, and the families are named consistently enough that
 * "anything with ball in it is a ball nose" is both shorter and more durable
 * than a list that silently drops whatever it has not heard of.
 *
 * Order matters — "counter sink" would otherwise be caught by "sink"-less
 * drill matching, and "face mill" by the generic mill fallback.
 */
function classify(
  sourceType: string,
  label: string,
  diameter: number,
  cornerRadius: number,
): { type: ToolType; note: string | null } {
  const described = label.toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => sourceType.includes(n));

  if (has('ball')) return { type: 'ballnose', note: null };
  // "Counter sink" is the type people pick for a V-bit, because Fusion has no
  // V-bit — a real library's 90° and 60° V-carving cutters are both filed
  // under it. Chamfer mills stay chamfer mills; the geometry is the same and
  // only the label differs, so a wrong guess costs nothing but a word.
  if (has('counter sink', 'countersink')) {
    return { type: 'vbit', note: 'Fusion calls it a countersink' };
  }
  if (has('chamfer')) {
    return { type: /v-?bit|v-?carve/.test(described) ? 'vbit' : 'chamfer', note: null };
  }
  if (has('taper')) {
    return { type: 'vbit', note: 'tapered mill — check whether it is a V-bit or a chamfer' };
  }
  if (has('face', 'shell')) return { type: 'surfacing', note: null };
  if (has('drill', 'tap', 'ream', 'bore')) return { type: 'drill', note: null };
  if (has('probe')) return { type: 'other', note: 'a probe, not a cutter' };

  if (has('mill')) {
    // Fusion has no notion of a spoilboard cutter — a 28mm slab flattener is
    // posted as a flat end mill like any other. The description is the only
    // place that distinction exists, so it is worth reading, but only where
    // the size makes it plausible.
    if (diameter >= 15 && /spoilboard|surfacing|slab|flycutter|fly cutter|planer|flatten/.test(described)) {
      return { type: 'surfacing', note: 'guessed from the name — Fusion calls it an end mill' };
    }
    if (/engrav/.test(described)) {
      return { type: 'engraver', note: 'guessed from the name' };
    }
    if (cornerRadius > 0 && diameter > 0 && cornerRadius < diameter / 2 - 1e-6) {
      return { type: 'endmill', note: `bull nose, ${cornerRadius}mm corner radius` };
    }
    return { type: 'endmill', note: null };
  }

  return { type: 'other', note: `unrecognised type “${sourceType || 'none'}”` };
}

/** Longest name worth putting on one line next to a diameter and flute count. */
const NAME_LIMIT = 42;

/**
 * A name, out of a catalogue description.
 *
 * Vendor descriptions are written for a search box, not a label — the Amana
 * spoilboard cutter in a real library describes itself in 130 characters and
 * lists six things it can do. The first clause is nearly always the part that
 * identifies it, and the full text is kept in the notes either way.
 */
export function shortName(description: string): string {
  const text = description.trim().replace(/\s+/g, ' ');
  if (text.length <= NAME_LIMIT) return text;

  const clause = text.split(/[,;(]/)[0].trim();
  if (clause.length >= 8 && clause.length <= NAME_LIMIT) return clause;

  const cut = text.slice(0, NAME_LIMIT);
  const space = cut.lastIndexOf(' ');
  return `${(space > 12 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * Whatever the library knows that the name could not carry: where the tool came
 * from, and what Fusion thinks it should be run at.
 *
 * The speeds are the useful part. They are what the CAM will post anyway, so
 * having them on the tool row is what lets an operator sanity-check an override
 * against the tool rather than against memory.
 */
function notesFor(
  entry: Record<string, unknown>,
  post: Record<string, unknown>,
  label: string,
  scale: number,
): string {
  const parts: string[] = [];

  // Only when the name lost something; repeating it verbatim is just noise.
  if (shortName(label) !== label) parts.push(label);

  const vendor = str(entry.vendor);
  const product = str(entry['product-id']);
  const source = [vendor, product].filter(Boolean).join(' ');
  if (source) parts.push(source);

  const preset = firstPreset(entry['start-values']);
  if (preset) {
    const rpm = num(preset.n);
    const feed = num(preset.v_f);
    const speeds: string[] = [];
    if (rpm) speeds.push(`${Math.round(rpm)} rpm`);
    if (feed) speeds.push(`${Math.round(feed * scale)} mm/min`);
    if (speeds.length) parts.push(speeds.join(' · '));
  }

  const comment = str(post.comment);
  if (comment) parts.push(comment);

  return parts.join(' · ');
}

/**
 * The first set of feeds and speeds, across both schema generations.
 *
 * Version 1 keyed them by material with `"*"` for "any"; version 36 replaced
 * that with an ordered list of named presets. Only the first is taken — the
 * tool table has one line for a tool, not one per material, and picking the
 * first is at least the one Fusion itself shows first.
 */
function firstPreset(startValues: unknown): Record<string, unknown> | null {
  if (!startValues || typeof startValues !== 'object') return null;
  const values = startValues as Record<string, unknown>;

  const presets = values.presets;
  if (Array.isArray(presets) && presets.length) {
    const first = presets[0];
    return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
  }

  const any = values['*'] ?? Object.values(values)[0];
  return any && typeof any === 'object' ? (any as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
