// Dashboard host: a 12-column grid of panels, reorderable by dragging a
// header, resizable, and persisted to localStorage.
//
// Deliberately not a full tiling window manager. Panels flow in a grid; each
// carries a column span and a pixel height. That covers "all on one page with
// configurable panels" without the complexity of arbitrary docking, and it
// degrades to a single readable column on a phone or a shop tablet in portrait.

import { html, nothing, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { PanelElement, panelDefinition, panelDefinitions } from './panel.js';
import { capabilities, loadSetting, saveSetting } from '../core/store.js';

export interface PanelInstance {
  /** Unique per instance so the same panel can appear twice. */
  key: string;
  /** PanelDefinition id. */
  id: string;
  width: number;
  height: number;
}

/**
 * Default dashboard.
 *
 * Ordered by how often you look at something while actually working:
 * position and motion first, then the toolpath with the spindle and tool
 * changer beside it, then files and console, then the operation packs.
 *
 * The object-model browser is deliberately absent. It is an advanced
 * diagnostic — genuinely useful, but not something to spend a sixth of the
 * screen on before you have needed it once. It is one click away in the panel
 * picker, and that space goes to the spindle and job instead.
 */
const DEFAULT_LAYOUT: PanelInstance[] = [
  { key: 'dro-1', id: 'dro', width: 5, height: 360 },
  // Tall enough for the XY pad, Z column and an aux-axis column without scrolling.
  { key: 'jog-1', id: 'jog', width: 4, height: 360 },
  { key: 'job-1', id: 'job', width: 3, height: 360 },
  { key: 'viewer-1', id: 'viewer', width: 8, height: 560 },
  // Full height beside the viewer so all eight ATC slots are visible at once.
  { key: 'spindle-1', id: 'spindle', width: 4, height: 560 },
  { key: 'console-1', id: 'console', width: 6, height: 420 },
  { key: 'files-1', id: 'files', width: 6, height: 420 },
  { key: 'probe-1', id: 'probe', width: 6, height: 520 },
  { key: 'machining-1', id: 'machining', width: 6, height: 520 },
];

/**
 * Bring a stored layout forward when panels change shape.
 *
 * A saved layout survives updates, so removing a panel would otherwise leave a
 * silent hole where it used to be. The combined Spindle & Job panel became two.
 */
function migrate(layout: PanelInstance[]): PanelInstance[] {
  if (!layout.some((p) => p.id === 'status')) return layout;
  const out: PanelInstance[] = [];
  for (const p of layout) {
    if (p.id === 'status') {
      out.push({ key: `spindle-${p.key}`, id: 'spindle', width: p.width, height: 480 });
      out.push({ key: `job-${p.key}`, id: 'job', width: p.width, height: p.height });
    } else {
      out.push(p);
    }
  }
  return out;
}

export class DashboardHost extends PanelElement {
  private layout: PanelInstance[] = migrate(loadSetting('layout', DEFAULT_LAYOUT));
  private dragKey: string | null = null;
  private pickerOpen = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => capabilities.get());
  }

  private persist(): void {
    saveSetting('layout', this.layout);
    this.requestUpdate();
  }

  private addPanel(id: string): void {
    const def = panelDefinition(id);
    if (!def) return;
    this.layout = [
      ...this.layout,
      {
        key: `${id}-${Date.now().toString(36)}`,
        id,
        width: def.defaultWidth,
        height: def.defaultHeight,
      },
    ];
    this.pickerOpen = false;
    this.persist();
  }

  private removePanel(key: string): void {
    this.layout = this.layout.filter((p) => p.key !== key);
    this.elements.delete(key);
    this.persist();
  }

  private setWidth(key: string, width: number): void {
    this.layout = this.layout.map((p) => (p.key === key ? { ...p, width } : p));
    this.persist();
  }

  private resetLayout(): void {
    this.layout = DEFAULT_LAYOUT.map((p) => ({ ...p }));
    this.elements.clear();
    this.pickerOpen = false;
    this.persist();
  }

  // --- Drag to reorder ---------------------------------------------------
  // Pointer events rather than HTML5 drag-and-drop so it works with touch on a
  // shop tablet, where dragstart never fires.

  private onHeaderPointerDown(e: PointerEvent, key: string): void {
    if ((e.target as HTMLElement).closest('button')) return;
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

    const from = this.layout.findIndex((p) => p.key === this.dragKey);
    const to = this.layout.findIndex((p) => p.key === overKey);
    if (from < 0 || to < 0) return;

    const next = [...this.layout];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this.layout = next;
    this.requestUpdate();
  }

  private onPointerUp(): void {
    if (!this.dragKey) return;
    this.dragKey = null;
    this.persist();
  }

  // --- Resize handle -----------------------------------------------------

  private startResize(e: PointerEvent, key: string): void {
    e.preventDefault();
    const panel = this.layout.find((p) => p.key === key);
    if (!panel) return;
    const startY = e.clientY;
    const startHeight = panel.height;

    const move = (ev: PointerEvent) => {
      const h = Math.max(140, startHeight + (ev.clientY - startY));
      this.layout = this.layout.map((p) => (p.key === key ? { ...p, height: h } : p));
      this.requestUpdate();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.persist();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // --- Render ------------------------------------------------------------

  /**
   * Panel elements are created once per instance and reused. Building them in
   * render() would hand Lit a fresh node every pass, tearing down and rebuilding
   * each panel — losing scroll position, console history, viewer camera and any
   * in-progress edit.
   */
  private elements = new Map<string, PanelElement>();

  private elementFor(p: PanelInstance, tag: string): PanelElement {
    let el = this.elements.get(p.key);
    if (!el) {
      el = document.createElement(tag) as PanelElement;
      el.instanceId = p.key;
      this.elements.set(p.key, el);
    }
    return el;
  }

  private renderPanel(p: PanelInstance): TemplateResult | typeof nothing {
    const def = panelDefinition(p.id);
    if (!def) return nothing;

    const el = this.elementFor(p, def.tag);

    return html`
      <section
        class="panel ${this.dragKey === p.key ? 'dragging' : ''}"
        data-panel-key=${p.key}
        style="grid-column: span ${p.width}; height: ${p.height}px"
      >
        <header
          class="panel-head"
          @pointerdown=${(e: PointerEvent) => this.onHeaderPointerDown(e, p.key)}
        >
          <span class="panel-title">${def.title}</span>
          <span class="panel-tools">
            <select
              class="width-select"
              title="Panel width"
              .value=${String(p.width)}
              @change=${(e: Event) =>
                this.setWidth(p.key, Number((e.target as HTMLSelectElement).value))}
            >
              ${[3, 4, 5, 6, 8, 9, 12].map(
                (w) => html`<option value=${w} ?selected=${w === p.width}>${w}/12</option>`,
              )}
            </select>
            <button class="icon" title="Remove panel" @click=${() => this.removePanel(p.key)}>
              ✕
            </button>
          </span>
        </header>
        <div class="panel-body">${el}</div>
        <div
          class="resize-handle"
          title="Drag to resize"
          @pointerdown=${(e: PointerEvent) => this.startResize(e, p.key)}
        ></div>
      </section>
    `;
  }

  private renderPicker(): TemplateResult {
    const caps = capabilities.get();
    const used = new Set(this.layout.map((p) => p.id));
    const available = panelDefinitions().filter((d) => !d.available || d.available(caps));

    return html`
      <div class="picker">
        <div class="picker-list">
          ${available.map(
            (d) => html`
              <button class="picker-item" @click=${() => this.addPanel(d.id)}>
                <strong>${d.title}</strong>
                ${used.has(d.id) ? html`<em>(already shown)</em>` : nothing}
                ${d.description ? html`<small>${d.description}</small>` : nothing}
              </button>
            `,
          )}
        </div>
        <div class="picker-foot">
          <button class="ghost" @click=${() => this.resetLayout()}>Reset layout</button>
          <button class="ghost" @click=${() => ((this.pickerOpen = false), this.requestUpdate())}>
            Close
          </button>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const visible = this.layout.filter((p) => {
      const def = panelDefinition(p.id);
      return def && (!def.available || def.available(caps));
    });

    return html`
      <div
        class="dashboard"
        @pointermove=${(e: PointerEvent) => this.onPointerMove(e)}
        @pointerup=${() => this.onPointerUp()}
        @pointercancel=${() => this.onPointerUp()}
      >
        ${repeat(
          visible,
          (p) => p.key,
          (p) => this.renderPanel(p),
        )}
      </div>
      <button
        class="add-panel"
        title="Add a panel"
        @click=${() => ((this.pickerOpen = !this.pickerOpen), this.requestUpdate())}
      >
        ${this.pickerOpen ? '✕' : '+'}
      </button>
      ${this.pickerOpen ? this.renderPicker() : nothing}
    `;
  }
}

customElements.define('cnc-dashboard', DashboardHost);
