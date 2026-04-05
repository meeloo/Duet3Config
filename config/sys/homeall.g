; homeall.g
; called to home all axes

G91 ; relative positioning
G21 ; Set units to mm

M913 U70 ; drop motor current to 70%

; Dust shoe up first
G1 H1 U{move.axes[3].max*2} F2000 ; move quickly to axis endstop and stop there (first pass)
; Then Z
G1 H1 Z{move.axes[2].max*2} F2000 ; move quickly to axis endstop and stop there (first pass)
G1 H1 X{-move.axes[0].max*2} F3000 ; move quickly to axis endstops and stop there (first pass)
G1 H1 Y{-move.axes[1].max*2} F3000 ; move quickly to axis endstops and stop there (first pass)
G92 X{move.axes[0].min} Y{move.axes[1].min} Z{move.axes[2].max} U{move.axes[3].max} ; Set Home Position

G1 X3 Y3 Z-3 U-3 F2000 ; go back a few mm
G1 H1 U{move.axes[3].max*2} F100 ; move quickly to axis endstop and stop there (first pass)
G1 H1 X{-move.axes[0].max*2} F100 ; move slowly to axis endstops once more (second pass)
G1 H1 Y{-move.axes[1].max*2} F100 ; move slowly to axis endstops once more (second pass)
G1 H1 Z{move.axes[2].max*2} F100 ; move slowly to axis endstop once more (second pass)
G92 X{move.axes[0].min} Y{move.axes[1].min} Z{move.axes[2].max} U{move.axes[3].max} ; Set Home Position
G90 ; absolute positioning



