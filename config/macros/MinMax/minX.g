G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters
G53 G0 X{move.axes[0].min} ; Fast move Use machine coordinate system
