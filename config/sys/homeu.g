; homeu.g
; called to home the U axis (Dust Shoe)

; Let the dust shoe go first — see the note in homeall.g. U is the follower, so
; without this the `G1 H1` below is asking the axis to seek an endstop while
; something else holds it to Z.
M98 P"dustShoeRelease.g" S1

G91 ; relative positioning
G21 ; Set units to mm
G1 H1 U{move.axes[3].max*2} F900 ; move quickly to axis endstop and stop there (first pass)
G92 U{move.axes[3].max} ; Set Home Position
G1 U-3 F2400 ; go back a few mm
G1 H1 U{move.axes[3].max*2} F300 ; move slowly to axis endstop once more (second pass)
G92 U{move.axes[3].max} ; Set Home Position
G90 ; absolute positioning

; Hand U back.
;
; "Once a motion system starts using an axis or extruder, it owns it until it
; is released, usually with M400" — so homing U claims the axis for whichever
; motion system ran this file, and keeps it. Without this line the next thing
; that wants U fails with "Drive U is already used by a different motion
; system", and the shoe stops following Z until the next reboot.
;
; Learned from the trigger, which ran in its own motion system, and kept for
; M604, which has to be able to take the axis when the shoe is engaged again.
; Harmless with a single motion system: M400 is then just a wait.
M400

;M400 ; Wait for current moves to finish 
;M913 U70 ; drop motor current to 70% 
;M400 
;G91 ; relative positioning 
;M915 U S-30 H200 F0 R0
;G1 H1 U{move.axes[3].max*2} F12000 ; move quickly to axis endstop and stop there (first pass) 
;G1 H2 U-5 F12000 ; go back a few mm 
;G1 H1 U{move.axes[3].max*2} F12000 ; move slowly to axis endstop once more (second pass) 
;M400
;G92 U{move.axes[3].max} ; Set Home Position 
;G90 ; absolute positioning 
;M400
;M913 U100 ; return current to 100% M400
;M400
