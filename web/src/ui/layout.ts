// Dashboard host, built on dockview-core.
//
// The previous hand-rolled grid worked but the interaction didn't: panels
// swapped on hover with no drop indicator, and two <select>s per header did the
// resizing. Rather than reimplement a docking engine badly, this delegates to
// one — dockview gives tabbed groups, drag between groups with a real drop
// overlay, and drag-to-resize splits, which is the whole of what was wanted.
//
// What stays hand-rolled:
//
//   Pages. Dockview is one docking surface; pages are separate surfaces you
//   switch between with number keys. Each page owns its OWN dockview instance
//   rather than swapping one instance's JSON, because reloading a layout
//   destroys and recreates panels — which would drop the viewer's WebGL context
//   and its parsed toolpath on every page change. Hidden pages keep their
//   panels alive and are re-laid-out when shown.
//
//   Panel lifetime. A panel element is created once per instance id and reused,
//   so dragging it between groups moves the same element rather than rebuilding
//   it. Lit re-runs connectedCallback on re-attach, so bindings re-establish
//   themselves.

import { html, nothing, type TemplateResult } from 'lit';
import { createDockview, type DockviewApi, type DockviewTheme, type IContentRenderer } from 'dockview-core';
import { PanelElement, panelDefinition, panelDefinitions } from './panel.js';
import { capabilities, loadSetting, saveSetting } from '../core/store.js';
import { theme } from '../core/theme.js';

interface PageState {
  id: string;
  name: string;
  /** dockview's serialised layout, or null for a page never opened. */
  layout: unknown | null;
  /**
   * Every panel id this page has ever held.
   *
   * A saved layout would otherwise freeze the page at whatever the defaults
   * were the day it was saved, so a panel added to DEFAULT_PAGES later would
   * never reach anyone who had used the app before. Comparing against this
   * instead of against the current layout adds a genuinely new default once,
   * while a panel the operator closed on purpose stays closed.
   */
  known?: string[];
}

interface LayoutState {
  pages: PageState[];
  active: number;
}

interface PageSpec {
  id: string;
  name: string;
  /** Opened left to right. */
  panels: string[];
  /** panel id → the panel it should sit behind as a tab. */
  stacked?: Record<string, string>;
}

const DEFAULT_PAGES: PageSpec[] = [
  { id: 'control', name: 'Control', panels: ['dro', 'jog', 'spindle'], stacked: { job: 'spindle', console: 'spindle' } },
  {
    id: 'job',
    name: 'Job',
    panels: ['viewer', 'preflight'],
    // Preflight, overrides and run-from-line all act on the loaded program and
    // are never wanted simultaneously, so they share a group as tabs.
    stacked: { overrides: 'preflight', resume: 'preflight', files: 'preflight' },
  },
  // Coordinates beside probing on purpose: the skew routine writes a rotation
  // and the only place that rotation is visible is the Coordinates panel.
  { id: 'setup', name: 'Setup', panels: ['wcs', 'probe'], stacked: { machining: 'probe' } },
  { id: 'advanced', name: 'Advanced', panels: ['om'], stacked: { console: 'om', files: 'om' } },
];

function defaultLayout(): LayoutState {
  return { active: 0, pages: DEFAULT_PAGES.map((p) => ({ id: p.id, name: p.name, layout: null })) };
}

export class DashboardHost extends PanelElement {
  private state: LayoutState = load();
  private views = new Map<string, { api: DockviewApi; host: HTMLElement }>();
  /** One element per panel instance id, reused across drags and page switches. */
  private elements = new Map<string, PanelElement>();
  private pickerOpen = false;
  private renaming: string | null = null;
  private resizeObserver: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => capabilities.get());
    this.bind(() => {
      const t = theme.get();
      for (const { api } of this.views.values()) api.updateOptions({ theme: dvTheme(t) });
    });
    window.addEventListener('keydown', this.onKeyDown);
    this.onDispose(() => {
      window.removeEventListener('keydown', this.onKeyDown);
      this.resizeObserver?.disconnect();
      for (const { api } of this.views.values()) api.dispose();
      this.views.clear();
    });
  }

  protected override updated(): void {
    this.syncViews();
  }

  private get page(): PageState {
    return this.state.pages[Math.min(this.state.active, this.state.pages.length - 1)];
  }

  private persist(): void {
    for (const [id, { api }] of this.views) {
      const page = this.state.pages.find((p) => p.id === id);
      if (!page) continue;
      page.layout = api.toJSON();
      page.known = [...new Set([...(page.known ?? []), ...api.panels.map((p) => p.id)])];
    }
    saveSetting('dockLayout', this.state);
    this.requestUpdate();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > this.state.pages.length) return;
    this.state.active = n - 1;
    this.persist();
  };

  // --- Dockview plumbing --------------------------------------------------

  /** Wrap a panel custom element as a dockview content renderer. */
  private renderer(instanceId: string, panelId: string): IContentRenderer {
    const def = panelDefinition(panelId);
    const wrapper = document.createElement('div');
    wrapper.className = 'dv-panel';

    if (def) {
      let el = this.elements.get(instanceId);
      if (!el) {
        el = document.createElement(def.tag) as PanelElement;
        el.instanceId = instanceId;
        this.elements.set(instanceId, el);
      }
      wrapper.appendChild(el);
    } else {
      wrapper.textContent = `Unknown panel: ${panelId}`;
    }

    return {
      element: wrapper,
      init: () => {
        /* the element is already populated */
      },
    };
  }

  private createView(page: PageState, host: HTMLElement): DockviewApi {
    const api = createDockview(host, {
      // The panel id is the instance id; `name` carries the panel type.
      createComponent: (options) => this.renderer(options.id, options.name),
      disableFloatingGroups: true,
      theme: dvTheme(theme.peek()),
    });

    let seeded = false;
    if (page.layout) {
      try {
        api.fromJSON(page.layout as never);
        seeded = true;
      } catch {
        // A stored layout referencing a panel that no longer exists would
        // otherwise leave a blank page.
        api.clear();
      }
    }
    if (!seeded) page.layout = null;
    this.ensureDefaults(page, api);

    api.onDidLayoutChange(() => this.persist());
    return api;
  }

  /**
   * Ensure a page holds its default panels, left to right with stacked ones as
   * tabs. Idempotent: anything already present, or recorded in `known`, is left
   * alone, so this can run on every update.
   *
   * It has to run repeatedly rather than once at creation for two reasons.
   *
   * Capabilities arrive asynchronously. A page shown before the driver has
   * connected would otherwise seed empty and stay empty for the session, since
   * `available()` rejects every panel while the capability set is still the
   * empty default — which is exactly what happens when the app reopens on the
   * Setup page.
   *
   * And a saved layout would otherwise freeze a page at whatever the defaults
   * were the day it was saved, so a panel added to DEFAULT_PAGES later would
   * never reach anyone who had used the app before.
   *
   * `known` is what stops it fighting the operator: a panel that has ever been
   * on this page is never re-added, so closing one makes it stay closed.
   */
  private ensureDefaults(page: PageState, api: DockviewApi): void {
    const spec = DEFAULT_PAGES.find((p) => p.id === page.id);
    if (!spec) return;
    const caps = capabilities.peek();
    const known = new Set(page.known ?? api.panels.map((p) => p.id));
    const usable = (id: string) => {
      const def = panelDefinition(id);
      return def && (!def.available || def.available(caps)) ? def : null;
    };

    let added = false;
    let previous: string | null = null;
    for (const id of spec.panels) {
      const def = usable(id);
      if (!def) continue;
      if (api.getPanel(id)) {
        previous = id;
        continue;
      }
      if (known.has(id)) continue;
      api.addPanel({
        id,
        component: id,
        title: def.title,
        ...(previous
          ? { position: { referencePanel: previous, direction: 'right' as const } }
          : {}),
      });
      previous = id;
      added = true;
    }

    for (const [id, behind] of Object.entries(spec.stacked ?? {})) {
      const def = usable(id);
      if (!def || api.getPanel(id) || known.has(id)) continue;
      const reference = api.getPanel(behind) ? behind : api.panels[0]?.id;
      api.addPanel({
        id,
        component: id,
        title: def.title,
        ...(reference ? { position: { referencePanel: reference } } : {}),
      });
      added = true;
    }

    // Leave the first tab of each stack showing, not the last one added — but
    // only when something was actually added, or this would yank the operator
    // back to the first tab on every poll.
    if (!added) return;
    for (const id of spec.panels) api.getPanel(id)?.api.setActive();
    api.getPanel(spec.panels[0])?.api.setActive();
    this.persist();
  }

  /** Create views lazily, and show exactly one. */
  private syncViews(): void {
    const container = this.querySelector('.dv-container');
    if (!container) return;

    const active = this.page;
    if (!this.views.has(active.id)) {
      const host = document.createElement('div');
      host.className = 'dv-host';
      container.appendChild(host);
      this.views.set(active.id, { api: this.createView(active, host), host });

      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.layoutActive());
        this.resizeObserver.observe(container);
      }
    }

    for (const [id, v] of this.views) {
      v.host.style.display = id === active.id ? '' : 'none';
      // Capabilities may have arrived since this view was created; a page that
      // seeded empty because the driver had not connected yet fills in here.
      const page = this.state.pages.find((p) => p.id === id);
      if (page) this.ensureDefaults(page, v.api);
    }
    // A hidden dockview has no size, so it must be told its dimensions when it
    // becomes visible or it renders collapsed.
    requestAnimationFrame(() => this.layoutActive());
  }

  private layoutActive(): void {
    const container = this.querySelector('.dv-container') as HTMLElement | null;
    const view = this.views.get(this.page.id);
    if (!container || !view) return;
    view.api.layout(container.clientWidth, container.clientHeight);
  }

  // --- Panels & pages -----------------------------------------------------

  private addPanel(panelId: string): void {
    const view = this.views.get(this.page.id);
    const def = panelDefinition(panelId);
    if (!view || !def) return;
    // A panel already on this page gets a fresh instance id so it can appear twice.
    const id = view.api.getPanel(panelId) ? `${panelId}~${Date.now().toString(36)}` : panelId;
    view.api.addPanel({ id, component: panelId, title: def.title });
    this.pickerOpen = false;
    this.persist();
  }

  private addPage(): void {
    const id = `page-${Date.now().toString(36)}`;
    this.state.pages.push({ id, name: `Page ${this.state.pages.length + 1}`, layout: null });
    this.state.active = this.state.pages.length - 1;
    this.persist();
  }

  private removePage(index: number): void {
    if (this.state.pages.length <= 1) return;
    const page = this.state.pages[index];
    if (!confirm(`Delete the "${page.name}" page?`)) return;
    const view = this.views.get(page.id);
    if (view) {
      view.api.dispose();
      view.host.remove();
      this.views.delete(page.id);
    }
    this.state.pages.splice(index, 1);
    this.state.active = Math.max(0, Math.min(this.state.active, this.state.pages.length - 1));
    this.persist();
  }

  private renamePage(index: number, name: string): void {
    this.state.pages[index].name = name || this.state.pages[index].name;
    this.renaming = null;
    this.persist();
  }

  private resetAll(): void {
    for (const { api, host } of this.views.values()) {
      api.dispose();
      host.remove();
    }
    this.views.clear();
    this.elements.clear();
    this.state = defaultLayout();
    this.pickerOpen = false;
    this.persist();
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const available = panelDefinitions().filter((d) => !d.available || d.available(caps));

    return html`
      <nav class="pages">
        ${this.state.pages.map((page, i) => {
          const active = i === this.state.active;
          if (this.renaming === page.id) {
            return html`<input
              class="page-rename"
              .value=${page.name}
              autofocus
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === 'Enter') this.renamePage(i, (e.target as HTMLInputElement).value);
                if (e.key === 'Escape') ((this.renaming = null), this.requestUpdate());
              }}
              @blur=${(e: Event) => this.renamePage(i, (e.target as HTMLInputElement).value)}
            />`;
          }
          return html`
            <button
              class="page-tab ${active ? 'active' : ''}"
              title=${`${page.name} — press ${i + 1}`}
              @click=${() => {
                if (active) this.renaming = page.id;
                else this.state.active = i;
                this.persist();
              }}
            >
              <span class="page-key">${i + 1}</span>${page.name}
              ${active && this.state.pages.length > 1
                ? html`<span class="page-close" title="Delete page"
                    @click=${(e: Event) => (e.stopPropagation(), this.removePage(i))}>✕</span>`
                : nothing}
            </button>
          `;
        })}
        <button class="page-add" title="Add a page" @click=${() => this.addPage()}>+</button>
        <span class="pages-spacer"></span>
        <button class="tiny" title="Add a panel to this page"
          @click=${() => ((this.pickerOpen = !this.pickerOpen), this.requestUpdate())}>
          ${this.pickerOpen ? 'Close' : '+ Panel'}
        </button>
      </nav>

      <div class="dv-container"></div>

      ${this.pickerOpen
        ? html`
            <div class="picker">
              <div class="picker-list">
                ${available.map(
                  (d) => html`
                    <button class="picker-item" @click=${() => this.addPanel(d.id)}>
                      <strong>${d.title}</strong>
                      ${d.description ? html`<small>${d.description}</small>` : nothing}
                    </button>
                  `,
                )}
              </div>
              <div class="picker-foot">
                <button class="ghost" @click=${() => this.resetAll()}>Reset all pages</button>
                <button class="ghost" @click=${() => ((this.pickerOpen = false), this.requestUpdate())}>
                  Close
                </button>
              </div>
            </div>
          `
        : nothing}
    `;
  }
}

/**
 * dockview 7 applies its theme to an inner shell element it creates itself,
 * defaulting to `abyss` — so setting a theme class on the container does
 * nothing, and the container's own variables are shadowed by the shell's. It
 * has to come through the `theme` option instead.
 *
 * The class names here are dockview's own stylesheet; our overrides in
 * styles.css then re-point its variables at the app palette.
 */
function dvTheme(t: 'light' | 'dark'): DockviewTheme {
  return t === 'dark'
    ? { name: 'app-dark', className: 'dockview-theme-dark', colorScheme: 'dark' }
    : { name: 'app-light', className: 'dockview-theme-light', colorScheme: 'light' };
}

function load(): LayoutState {
  const stored = loadSetting<LayoutState | null>('dockLayout', null);
  if (stored && Array.isArray(stored.pages) && stored.pages.length) return stored;
  return defaultLayout();
}

customElements.define('cnc-dashboard', DashboardHost);
