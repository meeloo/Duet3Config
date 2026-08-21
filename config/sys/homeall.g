; homeall.g
; called to home all axes

; Let the dust shoe go before anything moves.
;
; With U held to Z by M604, the `G1 H1` moves below drag U to its stop, and the
; `G92` that follows redefines Z's machine position underneath a relationship
; that was captured against the old one — leaving the shoe holding station
; against a coordinate frame that no longer exists. It also puts two things in
; charge of U at once, which is not a fight worth having during homing.
M98 P"dustShoeRelease.g" S1

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

; Hand the axes back — U is the one that matters. See the note in homeu.g: an
; axis stays owned by the motion system that moved it until an M400 releases it.
; That was found the expensive way when the shoe tracked from a different motion
; system, and it stays whichever mechanism is tracking — M604 has to be able to
; take the axis when the shoe is engaged again.
M400



