;Probe TOOL TCP
if {global.atcEnabled = false}
	echo "ATC Disabled - skipping probe"
	M99

if {global.atcProbingEnabled = false}
	echo "ATC Probing Disabled - skipping probe"
	M99


M558 K0 P5 C"!io5.in" H5 F500 T500 ; Z Probe for tool length

G21				                    			; make sure we’re in mm
G90   											; Absolute Mode	
G53 G0 Z{global.atcRetractZ} 					; Raise Head

G53 G0 X{global.atcProbeX} Y{global.atcProbeY} 	; Use machine coordinates Move to Z Probe Location
G10 L1 X0 Y0 Z0 ; Reset tool offset
echo "Start probing Z for current tool from " ^ {move.axes[2].machinePosition}
M585 Z{-(global.atcRetractZ - global.atcProbeZ)} P0 F500 S1 ; Reach for the probe
var newOffset = {-(move.axes[2].machinePosition - global.atcProbeZ)}
echo "Probed tool at " ^ {move.axes[2].machinePosition} ^ " New offset = " ^ {var.newOffset} ^ " (Z Probe height = " ^ {global.atcProbeZ} ^ ")"
G10 L1 Z{var.newOffset} ; Set Tool offset to the distance in between the current Z position and the probe Z position

G53 G0 Z{global.atcRetractZ} 					; Raise Head

; Go Back to XYZ Probe
M558 P5 F500 C"!io3.in" ; XYZ Probe
