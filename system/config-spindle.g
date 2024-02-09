; Laser configuration executed by config.g

; Define the Spindle VFD
M950 R0 C"vfd+nil+io4.out" Q2000 L0:24000 K0:1 

; Define tools:
M563 P1 R0 S"Spindle tool 1"
M563 P2 R0 S"Spindle tool 2"
M563 P3 R0 S"Spindle tool 3"
M563 P4 R0 S"Spindle tool 4"
M563 P5 R0 S"Spindle tool 5"
M563 P6 R0 S"Spindle tool 6"
M563 P7 R0 S"Spindle tool 7"
M563 P8 R0 S"Spindle tool 8"

; Define the out4 to send the forward or reverse commands to the relay:
;M950 P1 C"io4.out" Q500
