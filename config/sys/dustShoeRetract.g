; Retract dust shoe: stop following Z, then park at the top of its travel.
;
; Stop first, park second. With the shoe held to Z, a G1 on U is two things
; deciding the same axis — and the one that wins is not the one that was asked
; last.

M98 P"dustShoeRelease.g"
G53 G1 U{move.axes[3].max} F8000
M400
echo "Dust shoe retracted"
