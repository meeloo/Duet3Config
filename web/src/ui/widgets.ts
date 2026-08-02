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

/** Numeric parameter input. `onChange` fires on change, not on every keystroke. */
export function numberField(
  label: string,
  value: number,
  onChange: (v: number) => void,
  opts: { step?: number; min?: number; max?: number; suffix?: string; title?: string } = {},
): TemplateResult {
  return html`
    <label class="param" title=${opts.title ?? ''}>
      <span class="param-label">${label}</span>
      <span class="param-input">
        <input
          type="number"
          .value=${String(value)}
          step=${opts.step ?? 'any'}
          min=${opts.min ?? ''}
          max=${opts.max ?? ''}
          @change=${(e: Event) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (isFinite(v)) onChange(v);
          }}
        />
        ${opts.suffix ? html`<em>${opts.suffix}</em>` : nothing}
      </span>
    </label>
  `;
}

export function selectField<T extends string>(
  label: string,
  value: T,
  options: Array<{ value: T; label: string }>,
  onChange: (v: T) => void,
): TemplateResult {
  return html`
    <label class="param">
      <span class="param-label">${label}</span>
      <span class="param-input">
        <select @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value as T)}>
          ${options.map(
            (o) => html`<option value=${o.value} ?selected=${o.value === value}>${o.label}</option>`,
          )}
        </select>
      </span>
    </label>
  `;
}

export function checkField(
  label: string,
  value: boolean,
  onChange: (v: boolean) => void,
): TemplateResult {
  return html`
    <label class="param check-param">
      <input
        type="checkbox"
        .checked=${value}
        @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span>${label}</span>
    </label>
  `;
}

export function warnIf(condition: boolean, message: string): TemplateResult | typeof nothing {
  return condition ? html`<div class="warn-banner">${message}</div>` : nothing;
}
