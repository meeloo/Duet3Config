// Machining pack: facing, pockets, contours with holding tabs, and drilling.
//
// These retire the hand-edited constants at the top of flattenSpoilboard.g and
// "Plane Stock.g" — same operations, but with the numbers in a form and the
// resulting toolpath visible in the viewer before anything spins.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { connected, machine } from '../core/store.js';
import { checkField, numberField, selectField } from '../ui/widgets.js';
import { preview, saveAndRun } from '../ui/program.js';
import {
  circle,
  drillPattern,
  facing,
  rectContour,
  rectPocket,
  type ContourSide,
  type DrillPattern,
} from '../cam/operations.js';
import type { GeneratedProgram } from '../cam/format.js';

type OpId = 'facing' | 'pocket' | 'rect' | 'circle' | 'drill';

const OPS: Array<{ id: OpId; label: string; blurb: string }> = [
  { id: 'facing', label: 'Facing', blurb: 'Raster-surface a rectangular area — stock or spoilboard.' },
  { id: 'pocket', label: 'Rect pocket', blurb: 'Clear a rectangular pocket, ramping in, with a finishing pass at the wall.' },
  { id: 'rect', label: 'Rect contour', blurb: 'Cut a rectangle, offset inside, outside or on the line, with holding tabs.' },
  { id: 'circle', label: 'Circle', blurb: 'Cut a circular contour, or clear a circular pocket.' },
  { id: 'drill', label: 'Drill', blurb: 'Peck-drill a grid, a line, or a bolt circle of holes.' },
];

export class MachiningPanel extends PanelElement {
  private op: OpId = 'facing';

  // Shared
  private toolDiameter = 25;
  private zTop = 0;
  private depth = 0.5;
  private depthPerPass = 0.5;
  private feedRate = 2000;
  private plungeFeed = 400;
  private rpm = 15000;
  private safeZ = 5;
  private spindleDwell = 3;

  // Facing
  private x0 = 0;
  private y0 = 0;
  private x1 = 300;
  private y1 = 300;
  private stepover = 0.6;
  private along: 'x' | 'y' = 'y';

  // Contour
  private side: ContourSide = 'outside';
  private climb = true;

  // Circle
  private cx = 0;
  private cy = 0;
  private diameter = 50;
  private pocket = false;

  // Tabs (contours only)
  private tabCount = 4;
  private tabWidth = 6;
  private tabHeight = 1.5;

  // Rect pocket
  private finishAllowance = 0.3;
  private rampLength = 20;

  // Drilling
  private drillPatternId: DrillPattern = 'grid';
  private countX = 3;
  private countY = 3;
  private spacingX = 30;
  private spacingY = 30;
  private holeCount = 6;
  private boltDiameter = 80;
  private startAngle = 0;
  private retract = 2;
  private dwellAtBottom = 0;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      machine.get();
    });
  }

  private common() {
    return {
      toolDiameter: this.toolDiameter,
      zTop: this.zTop,
      depth: this.depth,
      depthPerPass: this.depthPerPass,
      feedRate: this.feedRate,
      plungeFeed: this.plungeFeed,
      rpm: this.rpm,
      safeZ: this.safeZ,
      spindleDwell: this.spindleDwell,
    };
  }

  private get tabs() {
    return { count: this.tabCount, width: this.tabWidth, height: this.tabHeight };
  }

  private build(): GeneratedProgram {
    switch (this.op) {
      case 'facing':
        return facing({
          ...this.common(),
          x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1,
          stepover: this.stepover,
          along: this.along,
        });
      case 'pocket':
        return rectPocket({
          ...this.common(),
          x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1,
          stepover: this.stepover,
          along: this.along,
          finishAllowance: this.finishAllowance,
          rampLength: this.rampLength,
        });
      case 'rect':
        return rectContour({
          ...this.common(),
          x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1,
          side: this.side,
          climb: this.climb,
          tabs: this.tabs,
        });
      case 'circle':
        return circle({
          ...this.common(),
          cx: this.cx, cy: this.cy,
          diameter: this.diameter,
          side: this.side,
          climb: this.climb,
          pocket: this.pocket,
          stepover: this.stepover,
          tabs: this.tabs,
        });
      case 'drill':
        return drillPattern({
          ...this.common(),
          pattern: this.drillPatternId,
          x0: this.x0, y0: this.y0,
          countX: this.countX, countY: this.countY,
          spacingX: this.spacingX, spacingY: this.spacingY,
          x1: this.x1, y1: this.y1,
          count: this.holeCount,
          boltDiameter: this.boltDiameter,
          startAngle: this.startAngle,
          retract: this.retract,
          dwellAtBottom: this.dwellAtBottom,
        });
    }
  }

  /** Fill the area from the machine's travel limits, in work coordinates. */
  private useWholeTable(): void {
    const axes = machine.peek().axes;
    const x = axes.find((a) => a.letter === 'X');
    const y = axes.find((a) => a.letter === 'Y');
    if (!x || !y) return;
    const toWork = (a: typeof x, v: number) => v - (a.machine - a.work);
    this.x0 = toWork(x, x.min);
    this.x1 = toWork(x, x.max);
    this.y0 = toWork(y, y.min);
    this.y1 = toWork(y, y.max);
    this.requestUpdate();
  }

  private renderParams(): TemplateResult {
    const tool = html`
      ${numberField('Tool ⌀', this.toolDiameter, (v) => ((this.toolDiameter = v), this.requestUpdate()), { suffix: 'mm', step: 0.1 })}
      ${numberField('Z top', this.zTop, (v) => ((this.zTop = v), this.requestUpdate()), { suffix: 'mm', title: 'Top of the material in work coordinates — 0 after probing.' })}
      ${numberField('Depth', this.depth, (v) => ((this.depth = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Per pass', this.depthPerPass, (v) => ((this.depthPerPass = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Feed', this.feedRate, (v) => ((this.feedRate = v), this.requestUpdate()), { suffix: 'mm/min' })}
      ${numberField('Plunge', this.plungeFeed, (v) => ((this.plungeFeed = v), this.requestUpdate()), { suffix: 'mm/min' })}
      ${numberField('RPM', this.rpm, (v) => ((this.rpm = v), this.requestUpdate()))}
      ${numberField('Safe Z', this.safeZ, (v) => ((this.safeZ = v), this.requestUpdate()), { suffix: 'mm' })}
    `;

    const rect = html`
      ${numberField('X0', this.x0, (v) => ((this.x0 = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Y0', this.y0, (v) => ((this.y0 = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('X1', this.x1, (v) => ((this.x1 = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Y1', this.y1, (v) => ((this.y1 = v), this.requestUpdate()), { suffix: 'mm' })}
    `;

    const tabsForm = html`
      ${numberField('Tabs', this.tabCount, (v) => ((this.tabCount = Math.max(0, Math.round(v))), this.requestUpdate()), { suffix: 'off at 0', min: 0, step: 1, title: 'Bridges of material left so the part does not come loose on the last pass.' })}
      ${this.tabCount > 0
        ? html`
            ${numberField('Tab width', this.tabWidth, (v) => ((this.tabWidth = v), this.requestUpdate()), { suffix: 'mm', title: 'Flat length of each tab along the path. The tool ramps in and out either side of it.' })}
            ${numberField('Tab height', this.tabHeight, (v) => ((this.tabHeight = v), this.requestUpdate()), { suffix: 'mm', step: 0.1, title: 'Material left under the tool at the tab. Must be less than the cut depth.' })}
          `
        : nothing}
    `;

    switch (this.op) {
      case 'facing':
        return html`
          ${rect}
          ${numberField('Stepover', this.stepover * 100, (v) => ((this.stepover = v / 100), this.requestUpdate()), { suffix: '%', min: 5, max: 100 })}
          ${selectField('Raster along', this.along, [
            { value: 'y', label: 'Y (long axis)' },
            { value: 'x', label: 'X' },
          ], (v) => ((this.along = v), this.requestUpdate()))}
          ${tool}
        `;
      case 'pocket':
        return html`
          ${rect}
          ${numberField('Stepover', this.stepover * 100, (v) => ((this.stepover = v / 100), this.requestUpdate()), { suffix: '%', min: 5, max: 100 })}
          ${selectField('Raster along', this.along, [
            { value: 'y', label: 'Y (long axis)' },
            { value: 'x', label: 'X' },
          ], (v) => ((this.along = v), this.requestUpdate()))}
          ${numberField('Finish stock', this.finishAllowance, (v) => ((this.finishAllowance = v), this.requestUpdate()), { suffix: 'mm', step: 0.05, min: 0, title: 'Left on the wall by the roughing raster and removed by the wall loop at each level.' })}
          ${numberField('Ramp', this.rampLength, (v) => ((this.rampLength = v), this.requestUpdate()), { suffix: 'mm', min: 0, title: 'Length of the descent into each level. 0 plunges straight down — only safe with a centre-cutting tool.' })}
          ${tool}
        `;
      case 'rect':
        return html`
          ${rect}
          ${selectField('Side', this.side, [
            { value: 'outside', label: 'Outside the line' },
            { value: 'inside', label: 'Inside the line' },
            { value: 'on', label: 'On the line' },
          ], (v) => ((this.side = v), this.requestUpdate()))}
          ${checkField('Climb milling', this.climb, (v) => ((this.climb = v), this.requestUpdate()))}
          ${tabsForm}
          ${tool}
        `;
      case 'circle':
        return html`
          ${numberField('Centre X', this.cx, (v) => ((this.cx = v), this.requestUpdate()), { suffix: 'mm' })}
          ${numberField('Centre Y', this.cy, (v) => ((this.cy = v), this.requestUpdate()), { suffix: 'mm' })}
          ${numberField('Diameter', this.diameter, (v) => ((this.diameter = v), this.requestUpdate()), { suffix: 'mm' })}
          ${checkField('Clear the pocket', this.pocket, (v) => ((this.pocket = v), this.requestUpdate()))}
          ${this.pocket
            ? numberField('Stepover', this.stepover * 100, (v) => ((this.stepover = v / 100), this.requestUpdate()), { suffix: '%', min: 5, max: 100 })
            : selectField('Side', this.side, [
                { value: 'outside', label: 'Outside the line' },
                { value: 'inside', label: 'Inside the line' },
                { value: 'on', label: 'On the line' },
              ], (v) => ((this.side = v), this.requestUpdate()))}
          ${checkField('Climb milling', this.climb, (v) => ((this.climb = v), this.requestUpdate()))}
          ${this.pocket ? nothing : tabsForm}
          ${tool}
        `;
      case 'drill':
        return html`
          ${selectField('Pattern', this.drillPatternId, [
            { value: 'grid', label: 'Grid' },
            { value: 'line', label: 'Line' },
            { value: 'bolt', label: 'Bolt circle' },
          ], (v) => ((this.drillPatternId = v), this.requestUpdate()))}
          ${numberField(this.drillPatternId === 'bolt' ? 'Centre X' : 'X0', this.x0, (v) => ((this.x0 = v), this.requestUpdate()), { suffix: 'mm' })}
          ${numberField(this.drillPatternId === 'bolt' ? 'Centre Y' : 'Y0', this.y0, (v) => ((this.y0 = v), this.requestUpdate()), { suffix: 'mm' })}
          ${this.drillPatternId === 'grid'
            ? html`
                ${numberField('Columns', this.countX, (v) => ((this.countX = v), this.requestUpdate()), { min: 1, step: 1 })}
                ${numberField('Rows', this.countY, (v) => ((this.countY = v), this.requestUpdate()), { min: 1, step: 1 })}
                ${numberField('Pitch X', this.spacingX, (v) => ((this.spacingX = v), this.requestUpdate()), { suffix: 'mm' })}
                ${numberField('Pitch Y', this.spacingY, (v) => ((this.spacingY = v), this.requestUpdate()), { suffix: 'mm' })}
              `
            : nothing}
          ${this.drillPatternId === 'line'
            ? html`
                ${numberField('X1', this.x1, (v) => ((this.x1 = v), this.requestUpdate()), { suffix: 'mm' })}
                ${numberField('Y1', this.y1, (v) => ((this.y1 = v), this.requestUpdate()), { suffix: 'mm' })}
                ${numberField('Holes', this.holeCount, (v) => ((this.holeCount = v), this.requestUpdate()), { min: 1, step: 1, title: 'Including both ends.' })}
              `
            : nothing}
          ${this.drillPatternId === 'bolt'
            ? html`
                ${numberField('Circle ⌀', this.boltDiameter, (v) => ((this.boltDiameter = v), this.requestUpdate()), { suffix: 'mm' })}
                ${numberField('Holes', this.holeCount, (v) => ((this.holeCount = v), this.requestUpdate()), { min: 1, step: 1 })}
                ${numberField('First at', this.startAngle, (v) => ((this.startAngle = v), this.requestUpdate()), { suffix: '\u00b0', title: 'Angle of the first hole, measured anticlockwise from +X.' })}
              `
            : nothing}
          ${numberField('Retract', this.retract, (v) => ((this.retract = v), this.requestUpdate()), { suffix: 'mm', title: 'Height each peck pulls back to. Must clear the stock top to actually clear the flutes.' })}
          ${numberField('Dwell', this.dwellAtBottom, (v) => ((this.dwellAtBottom = v), this.requestUpdate()), { suffix: 's', min: 0, title: 'Pause at full depth on the last peck, for a clean hole bottom.' })}
          ${tool}
          <div class="param-note">
            <strong>Per pass</strong> is the peck depth here, and <strong>Tool ⌀</strong> is the
            drill diameter — the hole comes out at that size, since nothing is interpolated.
          </div>
        `;
    }
  }

  protected override render(): TemplateResult {
    const live = connected.get();
    const info = OPS.find((o) => o.id === this.op)!;
    const program = this.build();

    return html`
      <div class="pack">
        <div class="pack-bar">
          <div class="pack-tabs">
            ${OPS.map(
              (o) => html`
                <button
                  class=${o.id === this.op ? 'seg active' : 'seg'}
                  title=${o.blurb}
                  @click=${() => ((this.op = o.id), this.requestUpdate())}
                >
                  ${o.label}
                </button>
              `,
            )}
          </div>
          ${this.op === 'facing' || this.op === 'pocket' || this.op === 'rect'
            ? html`<button class="tiny" title="Fill the area from the machine's travel limits"
                @click=${() => this.useWholeTable()}>Whole table</button>`
            : nothing}
        </div>

        <div class="pack-blurb">${info.blurb}</div>
        <div class="param-grid">${this.renderParams()}</div>

        <div class="pack-note">${program.summary}</div>
        ${program.warnings.length
          ? html`<div class="warn-banner">${program.warnings.map((w) => html`<div>${w}</div>`)}</div>`
          : nothing}

        <div class="pack-actions">
          <button @click=${() => preview(program)}>Preview</button>
          <button class="primary" ?disabled=${!live} @click=${() => void saveAndRun(program)}>
            Save &amp; run
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-machining', MachiningPanel);

registerPanel({
  id: 'machining',
  title: 'Machining',
  tag: 'cnc-machining',
  defaultWidth: 6,
  defaultHeight: 480,
  description: 'Facing, contours and pockets without CAM',
});
