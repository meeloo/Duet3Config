; RapidChangeATC pickup macro
echo "Pickup tool #" ^ {param.S}

if {global.atcEnabled = false}
	echo "ATC Disabled - skipping pickup"
	M99

if {!exists(param.S)}
	echo "This macro expects an S parameter"
	M99
	
if {param.S >= global.atcCount}
	echo "Requested tool index too big"
	M99

G90 ; Absolute positioning
G94 ; Feed Rate Mode (Units per Minute)
G17 ; Select XY plane for arc moves
G21 ; Set units to millimeters

G53 G0 Z{global.atcRetractZ} ; Fast move to Z 50
G53 G0 X{global.atcOriginX + global.atcOffsetX * (param.S - 1)} Y{global.atcOriginY + global.atcOffsetY * (param.S - 1)} ; Fast move to the origin of the ATC
G53 G0 Z{global.atcPickupStartZ} ; Fast move to Z pickup position

M400
M3 S{global.atcPickupRPM} ; Spindle On, Clockwise 1400 RPM
G4 S{global.atcSpindlePause} ; Pause for 2 s

G53 G1 Z{global.atcPickupEndZ} F{global.atcPickupFeed} ; Move to Z 0 1800mm/minute
G53 G0 Z{global.atcPickupEndZ + 8} ; Fast Move to Z+8

G4 S0.25 ; Pause for 0.25s

G53 G1 Z{global.atcPickupEndZ} F{global.atcPickupFeed} ; Move to Z 0 at 1800mm/min
G53 G0 Z{global.atcPickupStartZ} ; Fast move to Z 50

M400
M5 ; Spindle Off
G53 G0 Z{global.atcRetractZ} ; Fast Move to Z retract position

