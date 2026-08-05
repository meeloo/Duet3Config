; Engage dust shoe: move to work-coordinate U position, then enable Z tracking.
; Clamp the target to the axis limits expressed in work coordinates, so a large
; tool length offset cannot produce an out-of-range machine position.
var uOffset = {move.axes[3].machinePosition - move.axes[3].userPosition}
var targetU = {max(move.axes[3].min - var.uOffset, min(global.dustShoeEngagedU, move.axes[3].max - var.uOffset))}
G1 U{var.targetU} F8000
M400
set global.dustShoePrevZ   = move.axes[2].machinePosition
if {exists(global.dustShoeSaturated)}
	set global.dustShoeSaturated = false
set global.dustShoeEngaged = true
; Both coordinates. targetU is a work position, and reporting only that made
; "engaged at U=30" look like it sat mid-travel on an axis whose limits are
; machine coordinates — which is exactly the confusion that made the saturation
; warning unreadable.
echo "Dust shoe engaged at U=" ^ var.targetU ^ " (machine " ^ move.axes[3].machinePosition ^ ", limits " ^ move.axes[3].min ^ ".." ^ move.axes[3].max ^ ")"
