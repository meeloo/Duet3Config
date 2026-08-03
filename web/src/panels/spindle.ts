// Spindle and tool changer.
//
// Which tool is in the spindle is the single most consequential thing on this
// screen — every feed, speed and Z offset depends on it, and getting it wrong
// breaks cutters. So it is stated once, large, at the top, rather than being a
// number tucked into a status line.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine, run } from '../core/store.js';
import { BUSY_STATES } from '../machine/types.js';
import {
  TOOL_TYPES,
  describeTool,
  emptyGeometry,
  getTool,
  loadTools,
  saveTools,
  type ToolGeometry,
  type ToolInfo,
  type ToolType,
} from '../tools/table.js';
import { readToolLibrary, type ToolLibrary } from '../tools/fusion.js';

const RPM_PRESETS = [6000, 9000, 12000, 15000, 18000, 24000];

export class SpindlePanel extends PanelElement {
  private rpm = 12000;
  private tools = loadTools();
  private editing: number | null = null;

  // --- Library import -----------------------------------------------------
  /** Parsed but not yet applied; the operator sees it before the table moves. */
  private library: ToolLibrary | null = null;
  /** Rows the operator has unticked in the preview, by position in the list. */
  private excluded = new Set<number>();
  /** Assign 1…N in library order, for libraries that number nothing. */
  private renumber = false;
  private importError: string | null = null;
  private importBusy = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private get busy(): boolean {
    return BUSY_STATES.has(machine.get().status);
  }

  /** Slot count from the machine's own ATC configuration. */
  private get slotCount(): number {
    const globals = machine.peek().extras.global as Record<string, unknown> | undefined;
    const n = globals?.atcCount;
    return typeof n === 'number' && n > 0 ? n : 0;
  }

  private machineToolName(number: number): string | null {
    const t = machine.peek().tool;
    return t && t.number === number ? t.name : null;
  }

  private updateTool(number: number, patch: Partial<ToolInfo>): void {
    const next = { ...getTool(this.tools, number), ...patch, number };
    this.tools = { ...this.tools, [number]: next };
    saveTools(this.tools);
    this.requestUpdate();
  }

  private updateGeometry(number: number, patch: Partial<ToolGeometry>): void {
    const current = getTool(this.tools, number).geometry ?? emptyGeometry();
    this.updateTool(number, { geometry: { ...current, ...patch } });
  }

  // --- Library import -----------------------------------------------------

  private async loadLibrary(file: File): Promise<void> {
    this.importBusy = true;
    this.importError = null;
    this.library = null;
    this.requestUpdate();
    try {
      const library = await readToolLibrary(new Uint8Array(await file.arrayBuffer()));
      if (!library.tools.length) {
        throw new Error(
          library.skipped.length
            ? 'that library holds no numbered cutting tools'
            : 'that library is empty',
        );
      }
      this.library = library;
      this.excluded = new Set();
      // A library that numbers nothing is useless as-is, so the offer to number
      // it starts accepted; one that numbers properly is never touched.
      this.renumber = library.duplicateNumbers.length > 0;
    } catch (err) {
      this.importError = (err as Error).message;
    } finally {
      this.importBusy = false;
      this.requestUpdate();
    }
  }

  /**
   * The number a preview row will land on.
   *
   * Position in the full list, not in the ticked subset — unticking the third
   * of ten tools must not silently shift the other seven onto different slots
   * than the ones the preview showed.
   */
  private importNumber(index: number): number {
    const tool = this.library!.tools[index];
    return this.renumber ? index + 1 : tool.info.number;
  }

  private applyLibrary(): void {
    const library = this.library;
    if (!library) return;
    // Merge rather than replace: a library covers the tools it covers, and a
    // slot the operator filled in by hand is not evidence of anything wrong.
    const next = { ...this.tools };
    library.tools.forEach((tool, index) => {
      if (this.excluded.has(index)) return;
      const number = this.importNumber(index);
      next[number] = { ...tool.info, number };
    });
    this.tools = next;
    saveTools(this.tools);
    this.library = null;
    this.requestUpdate();
  }

  // --- Actions -----------------------------------------------------------

  private selectTool(n: number): void {
    // T<n> runs the machine's own tfree/tpre/tpost chain, which on this config
    // handles the dust shoe and the tool-length probe. Never bypass it.
    if (!confirm(`Change to tool T${n}?\n\nThis runs the full tool-change sequence.`)) return;
    void actions.send(`T${n}`);
  }

  private pickup(n: number): void {
    if (!confirm(`Pick up tool ${n} from its slot?\n\nThis does NOT probe tool length.`)) return;
    void run(`pickup ${n}`, (d) => d.send(`M98 P"/sys/atcPickup.g" S${n}`));
  }

  private drop(n: number): void {
    if (!confirm(`Drop the current tool into slot ${n}?`)) return;
    void run(`drop ${n}`, (d) => d.send(`M98 P"/sys/atcDrop.g" S${n}`));
  }

  private releaseTool(): void {
    if (!confirm('Deselect the current tool (T-1)?')) return;
    void actions.send('T-1');
  }

  // --- Render ------------------------------------------------------------

  private renderActiveTool(): TemplateResult {
    const state = machine.get();
    const tool = state.tool;
    const info = tool ? getTool(this.tools, tool.number) : null;

    if (!tool || !info) {
      return html`
        <div class="active-tool none">
          <div class="active-tool-number">—</div>
          <div class="active-tool-detail">
            <strong>No tool loaded</strong>
            <span>Select a tool below to load one</span>
          </div>
        </div>
      `;
    }

    const zOffset = tool.offsets?.[2];
    return html`
      <div class="active-tool">
        <div class="active-tool-number">T${tool.number}</div>
        <div class="active-tool-detail">
          <strong>${describeTool(info, tool.name)}</strong>
          <span>
            ${zOffset != null && zOffset !== 0
              ? html`Z offset ${zOffset.toFixed(3)}mm`
              : html`<em class="unmeasured">Z offset not set — probe the tool</em>`}
          </span>
        </div>
        <button class="tiny" ?disabled=${!connected.get() || this.busy} @click=${() => this.releaseTool()}>
          Release
        </button>
      </div>
    `;
  }

  private renderSpindle(): TemplateResult {
    const s = machine.get().spindle;
    const live = connected.get();
    if (!s) return html`<div class="empty">No spindle configured</div>`;

    const running = s.state !== 'stopped';
    const max = s.max || 24000;

    return html`
      <div class="spindle-block">
        <div class="spindle-readout ${running ? 'running' : ''}">
          <span class="spindle-rpm">${Math.round(s.current)}</span>
          <span class="spindle-unit">rpm</span>
          ${running && Math.abs(s.active - s.current) > 50
            ? html`<span class="spindle-target">→ ${Math.round(s.active)}</span>`
            : nothing}
        </div>
        <div class="spindle-controls">
          <select
            .value=${String(this.rpm)}
            @change=${(e: Event) => (this.rpm = Number((e.target as HTMLSelectElement).value))}
          >
            ${RPM_PRESETS.filter((r) => r <= max).map(
              (r) => html`<option value=${r} ?selected=${r === this.rpm}>${r}</option>`,
            )}
          </select>
          <button ?disabled=${!live} @click=${() => void actions.setSpindle(this.rpm, 'forward')}>
            Start
          </button>
          <button class=${running ? 'danger' : ''} ?disabled=${!live || !running}
            @click=${() => void actions.stopSpindle()}>
            Stop
          </button>
        </div>
      </div>
    `;
  }

  private renderToolRow(n: number, isManual: boolean): TemplateResult {
    const state = machine.get();
    const info = getTool(this.tools, n);
    const active = state.tool?.number === n;
    const live = connected.get();
    const canAct = live && !this.busy;
    const open = this.editing === n;

    return html`
      <div class="tool-row ${active ? 'active' : ''}">
        <button
          class="tool-slot"
          title=${isManual ? 'Manual tool' : `ATC slot ${n}`}
          @click=${() => ((this.editing = open ? null : n), this.requestUpdate())}
        >
          ${isManual ? 'M' : n}
        </button>
        <div class="tool-name" @click=${() => ((this.editing = open ? null : n), this.requestUpdate())}>
          ${describeTool(info, this.machineToolName(n))}
          ${info.notes ? html`<em>${info.notes}</em>` : nothing}
        </div>
        <div class="tool-actions">
          <button class="tiny" title="Full tool change to T${n}" ?disabled=${!canAct || active}
            @click=${() => this.selectTool(n)}>T${n}</button>
          ${isManual
            ? nothing
            : html`
                <button class="tiny" title="Pick up from slot ${n} (no probe)"
                  ?disabled=${!canAct} @click=${() => this.pickup(n)}>↑</button>
                <button class="tiny" title="Drop into slot ${n}"
                  ?disabled=${!canAct} @click=${() => this.drop(n)}>↓</button>
              `}
        </div>
      </div>
      ${open
        ? html`
            <div class="tool-edit">
              <label class="param">
                <span class="param-label">Name</span>
                <span class="param-input">
                  <input type="text" .value=${info.name} placeholder="e.g. 6mm compression"
                    @change=${(e: Event) => this.updateTool(n, { name: (e.target as HTMLInputElement).value })} />
                </span>
              </label>
              <label class="param">
                <span class="param-label">Diameter</span>
                <span class="param-input">
                  <input type="number" step="0.1" min="0" .value=${String(info.diameter)}
                    @change=${(e: Event) => this.updateTool(n, { diameter: Number((e.target as HTMLInputElement).value) })} />
                  <em>mm</em>
                </span>
              </label>
              <label class="param">
                <span class="param-label">Type</span>
                <span class="param-input">
                  <select @change=${(e: Event) => this.updateTool(n, { type: (e.target as HTMLSelectElement).value as ToolType })}>
                    ${TOOL_TYPES.map(
                      (t) => html`<option value=${t.value} ?selected=${t.value === info.type}>${t.label}</option>`,
                    )}
                  </select>
                </span>
              </label>
              <label class="param">
                <span class="param-label">Flutes</span>
                <span class="param-input">
                  <input type="number" step="1" min="0" .value=${String(info.flutes)}
                    @change=${(e: Event) => this.updateTool(n, { flutes: Number((e.target as HTMLInputElement).value) })} />
                </span>
              </label>
              <label class="param wide">
                <span class="param-label">Notes</span>
                <span class="param-input">
                  <input type="text" .value=${info.notes} placeholder="feeds, material, anything"
                    @change=${(e: Event) => this.updateTool(n, { notes: (e.target as HTMLInputElement).value })} />
                </span>
              </label>
              ${this.renderGeometry(n, info)}
            </div>
          `
        : nothing}
    `;
  }

  /**
   * The dimensions the 3D view draws from.
   *
   * Every one of them is optional and blank means "work it out" — the viewer
   * guesses a plausible shank and length from the diameter alone. Filling them
   * in is only worth doing for the tools whose reach you actually need to
   * judge, which on most machines is the long ones and the big ones.
   */
  private renderGeometry(n: number, info: ToolInfo): TemplateResult {
    const g = info.geometry ?? emptyGeometry();
    const dim = (
      label: string,
      value: number,
      unit: string,
      apply: (v: number) => void,
      step = 0.1,
    ) => html`
      <label class="param">
        <span class="param-label">${label}</span>
        <span class="param-input">
          <input type="number" step=${step} min="0" placeholder="auto"
            .value=${value > 0 ? String(value) : ''}
            @change=${(e: Event) => apply(Number((e.target as HTMLInputElement).value) || 0)} />
          <em>${unit}</em>
        </span>
      </label>
    `;

    return html`
      <div class="tool-geom-head">Geometry — for the 3D view</div>
      ${dim('Shank ⌀', g.shank, 'mm', (v) => this.updateGeometry(n, { shank: v }))}
      ${dim('Flute length', g.flute, 'mm', (v) => this.updateGeometry(n, { flute: v }))}
      ${dim('Overall length', g.length, 'mm', (v) => this.updateGeometry(n, { length: v }))}
      ${dim('Corner radius', g.cornerRadius, 'mm', (v) => this.updateGeometry(n, { cornerRadius: v }))}
      ${dim('Tip angle', g.tipAngle, '°', (v) => this.updateGeometry(n, { tipAngle: v }), 1)}
    `;
  }

  // --- Library import UI --------------------------------------------------

  private renderImportButton(): TemplateResult {
    return html`
      <label class="tool-import" title="Fusion 360 → Manage → Tool Library → right-click → Export">
        <input
          type="file"
          accept=".tools,.json,application/json"
          @change=${(e: Event) => {
            const input = e.target as HTMLInputElement;
            const file = input.files?.[0];
            // Clear it, so choosing the same file twice still fires a change.
            input.value = '';
            if (file) void this.loadLibrary(file);
          }}
        />
        <span>${this.importBusy ? 'Reading…' : 'Import library…'}</span>
      </label>
    `;
  }

  private renderPreview(): TemplateResult | typeof nothing {
    const library = this.library;
    if (!library) return nothing;

    const chosen = library.tools.filter((_, index) => !this.excluded.has(index));

    return html`
      <div class="modal-backdrop">
        <div class="modal wide" role="dialog" aria-modal="true">
          <h2>Import ${library.tools.length} tool${library.tools.length === 1 ? '' : 's'}</h2>
          <p class="import-intro">
            Tool numbers come from the library's post-processor settings, so they match what
            Fusion posts. Tools not listed here are left alone.
          </p>

          ${library.duplicateNumbers.length
            ? html`
                <label class="import-renumber">
                  <input
                    type="checkbox"
                    .checked=${this.renumber}
                    @change=${(e: Event) => {
                      this.renumber = (e.target as HTMLInputElement).checked;
                      this.requestUpdate();
                    }}
                  />
                  <span>Number them 1–${library.tools.length} in library order</span>
                </label>
              `
            : nothing}

          <div class="import-rows">
            ${library.tools.map((tool, index) => {
              const number = this.importNumber(index);
              const info = tool.info;
              const existing = this.tools[number];
              const on = !this.excluded.has(index);
              return html`
                <label class="import-row ${on ? '' : 'off'}">
                  <input
                    type="checkbox"
                    .checked=${on}
                    @change=${(e: Event) => {
                      if ((e.target as HTMLInputElement).checked) this.excluded.delete(index);
                      else this.excluded.add(index);
                      this.requestUpdate();
                    }}
                  />
                  <span class="import-number">T${number}</span>
                  <span class="import-detail">
                    <strong>${describeTool(info, null)}</strong>
                    <em>
                      ${tool.sourceType}${tool.note ? ` · ${tool.note}` : ''}
                      ${existing
                        ? html`<span class="import-replaces"
                            >replaces ${describeTool(existing, null)}</span
                          >`
                        : nothing}
                    </em>
                  </span>
                </label>
              `;
            })}
          </div>

          ${library.warnings.map((w) => html`<div class="warn-banner">${w}</div>`)}
          ${library.skipped.length
            ? html`<details class="import-skipped">
                <summary>${library.skipped.length} entr${library.skipped.length === 1 ? 'y' : 'ies'} skipped</summary>
                ${library.skipped.map((s) => html`<div>${s}</div>`)}
              </details>`
            : nothing}

          <div class="modal-buttons">
            <button class="ghost" @click=${() => ((this.library = null), this.requestUpdate())}>
              Cancel
            </button>
            <button class="primary" ?disabled=${!chosen.length} @click=${() => this.applyLibrary()}>
              Import ${chosen.length}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const slots = this.slotCount;
    const state = machine.get();
    // Anything the controller declares beyond the ATC slots — this config has a
    // manual tool 9 past the eight pockets.
    const manual = state.tool && state.tool.number > slots ? [state.tool.number] : [];
    const extraManual = slots > 0 && manual.length === 0 ? [slots + 1] : manual;

    return html`
      <div class="spindle-panel">
        ${this.renderActiveTool()} ${this.renderSpindle()}
        ${this.importError ? html`<div class="warn-banner">${this.importError}</div>` : nothing}
        ${caps.toolChanger && slots > 0
          ? html`
              <div class="tool-list">
                <div class="tool-list-head">
                  <span>Tool changer</span>
                  <em>${slots} slots · tap a row to edit</em>
                  ${this.renderImportButton()}
                </div>
                ${Array.from({ length: slots }, (_, i) => this.renderToolRow(i + 1, false))}
                ${extraManual.map((n) => this.renderToolRow(n, true))}
              </div>
            `
          : nothing}
        ${this.renderPreview()}
      </div>
    `;
  }
}

customElements.define('cnc-spindle', SpindlePanel);

registerPanel({
  id: 'spindle',
  title: 'Spindle & Tools',
  tag: 'cnc-spindle',
  defaultWidth: 4,
  defaultHeight: 520,
  description: 'Spindle control, active tool, and the ATC tool table',
});
