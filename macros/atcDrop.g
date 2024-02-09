; RapidChangeATC drop macro
if !exists(param.S)
	echo "This macro expects an S parameter"
	M99
	
if {param.S} >= global.atcCount
	echo "Requested tool index too big"
	M99

G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters
G53 ; Use machine coordinate system

G53 G0 Z{global.atc.RetractZ} ; Fast move to Z 50
G53 G0 X{global.atcOriginX + global.atcOffsetX * param.S} Y{global.atcOriginY + global.atcOffsetY * param.S} ; Fast move to the origin of the ATC
G53 G0 Z{global.atcDropStartZ} ; Fast move to Z engage position

M4 S{global.atcDropRPM} ; Spindle On, Counterclockwise 1400 RPM

G4 S{global.atcSpindlePause} ; Pause for 2 s

G53 G1 Z{global.atcDropEndZ} F{global.atcDropFeed} ; Move to Z 0 1800mm per minute
G53 G0 Z{global.atcRetractZ} ; Fast Move to Z retract position

M5 ; Spindle Off
