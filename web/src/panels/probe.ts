// Probing pack.
//
// Routines are grouped by the probe ROLE they need. A routine whose role has no
// probe assigned is listed but disabled, with the reason shown — that is how the
// planned feature probe stays genuinely separate from the tool setter and the
// corner probe rather than quietly borrowing one of them.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { capabilities, connected, machine } from '../core/store.js';
import { checkField, numberField, selectField } from '../ui/widgets.js';
import { preview, saveAndRun } from '../ui/program.js';
import {
  DEFAULT_PROBE_MAP,
  ROLES,
  loadProbeMap,
  saveProbeMap,
  type CornerX,
  type CornerY,
  type ProbeMap,
  type ProbeRole,
} from '../probing/types.js';
import { probeBore, probeCorner, probeEdge, probeSkew, probeToolLength, probeZ } from '../probing/rrf.js';
import type { GeneratedProgram } from '../cam/format.js';

type RoutineId = 'toolLength' | 'corner' | 'edge' | 'skew' | 'zsurface' | 'bore';

interface RoutineInfo {
  id: RoutineId;
  label: string;
  role: ProbeRole;
  blurb: string;
}

const ROUTINES: RoutineInfo[] = [
  { id: 'toolLength', label: 'Tool length', role: 'toolLength', blurb: 'Measure the tool on the fixed setter and set its Z offset.' },
  { id: 'corner', label: 'Corner', role: 'workpiece', blurb: 'Find a stock corner and set the work origin.' },
  { id: 'edge', label: 'Single edge', role: 'workpiece', blurb: 'Touch one face and assign it a coordinate.' },
  { id: 'skew', label: 'Skew', role: 'workpiece', blurb: 'Touch one edge twice and rotate the coordinate system onto it.' },
  { id: 'zsurface', label: 'Z surface', role: 'workpiece', blurb: 'Zero Z on the top of the stock or a touch plate.' },
  { id: 'bore', label: 'Bore / boss centre', role: 'feature', blurb: 'Find the centre of a hole or round boss.' },
];

export class ProbePanel extends PanelElement {
  private probeMap: ProbeMap = loadProbeMap();
  private routine: RoutineId = 'corner';
  private showSetup = false;

  // Shared probing parameters.
  private tipDiameter = 3;
  private feedFast = 400;
  private feedSlow = 60;
  private maxTravel = 30;
  private backoff = 2;
  private safeZ = 5;

  // Per-routine parameters.
  private plateThickness = 0;
  private cornerX: CornerX = 'left';
  private cornerY: CornerY = 'back';
  private clearance = 12;
  private probeDepth = 5;
  private includeZ = true;
  private edgeAxis: 'X' | 'Y' = 'X';
  private edgeDirection: 1 | -1 = 1;
  private edgeSetTo = 0;
  private nominalDiameter = 20;
  private outsideFeature = false;
  private skewEdgeAxis: 'X' | 'Y' = 'X';
  private skewApproach: 1 | -1 = 1;
  private skewSpan = 80;
  private skewTravel: 1 | -1 = 1;
  private skewCentreX = 0;
  private skewCentreY = 0;
  private skewMaxAngle = 5;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private globals(): Record<string, unknown> {
    return (machine.peek().extras.global as Record<string, unknown>) ?? {};
  }

  private num(key: string, fallback: number): number {
    const v = this.globals()[key];
    return typeof v === 'number' ? v : fallback;
  }

  private get wcs(): number {
    return machine.peek().wcs || 1;
  }

  private probeIndexFor(role: ProbeRole): number | null {
    return this.probeMap[role];
  }

  // --- Program construction ---------------------------------------------

  private build(): GeneratedProgram | null {
    const info = ROUTINES.find((r) => r.id === this.routine)!;
    const probeIndex = this.probeIndexFor(info.role);
    if (probeIndex === null) return null;

    const common = {
      probeIndex,
      tipDiameter: this.tipDiameter,
      feedFast: this.feedFast,
      feedSlow: this.feedSlow,
      maxTravel: this.maxTravel,
      backoff: this.backoff,
      safeZ: this.safeZ,
      wcs: this.wcs,
    };

    switch (this.routine) {
      case 'toolLength': {
        // Defaults come from this machine's own ATC globals rather than being
        // typed in twice and drifting apart.
        const dustShoe = machine.peek().axes.find((a) => a.letter === 'U');
        return probeToolLength({
          ...common,
          probeX: this.num('atcProbeX', 3),
          probeY: this.num('atcProbeY', 1260),
          probeZ: this.num('atcProbeZ', 41.3),
          retractZ: this.num('atcRetractZ', 135),
          dustShoeAxis: dustShoe ? 'U' : null,
        });
      }
      case 'corner':
        return probeCorner({
          ...common,
          plateThickness: this.plateThickness,
          cornerX: this.cornerX,
          cornerY: this.cornerY,
          clearance: this.clearance,
          probeDepth: this.probeDepth,
          includeZ: this.includeZ,
        });
      case 'edge':
        return probeEdge({
          ...common,
          axis: this.edgeAxis,
          direction: this.edgeDirection,
          setTo: this.edgeSetTo,
        });
      case 'skew':
        return probeSkew({
          ...common,
          edgeAxis: this.skewEdgeAxis,
          approach: this.skewApproach,
          span: this.skewSpan,
          travel: this.skewTravel,
          centreX: this.skewCentreX,
          centreY: this.skewCentreY,
          maxAngle: this.skewMaxAngle,
        });
      case 'zsurface':
        return probeZ({ ...common, plateThickness: this.plateThickness });
      case 'bore':
        return probeBore({
          ...common,
          nominalDiameter: this.nominalDiameter,
          outside: this.outsideFeature,
        });
    }
  }

  // --- Render ------------------------------------------------------------

  private renderSetup(): TemplateResult {
    return html`
      <div class="probe-setup">
        <p class="hint">
          Assign each role to a controller probe index (the <code>K</code> parameter from
          <code>M558</code>). A role with no probe leaves its routines disabled.
        </p>
        ${ROLES.map((r) => {
          const current = this.probeMap[r.role];
          return html`
            <label class="param" title=${r.description}>
              <span class="param-label">${r.label}</span>
              <span class="param-input">
                <select
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.probeMap = { ...this.probeMap, [r.role]: v === '' ? null : Number(v) };
                    saveProbeMap(this.probeMap);
                    this.requestUpdate();
                  }}
                >
                  <option value="" ?selected=${current === null}>not fitted</option>
                  ${[0, 1, 2, 3].map(
                    (k) => html`<option value=${k} ?selected=${current === k}>K${k}</option>`,
                  )}
                </select>
              </span>
            </label>
            <div class="param-note">${r.description}</div>
          `;
        })}
        <button
          class="ghost"
          @click=${() => {
            this.probeMap = { ...DEFAULT_PROBE_MAP };
            saveProbeMap(this.probeMap);
            this.requestUpdate();
          }}
        >
          Reset to this machine's defaults
        </button>
      </div>
    `;
  }

  private renderParams(): TemplateResult {
    const shared = html`
      ${numberField('Tip ⌀', this.tipDiameter, (v) => ((this.tipDiameter = v), this.requestUpdate()), { suffix: 'mm', step: 0.1, title: 'Effective probe tip diameter — calibrate this before trusting measured sizes.' })}
      ${numberField('Search feed', this.feedFast, (v) => ((this.feedFast = v), this.requestUpdate()), { suffix: 'mm/min' })}
      ${numberField('Touch feed', this.feedSlow, (v) => ((this.feedSlow = v), this.requestUpdate()), { suffix: 'mm/min' })}
      ${numberField('Max travel', this.maxTravel, (v) => ((this.maxTravel = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Back off', this.backoff, (v) => ((this.backoff = v), this.requestUpdate()), { suffix: 'mm' })}
      ${numberField('Safe Z', this.safeZ, (v) => ((this.safeZ = v), this.requestUpdate()), { suffix: 'mm' })}
    `;

    switch (this.routine) {
      case 'toolLength':
        return html`
          ${shared}
          <div class="param-note">
            Setter position and trigger height come from <code>global.atcProbe*</code> — currently
            X${this.num('atcProbeX', 3)} Y${this.num('atcProbeY', 1260)} Z${this.num('atcProbeZ', 41.3)}.
            Edit them in <code>atcConfig.g</code> or the Machine Model panel.
          </div>
        `;
      case 'corner':
        return html`
          ${selectField('Corner X', this.cornerX, [
            { value: 'left', label: 'Left (probe approaches +X)' },
            { value: 'right', label: 'Right (probe approaches −X)' },
          ], (v) => ((this.cornerX = v), this.requestUpdate()))}
          ${selectField('Corner Y', this.cornerY, [
            { value: 'back', label: 'Back (probe approaches −Y)' },
            { value: 'front', label: 'Front (probe approaches +Y)' },
          ], (v) => ((this.cornerY = v), this.requestUpdate()))}
          ${checkField('Also zero Z on the top face', this.includeZ, (v) => ((this.includeZ = v), this.requestUpdate()))}
          ${numberField('Plate thickness', this.plateThickness, (v) => ((this.plateThickness = v), this.requestUpdate()), { suffix: 'mm', step: 0.01, title: '0 when probing the surface directly.' })}
          ${numberField('Standoff', this.clearance, (v) => ((this.clearance = v), this.requestUpdate()), { suffix: 'mm', title: 'How far outside the edge to stand before probing sideways.' })}
          ${numberField('Side depth', this.probeDepth, (v) => ((this.probeDepth = v), this.requestUpdate()), { suffix: 'mm', title: 'How far below the top face to touch the side.' })}
          ${shared}
        `;
      case 'edge':
        return html`
          ${selectField('Axis', this.edgeAxis, [
            { value: 'X', label: 'X' },
            { value: 'Y', label: 'Y' },
          ], (v) => ((this.edgeAxis = v), this.requestUpdate()))}
          ${selectField('Direction', String(this.edgeDirection) as '1' | '-1', [
            { value: '1', label: 'Positive' },
            { value: '-1', label: 'Negative' },
          ], (v) => ((this.edgeDirection = Number(v) as 1 | -1), this.requestUpdate()))}
          ${numberField('Set edge to', this.edgeSetTo, (v) => ((this.edgeSetTo = v), this.requestUpdate()), { suffix: 'mm' })}
          ${shared}
        `;
      case 'skew':
        return html`
          ${selectField('Edge along', this.skewEdgeAxis, [
            { value: 'X', label: 'X · touch in Y' },
            { value: 'Y', label: 'Y · touch in X' },
          ], (v) => ((this.skewEdgeAxis = v), this.requestUpdate()))}
          ${selectField('Approach', String(this.skewApproach) as '1' | '-1', [
            { value: '1', label: 'Positive' },
            { value: '-1', label: 'Negative' },
          ], (v) => ((this.skewApproach = Number(v) as 1 | -1), this.requestUpdate()))}
          ${selectField('Travel', String(this.skewTravel) as '1' | '-1', [
            { value: '1', label: `+${this.skewEdgeAxis}` },
            { value: '-1', label: `−${this.skewEdgeAxis}` },
          ], (v) => ((this.skewTravel = Number(v) as 1 | -1), this.requestUpdate()))}
          ${numberField('Span', this.skewSpan, (v) => ((this.skewSpan = v), this.requestUpdate()), { suffix: 'mm', min: 1, title: 'Distance between the two touch points. Longer is more accurate — angle error falls off as 1/span.' })}
          ${numberField('Pivot X', this.skewCentreX, (v) => ((this.skewCentreX = v), this.requestUpdate()), { suffix: 'mm', title: 'Rotation centre in work coordinates. Leave at 0,0 to pivot about the work origin.' })}
          ${numberField('Pivot Y', this.skewCentreY, (v) => ((this.skewCentreY = v), this.requestUpdate()), { suffix: 'mm' })}
          ${numberField('Abort above', this.skewMaxAngle, (v) => ((this.skewMaxAngle = v), this.requestUpdate()), { suffix: '\u00b0', title: 'A missed touch reads as a huge angle. Above this the macro aborts instead of rotating.' })}
          ${shared}
          <div class="param-note">
            Tip diameter does not affect the result — both touches are offset by the same radius,
            so it cancels. This is the one routine in the pack that does not depend on tip
            calibration.
          </div>
        `;
      case 'zsurface':
        return html`
          ${numberField('Plate thickness', this.plateThickness, (v) => ((this.plateThickness = v), this.requestUpdate()), { suffix: 'mm', step: 0.01 })}
          ${shared}
        `;
      case 'bore':
        return html`
          ${checkField('Outside feature (boss)', this.outsideFeature, (v) => ((this.outsideFeature = v), this.requestUpdate()))}
          ${numberField('Nominal ⌀', this.nominalDiameter, (v) => ((this.nominalDiameter = v), this.requestUpdate()), { suffix: 'mm' })}
          ${shared}
        `;
    }
  }

  protected override render(): TemplateResult {
    const live = connected.get();
    const info = ROUTINES.find((r) => r.id === this.routine)!;
    const probeIndex = this.probeIndexFor(info.role);
    const program = probeIndex === null ? null : this.build();

    return html`
      <div class="pack">
        <div class="pack-bar">
          <div class="pack-tabs">
            ${ROUTINES.map((r) => {
              const ready = this.probeIndexFor(r.role) !== null;
              return html`
                <button
                  class=${r.id === this.routine ? 'seg active' : 'seg'}
                  title=${ready ? r.blurb : `${r.blurb} (no probe assigned to the ${r.role} role)`}
                  @click=${() => ((this.routine = r.id), this.requestUpdate())}
                >
                  ${r.label}${ready ? '' : ' ·'}
                </button>
              `;
            })}
          </div>
          <button class="tiny" @click=${() => ((this.showSetup = !this.showSetup), this.requestUpdate())}>
            ${this.showSetup ? 'Done' : 'Probes…'}
          </button>
        </div>

        ${this.showSetup
          ? this.renderSetup()
          : html`
              <div class="pack-blurb">${info.blurb}</div>
              ${probeIndex === null
                ? html`
                    <div class="warn-banner">
                      No probe assigned to the <strong>${info.role}</strong> role. This routine needs
                      its own probe — assign one under <em>Probes…</em> once it is wired and
                      configured with <code>M558</code>.
                    </div>
                  `
                : html`
                    <div class="pack-note">Using probe <code>K${probeIndex}</code>, writing G${53 + this.wcs}</div>
                    <div class="param-grid">${this.renderParams()}</div>
                    ${program?.warnings.length
                      ? html`<div class="warn-banner">${program.warnings.map((w) => html`<div>${w}</div>`)}</div>`
                      : nothing}
                    <div class="pack-actions">
                      <button ?disabled=${!program} @click=${() => program && preview(program)}>
                        Preview
                      </button>
                      <button
                        class="primary"
                        ?disabled=${!live || !program}
                        @click=${() => program && void saveAndRun(program)}
                      >
                        Save &amp; run
                      </button>
                    </div>
                  `}
            `}
      </div>
    `;
  }
}

customElements.define('cnc-probe', ProbePanel);

registerPanel({
  id: 'probe',
  title: 'Probing',
  tag: 'cnc-probe',
  defaultWidth: 6,
  defaultHeight: 480,
  available: (caps) => caps.macros,
  description: 'Tool length, corner, edge and feature probing',
});
