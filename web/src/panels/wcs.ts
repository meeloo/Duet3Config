// Work coordinate systems.
//
// Nine fixtures, each with its own origin, and no way to see more than one of
// them at a time in DWC. The whole value of this panel is the table: every
// system's offsets side by side, so "which one did I set up the vise in" is a
// glance rather than a guess.
//
// Two facts the table depends on:
//
//   Offsets are MACHINE coordinates, and work = machine − offset. Typing a
//   number here therefore does not depend on where the machine is standing,
//   which is exactly why it goes through G10 L2 and not G10 L20.
//
//   Names are ours alone. No controller stores "vise" anywhere, so they live in
//   browser settings and nothing here depends on them existing.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { fixed } from '../core/util.js';
import { empty } from '../ui/widgets.js';
import { loadWcsNames, saveWcsNames, wcsCode, type WcsNames } from '../wcs/names.js';

export class WcsPanel extends PanelElement {
  private names: WcsNames = loadWcsNames();
  private copyFrom = 1;
  private copyTo = 2;
  private rotAngle = 0;
  private rotCentreX = 0;
  private rotCentreY = 0;

  /**
   * Cells the operator is part-way through typing into.
   *
   * The panel re-renders on every poll, and without this a value arriving from
   * the machine would overwrite half-typed input. Keyed "<wcs>:<letter>".
   */
  private drafts = new Map<string, string>();

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private get systems(): number[] {
    const count = Math.min(capabilities.get().workCoordinateSystems || 1, 9);
    return Array.from({ length: count }, (_, i) => i + 1);
  }

  // --- Mutations ----------------------------------------------------------

  private setName(wcs: number, name: string): void {
    this.names = { ...this.names, [String(wcs)]: name };
    if (!name.trim()) delete this.names[String(wcs)];
    saveWcsNames(this.names);
    this.requestUpdate();
  }

  private async setFromPosition(wcs: number): Promise<void> {
    const state = machine.peek();
    if (!confirm(`Set the ${wcsCode(wcs)} origin to the current position?`)) return;
    // Sequential on purpose: the driver queues one command per call, and a
    // half-applied origin is worse than a slow one.
    for (const axis of state.axes) {
      if (axis.visible) await actions.setWorkZero(axis.letter, 0, wcs);
    }
  }

  private async clear(wcs: number): Promise<void> {
    const state = machine.peek();
    if (!confirm(`Zero every ${wcsCode(wcs)} offset? Its origin becomes the machine origin.`)) {
      return;
    }
    for (const axis of state.axes) {
      await actions.setWorkOffset(wcs, axis.letter, 0);
    }
  }

  private async copy(): Promise<void> {
    const { copyFrom: from, copyTo: to } = this;
    if (from === to) return;
    const state = machine.peek();
    if (!confirm(`Overwrite the ${wcsCode(to)} offsets with ${wcsCode(from)}?`)) return;
    for (const axis of state.axes) {
      const value = axis.workOffsets[from - 1];
      if (value === undefined) continue;
      await actions.setWorkOffset(to, axis.letter, value);
    }
  }

  private commitOffset(wcs: number, letter: string, raw: string): void {
    this.drafts.delete(`${wcs}:${letter}`);
    const value = Number(raw);
    if (!isFinite(value)) {
      this.requestUpdate();
      return;
    }
    void actions.setWorkOffset(wcs, letter, value);
  }

  // --- Render -------------------------------------------------------------

  private renderRow(wcs: number, live: boolean): TemplateResult {
    const state = machine.get();
    const active = state.wcs === wcs;

    return html`
      <tr class=${active ? 'wcs-row active' : 'wcs-row'}>
        <td class="wcs-code">
          <button
            class=${active ? 'seg active' : 'seg'}
            title="Select ${wcsCode(wcs)}"
            ?disabled=${!live}
            @click=${() => void actions.selectWcs(wcs)}
          >
            ${wcsCode(wcs)}
          </button>
        </td>
        <td class="wcs-name">
          <input
            type="text"
            placeholder="—"
            .value=${this.names[String(wcs)] ?? ''}
            @change=${(e: Event) => this.setName(wcs, (e.target as HTMLInputElement).value)}
          />
        </td>
        ${state.axes.map((axis) => {
          const key = `${wcs}:${axis.letter}`;
          const draft = this.drafts.get(key);
          const stored = axis.workOffsets[wcs - 1];
          return html`
            <td class="num">
              <input
                class="wcs-offset"
                type="number"
                step="any"
                ?disabled=${!live || stored === undefined}
                .value=${draft ?? (stored === undefined ? '' : fixed(stored))}
                @input=${(e: Event) =>
                  this.drafts.set(key, (e.target as HTMLInputElement).value)}
                @change=${(e: Event) =>
                  this.commitOffset(wcs, axis.letter, (e.target as HTMLInputElement).value)}
                @blur=${() => {
                  if (this.drafts.delete(key)) this.requestUpdate();
                }}
              />
            </td>
          `;
        })}
        <td class="wcs-actions">
          <button
            class="tiny"
            title="Set the ${wcsCode(wcs)} origin to where the machine is now"
            ?disabled=${!live}
            @click=${() => void this.setFromPosition(wcs)}
          >
            Set
          </button>
          <button
            class="tiny"
            title="Zero every ${wcsCode(wcs)} offset"
            ?disabled=${!live}
            @click=${() => void this.clear(wcs)}
          >
            Zero
          </button>
        </td>
      </tr>
    `;
  }

  private renderRotation(live: boolean): TemplateResult | typeof nothing {
    if (!capabilities.get().coordinateRotation) return nothing;
    const rotation = machine.get().rotation;

    return html`
      <div class="wcs-rotation">
        <div class="ov-head">
          <span>Rotation</span>
          <strong class=${rotation ? 'changed' : ''}>
            ${rotation ? `${rotation.angle.toFixed(4)}°` : 'none'}
          </strong>
        </div>
        ${rotation
          ? html`
              <div class="warn-banner">
                The coordinate system is rotated ${rotation.angle.toFixed(4)}° anticlockwise about
                machine X${fixed(rotation.centre[0], 2)} Y${fixed(rotation.centre[1], 2)}. Every
                XY move — including jogs and probes — runs along the rotated axes.
              </div>
            `
          : html`
              <p class="hint">
                Measure it with the <strong>Skew</strong> routine in the Probing panel rather than
                typing it: two touches on one edge give the angle to four decimals and the tip
                diameter cancels out.
              </p>
            `}
        <div class="wcs-rot-form">
          <label class="param">
            <span class="param-label">Angle</span>
            <span class="param-input">
              <input
                type="number"
                step="0.0001"
                .value=${String(this.rotAngle)}
                @change=${(e: Event) => (this.rotAngle = Number((e.target as HTMLInputElement).value))}
              />
              <em>° ccw</em>
            </span>
          </label>
          <label class="param">
            <span class="param-label">Pivot X</span>
            <span class="param-input">
              <input
                type="number"
                step="any"
                .value=${String(this.rotCentreX)}
                @change=${(e: Event) =>
                  (this.rotCentreX = Number((e.target as HTMLInputElement).value))}
              />
              <em>mm</em>
            </span>
          </label>
          <label class="param">
            <span class="param-label">Pivot Y</span>
            <span class="param-input">
              <input
                type="number"
                step="any"
                .value=${String(this.rotCentreY)}
                @change=${(e: Event) =>
                  (this.rotCentreY = Number((e.target as HTMLInputElement).value))}
              />
              <em>mm</em>
            </span>
          </label>
        </div>
        <div class="wcs-foot">
          <button
            ?disabled=${!live}
            @click=${() => void actions.setRotation(this.rotAngle, this.rotCentreX, this.rotCentreY)}
          >
            Apply
          </button>
          <button ?disabled=${!live || !rotation} @click=${() => void actions.clearRotation()}>
            Clear
          </button>
          <span class="hint">Pivot is in work coordinates. XY plane only.</span>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const live = connected.get();

    if (!state.axes.length) {
      return empty(live ? 'Waiting for axis data…' : 'Not connected');
    }

    return html`
      <div class="wcs">
        <div class="wcs-scroll">
          <table class="wcs-table">
            <thead>
              <tr>
                <th>System</th>
                <th>Name</th>
                ${state.axes.map((a) => html`<th class="num">${a.letter}</th>`)}
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${this.systems.map((wcs) => this.renderRow(wcs, live))}
            </tbody>
          </table>
        </div>

        <p class="hint">
          Offsets are machine coordinates: work = machine − offset. Typing one sets it directly
          (<code>G10 L2</code>); <em>Set</em> makes the current position the origin
          (<code>G10 L20</code>), <em>Zero</em> wipes every offset in the row.
        </p>

        <div class="wcs-foot">
          <span>Copy</span>
          <select
            @change=${(e: Event) =>
              ((this.copyFrom = Number((e.target as HTMLSelectElement).value)), this.requestUpdate())}
          >
            ${this.systems.map(
              (w) => html`<option value=${w} ?selected=${w === this.copyFrom}>${wcsCode(w)}</option>`,
            )}
          </select>
          <span>→</span>
          <select
            @change=${(e: Event) =>
              ((this.copyTo = Number((e.target as HTMLSelectElement).value)), this.requestUpdate())}
          >
            ${this.systems.map(
              (w) => html`<option value=${w} ?selected=${w === this.copyTo}>${wcsCode(w)}</option>`,
            )}
          </select>
          <button ?disabled=${!live || this.copyFrom === this.copyTo} @click=${() => void this.copy()}>
            Copy
          </button>
        </div>

        ${this.renderRotation(live)}
      </div>
    `;
  }
}

customElements.define('cnc-wcs', WcsPanel);

registerPanel({
  id: 'wcs',
  title: 'Coordinates',
  tag: 'cnc-wcs',
  defaultWidth: 6,
  defaultHeight: 480,
  available: (caps) => caps.workCoordinateSystems > 1,
  description: 'All work coordinate systems, their offsets, names and rotation',
});
