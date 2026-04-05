; Retract dust shoe: disable Z tracking then move to max (safe) position
set global.dustShoeEngaged = false
G53 G1 U{move.axes[3].max} F8000
M400
echo "Dust shoe retracted"
