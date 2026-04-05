; daemon.g — dust shoe Z-tracking daemon
; The firmware restarts this file every ~5s, so the tracking loop must be a
; while true loop — the G4 P50 at the bottom controls the actual iteration rate.

while true
    ; Wait for globals to exist (firmware may start daemon before config.g completes)
    if {!exists(global.dustShoeEngaged)}
        G4 P500

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
            var targetU = move.axes[3].machinePosition - var.deltaZ
            if {var.targetU < move.axes[3].min}
                set var.targetU = move.axes[3].min
            if {var.targetU > move.axes[3].max}
                set var.targetU = move.axes[3].max
            G53 G1 U{var.targetU} F8000
            set global.dustShoePrevZ = var.currentZ

        G4 P50
