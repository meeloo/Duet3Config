// The jog step ladder.
//
// One rule: every distance an operator can press must be a number they could
// have chosen themselves. 0.1, 0.5, 1, 5, 10, 50 — never 1.3467, never 3.5355.
// That rules out the obvious implementations (divide the maximum by the ring
// count, or take a constant ratio between rings) and makes the ladder itself
// the primitive: the maximum picks a rung, and the rings take the rungs below
// it.
//
// The 1–5 series rather than 1–2–5 because the rings are few. With four rings a
// 1–2–5 ladder spans 10→2, which is barely a decade and gives two rings that
// feel the same; 1–5 spans 10→0.1 and every ring is obviously different from
// its neighbours.

/** Ascending 1–5 series, 0.01mm to 500mm. */
export const STEP_LADDER: readonly number[] = (() => {
  const out: number[] = [];
  for (let decade = -2; decade <= 2; decade++) {
    out.push(1 * 10 ** decade, 5 * 10 ** decade);
  }
  out.push(1000);
  return out;
})();

/** Index of the ladder rung nearest `value`, by ratio rather than difference. */
export function nearestStep(value: number): number {
  if (!(value > 0)) return 0;
  let best = 0;
  let bestError = Infinity;
  for (let i = 0; i < STEP_LADDER.length; i++) {
    const error = Math.abs(Math.log(STEP_LADDER[i] / value));
    if (error < bestError) {
      bestError = error;
      best = i;
    }
  }
  return best;
}

/**
 * The distances for `count` rings whose outermost is `STEP_LADDER[maxIndex]`.
 *
 * Returned innermost first, so index 0 is the finest move. Clamped at the
 * bottom of the ladder rather than inventing rungs below it, which is why a
 * maximum of 0.5mm with four rings gives three distances and not four.
 */
export function ringSteps(maxIndex: number, count: number): number[] {
  const top = Math.min(Math.max(maxIndex, 0), STEP_LADDER.length - 1);
  const bottom = Math.max(0, top - count + 1);
  return STEP_LADDER.slice(bottom, top + 1);
}

/** Prose label: 0.01, 0.5, 1, 50, 500 — no trailing zeros, no exponents. */
export function stepLabel(mm: number): string {
  if (mm >= 1) return String(mm);
  return mm.toFixed(2).replace(/0$/, '').replace(/\.$/, '');
}

/**
 * Compact label for a crowded dial: the leading zero goes.
 *
 * The rose's labels lie along their own ring, so the room each one has is the
 * arc of its sector — shortest on the innermost ring, which is also where the
 * longest labels live. Dropping a leading zero costs no information and buys a
 * third of the width back, which is what lets the type stay large down there.
 */
export function stepTick(mm: number): string {
  return stepLabel(mm).replace(/^0\./, '.');
}

/**
 * Feed rates offered by the speed cursor, mm/min.
 *
 * A 1–2–5 series here, unlike the distances: feed is a continuous quantity
 * you tune rather than a quantum you count, so finer rungs are useful and there
 * is no arithmetic downstream to make ugly.
 */
export const FEED_LADDER: readonly number[] = [
  10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 5000, 6000, 8000, 10000, 15000, 20000,
];

export function nearestFeed(value: number): number {
  let best = FEED_LADDER[0];
  let bestError = Infinity;
  for (const f of FEED_LADDER) {
    const error = Math.abs(Math.log(f / Math.max(value, 1)));
    if (error < bestError) {
      bestError = error;
      best = f;
    }
  }
  return best;
}
