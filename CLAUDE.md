# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Repo Is

Configuration for a Duet3 6HC CNC controller (custom Ultimate Bee 750x1500mm) paired with a Huangyang VFD and 2.2kW water-cooled spindle. The `config/` directory mirrors the filesystem on the Duet3 controller. Files are G-code (`.g`) in RepRapFirmware (RRF) dialect.

## Syncing with the Controller

The `tools/` directory contains scripts to sync configuration with the live machine (at `http://sebscnc.local`):

```bash
./tools/get    # Pull from controller: initial mirror or refresh if already mirrored
./tools/put    # Upload local changes to controller
```

`grr.py` is the underlying Python 3 sync tool:
- `grr.py -m <URL> -d <dir>` — initial mirror from controller
- `grr.py -r` — refresh (pull remote changes, preserve local edits on conflict)
- `grr.py -u` — upload local modifications
- `grr.py -e "G28"` — execute a GCode command on the machine

State is tracked in `config/.rrf_mirror` (a SQLite DB, gitignored). Run from within `config/` or a subdirectory.

## Checking macros before uploading them

```bash
node tools/check.mjs          # all of config/sys
node tools/check.mjs a.g b.g  # just those
```

Structural only — unbalanced braces or quotes, undeclared `var.`/`global.`,
indentation mixed between tabs and spaces, a stray `else`. It is not a G-code
parser and will not catch a wrong parameter letter or a move in the wrong
direction. Worth running anyway: the machine reports this class of mistake by
refusing a line at boot with nobody watching, or by aborting a macro halfway
through a tool change.

## Config Structure

`config/sys/` — system files executed by RRF firmware:
- `config.g` — entrypoint; loads sub-configs via `M98 P"..."` then runs `M501`
- `config-axes.g`, `config-drives.g`, `config-network.g`, etc. — modular config fragments
- `atcConfig.g` — ATC (RapidChange automatic tool changer) globals; **machine-specific values that must be updated per setup**
- `atcPickup.g`, `atcDrop.g`, `atcProbeZ.g` — ATC operation macros
- `tpre{N}.g`, `tpost{N}.g`, `tfree{N}.g` — tool pre/post/free macros for tools 0-9
- `dustShoeConfig.g` — dust-shoe globals; `dustShoeTracking` picks who keeps the shoe level with the tool
- `dustShoeEngage.g`, `dustShoeRetract.g`, `dustShoeRelease.g` — engage (position, then start following), retract (stop following, then park), release (stop following, move nothing)
- `homeall.g`, `homex.g`, `homey.g`, `homez.g`, `homeu.g` — homing sequences
- `XYZ-probe.g`, `probe.g` — probing routines
- `config-override.g` — loaded by `M501`; stores tuned values (do not hand-edit)

`config/macros/` — user-invocable macros from DWC (Duet Web Control)

`Fusion 360 Post processor/` — customized Fusion 360 post processor with ATC support and sensible defaults for batch posting.

## G-code Dialect Notes

This is RepRapFirmware (RRF) G-code, not standard CNC G-code:
- `M98 P"file.g"` — call a macro file
- `global varName = value` — declare a global variable
- `set global.varName = value` — assign a global
- `{expression}` — inline expression evaluation
- `if {condition}` / `while {condition}` — control flow
- `M950` — configure GPIO pins, spindle outputs, etc.

Two commands here are **not** in stock RepRapFirmware. They come from the
`meeloo/RepRapFirmware` fork, branch `feature/velocity-jog`, and `M604`'s number
is provisional — free in that firmware, not blessed by Duet3D:
- `M604 A"U" B"Z" E1` — make one axis follow another inside the motion planner;
  `E0` disengages, no parameters reports. Captures the current separation, so
  the follower must be positioned first.
- `M700 X<mm/s> …` — move by velocity rather than destination, with a watchdog
  that stops the machine if commands stop arriving.

Anything guarded by `if {global.dustShoeTracking == "m604"}` is there so the
configuration still works on firmware without them.
