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

; Move the shoe in its own movement queue, so it moves WHILE Z does.
;
; Without this the G1 below goes on the end of the same queue as the Z move
; that fired the trigger, and a queue runs in order — so the shoe waited for
; the whole Z move to finish before starting, however promptly the trigger
; fired. That is what made the tracking feel nothing like real time, and no
; amount of polling faster would have touched it.
;
; Skipped when the firmware has no second queue (see dustShoeConfig.g), where
; it would only throw and abandon the tracking altogether.
if {global.dustShoeQueue != 0}
	M596 P{global.dustShoeQueue}

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

; Wait for that move, then let go of U.
;
; Both halves matter. The wait is on THIS channel only — the job's Z carries on
; in queue 0 — and it is what stops the trigger re-arming and stacking a second
; correction on top of one still running.
;
; The release is what lets anything else have the axis: an axis is owned by the
; motion system that moved it, so without this the shoe would keep U to itself
; and dustShoeEngage.g, dustShoeRetract.g, homeu.g and the tool change would
; all be waiting on a trigger to give it back.
if {global.dustShoeQueue != 0}
	M400 S0

; Only what was actually achieved. Recording the Z we wanted to reach while U
; was clamped short of it would tell the next firing that the shoe is caught
; up when it is not — and the shoe would never recover once the axis came back
; off its limit.
if {var.gotU == var.wantU}
	set global.dustShoePrevZ = var.nowZ
else
	set global.dustShoePrevZ = {var.nowZ - (var.wantU - var.gotU)}
	set global.dustShoeSaturated = true
