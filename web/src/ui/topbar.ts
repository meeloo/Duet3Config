// Persistent top bar: connection, machine identity, status, and E-stop.
//
// The E-stop lives here rather than in a panel because it must never be
// scrolled off, closed, or rearranged away.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import {
  actions,
  connect,
  connected,
  connecting,
  connectionError,
  controllerUrl,
  disconnect,
  driverId,
  machine,
} from '../core/store.js';
import { DRIVERS, driverInfo } from '../machine/registry.js';
import { statusClass, statusLabel } from './widgets.js';

export class TopBar extends PanelElement {
  private password = '';
  private showSettings = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      connecting.get();
      connectionError.get();
      controllerUrl.get();
      driverId.get();
    });
  }

  private async toggleConnection(): Promise<void> {
    if (connected.get()) {
      await disconnect();
      return;
    }
    try {
      await connect(controllerUrl.peek(), driverId.peek(), this.password);
    } catch {
      // connect() already routed the message to the console and error signal.
    }
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const isConnected = connected.get();
    const busy = connecting.get();
    const info = driverInfo(driverId.get());
    const err = connectionError.get();

    return html`
      <div class="topbar">
        <div class="brand">CNC</div>

        <div class="conn">
          <select
            .value=${driverId.get()}
            ?disabled=${isConnected}
            @change=${(e: Event) => driverId.set((e.target as HTMLSelectElement).value)}
            title="Controller type"
          >
            ${DRIVERS.map(
              (d) => html`
                <option value=${d.id} ?selected=${d.id === driverId.get()}>
                  ${d.label}${d.ready ? '' : ' — not implemented'}
                </option>
              `,
            )}
          </select>

          <input
            type="text"
            class="url"
            .value=${controllerUrl.get()}
            placeholder=${info?.urlHint ?? 'http://…'}
            ?disabled=${isConnected}
            @change=${(e: Event) => controllerUrl.set((e.target as HTMLInputElement).value)}
          />

          <button
            class=${isConnected ? 'ghost' : 'primary'}
            ?disabled=${busy || (!isConnected && info?.ready === false)}
            @click=${() => void this.toggleConnection()}
          >
            ${busy ? 'Connecting…' : isConnected ? 'Disconnect' : 'Connect'}
          </button>

          <button
            class="icon"
            title="Connection settings"
            @click=${() => ((this.showSettings = !this.showSettings), this.requestUpdate())}
          >
            ⚙
          </button>
        </div>

        <div class="identity">${state.identity ?? (info?.label ?? '')}</div>

        <div class="status-area">
          <span class="pill ${statusClass(state.status)}">${statusLabel(state.status)}</span>
          ${state.tool
            ? html`<span class="pill dim">T${state.tool.number}${
                state.tool.name ? ` · ${state.tool.name}` : ''
              }</span>`
            : nothing}
        </div>

        <button
          class="estop"
          title="Emergency stop (M112)"
          ?disabled=${!isConnected}
          @click=${() => void actions.estop()}
        >
          STOP
        </button>
      </div>

      ${this.showSettings
        ? html`
            <div class="conn-settings">
              <label>
                Password
                <input
                  type="password"
                  .value=${this.password}
                  placeholder="(blank for default)"
                  @change=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
                />
              </label>
              <p class="hint">
                Serving this page from somewhere other than the controller needs CORS enabled
                on it. On RepRapFirmware that is <code>M586 C"*"</code> in
                <code>config-network.g</code>.
              </p>
            </div>
          `
        : nothing}
      ${err ? html`<div class="conn-error">${err}</div>` : nothing}
    `;
  }
}

customElements.define('cnc-topbar', TopBar);
