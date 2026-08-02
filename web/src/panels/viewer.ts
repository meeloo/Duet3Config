// Toolpath viewer with live cutter tracking.
//
// The live position works by mapping `job.filePosition` — a byte offset — onto
// the per-vertex source offsets recorded by the parser. That is why the parser
// carries offsets around, and it is the piece a printer-oriented layer viewer
// fundamentally cannot give you.
//
// Files are parsed once and cached in memory by path. Pulling a large 3D-carve
// program back off the controller's SD card is slow, so re-parsing on every
// panel re-render would be painful; the cache also means switching files back
// and forth is instant.

import { html, nothing, type TemplateResult } from 'lit';
import { PanelElement, registerPanel } from '../ui/panel.js';
import { activeDriver, capabilities, connected, loadSetting, machine, run, saveSetting } from '../core/store.js';
import { basename, formatBytes } from '../core/util.js';
import { parseGcode, type ParsedToolpath } from '../viewer/parse.js';
import { ToolpathRenderer, type Box, type Projection, type ViewName } from '../viewer/render.js';
import type { FileEntry } from '../machine/types.js';
import { theme, viewerPalette } from '../core/theme.js';
import { previewProgram } from '../ui/program.js';

const cache = new Map<string, ParsedToolpath>();
/** Refuse to pull anything past this over the controller's HTTP server. */
const MAX_FETCH_BYTES = 64 * 1024 * 1024;

export class ViewerPanel extends PanelElement {
  private canvas: HTMLCanvasElement | null = null;
  private renderer: ToolpathRenderer | null = null;
  private raf = 0;
  private resizeObserver: ResizeObserver | null = null;

  private path: ParsedToolpath | null = null;
  private loadedFrom: string | null = null;
  private loading = false;
  private error: string | null = null;
  private showRapids = true;
  private followJob = true;
  private showEnvelope = true;
  private projection: Projection = loadSetting<Projection>('viewerProjection', 'perspective');
  /** One-shot: frame the bed once, don't fight the user's camera afterwards. */
  private framedEnvelope = false;
  private files: FileEntry[] = [];
  private pickerOpen = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.bind(() => {
      connected.get();
      capabilities.get();
      machine.get();
    });
    // Recolour the GL view when the theme changes — it can't read CSS variables.
    this.bind(() => {
      const t = theme.get();
      if (this.renderer) this.renderer.palette = viewerPalette(t);
    });
    // The probing and machining packs push generated programs here to be looked
    // at before they are written to the controller.
    this.bind(() => {
      const p = previewProgram.get();
      if (p) this.showGenerated(p.name, p.gcode);
    });
    this.onDispose(() => this.teardown());
  }

  protected override firstUpdated(): void {
    this.setupCanvas();
  }

  protected override updated(): void {
    // The canvas is recreated whenever we switch between the empty state and
    // the viewer, so re-bind if it changed.
    const canvas = this.querySelector('canvas');
    if (canvas && canvas !== this.canvas) this.setupCanvas();
  }

  private setupCanvas(): void {
    const canvas = this.querySelector('canvas') as HTMLCanvasElement | null;
    if (!canvas) return;
    this.teardown();
    this.canvas = canvas;

    try {
      this.renderer = new ToolpathRenderer(canvas);
      this.renderer.palette = viewerPalette(theme.peek());
      this.renderer.projection = this.projection;
    } catch (err) {
      this.error = (err as Error).message;
      this.requestUpdate();
      return;
    }

    if (this.path) this.renderer.setToolpath(this.path);
    this.attachControls(canvas);

    this.resizeObserver = new ResizeObserver(() => this.renderer?.resize());
    this.resizeObserver.observe(canvas);

    const loop = () => {
      this.drawFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private teardown(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.renderer?.dispose();
    this.renderer = null;
    this.canvas = null;
  }

  /** Orbit / pan / zoom. ~50 lines, which is why three.js isn't here. */
  private attachControls(canvas: HTMLCanvasElement): void {
    let dragging: 'orbit' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = e.button === 2 || e.shiftKey ? 'pan' : 'orbit';
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging || !this.renderer) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const cam = this.renderer.camera;

      if (dragging === 'orbit') {
        cam.azimuth -= dx * 0.008;
        cam.elevation = Math.max(
          -Math.PI / 2 + 0.05,
          Math.min(Math.PI / 2 - 0.05, cam.elevation + dy * 0.008),
        );
      } else {
        // Pan in the camera's screen plane, scaled so it tracks the pointer.
        const scale = cam.distance * 0.0015;
        const sinA = Math.sin(cam.azimuth);
        const cosA = Math.cos(cam.azimuth);
        cam.target[0] += (dx * sinA - dy * cosA * Math.sin(cam.elevation)) * scale;
        cam.target[1] += (-dx * cosA - dy * sinA * Math.sin(cam.elevation)) * scale;
        cam.target[2] += dy * Math.cos(cam.elevation) * scale;
      }
    });

    const end = (e: PointerEvent) => {
      dragging = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.renderer) return;
        e.preventDefault();
        const cam = this.renderer.camera;
        cam.distance = Math.max(1, Math.min(100000, cam.distance * (1 + Math.sign(e.deltaY) * 0.12)));
      },
      { passive: false },
    );
  }

  private setView(name: ViewName): void {
    this.renderer?.setView(name);
    // Home also re-frames, since it is the "put it back how it was" button.
    if (name === 'home') this.fit();
    this.requestUpdate();
  }

  private toggleProjection(): void {
    this.projection = this.projection === 'ortho' ? 'perspective' : 'ortho';
    if (this.renderer) this.renderer.projection = this.projection;
    saveSetting('viewerProjection', this.projection);
    this.requestUpdate();
  }

  /** Frame the toolpath if one is loaded, otherwise the machine bed. */
  private fit(): void {
    const box = this.path ? { min: this.path.min, max: this.path.max } : this.machineEnvelope();
    if (box) this.renderer?.frame(box);
  }

  private drawFrame(): void {
    const r = this.renderer;
    if (!r) return;

    // With no file open, frame the bed once the envelope becomes known so the
    // panel shows the machine rather than an empty void.
    if (!this.path && !this.framedEnvelope) {
      const env = this.machineEnvelope();
      if (env) {
        r.frame(env);
        this.framedEnvelope = true;
      }
    }

    const state = machine.peek();
    r.showRapids = this.showRapids;

    // Map the job's byte offset onto the toolpath's source offsets.
    const job = state.job;
    r.progress =
      this.followJob && job?.filePosition != null && this.loadedFrom === job.fileName
        ? job.filePosition
        : -1;

    const visible = state.axes.filter((a) => ['X', 'Y', 'Z'].includes(a.letter));
    const cutter: [number, number, number] | null =
      visible.length >= 3
        ? [
            visible.find((a) => a.letter === 'X')!.work,
            visible.find((a) => a.letter === 'Y')!.work,
            visible.find((a) => a.letter === 'Z')!.work,
          ]
        : null;

    r.setOverlay(
      cutter,
      this.path ? { min: this.path.min, max: this.path.max } : null,
      this.showEnvelope ? this.machineEnvelope() : null,
    );
    r.render();
  }

  /**
   * The machine's travel limits, expressed in WORK coordinates.
   *
   * The controller reports axis min/max in machine coordinates, but the
   * toolpath — and everything else drawn here — is in work coordinates. The
   * offset between them is whatever the active WCS is set to, which we can read
   * straight off the axis rather than digging through workplaceOffsets:
   * offset = machinePosition - userPosition.
   */
  private machineEnvelope(): Box | null {
    const axes = machine.peek().axes;
    const get = (letter: string) => axes.find((a) => a.letter === letter);
    const x = get('X');
    const y = get('Y');
    const z = get('Z');
    if (!x || !y || !z) return null;

    const toWork = (a: NonNullable<ReturnType<typeof get>>, v: number) =>
      v - (a.machine - a.work);

    // A machine that has never been homed still reports its configured limits,
    // so this is useful before homing too.
    if (x.max === x.min || y.max === y.min) return null;

    return {
      min: [toWork(x, x.min), toWork(y, y.min), toWork(z, z.min)],
      max: [toWork(x, x.max), toWork(y, y.max), toWork(z, z.max)],
    };
  }

  // --- Loading -----------------------------------------------------------

  private async openPicker(): Promise<void> {
    this.pickerOpen = !this.pickerOpen;
    this.requestUpdate();
    if (!this.pickerOpen) return;

    const driver = activeDriver();
    if (!driver) return;
    const root = capabilities.peek().gcodeRoot;
    const entries = await run('list G-code', (d) => d.listFiles(root));
    this.files = (entries ?? []).filter((e) => !e.directory && /\.(g|gcode|nc|tap)$/i.test(e.name));
    this.requestUpdate();
  }

  private async loadFile(entry: FileEntry): Promise<void> {
    this.pickerOpen = false;
    this.error = null;

    if (entry.size > MAX_FETCH_BYTES) {
      this.error = `${entry.name} is ${formatBytes(entry.size)} — too large to fetch over HTTP`;
      this.requestUpdate();
      return;
    }

    const cached = cache.get(entry.path);
    if (cached) {
      this.applyToolpath(entry.path, cached);
      return;
    }

    this.loading = true;
    this.requestUpdate();

    const bytes = await run(`load ${entry.name}`, (d) => d.readFile(entry.path));
    if (!bytes) {
      this.loading = false;
      this.requestUpdate();
      return;
    }

    try {
      const parsed = parseGcode(new TextDecoder().decode(bytes));
      cache.set(entry.path, parsed);
      this.applyToolpath(entry.path, parsed);
    } catch (err) {
      this.error = `parse failed: ${(err as Error).message}`;
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  /** Render a program that exists only in the browser, before it is uploaded. */
  private showGenerated(name: string, gcode: string): void {
    try {
      const parsed = parseGcode(gcode);
      this.error = parsed.positions.length ? null : 'Generated program contains no motion';
      // Deliberately not cached by path — a generated program changes every time
      // a parameter moves, and it has no file on the controller yet.
      this.path = parsed;
      this.loadedFrom = `(generated) ${name}`;
      this.renderer?.setToolpath(parsed);
      this.requestUpdate();
    } catch (err) {
      this.error = `preview failed: ${(err as Error).message}`;
      this.requestUpdate();
    }
  }

  private applyToolpath(path: string, parsed: ParsedToolpath): void {
    this.path = parsed;
    this.loadedFrom = path;
    this.renderer?.setToolpath(parsed);
    this.requestUpdate();
  }

  /** Load whatever the machine is currently running. */
  private async loadRunningJob(): Promise<void> {
    const job = machine.peek().job;
    if (!job?.fileName) return;
    await this.loadFile({
      name: basename(job.fileName),
      path: job.fileName,
      directory: false,
      size: job.fileSize ?? 0,
      modified: null,
    });
  }

  protected override render(): TemplateResult {
    const caps = capabilities.get();
    const state = machine.get();
    const job = state.job;
    const jobLoaded = job?.fileName && this.loadedFrom === job.fileName;

    return html`
      <div class="viewer">
        <div class="viewer-bar">
          ${caps.files
            ? html`<button class="tiny" @click=${() => void this.openPicker()}>Open…</button>`
            : nothing}
          ${job?.fileName && !jobLoaded
            ? html`<button class="tiny highlight" @click=${() => void this.loadRunningJob()}>
                Load running job
              </button>`
            : nothing}
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.showRapids}
              @change=${(e: Event) => {
                this.showRapids = (e.target as HTMLInputElement).checked;
              }}
            />
            Rapids
          </label>
          <label class="check">
            <input
              type="checkbox"
              .checked=${this.showEnvelope}
              @change=${(e: Event) => {
                this.showEnvelope = (e.target as HTMLInputElement).checked;
              }}
            />
            Envelope
          </label>
          ${caps.jobFilePosition
            ? html`
                <label class="check">
                  <input
                    type="checkbox"
                    .checked=${this.followJob}
                    @change=${(e: Event) => {
                      this.followJob = (e.target as HTMLInputElement).checked;
                    }}
                  />
                  Track job
                </label>
              `
            : nothing}
          <span class="viewer-file" title=${this.loadedFrom ?? ''}>
            ${this.loadedFrom ? basename(this.loadedFrom) : 'no file'}
          </span>
          ${this.path
            ? html`<span class="hint"
                >${(this.path.positions.length / 6).toLocaleString()} segs</span
              >`
            : nothing}
          ${this.renderer && (this.path || this.machineEnvelope())
            ? html`<button class="tiny" title="Frame the toolpath, or the bed if none is loaded"
                @click=${() => this.fit()}>Fit</button>`
            : nothing}
        </div>

        <div class="viewer-views">
          ${(
            [
              ['home', 'Home', 'Default shallow view down the bed'],
              ['top', 'Top', 'Look straight down'],
              ['front', 'Front', 'Look along +Y'],
              ['back', 'Back', 'Look along −Y'],
              ['left', 'Left', 'Look along +X'],
              ['right', 'Right', 'Look along −X'],
              ['iso', 'Iso', 'True isometric'],
            ] as Array<[ViewName, string, string]>
          ).map(
            ([name, label, title]) => html`
              <button class="seg" title=${title} @click=${() => this.setView(name)}>${label}</button>
            `,
          )}
          <button
            class="seg proj"
            title=${this.projection === 'ortho'
              ? 'Orthographic — parallel edges stay parallel, true for measuring'
              : 'Perspective — reads better for shape'}
            @click=${() => this.toggleProjection()}
          >
            ${this.projection === 'ortho' ? 'Ortho' : 'Persp'}
          </button>
        </div>

        ${this.error ? html`<div class="viewer-error">${this.error}</div>` : nothing}
        ${this.path?.warnings.length
          ? html`<div class="viewer-warn">${this.path.warnings.slice(0, 3).join(' · ')}</div>`
          : nothing}

        <div class="viewer-canvas-wrap">
          <canvas></canvas>
          ${this.loading ? html`<div class="viewer-overlay">Loading and parsing…</div>` : nothing}
          ${!this.path && !this.loading
            ? html`<div class="viewer-overlay">
                ${connected.get() ? 'Open a G-code file to view its toolpath' : 'Not connected'}
              </div>`
            : nothing}
        </div>

        ${this.pickerOpen
          ? html`
              <div class="viewer-picker">
                ${this.files.length
                  ? this.files.map(
                      (f) => html`
                        <button class="picker-item" @click=${() => void this.loadFile(f)}>
                          <strong>${f.name}</strong><small>${formatBytes(f.size)}</small>
                        </button>
                      `,
                    )
                  : html`<div class="empty">No G-code files in ${caps.gcodeRoot}</div>`}
              </div>
            `
          : nothing}
      </div>
    `;
  }
}

customElements.define('cnc-viewer', ViewerPanel);

registerPanel({
  id: 'viewer',
  title: 'Toolpath',
  tag: 'cnc-viewer',
  defaultWidth: 8,
  defaultHeight: 460,
  description: 'G-code toolpath with live cutter position',
});
