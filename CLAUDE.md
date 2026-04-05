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

## Config Structure

`config/sys/` — system files executed by RRF firmware:
- `config.g` — entrypoint; loads sub-configs via `M98 P"..."` then runs `M501`
- `config-axes.g`, `config-drives.g`, `config-network.g`, etc. — modular config fragments
- `atcConfig.g` — ATC (RapidChange automatic tool changer) globals; **machine-specific values that must be updated per setup**
- `atcPickup.g`, `atcDrop.g`, `atcProbeZ.g` — ATC operation macros
- `tpre{N}.g`, `tpost{N}.g`, `tfree{N}.g` — tool pre/post/free macros for tools 0-9
- `homeall.g`, `homex.g`, `homey.g`, `homez.g` — homing sequences
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
