// Object model browser.
//
// This is the one panel that deliberately reaches through the driver's `native`
// escape hatch — it is inherently controller-specific, and gated on
// `capabilities.objectModel` so it simply doesn't appear for drivers without one.
//
// Editing is limited to `global.*`. Those are the variables this machine's
// config actually uses for ATC and dust-shoe state, they're writable with a
// plain `set global.x = v`, and confining edits to that namespace avoids
// offering a text box that looks like it can write read-only firmware state.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, capabilities, connected, machine } from '../core/store.js';
import { actions } from '../core/store.js';
import type { RrfNative } from '../machine/drivers/rrf/driver.js';

export class ObjectModelPanel extends PanelElement {
  private expanded = new Set<string>(['global', 'move', 'state']);
  private filter = '';
  private editing: string | null = null;
  private editValue = '';

  override connectedCallback(): void {
    super.connectedCallback();
    // Re-render on every state push so values track the poll loop.
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private model(): Record<string, unknown> | null {
    const driver = activeDriver();
    const native = driver?.native as RrfNative | undefined;
    if (!native?.getModel) return null;
    try {
      return native.getModel() as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private toggle(path: string): void {
    if (this.expanded.has(path)) this.expanded.delete(path);
    else this.expanded.add(path);
    this.requestUpdate();
  }

  private beginEdit(path: string, value: unknown): void {
    this.editing = path;
    this.editValue = typeof value === 'string' ? value : JSON.stringify(value);
    this.requestUpdate();
  }

  private commitEdit(): void {
    if (!this.editing) return;
    const path = this.editing;
    const raw = this.editValue.trim();

    // Strings need quoting in RRF expressions; numbers and booleans must not be.
    const isNumber = raw !== '' && !isNaN(Number(raw));
    const isBool = raw === 'true' || raw === 'false';
    const literal = isNumber || isBool ? raw : `"${raw.replace(/"/g, '""')}"`;

    void actions.send(`set ${path} = ${literal}`);
    this.editing = null;
    this.requestUpdate();
  }

  private pathMatches(path: string): boolean {
    return !this.filter || path.toLowerCase().includes(this.filter.toLowerCase());
  }

  private renderValue(path: string, value: unknown, depth: number): TemplateResult {
    const editable = path.startsWith('global.');
    const indent = `padding-left:${depth * 12}px`;

    if (value !== null && typeof value === 'object') {
      const isArray = Array.isArray(value);
      const entries = isArray
        ? (value as unknown[]).map((v, i) => [String(i), v] as const)
        : Object.entries(value as Record<string, unknown>);
      const open = this.expanded.has(path);

      return html`
        <div class="om-node">
          <div class="om-row branch" style=${indent} @click=${() => this.toggle(path)}>
            <span class="om-caret">${open ? '▾' : '▸'}</span>
            <span class="om-key">${path.split('.').pop()}</span>
            <span class="om-meta">${isArray ? `[${entries.length}]` : `{${entries.length}}`}</span>
          </div>
          ${open
            ? entries.map(([k, v]) => this.renderValue(`${path}.${k}`, v, depth + 1))
            : nothing}
        </div>
      `;
    }

    if (!this.pathMatches(path)) return html``;

    const display =
      value === null ? 'null' : typeof value === 'string' ? `"${value}"` : String(value);

    return html`
      <div class="om-row leaf" style=${indent}>
        <span class="om-key">${path.split('.').pop()}</span>
        ${this.editing === path
          ? html`
              <input
                class="om-edit"
                .value=${this.editValue}
                autofocus
                @input=${(e: Event) => (this.editValue = (e.target as HTMLInputElement).value)}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.commitEdit();
                  if (e.key === 'Escape') ((this.editing = null), this.requestUpdate());
                }}
                @blur=${() => ((this.editing = null), this.requestUpdate())}
              />
            `
          : html`
              <span
                class="om-value ${typeof value} ${editable ? 'editable' : ''}"
                title=${editable ? 'Click to edit' : path}
                @click=${() => editable && this.beginEdit(path, value)}
                >${display}</span
              >
            `}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!capabilities.get().objectModel) {
      return html`<div class="empty">This controller has no object model</div>`;
    }
    if (!connected.get()) return html`<div class="empty">Not connected</div>`;

    const model = this.model();
    if (!model) return html`<div class="empty">Waiting for object model…</div>`;

    // Sort so the keys worth watching on a CNC come first.
    const priority = ['global', 'move', 'state', 'spindles', 'tools', 'job', 'sensors'];
    const keys = Object.keys(model).sort((a, b) => {
      const ia = priority.indexOf(a);
      const ib = priority.indexOf(b);
      if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.localeCompare(b);
    });

    return html`
      <div class="om">
        <div class="om-bar">
          <input
            type="search"
            placeholder="Filter by path…"
            .value=${this.filter}
            @input=${(e: Event) => {
              this.filter = (e.target as HTMLInputElement).value;
              this.requestUpdate();
            }}
          />
          <span class="hint">global.* is editable</span>
        </div>
        <div class="om-tree">
          ${keys.map((k) => this.renderValue(k, model[k], 0))}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-om', ObjectModelPanel);

registerPanel({
  id: 'om',
  title: 'Machine Model',
  tag: 'cnc-om',
  defaultWidth: 6,
  defaultHeight: 420,
  available: (caps) => caps.objectModel,
  description: 'Browse controller state; edit global variables',
});
