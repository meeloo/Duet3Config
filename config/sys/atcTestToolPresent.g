; atcTest Tool

if !{exists(global.atcToolHasBeenDetected)}
	global atcToolHasBeenDetected = true

set global.atcToolHasBeenDetected = true
var loopCounter = 0
var counter = 0

set var.loopCounter = 0
set var.counter = 0
while var.loopCounter < 10
	G4 P100 ; Wait for xx milliseconds
	set var.loopCounter = iterations
	set var.counter = {var.counter + sensors.gpIn[6].value}
	set global.atcToolHasBeenDetected = var.counter < 2
	;echo "toolStillOn:"
	;echo {global.atcToolHasBeenDetected}
	;echo " counter = "
	;echo {var.counter}

if global.atcToolHasBeenDetected
	echo "Tool Has Been Detected"
else
	echo "Tool Has NOT Been Detected"

