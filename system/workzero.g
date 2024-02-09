; workzero.g
; called when GO TO WORK ZERO is pressed in WorkBee Control

G90
G53 G1 Z{move.axes[2].max} F1500 ; raise the Z to the highest position
G1 X0 Y0 F1500 ; go directly above the work zero position
G1 Z0 F1500 ; go to the work Z zero position 