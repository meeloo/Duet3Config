;Probe TOOL TCP
if {global.atcEnabled = false}
	echo "ATC Disabled - skipping probe"
	M99

if {global.atcProbingEnabled = false}
	echo "ATC Probing Disabled - skipping probe"
	M99


;M558 K0 P5 C"!io5.in" H5 F500 T500 ; Z Probe for tool length

G21				                    			; make sure we’re in mm
G90   											; Absolute Mode	
G53 G0 Z{global.atcRetractZ} 					; Raise Head

G53 G0 X{global.atcProbeX} Y{global.atcProbeY} 	; Use machine coordinates Move to Z Probe Location
G10 L1 X0 Y0 Z0 ; Reset tool offset
echo "Start probing Z for current tool from " ^ {move.axes[2].machinePosition}
M585 Z{-(global.atcRetractZ - global.atcProbeZ)} P0 F500 S1 ; Reach for the probe
var newOffset = {-(move.axes[2].machinePosition - global.atcProbeZ)}
echo "Probed tool at " ^ {move.axes[2].machinePosition} ^ " New offset = " ^ {var.newOffset} ^ " (Z Probe height = " ^ {global.atcProbeZ} ^ ")"
; Set the tool offset to the distance between the current Z position and the
; probe Z position.
;
; The dust shoe used to get a U term here — the inverse of the same offset. It
; did not move the shoe; it shifted U's WORK coordinate so that
; dustShoeEngage.g's fixed work-coordinate target landed at a machine position
; corrected for tool length. Under M604 the firmware holds U to Z in MACHINE
; coordinates and after tool offsets, so a longer tool raises the carriage and
; the shoe comes down by exactly as much on its own, and the term does nothing.
;
; Conditional rather than deleted: it is still what keeps the shoe level on a
; firmware without M604, and dropping it there is silent — valid G-code, machine
; runs, bristles at the wrong height for every tool but the one they were set
; with.
; Nested, not `exists(...) && ...` — see the note in dustShoeRelease.g.
var shoeInFirmware = false
if {exists(global.dustShoeTracking)}
	set var.shoeInFirmware = {global.dustShoeTracking == "m604"}

if {var.shoeInFirmware}
	G10 L1 Z{var.newOffset}
else
	G10 L1 Z{var.newOffset} U{-var.newOffset}

G53 G0 Z{global.atcRetractZ} 					; Raise Head

; Go Back to XYZ Probe
;M558 P5 F500 C"!io3.in" ; XYZ Probe
