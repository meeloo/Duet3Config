// MDI console: send commands, read replies.

import { html, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, loadSetting, log, saveSetting } from '../core/store.js';

const HISTORY_LIMIT = 100;

export class ConsolePanel extends PanelElement {
  private history: string[] = loadSetting('mdiHistory', [] as string[]);
  private historyIndex = -1;
  private draft = '';
  private pinned = true;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      log.get();
      connected.get();
    });
  }

  protected override updated(): void {
    // Keep the newest line visible unless the operator has scrolled up to read
    // something — yanking the view away mid-read is worse than a stale scroll.
    if (!this.pinned) return;
    const out = this.querySelector('.console-out');
    if (out) out.scrollTop = out.scrollHeight;
  }

  private onScroll(e: Event): void {
    const el = e.target as HTMLElement;
    this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  private submit(): void {
    const cmd = this.draft.trim();
    if (!cmd) return;

    this.history = [cmd, ...this.history.filter((h) => h !== cmd)].slice(0, HISTORY_LIMIT);
    saveSetting('mdiHistory', this.history);
    this.historyIndex = -1;
    this.draft = '';
    this.pinned = true;

    void actions.send(cmd);
    this.requestUpdate();
  }

  private onKeyDown(e: KeyboardEvent): void {
    const input = e.target as HTMLInputElement;

    if (e.key === 'Enter') {
      e.preventDefault();
      this.submit();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.historyIndex + 1 < this.history.length) {
        this.historyIndex++;
        this.draft = this.history[this.historyIndex];
        input.value = this.draft;
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.draft = this.history[this.historyIndex];
      } else {
        this.historyIndex = -1;
        this.draft = '';
      }
      input.value = this.draft;
    }
  }

  protected override render(): TemplateResult {
    const lines = log.get();
    const live = connected.get();

    return html`
      <div class="console">
        <div class="console-out" @scroll=${(e: Event) => this.onScroll(e)}>
          ${repeat(
            lines,
            (_l, i) => i,
            (l) => html`
              <div class="line ${l.level}">
                <span class="time">${l.time.toLocaleTimeString()}</span>
                <span class="text">${l.text}</span>
              </div>
            `,
          )}
        </div>
        <div class="console-in">
          <input
            type="text"
            placeholder=${live ? 'G-code…' : 'Not connected'}
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            ?disabled=${!live}
            .value=${this.draft}
            @input=${(e: Event) => (this.draft = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => this.onKeyDown(e)}
          />
          <button class="primary" ?disabled=${!live} @click=${() => this.submit()}>Send</button>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-console', ConsolePanel);

registerPanel({
  id: 'console',
  title: 'Console',
  tag: 'cnc-console',
  defaultWidth: 4,
  defaultHeight: 460,
  description: 'Send G-code, read controller replies',
});
