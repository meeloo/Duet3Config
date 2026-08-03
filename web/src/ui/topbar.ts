// Persistent top bar: connection, machine identity, status, and E-stop.
//
// The E-stop lives here rather than in a panel because it must never be
// scrolled off, closed, or rearranged away.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement } from './panel.js';
import {
  actions,
  appendLog,
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
import {
  addPage,
  pageTabs,
  panelPickerOpen,
  removePage,
  renamePage,
  renamingPage,
  selectPage,
} from './layout.js';
import { statusClass, statusLabel } from './widgets.js';
import { theme, toggleTheme } from '../core/theme.js';
import {
  applySettings,
  describeKey,
  differingKeys,
  followMachine,
  noteAdopted,
  readRemoteSettings,
  setFollowMachine,
  settingsPath,
  syncOnConnect,
  writeRemoteSettings,
  type RemoteState,
} from '../core/settings.js';

export class TopBar extends PanelElement {
  private password = '';
  private showSettings = false;
  /** What the machine's copy looks like, once we have asked. */
  private remote: RemoteState | null = null;
  private syncBusy = false;
  private syncNote: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      connecting.get();
      connectionError.get();
      controllerUrl.get();
      driverId.get();
      theme.get();
      pageTabs.get();
      renamingPage.get();
      panelPickerOpen.get();
    });
  }

  private async toggleConnection(): Promise<void> {
    if (connected.get()) {
      await disconnect();
      return;
    }
    try {
      await connect(controllerUrl.peek(), driverId.peek(), this.password);
      // Same opt-in path as auto-connect on load: if this browser follows the
      // machine, a manual connect adopts its settings too.
      await this.adoptMachineSettings();
    } catch {
      // connect() already routed the message to the console and error signal.
    }
  }

  // --- Shared settings ----------------------------------------------------

  private async adoptMachineSettings(): Promise<void> {
    const changed = await syncOnConnect();
    if (!changed.length) return;
    appendLog({
      level: 'info',
      text: `Adopted the machine's settings (${changed.join(', ')}) — reloading`,
      time: new Date(),
    });
    setTimeout(() => location.reload(), 250);
  }

  private async refreshRemote(): Promise<void> {
    this.syncBusy = true;
    this.requestUpdate();
    this.remote = await readRemoteSettings();
    this.syncBusy = false;
    this.requestUpdate();
  }

  private async pushSettings(): Promise<void> {
    this.syncBusy = true;
    this.syncNote = null;
    this.requestUpdate();
    try {
      const bundle = await writeRemoteSettings();
      this.remote = { kind: 'ok', bundle };
      this.syncNote = `Saved to ${settingsPath()}`;
    } catch (err) {
      this.syncNote = `Could not save: ${(err as Error).message}`;
    } finally {
      this.syncBusy = false;
      this.requestUpdate();
    }
  }

  /**
   * Pull, then reload.
   *
   * The dock layout is read once when the dashboard is constructed, and the
   * panels each read their own settings on connect — so writing new values into
   * storage changes nothing that is already on screen. Rebuilding the dashboard
   * in place would work but destroys and recreates every panel, which costs the
   * viewer its WebGL context and its parsed toolpath. A reload is the honest
   * version of the same thing, and it only happens on an explicit press.
   */
  private async pullSettings(): Promise<void> {
    const remote = this.remote;
    if (remote?.kind !== 'ok') return;
    const changed = differingKeys(remote.bundle);
    if (!changed.length) {
      this.syncNote = 'Already identical — nothing to change.';
      this.requestUpdate();
      return;
    }
    const list = changed.map((k) => `  • ${describeKey(k)}`).join('\n');
    if (!confirm(`Use the machine's settings? This replaces:\n\n${list}\n\nThe page will reload.`)) {
      return;
    }
    applySettings(remote.bundle);
    noteAdopted(remote.bundle);
    location.reload();
  }

  private renderSettingsSync(): TemplateResult {
    const path = settingsPath();
    const live = connected.get();
    const remote = this.remote;
    const differing = remote?.kind === 'ok' ? differingKeys(remote.bundle) : [];

    return html`
      <div class="sync-settings">
        <div class="sync-head">
          <span>Shared settings</span>
          ${path ? html`<code>${path}</code>` : nothing}
        </div>
        <p class="hint">
          Layout, panel preferences and the tool table live in this browser. Keeping a copy on
          the controller is what makes them the same on the tablet, the laptop and the machine.
        </p>
        <div class="sync-actions">
          <button ?disabled=${!live || !path || this.syncBusy} @click=${() => void this.pushSettings()}>
            Save to machine
          </button>
          <button
            ?disabled=${!live || !path || this.syncBusy || remote?.kind !== 'ok'}
            @click=${() => void this.pullSettings()}
          >
            Use machine's
          </button>
          <button
            class="tiny"
            ?disabled=${!live || !path || this.syncBusy}
            @click=${() => void this.refreshRemote()}
          >
            ${this.syncBusy ? 'Checking…' : 'Check'}
          </button>
        </div>
        <label class="sync-follow">
          <input
            type="checkbox"
            .checked=${followMachine()}
            @change=${(e: Event) => {
              setFollowMachine((e.target as HTMLInputElement).checked);
              this.requestUpdate();
            }}
          />
          <span>Adopt the machine's settings when this browser connects</span>
        </label>
        ${remote === null
          ? nothing
          : remote.kind === 'absent'
            ? html`<div class="hint">Nothing saved on the machine yet.</div>`
            : remote.kind === 'error'
              ? html`<div class="hint warn">${remote.message}</div>`
              : html`<div class="hint">
                  Machine copy written ${new Date(remote.bundle.written).toLocaleString()} —
                  ${differing.length
                    ? html`differs in <strong>${differing.map(describeKey).join(', ')}</strong>`
                    : 'identical to this browser'}
                </div>`}
        ${this.syncNote ? html`<div class="hint">${this.syncNote}</div>` : nothing}
      </div>
    `;
  }

  // --- Page tabs ----------------------------------------------------------

  /**
   * The dashboard's pages, rendered here.
   *
   * They used to have a strip of their own directly beneath this one, which
   * meant two full-width bands of chrome above the actual machine controls. The
   * pages are still the dashboard's state — it publishes them and this calls
   * back in — so nothing about how a page works moved, only where its tab is
   * drawn.
   */
  private renderPages(): TemplateResult {
    const { pages, active } = pageTabs.get();
    const renaming = renamingPage.get();

    return html`
      <nav class="pages">
        ${pages.map((page, i) => {
          const isActive = i === active;
          if (renaming === page.id) {
            return html`<input
              class="page-rename"
              .value=${page.name}
              autofocus
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') renamePage(i, (e.target as HTMLInputElement).value);
                if (e.key === 'Escape') renamingPage.set(null);
              }}
              @blur=${(e: Event) => renamePage(i, (e.target as HTMLInputElement).value)}
            />`;
          }
          return html`
            <button
              class="page-tab ${isActive ? 'active' : ''}"
              title=${`${page.name} — press ${i + 1}`}
              @click=${() => (isActive ? renamingPage.set(page.id) : selectPage(i))}
            >
              <span class="page-key">${i + 1}</span>${page.name}
              ${isActive && pages.length > 1
                ? html`<span
                    class="page-close"
                    title="Delete page"
                    @click=${(e: Event) => (e.stopPropagation(), removePage(i))}
                    >✕</span
                  >`
                : nothing}
            </button>
          `;
        })}
        <button class="page-add" title="Add a page" @click=${() => addPage()}>+</button>
        <button
          class="tiny"
          title="Add a panel to this page"
          @click=${() => panelPickerOpen.set(!panelPickerOpen.peek())}
        >
          ${panelPickerOpen.get() ? 'Close' : '+ Panel'}
        </button>
      </nav>
    `;
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const live = connected.get();
    const busy = connecting.get();
    const err = connectionError.get();
    const info = driverInfo(driverId.get());

    return html`
      <div class="topbar">
        <button
          class=${this.showSettings ? 'gear active' : 'gear'}
          title="Preferences — connection, appearance, shared settings"
          @click=${() => ((this.showSettings = !this.showSettings), this.requestUpdate())}
        >
          ⚙
        </button>

        ${this.renderPages()}

        <span class="topbar-spacer"></span>

        <div class="status-area">
          <span class="pill ${statusClass(state.status)}">${statusLabel(state.status)}</span>
          ${state.tool
            ? html`<span class="pill active" title="Active tool">
                T${state.tool.number}${state.tool.name ? ` · ${state.tool.name}` : ''}
              </span>`
            : nothing}
          <span class="identity">${state.identity ?? (info?.label ?? '')}</span>
          ${!live
            ? html`<button
                class="tiny"
                ?disabled=${busy}
                @click=${() => void this.toggleConnection()}
              >
                ${busy ? 'Connecting…' : 'Connect'}
              </button>`
            : nothing}
        </div>

        <button class="estop" title="Emergency stop (M112) — or press Escape twice"
          @click=${() => void actions.estop()}>
          STOP
        </button>
      </div>

      ${this.showSettings ? this.renderPreferences() : nothing}
      ${err ? html`<div class="conn-error">${err}</div>` : nothing}
    `;
  }

  /** Everything that is set once and then left alone. */
  private renderPreferences(): TemplateResult {
    const live = connected.get();
    const busy = connecting.get();

    return html`
      <div class="conn-settings">
        <div class="pref-row">
          <label>
            Controller
            <select
              @change=${(e: Event) => driverId.set((e.target as HTMLSelectElement).value)}
            >
              ${DRIVERS.map(
                (d) => html`<option value=${d.id} ?selected=${d.id === driverId.get()}>
                  ${d.label}
                </option>`,
              )}
            </select>
          </label>
          <label>
            Address
            <input
              class="url"
              .value=${controllerUrl.get()}
              spellcheck="false"
              @change=${(e: Event) => controllerUrl.set((e.target as HTMLInputElement).value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              .value=${this.password}
              placeholder="(blank for default)"
              @change=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)}
            />
          </label>
          <button ?disabled=${busy} @click=${() => void this.toggleConnection()}>
            ${busy ? 'Connecting…' : live ? 'Disconnect' : 'Connect'}
          </button>
          <button class="tiny" title="Switch between light and dark" @click=${() => toggleTheme()}>
            ${theme.get() === 'dark' ? '☀ Light' : '☾ Dark'}
          </button>
        </div>
        <p class="hint">
          Serving this page from somewhere other than the controller needs CORS enabled on it.
          On RepRapFirmware that is <code>M586 C"*"</code> in <code>config-network.g</code>.
        </p>
        ${this.renderSettingsSync()}
      </div>
    `;
  }
}

customElements.define('cnc-topbar', TopBar);
