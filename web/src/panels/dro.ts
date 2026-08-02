// Digital readout.
//
// Shows work and machine coordinates side by side, which is the single thing
// DWC's printer-shaped UI makes hardest. Work coordinates are what you cut in;
// machine coordinates are what you need when something has gone wrong.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { fixed } from '../core/util.js';
import { empty } from '../ui/widgets.js';

const WCS_NAMES = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'];

export class DroPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private zeroAxis(letter: string): void {
    void actions.setWorkZero(letter, 0);
  }

  private zeroAll(): void {
    const state = machine.peek();
    for (const axis of state.axes) {
      if (axis.visible) void actions.setWorkZero(axis.letter, 0);
    }
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const caps = capabilities.get();
    const live = connected.get();

    if (!state.axes.length) {
      return empty(live ? 'Waiting for axis data…' : 'Not connected');
    }

    return html`
      <div class="dro">
        ${caps.workCoordinateSystems > 1
          ? html`
              <div class="dro-wcs">
                ${WCS_NAMES.slice(0, caps.workCoordinateSystems).map(
                  (name, i) => html`
                    <button
                      class=${state.wcs === i + 1 ? 'seg active' : 'seg'}
                      ?disabled=${!live}
                      @click=${() => void actions.selectWcs(i + 1)}
                    >
                      ${name}
                    </button>
                  `,
                )}
              </div>
            `
          : nothing}

        <table class="dro-table">
          <thead>
            <tr>
              <th class="axis-col">Axis</th>
              <th class="num">Work</th>
              <th class="num">Machine</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${state.axes.map(
              (axis) => html`
                <tr class=${axis.homed ? '' : 'unhomed'}>
                  <td class="axis-col">
                    <span class="axis-letter">${axis.letter}</span>
                    ${axis.homed
                      ? nothing
                      : html`<span class="unhomed-dot" title="Not homed">●</span>`}
                  </td>
                  <td class="num work">${fixed(axis.work)}</td>
                  <td class="num machine">${fixed(axis.machine)}</td>
                  <td class="dro-actions">
                    <button
                      class="tiny"
                      title="Zero ${axis.letter} in the active work coordinate system"
                      ?disabled=${!live}
                      @click=${() => this.zeroAxis(axis.letter)}
                    >
                      0
                    </button>
                    <button
                      class="tiny"
                      title="Home ${axis.letter}"
                      ?disabled=${!live}
                      @click=${() => void actions.home([axis.letter])}
                    >
                      ⌂
                    </button>
                  </td>
                </tr>
              `,
            )}
          </tbody>
        </table>

        <div class="dro-foot">
          <button ?disabled=${!live} @click=${() => this.zeroAll()}>Zero all</button>
          <button ?disabled=${!live} @click=${() => void actions.home()}>Home all</button>
          ${state.feedRate != null
            ? html`<span class="readout">F ${Math.round(state.feedRate)}</span>`
            : nothing}
          ${state.feedMultiplier !== 1
            ? html`<span class="readout warn">${Math.round(state.feedMultiplier * 100)}%</span>`
            : nothing}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-dro', DroPanel);

registerPanel({
  id: 'dro',
  title: 'Position',
  tag: 'cnc-dro',
  defaultWidth: 5,
  defaultHeight: 320,
  description: 'Work and machine coordinates, WCS selection, zeroing',
});
