; Engage dust shoe: move to engaged position and enable Z tracking
G53 G1 U{global.dustShoeEngagedU} F8000
M400
set global.dustShoePrevZ   = move.axes[2].machinePosition
set global.dustShoeEngaged = true
echo "Dust shoe engaged at U=" ^ global.dustShoeEngagedU
