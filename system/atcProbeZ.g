;Probe TOOL TCP
;List of Variables
; LOAD LOCATION XY = X-339.2 Y-798.4		; specify your desired load location based on global machine coordinate system in millimeters 
; PROBE LOCATION XY = X-553.625 Y-814.525	; specify your desired load location based on global machine coordinate system in millimeters 
; TOOL # = 0	; Specify your desired tool " Tool 0 is my default active tool number"
; K# = 2 	; Specify the probe you want to used, this is configured in your Config.g file


G21				                    			; make sure we’re in mm
G90   											; Absolute Mode	
G53 G0 Z{global.atcRetractZ} 					; Raise Head


;Tool  Probe Z
G53 G0 X{global.atcProbeX} Y{global.atcProbeX} 	; Use machine coordinates Move to Z Probe Location
G30 S-2 K2 X0 Y0 	               				; Probe in the Z direction and update tool z offset
M500	                						; Save axis length to config-override.g


; END
G53 G0 Z{global.atcRetractZ} 					; Raise Head

M291 P"Probing complete. Tool Offset Updated." R"Success" S1    ; screen message

M5 ; Spindle Off
