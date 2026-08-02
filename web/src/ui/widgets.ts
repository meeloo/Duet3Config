// Shared render helpers. Not components — plain functions returning templates,
// which keeps them cheap and avoids a custom element per button.

import { html, nothing, type TemplateResult } from 'lit';
import type { MachineStatus } from '../machine/types.js';

export function statusLabel(status: MachineStatus): string {
  switch (status) {
    case 'disconnected':
      return 'Disconnected';
    case 'connecting':
      return 'Connecting';
    case 'idle':
      return 'Idle';
    case 'busy':
      return 'Busy';
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'pausing':
      return 'Pausing';
    case 'resuming':
      return 'Resuming';
    case 'homing':
      return 'Homing';
    case 'tool-change':
      return 'Tool change';
    case 'halted':
      return 'HALTED';
    case 'off':
      return 'Off';
  }
}

/** Colour class for a status pill. */
export function statusClass(status: MachineStatus): string {
  if (status === 'halted') return 'bad';
  if (status === 'disconnected' || status === 'off') return 'dim';
  if (status === 'running' || status === 'tool-change') return 'active';
  if (status === 'paused' || status === 'pausing') return 'warn';
  if (status === 'idle') return 'good';
  return 'busy';
}

export function empty(message: string): TemplateResult {
  return html`<div class="empty">${message}</div>`;
}

export interface ButtonOptions {
  label: string | TemplateResult;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function button(o: ButtonOptions): TemplateResult {
  return html`
    <button
      class=${o.className ?? ''}
      title=${o.title ?? ''}
      ?disabled=${o.disabled ?? false}
      @click=${o.onClick}
    >
      ${o.label}
    </button>
  `;
}

/** Segmented selector — used for jog steps, WCS, spindle presets. */
export function segmented<T>(
  values: readonly T[],
  current: T,
  onSelect: (v: T) => void,
  format: (v: T) => string = String,
): TemplateResult {
  return html`
    <div class="segmented">
      ${values.map(
        (v) => html`
          <button class=${v === current ? 'seg active' : 'seg'} @click=${() => onSelect(v)}>
            ${format(v)}
          </button>
        `,
      )}
    </div>
  `;
}

export function field(label: string, control: TemplateResult): TemplateResult {
  return html`<label class="field"><span>${label}</span>${control}</label>`;
}

export function warnIf(condition: boolean, message: string): TemplateResult | typeof nothing {
  return condition ? html`<div class="warn-banner">${message}</div>` : nothing;
}
