// Spindle and running-job status.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, capabilities, connected, machine } from '../core/store.js';
import { basename, formatBytes, formatDuration } from '../core/util.js';
import { empty } from '../ui/widgets.js';

const RPM_PRESETS = [0, 6000, 12000, 18000, 24000];

export class StatusPanel extends PanelElement {
  private rpm = 12000;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
      capabilities.get();
    });
  }

  private renderSpindle(): TemplateResult | typeof nothing {
    const s = machine.get().spindle;
    if (!s) return nothing;
    const live = connected.get();
    const running = s.state !== 'stopped';

    return html`
      <div class="status-block">
        <div class="status-row">
          <span class="label">Spindle</span>
          <span class="value ${running ? 'active' : ''}">
            ${Math.round(s.current)} <small>rpm</small>
          </span>
        </div>
        ${s.active > 0 && Math.abs(s.active - s.current) > 1
          ? html`<div class="status-row sub">
              <span class="label">commanded</span>
              <span class="value">${Math.round(s.active)}</span>
            </div>`
          : nothing}
        <div class="spindle-controls">
          <select
            .value=${String(this.rpm)}
            @change=${(e: Event) => (this.rpm = Number((e.target as HTMLSelectElement).value))}
          >
            ${RPM_PRESETS.filter((r) => r <= (s.max || 24000)).map(
              (r) => html`<option value=${r} ?selected=${r === this.rpm}>${r} rpm</option>`,
            )}
          </select>
          <button ?disabled=${!live} @click=${() => void actions.setSpindle(this.rpm, 'forward')}>
            Start
          </button>
          <button ?disabled=${!live || !running} @click=${() => void actions.stopSpindle()}>
            Stop
          </button>
        </div>
      </div>
    `;
  }

  private renderJob(): TemplateResult {
    const state = machine.get();
    const job = state.job;
    const live = connected.get();

    if (!job) {
      return html`<div class="status-block"><div class="empty">No job running</div></div>`;
    }

    const pct = job.progress != null ? Math.round(job.progress * 100) : null;

    return html`
      <div class="status-block">
        <div class="status-row">
          <span class="label">Job</span>
          <span class="value small" title=${job.fileName ?? ''}>
            ${job.fileName ? basename(job.fileName) : '—'}
          </span>
        </div>
        ${pct != null
          ? html`
              <div class="progress" title="${pct}%">
                <div class="progress-bar" style="width:${pct}%"></div>
                <span class="progress-label">${pct}%</span>
              </div>
            `
          : nothing}
        <div class="status-row sub">
          <span class="label">elapsed</span><span class="value">${formatDuration(job.elapsed)}</span>
        </div>
        <div class="status-row sub">
          <span class="label">remaining</span
          ><span class="value">${formatDuration(job.remaining)}</span>
        </div>
        ${job.filePosition != null && job.fileSize
          ? html`<div class="status-row sub">
              <span class="label">position</span>
              <span class="value">${formatBytes(job.filePosition)} / ${formatBytes(job.fileSize)}</span>
            </div>`
          : nothing}
        <div class="job-controls">
          ${state.status === 'paused'
            ? html`<button class="primary" ?disabled=${!live} @click=${() => void actions.resumeJob()}>
                Resume
              </button>`
            : html`<button ?disabled=${!live} @click=${() => void actions.pauseJob()}>Pause</button>`}
          <button class="danger" ?disabled=${!live} @click=${() => void actions.cancelJob()}>
            Cancel
          </button>
        </div>
      </div>
    `;
  }

  protected override render(): TemplateResult {
    if (!connected.get() && !machine.get().axes.length) return empty('Not connected');
    return html`<div class="status-panel">${this.renderSpindle()}${this.renderJob()}</div>`;
  }
}

customElements.define('cnc-status', StatusPanel);

registerPanel({
  id: 'status',
  title: 'Spindle & Job',
  tag: 'cnc-status',
  defaultWidth: 3,
  defaultHeight: 320,
  description: 'Spindle control and running job progress',
});
