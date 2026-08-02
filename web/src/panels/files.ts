// File browser and text editor.
//
// Covers the "browse and edit the configuration from the web page" requirement:
// navigate the controller's filesystem, open a text file, edit it, save it back.
// Saving goes through the driver's writeFile, which for RRF means a CRC32-checked
// rr_upload — the firmware rejects a corrupt transfer rather than half-writing
// a config file.

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, activeDriver, appendLog, capabilities, connected, run } from '../core/store.js';
import { basename, formatBytes, parentPath } from '../core/util.js';
import type { FileEntry } from '../machine/types.js';

const TEXT_EXTENSIONS = /\.(g|gcode|nc|txt|json|csv|md|cfg|conf|ini|log)$/i;
/** Refuse to open anything big enough to lock up the editor. */
const MAX_EDIT_BYTES = 512 * 1024;

export class FilesPanel extends PanelElement {
  private cwd = '/sys';
  private entries: FileEntry[] = [];
  private loading = false;
  private error: string | null = null;

  private openPath: string | null = null;
  private content = '';
  private original = '';
  private saving = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      capabilities.get();
    });
    // Reload when a connection appears.
    let wasConnected = false;
    this.bind(() => {
      const now = connected.get();
      if (now && !wasConnected) {
        const caps = capabilities.peek();
        this.cwd = caps.configRoot ?? caps.gcodeRoot;
        void this.load();
      }
      wasConnected = now;
    });
  }

  private get dirty(): boolean {
    return this.openPath !== null && this.content !== this.original;
  }

  private async load(dir = this.cwd): Promise<void> {
    const driver = activeDriver();
    if (!driver) return;
    this.loading = true;
    this.error = null;
    this.requestUpdate();
    try {
      this.entries = await driver.listFiles(dir);
      this.cwd = dir;
    } catch (err) {
      this.error = (err as Error).message;
      this.entries = [];
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  private async open(entry: FileEntry): Promise<void> {
    if (entry.directory) {
      if (this.dirty && !confirm('Discard unsaved changes?')) return;
      this.openPath = null;
      await this.load(entry.path);
      return;
    }

    if (!TEXT_EXTENSIONS.test(entry.name)) {
      appendLog({
        level: 'warning',
        text: `${entry.name}: not a recognised text file — not opening`,
        time: new Date(),
      });
      return;
    }
    if (entry.size > MAX_EDIT_BYTES) {
      appendLog({
        level: 'warning',
        text: `${entry.name} is ${formatBytes(entry.size)} — too large to edit here`,
        time: new Date(),
      });
      return;
    }
    if (this.dirty && !confirm('Discard unsaved changes?')) return;

    const driver = activeDriver();
    if (!driver) return;
    const bytes = await run(`read ${entry.name}`, (d) => d.readFile(entry.path));
    if (!bytes) return;

    this.content = new TextDecoder().decode(bytes);
    this.original = this.content;
    this.openPath = entry.path;
    this.requestUpdate();
  }

  private async save(): Promise<void> {
    if (!this.openPath || !this.dirty) return;
    this.saving = true;
    this.requestUpdate();

    const path = this.openPath;
    const data = new TextEncoder().encode(this.content);
    const ok = await run(`save ${basename(path)}`, async (d) => {
      await d.writeFile(path, data);
      return true;
    });

    if (ok) {
      this.original = this.content;
      appendLog({ level: 'info', text: `Saved ${path}`, time: new Date() });
      void this.load();
    }
    this.saving = false;
    this.requestUpdate();
  }

  /**
   * Whether a file may be executed from here, and how.
   *
   * Only macros and G-code jobs get a run button. Notably NOT /sys: those are
   * config fragments that the firmware sources at boot, and handing `config.g`
   * to M32 would try to run it as a job. They are editable here, never runnable.
   */
  private runModeFor(entry: FileEntry): 'macro' | 'job' | null {
    if (entry.directory || !/\.(g|gcode|nc|tap)$/i.test(entry.name)) return null;
    const caps = capabilities.peek();
    const under = (root: string | null) => !!root && (this.cwd === root || this.cwd.startsWith(`${root}/`));
    if (under(caps.macroRoot)) return 'macro';
    if (under(caps.gcodeRoot)) return 'job';
    return null;
  }

  private runEntry(entry: FileEntry): void {
    const mode = this.runModeFor(entry);
    if (mode === 'macro') {
      if (confirm(`Run macro:\n${entry.path}`)) void actions.runMacro(entry.path);
    } else if (mode === 'job') {
      if (confirm(`Start job:\n${entry.path}`)) void actions.startJob(entry.path);
    }
  }

  private closeEditor(): void {
    if (this.dirty && !confirm('Discard unsaved changes?')) return;
    this.openPath = null;
    this.requestUpdate();
  }

  private renderBrowser(): TemplateResult {
    const caps = capabilities.get();
    const roots = [caps.configRoot, caps.macroRoot, caps.gcodeRoot].filter(
      (r): r is string => !!r,
    );

    return html`
      <div class="files-browser">
        <div class="files-bar">
          ${roots.map(
            (r) => html`
              <button
                class=${this.cwd === r ? 'seg active' : 'seg'}
                @click=${() => void this.load(r)}
              >
                ${r}
              </button>
            `,
          )}
          <button
            class="tiny"
            title="Up one level"
            ?disabled=${this.cwd === '/'}
            @click=${() => void this.load(parentPath(this.cwd))}
          >
            ↑
          </button>
          <button class="tiny" title="Refresh" @click=${() => void this.load()}>⟳</button>
          <span class="files-path">${this.cwd}</span>
        </div>

        ${this.error ? html`<div class="files-error">${this.error}</div>` : nothing}
        ${this.loading ? html`<div class="empty">Loading…</div>` : nothing}

        <div class="files-list">
          ${repeat(
            this.entries,
            (e) => e.path,
            (e) => html`
              <div
                class="file-row ${e.directory ? 'dir' : ''} ${this.openPath === e.path ? 'open' : ''}"
                @click=${() => void this.open(e)}
              >
                <span class="file-icon">${e.directory ? '▸' : '·'}</span>
                <span class="file-name">${e.name}</span>
                <span class="file-size">${e.directory ? '' : formatBytes(e.size)}</span>
                ${this.runModeFor(e)
                  ? html`
                      <button
                        class="tiny run"
                        title=${this.runModeFor(e) === 'macro' ? 'Run macro' : 'Start as job'}
                        @click=${(ev: Event) => {
                          ev.stopPropagation();
                          this.runEntry(e);
                        }}
                      >
                        ▶
                      </button>
                    `
                  : nothing}
              </div>
            `,
          )}
          ${!this.loading && !this.entries.length && !this.error
            ? html`<div class="empty">Empty directory</div>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderEditor(): TemplateResult {
    const caps = capabilities.get();
    return html`
      <div class="files-editor">
        <div class="editor-bar">
          <span class="editor-path" title=${this.openPath ?? ''}>
            ${basename(this.openPath ?? '')}${this.dirty ? ' •' : ''}
          </span>
          <button
            class="primary"
            ?disabled=${!this.dirty || this.saving || !caps.fileWrite}
            @click=${() => void this.save()}
          >
            ${this.saving ? 'Saving…' : 'Save'}
          </button>
          <button class="ghost" @click=${() => this.closeEditor()}>Close</button>
        </div>
        <textarea
          class="editor-text"
          spellcheck="false"
          .value=${this.content}
          ?readonly=${!caps.fileWrite}
          @input=${(e: Event) => {
            this.content = (e.target as HTMLTextAreaElement).value;
            this.requestUpdate();
          }}
        ></textarea>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!capabilities.get().files) {
      return html`<div class="empty">This controller does not expose a filesystem</div>`;
    }
    if (!connected.get()) return html`<div class="empty">Not connected</div>`;

    return html`
      <div class="files ${this.openPath ? 'split' : ''}">
        ${this.renderBrowser()} ${this.openPath ? this.renderEditor() : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-files', FilesPanel);

registerPanel({
  id: 'files',
  title: 'Files',
  tag: 'cnc-files',
  defaultWidth: 6,
  defaultHeight: 420,
  available: (caps) => caps.files,
  description: 'Browse the controller filesystem, view and edit config',
});
