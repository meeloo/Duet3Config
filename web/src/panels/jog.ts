// Motion control.
//
// Note on hold-to-jog: there is no continuous-jog command over HTTP polling, so
// holding a button fires repeated discrete relative moves. That is what DWC and
// the GamepadJogger plugin do too. The repeat rate is deliberately conservative
// — queueing moves faster than the machine consumes them makes the button feel
// laggy and, worse, keeps moving after release.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { BUSY_STATES } from '../machine/types.js';
import { empty, segmented } from '../ui/widgets.js';

const STEPS = [0.01, 0.1, 1, 10, 50];
const FEEDS = [100, 500, 1000, 3000, 6000];
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 180;

export class JogPanel extends PanelElement {
  private step = 1;
  private feed = 1000;
  private repeatTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatInterval: ReturnType<typeof setInterval> | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
    this.onDispose(() => this.stopRepeat());
  }

  private get canMove(): boolean {
    return connected.get() && !BUSY_STATES.has(machine.get().status);
  }

  private jog(axis: string, sign: number): void {
    void actions.jog(axis, sign * this.step, this.feed);
  }

  private startRepeat(axis: string, sign: number): void {
    this.stopRepeat();
    this.jog(axis, sign);
    this.repeatTimer = setTimeout(() => {
      this.repeatInterval = setInterval(() => this.jog(axis, sign), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  private stopRepeat(): void {
    if (this.repeatTimer) clearTimeout(this.repeatTimer);
    if (this.repeatInterval) clearInterval(this.repeatInterval);
    this.repeatTimer = null;
    this.repeatInterval = null;
  }

  private jogButton(axis: string, sign: number, label: string, cls = ''): TemplateResult {
    return html`
      <button
        class="jog-btn ${cls}"
        ?disabled=${!this.canMove}
        @pointerdown=${(e: PointerEvent) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          this.startRepeat(axis, sign);
        }}
        @pointerup=${() => this.stopRepeat()}
        @pointercancel=${() => this.stopRepeat()}
        @pointerleave=${() => this.stopRepeat()}
      >
        ${label}
      </button>
    `;
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    if (!state.axes.length) return empty(connected.get() ? 'Waiting for axes…' : 'Not connected');

    const letters = new Set(state.axes.map((a) => a.letter));
    // Axes beyond XYZ (this machine's U carries the dust shoe) get their own row
    // rather than being forced into the XY pad.
    const auxAxes = state.axes.filter((a) => !['X', 'Y', 'Z'].includes(a.letter));

    return html`
      <div class="jog">
        <div class="jog-settings">
          <div class="jog-setting">
            <span class="label">Step (mm)</span>
            ${segmented(STEPS, this.step, (v) => ((this.step = v), this.requestUpdate()))}
          </div>
          <div class="jog-setting">
            <span class="label">Feed (mm/min)</span>
            ${segmented(FEEDS, this.feed, (v) => ((this.feed = v), this.requestUpdate()))}
          </div>
        </div>

        <div class="jog-pads">
          ${letters.has('X') && letters.has('Y')
            ? html`
                <div class="jog-xy">
                  <div></div>
                  ${this.jogButton('Y', 1, '↑')}
                  <div></div>
                  ${this.jogButton('X', -1, '←')}
                  <button
                    class="jog-btn home"
                    title="Home X and Y"
                    ?disabled=${!this.canMove}
                    @click=${() => void actions.home(['X', 'Y'])}
                  >
                    ⌂
                  </button>
                  ${this.jogButton('X', 1, '→')}
                  <div></div>
                  ${this.jogButton('Y', -1, '↓')}
                  <div></div>
                </div>
              `
            : nothing}

          ${letters.has('Z')
            ? html`
                <div class="jog-z">
                  ${this.jogButton('Z', 1, 'Z↑')}
                  <button
                    class="jog-btn home"
                    title="Home Z"
                    ?disabled=${!this.canMove}
                    @click=${() => void actions.home(['Z'])}
                  >
                    ⌂
                  </button>
                  ${this.jogButton('Z', -1, 'Z↓')}
                </div>
              `
            : nothing}
        </div>

        ${auxAxes.length
          ? html`
              <div class="jog-aux">
                ${auxAxes.map(
                  (a) => html`
                    <div class="jog-aux-row">
                      <span class="axis-letter">${a.letter}</span>
                      ${this.jogButton(a.letter, -1, '−')}
                      ${this.jogButton(a.letter, 1, '+')}
                      <button
                        class="tiny"
                        ?disabled=${!this.canMove}
                        @click=${() => void actions.home([a.letter])}
                      >
                        ⌂
                      </button>
                    </div>
                  `,
                )}
              </div>
            `
          : nothing}

        ${!this.canMove && connected.get()
          ? html`<div class="jog-blocked">Machine busy — jogging disabled</div>`
          : nothing}
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
  defaultHeight: 320,
  description: 'Jog pad, step/feed selection, homing',
});
