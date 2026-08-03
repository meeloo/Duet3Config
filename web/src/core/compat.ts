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
 * Pointer events, from touch events.
 *
 * Safari did not implement Pointer Events until 13, which on an iOS 12 iPad
 * means `pointerdown` never fires — and every motion control in this app is
 * built on it. Jogging, orbiting the 3D view and driving the camera are all
 * simply dead there, silently, because a listener that is never called looks
 * exactly like a button that does nothing.
 *
 * Only what this app actually uses is synthesised: one pointer at a time, no
 * hover, no pressure, no tilt. A full polyfill is a much larger thing and none
 * of the rest is reachable from here.
 *
 * `setPointerCapture` earns a second job. `touch-action: none` is also Safari
 * 13, so the usual way of saying "this gesture is mine, do not scroll the page"
 * is unavailable too — but the controls that mean it are exactly the ones that
 * capture the pointer. So capturing suppresses the browser's own scrolling for
 * the rest of that gesture, which is what the CSS would have done.
 */
function installPointerEvents(): void {
  if ('PointerEvent' in window || !('ontouchstart' in window)) return;

  /** The element that claimed this gesture, if any. */
  let captured: Element | null = null;
  /** Where the gesture started, so a finger that slides off still reports. */
  let origin: EventTarget | null = null;
  /** True when the engine turned out to deliver its own pointer events. */
  let native = false;
  let suppressed = false;

  // Absence of the constructor is the only thing that can be tested up front,
  // and it is not proof that the events are missing too. If real ones do turn
  // up, stand down for that gesture rather than dispatching a second set — a
  // jog button that fires twice per tap moves the machine twice, which is a
  // considerably worse bug than the one being fixed. Pointer events precede
  // touch events, so this is known in time.
  document.addEventListener(
    'pointerdown',
    (e) => {
      // Only a touch-driven one counts. An engine that reports mouse pointer
      // events but not touch ones still needs the synthesis for touch, and
      // saying otherwise would disable it on exactly that hybrid.
      if (e.isTrusted && e.pointerType !== 'mouse') native = true;
    },
    true,
  );

  const dispatch = (type: string, touch: Touch, source: TouchEvent): boolean => {
    const target = (captured ?? origin ?? touch.target) as EventTarget;
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      shiftKey: source.shiftKey,
      ctrlKey: source.ctrlKey,
      altKey: source.altKey,
      metaKey: source.metaKey,
    });
    // MouseEvent has no pointer fields, and handlers read pointerId.
    for (const [key, value] of Object.entries({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      width: 1,
      height: 1,
      pressure: type === 'pointerup' ? 0 : 0.5,
    })) {
      Object.defineProperty(event, key, { value, enumerable: true });
    }
    return target.dispatchEvent(event);
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        // A second finger means a two-finger gesture — a pinch — not a drag.
        // End the one being synthesised, or the 3D view keeps orbiting from
        // the first finger while the pinch scales it.
        if (origin && !suppressed) dispatch('pointerup', e.changedTouches[0], e);
        captured = null;
        origin = null;
        return;
      }
      suppressed = native;
      if (suppressed) return;
      captured = null;
      origin = e.target;
      dispatch('pointerdown', e.changedTouches[0], e);
    },
    true,
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      // Multi-touch belongs to whatever is handling the gesture directly.
      if (suppressed || !origin || e.touches.length > 1) return;
      dispatch('pointermove', e.changedTouches[0], e);
      // Only once something has claimed the gesture. Otherwise this would kill
      // scrolling everywhere, which is the opposite of the problem.
      if (captured && e.cancelable) e.preventDefault();
    },
    // Not passive, or preventDefault would be ignored.
    { capture: true, passive: false },
  );

  const end = (e: TouchEvent) => {
    if (suppressed || !origin) return;
    dispatch('pointerup', e.changedTouches[0], e);
    captured = null;
    origin = null;
  };
  document.addEventListener('touchend', end, true);
  document.addEventListener('touchcancel', end, true);

  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.setPointerCapture = function (this: Element): void {
    captured = this;
  };
  proto.releasePointerCapture = function (this: Element): void {
    if (captured === this) captured = null;
  };
  proto.hasPointerCapture = function (this: Element): boolean {
    return captured === this;
  };
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
  installPointerEvents();

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
