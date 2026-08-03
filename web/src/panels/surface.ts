// Surface scan and height map.
//
// A 750×1500 spoilboard is never flat, and neither is a sheet of ply. Probing a
// grid over the work and letting the controller correct Z against it is the
// difference between an engraving that cuts through in one corner and vanishes
// in the other, and one that doesn't.
//
// Two things this panel is careful about.
//
//   The scan runs on the probe assigned to the `workpiece` role, never on
//   probe 0. On this machine probe 0 is the tool-length setter; a grid scan
//   that fired it would drive the spindle at the setter once per point.
//
//   Compensation, once loaded, silently changes Z on every move — including
//   jogs. That gets a banner, the same as coordinate rotation, because a Z
//   offset you have forgotten about is indistinguishable from a broken machine.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, activeDriver, appendLog, capabilities, connected, machine, run } from '../core/store.js';
import { formatDuration } from '../core/util.js';
import { numberField } from '../ui/widgets.js';
import { theme } from '../core/theme.js';
import { diverging } from '../core/oklab.js';
import { loadProbeMap } from '../probing/types.js';
import { parseHeightMap, type HeightMap } from '../surface/heightmap.js';
import {
  CLEAR_COMMAND,
  HEIGHTMAP_PATH,
  applyCommand,
  defineGridCommand,
  estimateScanSeconds,
  scanCommand,
  scanPointCount,
  type ScanArea,
} from '../surface/rrf.js';

/**
 * Diverging ramp: below nominal ← neutral → above nominal.
 *
 * Two hues with a genuinely neutral midpoint, so "flat here" reads as absence
 * rather than as a colour. A single-hue ramp would hide which side of zero a
 * point is on, and a rainbow would invent boundaries the data does not have.
 * Both modes are stepped for their own surface rather than flipped.
 */
const RAMP = {
  light: { cool: '#104281', neutral: '#f0efec', warm: '#8f1f1c' },
  dark: { cool: '#86b6ef', neutral: '#383835', warm: '#f0918f' },
};

/** Cell size bounds, px. Keeps the map readable without letting it own the panel. */
const MAX_CELL_PX = 26;
const MAX_MAP_PX = 300;

export class SurfacePanel extends PanelElement {
  private area: ScanArea = { x0: 0, y0: 0, x1: 300, y1: 300, spacingX: 25, spacingY: 25 };
  private map: HeightMap | null = null;
  private mapError: string | null = null;
  private loading = false;
  private canvas: HTMLCanvasElement | null = null;
  private hover: { row: number; col: number } | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
      theme.get();
    });
  }

  protected override updated(): void {
    this.canvas = this.querySelector('canvas.surf-map');
    this.draw();
  }

  private get probeIndex(): number | null {
    return loadProbeMap().workpiece;
  }

  private get points() {
    return scanPointCount(this.area);
  }

  private set(key: keyof ScanArea, value: number): void {
    this.area = { ...this.area, [key]: value };
    this.requestUpdate();
  }

  /** Fill the scan area from the machine's travel limits, in work coordinates. */
  private useWholeTable(): void {
    const axes = machine.peek().axes;
    const x = axes.find((a) => a.letter === 'X');
    const y = axes.find((a) => a.letter === 'Y');
    if (!x || !y) return;
    const toWork = (a: typeof x, v: number) => v - (a.machine - a.work);
    this.area = {
      ...this.area,
      x0: toWork(x, x.min),
      x1: toWork(x, x.max),
      y0: toWork(y, y.min),
      y1: toWork(y, y.max),
    };
    this.requestUpdate();
  }

  // --- Actions ------------------------------------------------------------

  private async scan(): Promise<void> {
    const probe = this.probeIndex;
    if (probe === null) return;
    const { total } = this.points;
    const estimate = estimateScanSeconds(total, 5, 400, 3000, Math.min(this.area.spacingX, this.area.spacingY));
    if (
      !confirm(
        `Probe ${total} points with probe K${probe}?\n\n` +
          `Rough estimate: ${formatDuration(estimate)}.\n\n` +
          'The machine must be homed and the probe must reach every point. ' +
          'Press the emergency stop if it heads somewhere unexpected.',
      )
    ) {
      return;
    }
    await actions.send(defineGridCommand(this.area));
    await actions.send(scanCommand(probe));
    appendLog({
      level: 'info',
      text: `Scanning ${total} points — load the map when the machine goes idle`,
      time: new Date(),
    });
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.mapError = null;
    this.requestUpdate();

    const bytes = await run('read height map', (d) => d.readFile(HEIGHTMAP_PATH));
    this.loading = false;
    if (!bytes) {
      this.mapError = `Could not read ${HEIGHTMAP_PATH}. Run a scan first.`;
      this.requestUpdate();
      return;
    }
    try {
      this.map = parseHeightMap(new TextDecoder().decode(bytes));
    } catch (err) {
      this.map = null;
      this.mapError = (err as Error).message;
    }
    this.requestUpdate();
  }

  // --- Heat map -----------------------------------------------------------

  /** Largest absolute deviation, which sets both ends of the ramp. */
  private get span(): number {
    if (!this.map) return 1;
    return Math.max(Math.abs(this.map.min), Math.abs(this.map.max), 0.001);
  }

  private draw(): void {
    const canvas = this.canvas;
    const map = this.map;
    if (!canvas || !map) return;

    const ramp = theme.peek() === 'dark' ? RAMP.dark : RAMP.light;
    const dpr = window.devicePixelRatio || 1;
    // Square cells: the map is a picture of the table, and stretching it to fill
    // the panel would misrepresent where the high spot actually is. Bounded on
    // both axes so a coarse grid in a wide panel doesn't blow up into cells the
    // size of a fist and push the statistics off the bottom.
    const available = canvas.parentElement?.clientWidth ?? canvas.clientWidth;
    const cell = Math.max(
      4,
      Math.min(MAX_CELL_PX, Math.floor(available / map.xNum), Math.floor(MAX_MAP_PX / map.yNum)),
    );
    const width = cell * map.xNum;
    const height = cell * map.yNum;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const span = this.span;
    for (let row = 0; row < map.yNum; row++) {
      for (let col = 0; col < map.xNum; col++) {
        const v = map.values[row][col];
        // Canvas Y grows downward; grid row 0 is the lowest Y, so rows are drawn
        // bottom-up or the map comes out mirrored against the machine.
        const y = (map.yNum - 1 - row) * cell;
        const x = col * cell;
        if (v === null) {
          // Not probed. Hatched rather than coloured — a hole in the data must
          // not look like a measurement of zero.
          ctx.fillStyle = ramp.neutral;
          ctx.fillRect(x, y, cell, cell);
          ctx.strokeStyle = 'rgba(128,128,128,0.55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, y + cell);
          ctx.lineTo(x + cell, y);
          ctx.stroke();
        } else {
          ctx.fillStyle = diverging(ramp, v / span);
          ctx.fillRect(x, y, cell, cell);
        }
        if (this.hover && this.hover.row === row && this.hover.col === col) {
          ctx.strokeStyle = 'currentColor';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
        }
      }
    }
  }

  private onMove(e: MouseEvent): void {
    const map = this.map;
    const canvas = this.canvas;
    if (!map || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cell = rect.width / map.xNum;
    const col = Math.floor((e.clientX - rect.left) / cell);
    const row = map.yNum - 1 - Math.floor((e.clientY - rect.top) / cell);
    const next = col >= 0 && col < map.xNum && row >= 0 && row < map.yNum ? { row, col } : null;
    if (next?.row !== this.hover?.row || next?.col !== this.hover?.col) {
      this.hover = next;
      this.requestUpdate();
    }
  }

  private renderLegend(): TemplateResult {
    const ramp = theme.get() === 'dark' ? RAMP.dark : RAMP.light;
    const span = this.span;
    const stops = Array.from({ length: 11 }, (_, i) => diverging(ramp, -1 + i / 5));
    return html`
      <div class="surf-legend">
        <span>−${span.toFixed(3)}</span>
        <span class="surf-bar" style="background: linear-gradient(to right, ${stops.join(', ')})"></span>
        <span>+${span.toFixed(3)} mm</span>
      </div>
    `;
  }

  private renderMap(): TemplateResult {
    const map = this.map!;
    const hovered =
      this.hover ? map.values[this.hover.row][this.hover.col] : null;
    const hoveredXY = this.hover
      ? [map.xMin + this.hover.col * map.xSpacing, map.yMin + this.hover.row * map.ySpacing]
      : null;

    return html`
      <div class="surf-map-wrap">
        <canvas
          class="surf-map"
          @mousemove=${(e: MouseEvent) => this.onMove(e)}
          @mouseleave=${() => ((this.hover = null), this.requestUpdate())}
        ></canvas>
        ${this.renderLegend()}
        <div class="surf-readout">
          ${hoveredXY
            ? html`X${hoveredXY[0].toFixed(1)} Y${hoveredXY[1].toFixed(1)} →
                ${hovered === null ? 'not probed' : `${hovered.toFixed(3)} mm`}`
            : html`Hover a cell for its height.`}
        </div>
        <table class="surf-stats">
          <tbody>
            <tr>
              <th>Grid</th>
              <td>${map.xNum} × ${map.yNum} at ${map.xSpacing}×${map.ySpacing}mm</td>
              <th>Probed</th>
              <td>${map.probed} of ${map.xNum * map.yNum}</td>
            </tr>
            <tr>
              <th>Area</th>
              <td>X${map.xMin}…${map.xMax} Y${map.yMin}…${map.yMax}</td>
              <th>Range</th>
              <td>${map.min.toFixed(3)} … ${map.max.toFixed(3)} mm</td>
            </tr>
            <tr>
              <th>Mean</th>
              <td>${map.mean.toFixed(3)} mm</td>
              <th>Deviation</th>
              <td>${map.deviation.toFixed(3)} mm</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const live = connected.get();
    const caps = capabilities.get();
    const state = machine.get();
    const probe = this.probeIndex;
    const { x, y, total } = this.points;
    const active = state.compensation;

    if (!caps.surfaceMap) {
      return html`<div class="empty">
        ${activeDriver()?.label ?? 'This controller'} does not support height-map compensation.
      </div>`;
    }

    return html`
      <div class="surface">
        ${active
          ? html`<div class="warn-banner">
              Height-map compensation is <strong>on</strong>${active.file ? ` (${active.file})` : ''}.
              Z is corrected against the map on every move, including jogs.
              ${active.deviation != null ? html`Deviation ${active.deviation.toFixed(3)}mm.` : nothing}
            </div>`
          : nothing}
        ${probe === null
          ? html`<div class="warn-banner">
              No probe assigned to the <strong>workpiece</strong> role. Assign one under
              <em>Probes…</em> in the Probing panel — scanning must not run on the tool setter.
            </div>`
          : nothing}

        <div class="param-grid">
          ${numberField('X0', this.area.x0, (v) => this.set('x0', v), { suffix: 'mm' })}
          ${numberField('X1', this.area.x1, (v) => this.set('x1', v), { suffix: 'mm' })}
          ${numberField('Y0', this.area.y0, (v) => this.set('y0', v), { suffix: 'mm' })}
          ${numberField('Y1', this.area.y1, (v) => this.set('y1', v), { suffix: 'mm' })}
          ${numberField('Pitch X', this.area.spacingX, (v) => this.set('spacingX', v), { suffix: 'mm', min: 1 })}
          ${numberField('Pitch Y', this.area.spacingY, (v) => this.set('spacingY', v), { suffix: 'mm', min: 1 })}
          <div class="param-note">
            ${x} × ${y} = <strong>${total} points</strong>, roughly
            ${formatDuration(estimateScanSeconds(total, 5, 400, 3000, Math.min(this.area.spacingX, this.area.spacingY)))}.
            The grid is <code>${defineGridCommand(this.area)}</code>, scanned with
            <code>${probe === null ? 'G29 K? S0' : scanCommand(probe)}</code>.
          </div>
        </div>

        <div class="pack-actions">
          <button class="tiny" @click=${() => this.useWholeTable()}>Whole table</button>
          <button ?disabled=${!live || probe === null} @click=${() => void this.scan()}>Scan</button>
          <button ?disabled=${!live || this.loading} @click=${() => void this.load()}>
            ${this.loading ? 'Loading…' : 'Load map'}
          </button>
          <button ?disabled=${!live} @click=${() => void actions.send(applyCommand())}>
            Apply
          </button>
          <button ?disabled=${!live || !active} @click=${() => void actions.send(CLEAR_COMMAND)}>
            Turn off
          </button>
        </div>

        ${this.mapError ? html`<div class="warn-banner">${this.mapError}</div>` : nothing}
        ${this.map ? this.renderMap() : html`<p class="hint">
          Scan, wait for the machine to go idle, then <em>Load map</em> to see the result.
          <em>Apply</em> switches compensation on; it stays on until turned off or the board resets.
        </p>`}
      </div>
    `;
  }
}

customElements.define('cnc-surface', SurfacePanel);

registerPanel({
  id: 'surface',
  title: 'Surface',
  tag: 'cnc-surface',
  defaultWidth: 5,
  defaultHeight: 520,
  available: (caps) => caps.surfaceMap,
  description: 'Probe a grid into a height map and compensate Z against it',
});
