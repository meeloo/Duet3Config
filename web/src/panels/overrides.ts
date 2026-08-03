// Live overrides: feed rate, and a dry-run Z lift.
//
// Two things a CNC control is expected to have that this deliberately does NOT,
// because RepRapFirmware has no equivalent and faking them would be worse than
// their absence:
//
//   Single block. There is no step-one-line mode — the file is executed by the
//   controller, and nothing in the G-code dictionary suspends it between
//   blocks. Pause (M25) stops at the end of the current move, which is close
//   but is not the same thing and shouldn't be labelled as if it were.
//
//   Spindle override. Feed has M220, a genuine multiplier the firmware applies
//   to every move. Spindle speed has no counterpart; the only way to change it
//   is to re-issue M3 S<rpm>, which the file's next M3 silently overwrites. A
//   slider that quietly stops working partway through a job is a trap.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, machine } from '../core/store.js';
import { loadedProgram } from '../ui/program.js';

const FEED_PRESETS = [25, 50, 75, 100, 125, 150];

export class OverridesPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      loadedProgram.get();
    });
  }

  private get zBabystep(): number {
    return machine.get().axes.find((a) => a.letter === 'Z')?.babystep ?? 0;
  }

  /**
   * A lift that clears the deepest cut in the loaded program.
   *
   * The whole point of a dry run is that nothing touches the material, so the
   * lift has to exceed the lowest Z the program reaches — which we already know
   * from parsing it. A lift smaller than that still cuts, just less.
   */
  private get suggestedLift(): number | null {
    const program = loadedProgram.get();
    if (!program) return null;
    const deepest = program.path.min[2];
    if (deepest >= 0) return null;
    return Math.ceil(-deepest) + 2;
  }

  private setFeed(percent: number): void {
    void actions.send(`M220 S${Math.round(percent)}`);
  }

  private applyLift(mm: number): void {
    const program = loadedProgram.peek();
    const deepest = program ? program.path.min[2] : 0;
    if (mm > 0 && deepest < 0 && mm <= -deepest) {
      if (
        !confirm(
          `A ${mm}mm lift does not clear this program's deepest cut (${deepest.toFixed(2)}mm).\n\n` +
            `The tool will still cut, just ${(-deepest - mm).toFixed(2)}mm shallower. Continue?`,
        )
      ) {
        return;
      }
    }
    // R0 = absolute, so repeated presses set the lift rather than accumulating.
    void actions.send(`M290 R0 Z${mm}`);
    this.requestUpdate();
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const live = connected.get();
    const feedPct = Math.round(state.feedMultiplier * 100);
    const lift = this.zBabystep;
    const suggested = this.suggestedLift;

    return html`
      <div class="overrides">
        <div class="ov-block">
          <div class="ov-head">
            <span>Feed rate</span>
            <strong class=${feedPct !== 100 ? 'changed' : ''}>${feedPct}%</strong>
          </div>
          <input
            class="ov-slider"
            type="range"
            min="10"
            max="200"
            step="5"
            .value=${String(feedPct)}
            ?disabled=${!live}
            @input=${(e: Event) => this.setFeed(Number((e.target as HTMLInputElement).value))}
          />
          <div class="segmented">
            ${FEED_PRESETS.map(
              (v) => html`
                <button
                  class=${v === feedPct ? 'seg active' : 'seg'}
                  ?disabled=${!live}
                  @click=${() => this.setFeed(v)}
                >
                  ${v}%
                </button>
              `,
            )}
          </div>
          ${state.feedRate != null && state.feedRate > 0
            ? html`<div class="hint">
                Programmed ${Math.round(state.feedRate)} mm/min →
                ${Math.round(state.feedRate * state.feedMultiplier)} actual
              </div>`
            : nothing}
        </div>

        <div class="ov-block">
          <div class="ov-head">
            <span>Dry run lift</span>
            <strong class=${lift > 0 ? 'changed' : ''}>${lift.toFixed(2)} mm</strong>
          </div>
          <p class="hint">
            Raises Z live so the program runs above the material. The spindle still starts and
            the feeds are unchanged — this proves the path, not the cut.
          </p>
          <div class="segmented">
            ${[0, 5, 10, 20].map(
              (v) => html`
                <button
                  class=${Math.abs(lift - v) < 0.01 ? 'seg active' : 'seg'}
                  ?disabled=${!live}
                  @click=${() => this.applyLift(v)}
                >
                  ${v === 0 ? 'Off' : `${v}mm`}
                </button>
              `,
            )}
            ${suggested !== null && ![0, 5, 10, 20].includes(suggested)
              ? html`
                  <button
                    class=${Math.abs(lift - suggested) < 0.01 ? 'seg active' : 'seg'}
                    title="Clears the deepest cut in the loaded program"
                    ?disabled=${!live}
                    @click=${() => this.applyLift(suggested)}
                  >
                    ${suggested}mm ✓
                  </button>
                `
              : nothing}
          </div>
          ${suggested !== null
            ? html`<div class="hint">
                Loaded program cuts to ${loadedProgram.get()!.path.min[2].toFixed(2)}mm — clear it
                with ${suggested}mm.
              </div>`
            : nothing}
          ${lift > 0
            ? html`<div class="warn-banner">
                Z is lifted ${lift.toFixed(2)}mm. Set it back to Off before cutting for real.
              </div>`
            : nothing}
        </div>

        <div class="ov-block">
          <div class="ov-head"><span>Not available</span></div>
          <p class="hint">
            <strong>Single block</strong> and <strong>spindle override</strong> have no
            RepRapFirmware equivalent. Pause (M25) stops at the end of the current move, which is
            the closest thing the controller offers.
          </p>
          <div class="segmented">
            <button ?disabled=${!live} class="seg" @click=${() => void actions.pauseJob()}>
              Pause
            </button>
            <button ?disabled=${!live} class="seg" @click=${() => void actions.resumeJob()}>
              Resume
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-overrides', OverridesPanel);

registerPanel({
  id: 'overrides',
  title: 'Overrides',
  tag: 'cnc-overrides',
  defaultWidth: 4,
  defaultHeight: 480,
  description: 'Live feed rate and a dry-run Z lift',
});
