// Minimal fine-grained reactivity.
//
// Lit gives us templating; this gives us state propagation. The two meet in
// `ReactiveElement.bind()` (see ui/panel.ts), which subscribes an element to a
// set of signals and calls requestUpdate() when any of them change.
//
// Deliberately ~60 lines. There is no scheduler, no diamond-dependency
// resolution and no automatic disposal beyond `effect()`'s returned unsubscribe.
// That is sufficient here because machine state is a tree owned by the
// controller, mirrored one-way into the UI: there is nothing to reconcile.

type Runner = { fn: () => void; deps: Set<Set<Runner>>; disposed: boolean };

let active: Runner | null = null;
let batchDepth = 0;
const pending = new Set<Runner>();

export interface Signal<T> {
  get(): T;
  set(value: T): void;
  /** Mutate in place and notify unconditionally (for arrays/objects). */
  touch(mutator?: (value: T) => void): void;
  peek(): T;
}

export function signal<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is): Signal<T> {
  let value = initial;
  const subs = new Set<Runner>();

  const notify = () => {
    for (const r of [...subs]) {
      if (r.disposed) continue;
      if (batchDepth > 0) pending.add(r);
      else r.fn();
    }
  };

  return {
    get() {
      if (active) {
        subs.add(active);
        active.deps.add(subs);
      }
      return value;
    },
    peek: () => value,
    set(next: T) {
      if (equals(next, value)) return;
      value = next;
      notify();
    },
    touch(mutator?: (v: T) => void) {
      mutator?.(value);
      notify();
    },
  };
}

/** Run `fn`, tracking signal reads. Re-runs when any read signal changes. */
export function effect(fn: () => void): () => void {
  const runner: Runner = { fn: () => {}, deps: new Set(), disposed: false };

  runner.fn = () => {
    if (runner.disposed) return;
    // Drop previous dependencies so conditional branches don't leak subscriptions.
    for (const set of runner.deps) set.delete(runner);
    runner.deps.clear();

    const prev = active;
    active = runner;
    try {
      fn();
    } finally {
      active = prev;
    }
  };

  runner.fn();

  return () => {
    runner.disposed = true;
    for (const set of runner.deps) set.delete(runner);
    runner.deps.clear();
  };
}

/** Cached derived value. Recomputes lazily when its dependencies change. */
export function computed<T>(fn: () => T, equals?: (a: T, b: T) => boolean): Signal<T> {
  const out = signal<T>(undefined as T, equals);
  effect(() => out.set(fn()));
  return out;
}

/**
 * Coalesce notifications. The poll loop wraps each object-model update in this
 * so that a snapshot touching twenty signals triggers one render pass, not twenty.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const queued = [...pending];
      pending.clear();
      for (const r of queued) if (!r.disposed) r.fn();
    }
  }
}
