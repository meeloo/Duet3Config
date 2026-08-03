// Blocking-prompt dialog (RepRapFirmware M291, and equivalents on other drivers).
//
// This is not optional polish. Macros that prompt will sit and wait forever if
// nothing answers them, and the machine will simply look hung — which on this
// config means the ATC and probing macros. Any front end that skips this is
// unusable for real work.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import { actions, machine } from '../core/store.js';
import type { MachinePrompt } from '../machine/types.js';

export class MessageBox extends PanelElement {
  private value = '';
  /** Prompt seq we last prefilled for, so typing isn't clobbered by polling. */
  private valueForSeq = -1;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => machine.get().prompt);
  }

  private answer(prompt: MachinePrompt, accept: boolean): void {
    const needsValue =
      prompt.mode === 'input-int' ||
      prompt.mode === 'input-float' ||
      prompt.mode === 'input-string';

    if (!accept || !needsValue) {
      void actions.answerPrompt(prompt.seq, accept);
      return;
    }

    const raw = this.value;
    const value =
      prompt.mode === 'input-string'
        ? raw
        : prompt.mode === 'input-int'
          ? parseInt(raw, 10)
          : parseFloat(raw);

    if (typeof value === 'number' && !isFinite(value)) return; // reject empty/garbage
    void actions.answerPrompt(prompt.seq, true, value);
  }

  protected override render(): TemplateResult | typeof nothing {
    const prompt = machine.get().prompt;
    if (!prompt) return nothing;

    if (this.valueForSeq !== prompt.seq) {
      this.valueForSeq = prompt.seq;
      this.value = prompt.defaultValue != null ? String(prompt.defaultValue) : '';
    }

    const needsValue =
      prompt.mode === 'input-int' ||
      prompt.mode === 'input-float' ||
      prompt.mode === 'input-string';
    const cancellable = prompt.mode === 'ok-cancel' || prompt.mode === 'close';

    return html`
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${prompt.title || 'Message'}</h2>
          <p class="modal-message">${prompt.message}</p>

          ${prompt.axisControls.length
            ? html`
                <div class="modal-jog">
                  ${prompt.axisControls.map(
                    (axis) => html`
                      <div class="modal-jog-axis">
                        <span>${axis}</span>
                        ${[-1, -0.1, 0.1, 1].map(
                          (d) => html`
                            <button @click=${() => void actions.jog({ [axis]: d }, 600)}>
                              ${d > 0 ? `+${d}` : d}
                            </button>
                          `,
                        )}
                      </div>
                    `,
                  )}
                </div>
              `
            : nothing}

          ${needsValue
            ? html`
                <input
                  class="modal-input"
                  type=${prompt.mode === 'input-string' ? 'text' : 'number'}
                  step=${prompt.mode === 'input-float' ? 'any' : '1'}
                  .value=${this.value}
                  autofocus
                  @input=${(e: Event) => (this.value = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === 'Enter') this.answer(prompt, true);
                  }}
                />
              `
            : nothing}

          <div class="modal-buttons">
            ${cancellable
              ? html`<button class="ghost" @click=${() => this.answer(prompt, false)}>
                  Cancel
                </button>`
              : nothing}
            ${prompt.mode === 'none'
              ? html`<span class="hint">Waiting for the machine…</span>`
              : html`<button class="primary" @click=${() => this.answer(prompt, true)}>OK</button>`}
          </div>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-messagebox', MessageBox);
