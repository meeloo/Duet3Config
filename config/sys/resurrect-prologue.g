; resurrect-prologue.g
; called to resume job after power out.

M98 P"homeall.g"
G1 R1 X0 Y0 ; go directly above the saved position
