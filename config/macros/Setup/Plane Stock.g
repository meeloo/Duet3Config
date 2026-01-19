; Plane a surface
var bitWidth = 0 ; set to zero if you want to flatten outside the maximum reach of your XY gantry
var advance = 4 ;0.1 * var.bitWidth ; 0 to 1 -> the amount of overlap
var feed = 2000 ; The speed of the XY movements while cutting
var speed = 18000 ; The spindle Speed

var minX = 0
var maxX = 365
var minY = 0
var maxY = 520

var distX = var.maxX - var.minX
var count = {var.distX / var.advance}
if var.count * var.advance != var.distX
	set var.count = var.count + 1

var direction = true

echo "Start"
G91 ; relative positioning
G21 ; mm

;echo "Goto Start"
;G53 G0 X{var.minX} Y{var.minY} ; Go to start

;T0 P0 ; Pretend that the tool is already setup

;T0 P0 M3 S{var.speed} ; turn on the spindle clockwise
echo "Wait for spindle"
G4 S5 ; Wait for the spindle to get to speed

echo "Starting to plane the stock"

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
echo "Stock flattening successful"
