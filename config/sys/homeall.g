; homeall.g
; called to home all axes

G91 ; relative positioning
G21 ; Set units to mm
G1 H1 Z{move.axes[2].max*2} F2000 ; move quickly to Z axis endstop and stop there (first pass)
G1 H1 X{-move.axes[0].max*2} F3000 ; move quickly to X axis endstops and stop there (first pass)
G1 H1 Y{-move.axes[1].max*2} F3000 ; move quickly to Y axis endstops and stop there (first pass)
G92 X{move.axes[0].min} Y{move.axes[1].min} Z{move.axes[2].max} ; Set Home Position
G1 X3 Y3 Z-3 F2000 ; go back a few mm
G1 H1 X{-move.axes[0].max*2} F100 ; move slowly to X axis endstops once more (second pass)
G1 H1 Y{-move.axes[1].max*2} F100 ; move slowly to Y axis endstops once more (second pass)
G1 H1 Z{move.axes[2].max*2} F100 ; move slowly to Z axis endstop once more (second pass)
G92 X{move.axes[0].min} Y{move.axes[1].min} Z{move.axes[2].max} ; Set Home Position
G90 ; absolute positioning