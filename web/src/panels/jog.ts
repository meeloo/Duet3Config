// Motion control: a compass rose of distances.
//
// The old panel made every jog two decisions — pick a step, then pick a
// direction — and it only did four directions. This one puts distance and
// direction in the same press: concentric rings, eight octants each, so the
// sector you touch says both where and how far. Nearer the centre is finer.
//
// Three rules the layout follows.
//
//   Every distance is a number an operator could have chosen. The rings take
//   consecutive rungs off a 1–5 ladder, so they read 0.1 / 0.5 / 1 / 5 / 10 and
//   never 1.3467. Nothing here divides a maximum by a ring count.
//
//   A diagonal moves the ring's distance on BOTH axes — 5mm NE is X+5 Y+5, not
//   3.5355 each. That keeps the numbers honest, and it is what you want when
//   walking into a corner. It goes out as one G1, not two, so the path is the
//   diagonal rather than an L through whatever is in the way.
//
//   Nearer the centre is a fatter ring. The rings are equal in AREA, not in
//   thickness, which makes the innermost band the widest — and the finest step
//   is the one you press twenty times in a row while creeping up on an edge.
//
// Note on hold-to-jog: there is no continuous-jog command over HTTP polling, so
// holding a button fires repeated discrete relative moves, as DWC does. The
// repeat rate is deliberately conservative — queueing moves faster than the
// machine consumes them makes the button feel laggy and, worse, keeps moving
// after release.

import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, loadSetting, machine, saveSetting } from '../core/store.js';
import { BUSY_STATES } from '../machine/types.js';
import { empty } from '../ui/widgets.js';
import {
  FEED_LADDER,
  STEP_LADDER,
  nearestStep,
  ringSteps,
  stepLabel,
  stepTick,
} from '../core/steps.js';

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 180;

/** Rose geometry, in viewBox units. */
const OUTER_R = 100;
const HUB_R = 30;

/**
 * How ring thickness is distributed, as the exponent in
 * r(k) = hub + (outer − hub) · (k/n)^E.
 *
 * E = 1 gives equal thickness; E = 0.5 gives equal area. Equal area is the
 * right instinct — the finest step is the one pressed twenty times while
 * creeping onto an edge, so it should be the fattest band — but it starves the
 * outer rings badly enough at six rings that their labels no longer fit between
 * them. 0.7 keeps the centre generous while leaving the thinnest band about
 * two-thirds the width of the widest.
 */
const RING_EXPONENT = 0.7;

/**
 * The eight octants, anticlockwise from +X.
 *
 * Integer deltas: a diagonal gets the full ring distance on each axis. `angle`
 * is measured the way maths does — anticlockwise from +X — and the projection
 * below flips it into SVG's downward Y so that "up on screen" is +Y on the
 * machine.
 */
const OCTANTS: Array<{ dx: number; dy: number; angle: number; name: string }> = [
  { dx: 1, dy: 0, angle: 0, name: 'X+' },
  { dx: 1, dy: 1, angle: 45, name: 'X+ Y+' },
  { dx: 0, dy: 1, angle: 90, name: 'Y+' },
  { dx: -1, dy: 1, angle: 135, name: 'X− Y+' },
  { dx: -1, dy: 0, angle: 180, name: 'X−' },
  { dx: -1, dy: -1, angle: 225, name: 'X− Y−' },
  { dx: 0, dy: -1, angle: 270, name: 'Y−' },
  { dx: 1, dy: -1, angle: 315, name: 'X+ Y−' },
];

interface JogSettings {
  /** Index into STEP_LADDER of the outermost ring. */
  maxStep: number;
  feed: number;
  rings: number;
}

const DEFAULTS: JogSettings = { maxStep: nearestStep(10), feed: 1000, rings: 4 };

/** Point on the rose at radius `r` and maths-convention angle `deg`. */
function polar(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [r * Math.cos(a), -r * Math.sin(a)];
}

/**
 * SVG rotation that lays a label along its ring, upright.
 *
 * Tangential rather than horizontal, and not only for looks: horizontal labels
 * line up radially on the E and W spokes, so each one may be no WIDER than its
 * ring is thick — which is what forced the type down to near-illegible at six
 * rings. Along the arc, the constraint becomes font HEIGHT against ring
 * thickness, and the arc is far longer than the band is thick. Radial
 * collisions stop being possible and the type can grow.
 *
 * SVG angles run clockwise because Y points down, so the label's own angle is
 * −θ and the tangent is a further +90°. Anything that would end up reading
 * upside down — the whole southern half — is flipped by 180°, which is the same
 * line read from the other end.
 */
function labelRotation(deg: number): number {
  let r = -deg + 90;
  while (r > 90) r -= 180;
  while (r < -90) r += 180;
  return r;
}

/** Annular sector spanning `deg ± half`, as a path. */
function sectorPath(rInner: number, rOuter: number, deg: number, half: number): string {
  const [x1, y1] = polar(rOuter, deg - half);
  const [x2, y2] = polar(rOuter, deg + half);
  const [x3, y3] = polar(rInner, deg + half);
  const [x4, y4] = polar(rInner, deg - half);
  // sweep-flag 0 going out, 1 coming back: increasing maths angle is
  // anticlockwise on the machine, which is the negative sweep direction once
  // SVG's downward Y has flipped it.
  return (
    `M ${x1} ${y1} A ${rOuter} ${rOuter} 0 0 0 ${x2} ${y2} ` +
    `L ${x3} ${y3} A ${rInner} ${rInner} 0 0 1 ${x4} ${y4} Z`
  );
}

export class JogPanel extends PanelElement {
  private settings: JogSettings = { ...DEFAULTS, ...loadSetting<Partial<JogSettings>>('jog', {}) };
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatInterval: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
    });
    this.onDispose(() => this.stopRepeat());
  }

  private get canMove(): boolean {
    return connected.get() && !BUSY_STATES.has(machine.get().status);
  }

  /** Distances for each ring, innermost first. */
  private get steps(): number[] {
    return ringSteps(this.settings.maxStep, this.settings.rings);
  }

  /** NOT `update` — that is a LitElement lifecycle method. */
  private patchSettings(patch: Partial<JogSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSetting('jog', this.settings);
    this.requestUpdate();
  }

  /**
   * Fastest feed every axis in the move can sustain.
   *
   * Asking for more than the slowest one does not go faster — the firmware
   * clamps to what the combination allows — but showing a number the machine
   * will not honour makes the cursor a lie.
   */
  private feedLimit(axes: string[]): number {
    const limits = machine
      .get()
      .axes.filter((a) => axes.includes(a.letter) && a.maxFeed > 0)
      .map((a) => a.maxFeed);
    return limits.length ? Math.min(...limits) : Infinity;
  }

  // --- Motion -------------------------------------------------------------

  private move(deltas: Record<string, number>): void {
    const feed = Math.min(this.settings.feed, this.feedLimit(Object.keys(deltas)));
    void actions.jog(deltas, feed);
  }

  private startRepeat(deltas: Record<string, number>): void {
    this.stopRepeat();
    this.move(deltas);
    this.repeatTimer = setTimeout(() => {
      this.repeatInterval = setInterval(() => this.move(deltas), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  private stopRepeat(): void {
    if (this.repeatTimer) clearTimeout(this.repeatTimer);
    if (this.repeatInterval) clearInterval(this.repeatInterval);
    this.repeatTimer = null;
    this.repeatInterval = null;
  }

  /** Pointer handlers shared by every motion control, rose or column. */
  private pressHandlers(deltas: Record<string, number>) {
    return {
      onDown: (e: PointerEvent) => {
        if (!this.canMove) return;
        e.preventDefault();
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        this.startRepeat(deltas);
      },
      onUp: () => this.stopRepeat(),
    };
  }

  // --- Rose ---------------------------------------------------------------

  private renderRose(): SVGTemplateResult {
    const steps = this.steps;
    const enabled = this.canMove;

    const radius = (k: number) =>
      HUB_R + (OUTER_R - HUB_R) * (k / steps.length) ** RING_EXPONENT;

    const sectors: SVGTemplateResult[] = [];
    steps.forEach((mm, ring) => {
      const rInner = radius(ring);
      const rOuter = radius(ring + 1);
      // A hair of angular padding so neighbouring sectors read as separate
      // targets rather than one continuous band.
      const half = 22.5 - 1.2;
      const labelR = (rInner + rOuter) / 2;
      // Sized to the band. With the labels lying along their arc the limit is
      // the glyph height against the ring thickness, not the text width, so
      // this can be far more generous than it had to be when they were
      // horizontal.
      const fontSize = Math.max(5, Math.min(13, (rOuter - rInner) * 0.62));

      for (const octant of OCTANTS) {
        const [lx, ly] = polar(labelR, octant.angle);
        const deltas: Record<string, number> = {};
        if (octant.dx) deltas.X = octant.dx * mm;
        if (octant.dy) deltas.Y = octant.dy * mm;
        const { onDown, onUp } = this.pressHandlers(deltas);

        sectors.push(svg`
          <g
            class=${enabled ? 'rose-cell' : 'rose-cell disabled'}
            @pointerdown=${onDown}
            @pointerup=${onUp}
            @pointercancel=${onUp}
            @pointerleave=${onUp}
          >
            <title>${octant.name} ${stepLabel(mm)}mm</title>
            <path d=${sectorPath(rInner, rOuter, octant.angle, half)} />
            <text
              x=${lx}
              y=${ly}
              dy="0.36em"
              transform=${`rotate(${labelRotation(octant.angle)} ${lx} ${ly})`}
              style="font-size:${fontSize}px"
            >${stepTick(mm)}</text>
          </g>
        `);
      }
    });

    return svg`
      <svg class="rose" viewBox="-104 -104 208 208" role="group" aria-label="XY jog">
        ${sectors}
        <g
          class=${enabled ? 'rose-hub' : 'rose-hub disabled'}
          @click=${() => enabled && void actions.home(['X', 'Y'])}
        >
          <title>Home X and Y</title>
          <circle r=${HUB_R - 4} />
          <text y="4">⌂ XY</text>
        </g>
      </svg>
    `;
  }

  // --- Vertical axes ------------------------------------------------------

  /**
   * One axis as a column: largest step at the top, home in the middle, mirrored
   * below. The same ladder as the rose, so "the second cell out" means the same
   * distance whichever control you reach for.
   */
  private renderColumn(letter: string): TemplateResult {
    const steps = this.steps;
    const enabled = this.canMove;
    const button = (mm: number, sign: 1 | -1) => {
      const { onDown, onUp } = this.pressHandlers({ [letter]: sign * mm });
      return html`
        <button
          class="jog-cell"
          ?disabled=${!enabled}
          title="${letter}${sign > 0 ? '+' : '−'} ${stepLabel(mm)}mm"
          @pointerdown=${onDown}
          @pointerup=${onUp}
          @pointercancel=${onUp}
          @pointerleave=${onUp}
        >
          <span class="jog-arrow">${sign > 0 ? '▲' : '▼'}</span>
          <span class="jog-mm">${stepLabel(mm)}</span>
        </button>
      `;
    };

    return html`
      <div class="jog-column">
        <div class="jog-column-name">${letter}</div>
        ${[...steps].reverse().map((mm) => button(mm, 1))}
        <button
          class="jog-cell home"
          ?disabled=${!enabled}
          title="Home ${letter}"
          @click=${() => void actions.home([letter])}
        >
          ⌂
        </button>
        ${steps.map((mm) => button(mm, -1))}
      </div>
    `;
  }

  // --- Cursors ------------------------------------------------------------

  private renderCursors(): TemplateResult {
    const steps = this.steps;
    const feedCap = this.feedLimit(['X', 'Y']);
    const usable = FEED_LADDER.filter((f) => f <= feedCap);
    const feeds = usable.length ? usable : [FEED_LADDER[0]];
    const chosen = Math.min(this.settings.feed, feeds[feeds.length - 1]);
    const feedIndex = Math.max(0, feeds.indexOf(chosen) < 0 ? feeds.length - 1 : feeds.indexOf(chosen));

    return html`
      <div class="jog-cursors">
        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Reach</span>
            <strong>${stepLabel(steps[steps.length - 1])} mm</strong>
          </span>
          <input
            type="range"
            min="0"
            max=${STEP_LADDER.length - 1}
            step="1"
            .value=${String(this.settings.maxStep)}
            @input=${(e: Event) =>
              this.patchSettings({ maxStep: Number((e.target as HTMLInputElement).value) })}
          />
          <span class="jog-cursor-foot">
            <em>rings</em>${steps.map((s) => html`<em>${stepLabel(s)}</em>`)}
          </span>
        </label>

        <label class="jog-cursor">
          <span class="jog-cursor-head">
            <span>Speed</span>
            <strong>${chosen} mm/min</strong>
          </span>
          <input
            type="range"
            min="0"
            max=${feeds.length - 1}
            step="1"
            .value=${String(feedIndex)}
            @input=${(e: Event) =>
              this.patchSettings({ feed: feeds[Number((e.target as HTMLInputElement).value)] })}
          />
          <span class="jog-cursor-foot">
            <em>${isFinite(feedCap) ? `machine limit ${feedCap} mm/min` : ' '}</em>
          </span>
        </label>
      </div>
    `;
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const state = machine.get();
    if (!state.axes.length) return empty(connected.get() ? 'Waiting for axes…' : 'Not connected');

    const letters = new Set(state.axes.map((a) => a.letter));
    // Anything past X and Y — Z, and this machine's U dust shoe — gets its own
    // column beside the rose rather than being squeezed into it.
    const columns = state.axes.map((a) => a.letter).filter((l) => l !== 'X' && l !== 'Y');

    return html`
      <div class="jog">
        ${this.renderCursors()}

        <div class="jog-pads">
          ${letters.has('X') && letters.has('Y') ? this.renderRose() : nothing}
          ${columns.map((l) => this.renderColumn(l))}
        </div>

        <div class="jog-foot">
          <span class="label">Rings</span>
          <div class="segmented">
            ${[2, 3, 4, 5, 6].map(
              (n) => html`
                <button
                  class=${n === this.settings.rings ? 'seg active' : 'seg'}
                  @click=${() => this.patchSettings({ rings: n })}
                >
                  ${n}
                </button>
              `,
            )}
          </div>
          ${!this.canMove && connected.get()
            ? html`<span class="jog-blocked">Machine busy — jogging disabled</span>`
            : nothing}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-jog', JogPanel);

registerPanel({
  id: 'jog',
  title: 'Motion',
  tag: 'cnc-jog',
  defaultWidth: 4,
  defaultHeight: 460,
  description: 'Compass-rose jogging: direction and distance in one press',
});
