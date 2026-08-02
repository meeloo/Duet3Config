// Deep-merge for object-model patches.
//
// The per-tick `rr_model?flags=d99fn` response carries only frequently-changing
// values, laid over the same tree shape as the full model. Merging rather than
// replacing keeps the verbose fields (axis limits, tool names, board identity)
// that only arrive on a full per-key fetch.
//
// Arrays are merged element-wise because RRF reports live array members in
// place — `move.axes[1].machinePosition` arrives without the axis's `letter`
// or `min`/`max`. Replacing the array wholesale would blank those every tick.
//
// One RRF-specific wrinkle: a shortened array in a patch means items were
// removed (e.g. a tool was deleted), so we truncate to the patch length. A
// `null` array element means "no change to this element".

export function mergeInto<T>(target: T, patch: unknown): T {
  if (patch === null || patch === undefined) return target;

  if (Array.isArray(patch)) {
    const base = Array.isArray(target) ? (target as unknown[]) : [];
    const out: unknown[] = base.slice(0, patch.length);
    for (let i = 0; i < patch.length; i++) {
      const item = patch[i];
      if (item === null) {
        // Null element = unchanged; keep whatever we already had.
        if (out[i] === undefined) out[i] = null;
        continue;
      }
      out[i] = isPlainObject(item) || Array.isArray(item) ? mergeInto(out[i], item) : item;
    }
    return out as unknown as T;
  }

  if (isPlainObject(patch)) {
    const base: Record<string, unknown> = isPlainObject(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
    for (const [k, v] of Object.entries(patch)) {
      base[k] =
        isPlainObject(v) || Array.isArray(v) ? mergeInto(base[k], v) : v;
    }
    return base as unknown as T;
  }

  return patch as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
