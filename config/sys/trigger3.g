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

M118 P0 S"Dust shoe: out of travel — U has hit its limit and the shoe is no longer following Z. Extraction is compromised until Z comes back within range."

; Left set so the state is visible in the object model and in Axis Control
; after the message has scrolled away. dustShoeEngage.g clears it.
set global.dustShoeSaturated = true
