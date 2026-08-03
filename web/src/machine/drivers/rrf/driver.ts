// RepRapFirmware driver — maps the object model onto the neutral machine model.

import type { ConnectionConfig, JogOptions, MachineDriver } from '../../driver.js';
import {
  defaultCapabilities,
  emptyMachineState,
  type Axis,
  type Capabilities,
  type DiagnosticItem,
  type DiagnosticSection,
  type FileEntry,
  type LogLine,
  type MachineState,
} from '../../types.js';
import { RrfClient, SessionLostError } from './client.js';
import { mergeInto } from './merge.js';
import {
  TRACKED_KEYS,
  expandAxisControls,
  mapPromptMode,
  mapSpindleState,
  mapStatus,
  type ObjectModel,
  type OmRange,
  type OmSeqs,
} from './om.js';
import { formatBytes, formatDuration, joinPath } from '../../../core/util.js';

/** Exposed through `driver.native` for the object-model browser panel. */
export interface RrfNative {
  getModel(): ObjectModel;
  /** Fetch a subtree on demand, e.g. "sensors.probes". */
  fetchKey(key: string): Promise<unknown>;
  client(): RrfClient;
}

const POLL_INTERVAL_MS = 250;
/** Back off to this while the machine is idle to spare the board's sockets. */
const IDLE_POLL_INTERVAL_MS = 500;

export class RrfDriver implements MachineDriver {
  readonly id = 'rrf';
  readonly label = 'RepRapFirmware (Duet)';

  readonly capabilities: Capabilities = {
    ...defaultCapabilities(),
    objectModel: true,
    files: true,
    fileWrite: true,
    macros: true,
    workCoordinateSystems: 9,
    // G68/G69, XY plane only. Experimental in RRF but present since 3.4, and
    // 3.6.1 fixed the direction to anticlockwise as the standard requires.
    coordinateRotation: true,
    // M557 + G29; the K parameter is what keeps it off the tool setter.
    surfaceMap: true,
    jobFilePosition: true,
    toolChanger: true,
    prompts: true,
    gcodeRoot: '/gcodes',
    configRoot: '/sys',
    macroRoot: '/macros',
  };

  private client: RrfClient | null = null;
  private model: ObjectModel = {};
  private seqs: OmSeqs = {};
  private state: MachineState = emptyMachineState();
  private stateSubs = new Set<(s: MachineState) => void>();
  private logSubs = new Set<(l: LogLine) => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = true;
  private config: ConnectionConfig | null = null;
  private consecutiveFailures = 0;

  readonly native: RrfNative = {
    getModel: () => this.model,
    fetchKey: async (key: string) => {
      if (!this.client) throw new Error('not connected');
      return this.client.model(key, 'd99vn');
    },
    client: () => {
      if (!this.client) throw new Error('not connected');
      return this.client;
    },
  };

  // --- Lifecycle ---------------------------------------------------------

  async connect(config: ConnectionConfig): Promise<void> {
    await this.disconnect();
    this.config = config;
    this.stopped = false;
    this.client = new RrfClient(config.url);
    this.client.signal = config.signal ?? null;

    this.patchState({ status: 'connecting' });
    const info = await this.client.connect(config.password ?? '');
    this.log('info', `connected to ${info.boardType}${info.sessionKey != null ? '' : ' (legacy session)'}`);

    await this.seedModel();
    this.rebuildState();

    this.schedule(0);
  }

  /**
   * Seed the cached model, one top-level key at a time.
   *
   * Emphatically NOT `rr_model?flags=d99vn` with an empty key. That asks the
   * board to serialise its entire object model, verbose, nulls included, to
   * unlimited depth — by far the largest response it can be made to produce, and
   * on a machine with nine tools and four axes it is big enough that the board
   * can fail to deliver it at all. (The firmware gained an `p` flag specifically
   * to shorten responses, which is the same problem viewed from the other end.)
   *
   * Fetching per key is also what the documented seqs-driven pattern expects,
   * and it degrades gracefully: one key the firmware chokes on costs us that
   * subtree, not the whole connection.
   */
  private async seedModel(): Promise<void> {
    const client = this.requireClient();
    this.model = {};

    const seqs = (await client.model('seqs', 'd99vn')) as OmSeqs;
    this.seqs = { ...(seqs ?? {}) };

    for (const key of TRACKED_KEYS) {
      try {
        const subtree = await client.model(key, 'd99vn');
        this.model = mergeInto(this.model, { [key]: subtree });
      } catch (err) {
        // A missing or oversized key must not abort the connection.
        this.log('warning', `could not read ${key}: ${(err as Error).message}`);
      }
    }
    this.model = mergeInto(this.model, { seqs: this.seqs });
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const c = this.client;
    this.client = null;
    this.model = {};
    this.seqs = {};
    if (c) {
      try {
        await c.disconnect();
      } catch {
        // Best effort — the board may already have dropped us.
      }
    }
    this.patchState({ ...emptyMachineState() });
  }

  onState(cb: (s: MachineState) => void): () => void {
    this.stateSubs.add(cb);
    cb(this.state);
    return () => this.stateSubs.delete(cb);
  }

  onLog(cb: (l: LogLine) => void): () => void {
    this.logSubs.add(cb);
    return () => this.logSubs.delete(cb);
  }

  // --- Poll loop ---------------------------------------------------------

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.client) return;
    this.polling = true;

    try {
      // 1. One cheap request for the live subset of the whole tree, plus seqs.
      const live = (await this.client.model('', 'd99fn')) as ObjectModel;
      this.model = mergeInto(this.model, live);

      // 2. Re-fetch in full only the subtrees whose sequence number moved.
      const next = (live.seqs ?? {}) as OmSeqs;
      const changed = TRACKED_KEYS.filter((k) => next[k] !== undefined && next[k] !== this.seqs[k]);

      for (const key of changed) {
        const subtree = await this.client.model(key, 'd99vn');
        this.model = mergeInto(this.model, { [key]: subtree });
        this.seqs[key] = next[key];
      }

      // 3. seqs.reply advancing means buffered console output is waiting.
      if (next.reply !== undefined && next.reply !== this.seqs.reply) {
        this.seqs.reply = next.reply;
        const text = await this.client.reply();
        if (text.trim()) this.emitReply(text);
      }

      this.consecutiveFailures = 0;
      this.rebuildState();

      const idle = this.state.status === 'idle' || this.state.status === 'off';
      this.schedule(idle ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS);
    } catch (err) {
      await this.handlePollError(err);
    } finally {
      this.polling = false;
    }
  }

  private async handlePollError(err: unknown): Promise<void> {
    this.consecutiveFailures++;

    if (err instanceof SessionLostError) {
      // The board evicted us (timeout, reset, or another client took the slot).
      // Re-running rr_connect is the documented recovery.
      this.log('warning', 'session lost — reconnecting');
      try {
        if (this.client && this.config) {
          await this.client.connect(this.config.password ?? '');
          await this.seedModel();
          this.consecutiveFailures = 0;
          this.rebuildState();
          this.log('info', 'reconnected');
        }
      } catch (e) {
        this.log('error', `reconnect failed: ${(e as Error).message}`);
      }
      this.schedule(1000);
      return;
    }

    // A reset (M999, firmware update, power cycle) shows up as repeated network
    // errors. Keep retrying with a ceiling rather than tearing the UI down.
    if (this.consecutiveFailures === 3) {
      this.log('error', `lost contact with controller: ${(err as Error).message}`);
      this.patchState({ status: 'disconnected' });
    }
    const backoff = Math.min(500 * this.consecutiveFailures, 5000);
    this.schedule(backoff);
  }

  // --- State mapping -----------------------------------------------------

  private rebuildState(): void {
    const m = this.model;

    // RRF's object-model arrays are indexed by *number*, not packed, so any
    // slot the machine doesn't define comes back as null. This config declares
    // M563 P1..P9 with no P0, so `tools[0]` is null — and reading `.number` off
    // it is what "null is not an object" was. Never touch fields on a member of
    // one of these arrays without dropping the holes first.
    const omAxes = (m.move?.axes ?? []).filter(Boolean);
    const omTools = (m.tools ?? []).filter(Boolean);
    const omSpindles = (m.spindles ?? []).filter(Boolean);
    const board = (m.boards ?? []).filter(Boolean)[0] ?? null;

    const axes: Axis[] = omAxes.map((a) => ({
      letter: a.letter,
      machine: a.machinePosition ?? 0,
      work: a.userPosition ?? 0,
      homed: !!a.homed,
      min: a.min ?? 0,
      max: a.max ?? 0,
      visible: a.visible !== false,
      workOffsets: a.workplaceOffsets ?? [],
      // Already mm/min — this one the firmware converts for us.
      maxFeed: a.speed ?? 0,
      babystep: a.babystep ?? 0,
    }));

    const spindleOm = omSpindles.find((s) => s.max > 0) ?? omSpindles[0] ?? null;
    const job = m.job;
    const fileSize = job?.file?.size ?? null;
    const filePosition = job?.filePosition ?? null;

    const currentToolNumber = m.state?.currentTool ?? -1;
    const toolOm = omTools.find((t) => t.number === currentToolNumber) ?? null;

    const box = m.state?.messageBox;

    this.state = {
      status: mapStatus(m.state?.status),
      identity: board
        ? `${board.name ?? board.shortName ?? 'Duet'}${
            board.firmwareVersion ? ` / RRF ${board.firmwareVersion}` : ''
          }`
        : null,
      axes,
      wcs: m.move?.workplaceNumber != null ? m.move.workplaceNumber + 1 : 1,
      wcsCount: 9,
      // Absent `move.rotation` means the firmware wasn't built with coordinate
      // rotation at all; a zero angle means it is supported but not in use.
      // Both surface as null, and the capability flag below tells them apart.
      // "none" is RRF's own word for no compensation loaded; anything else means
      // Z is being corrected on every move.
      compensation:
        m.move?.compensation && m.move.compensation.type && m.move.compensation.type !== 'none'
          ? {
              file: m.move.compensation.file ?? null,
              mean: m.move.compensation.meshDeviation?.mean ?? null,
              deviation: m.move.compensation.meshDeviation?.deviation ?? null,
            }
          : null,
      rotation:
        m.move?.rotation && m.move.rotation.angle !== 0
          ? {
              angle: m.move.rotation.angle,
              centre: [m.move.rotation.centre?.[0] ?? 0, m.move.rotation.centre?.[1] ?? 0],
            }
          : null,
      spindle: spindleOm
        ? {
            active: spindleOm.active ?? 0,
            current: spindleOm.current ?? 0,
            min: spindleOm.min ?? 0,
            max: spindleOm.max ?? 0,
            state: mapSpindleState(spindleOm.state),
          }
        : null,
      job: job?.file?.fileName
        ? {
            fileName: job.file.fileName,
            filePosition,
            fileSize,
            progress:
              fileSize && filePosition != null && fileSize > 0
                ? Math.min(1, filePosition / fileSize)
                : null,
            elapsed: job.duration ?? null,
            remaining: job.timesLeft?.file ?? null,
          }
        : null,
      tool: toolOm
        ? { number: toolOm.number, name: toolOm.name || null, offsets: toolOm.offsets ?? [] }
        : null,
      prompt: box
        ? {
            seq: box.seq,
            title: box.title || '',
            message: box.message || '',
            mode: mapPromptMode(box.mode),
            axisControls: expandAxisControls(box.axisControls ?? 0, omAxes),
            timeout: box.timeout || null,
          }
        : null,
      // ×60: currentMove is mm/s in the object model, the neutral model is
      // mm/min. See the units warning on OmMove.currentMove.
      feedRate:
        m.move?.currentMove?.requestedSpeed != null
          ? m.move.currentMove.requestedSpeed * 60
          : null,
      feedMultiplier: m.move?.speedFactor ?? 1,
      // The ATC and dust shoe state in this machine's config lives entirely in
      // RRF globals, and globals are part of the object model — so panels get
      // real machine state here rather than shadow bookkeeping.
      extras: { global: m.global ?? {} },
    };

    this.emitState();
  }

  private patchState(patch: Partial<MachineState>): void {
    this.state = { ...this.state, ...patch };
    this.emitState();
  }

  private emitState(): void {
    for (const cb of this.stateSubs) cb(this.state);
  }

  private log(level: LogLine['level'], text: string): void {
    const line: LogLine = { level, text, time: new Date() };
    for (const cb of this.logSubs) cb(line);
  }

  /** RRF prefixes replies with "Error: " / "Warning: "; surface that as a level. */
  private emitReply(text: string): void {
    for (const raw of text.split('\n')) {
      const t = raw.trimEnd();
      if (!t.trim()) continue;
      const level: LogLine['level'] = /^Error:/i.test(t)
        ? 'error'
        : /^Warning:/i.test(t)
          ? 'warning'
          : 'reply';
      this.log(level, t);
    }
  }

  // --- Commands ----------------------------------------------------------

  private requireClient(): RrfClient {
    if (!this.client) throw new Error('not connected to a controller');
    return this.client;
  }

  async send(command: string): Promise<void> {
    this.log('command', command);
    await this.requireClient().gcode(command);
  }

  /**
   * Send and wait for the reply. RRF buffers replies per HTTP client (3.5+), so
   * this does not steal output from DWC or grr.py running alongside us.
   */
  async query(command: string): Promise<string> {
    const client = this.requireClient();
    this.log('command', command);
    await client.gcode(command);

    // Wait for seqs.reply to advance rather than guessing at a delay.
    const before = this.seqs.reply;
    for (let i = 0; i < 40; i++) {
      const seqs = (await client.model('seqs', 'd2')) as OmSeqs;
      if (seqs.reply !== before) {
        this.seqs.reply = seqs.reply;
        const text = await client.reply();
        if (text.trim()) this.emitReply(text);
        return text;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return '';
  }

  async jog(deltas: Record<string, number>, opts: JogOptions): Promise<void> {
    const words = Object.entries(deltas)
      .filter(([, d]) => d !== 0)
      .map(([axis, d]) => `${axis.toUpperCase()}${d}`)
      .join(' ');
    if (!words) return;
    // One G1 for every axis, so a diagonal is interpolated rather than stepped.
    // G91 relative, move, then back — RRF has no continuous-jog code, so
    // hold-to-jog is built from repeated discrete moves at the UI layer.
    const prefix = opts.machineCoords ? 'G53 ' : '';
    await this.send(`M120\nG91\n${prefix}G1 ${words} F${opts.feedRate}\nM121`);
  }

  async home(axes?: string[]): Promise<void> {
    if (!axes || axes.length === 0) return this.send('G28');
    await this.send(`G28 ${axes.map((a) => a.toUpperCase()).join(' ')}`);
  }

  async setWorkZero(axis: string, value: number, wcs = this.state.wcs): Promise<void> {
    // G10 L20 sets the offset so the current position reads `value`.
    await this.send(`G10 L20 P${wcs} ${axis.toUpperCase()}${value}`);
  }

  async setWorkOffset(wcs: number, axis: string, machineValue: number): Promise<void> {
    // L2 writes the offset itself rather than deriving it from where the
    // machine happens to be, so it works while the machine is parked anywhere
    // — including while it is unhomed and the current position is a fiction.
    await this.send(`G10 L2 P${wcs} ${axis.toUpperCase()}${machineValue}`);
  }

  async selectWcs(index: number): Promise<void> {
    // G54..G59 are 54..59; G59.1..G59.3 continue past that.
    const code = index <= 6 ? `G${53 + index}` : `G59.${index - 6}`;
    await this.send(code);
  }

  async setRotation(angle: number, centreX: number, centreY: number): Promise<void> {
    // R, and one of A/X plus one of B/Y, are all mandatory — RRF's HandleG68
    // does MustSee on each, so omitting the centre is an error rather than a
    // rotation about the origin.
    await this.send(`G68 X${centreX} Y${centreY} R${angle}`);
  }

  async clearRotation(): Promise<void> {
    await this.send('G69');
  }

  async emergencyStop(): Promise<void> {
    this.log('warning', 'EMERGENCY STOP (M112)');
    await this.requireClient().gcode('M112');
  }

  async setSpindle(rpm: number, direction: 'forward' | 'reverse'): Promise<void> {
    await this.send(`${direction === 'forward' ? 'M3' : 'M4'} S${rpm}`);
  }

  async stopSpindle(): Promise<void> {
    await this.send('M5');
  }

  // --- Files -------------------------------------------------------------

  async listFiles(dir: string): Promise<FileEntry[]> {
    const entries = await this.requireClient().filelist(dir);
    return entries
      .map((e) => ({
        name: e.name,
        path: joinPath(dir, e.name),
        directory: e.type === 'd',
        size: e.size ?? 0,
        modified: e.date ? new Date(e.date) : null,
      }))
      .sort((a, b) =>
        a.directory !== b.directory
          ? a.directory
            ? -1
            : 1
          : a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  }

  readFile(
    path: string,
    onProgress?: (loaded: number, total: number | null) => void,
  ): Promise<Uint8Array> {
    return this.requireClient().download(path, onProgress);
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    return this.requireClient().uploadFile(path, data);
  }

  deleteFile(path: string): Promise<void> {
    return this.requireClient().delete(path);
  }

  makeDirectory(path: string): Promise<void> {
    return this.requireClient().mkdir(path);
  }

  // --- Jobs --------------------------------------------------------------

  async startJob(path: string): Promise<void> {
    await this.send(`M32 "${path}"`);
  }

  async pauseJob(): Promise<void> {
    await this.send('M25');
  }

  async resumeJob(): Promise<void> {
    await this.send('M24');
  }

  async cancelJob(): Promise<void> {
    await this.send('M0');
  }

  async runMacro(path: string): Promise<void> {
    await this.send(`M98 P"${path}"`);
  }

  // --- Diagnostics -------------------------------------------------------

  /**
   * Health readout assembled from the object model this driver already polls.
   *
   * Every value here is something the board reports. Nothing is compared
   * against a threshold invented in this file — RRF's `vIn.min`/`vIn.max` are
   * the *extremes observed*, not permitted limits, so they are shown as context
   * beside the current reading rather than used to colour it. The only levels
   * set are ones the controller itself asserts: a halted machine, a triggered
   * probe, a poll that is failing.
   *
   * Anything needing real limits — driver temperature flags, stall detection,
   * stack usage — lives behind the M122 button, because the firmware's own
   * report is authoritative and decoding its bitfields here would be guesswork.
   */
  diagnostics(): DiagnosticSection[] {
    const m = this.model;
    const board = (m.boards ?? []).filter(Boolean)[0];
    const sections: DiagnosticSection[] = [];

    const range = (r: OmRange | undefined, unit: string, places = 1): DiagnosticItem['detail'] =>
      r && (r.min != null || r.max != null)
        ? `seen ${r.min?.toFixed(places) ?? '?'}–${r.max?.toFixed(places) ?? '?'}${unit}`
        : undefined;

    // --- Controller ---
    const controller: DiagnosticItem[] = [];
    if (board) {
      controller.push({ label: 'Board', value: board.name ?? board.shortName ?? 'unknown' });
      controller.push({
        label: 'Firmware',
        value: `${board.firmwareName ?? 'RepRapFirmware'} ${board.firmwareVersion ?? ''}`.trim(),
        detail: board.firmwareDate ? `built ${board.firmwareDate}` : undefined,
      });
      if (board.uniqueId) controller.push({ label: 'Unique ID', value: board.uniqueId });
    }
    controller.push({
      label: 'Status',
      value: m.state?.status ?? 'unknown',
      level: this.state.status === 'halted' ? 'bad' : 'ok',
      detail: m.state?.machineMode ? `mode ${m.state.machineMode}` : undefined,
    });
    if (m.state?.upTime != null) {
      controller.push({ label: 'Uptime', value: formatDuration(m.state.upTime) });
    }
    sections.push({
      title: 'Controller',
      items: controller,
      actions: [
        { label: 'M122', command: 'M122', title: "Full firmware diagnostics — printed to the console" },
        { label: 'M98 config.g', command: 'M98 P"config.g"', title: 'Re-run config.g and report any errors' },
      ],
    });

    // --- Power and temperature ---
    const power: DiagnosticItem[] = [];
    if (board?.vIn?.current != null) {
      power.push({ label: 'VIN', value: `${board.vIn.current.toFixed(1)} V`, detail: range(board.vIn, ' V') });
    }
    if (board?.v12?.current != null) {
      power.push({ label: '12V rail', value: `${board.v12.current.toFixed(1)} V`, detail: range(board.v12, ' V') });
    }
    if (board?.mcuTemp?.current != null) {
      power.push({
        label: 'MCU temperature',
        value: `${board.mcuTemp.current.toFixed(1)} °C`,
        detail: range(board.mcuTemp, ' °C'),
      });
    }
    if (board?.freeRam != null) {
      power.push({ label: 'Never-used RAM', value: formatBytes(board.freeRam) });
    }
    if (power.length) sections.push({ title: 'Power & temperature', items: power });

    // --- Network ---
    const interfaces = (m.network?.interfaces ?? []).filter(Boolean);
    if (interfaces.length || m.network?.hostname) {
      const net: DiagnosticItem[] = [];
      if (m.network?.hostname) net.push({ label: 'Hostname', value: m.network.hostname });
      interfaces.forEach((iface, i) => {
        const bits = [iface.actualIP, iface.speed ? `${iface.speed} Mbps` : null].filter(Boolean);
        net.push({
          label: iface.type ? `${iface.type}${interfaces.length > 1 ? ` ${i}` : ''}` : `Interface ${i}`,
          value: iface.state ?? 'unknown',
          level: iface.state === 'active' ? 'ok' : 'info',
          detail: [bits.join(' · '), iface.signal != null ? `signal ${iface.signal} dBm` : null]
            .filter(Boolean)
            .join(' · ') || undefined,
        });
      });
      sections.push({ title: 'Network', items: net });
    }

    // --- Probes ---
    // Live probe readings are the fastest way to tell a wiring fault from a
    // configuration one, and to confirm a probe triggers before trusting a
    // routine to drive the spindle into the work with it.
    const probes = (m.sensors?.probes ?? []).filter(Boolean);
    sections.push({
      title: 'Probes',
      emptyNote: 'No probes configured — see M558 in config-probe.g.',
      items: probes.map((probe, i) => ({
        label: `K${i}`,
        value: probe.triggered ? 'TRIGGERED' : 'open',
        level: probe.triggered ? 'warn' : 'ok',
        detail: [
          probe.value?.length ? `reading ${probe.value.join(', ')}` : null,
          probe.type != null ? `type ${probe.type}` : null,
          probe.threshold != null ? `threshold ${probe.threshold}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || undefined,
      })),
    });

    // --- Connection ---
    // Not from the board: this is how well *we* are talking to it, which is
    // the one thing the board itself can never report.
    sections.push({
      title: 'Connection',
      items: [
        { label: 'Controller', value: this.config?.url ?? '—' },
        {
          label: 'Poll',
          value: `every ${this.state.status === 'idle' || this.state.status === 'off' ? IDLE_POLL_INTERVAL_MS : POLL_INTERVAL_MS} ms`,
        },
        {
          label: 'Failed polls',
          value: String(this.consecutiveFailures),
          level: this.consecutiveFailures > 0 ? 'warn' : 'ok',
          detail: this.consecutiveFailures > 0 ? 'consecutive; the driver backs off and retries' : undefined,
        },
      ],
    });

    return sections;
  }

  // --- Prompts -----------------------------------------------------------

  async answerPrompt(seq: number, accept: boolean, value?: string | number): Promise<void> {
    // M292 acknowledges a blocking M291. P0 = OK/accept, P1 = cancel.
    // S<seq> identifies which box is being answered so a stale click can't
    // dismiss a newer prompt; R supplies the value for input modes (S4-S7).
    //
    // NOTE: the S and R parameters are 3.5+ additions. If your firmware is
    // older, drop them — a bare `M292 P0` is the long-standing form.
    let cmd = `M292 P${accept ? 0 : 1} S${seq}`;
    if (accept && value !== undefined) {
      cmd += typeof value === 'number' ? ` R${value}` : ` R"${String(value).replace(/"/g, '""')}"`;
    }
    await this.send(cmd);
  }
}
