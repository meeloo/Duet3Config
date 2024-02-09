(pick up tool one.)
(For a macro this example will need to be changed to match your set up using G53 machine coordinates.)
(This will only work if the current work offset is set X0Y0Z0 for the center of the pocket and at Z Engage Height.)
G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters
G53 ; Use machine coordinate system
G53 G0 Z50.0 ; Fast move to Z 50
G53 G0 X0 Y0 ; Fast move to X0 Y0
G53 G0 Z13.00 ; Fast move to Z 13
M3 S1400 ; Spindle On, Clockwise 1400 RPM
G4 S2 ; Pause for 2 s
G53 G1 Z0 F1800 ; Move to Z 0 1800mm/minute
G53 G0 Z8 ; Fast Move to Z 8
G4 S0.25 ; Pause for 0.25s
G53 G1 Z0 F1800 ; Move to Z 0 at 1800mm/min
G53 G0 Z50 ; Fast move to Z 50
M5 ; Spindle Off
G54 ; Go back to worksplace 1
;M2 ;M30 ; End of program (but on the RepRapFirmware M30 is use to delete a file on the SD Card... so using M2 instead). It is commented as it's not needed on the Duet board and it generates additional logs