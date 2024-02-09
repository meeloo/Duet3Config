; homez.g
; called to home the Z axis

G91 ; relative positioning
G21 ; Set units to mm
G1 H1 Z{move.axes[2].max*2} F900 ; move quickly to Z axis endstop and stop there (first pass)
G92 Z{move.axes[2].max} ; Set Home Position
G1 Z-3 F2400 ; go back a few mm
G1 H1 Z{move.axes[2].max*2} F300 ; move slowly to Z axis endstop once more (second pass)
G92 Z{move.axes[2].max} ; Set Home Position
G90 ; absolute positioning