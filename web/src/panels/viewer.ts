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
import { type ParsedToolpath } from '../viewer/parse.js';
import { parseAsync } from '../viewer/parse-client.js';
import { ToolpathRenderer, type Box, type Projection, type ViewName } from '../viewer/render.js';
import type { FileEntry } from '../machine/types.js';
import { theme, viewerPalette } from '../core/theme.js';
import { loadedProgram, previewProgram, resumePoint } from '../ui/program.js';
import {
  cursorAtOffset,
  cursorAtTime,
  programCursor,
  totalSeconds,
  type ProgramCursor,
} from '../viewer/cursor.js';
import { formatDuration } from '../core/util.js';
import { toolShape, type ToolShape } from '../tools/shape.js';
import { getTool, loadTools } from '../tools/table.js';

/**
 * Zoom per wheel event, as a fraction of the current distance.
 *
 * Deliberately per *event* rather than scaled by deltaY, so one mouse-wheel
 * notch is one predictable step. The cost is that a trackpad, which fires a
 * stream of small events for a single two-finger gesture, gets a full step from
 * each one — which is why this is a third of what feels right for a mouse.
 */
const ZOOM_STEP = 0.04;

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
  /** Null when idle; otherwise what is happening and how far along it is. */
  private progress: { phase: 'download' | 'parse'; value: number | null } | null = null;
  private error: string | null = null;
  private showRapids = true;
  private followJob = true;
  private showEnvelope = true;
  private showTool = loadSetting<boolean>('viewerShowTool', true);
  /** Built from the tool table; rebuilt only when the tool actually changes. */
  private toolShape: ToolShape | null = null;
  private toolShapeKey = '';
  private toolsStale = true;
  private projection: Projection = loadSetting<Projection>('viewerProjection', 'perspective');
  /** One-shot: frame the bed once, don't fight the user's camera afterwards. */
  private framedEnvelope = false;
  private files: FileEntry[] = [];
  private pickerOpen = false;
  /** When on, clicking the toolpath chooses a run-from-line point. */
  private pickMode = false;

  // --- Simulation ---------------------------------------------------------
  /** Playback multiplier; 0 means paused. */
  private playRate = 0;
  private playHandle: number | null = null;
  private lastFrameMs = 0;
  /**
   * True while the operator is driving the cursor by hand — scrubbing or
   * picking. A running job pushes the cursor too, and without this the two
   * would fight every poll: you would drag the slider and it would snap back
   * 250ms later.
   */
  private manualCursor = false;

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
      if (p) void this.showGenerated(p.name, p.gcode);
    });
    this.onDispose(() => {
      this.stopPlaying();
      this.teardown();
    });
  }

  protected override firstUpdated(): void {
    this.setupCanvas();
  }

  protected override updated(): void {
    // The canvas is recreated whenever we switch between the empty state and
    // the viewer, so re-bind if it changed.
    const canvas = this.querySelector('canvas');
    if (canvas && canvas !== this.canvas) this.setupCanvas();
    // The tool table is localStorage, with no signal behind it, and the draw
    // loop runs at 60fps — so it is re-read here instead, at the machine
    // signal's rate. An edit in the Spindle panel shows up within a poll.
    this.toolsStale = true;
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
      if (this.pickMode && e.button === 0 && this.path && this.renderer) {
        const r = canvas.getBoundingClientRect();
        const hit = this.renderer.pickNearest(e.clientX - r.left, e.clientY - r.top, this.path);
        if (hit) {
          resumePoint.set(hit);
          this.renderer.resumeMarker = hit.point;
          // Picking is a cursor move as much as a run-from-line choice, so the
          // slider and the simulation follow the click rather than sitting
          // somewhere else showing a different moment in the same program.
          this.stopPlaying();
          this.manualCursor = true;
          this.setCursor(cursorAtOffset(this.path, hit.offset, this.rapidRate, 'pick'));
        }
        return;
      }
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
        cam.distance = Math.max(
          1,
          Math.min(100000, cam.distance * (1 + Math.sign(e.deltaY) * ZOOM_STEP)),
        );
      },
      { passive: false },
    );
  }

  private clearResumePoint(): void {
    resumePoint.set(null);
    this.followLive();
    if (this.renderer) this.renderer.resumeMarker = null;
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

    // Map the job's byte offset onto the toolpath's source offsets — unless the
    // operator has taken the cursor by scrubbing or picking, in which case the
    // job would drag it back on the next poll.
    const job = state.job;
    const live =
      this.followJob && job?.filePosition != null && this.loadedFrom === job.fileName;
    if (live && !this.manualCursor && this.path) {
      const cursor = cursorAtOffset(this.path, job!.filePosition!, this.rapidRate, 'job');
      programCursor.set(cursor);
      r.progress = job!.filePosition!;
    } else if (!this.manualCursor && !live) {
      programCursor.set(null);
      r.progress = -1;
    } else {
      r.progress = programCursor.peek()?.offset ?? -1;
    }

    const cutter = this.cutterPoint();

    r.setOverlay(
      cutter,
      this.path ? { min: this.path.min, max: this.path.max } : null,
      this.showEnvelope ? this.machineEnvelope() : null,
      this.activeToolShape(),
    );
    r.render();
  }

  /** Where the tool tip is, in work coordinates. */
  private cutterPoint(): [number, number, number] | null {
    const axes = machine.peek().axes;
    const at = (letter: string) => axes.find((a) => a.letter === letter);
    // While scrubbing, the crosshair belongs on the simulated point rather than
    // on the real spindle — the whole purpose is to look somewhere the machine
    // isn't.
    if (this.manualCursor) {
      const point = programCursor.peek()?.point ?? null;
      if (point) return point;
    }
    const [x, y, z] = [at('X'), at('Y'), at('Z')];
    return x && y && z ? [x.work, y.work, z.work] : null;
  }

  /**
   * Point the camera at the cutter, close enough to see its shape.
   *
   * Needed because the tool is drawn at true size and the bed is 1500mm long:
   * framed on the whole envelope a 6mm cutter is three pixels wide, which
   * looks exactly like the feature not working. One button gets there.
   */
  private frameCutter(): void {
    const r = this.renderer;
    const cutter = this.cutterPoint();
    if (!r || !cutter) return;
    const shape = this.activeToolShape();
    const span = shape ? Math.max(shape.height, shape.radius * 4, 10) : 40;
    // Aimed a little up the shank rather than at the tip, so the tool sits in
    // the middle of the view instead of hanging off the top of it.
    r.camera.target = [cutter[0], cutter[1], cutter[2] + span * 0.35];
    r.camera.distance = span * 2.2;
  }

  /**
   * Why no cutter is drawn, when one was asked for.
   *
   * Without this the checkbox is ticked, nothing appears, and the only
   * available conclusion is that it is broken — when the real answer is
   * usually that the tool has no diameter in the library that is loaded.
   */
  private toolMissingReason(): string | null {
    if (!this.showTool || !connected.get()) return null;
    const tool = machine.get().tool;
    if (!tool) return 'no tool loaded';
    if (this.activeToolShape()) return null;
    return `T${tool.number} has no diameter`;
  }

  /**
   * The cutter currently in the spindle, as a wireframe.
   *
   * Only ever the *active* tool. A program's tool changes are not simulated —
   * the cursor knows where the cutter is, not what it is — and drawing a
   * confidently wrong cutter is worse than drawing none, because clearance is
   * exactly what an operator would be using it to judge.
   */
  private activeToolShape(): ToolShape | null {
    if (!this.showTool) return null;
    const number = machine.peek().tool?.number ?? null;
    if (number == null) {
      this.toolShapeKey = '';
      return (this.toolShape = null);
    }

    if (this.toolsStale || !this.toolShapeKey.startsWith(`${number}|`)) {
      this.toolsStale = false;
      const info = getTool(loadTools(), number);
      const key = `${number}|${info.diameter}|${info.type}|${JSON.stringify(info.geometry ?? null)}`;
      if (key !== this.toolShapeKey) {
        this.toolShapeKey = key;
        this.toolShape = toolShape(info);
      }
    }
    return this.toolShape;
  }

  // --- Program cursor -----------------------------------------------------

  /**
   * How fast this machine rapids, mm/min.
   *
   * The parser leaves rapids untimed on purpose, so the estimate is only as
   * good as this. The slowest of X/Y/Z is the honest answer for a three-axis
   * rapid; with nothing connected, a figure that at least keeps the slider
   * usable rather than making every rapid instantaneous.
   */
  private get rapidRate(): number {
    const axes = machine
      .peek()
      .axes.filter((a) => ['X', 'Y', 'Z'].includes(a.letter) && a.maxFeed > 0);
    return axes.length ? Math.min(...axes.map((a) => a.maxFeed)) : 3000;
  }

  private get duration(): number {
    return this.path ? totalSeconds(this.path, this.rapidRate) : 0;
  }

  private setCursor(cursor: ProgramCursor | null): void {
    programCursor.set(cursor);
    if (this.renderer) this.renderer.progress = cursor ? cursor.offset : -1;
    this.requestUpdate();
  }

  /** Scrub to a time. Stops following the job — you asked to look elsewhere. */
  private scrubTo(seconds: number): void {
    if (!this.path) return;
    this.manualCursor = true;
    this.setCursor(cursorAtTime(this.path, seconds, this.rapidRate, 'scrub'));
  }

  /**
   * Commit the scrub as a run-from-line point.
   *
   * Split from scrubTo because the two events mean different things: `input`
   * fires continuously while dragging and only previews, `change` fires on
   * release and is a decision. Updating the resume point on every `input` frame
   * would make the run-from-line panel recompute modal state — a walk of the
   * whole file — sixty times a second, and smear the marker across the path
   * while doing it. Playback never commits at all: watching a simulation is not
   * choosing where to restart.
   */
  private commitScrub(): void {
    const cursor = programCursor.peek();
    if (!cursor || !this.renderer) return;
    resumePoint.set({ offset: cursor.offset, point: cursor.point });
    this.renderer.resumeMarker = cursor.point;
    this.requestUpdate();
  }

  private setPlayRate(rate: number): void {
    this.playRate = rate;
    if (rate > 0) {
      this.manualCursor = true;
      // Start from the beginning if the cursor is parked at the end, so the
      // play button never looks broken.
      if (!programCursor.peek() || programCursor.peek()!.seconds >= this.duration - 1e-3) {
        this.scrubTo(0);
      }
      this.lastFrameMs = performance.now();
      if (this.playHandle === null) this.playHandle = requestAnimationFrame(this.step);
    } else {
      this.stopPlaying();
    }
    this.requestUpdate();
  }

  private stopPlaying(): void {
    this.playRate = 0;
    if (this.playHandle !== null) cancelAnimationFrame(this.playHandle);
    this.playHandle = null;
  }

  /**
   * Advance by wall-clock time, not by a fixed step per frame.
   *
   * A frame-counted simulation runs at whatever rate the browser feels like,
   * so it plays at a different speed on a laptop that is throttling — and "4×"
   * would mean nothing.
   */
  private step = (now: number): void => {
    this.playHandle = null;
    if (this.playRate <= 0 || !this.path) return;

    const dt = Math.min((now - this.lastFrameMs) / 1000, 0.25);
    this.lastFrameMs = now;
    const next = (programCursor.peek()?.seconds ?? 0) + dt * this.playRate;

    if (next >= this.duration) {
      this.setCursor(cursorAtTime(this.path, this.duration, this.rapidRate, 'scrub'));
      this.stopPlaying();
      this.requestUpdate();
      return;
    }
    this.setCursor(cursorAtTime(this.path, next, this.rapidRate, 'scrub'));
    this.playHandle = requestAnimationFrame(this.step);
  };

  /** Hand the cursor back to the running job. */
  private followLive(): void {
    this.stopPlaying();
    this.manualCursor = false;
    this.requestUpdate();
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

    this.progress = { phase: 'download', value: 0 };
    this.requestUpdate();

    const bytes = await run(`load ${entry.name}`, (d) =>
      d.readFile(entry.path, (loaded, total) => {
        this.progress = { phase: 'download', value: total ? loaded / total : null };
        this.requestUpdate();
      }),
    );
    if (!bytes) {
      this.progress = null;
      this.requestUpdate();
      return;
    }

    try {
      this.progress = { phase: 'parse', value: 0 };
      this.requestUpdate();
      const parsed = await parseAsync(new TextDecoder().decode(bytes), (value) => {
        this.progress = { phase: 'parse', value };
        this.requestUpdate();
      });
      cache.set(entry.path, parsed);
      this.applyToolpath(entry.path, parsed);
    } catch (err) {
      this.error = `parse failed: ${(err as Error).message}`;
    } finally {
      this.progress = null;
      this.requestUpdate();
    }
  }

  /** Render a program that exists only in the browser, before it is uploaded. */
  private async showGenerated(name: string, gcode: string): Promise<void> {
    try {
      const parsed = await parseAsync(gcode);
      this.error = parsed.positions.length ? null : 'Generated program contains no motion';
      // Deliberately not cached by path — a generated program changes every time
      // a parameter moves, and it has no file on the controller yet.
      this.path = parsed;
      this.loadedFrom = `(generated) ${name}`;
      loadedProgram.set({ name, controllerPath: null, path: parsed });
      this.clearResumePoint();
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
    loadedProgram.set({ name: path, controllerPath: path, path: parsed });
    // A resume point belongs to one file; carrying it across would resume at a
    // byte offset that means something entirely different in another program.
    this.clearResumePoint();
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

  /**
   * Scrub bar, play controls and the readout.
   *
   * Deliberately one row and always visible when a program is loaded: this is
   * the control that answers "what does this file actually do", and burying it
   * behind a toggle means it never gets used.
   */
  private renderTransport(): TemplateResult | typeof nothing {
    if (!this.path) return nothing;
    const total = this.duration;
    const cursor = programCursor.get();
    const at = cursor?.seconds ?? 0;
    const playing = this.playRate > 0;

    return html`
      <div class="viewer-transport">
        <button
          class="seg play"
          title=${playing ? 'Pause' : 'Play the toolpath'}
          @click=${() => this.setPlayRate(playing ? 0 : 1)}
        >
          ${playing ? '❚❚' : '▶'}
        </button>
        <input
          class="transport-slider"
          type="range"
          min="0"
          max=${Math.max(total, 0.001)}
          step="0.001"
          .value=${String(at)}
          @input=${(e: Event) => this.scrubTo(Number((e.target as HTMLInputElement).value))}
          @change=${() => this.commitScrub()}
        />
        <span class="transport-time" style="--time-width:${formatDuration(total).length}ch">
          <strong>${formatDuration(at)}</strong>/${formatDuration(total)}
        </span>
        <div class="segmented transport-rates">
          ${[1, 4, 16, 64].map(
            (r) => html`
              <button
                class=${playing && this.playRate === r ? 'seg active' : 'seg'}
                title="Play at ${r}x"
                @click=${() => this.setPlayRate(r)}
              >
                ${r}×
              </button>
            `,
          )}
        </div>
        ${cursor
          ? html`<span class="transport-where" title="Source byte offset ${cursor.offset}">
              ${['X', 'Y', 'Z']
                .map((axis, i) => `${axis}${cursor.point[i].toFixed(1).padStart(7)}`)
                .join(' ')}
              <em>${cursor.source === 'job' ? 'live' : cursor.source}</em>
            </span>`
          : nothing}
        ${this.manualCursor
          ? html`<button
              class="tiny"
              title="Stop scrubbing and follow the running job again"
              @click=${() => this.followLive()}
            >
              Follow job
            </button>`
          : nothing}
      </div>
    `;
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
          <label class="check" title="Draw the cutter in the spindle at its tip">
            <input
              type="checkbox"
              .checked=${this.showTool}
              @change=${(e: Event) => {
                this.showTool = (e.target as HTMLInputElement).checked;
                saveSetting('viewerShowTool', this.showTool);
              }}
            />
            Tool
          </label>
          ${this.toolMissingReason()
            ? html`<em class="hint tool-missing">${this.toolMissingReason()}</em>`
            : nothing}
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
          ${this.renderer?.backend === 'webgl'
            ? html`<span
                class="pill dim"
                title="Drawing with WebGL 1 — this browser has no WebGL 2. Same picture, older pipeline."
                >GL1</span
              >`
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
            class="seg"
            title="Zoom in on the cutter, which is a few pixels wide when the whole bed is in view"
            ?disabled=${!connected.get()}
            @click=${() => this.frameCutter()}
          >
            Cutter
          </button>
          <button
            class=${this.pickMode ? 'seg active' : 'seg'}
            title="Click the toolpath to choose a run-from-line point"
            ?disabled=${!this.path}
            @click=${() => ((this.pickMode = !this.pickMode), this.requestUpdate())}
          >
            Pick
          </button>
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

        ${this.renderTransport()}

        <div class="viewer-canvas-wrap">
          <canvas></canvas>
          ${this.progress
            ? html`
                <div class="viewer-overlay">
                  <div class="load-box">
                    <span class="load-label">
                      ${this.progress.phase === 'download' ? 'Downloading' : 'Parsing'}
                      ${this.progress.value != null
                        ? html`<em>${Math.round(this.progress.value * 100)}%</em>`
                        : nothing}
                    </span>
                    <div class="load-track">
                      <div
                        class="load-fill ${this.progress.value == null ? 'indeterminate' : ''}"
                        style=${this.progress.value != null
                          ? `width:${Math.round(this.progress.value * 100)}%`
                          : ''}
                      ></div>
                    </div>
                  </div>
                </div>
              `
            : nothing}
          ${!this.path && !this.progress
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
