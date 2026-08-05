; daemon.g — dust shoe Z-tracking daemon
; The firmware restarts this file every ~5s, so the tracking loop must be a
; while true loop — the G4 P50 at the bottom controls the actual iteration rate.

while true
    ; Stand down while the machine is halted.
    ;
    ; After M112 the firmware refuses everything this file does — including the
    ; G4 that paces the loop, which comes back as "Error: G4: Machine is halted".
    ; Every branch below ends in a G4, so with nothing to pace it the loop spins
    ; as fast as the firmware will run it, one error per turn, and the board has
    ; better things to do with its output buffers than fill them with the same
    ; complaint. The web interface stopped answering at all.
    ;
    ; Leaving is the whole fix: the firmware restarts daemon.g every few seconds,
    ; so this idles for free and picks straight back up after M999 or a reset.
    if {state.status == "halted" || state.status == "off"}
        break

    ; Wait for globals to exist (firmware may start daemon before config.g completes)
    if {!exists(global.dustShoeEngaged)}
        G4 P500

    ; On RRF 3.7 the tracking is an M581.1 expression trigger (trigger2.g) and
    ; this loop must keep out of its way — two things moving U from different
    ; channels would fight, each undoing the other's correction. Idles slowly
    ; rather than exiting, so flipping the switch back takes effect without a
    ; restart.
    elif {exists(global.dustShoeUseTrigger) && global.dustShoeUseTrigger}
        G4 P1000

    ; Never move an unhomed axis
    elif {!move.axes[3].homed}
        G4 P200

    ; Nothing to do when retracted
    elif {!global.dustShoeEngaged}
        G4 P200

    else
        ; --- Compensate U for Z movement ---
        var currentZ = move.axes[2].machinePosition
        var deltaZ   = var.currentZ - global.dustShoePrevZ

        if {abs(var.deltaZ) > 0.1}
            var wantU = move.axes[3].machinePosition - var.deltaZ
            var targetU = var.wantU
            if {var.targetU < move.axes[3].min}
                set var.targetU = move.axes[3].min
            if {var.targetU > move.axes[3].max}
                set var.targetU = move.axes[3].max
            G53 G1 U{var.targetU} F8000
            ; Compared before the move, not after: once the G1 is issued
            ; machinePosition is whatever the axis has reached since, and
            ; measuring the clamp against that says nothing about the clamp.
            if {var.targetU == var.wantU}
                set global.dustShoePrevZ = var.currentZ
            else
                ; Only credit the Z that was actually compensated for, or the
                ; shoe never recovers once the axis comes off its stop.
                set global.dustShoePrevZ = {var.currentZ - (var.wantU - var.targetU)}
                if {exists(global.dustShoeSaturated)}
                    set global.dustShoeSaturated = true

        G4 P50
