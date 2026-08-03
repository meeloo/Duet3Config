// Run-from-line.
//
// Pick a point on the toolpath (or type a line number), see the modal state the
// skipped lines would have established, and restart there.
//
// The sequence is deliberately two steps: run a generated preamble that
// restores state and repositions, then M23/M26/M24 to seek and go. If the
// connection drops between them the machine is left positioned but idle, which
// is the safe failure — nothing is cutting.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import {
  actions,
  activeDriver,
  appendLog,
  capabilities,
  connected,
  machine,
  run,
} from '../core/store.js';
import { loadedProgram, resumePoint } from '../ui/program.js';
import { buildResumePreamble, modalStateAt, wcsCode, type ModalState } from '../job/resume.js';
import { checkField, numberField } from '../ui/widgets.js';
import { basename, formatBytes } from '../core/util.js';

export class ResumePanel extends PanelElement {
  private changeTool = true;
  private startSpindle = true;
  private plungeFeed = 300;
  private spindleDwell = 4;

  /** Source text, fetched lazily — the parser keeps geometry, not the file. */
  private source: string | null = null;
  private sourceFor: string | null = null;
  private busy = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      loadedProgram.get();
      resumePoint.get();
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  /** Highest machine Z, used as the retract height before any travel. */
  private get safeMachineZ(): number {
    const z = machine.peek().axes.find((a) => a.letter === 'Z');
    return z ? z.max : 0;
  }

  private async ensureSource(path: string): Promise<string | null> {
    if (this.sourceFor === path && this.source) return this.source;
    const driver = activeDriver();
    if (!driver) return null;
    const bytes = await run(`read ${basename(path)}`, (d) => d.readFile(path));
    if (!bytes) return null;
    this.source = new TextDecoder().decode(bytes);
    this.sourceFor = path;
    return this.source;
  }

  private state: ModalState | null = null;
  private stateForOffset = -1;

  private async computeState(offset: number): Promise<void> {
    const program = loadedProgram.peek();
    if (!program?.controllerPath) return;
    const src = await this.ensureSource(program.controllerPath);
    if (!src) return;
    this.state = modalStateAt(src, offset);
    this.stateForOffset = offset;
    this.requestUpdate();
  }

  private async resume(offset: number): Promise<void> {
    const program = loadedProgram.peek();
    if (!program?.controllerPath || !this.state) return;

    const caps = capabilities.peek();
    const preamble = buildResumePreamble(this.state, {
      safeMachineZ: this.safeMachineZ,
      plungeFeed: this.plungeFeed,
      changeTool: this.changeTool,
      startSpindle: this.startSpindle,
      spindleDwell: this.spindleDwell,
    });

    const s = this.state;
    const ok = confirm(
      `Resume ${basename(program.name)} at line ${s.line}?\n\n` +
        `• retract to machine Z${this.safeMachineZ}\n` +
        `• restore ${wcsCode(s.wcs)}, ${s.units === 'mm' ? 'G21' : 'G20'}, G${s.plane}\n` +
        (this.changeTool && s.tool !== null ? `• tool change to T${s.tool} (re-probes length)\n` : '') +
        (this.startSpindle && s.spindleDir !== 'off' ? `• spindle ${s.spindleRpm} rpm\n` : '') +
        `• move to X${s.x.toFixed(2)} Y${s.y.toFixed(2)}, then down to Z${s.z.toFixed(2)}\n` +
        `• seek to byte ${offset} and run\n\n` +
        `Everything before that point will NOT be cut.`,
    );
    if (!ok) return;

    this.busy = true;
    this.requestUpdate();
    try {
      const dir = `${caps.macroRoot ?? '/macros'}/generated`;
      const path = `${dir}/resume-preamble.g`;
      const driver = activeDriver();
      if (!driver) return;
      try {
        await driver.makeDirectory(dir);
      } catch {
        /* exists */
      }
      const written = await run('save resume preamble', async (d) => {
        await d.writeFile(path, new TextEncoder().encode(preamble));
        return true;
      });
      if (!written) return;

      await actions.runMacro(path);
      // M26 needs the file selected by M23 first, and the offset must land on a
      // command boundary — the parser's per-line offsets already do.
      await actions.send(`M23 "${program.controllerPath}"`);
      await actions.send(`M26 S${offset}`);
      await actions.send('M24');
      appendLog({
        level: 'info',
        text: `Resumed ${basename(program.name)} at line ${this.state.line} (byte ${offset})`,
        time: new Date(),
      });
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private renderState(s: ModalState, offset: number, total: number): TemplateResult {
    const rows: Array<[string, string]> = [
      ['Line', String(s.line)],
      ['Position', `${formatBytes(offset)} of ${formatBytes(total)}`],
      ['Coordinates', `${wcsCode(s.wcs)} · ${s.units === 'mm' ? 'G21 mm' : 'G20 inch'} · G${s.plane} · ${s.distance === 'absolute' ? 'G90' : 'G91'}`],
      ['Tool', s.tool !== null ? `T${s.tool}` : 'none selected'],
      ['Spindle', s.spindleDir === 'off' ? 'off' : `${s.spindleRpm} rpm ${s.spindleDir}`],
      ['Feed', s.feed > 0 ? `${s.feed} mm/min` : 'not set'],
      ['Resume at', `X${s.x.toFixed(2)} Y${s.y.toFixed(2)} Z${s.z.toFixed(2)}`],
    ];
    return html`
      <div class="resume-state">
        ${rows.map(
          ([k, v]) => html`<div class="resume-row"><span>${k}</span><strong>${v}</strong></div>`,
        )}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const program = loadedProgram.get();
    if (!program) {
      return html`<div class="empty">Open a G-code file in the Toolpath panel first.</div>`;
    }
    if (!program.controllerPath) {
      return html`<div class="empty">
        This program only exists in the browser. Save it to the controller before resuming into it.
      </div>`;
    }

    const pick = resumePoint.get();
    const offset = pick?.offset ?? null;
    if (offset !== null && offset !== this.stateForOffset && !this.busy) {
      void this.computeState(offset);
    }

    const live = connected.get();
    const s = offset !== null && offset === this.stateForOffset ? this.state : null;

    return html`
      <div class="resume">
        <div class="pack-blurb">
          Choose where the cut restarts from the Toolpath panel: drag the scrub bar, or turn
          on <strong>Pick</strong> and click the path. Everything before that point is skipped.
        </div>

        ${offset === null
          ? html`<div class="empty">No resume point chosen.</div>`
          : s
            ? this.renderState(s, offset, program.path.byteLength)
            : html`<div class="empty">Reading the file…</div>`}

        ${s
          ? html`
              <div class="param-grid">
                ${checkField(
                  `Run tool change${s.tool !== null ? ` (T${s.tool})` : ''}`,
                  this.changeTool,
                  (v) => ((this.changeTool = v), this.requestUpdate()),
                )}
                ${checkField('Restart spindle', this.startSpindle, (v) => ((this.startSpindle = v), this.requestUpdate()))}
                ${numberField('Plunge feed', this.plungeFeed, (v) => ((this.plungeFeed = v), this.requestUpdate()), { suffix: 'mm/min' })}
                ${numberField('Spindle dwell', this.spindleDwell, (v) => ((this.spindleDwell = v), this.requestUpdate()), { suffix: 's' })}
              </div>
              <div class="warn-banner">
                Retracts to machine Z${this.safeMachineZ} before any travel. Check the path from
                where the tool is now to the resume point is clear.
              </div>
            `
          : nothing}

        <div class="pack-actions">
          <button
            class="ghost"
            ?disabled=${offset === null}
            @click=${() => resumePoint.set(null)}
          >
            Clear
          </button>
          <button
            class="primary"
            ?disabled=${!live || !s || this.busy}
            @click=${() => offset !== null && void this.resume(offset)}
          >
            ${this.busy ? 'Resuming…' : 'Resume here'}
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-resume', ResumePanel);

registerPanel({
  id: 'resume',
  title: 'Run from line',
  tag: 'cnc-resume',
  defaultWidth: 4,
  defaultHeight: 480,
  available: (caps) => caps.files && caps.macros,
  description: 'Restart a job partway through, after a broken cutter',
});
