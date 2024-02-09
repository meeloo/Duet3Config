; Axes configuration executed by config.g
M564 H0 ; enable move before homing

M584 X0 Y1 Z2 P3 ; Apply drive mapping to axes
;M584 P3
M584 X0.0 Y0.1:0.2 Z0.3                            ; set drive mapping
M906 X2400 Y2400 Z2400 I50 ; Set motor currents (mA)
M350 X16 Y16 Z16 I1 ; Configure microstepping
M203 X4000 Y3000 Z1500 ; Set maximum speeds (mm/min)
;M203 X10000.00 Y10000.00 Z3000.00                  ; set maximum speeds (mm/min)
M201 X200 Y200 Z150 ; Set accelerations (mm/s^2)
;M201 X500.00 Y500.00 Z100.00                       ; set accelerations (mm/s^2)
;M566 X500 Y500 Z500 U500 ; Set maximum instantaneous speed changes (mm/min)
M566 X200.00 Y200.00 Z200.00                        ; set maximum instantaneous speed changes (mm/min)
;M669 K0 X1:0:0:0 Y0:1:1:0 Z0:0:0:1
M669 K0
M84 S10                                            ; Set idle timeout
