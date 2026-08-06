; Dust shoe configuration
;
; The shoe hangs off the Z carriage on its own U axis. When engaged, U has to
; move opposite to Z so the bristles stay at a constant height above the work.
;
; That tracking used to be a polling loop in daemon.g. On RRF 3.7 it is an
; M581.1 expression trigger instead — see the note on dustShoeUseTrigger below.

global dustShoeEngaged    = false
global dustShoePrevZ      = move.axes[2].machinePosition
global dustShoeEngagedU   = 30   ; mm — default engaged U position in work coordinates, adjust to suit bristle contact

; How far Z may move before the shoe follows it.
;
; Every bit of it is dead band: the shoe sits this much out of position between
; corrections, and shrinking it buys accuracy nobody can see at the cost of a
; U move for every twitch of Z.
global dustShoeBand       = 0.1  ; mm

; Set when U runs out of travel and the shoe stops tracking. Cleared on engage.
global dustShoeSaturated  = false

; Which mechanism does the tracking.
;
; true  — M581.1 expression triggers (RRF 3.7 and later). The firmware watches
;         the expression and fires trigger2.g when it becomes true.
; false — nothing. The polling loop this used to fall back to has been taken
;         out of daemon.g: with the tracking in its own motion system, a second
;         thing reaching for U from motion system 0 does not idle quietly, it
;         reports "Drive U is already used by a different motion system" once
;         per move for as long as the machine is on.
;
; So on a firmware without M581.1 there is now no tracking at all rather than a
; slower kind. The loop is in daemon.g's history if it is ever needed back.
global dustShoeUseTrigger = true

; Tried and disproved: a second movement queue does not fix the lag.
;
; The theory was that the shoe waits because trigger2.g's G1 goes on the end of
; the same movement queue as the Z move that fired it, and a queue runs in
; order. RRF 3.5+ can plan a second queue independently (M596), so the shoe
; should have been able to move while Z did.
;
; It does not. With the trigger running in motion system 1 and U released to it
; properly, U still moves only after Z has finished — exactly as before. So the
; queue was never the constraint.
;
; What is left, most likely: the trigger reads move.axes[2].machinePosition,
; and if that only updates when a move completes then the expression cannot
; become true until Z has already arrived. The information is late, not the
; motion, and nothing about queues, trigger rates or polling intervals can
; make late information early. It is also why swapping the daemon for a trigger
; changed nothing measurable.
;
; Two failures were paid for on the way, both worth remembering because they
; are the cost of this feature rather than of this idea: an axis stays owned by
; the motion system that moved it until an M400 releases it (homing kept U),
; and a second claimant on the axis does not idle quietly, it errors on every
; move (daemon.g). The M400s in homeall.g and homeu.g are still there — they
; are good hygiene either way — and daemon.g stays empty.

if {global.dustShoeUseTrigger}
	; Trigger 2: the shoe has fallen behind Z by more than the dead band.
	;
	; Re-arming is the whole trick. M581.1 fires on a false→true edge, so this
	; would fire once and never again — except that trigger2.g rewrites
	; dustShoePrevZ, which makes the expression false and arms it for the next
	; move. An edge trigger doing a continuous job.
	;
	; R0 so it applies whether or not a file is running: the shoe has to follow
	; Z while jogging by hand just as much as during a job.
	M581.1 T2 P"global.dustShoeEngaged && move.axes[3].homed && abs(move.axes[2].machinePosition - global.dustShoePrevZ) > global.dustShoeBand" R0

	; Trigger 3: U has hit a limit while engaged, so tracking has stopped.
	; Guarded on dustShoeSaturated being false so it reports the transition
	; once rather than on every re-evaluation while the axis sits on its stop.
	M581.1 T3 P"global.dustShoeEngaged && !global.dustShoeSaturated && (move.axes[3].machinePosition <= move.axes[3].min + 0.2 || move.axes[3].machinePosition >= move.axes[3].max - 0.2)" R0
