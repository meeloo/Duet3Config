// Import an SVG or DXF and cut it.
//
// The whole panel is arranged around one fact: **the file usually does not say
// how big it is.** An SVG sized in pixels and a DXF with $INSUNITS unset are
// both perfectly normal exports, and the difference between reading one as
// millimetres and as inches is a factor of 25.4. So the measured size in mm is
// shown large and permanently, the scale is always editable, and nothing can be
// cut without the size having been on screen first.
//
// Everything downstream of the drawing is deliberately somebody else's problem:
// offsetting is Clipper's, tabs and depth passes are the machining pack's, and
// the preview is the viewer's.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected, machine } from '../core/store.js';
import { checkField, numberField, selectField } from '../ui/widgets.js';
import { preview, saveAndRun } from '../ui/program.js';
import { importSvg } from '../import/svg.js';
import { importDxf } from '../import/dxf.js';
import { chain, place } from '../import/geometry.js';
import { offsetPaths, orderForCut, orientForCut, type CutSide } from '../import/offset.js';
import { boundsOf, type ImportedDrawing, type Polyline } from '../import/types.js';
import { profile } from '../cam/profile.js';
import type { GeneratedProgram } from '../cam/format.js';

/** Where to put the drawing's own bounding box in work coordinates. */
type Anchor = 'bottom-left' | 'centre' | 'as-drawn';

export class ImportPanel extends PanelElement {
  private drawing: ImportedDrawing | null = null;
  private error: string | null = null;
  private busy = false;

  // Placement
  private scale = 1;
  private anchor: Anchor = 'bottom-left';
  private originX = 0;
  private originY = 0;
  /** Join segments whose ends are this close, mm. */
  private joinTolerance = 0.05;
  private curveTolerance = 0.02;

  // Cutting
  private side: CutSide = 'outside';
  private climb = true;
  private toolDiameter = 3;
  private allowance = 0;
  private zTop = 0;
  private depth = 6;
  private depthPerPass = 1.5;
  private feedRate = 1200;
  private plungeFeed = 300;
  private rpm = 18000;
  private safeZ = 5;
  private spindleDwell = 3;
  private rampLength = 20;
  private tabCount = 4;
  private tabWidth = 6;
  private tabHeight = 1.5;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
  }

  // --- Loading ------------------------------------------------------------

  private async loadFile(file: File): Promise<void> {
    this.busy = true;
    this.error = null;
    this.requestUpdate();
    try {
      const text = await file.text();
      const isDxf = /\.dxf$/i.test(file.name) || /^\s*0\s*[\r\n]+\s*SECTION/.test(text.slice(0, 200));
      this.drawing = isDxf
        ? importDxf(text, { tolerance: this.curveTolerance, name: file.name })
        : importSvg(text, { tolerance: this.curveTolerance, name: file.name });
      // Take the file at its word initially; the size readout below is what
      // tells the operator whether that word was worth anything.
      this.scale = this.drawing.mmPerUnit;
    } catch (err) {
      this.drawing = null;
      this.error = (err as Error).message;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  // --- Geometry pipeline --------------------------------------------------

  /** Drawing units, joined into loops, scaled and placed into work coordinates. */
  private get placed(): Polyline[] {
    const drawing = this.drawing;
    if (!drawing) return [];

    // SVG's Y axis grows downward; the machine's grows up. Getting this wrong
    // mirrors the part, which is exactly the sort of mistake that survives a
    // glance at the preview and is only obvious in the material.
    const flipY = drawing.source === 'svg';
    const scaled = place(chain(drawing.paths, this.joinTolerance / Math.max(this.scale, 1e-9)), {
      scale: this.scale,
      flipY,
      offsetX: 0,
      offsetY: 0,
    });

    const box = boundsOf(scaled);
    if (!box) return scaled;

    let dx = this.originX;
    let dy = this.originY;
    if (this.anchor === 'bottom-left') {
      dx -= box.min[0];
      dy -= box.min[1];
    } else if (this.anchor === 'centre') {
      dx -= (box.min[0] + box.max[0]) / 2;
      dy -= (box.min[1] + box.max[1]) / 2;
    }
    return place(scaled, { scale: 1, flipY: false, offsetX: dx, offsetY: dy });
  }

  /**
   * Scale so the drawing comes out this wide.
   *
   * More useful than arguing with the file about units: whatever a pixel or an
   * unlabelled DXF unit was meant to be, the operator generally does know how
   * wide the part is supposed to end up.
   */
  private setWidth(mm: number): void {
    const current = this.size;
    if (!current || !(current.w > 1e-9) || !(mm > 0)) return;
    this.scale *= mm / current.w;
    this.requestUpdate();
  }

  private get size(): { w: number; h: number } | null {
    const box = boundsOf(this.placed);
    return box ? { w: box.max[0] - box.min[0], h: box.max[1] - box.min[1] } : null;
  }

  private build(): { program: GeneratedProgram; warnings: string[] } | null {
    const drawing = this.drawing;
    if (!drawing) return null;
    const paths = this.placed;
    if (!paths.length) return null;

    const { loops, warnings } = offsetPaths(paths, {
      side: this.side,
      toolDiameter: this.toolDiameter,
      allowance: this.allowance,
      tolerance: this.curveTolerance,
    });

    const ready = orderForCut(orientForCut(loops, this.climb, this.side));
    const size = this.size;

    const program = profile(ready, {
      toolDiameter: this.toolDiameter,
      zTop: this.zTop,
      depth: this.depth,
      depthPerPass: this.depthPerPass,
      feedRate: this.feedRate,
      plungeFeed: this.plungeFeed,
      rpm: this.rpm,
      safeZ: this.safeZ,
      spindleDwell: this.spindleDwell,
      tabs: { count: this.tabCount, width: this.tabWidth, height: this.tabHeight },
      rampLength: this.rampLength,
      sourceNote:
        `from ${drawing.name}` +
        (size ? `, ${size.w.toFixed(1)} x ${size.h.toFixed(1)}mm, ${this.side} of line` : ''),
    });

    return { program, warnings: [...warnings, ...program.warnings] };
  }

  // --- Render -------------------------------------------------------------

  private renderDrop(): TemplateResult {
    return html`
      <label
        class="import-drop"
        @dragover=${(e: DragEvent) => e.preventDefault()}
        @drop=${(e: DragEvent) => {
          e.preventDefault();
          const file = e.dataTransfer?.files?.[0];
          if (file) void this.loadFile(file);
        }}
      >
        <input
          type="file"
          accept=".svg,.dxf,image/svg+xml"
          @change=${(e: Event) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) void this.loadFile(file);
          }}
        />
        <strong>${this.busy ? 'Reading…' : 'Drop an SVG or DXF here'}</strong>
        <span class="hint">or click to choose a file</span>
      </label>
    `;
  }

  private renderPlacement(): TemplateResult {
    const drawing = this.drawing!;
    const size = this.size;
    const paths = this.placed;
    const closed = paths.filter((p) => p.closed).length;

    return html`
      <div class="import-summary">
        <div class="import-file">
          <strong>${drawing.name}</strong>
          <span class="hint">${drawing.source.toUpperCase()} · ${paths.length} path(s), ${closed} closed</span>
        </div>
        <div class="import-size">
          ${size ? html`${size.w.toFixed(1)} × ${size.h.toFixed(1)} <em>mm</em>` : '—'}
        </div>
      </div>

      ${drawing.units === 'unknown'
        ? html`<div class="warn-banner">
            This file does not state its size. It is being read as
            ${drawing.mmPerUnit === 1 ? 'millimetres' : `${drawing.mmPerUnit.toFixed(4)}mm per unit`} —
            check the measurement above against the real part before cutting.
            ${drawing.mmPerUnit === 1
              ? html`<button
                  class="tiny"
                  title="For a file whose coordinates are in inches"
                  @click=${() => ((this.scale *= 25.4), this.requestUpdate())}
                >
                  ×25.4 (the numbers are inches)
                </button>`
              : nothing}
          </div>`
        : nothing}
      ${drawing.warnings.map((w) => html`<div class="warn-banner">${w}</div>`)}

      <div class="param-grid">
        ${numberField('Scale', this.scale, (v) => ((this.scale = v), this.requestUpdate()), { suffix: 'mm/unit', step: 0.0001, title: 'Millimetres per unit of the source file. The size above updates as you change it.' })}
        ${size
          ? numberField('Make it wide', size.w, (v) => this.setWidth(v), { suffix: 'mm', min: 0.01, title: 'Type the width the finished part should be and the scale is worked out from it. Usually easier than knowing what a file\u2019s units were.' })
          : nothing}
        ${selectField('Place', this.anchor, [
          { value: 'bottom-left', label: 'Bottom-left at origin' },
          { value: 'centre', label: 'Centred on origin' },
          { value: 'as-drawn', label: 'As drawn' },
        ], (v) => ((this.anchor = v), this.requestUpdate()))}
        ${numberField('Origin X', this.originX, (v) => ((this.originX = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Origin Y', this.originY, (v) => ((this.originY = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Curve tolerance', this.curveTolerance, (v) => ((this.curveTolerance = v), this.requestUpdate()), { suffix: 'mm', step: 0.005, title: 'How far a flattened curve may stray from the true one.' })}
        ${numberField('Join gap', this.joinTolerance, (v) => ((this.joinTolerance = v), this.requestUpdate()), { suffix: 'mm', step: 0.01, title: 'Segment ends this close are treated as joined. A DXF rectangle is four separate lines and needs this to become one loop.' })}
      </div>
    `;
  }

  private renderCutting(): TemplateResult {
    return html`
      <div class="param-grid">
        ${selectField('Side', this.side, [
          { value: 'outside', label: 'Outside the line' },
          { value: 'inside', label: 'Inside the line' },
          { value: 'on', label: 'On the line' },
        ], (v) => ((this.side = v), this.requestUpdate()))}
        ${checkField('Climb milling', this.climb, (v) => ((this.climb = v), this.requestUpdate()))}
        ${numberField('Tool ⌀', this.toolDiameter, (v) => ((this.toolDiameter = v), this.requestUpdate()), { suffix: 'mm', step: 0.1 })}
        ${this.side === 'on'
          ? nothing
          : numberField('Leave stock', this.allowance, (v) => ((this.allowance = v), this.requestUpdate()), { suffix: 'mm', step: 0.05, title: 'Extra material left on the wall for a finishing pass.' })}
        ${numberField('Z top', this.zTop, (v) => ((this.zTop = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Depth', this.depth, (v) => ((this.depth = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Per pass', this.depthPerPass, (v) => ((this.depthPerPass = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Ramp', this.rampLength, (v) => ((this.rampLength = v), this.requestUpdate()), { suffix: 'mm', min: 0, title: 'Descend over this much travel along the path instead of plunging.' })}
        ${numberField('Feed', this.feedRate, (v) => ((this.feedRate = v), this.requestUpdate()), { suffix: 'mm/min' })}
        ${numberField('Plunge', this.plungeFeed, (v) => ((this.plungeFeed = v), this.requestUpdate()), { suffix: 'mm/min' })}
        ${numberField('RPM', this.rpm, (v) => ((this.rpm = v), this.requestUpdate()))}
        ${numberField('Safe Z', this.safeZ, (v) => ((this.safeZ = v), this.requestUpdate()), { suffix: 'mm' })}
        ${numberField('Tabs', this.tabCount, (v) => ((this.tabCount = Math.max(0, Math.round(v))), this.requestUpdate()), { suffix: 'off at 0', min: 0, step: 1 })}
        ${this.tabCount > 0
          ? html`
              ${numberField('Tab width', this.tabWidth, (v) => ((this.tabWidth = v), this.requestUpdate()), { suffix: 'mm' })}
              ${numberField('Tab height', this.tabHeight, (v) => ((this.tabHeight = v), this.requestUpdate()), { suffix: 'mm', step: 0.1 })}
            `
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const live = connected.get();
    const built = this.drawing ? this.build() : null;

    return html`
      <div class="pack import">
        ${this.error ? html`<div class="warn-banner">${this.error}</div>` : nothing}
        ${this.drawing === null
          ? this.renderDrop()
          : html`
              ${this.renderPlacement()}
              <div class="import-rule"></div>
              ${this.renderCutting()}
              ${built?.warnings.length
                ? html`<div class="warn-banner">${built.warnings.map((w) => html`<div>${w}</div>`)}</div>`
                : nothing}
              ${built ? html`<div class="pack-note">${built.program.summary}</div>` : nothing}
              <div class="pack-actions">
                <button class="tiny" @click=${() => ((this.drawing = null), this.requestUpdate())}>
                  Another file
                </button>
                <button ?disabled=${!built} @click=${() => built && preview(built.program)}>
                  Preview
                </button>
                <button
                  class="primary"
                  ?disabled=${!live || !built}
                  @click=${() => built && void saveAndRun(built.program)}
                >
                  Save &amp; run
                </button>
              </div>
            `}
      </div>
    `;
  }
}

customElements.define('cnc-import', ImportPanel);

registerPanel({
  id: 'import',
  title: 'Import',
  tag: 'cnc-import',
  defaultWidth: 5,
  defaultHeight: 560,
  description: 'Cut an SVG or DXF outline, offset for the tool',
});
