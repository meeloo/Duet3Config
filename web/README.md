# CNC web front end

A CNC-first web UI for the Duet 3 6HC, built to replace day-to-day use of DWC —
whose information architecture is shaped around 3D printing.

Runtime dependencies: **Lit** (~5 KB). That's the whole list. The toolpath
viewer is raw WebGL2, the reactivity is ~60 lines, the build is a single
`esbuild` binary. Current bundle: **27 KB gzipped**.

```
npm install
npm run dev        # esbuild watch + dev server on :8080
npm run build      # dist/, with .gz siblings for the Duet
npm run typecheck
```

## Developing without the machine

```
node tools/mock-rrf.mjs        # mock controller on :8081, also serves dist/
```

The mock implements the `rr_*` endpoints against a synthetic object model
shaped like the real Ultimate Bee: X/Y/Z plus the U dust-shoe axis, a
0–24000 rpm VFD spindle, the 8-slot RapidChange ATC, and the `atc*`/`dustShoe*`
globals from `config/sys`. It simulates motion and job progress, so the DRO
moves and the viewer's live cutter tracking has something to follow. Two sample
programs are included, one with arcs and a full circle to exercise the
tessellator.

Open <http://localhost:8081> and it connects to itself.

## Deploying to the controller

Either host it anywhere on the LAN and point it at the Duet — CORS is already
enabled by `M586 C"*"` in `config/sys/config-network.g` — or copy `dist/` onto
the SD card:

```
# from the repo root, with the controller reachable
cp -r web/dist/* /path/to/sd/www/cnc/
```

then browse to `http://sebscnc.local/cnc/`. Ship the `.gz` files alongside the
originals; the Duet serves them when the browser sends `Accept-Encoding: gzip`,
which matters because it reads off the SD card single-threaded.

DWC stays installed at `/`. This UI is not trying to reach feature parity —
firmware updates, the config tool and network setup are all still DWC's job.

## Architecture

```
src/
  core/          signals (reactivity), app store, CRC32, helpers
  machine/
    types.ts     vendor-neutral machine model — the only vocabulary panels see
    driver.ts    the MachineDriver contract
    registry.ts  driver list
    drivers/
      rrf/       RepRapFirmware: HTTP transport, object model, state mapping
      carvera/   Makera Carvera / Z1 — stub, see its README first
  ui/            panel base class, dashboard layout, top bar, prompt dialog
  panels/        one file per panel, self-registering
  viewer/        G-code parser, WebGL2 renderer, mat4
```

### The driver layer

Panels read **only** `machine/types.ts`. Nothing above the driver layer may
import RRF object-model types or `rr_*` endpoint names. A second controller is a
new `MachineDriver` implementation, not a fork of the UI.

Each driver publishes a `Capabilities` record, and panels hide themselves when
the active controller can't back them — so a partially-implemented driver still
yields a coherent UI instead of dead buttons. The object-model browser is the
one panel that deliberately reaches through `driver.native`, gated on
`capabilities.objectModel`.

### RRF specifics

Standalone RRF has no WebSocket (reserved in the API, unimplemented — the board
has ~8 sockets and half may go to non-HTTP services). So the driver polls:

1. one cheap `rr_model?flags=d99fn` per tick for live values across the whole
   tree, plus `seqs`;
2. a full `rr_model?key=<k>&flags=d99vn` **only** for subtrees whose sequence
   number moved;
3. `rr_reply` when `seqs.reply` advances.

250 ms while active, 500 ms when idle. Replies are buffered per HTTP client on
3.5+, so running this alongside DWC and `tools/grr.py` doesn't steal output.
Sessions use `sessionKey`/`X-Session-Key` where available, falling back to
implicit per-IP sessions on older firmware.

### Why the byte offset matters

The parser records the **source byte offset** on every vertex. RRF reports
`job.filePosition` as a byte offset, so comparing the two in the fragment shader
is what draws the cut/uncut boundary and places the live cutter. A parser that
discards offsets can draw a toolpath but can never track a running job.

## Adding a controller

1. Implement `MachineDriver` under `src/machine/drivers/<name>/`.
2. Set `Capabilities` honestly as you go.
3. Register a factory in `src/machine/registry.ts`.

No panel changes. See `drivers/carvera/README.md` — note especially that the
Carvera/Z1 speaks raw TCP or USB serial rather than HTTP, so it needs WebSerial
or a small WebSocket⇄TCP bridge. `connect(config)` takes a URL string precisely
so that choice stays inside the driver.

## Status

Working: DRO with work/machine coordinates and WCS selection, jog and homing,
MDI console, file browser with a config editor (CRC32-checked writes), object
model browser with editable globals, toolpath viewer with live cutter tracking,
M291 prompt handling, configurable panel layout persisted to localStorage.

Not done: probing wizards, an ATC carousel view, tool table editing, job history.

## Notes

- `M292` is sent with `S<seq>` and, for input prompts, `R<value>`. Both are 3.5+
  additions — on older firmware, drop them for a bare `M292 P0`.
- Hold-to-jog fires repeated discrete relative moves; there is no continuous-jog
  command over HTTP polling. A pendant will always feel better than a browser.
- `/sys` files are editable but deliberately **not** runnable — handing
  `config.g` to `M32` would try to execute it as a job.
