G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters
G53 ; Use machine coordinate system
G53 G0 Z50.0 ; Fast move to Z 50
G53 G0 X0 Y0 ; Fast move to X0 Y0
G53 G0 Z13.00 ; Fast move to Z 13
M4 S1400 ; Spindle On, Counterclockwise 1400 RPM
G4 S2 ; Pause for 2 s
G53 G1 Z0 F1800 ; Move to Z 0 1800mm per minute
G53 G0 Z50 ; Fast Move to Z 50
M5 ; Spindle Off
;M2 ;M30 ; End of program (but on the RepRapFirmware M30 is use to delete a file on the SD Card... so using M2 instead). It is commented as it's not needed on the Duet board and it generates additional logs