// Dashboard host: paged, fixed to the viewport, never scrolls.
//
// Scrolling a dashboard is fine at a desk and wrong at a machine. Standing at
// the spindle — often one-handed, sometimes in gloves, occasionally in a hurry —
// a control you have to hunt for by scrolling is a control you don't have. So
// the app fills the window exactly and splits panels across PAGES you switch
// between, rather than one long column you scroll.
//
// Consequences that fall out of that decision:
//  - panel height is a ROW SPAN, not pixels: rows divide the available height,
//    so every page fits whatever window it is given;
//  - number keys 1-9 switch pages, because on a shop floor a keystroke beats
//    aiming at a tab;
//  - panels still scroll internally when their own content overflows. That is
//    unavoidable (a file listing is arbitrarily long) but it is contained, and
//    the controls around it never move.
//
// Narrow screens are the one exception: below the breakpoint the grid collapses
// to a single column and the page is allowed to scroll, because a phone-width
// viewport cannot show a useful panel otherwise.

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PanelElement, panelDefinition, panelDefinitions } from './panel.js';
import { capabilities, loadSetting, saveSetting } from '../core/store.js';

export interface PanelInstance {
  /** Unique per instance so the same panel can appear twice. */
  key: string;
  /** PanelDefinition id. */
  id: string;
  /** Columns of 12. */
  width: number;
  /** Rows spanned within the page's row count. */
  rows: number;
}

export interface Page {
  id: string;
  name: string;
  /** How many equal rows this page divides the viewport into. */
  rows: number;
  panels: PanelInstance[];
}

export interface Layout {
  pages: Page[];
  active: number;
}

/**
 * Default pages, grouped by what you are doing rather than by what things are.
 *
 * Control is what you look at while jogging and setting up. Job is what you
 * look at while something is cutting. Setup holds the operation packs, which
 * you visit deliberately. Advanced holds the object-model browser — a real
 * diagnostic, but not worth screen space before it has been needed.
 */
const DEFAULT_LAYOUT: Layout = {
  active: 0,
  pages: [
    {
      id: 'control',
      name: 'Control',
      rows: 2,
      panels: [
        { key: 'dro-1', id: 'dro', width: 4, rows: 1 },
        { key: 'jog-1', id: 'jog', width: 4, rows: 1 },
        // Full height so all eight ATC slots show without scrolling.
        { key: 'spindle-1', id: 'spindle', width: 4, rows: 2 },
        { key: 'job-1', id: 'job', width: 4, rows: 1 },
        { key: 'console-1', id: 'console', width: 4, rows: 1 },
      ],
    },
    {
      id: 'job',
      name: 'Job',
      // Three rows so the viewer keeps its height while preflight, overrides
      // and run-from-line stack beside it — all three act on the program in
      // the viewer, and run-from-line needs its Pick button on the same page.
      rows: 3,
      panels: [
        { key: 'viewer-1', id: 'viewer', width: 8, rows: 3 },
        { key: 'preflight-1', id: 'preflight', width: 4, rows: 1 },
        { key: 'overrides-1', id: 'overrides', width: 4, rows: 1 },
        { key: 'resume-1', id: 'resume', width: 4, rows: 1 },
      ],
    },
    {
      id: 'setup',
      name: 'Setup',
      rows: 2,
      panels: [
        { key: 'probe-1', id: 'probe', width: 6, rows: 2 },
        { key: 'machining-1', id: 'machining', width: 6, rows: 2 },
      ],
    },
    {
      id: 'advanced',
      name: 'Advanced',
      rows: 1,
      panels: [
        { key: 'om-1', id: 'om', width: 5, rows: 1 },
        { key: 'files-1', id: 'files', width: 3, rows: 1 },
        { key: 'console-2', id: 'console', width: 4, rows: 1 },
      ],
    },
  ],
};

/**
 * Bring older stored layouts forward.
 *
 * Two shapes have existed: a flat array of pixel-height panels, and the
 * combined status panel before it split. A stored layout outlives updates, so
 * neither may be dropped silently — a flat layout becomes a single page with
 * pixel heights mapped onto row spans.
 */
function migrate(stored: unknown): Layout {
  if (Array.isArray(stored)) {
    const rows = 2;
    const panels: PanelInstance[] = [];
    for (const p of stored as Array<{ key: string; id: string; width: number; height: number }>) {
      const ids = p.id === 'status' ? ['spindle', 'job'] : [p.id];
      for (const id of ids) {
        panels.push({
          key: `${id}-${panels.length}`,
          id,
          width: p.width,
          rows: Math.max(1, Math.min(rows, Math.round((p.height ?? 360) / 380))),
        });
      }
    }
    return { active: 0, pages: [{ id: 'main', name: 'Main', rows, panels }] };
  }

  const layout = stored as Layout;
  if (!layout || !Array.isArray(layout.pages) || layout.pages.length === 0) {
    return structuredClone(DEFAULT_LAYOUT);
  }
  return layout;
}

export class DashboardHost extends PanelElement {
  private layout: Layout = migrate(loadSetting<unknown>('layout', null) ?? DEFAULT_LAYOUT);
  private dragKey: string | null = null;
  private pickerOpen = false;
  private renaming: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => capabilities.get());
    window.addEventListener('keydown', this.onKeyDown);
    this.onDispose(() => window.removeEventListener('keydown', this.onKeyDown));
  }

  /** Number keys switch pages — faster than aiming at a tab at the machine. */
  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > this.layout.pages.length) return;
    this.layout = { ...this.layout, active: n - 1 };
    this.persist();
  };

  private get page(): Page {
    return this.layout.pages[Math.min(this.layout.active, this.layout.pages.length - 1)];
  }

  private persist(): void {
    saveSetting('layout', this.layout);
    this.requestUpdate();
  }

  private mutatePage(fn: (page: Page) => Page): void {
    const pages = this.layout.pages.map((p, i) => (i === this.layout.active ? fn(p) : p));
    this.layout = { ...this.layout, pages };
    this.persist();
  }

  // --- Panels ------------------------------------------------------------

  private elements = new Map<string, PanelElement>();

  private elementFor(key: string, tag: string): PanelElement {
    let el = this.elements.get(key);
    if (!el) {
      el = document.createElement(tag) as PanelElement;
      el.instanceId = key;
      this.elements.set(key, el);
    }
    return el;
  }

  private addPanel(id: string): void {
    const def = panelDefinition(id);
    if (!def) return;
    this.mutatePage((page) => ({
      ...page,
      panels: [
        ...page.panels,
        { key: `${id}-${Date.now().toString(36)}`, id, width: Math.min(12, def.defaultWidth), rows: 1 },
      ],
    }));
    this.pickerOpen = false;
    this.requestUpdate();
  }

  private removePanel(key: string): void {
    this.elements.delete(key);
    this.mutatePage((page) => ({ ...page, panels: page.panels.filter((p) => p.key !== key) }));
  }

  private setWidth(key: string, width: number): void {
    this.mutatePage((page) => ({
      ...page,
      panels: page.panels.map((p) => (p.key === key ? { ...p, width } : p)),
    }));
  }

  private setRows(key: string, rows: number): void {
    this.mutatePage((page) => ({
      ...page,
      panels: page.panels.map((p) => (p.key === key ? { ...p, rows } : p)),
    }));
  }

  // --- Pages -------------------------------------------------------------

  private addPage(): void {
    const id = `page-${Date.now().toString(36)}`;
    this.layout = {
      pages: [...this.layout.pages, { id, name: `Page ${this.layout.pages.length + 1}`, rows: 2, panels: [] }],
      active: this.layout.pages.length,
    };
    this.persist();
  }

  private removePage(index: number): void {
    if (this.layout.pages.length <= 1) return;
    const page = this.layout.pages[index];
    if (page.panels.length && !confirm(`Delete the "${page.name}" page and its ${page.panels.length} panel(s)?`)) return;
    for (const p of page.panels) this.elements.delete(p.key);
    const pages = this.layout.pages.filter((_, i) => i !== index);
    this.layout = { pages, active: Math.max(0, Math.min(this.layout.active, pages.length - 1)) };
    this.persist();
  }

  private renamePage(index: number, name: string): void {
    const pages = this.layout.pages.map((p, i) => (i === index ? { ...p, name: name || p.name } : p));
    this.layout = { ...this.layout, pages };
    this.renaming = null;
    this.persist();
  }

  private setPageRows(rows: number): void {
    this.mutatePage((page) => ({
      ...page,
      rows,
      // Nothing may span more rows than the page has.
      panels: page.panels.map((p) => ({ ...p, rows: Math.min(p.rows, rows) })),
    }));
  }

  private resetLayout(): void {
    this.elements.clear();
    this.layout = structuredClone(DEFAULT_LAYOUT);
    this.pickerOpen = false;
    this.persist();
  }

  // --- Drag to reorder ---------------------------------------------------

  private onHeaderPointerDown(e: PointerEvent, key: string): void {
    if ((e.target as HTMLElement).closest('button, select')) return;
    this.dragKey = key;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.requestUpdate();
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.dragKey) return;
    const over = document
      .elementsFromPoint(e.clientX, e.clientY)
      .find((el) => el instanceof HTMLElement && el.dataset.panelKey) as HTMLElement | undefined;
    const overKey = over?.dataset.panelKey;
    if (!overKey || overKey === this.dragKey) return;

    const panels = [...this.page.panels];
    const from = panels.findIndex((p) => p.key === this.dragKey);
    const to = panels.findIndex((p) => p.key === overKey);
    if (from < 0 || to < 0) return;
    const [moved] = panels.splice(from, 1);
    panels.splice(to, 0, moved);
    this.layout = {
      ...this.layout,
      pages: this.layout.pages.map((p, i) => (i === this.layout.active ? { ...p, panels } : p)),
    };
    this.requestUpdate();
  }

  private onPointerUp(): void {
    if (!this.dragKey) return;
    this.dragKey = null;
    this.persist();
  }

  // --- Render ------------------------------------------------------------

  private renderPanel(p: PanelInstance, pageRows: number): TemplateResult | typeof nothing {
    const def = panelDefinition(p.id);
    if (!def) return nothing;
    const el = this.elementFor(p.key, def.tag);

    return html`
      <section
        class="panel ${this.dragKey === p.key ? 'dragging' : ''}"
        data-panel-key=${p.key}
        style="grid-column: span ${p.width}; grid-row: span ${Math.min(p.rows, pageRows)}"
      >
        <header class="panel-head" @pointerdown=${(e: PointerEvent) => this.onHeaderPointerDown(e, p.key)}>
          <span class="panel-title">${def.title}</span>
          <span class="panel-tools">
            <select
              class="width-select"
              title="Panel width"
              @change=${(e: Event) => this.setWidth(p.key, Number((e.target as HTMLSelectElement).value))}
            >
              ${[3, 4, 5, 6, 7, 8, 9, 12].map(
                (w) => html`<option value=${w} ?selected=${w === p.width}>${w}/12</option>`,
              )}
            </select>
            ${pageRows > 1
              ? html`
                  <select
                    class="width-select"
                    title="Panel height in rows"
                    @change=${(e: Event) => this.setRows(p.key, Number((e.target as HTMLSelectElement).value))}
                  >
                    ${Array.from({ length: pageRows }, (_, i) => i + 1).map(
                      (r) => html`<option value=${r} ?selected=${r === p.rows}>${r}r</option>`,
                    )}
                  </select>
                `
              : nothing}
            <button class="icon" title="Remove panel" @click=${() => this.removePanel(p.key)}>✕</button>
          </span>
        </header>
        <div class="panel-body">${el}</div>
      </section>
    `;
  }

  private renderTabs(): TemplateResult {
    return html`
      <nav class="pages">
        ${this.layout.pages.map((page, i) => {
          const active = i === this.layout.active;
          if (this.renaming === page.id) {
            return html`
              <input
                class="page-rename"
                .value=${page.name}
                autofocus
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.renamePage(i, (e.target as HTMLInputElement).value);
                  if (e.key === 'Escape') ((this.renaming = null), this.requestUpdate());
                }}
                @blur=${(e: Event) => this.renamePage(i, (e.target as HTMLInputElement).value)}
              />
            `;
          }
          return html`
            <button
              class="page-tab ${active ? 'active' : ''}"
              title=${`${page.name} — press ${i + 1}`}
              @click=${() => {
                if (active) this.renaming = page.id;
                else this.layout = { ...this.layout, active: i };
                this.persist();
              }}
            >
              <span class="page-key">${i + 1}</span>${page.name}
              ${active && this.layout.pages.length > 1
                ? html`<span class="page-close" title="Delete page"
                    @click=${(e: Event) => (e.stopPropagation(), this.removePage(i))}>✕</span>`
                : nothing}
            </button>
          `;
        })}
        <button class="page-add" title="Add a page" @click=${() => this.addPage()}>+</button>

        <span class="pages-spacer"></span>
        <label class="rows-select" title="How many rows this page divides the height into">
          <select @change=${(e: Event) => this.setPageRows(Number((e.target as HTMLSelectElement).value))}>
            ${[1, 2, 3].map(
              (r) => html`<option value=${r} ?selected=${r === this.page.rows}>${r} row${r > 1 ? 's' : ''}</option>`,
            )}
          </select>
        </label>
        <button class="tiny" title="Add a panel to this page"
          @click=${() => ((this.pickerOpen = !this.pickerOpen), this.requestUpdate())}>
          ${this.pickerOpen ? 'Close' : '+ Panel'}
        </button>
      </nav>
    `;
  }

  private renderPicker(): TemplateResult {
    const caps = capabilities.get();
    const used = new Set(this.page.panels.map((p) => p.id));
    const available = panelDefinitions().filter((d) => !d.available || d.available(caps));

    return html`
      <div class="picker">
        <div class="picker-list">
          ${available.map(
            (d) => html`
              <button class="picker-item" @click=${() => this.addPanel(d.id)}>
                <strong>${d.title}</strong>
                ${used.has(d.id) ? html`<em>(already on this page)</em>` : nothing}
                ${d.description ? html`<small>${d.description}</small>` : nothing}
              </button>
            `,
          )}
        </div>
        <div class="picker-foot">
          <button class="ghost" @click=${() => this.resetLayout()}>Reset all pages</button>
          <button class="ghost" @click=${() => ((this.pickerOpen = false), this.requestUpdate())}>Close</button>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const page = this.page;
    const visible = page.panels.filter((p) => {
      const def = panelDefinition(p.id);
      return def && (!def.available || def.available(caps));
    });

    return html`
      ${this.renderTabs()}
      <div
        class="dashboard"
        style="grid-template-rows: repeat(${page.rows}, minmax(0, 1fr))"
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${() => this.onPointerUp()}
        @pointercancel=${() => this.onPointerUp()}
      >
        ${repeat(
          visible,
          (p) => p.key,
          (p) => this.renderPanel(p, page.rows),
        )}
        ${visible.length === 0
          ? html`<div class="page-empty">
              This page is empty — use <strong>+ Panel</strong> to add something.
            </div>`
          : nothing}
      </div>
      ${this.pickerOpen ? this.renderPicker() : nothing}
    `;
  }
}

customElements.define('cnc-dashboard', DashboardHost);
