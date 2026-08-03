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
import { signal } from '../core/signal.js';
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

/**
 * Page state, published for the top bar.
 *
 * The tabs used to sit in their own row directly under the top bar, which meant
 * two full-width strips of chrome above a machine control. Merging them puts the
 * tabs in the top bar — but the pages themselves are still the dashboard's, so
 * rather than move the state, the dashboard publishes it here and the top bar
 * calls back in. There is exactly one dashboard, which is what makes a module
 * reference honest rather than a shortcut.
 */
export const pageTabs = signal<{ pages: Array<{ id: string; name: string }>; active: number }>({
  pages: [],
  active: 0,
});

/** Tab being renamed in place, by page id. */
export const renamingPage = signal<string | null>(null);

/** Whether the add-a-panel picker is showing. */
export const panelPickerOpen = signal(false);

let host: DashboardHost | null = null;

export function selectPage(index: number): void {
  host?.goToPage(index);
}
export function addPage(): void {
  host?.addPage();
}
export function removePage(index: number): void {
  host?.removePage(index);
}
export function renamePage(index: number, name: string): void {
  host?.renamePage(index, name);
}

const DEFAULT_PAGES: PageSpec[] = [
  { id: 'control', name: 'Control', panels: ['dro', 'jog', 'spindle'], stacked: { job: 'spindle', macros: 'spindle', console: 'spindle' } },
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
  { id: 'setup', name: 'Setup', panels: ['wcs', 'probe'], stacked: { machining: 'probe', surface: 'probe', import: 'probe' } },
  { id: 'advanced', name: 'Advanced', panels: ['diagnostics', 'om'], stacked: { console: 'om', files: 'om' } },
];

function defaultLayout(): LayoutState {
  return { active: 0, pages: DEFAULT_PAGES.map((p) => ({ id: p.id, name: p.name, layout: null })) };
}

export class DashboardHost extends PanelElement {
  private state: LayoutState = load();
  private views = new Map<string, { api: DockviewApi; host: HTMLElement }>();
  /** One element per panel instance id, reused across drags and page switches. */
  private elements = new Map<string, PanelElement>();
  private resizeObserver: ResizeObserver | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => capabilities.get());
    this.bind(() => {
      const t = theme.get();
      for (const { api } of this.views.values()) api.updateOptions({ theme: dvTheme(t) });
    });
    host = this;
    this.publishTabs();
    this.bind(() => panelPickerOpen.get());
    window.addEventListener('keydown', this.onKeyDown);
    this.onDispose(() => {
      if (host === this) host = null;
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
    this.publishTabs();
    this.requestUpdate();
  }

  private publishTabs(): void {
    pageTabs.set({
      pages: this.state.pages.map((p) => ({ id: p.id, name: p.name })),
      active: Math.min(this.state.active, this.state.pages.length - 1),
    });
  }

  /** Switch page. Public because the top bar owns the tabs now. */
  goToPage(index: number): void {
    if (index < 0 || index >= this.state.pages.length) return;
    this.state.active = index;
    this.persist();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1 || n > this.state.pages.length) return;
    this.goToPage(n - 1);
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
    panelPickerOpen.set(false);
    this.persist();
  }

  addPage(): void {
    const id = `page-${Date.now().toString(36)}`;
    this.state.pages.push({ id, name: `Page ${this.state.pages.length + 1}`, layout: null });
    this.state.active = this.state.pages.length - 1;
    this.persist();
  }

  removePage(index: number): void {
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

  renamePage(index: number, name: string): void {
    this.state.pages[index].name = name || this.state.pages[index].name;
    renamingPage.set(null);
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
    panelPickerOpen.set(false);
    this.persist();
  }

  // --- Render -------------------------------------------------------------

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const available = panelDefinitions().filter((d) => !d.available || d.available(caps));

    return html`
      <div class="dv-container"></div>

      ${panelPickerOpen.get()
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
                <button class="ghost" @click=${() => panelPickerOpen.set(false)}>
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
