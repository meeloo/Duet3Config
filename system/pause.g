; pause.g
; called when a print from SD card is paused

G90
G53 G1 Z{move.axes[2].max} F1500 ; move the Z-Axis to the maximum position
G53 G1 X{move.axes[0].max} F2500 ; move the X-Axis to the maximum position
G53 G1 Y{move.axes[1].max} F2500 ; move the Y-Axis to the maximum position