; Engage dust shoe: move to the working U position, then start following Z.
;
; The order is not a style choice and cannot be swapped. M604 CAPTURES the
; separation between the two axes at the moment it is engaged rather than taking
; an absolute target, so engaging before the move would faithfully hold the shoe
; wherever it happened to be parked — a correct relationship about the wrong
; place, which looks like it worked.

if {!move.axes[3].homed}
	echo "Dust shoe: U is not homed, so there is no position to hold it at. Home U first."
	M99

; Let go of any relationship still in force before positioning, or the move
; below fights it: with U held to Z, a G1 on U is asking two things to decide
; the same axis.
M98 P"dustShoeRelease.g"

; Read once. Nested exists() rather than one `&&` expression — see the note in
; dustShoeRelease.g — and kept in a var so the echo at the end can say what is
; in force without repeating the guard.
var tracking = "none"
if {exists(global.dustShoeTracking)}
	set var.tracking = global.dustShoeTracking

; Clamp the target to the axis limits expressed in work coordinates, so a large
; tool length offset cannot produce an out-of-range machine position.
var uOffset = {move.axes[3].machinePosition - move.axes[3].userPosition}
var targetU = {max(move.axes[3].min - var.uOffset, min(global.dustShoeEngagedU, move.axes[3].max - var.uOffset))}
G1 U{var.targetU} F8000
M400

set global.dustShoePrevZ   = move.axes[2].machinePosition
if {exists(global.dustShoeFires)}
	set global.dustShoeFires = 0
if {exists(global.dustShoeSaturated)}
	set global.dustShoeSaturated = false

; A"U" follows B"Z". No scale given: it defaults to -1, which is what a shoe
; carried on the Z carriage needs — down on Z is up on U for the bristles to
; stay put — and is the same relationship the old daemon expressed as
; `targetU = U - deltaZ`. Left to the default rather than written out, because
; the parameter letter for it is not documented and guessing at one produces a
; command that looks right and is ignored.
;
; After the M400, so what gets captured is where the axes have actually arrived
; rather than where they were on the way.
if {var.tracking == "m604"}
	M604 A"U" B"Z" E1

set global.dustShoeEngaged = true

; Both coordinates. targetU is a work position, and reporting only that made
; "engaged at U=30" look like it sat mid-travel on an axis whose limits are
; machine coordinates — which is exactly the confusion that made the saturation
; warning unreadable.
echo "Dust shoe at U" ^ var.targetU ^ " (machine " ^ move.axes[3].machinePosition ^ ", limits " ^ move.axes[3].min ^ ".." ^ move.axes[3].max ^ "), tracking: " ^ var.tracking
