// Macro buttons.
//
// The file browser can already run a macro, but getting there is three clicks
// through a tree — and the macros you actually use mid-job are the ones you
// want under a thumb: engage the dust shoe, go to the Z probe, save the work
// state. This is that: every macro on the controller as a button, laid out to
// fill the panel however wide it happens to be.
//
// Folders become sections rather than something to navigate into. A macro two
// folders deep is still one press, which is the entire point; the folder name
// is a heading, not a door.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, activeDriver, capabilities, connected, machine } from '../core/store.js';
import { BUSY_STATES, type FileEntry } from '../machine/types.js';
import { empty } from '../ui/widgets.js';

/** Macros grouped by the folder they live in, root first. */
interface MacroGroup {
  /** Path relative to the macro root; '' is the root itself. */
  label: string;
  macros: FileEntry[];
}

/** How deep to walk. Deep enough for any sane layout, bounded against a loop. */
const MAX_DEPTH = 4;

/**
 * Natural-order compare, so "Tool 10" sorts after "Tool 9" rather than after
 * "Tool 1" — macro sets are routinely numbered and plain string order makes
 * them look shuffled.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export class MacrosPanel extends PanelElement {
  private groups: MacroGroup[] = [];
  private loading = false;
  private error: string | null = null;
  /** Path of the macro most recently fired, for a moment's feedback. */
  private lastRun: string | null = null;
  private loadedFor: string | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      capabilities.get();
      machine.get();
    });
  }

  protected override updated(): void {
    // Load once per connection rather than on every render — the machine signal
    // ticks four times a second and a filelist walk per tick would hammer the
    // board for a directory that changes about once a month.
    const root = capabilities.peek().macroRoot;
    const key = connected.peek() ? root : null;
    if (key && this.loadedFor !== key && !this.loading) {
      this.loadedFor = key;
      void this.load();
    } else if (!key && this.loadedFor !== null) {
      this.loadedFor = null;
      this.groups = [];
    }
  }

  private get canRun(): boolean {
    return connected.get() && !BUSY_STATES.has(machine.get().status);
  }

  // --- Loading ------------------------------------------------------------

  private async load(): Promise<void> {
    const driver = activeDriver();
    const root = capabilities.peek().macroRoot;
    if (!driver || !root) return;

    this.loading = true;
    this.error = null;
    this.requestUpdate();

    try {
      this.groups = await this.walk(driver, root, '', 0);
    } catch (err) {
      this.error = (err as Error).message;
      this.groups = [];
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  /** Depth-first, so a folder's own macros come before its subfolders'. */
  private async walk(
    driver: NonNullable<ReturnType<typeof activeDriver>>,
    dir: string,
    label: string,
    depth: number,
  ): Promise<MacroGroup[]> {
    const entries = await driver.listFiles(dir);
    const macros = entries
      .filter((e) => !e.directory && /\.g$/i.test(e.name))
      .sort((a, b) => collator.compare(a.name, b.name));

    const groups: MacroGroup[] = macros.length ? [{ label, macros }] : [];
    if (depth >= MAX_DEPTH) return groups;

    const folders = entries
      .filter((e) => e.directory)
      .sort((a, b) => collator.compare(a.name, b.name));
    for (const folder of folders) {
      try {
        groups.push(
          ...(await this.walk(driver, folder.path, label ? `${label} / ${folder.name}` : folder.name, depth + 1)),
        );
      } catch {
        // One unreadable folder must not lose every other button.
      }
    }
    return groups;
  }

  // --- Running ------------------------------------------------------------

  private async run(macro: FileEntry): Promise<void> {
    this.lastRun = macro.path;
    this.requestUpdate();
    await actions.runMacro(macro.path);
    // Clear the highlight after a beat. Not a progress indicator — a macro can
    // run for minutes and the machine's own status says whether it is busy;
    // this only confirms the press landed.
    setTimeout(() => {
      if (this.lastRun === macro.path) {
        this.lastRun = null;
        this.requestUpdate();
      }
    }, 1200);
  }

  // --- Render -------------------------------------------------------------

  /** `.g` is noise on a button — every one of them is a .g. */
  private static title(name: string): string {
    return name.replace(/\.g$/i, '');
  }

  private renderGroup(group: MacroGroup): TemplateResult {
    return html`
      ${group.label
        ? html`<div class="macro-sep"><span>${group.label}</span></div>`
        : nothing}
      <div class="macro-grid">
        ${group.macros.map(
          (macro) => html`
            <button
              class=${this.lastRun === macro.path ? 'macro-btn ran' : 'macro-btn'}
              title=${macro.path}
              ?disabled=${!this.canRun}
              @click=${() => void this.run(macro)}
            >
              ${MacrosPanel.title(macro.name)}
            </button>
          `,
        )}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const live = connected.get();

    if (!caps.macros || !caps.macroRoot) {
      return empty('This controller does not run macro files.');
    }
    if (!live) return empty('Not connected');

    const count = this.groups.reduce((n, g) => n + g.macros.length, 0);

    return html`
      <div class="macros">
        <div class="macro-bar">
          <span class="hint">${count} macro${count === 1 ? '' : 's'} in ${caps.macroRoot}</span>
          <button class="tiny" ?disabled=${this.loading} @click=${() => void this.load()}>
            ${this.loading ? 'Reading…' : 'Refresh'}
          </button>
        </div>
        ${this.error ? html`<div class="warn-banner">${this.error}</div>` : nothing}
        ${!this.loading && !count && !this.error
          ? empty(`No .g files under ${caps.macroRoot}.`)
          : nothing}
        <div class="macro-scroll">${this.groups.map((g) => this.renderGroup(g))}</div>
        ${live && !this.canRun
          ? html`<div class="macro-blocked">Machine busy — macros disabled</div>`
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-macros', MacrosPanel);

registerPanel({
  id: 'macros',
  title: 'Macros',
  tag: 'cnc-macros',
  defaultWidth: 4,
  defaultHeight: 320,
  available: (caps) => caps.macros,
  description: 'One button per macro on the controller, grouped by folder',
});
