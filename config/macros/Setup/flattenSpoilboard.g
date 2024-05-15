; Flatten the spoilboard on all the surface
var bitWidth = 0 ; set to zero if you want to flatten outside the maximum reach of your XY gantry
var advance = 25 ;0.1 * var.bitWidth ; 0 to 1 -> the amount of overlap
var feed = 2000 ; The speed of the XY movements while cutting
var speed = 15000 ; The spindle Speed

var minX = {move.axes[0].min + var.bitWidth}
var maxX = {move.axes[0].max - var.bitWidth}
var minY = {move.axes[1].min + var.bitWidth}
var maxY = {move.axes[1].max - var.bitWidth}

var distX = var.maxX - var.minX
var count = {var.distX / var.advance}
if var.count * var.advance != var.distX
	set var.count = var.count + 1

var direction = true

echo "Start"
G90 ; absolute positioning
G21 ; mm

echo "Goto Start"
G53 G0 X{var.minX} Y{var.minY} ; Go to start

;T0 P0 ; Pretend that the tool is already setup

;T0 P0 M3 S{var.speed} ; turn on the spindle clockwise
echo "Wait for spindle"
G4 S5 ; Wait for the spindle to get to speed

echo "Starting to flatten the spoil board"

var posX = move.axes[0].machinePosition
while {var.count > 0}
	if {var.direction}
		echo "Go Y forward"
		G53 G1 Y{var.maxY} F{var.feed}
	else
		echo "Go Y backward"
		G53 G1 Y{var.minY} F{var.feed}
	set var.direction = {!var.direction}
	
	set var.posX = {min(var.maxX, (iterations + 1) * var.advance + var.minX)}
	echo "Advance X to " ^ {var.posX}
	G53 G1 X{var.posX}
	set var.count = var.count - 1

echo "DONE"

M400 ; wait for the end
;M5 ; Stop the spindle
echo "Spoil board flattening successful"
