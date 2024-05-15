; RapidChangeATC drop macro
echo "ATC Droping tool #" ^ {param.S}

if {global.atcEnabled = false}
	echo "ATC Disabled - skipping drop"
	M99

if {!exists(param.S)}
	echo "This macro expects an S parameter"
	M99
	
if {param.S} > global.atcCount
	echo "Requested tool index too big"
	M99

G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters

M98 P"atcOpenDustCover.g"

G53 G0 Z{global.atcRetractZ} ; Fast move to Z 50
G53 G0 X{global.atcOriginX + global.atcOffsetX * (param.S - 1)} Y{global.atcOriginY + global.atcOffsetY * (param.S - 1)} ; Fast move to the origin of the ATC
G53 G0 Z{global.atcDropStartZ} ; Fast move to Z engage position

M400
M4 S{global.atcDropRPM} ; Spindle On, Counterclockwise 1400 RPM

G4 S{global.atcSpindlePause} ; Pause for 2 s

G53 G1 Z{global.atcDropEndZ} F{global.atcDropFeed} ; Move to Z 0 1800mm per minute
G53 G1 Z{global.atcDropStartZ} ; Fast move to Z engage position

M400
M5 ; Spindle Off

; Check for tool drop success:
G53 G0 Z{global.atcPickupStartZ + 5}
G4 S1
if {sensors.gpIn[6].value} = 1
	M291 R"Tool drop check failed!" P"A tool was found by the IR detector. Cancelling further operations" S2
	abort "Tool drop check failed!"

G53 G0 Z{global.atcRetractZ} ; Fast Move to Z retract position

M98 P"atcCloseDustCover.g"
