# Makera Carvera / Z1 driver

Stub. `driver.ts` implements the `MachineDriver` interface with every method
throwing, so the shell can list the machine without the UI needing to know it
isn't finished yet. Fill it in when the machine arrives.

## The transport problem — read this first

The Carvera family is not an HTTP controller. It is reached over **a raw TCP
socket on the LAN, or over USB serial**, speaking a Smoothieware-derived dialect
with Grbl-style `?` status polling.

**A browser cannot open a raw TCP socket.** There is no API for it and there
will not be one. So unlike the Duet — which is directly reachable because it
*is* an HTTP server — this driver needs one of:

1. **WebSerial** (`navigator.serial`) for the USB connection. Works in
   Chrome/Edge with no extra process, requires a user gesture to pick the port,
   and needs the page served over HTTPS or localhost. This is the lowest-effort
   path and is probably what you want first.
2. **A small bridge process** — Node or Python, ~100 lines — exposing
   `WebSocket ⇄ TCP:2222` so the browser talks WebSocket and the bridge talks
   to the machine. Needed for the wireless connection. Also the natural place
   to put anything else that wants a real socket later.
3. **WebUSB**, if the board enumerates as something WebSerial won't claim.
   Fiddlier; treat as a fallback.

The `MachineDriver` interface is deliberately transport-agnostic for this
reason: `connect(config)` takes a URL string, and nothing above the driver
layer cares whether that resolves to HTTP, a WebSocket bridge, or a serial
port handle.

## What to verify against the real machine

Do not trust any of this until checked against hardware — it is written from
the general shape of Smoothie/Grbl controllers, not from the Z1 itself:

- Status report format and poll cadence (Grbl `?` → `<Idle|MPos:...|WPos:...>`,
  but Makera has extended it).
- Whether file transfer is available over the wire, and in what framing. This
  determines whether the file browser and G-code viewer panels can work at all,
  or whether `capabilities.files` must stay `false`.
- Work coordinate system support (`G54`-`G59`) and how offsets are read back.
- Whether anything reports a byte offset into the running file. If not, set
  `capabilities.jobFilePosition = false` and the viewer will render the toolpath
  without the live cutter position — the panel already handles that case.
- Tool changer semantics for the Z1's ATC.

## Implementation order

Mirror the RRF driver: transport first (`client.ts`), then a state mapper, then
wire up `MachineDriver`. Set `capabilities` honestly as you go — panels hide
themselves based on it, so an accurate capability set gives a working UI even
when the driver is half-finished.
