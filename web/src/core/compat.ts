// Shims for browsers older than the ones this was written against.
//
// Specifically an iPad mini 2, which is stuck on iOS 12 and therefore Safari
// 12. That is a 2018 engine, and a tablet propped next to the machine is
// exactly the job a superseded iPad is good for, so it is worth supporting.
//
// Syntax is not this file's problem — the bundler lowers that. What it cannot
// do is invent APIs that were not there, and only one of them actually stops
// the app dead: ResizeObserver (Safari 13.1), which dockview constructs
// unguarded to lay itself out. Without it the dashboard throws before drawing
// anything.
//
// Imported for its side effects, first, before anything can touch the DOM.

/**
 * ResizeObserver, approximately.
 *
 * The real one is driven by layout itself and fires exactly when a box
 * changes. This polls, which is a genuinely worse thing, and the honest
 * justification is that both users of it here — dockview's layout and the
 * 3D view's canvas — only need to notice within a few frames of a resize, and
 * both already re-check on their own for other reasons.
 *
 * One timer and one resize listener for all observers rather than per
 * instance: a dashboard has a dozen or so live at once, and a dozen intervals
 * on a 2013 tablet is a real cost.
 */
class PollingResizeObserver {
  private static observers = new Set<PollingResizeObserver>();
  private static timer: number | null = null;

  private targets = new Set<Element>();
  private sizes = new WeakMap<Element, { width: number; height: number }>();

  constructor(private callback: (entries: unknown[], observer: unknown) => void) {}

  observe(target: Element): void {
    this.targets.add(target);
    // Seed the size so the first check reports a change only if one happened —
    // the real thing fires once on observe, which callers rely on, so measure
    // now and deliver that first callback.
    const rect = target.getBoundingClientRect();
    this.sizes.set(target, { width: rect.width, height: rect.height });
    this.deliver([target]);
    PollingResizeObserver.observers.add(this);
    PollingResizeObserver.start();
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    if (!this.targets.size) PollingResizeObserver.observers.delete(this);
  }

  disconnect(): void {
    this.targets.clear();
    PollingResizeObserver.observers.delete(this);
  }

  private deliver(targets: Element[]): void {
    if (!targets.length) return;
    const entries = targets.map((target) => {
      const rect = target.getBoundingClientRect();
      return {
        target,
        contentRect: rect,
        borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
      };
    });
    try {
      this.callback(entries, this);
    } catch (err) {
      // A throwing observer callback must not kill the shared timer and take
      // every other observer down with it.
      console.error('resize observer callback failed:', err);
    }
  }

  private check(): void {
    const changed: Element[] = [];
    for (const target of this.targets) {
      const rect = target.getBoundingClientRect();
      const previous = this.sizes.get(target);
      if (!previous || Math.abs(previous.width - rect.width) > 0.5 || Math.abs(previous.height - rect.height) > 0.5) {
        this.sizes.set(target, { width: rect.width, height: rect.height });
        changed.push(target);
      }
    }
    this.deliver(changed);
  }

  /** Often enough to feel immediate when dragging a splitter, cheap enough. */
  private static readonly INTERVAL_MS = 150;

  private static start(): void {
    if (this.timer != null) return;
    this.timer = window.setInterval(() => {
      for (const observer of this.observers) observer.check();
    }, this.INTERVAL_MS);
    // A resize is the one case where waiting up to 150ms is visible, so take
    // that one for free.
    window.addEventListener('resize', () => {
      for (const observer of this.observers) observer.check();
    });
  }
}

/**
 * Applied on import rather than exposed as a call the entry point makes: an
 * `import` is hoisted above every statement in the module that writes it, so a
 * call in main.ts would run *after* dockview had already been evaluated.
 */
export function installCompat(): void {
  if (typeof window === 'undefined') return;

  if (typeof (window as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = PollingResizeObserver;
  }

  // Flexbox gap arrived in Safari 14.1, and there is no way to ask CSS about it
  // — `@supports (gap: 1px)` is true on Safari 12 because grid gap works there.
  // So it is measured, once, and published as a class for the stylesheet.
  document.documentElement.classList.toggle('no-flex-gap', !supportsFlexGap());
}

/**
 * Does `gap` actually do anything in a flex container?
 *
 * Two 1px children in a column flex box with a 1px gap: 3px tall if gap works,
 * 2px if it is being ignored.
 */
function supportsFlexGap(): boolean {
  const probe = document.createElement('div');
  probe.style.cssText = 'display:flex;flex-direction:column;row-gap:1px;position:absolute;visibility:hidden';
  probe.appendChild(document.createElement('div'));
  probe.appendChild(document.createElement('div'));
  document.body.appendChild(probe);
  const supported = probe.scrollHeight === 1;
  probe.parentNode?.removeChild(probe);
  return supported;
}

installCompat();
