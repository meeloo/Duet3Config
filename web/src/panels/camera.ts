// A camera pointed at the machine.
//
// Independent of the controller entirely — it has its own address and its own
// credentials, and it works whether or not the Duet is connected, because the
// times you most want to see the spindle are the times something has gone
// wrong with the connection to it.
//
// The picture is double-buffered: two <img> elements, one showing and one
// loading, swapped when the new frame has decoded. Pointing a single <img> at a
// new src blanks it while the next one downloads, which at 2fps is a strobe
// rather than a video.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { loadSetting, saveSetting } from '../core/store.js';
import { detectCamera } from '../camera/detect.js';
import { DAY_NIGHT, ReolinkClient, SPOTLIGHT_MODES, rtspUrl, snapshotUrl } from '../camera/reolink.js';
import type { PtzOp } from '../camera/reolink.js';
import {
  NO_CONTROLS,
  defaultCameraConfig,
  defaultCredentials,
  type CameraConfig,
  type CameraCredentials,
  type CameraProbe,
} from '../camera/types.js';

/** Pad layout, matching the jog rose's compass sense: north is up-screen. */
const PAD: Array<{ op: PtzOp; label: string; title: string } | null> = [
  { op: 'LeftUp', label: '↖', title: 'Up and left' },
  { op: 'Up', label: '↑', title: 'Up' },
  { op: 'RightUp', label: '↗', title: 'Up and right' },
  { op: 'Left', label: '←', title: 'Left' },
  null, // centre: stop
  { op: 'Right', label: '→', title: 'Right' },
  { op: 'LeftDown', label: '↙', title: 'Down and left' },
  { op: 'Down', label: '↓', title: 'Down' },
  { op: 'RightDown', label: '↘', title: 'Down and right' },
];

/**
 * Rates offered. 0 means "as fast as they arrive" — with the pipeline that is
 * the camera's own ceiling rather than a number anyone has to guess.
 */
const FPS_CHOICES: Array<{ value: number; label: string }> = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 5, label: '5' },
  { value: 10, label: '10' },
  { value: 15, label: '15' },
  { value: 0, label: 'Max' },
];

/** Consecutive dropped frames before the picture is called stale. */
const FRAME_ERROR_LIMIT = 3;

export class CameraPanel extends PanelElement {
  private config: CameraConfig = {
    ...defaultCameraConfig(),
    ...loadSetting<Partial<CameraConfig>>('camera', {}),
  };
  private creds: CameraCredentials = {
    ...defaultCredentials(),
    ...loadSetting<Partial<CameraCredentials>>('cameraAuth', {}),
  };

  private probe: CameraProbe | null = null;
  private client: ReolinkClient | null = null;
  private error: string | null = null;
  private busy = false;
  private showSetup = false;
  private live = false;

  /** Buffers cycle; whichever decodes a newer frame becomes the visible one. */
  private streaming = false;
  private timers: number[] = [];
  /** Request counter, so an out-of-order arrival can be recognised and dropped. */
  private seq = 0;
  private shownSeq = -1;
  /** Consecutive frame failures; reset by any frame that arrives. */
  private frameErrors = 0;
  private presets: Array<{ id: number; name: string }> = [];

  // Control state. Null means "not read" — blind mode never learns it.
  private ir: boolean | null = null;
  private spotMode: number | null = null;
  private spotBright = 100;
  private dayNight: string | null = null;

  private speed = 16;

  override connectedCallback(): void {
    super.connectedCallback();
    // Nothing is contacted until the operator asks, or until a camera that has
    // already been set up is on screen.
    if (this.configured) void this.start();
    else this.showSetup = true;
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.stopStream();
  }

  /** A hidden tab must not keep pulling 4K stills off the camera. */
  private onVisibility = (): void => {
    if (document.hidden) this.stopStream();
    else if (this.live) this.startStream();
  };

  private get configured(): boolean {
    return this.config.kind === 'generic' ? !!this.config.imageUrl.trim() : !!this.config.url.trim();
  }

  private get controls() {
    return this.probe?.controls ?? NO_CONTROLS;
  }

  // --- Connecting ---------------------------------------------------------

  private async start(): Promise<void> {
    this.busy = true;
    this.error = null;
    this.requestUpdate();
    try {
      const probe = await detectCamera(this.config, this.creds);
      this.probe = probe;
      if (probe.kind === 'reolink') {
        const client = new ReolinkClient(this.config, this.creds);
        client.readable = probe.readable;
        this.client = client;
        if (probe.readable) await this.refreshState();
      } else {
        this.client = null;
      }
      this.live = true;
      this.showSetup = false;
      this.startStream();
    } catch (err) {
      this.error = (err as Error).message;
      this.live = false;
      this.probe = null;
      this.showSetup = true;
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }

  private async refreshState(): Promise<void> {
    if (!this.client?.readable) return;
    try {
      const state = await this.client.readState();
      this.ir = state.ir;
      this.spotMode = state.spotlightMode;
      if (state.spotlightBright != null) this.spotBright = state.spotlightBright;
      this.dayNight = state.dayNight;
      if (this.controls.presets) this.presets = await this.client.presets();
    } catch {
      // Readable a moment ago, not now. The picture is the important part.
    }
  }

  private saveConfig(): void {
    saveSetting('camera', this.config);
    saveSetting('cameraAuth', this.creds);
  }

  // --- The picture --------------------------------------------------------

  private imgs(): HTMLImageElement[] {
    return Array.from(this.querySelectorAll<HTMLImageElement>('.cam-frame'));
  }

  private frameUrl(): string {
    if (this.config.kind === 'generic') return this.config.imageUrl;
    return snapshotUrl(this.config, this.creds, Date.now());
  }

  /**
   * Frames per second the pipeline is actually achieving.
   *
   * Shown, because the ceiling depends entirely on the camera and the network
   * and there is otherwise no way to tell a setting that is too high from a
   * camera that is struggling.
   */
  private measured = 0;
  private frameTimes: number[] = [];

  /** Milliseconds between frames the operator asked for; 0 means unpaced. */
  private framePeriod(): number {
    const fps = this.config.fps;
    return fps > 0 ? 1000 / fps : 0;
  }

  /**
   * Poll for stills, several requests deep.
   *
   * The obvious loop — request, wait, request — is what made this a slideshow:
   * the wait is added *after* the frame arrives, so every frame costs a full
   * round trip plus the interval, and a 2fps setting over a 150ms link runs at
   * about 1.5. Requests are pipelined instead, so the round trip overlaps
   * itself and the rate is set by what the camera can produce rather than by
   * how far away it is.
   *
   * Three in flight, not more: Reolink's HTTP server has few workers, and
   * queueing requests it cannot serve buys latency rather than frames.
   */
  private startStream(): void {
    this.stopStream();
    this.frameErrors = 0;
    this.frameTimes = [];
    if (!this.live || document.hidden) return;

    // A multipart MJPEG endpoint streams into one <img> on its own; polling it
    // would throw away the connection every frame.
    if (this.config.stream || this.config.kind === 'generic') {
      const [a] = this.imgs();
      if (a && a.src !== this.config.imageUrl) a.src = this.frameUrl();
      return;
    }

    const imgs = this.imgs();
    // start() flips `live` and calls straight in, before the render that
    // creates the buffers. Staying stopped is what lets updated() try again;
    // claiming to be streaming with nothing to stream from would wedge it.
    if (!imgs.length) return;

    this.streaming = true;
    const period = this.framePeriod();
    imgs.forEach((img, index) => {
      // Stagger the start so the buffers stay evenly spaced rather than all
      // asking at once and then all idling together.
      this.timers[index] = window.setTimeout(
        () => this.pump(img, index),
        (period * index) / Math.max(1, imgs.length),
      );
    });
  }

  /** One buffer's loop: request a frame, show it if it is the newest, repeat. */
  private pump(img: HTMLImageElement, index: number): void {
    if (!this.streaming) return;

    // Dockview keeps a panel mounted when its tab is not the one showing, so
    // without this the camera is still asked for frames while nobody is
    // looking. offsetParent is null exactly when an ancestor is display:none.
    if (document.hidden || this.offsetParent === null) {
      this.timers[index] = window.setTimeout(() => this.pump(img, index), 1000);
      return;
    }

    const seq = ++this.seq;
    const started = Date.now();

    img.onload = () => {
      const wasStale = this.frameErrors >= FRAME_ERROR_LIMIT;
      this.frameErrors = 0;
      this.showFrame(img, seq);
      if (wasStale) this.requestUpdate();
      this.reschedule(img, index, started, false);
    };
    img.onerror = () => {
      // A dropped frame is not a failure — cameras hiccup, and retrying is
      // right. But retrying silently forever is how a black rectangle comes
      // to mean both "night" and "the camera died half an hour ago", so once
      // it is clearly not a hiccup, say so.
      this.frameErrors++;
      if (this.frameErrors === FRAME_ERROR_LIMIT) this.requestUpdate();
      this.reschedule(img, index, started, true);
    };
    img.src = this.frameUrl();
  }

  private reschedule(
    img: HTMLImageElement,
    index: number,
    started: number,
    failed: boolean,
  ): void {
    if (!this.streaming) return;
    const buffers = Math.max(1, this.imgs().length);
    // Each buffer only has to fire every buffers×period for the buffers
    // together to hit the asked-for rate.
    const target = failed
      ? Math.max(1000, this.framePeriod())
      : this.framePeriod() * buffers;
    const wait = Math.max(0, target - (Date.now() - started));
    this.timers[index] = window.setTimeout(() => this.pump(img, index), wait);
  }

  /**
   * Put a decoded frame on screen, unless a newer one already is.
   *
   * With several requests in flight they can finish out of order, and showing
   * a late arrival would jump the picture backwards in time.
   */
  private showFrame(img: HTMLImageElement, seq: number): void {
    if (seq < this.shownSeq) return;
    this.shownSeq = seq;
    for (const other of this.imgs()) other.classList.toggle('showing', other === img);

    const now = Date.now();
    this.frameTimes.push(now);
    if (this.frameTimes.length > 12) this.frameTimes.shift();
    const span = now - this.frameTimes[0];
    if (this.frameTimes.length > 2 && span > 0) {
      const rate = ((this.frameTimes.length - 1) * 1000) / span;
      // Only re-render when the readout would actually change.
      if (Math.abs(rate - this.measured) > 0.4) {
        this.measured = rate;
        this.requestUpdate();
      }
    }
  }

  private stopStream(): void {
    this.streaming = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const img of this.imgs()) img.onload = img.onerror = null;
  }

  protected override updated(): void {
    // The <img> pair only exists once a camera is live, so the stream cannot be
    // started before the first render that includes them.
    if (this.live && !this.streaming && !this.config.stream) this.startStream();
  }

  // --- Commands -----------------------------------------------------------

  /** Every control goes through here, so a blind-mode failure is still seen. */
  private async command(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.error = null;
    } catch (err) {
      this.error = `${what}: ${(err as Error).message}`;
    }
    this.requestUpdate();
  }

  private hold(op: PtzOp): void {
    void this.command('move', async () => {
      await this.client!.ptz(op, this.speed);
    });
  }

  private release(): void {
    void this.command('stop', async () => {
      await this.client!.stop();
    });
  }

  // --- Render -------------------------------------------------------------

  private renderSetup(): TemplateResult {
    const c = this.config;
    const generic = c.kind === 'generic';

    return html`
      <div class="cam-setup">
        <label class="param">
          <span class="param-label">Camera</span>
          <span class="param-input">
            <select
              @change=${(e: Event) => {
                this.config = { ...c, kind: (e.target as HTMLSelectElement).value as CameraConfig['kind'] };
                this.requestUpdate();
              }}
            >
              <option value="auto" ?selected=${c.kind === 'auto'}>Detect (Reolink)</option>
              <option value="reolink" ?selected=${c.kind === 'reolink'}>Reolink</option>
              <option value="generic" ?selected=${generic}>Other — image URL</option>
            </select>
          </span>
        </label>

        ${generic
          ? html`
              <label class="param wide">
                <span class="param-label">Image or MJPEG URL</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${c.imageUrl}
                    placeholder="http://camera/snapshot.jpg"
                    @change=${(e: Event) => (this.config = { ...c, imageUrl: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="check">
                <input
                  type="checkbox"
                  .checked=${c.stream}
                  @change=${(e: Event) => {
                    this.config = { ...c, stream: (e.target as HTMLInputElement).checked };
                    this.requestUpdate();
                  }}
                />
                It is a continuous MJPEG stream, not a still
              </label>
            `
          : html`
              <label class="param wide">
                <span class="param-label">Address</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${c.url}
                    placeholder="192.168.1.40"
                    @change=${(e: Event) => (this.config = { ...c, url: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="param">
                <span class="param-label">User</span>
                <span class="param-input">
                  <input
                    type="text"
                    .value=${this.creds.user}
                    @change=${(e: Event) => (this.creds = { ...this.creds, user: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="param">
                <span class="param-label">Password</span>
                <span class="param-input">
                  <input
                    type="password"
                    .value=${this.creds.password}
                    @change=${(e: Event) => (this.creds = { ...this.creds, password: (e.target as HTMLInputElement).value })}
                  />
                </span>
              </label>
              <label class="param">
                <span class="param-label">Quality</span>
                <span class="param-input">
                  <select
                    @change=${(e: Event) => (this.config = { ...c, quality: (e.target as HTMLSelectElement).value as 'sub' | 'main' })}
                  >
                    <option value="sub" ?selected=${c.quality === 'sub'}>Substream (light)</option>
                    <option value="main" ?selected=${c.quality === 'main'}>Full resolution</option>
                  </select>
                </span>
              </label>
            `}

        <label class="param">
          <span class="param-label">Frames / second</span>
          <span class="param-input">
            <select
              ?disabled=${c.stream}
              @change=${(e: Event) => {
                this.config = { ...c, fps: Number((e.target as HTMLSelectElement).value) };
                this.startStream();
              }}
            >
              ${FPS_CHOICES.map(
                (f) => html`<option value=${f.value} ?selected=${f.value === c.fps}>${f.label}</option>`,
              )}
            </select>
          </span>
        </label>

        <div class="cam-setup-actions">
          <button
            class="primary"
            ?disabled=${this.busy}
            @click=${() => {
              this.saveConfig();
              void this.start();
            }}
          >
            ${this.busy ? 'Looking…' : 'Connect'}
          </button>
          ${this.live
            ? html`<button class="ghost" @click=${() => ((this.showSetup = false), this.requestUpdate())}>
                Cancel
              </button>`
            : nothing}
        </div>

        <p class="hint cam-note">
          The password is kept on this device only — it is left out of the settings shared
          through the controller. A browser cannot play RTSP: if this camera only speaks
          RTSP, run go2rtc or MediaMTX in front of it and paste the MJPEG URL above.
        </p>
      </div>
    `;
  }

  private renderPad(): TemplateResult {
    return html`
      <div class="cam-pad">
        ${PAD.map((cell) =>
          cell
            ? html`
                <button
                  title=${cell.title}
                  @pointerdown=${() => this.hold(cell.op)}
                  @pointerup=${() => this.release()}
                  @pointerleave=${() => this.release()}
                  @pointercancel=${() => this.release()}
                  @contextmenu=${(e: Event) => e.preventDefault()}
                >
                  ${cell.label}
                </button>
              `
            : html`<button class="cam-stop" title="Stop moving" @click=${() => this.release()}>■</button>`,
        )}
      </div>
    `;
  }

  private renderControls(): TemplateResult | typeof nothing {
    const c = this.controls;
    if (!this.client) return nothing;
    const anyMode = c.irLights || c.spotlight || c.dayNight;

    return html`
      <div class="cam-controls">
        ${c.pan
          ? html`
              <div class="cam-motion">
                ${this.renderPad()}
                <div class="cam-motion-side">
                  <label class="cam-speed">
                    <span>Speed</span>
                    <input
                      type="range"
                      min="1"
                      max="64"
                      .value=${String(this.speed)}
                      @input=${(e: Event) => (this.speed = Number((e.target as HTMLInputElement).value))}
                    />
                  </label>
                  ${c.zoom
                    ? html`
                        <div class="cam-zoom">
                          <button
                            title="Zoom in"
                            @pointerdown=${() => this.hold('ZoomInc')}
                            @pointerup=${() => this.release()}
                            @pointerleave=${() => this.release()}
                          >
                            ＋
                          </button>
                          <button
                            title="Zoom out"
                            @pointerdown=${() => this.hold('ZoomDec')}
                            @pointerup=${() => this.release()}
                            @pointerleave=${() => this.release()}
                          >
                            －
                          </button>
                        </div>
                      `
                    : nothing}
                </div>
              </div>
            `
          : nothing}

        ${this.presets.length
          ? html`
              <div class="cam-presets">
                ${this.presets.map(
                  (p) => html`<button class="tiny" @click=${() => void this.command('preset', () => this.client!.goToPreset(p.id))}>
                    ${p.name}
                  </button>`,
                )}
              </div>
            `
          : c.presets && !this.probe?.readable
            ? html`
                <div class="cam-presets">
                  <span class="hint">Presets</span>
                  ${[1, 2, 3, 4].map(
                    (id) => html`<button class="tiny" title="Go to preset ${id}"
                      @click=${() => void this.command('preset', () => this.client!.goToPreset(id))}>
                      ${id}
                    </button>`,
                  )}
                </div>
              `
            : nothing}

        ${anyMode
          ? html`
              <div class="cam-modes">
                ${c.irLights
                  ? html`
                      <label class="check" title="Infrared illuminators, driven by the light sensor">
                        <input
                          type="checkbox"
                          .checked=${this.ir ?? true}
                          @change=${(e: Event) => {
                            const on = (e.target as HTMLInputElement).checked;
                            this.ir = on;
                            void this.command('IR lights', () => this.client!.setIrLights(on));
                          }}
                        />
                        IR
                      </label>
                    `
                  : nothing}
                ${c.spotlight
                  ? html`
                      <label class="cam-mode">
                        <span>Spotlight</span>
                        <select
                          @change=${(e: Event) => {
                            const mode = Number((e.target as HTMLSelectElement).value);
                            this.spotMode = mode;
                            void this.command('spotlight', () => this.client!.setSpotlight(mode, this.spotBright));
                          }}
                        >
                          ${SPOTLIGHT_MODES.map(
                            (m) => html`<option value=${m.value} ?selected=${m.value === this.spotMode}>
                              ${m.label}
                            </option>`,
                          )}
                        </select>
                        <input
                          type="range"
                          min="0"
                          max="100"
                          title="Brightness"
                          .value=${String(this.spotBright)}
                          @change=${(e: Event) => {
                            this.spotBright = Number((e.target as HTMLInputElement).value);
                            void this.command('spotlight', () =>
                              this.client!.setSpotlight(this.spotMode ?? 1, this.spotBright),
                            );
                          }}
                        />
                      </label>
                    `
                  : nothing}
                ${c.dayNight
                  ? html`
                      <label class="cam-mode">
                        <span>Image</span>
                        <select
                          @change=${(e: Event) => {
                            const value = (e.target as HTMLSelectElement).value;
                            this.dayNight = value;
                            void this.command('day/night', () => this.client!.setDayNight(value));
                          }}
                        >
                          ${DAY_NIGHT.map(
                            (d) => html`<option value=${d.value} ?selected=${d.value === this.dayNight}>
                              ${d.label}
                            </option>`,
                          )}
                        </select>
                      </label>
                    `
                  : nothing}
              </div>
            `
          : nothing}
      </div>
    `;
  }

  protected override render(): TemplateResult {
    const probe = this.probe;

    return html`
      <div class="cam-panel">
        <div class="cam-bar">
          <span class="cam-id">
            ${probe
              ? html`${probe.model ?? (probe.kind === 'reolink' ? 'Reolink' : 'Camera')}
                  ${probe.name ? html`· ${probe.name}` : nothing}`
              : 'No camera'}
          </span>
          ${probe && !probe.readable
            ? html`<span class="pill dim" title=${probe.note ?? ''}>blind</span>`
            : nothing}
          ${this.live && this.measured > 0 && !this.config.stream
            ? html`<span class="cam-fps" title="Frames per second actually arriving">
                ${this.measured.toFixed(1)} fps
              </span>`
            : nothing}
          <span class="topbar-spacer"></span>
          ${this.live
            ? html`<button class="tiny" title="Full-resolution still in a new tab"
                @click=${() =>
                  window.open(
                    this.config.kind === 'generic'
                      ? this.config.imageUrl
                      : snapshotUrl({ ...this.config, quality: 'main' }, this.creds, Date.now()),
                    '_blank',
                    'noopener',
                  )}>
                Still
              </button>`
            : nothing}
          <button
            class=${this.showSetup ? 'icon active' : 'icon'}
            title="Camera settings"
            @click=${() => ((this.showSetup = !this.showSetup), this.requestUpdate())}
          >
            ⚙
          </button>
        </div>

        ${this.error ? html`<div class="warn-banner">${this.error}</div>` : nothing}
        ${probe?.note && !this.showSetup ? html`<div class="cam-hint">${probe.note}</div>` : nothing}
        ${this.showSetup ? this.renderSetup() : nothing}

        <div class="cam-view ${this.live ? '' : 'idle'}">
          ${this.live
            ? html`
                <img class="cam-frame showing" alt="Camera" />
                <img class="cam-frame" alt="" />
                <img class="cam-frame" alt="" />
                ${this.frameErrors >= FRAME_ERROR_LIMIT
                  ? html`<span class="cam-stale">No frames from the camera</span>`
                  : nothing}
              `
            : html`<span class="hint">${this.busy ? 'Looking for the camera…' : 'Not connected'}</span>`}
        </div>

        ${this.live && !this.showSetup ? this.renderControls() : nothing}
        ${this.showSetup && this.config.kind !== 'generic' && this.config.url
          ? html`<p class="hint cam-rtsp">
              RTSP (for VLC or a bridge): <code>${rtspUrl(this.config, { ...this.creds, password: '•••' })}</code>
            </p>`
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-camera', CameraPanel);

registerPanel({
  id: 'camera',
  title: 'Camera',
  tag: 'cnc-camera',
  defaultWidth: 4,
  defaultHeight: 420,
  // Nothing here depends on the controller — a camera is worth watching most
  // when the machine is the thing that has stopped answering.
  available: () => true,
  description: 'Live view from an IP camera, with pan/tilt and lighting',
});
