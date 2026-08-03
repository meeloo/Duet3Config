// Diagnostics.
//
// What you want on screen when the machine is doing something it shouldn't:
// supply voltage, board temperature, whether the network dropped, whether a
// probe is stuck triggered, and whether this app is still actually talking to
// the controller.
//
// The panel itself knows nothing about any controller. The driver hands back
// pre-formatted sections, including the commands its section buttons should
// send — so a second driver reports whatever it has without a line changing
// here, and one with nothing to report simply makes the panel say so.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { actions, activeDriver, connected, machine } from '../core/store.js';
import { empty } from '../ui/widgets.js';
import type { DiagnosticItem, DiagnosticSection } from '../machine/types.js';

export class DiagnosticsPanel extends PanelElement {
  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      machine.get();
      connected.get();
    });
  }

  private renderItem(item: DiagnosticItem): TemplateResult {
    return html`
      <div class="diag-item">
        <span class="diag-label">${item.label}</span>
        <span class="diag-value ${item.level ?? ''}">${item.value}</span>
        ${item.detail ? html`<span class="diag-detail">${item.detail}</span>` : nothing}
      </div>
    `;
  }

  private renderSection(section: DiagnosticSection, live: boolean): TemplateResult {
    return html`
      <div class="diag-section">
        <div class="diag-title">
          <span>${section.title}</span>
          ${section.actions?.length
            ? html`
                <span class="diag-actions">
                  ${section.actions.map(
                    (a) => html`
                      <button
                        class="tiny"
                        title=${a.title ?? a.command}
                        ?disabled=${!live}
                        @click=${() => void actions.send(a.command)}
                      >
                        ${a.label}
                      </button>
                    `,
                  )}
                </span>
              `
            : nothing}
        </div>
        ${section.items.length
          ? section.items.map((i) => this.renderItem(i))
          : html`<div class="hint">${section.emptyNote ?? 'Nothing to report.'}</div>`}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    // Read the machine signal so this re-renders on every poll; the driver
    // derives its sections from the same snapshot.
    machine.get();
    const live = connected.get();
    const driver = activeDriver();
    const sections = driver?.diagnostics() ?? [];

    if (!live) return empty('Not connected');
    if (!sections.length) {
      return empty(`${driver?.label ?? 'This controller'} does not report diagnostics.`);
    }

    return html`
      <div class="diagnostics">
        ${sections.map((s) => this.renderSection(s, live))}
        <p class="hint">
          Values come straight from the controller and are not compared against any limit
          invented here. For the firmware's own verdict — driver temperature flags, stall
          detection, stack usage — press <strong>M122</strong> and read the console.
        </p>
      </div>
    `;
  }
}

customElements.define('cnc-diagnostics', DiagnosticsPanel);

registerPanel({
  id: 'diagnostics',
  title: 'Diagnostics',
  tag: 'cnc-diagnostics',
  defaultWidth: 4,
  defaultHeight: 480,
  description: 'Supply, temperature, network, probe state and connection health',
});
