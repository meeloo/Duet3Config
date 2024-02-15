;;Probe TOOL TCP
;;List of Variables
;; LOAD LOCATION XY = X-339.2 Y-798.4		; specify your desired load location based on global machine coordinate system in millimeters 
;; PROBE LOCATION XY = X-553.625 Y-814.525	; specify your desired load location based on global machine coordinate system in millimeters 
;; TOOL # = 0	; Specify your desired tool " Tool 0 is my default active tool number"
;; K# = 2 	; Specify the probe you want to used, this is configured in your Config.g file
;
;
;G21				                    			; make sure we’re in mm
;G90   											; Absolute Mode	
;G53 G0 Z{global.atcRetractZ} 					; Raise Head
;
;
;;Tool  Probe Z
;G53 G0 X{global.atcProbeX} Y{global.atcProbeX} 	; Use machine coordinates Move to Z Probe Location
;G30 S-2 K2 X0 Y0 	               				; Probe in the Z direction and update tool z offset
;M500	                						; Save axis length to config-override.g
;
;
;; END
;G53 G0 Z{global.atcRetractZ} 					; Raise Head
;
;M291 P"Probing complete. Tool Offset Updated." R"Success" S1    ; screen message
;
;M5 ; Spindle Off
;
;
;
;
;
;
;
;;------------------------------------------- OTHER VERSION
;M208 Z8 S1 ; Set axis max travel
; 
;G53 G90 G0 X321.0 Y0.0 ; Use machine coordinates with absolute positioning and go to given XY
; 
;if !exists(global.MGlobalsLoaded)
;	M98 P"/macros/Measuring/globals.g"
;	
;;M558 P1 C"io7.in" H23.258 F{global.MSpeedFast,global.MSpeedLow}	
; 
;M558 F{global.MSpeedFast} K1 ; Set Z probe type for probe 1
; 
;M300 S300 P1000 ; Play beep sound
;if state.currentTool = -1
;    M291 S0 T5 P"Probing the spindle zero height" ; Display message and optionally wait for response
;else
;	if global.HSpindle <= -9999
;		abort S"Please set the spindle zero first"
;	M291 S0 T5 P"Probing the tool " ^ state.currentTool ^" offset" ;  Display message and optionally wait for response
; 
; 
;M558 F{global.MSpeedFast} K1 ; Set Z probe type for probe 1
; 
;G30 S-1 K1 ; Single Z-Probe 1 and reports the Z value when the probe triggers
;G53 G1 Z{move.axes[2].machinePosition+2} H4 ; Use machine coordinates and move up 2mm (Sense endstops while moving, update the current position at which the endstop switch triggers)
; 
;M558 F{global.MSpeedLow} K1 ; Set Z probe type for probe 1
;G30 S-1 K1 ; Single Z-Probe 1 and reports the Z value when the probe triggers
; 
; 
;if state.currentTool = -1
;  G92 Z{sensors.probes[1].diveHeight}  ; Set User Position
;  set global.HSpindle = sensors.probes[1].diveHeight
;  set global.MResultZ = sensors.probes[1].diveHeight
;  M208 Z30 S1
;else
;	M400
;	echo "Probe triggered at Z:" ^ move.axes[2].machinePosition ^" Sensor height: " ^ sensors.probes[1].diveHeight
;	var ToolLen = move.axes[2].machinePosition - sensors.probes[1].diveHeight
;	set global.MResultZ = - var.ToolLen
;	M98 P"/sys/tool_set.g" T{state.currentTool} O{global.MResultZ}
;	
;	; Set soft limit to 0 plane
;	M208 Z{var.ToolLen} S1
;	
; 
; 
;M558 F{global.MSpeedFast} K1
;G53 G1 Z{move.axes[2].max - 10} H4
;