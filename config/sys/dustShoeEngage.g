; Engage dust shoe: move to work-coordinate U position, then enable Z tracking.
; Clamp the target to the axis limits expressed in work coordinates, so a large
; tool length offset cannot produce an out-of-range machine position.
var uOffset = {move.axes[3].machinePosition - move.axes[3].userPosition}
var targetU = {max(move.axes[3].min - var.uOffset, min(global.dustShoeEngagedU, move.axes[3].max - var.uOffset))}
G1 U{var.targetU} F8000
M400
set global.dustShoePrevZ   = move.axes[2].machinePosition
set global.dustShoeEngaged = true
echo "Dust shoe engaged at U=" ^ var.targetU
