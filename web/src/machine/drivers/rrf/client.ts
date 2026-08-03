// RepRapFirmware HTTP transport (standalone mode).
//
// Endpoint reference:
//   https://github.com/Duet3D/RepRapFirmware/wiki/HTTP-requests
//
// Standalone RRF has no WebSocket — it is reserved in the API but unimplemented,
// deliberately, because the board has only ~8 sockets and half may go to
// non-HTTP services. So everything here is polling, and the poll budget is a
// real constraint: one connection, keep-alive, and `seqs`-diffed fetches rather
// than pulling the whole object model every tick.

import { crc32Hex } from '../../../core/crc32.js';
import { rrfTimestamp } from '../../../core/util.js';

export class RrfError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(message);
    this.name = 'RrfError';
  }
}

/** Thrown when the session is gone and the caller should reconnect. */
export class SessionLostError extends RrfError {}

/** Thrown when the caller aborted the request. Not a failure to report. */
export class CancelledError extends RrfError {
  constructor(message = 'cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

/**
 * How long one request may go unanswered before it is treated as dead.
 *
 * A board on the LAN answers rr_model in single-digit milliseconds, so this is
 * not a latency budget — it is the line between "slow" and "never". It has to
 * exist because a TCP connection that is accepted and then ignored leaves fetch
 * pending indefinitely, with no error, forever: the app looks like it is still
 * connecting and there is nothing to report and nothing to retry.
 */
const REQUEST_TIMEOUT_MS = 15_000;

/** Long enough for a real file over wifi; short enough to not hang forever. */
const UPLOAD_TIMEOUT_MS = 120_000;

export interface ConnectResult {
  sessionTimeout: number;
  boardType: string;
  sessionKey: number | null;
  apiLevel: number;
}

export interface FileListEntry {
  type: 'f' | 'd';
  name: string;
  size: number;
  date: string | null;
}

export class RrfClient {
  private base: string;
  private sessionKey: number | null = null;
  /** Set once we know the firmware ignores/rejects sessionKey (pre-3.5-b4). */
  private useSessionKey = true;
  /**
   * True when the page is served from the controller itself, so no CORS applies.
   *
   * This matters more than it looks. `M586 C"*"` makes RRF send
   * Access-Control-Allow-Origin, but it does NOT answer a CORS *preflight* with
   * Access-Control-Allow-Headers. So cross-origin, any request carrying a custom
   * header (X-Session-Key) or a non-simple Content-Type is preflighted and fails
   * at the network layer — while rr_connect, which carries neither, succeeds.
   * That asymmetry is exactly what "connected… then rr_model: Load failed" is.
   *
   * Cross-origin we therefore stay inside the CORS-simple envelope: no custom
   * headers, no exotic content types. The cost is falling back to RRF's implicit
   * per-IP session, which is how every client worked before 3.5-b4.
   */
  private readonly sameOrigin: boolean;

  /**
   * Aborts everything this client has in flight.
   *
   * Owned by whoever is driving the connection, so that cancelling reaches the
   * requests rather than only the code waiting on them.
   */
  signal: AbortSignal | null = null;

  constructor(url: string) {
    this.base = normaliseBase(url);
    this.sameOrigin = isSameOrigin(this.base);
  }

  get baseUrl(): string {
    return this.base;
  }

  /** True when served from the controller and a session key is in play. */
  private get canUseSessionHeader(): boolean {
    return this.sameOrigin && this.useSessionKey && this.sessionKey != null;
  }

  private headers(): HeadersInit {
    return this.canUseSessionHeader ? { 'X-Session-Key': String(this.sessionKey) } : {};
  }

  private url(endpoint: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(`${this.base}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
    init: RequestInit = {},
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const attempt = new AbortController();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => attempt.abort(new DOMException('timed out', 'TimeoutError')), timeoutMs)
        : null;
    // The caller's signal is how a cancel button reaches a request that is
    // already in flight; without linking it, cancelling only stops waiting for
    // the answer, it does not stop asking.
    const outer = this.signal;
    const relay = () => attempt.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) relay();
      else outer.addEventListener('abort', relay);
    }

    let res: Response;
    try {
      res = await fetch(this.url(endpoint, params), {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        // The board is on the LAN; never let a stale cache answer for machine state.
        cache: 'no-store',
        credentials: 'omit',
        signal: attempt.signal,
      });
    } catch (e) {
      if (outer?.aborted) throw new CancelledError(`${endpoint} cancelled`);
      if (attempt.signal.aborted) {
        // The distinction matters: a refused connection is a wrong address or a
        // board that is off, whereas silence is a board that is listening and
        // not answering — wedged, or out of HTTP session slots.
        throw new RrfError(
          `${endpoint} did not answer within ${Math.round(timeoutMs / 1000)}s. ` +
            `The controller accepted the connection but sent nothing back — it may be busy, ` +
            `out of session slots (try M552 or a power cycle), or reachable but not responding.`,
        );
      }
      // A fetch that dies below HTTP level gives no detail ("Load failed" in
      // Safari, "Failed to fetch" in Chrome). Don't assert a cause we can't
      // observe — name the candidates, in the order they're actually likely.
      const detail = (e as Error).message;
      const url = this.url(endpoint, params);
      throw new RrfError(
        `network error calling ${endpoint}: ${detail}. ` +
          `The controller closed the connection or was unreachable. ` +
          `Open ${url} directly in a browser tab — if that also fails, it is the ` +
          `controller, not CORS.` +
          (this.sameOrigin ? '' : ` If it loads fine there, check M586 C"*" in config-network.g.`),
      );
    } finally {
      // Cleared once the headers are in. The timeout deliberately covers
      // time-to-first-byte and not the body: a small JSON answer follows its
      // headers immediately, while a file download legitimately takes as long
      // as it takes, and killing that at 15s would be a bug of its own.
      if (timer) clearTimeout(timer);
      outer?.removeEventListener('abort', relay);
    }

    // RRF answers 401 when the session has expired or was evicted.
    if (res.status === 401 || res.status === 403) {
      throw new SessionLostError(`session rejected by controller (${res.status})`, undefined, res.status);
    }
    if (res.status === 404 && endpoint === 'rr_connect') {
      throw new RrfError(
        `rr_connect returned HTTP 404 — ${this.base} does not look like a RepRapFirmware ` +
          `controller. Enter the controller's address in the top bar.`,
        undefined,
        404,
      );
    }
    if (!res.ok) {
      throw new RrfError(`${endpoint} returned HTTP ${res.status}`, undefined, res.status);
    }
    return res;
  }

  private async json<T>(
    endpoint: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const res = await this.request(endpoint, params);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RrfError(`${endpoint} returned non-JSON body: ${text.slice(0, 120)}`);
    }
  }

  // --- Session -----------------------------------------------------------

  async connect(password = ''): Promise<ConnectResult> {
    // sessionKey=yes is honoured from 3.5-b4 onward and lets several clients
    // share one IP — which matters here because DWC, this UI and tools/grr.py
    // may all be open at once. Older firmware simply omits the key from the
    // response, and we fall back to implicit per-IP sessions.
    const res = await this.json<{
      err: number;
      sessionTimeout?: number;
      boardType?: string;
      sessionKey?: number;
      apiLevel?: number;
    }>('rr_connect', {
      password: password || 'reprap',
      time: rrfTimestamp(),
      // Only ask for a session key when we can actually send it back. Requesting
      // one cross-origin would allocate a session slot on the board that we then
      // could never authenticate against, since the header would be preflighted.
      sessionKey: this.sameOrigin ? 'yes' : undefined,
    });

    if (res.err === 1) throw new RrfError('incorrect password', 1);
    if (res.err === 2) throw new RrfError('controller has no free sessions', 2);
    if (res.err !== 0) throw new RrfError(`rr_connect failed (err ${res.err})`, res.err);

    this.sessionKey = res.sessionKey ?? null;
    this.useSessionKey = res.sessionKey != null;

    return {
      sessionTimeout: res.sessionTimeout ?? 8000,
      boardType: res.boardType ?? 'unknown',
      sessionKey: this.sessionKey,
      apiLevel: res.apiLevel ?? 0,
    };
  }

  async disconnect(): Promise<void> {
    try {
      await this.json<{ err: number }>('rr_disconnect');
    } finally {
      this.sessionKey = null;
    }
  }

  // --- Object model ------------------------------------------------------

  /**
   * Fetch part of the object model.
   *
   * flags: f = frequently-changing values, v = verbose (rarely-needed fields),
   *        n = include null-valued fields, d<N> = depth limit, o = obsolete.
   *
   * An empty key with `d99fn` yields the live subset of the whole tree plus
   * `seqs`; that is the cheap per-tick request. A specific key with `d99vn`
   * yields a full subtree, which we only issue when its sequence number moves.
   */
  async model<T = unknown>(key = '', flags = 'd99fn'): Promise<T> {
    // Omit `key` entirely when empty rather than sending `key=`. tools/grr.py
    // talks to this same machine with `rr_model?flags=d99fn` and no key at all,
    // so match the form that is known-good on real hardware.
    const res = await this.json<{ key: string; flags: string; result: T; err?: number }>(
      'rr_model',
      { key: key || undefined, flags },
    );
    if (res.err) throw new RrfError(`rr_model(${key}) failed (err ${res.err})`, res.err);
    return res.result;
  }

  // --- G-code ------------------------------------------------------------

  /** Queue a command. Resolves when RRF has accepted it into its buffer. */
  async gcode(command: string): Promise<void> {
    const res = await this.json<{ buff?: number; err?: number }>('rr_gcode', { gcode: command });
    if (res.err) throw new RrfError(`rr_gcode rejected: ${command}`, res.err);
  }

  /** Fetch buffered reply text. Empty string when there is nothing waiting. */
  async reply(): Promise<string> {
    const res = await this.request('rr_reply');
    return res.text();
  }

  // --- Files -------------------------------------------------------------

  async filelist(dir: string, first = 0): Promise<FileListEntry[]> {
    const out: FileListEntry[] = [];
    let next = first;
    // RRF paginates when a directory doesn't fit the response buffer; `next` is
    // 0 once the listing is complete.
    for (;;) {
      const res = await this.json<{
        dir: string;
        first: number;
        files: FileListEntry[];
        next: number;
        err?: number;
      }>('rr_filelist', { dir, first: next });

      if (res.err === 1) throw new RrfError('SD card not mounted', 1);
      if (res.err === 2) throw new RrfError(`directory not found: ${dir}`, 2);
      if (res.err) throw new RrfError(`rr_filelist failed (err ${res.err})`, res.err);

      out.push(...(res.files ?? []));
      if (!res.next) break;
      next = res.next;
    }
    return out;
  }

  async download(
    path: string,
    onProgress?: (loaded: number, total: number | null) => void,
  ): Promise<Uint8Array> {
    const res = await this.request('rr_download', { name: path });
    if (!onProgress || !res.body) return new Uint8Array(await res.arrayBuffer());

    // Read the stream so a multi-megabyte pull off the SD card can show real
    // progress. Content-Length is usually present; when it isn't, `total` is
    // null and the caller shows an indeterminate bar rather than a wrong one.
    const header = res.headers.get('Content-Length');
    const total = header ? Number(header) : null;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, Number.isFinite(total) ? total : null);
    }

    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  async downloadText(path: string): Promise<string> {
    const res = await this.request('rr_download', { name: path });
    return res.text();
  }

  async upload(path: string, data: Uint8Array): Promise<void> {
    // CRC32 is verified by the firmware; a mismatch returns err:1 and the file
    // is discarded. Matches tools/grr.py's zlib.crc32 hex encoding.
    const res = await this.json<{ err: number }>('rr_upload', {
      name: path,
      time: rrfTimestamp(),
      crc32: crc32Hex(data),
    });
    if (res.err !== 0) throw new RrfError(`upload of ${path} failed (err ${res.err})`, res.err);
  }

  /** Upload needs a POST body, so it bypasses the JSON helper. */
  async uploadFile(path: string, data: Uint8Array): Promise<void> {
    const res = await this.request(
      'rr_upload',
      { name: path, time: rrfTimestamp(), crc32: crc32Hex(data) },
      {
        method: 'POST',
        // A Blob with no type makes fetch omit Content-Type entirely, keeping the
        // request CORS-simple. Setting application/octet-stream would preflight
        // it and fail cross-origin exactly like the X-Session-Key header does.
        // RRF doesn't inspect the content type on rr_upload — tools/grr.py sends
        // application/json and the firmware is perfectly happy.
        body: new Blob([data as unknown as BlobPart]),
      },
      // RRF answers only once the whole body has landed on the SD card, so an
      // upload's time-to-first-byte is the upload. The usual budget would kill
      // any file worth uploading.
      UPLOAD_TIMEOUT_MS,
    );
    const body = (await res.json()) as { err: number };
    if (body.err !== 0) {
      throw new RrfError(`upload of ${path} failed (err ${body.err}) — CRC mismatch?`, body.err);
    }
  }

  async delete(path: string, recursive = false): Promise<void> {
    const res = await this.json<{ err: number }>('rr_delete', {
      name: path,
      recursive: recursive ? 'yes' : undefined,
    });
    if (res.err !== 0) throw new RrfError(`delete of ${path} failed`, res.err);
  }

  async mkdir(path: string): Promise<void> {
    const res = await this.json<{ err: number }>('rr_mkdir', { dir: path });
    if (res.err !== 0) throw new RrfError(`mkdir ${path} failed`, res.err);
  }

  async move(from: string, to: string, overwrite = false): Promise<void> {
    const res = await this.json<{ err: number }>('rr_move', {
      old: from,
      new: to,
      deleteexisting: overwrite ? 'yes' : undefined,
    });
    if (res.err !== 0) throw new RrfError(`move ${from} → ${to} failed`, res.err);
  }

  async fileinfo(path: string): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>('rr_fileinfo', { name: path });
  }
}

function normaliseBase(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

/** Served from the controller itself? Then CORS doesn't apply at all. */
function isSameOrigin(base: string): boolean {
  if (typeof location === 'undefined') return true; // non-browser (tests)
  try {
    return new URL(base).origin === location.origin;
  } catch {
    return false;
  }
}
