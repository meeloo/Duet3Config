; Axes configuration executed by config.g
M564 H0 ; enable move before homing

M584 X0 Y1 Z2 P3 ; Apply drive mapping to axes
;M584 P3
M584 X0.0 Y0.1:0.2 Z0.3                            ; set drive mapping
M906 X2400 Y2400 Z2400 I50 ; Set motor currents (mA)
M350 X16 Y16 Z16 I1 ; Configure microstepping
;M203 X7000 Y7000 Z2500 ; Set maximum speeds (mm/min)
M203 X6000.00 Y6000.00 Z2000.00                  ; set maximum speeds (mm/min)
M566 X100.00 Y100.00 Z100.00                        ; set maximum instantaneous speed changes (mm/min)
M201 X500 Y500 Z200 ; Set accelerations (mm/s^2)
;M201 X500.00 Y500.00 Z100.00                       ; set accelerations (mm/s^2)
;M566 X500 Y500 Z500 U500 ; Set maximum instantaneous speed changes (mm/min)
;M669 K0 X1:0:0:0 Y0:1:1:0 Z0:0:0:1
M669 K0 S10 ; Set kinematics type and kinematics parameters. S10 = break move commands to 10 segments per seconds
M84 S10                                            ; Set idle timeout
