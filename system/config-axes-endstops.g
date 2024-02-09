; Endstop configuration executed by config.g

M574 X1 S1 P"io0.in"                               ; configure switch-type (e.g. microswitch) endstop for low end on X via pin io0.in
M574 Y1 S1 P"io1.in"                               ; configure switch-type (e.g. microswitch) endstop for low end on Y via pin io1.in
M574 Z2 S1 P"io2.in"                               ; configure switch-type (e.g. microswitch) endstop for high end on Z via pin io2.in
M574 E1 S1 P"io3.in"                               ; XYZ Probe configure switch-type (e.g. microswitch) endstop for high end on Z via pin io3.in

;M574 X1 P"xstop" S1 ; Set active low X endstop
;M574 Y1 P"ystop" S1 ; Set active low Y endstop
;M574 Z2 P"zstop" S1 ; Set active low Z endstop