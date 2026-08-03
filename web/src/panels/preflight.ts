// Preflight panel: check a job against the machine before starting it.
//
// Works on whatever the viewer currently has loaded, so the thing you are
// looking at is the thing being checked — there is no second file picker to get
// out of step with the toolpath on screen.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { loadedProgram } from '../ui/program.js';
import { preflight, verdict, type Check, type CheckLevel } from '../job/preflight.js';
import { loadTools } from '../tools/table.js';
import { basename } from '../core/util.js';

const ICON: Record<CheckLevel, string> = { ok: '✓', warn: '!', error: '✕', info: 'i' };

export class PreflightPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
      loadedProgram.get();
    });
  }

  private get slotCount(): number {
    const globals = machine.peek().extras.global as Record<string, unknown> | undefined;
    const n = globals?.atcCount;
    return typeof n === 'number' && n > 0 ? n : 0;
  }

  private renderCheck(c: Check): TemplateResult {
    return html`
      <div class="pf-check ${c.level}">
        <span class="pf-check-icon">${ICON[c.level]}</span>
        <div class="pf-check-body">
          <strong>${c.title}</strong>
          ${c.detail ? html`<span>${c.detail}</span>` : nothing}
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const program = loadedProgram.get();
    if (!program) {
      return html`
        <div class="empty">
          Open a G-code file in the Toolpath panel, or generate an operation, and its checks appear here.
        </div>
      `;
    }

    const state = machine.get();
    if (!state.axes.length) return html`<div class="empty">Not connected</div>`;

    const checks = preflight({
      path: program.path,
      state,
      tools: loadTools(),
      slotCount: this.slotCount,
    });
    const overall = verdict(checks);
    const live = connected.get();
    // Generated programs live only in the browser until saved, so there is
    // nothing on the controller to start yet.
    const runnable = program.controllerPath !== null;

    return html`
      <div class="preflight">
        <div class="preflight-head ${overall}">
          <span class="preflight-verdict">
            ${overall === 'ok' ? 'Ready' : overall === 'warn' ? 'Check first' : 'Not ready'}
          </span>
          <span class="preflight-file" title=${program.name}>${basename(program.name)}</span>
        </div>

        <div class="pf-check-list">${checks.map((c) => this.renderCheck(c))}</div>

        <div class="preflight-actions">
          ${runnable
            ? html`
                <button
                  class=${overall === 'error' ? 'danger' : 'primary'}
                  ?disabled=${!live}
                  @click=${() => {
                    const warn =
                      overall === 'error'
                        ? 'Preflight found problems that will likely crash or run off the bed.\n\n'
                        : '';
                    if (confirm(`${warn}Start ${basename(program.name)}?`)) {
                      void actions.startJob(program.controllerPath!);
                    }
                  }}
                >
                  ${overall === 'error' ? 'Start anyway' : 'Start job'}
                </button>
              `
            : html`<span class="hint">Save this program to the controller before it can be run.</span>`}
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-preflight', PreflightPanel);

registerPanel({
  id: 'preflight',
  title: 'Preflight',
  tag: 'cnc-preflight',
  defaultWidth: 4,
  defaultHeight: 480,
  description: 'Check a job against the machine before starting it',
});
