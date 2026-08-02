// Running job: progress and control.
//
// Split out from the spindle panel — they answer different questions ("what is
// cutting right now" vs "what is the machine doing"), get looked at at
// different moments, and want different amounts of screen.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, connected, machine } from '../core/store.js';
import { basename, formatBytes, formatDuration } from '../core/util.js';
import { statusClass, statusLabel } from '../ui/widgets.js';

export class JobPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
    });
  }

  protected override render(): TemplateResult {
    const state = machine.get();
    const job = state.job;
    const live = connected.get();

    if (!job) {
      return html`
        <div class="job-panel">
          <div class="job-idle">
            <span class="pill ${statusClass(state.status)}">${statusLabel(state.status)}</span>
            <p>No job running</p>
            <p class="hint">Start one from the Files panel, or generate an operation in Machining.</p>
          </div>
        </div>
      `;
    }

    const pct = job.progress != null ? Math.round(job.progress * 100) : null;
    const paused = state.status === 'paused';

    return html`
      <div class="job-panel">
        <div class="job-head">
          <span class="pill ${statusClass(state.status)}">${statusLabel(state.status)}</span>
          <span class="job-file" title=${job.fileName ?? ''}>
            ${job.fileName ? basename(job.fileName) : '—'}
          </span>
        </div>

        ${pct != null
          ? html`
              <div class="progress">
                <div class="progress-bar" style="width:${pct}%"></div>
                <span class="progress-label">${pct}%</span>
              </div>
            `
          : nothing}

        <div class="job-stats">
          <div><span class="label">Elapsed</span><strong>${formatDuration(job.elapsed)}</strong></div>
          <div><span class="label">Remaining</span><strong>${formatDuration(job.remaining)}</strong></div>
          ${state.feedRate != null
            ? html`<div><span class="label">Feed</span><strong>${Math.round(state.feedRate)}</strong></div>`
            : nothing}
          ${state.feedMultiplier !== 1
            ? html`<div><span class="label">Override</span><strong class="warn">${Math.round(state.feedMultiplier * 100)}%</strong></div>`
            : nothing}
          ${job.filePosition != null && job.fileSize
            ? html`<div class="wide"><span class="label">Position</span><strong>${formatBytes(job.filePosition)} / ${formatBytes(job.fileSize)}</strong></div>`
            : nothing}
        </div>

        <div class="job-controls">
          ${paused
            ? html`<button class="primary" ?disabled=${!live} @click=${() => void actions.resumeJob()}>Resume</button>`
            : html`<button ?disabled=${!live} @click=${() => void actions.pauseJob()}>Pause</button>`}
          <button class="danger" ?disabled=${!live}
            @click=${() => confirm('Cancel the running job?') && void actions.cancelJob()}>
            Cancel
          </button>
        </div>
      </div>
    `;
  }
}

customElements.define('cnc-job', JobPanel);

registerPanel({
  id: 'job',
  title: 'Job',
  tag: 'cnc-job',
  defaultWidth: 3,
  defaultHeight: 320,
  description: 'Running job progress, pause and cancel',
});
