// Base class for panels.
//
// Two jobs:
//  1. Opt out of Shadow DOM. Style encapsulation is friction for a single-dev
//     app: global CSS wouldn't reach in, theming would have to route through
//     custom properties, and querySelector would stop crossing the boundary.
//  2. Bridge signals to Lit. `bind()` runs a reactive effect that calls
//     requestUpdate() whenever any signal read inside it changes, and disposes
//     itself with the element.

import { LitElement } from 'lit';
import { effect } from '../core/signal.js';

export class PanelElement extends LitElement {
  private disposers: (() => void)[] = [];
  /** Panel instance id, assigned by the layout host. */
  instanceId = '';

  /** Render into light DOM — see note above. */
  protected override createRenderRoot(): HTMLElement | DocumentFragment {
    return this;
  }

  /**
   * Re-render this element whenever any signal read by `reader` changes.
   * Call from connectedCallback; disposal is automatic.
   */
  protected bind(reader: () => void): void {
    let first = true;
    this.disposers.push(
      effect(() => {
        reader();
        if (first) first = false;
        else this.requestUpdate();
      }),
    );
  }

  /** Register any other teardown to run on disconnect. */
  protected onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    for (const d of this.disposers) d();
    this.disposers = [];
  }
}

/** Descriptor used by the layout host to build the panel picker. */
export interface PanelDefinition {
  id: string;
  title: string;
  /** Custom element tag. */
  tag: string;
  /** Default width in grid columns (of 12). */
  defaultWidth: number;
  /** Default height in px. */
  defaultHeight: number;
  /** Hide from the picker when this returns false for the active driver. */
  available?: (caps: import('../machine/types.js').Capabilities) => boolean;
  description?: string;
}

const registry = new Map<string, PanelDefinition>();

export function registerPanel(def: PanelDefinition): void {
  registry.set(def.id, def);
}

export function panelDefinitions(): PanelDefinition[] {
  return [...registry.values()];
}

export function panelDefinition(id: string): PanelDefinition | undefined {
  return registry.get(id);
}
