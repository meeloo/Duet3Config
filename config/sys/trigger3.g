; trigger3.g — the dust shoe has stopped following Z
;
; This is the failure the old daemon could not report. It clamped the U target
; to the axis limits and carried straight on, so once the axis ran out of
; travel the shoe silently stopped tracking: bristles either lifted clear of
; the work, extracting nothing, or driven into it and bent over.
;
; It is not a corner case on this machine. Z travels 0..135 and U travels
; 0..70, so any Z move longer than 70mm exhausts the shoe's travel by
; construction — and pause.g lifts Z to its maximum, which does exactly that
; every time a job is paused with the shoe engaged.
;
; Reported rather than acted on. Retracting the shoe here would be a machine
; deciding by itself to stop extracting dust mid-cut, and stopping the job
; would turn a cosmetic problem into a scrapped part. The operator is told, and
; can choose.

; The numbers, not just the complaint.
;
; The first time this fired, U was reported as 30 on an axis that travels 0..70
; and the message gave no way to tell whether the axis really was at a stop or
; the trigger was wrong — which cost a round trip to find out. A diagnostic that
; needs a follow-up question is half a diagnostic.
;
; machinePosition is what the soft limits are in; userPosition is what the
; engage macro's "U=30" was in. When those two disagree the offset is the
; answer, and this line shows both.
M118 P0 S{"Dust shoe: out of travel — U is at " ^ move.axes[3].machinePosition ^ " (work " ^ move.axes[3].userPosition ^ ") against limits " ^ move.axes[3].min ^ ".." ^ move.axes[3].max ^ ". The shoe is no longer following Z; extraction is compromised until Z comes back within range."}

; Left set so the state is visible in the object model and in Axis Control
; after the message has scrolled away. dustShoeEngage.g clears it.
set global.dustShoeSaturated = true
