; homeu.g
; called to home the U axis (Dust Shoe)

G91 ; relative positioning
G21 ; Set units to mm
G1 H1 U{move.axes[3].max*2} F900 ; move quickly to axis endstop and stop there (first pass)
G92 U{move.axes[3].max} ; Set Home Position
G1 U-3 F2400 ; go back a few mm
G1 H1 U{move.axes[3].max*2} F300 ; move slowly to axis endstop once more (second pass)
G92 U{move.axes[3].max} ; Set Home Position
G90 ; absolute positioning

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
