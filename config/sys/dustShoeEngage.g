; Engage dust shoe: move to work-coordinate U position, then enable Z tracking.
; The U work offset should be set so that dustShoeEngagedU in work coords places
; the bristles at the correct height for the current tool — this naturally adapts
; to tool length offsets set after each tool change and probe.
G1 U{global.dustShoeEngagedU} F8000
M400
set global.dustShoePrevZ   = move.axes[2].machinePosition
set global.dustShoeEngaged = true
echo "Dust shoe engaged at U=" ^ global.dustShoeEngagedU
