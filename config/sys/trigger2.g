; trigger2.g — the dust shoe follows Z
;
; Fired by the M581.1 expression registered in dustShoeConfig.g, which is true
; whenever the shoe has fallen more than the deadband behind Z.
;
; The trigger re-arms itself. M581.1 fires on a false→true edge, so a trigger
; that only ever became true once would be useless for tracking — but the last
; line here rewrites global.dustShoePrevZ to the Z it just compensated for,
; which makes the expression false again and ready to fire on the next move.
; That is what lets an edge trigger do a job that used to need a polling loop.
;
; Why this is better than the daemon it replaces: the firmware evaluates the
; expression itself, rather than a `while true` loop in daemon.g waking every
; 50ms to ask the same question and finding the answer is usually "nothing to
; do". The shoe also follows sooner, because the check happens at the
; firmware's own rate rather than at whatever the daemon's G4 P50 grants it.

; Nothing to follow while the machine is halted, and the G1 below would be
; refused anyway. Same reasoning as the guard in daemon.g, which learned it the
; expensive way.
if {state.status == "halted" || state.status == "off"}
	M99

; What this firing actually saw. See dustShoeDebug in dustShoeConfig.g: the gap
; between the two Z figures says whether the trigger fired while Z was still
; travelling, and whether userPosition is holding the endpoint of the move.
if {global.dustShoeDebug}
	echo "trig Zm=" ^ move.axes[2].machinePosition ^ " Zu=" ^ move.axes[2].userPosition ^ " prev=" ^ global.dustShoePrevZ ^ " Um=" ^ move.axes[3].machinePosition ^ " " ^ state.status

; The Z this move is compensating for, sampled once. Z is still moving, and
; taking it twice would compensate for one position and record another —
; leaving a permanent offset that never gets corrected.
var nowZ   = {move.axes[2].machinePosition}
var deltaZ = {var.nowZ - global.dustShoePrevZ}

; The shoe hangs off the Z carriage, so U moves opposite to Z to keep the
; bristles at the same height above the work.
var wantU = {move.axes[3].machinePosition - var.deltaZ}
; min(max(…)) rather than a clamp function: RRF has no constrain(), which this
; line claimed it did — "unknown function" at the open bracket, every firing.
; The same shape is already in dustShoeEngage.g, which is where it should have
; been copied from in the first place.
var loU   = {move.axes[3].min}
var hiU   = {move.axes[3].max}
var gotU  = {min(max(var.wantU, var.loU), var.hiU)}

G53 G1 U{var.gotU} F8000

; Only what was actually achieved. Recording the Z we wanted to reach while U
; was clamped short of it would tell the next firing that the shoe is caught
; up when it is not — and the shoe would never recover once the axis came back
; off its limit.
if {var.gotU == var.wantU}
	set global.dustShoePrevZ = var.nowZ
else
	set global.dustShoePrevZ = {var.nowZ - (var.wantU - var.gotU)}
	set global.dustShoeSaturated = true
