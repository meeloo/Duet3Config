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
; false — the polling loop in daemon.g, which is what RRF 3.6 and earlier need.
;
; Left as a switch rather than detected, because getting it wrong in the
; direction of "assume 3.7" on a board that has been rolled back would leave
; the shoe not tracking at all, with nothing on screen saying so. Flip it by
; hand if you go back to 3.6.
global dustShoeUseTrigger = true

; Which movement queue the shoe's own moves go in.
;
; This is the whole latency question, and it is not about how fast the trigger
; fires. A G1 issued from trigger2.g is appended to the same movement queue as
; the Z move that fired it, and RRF runs a queue strictly in order — so the
; shoe cannot start moving until the Z move it is compensating for has
; finished. Polling faster never had a chance of fixing that; neither did the
; daemon before it. The move was never late, it was behind.
;
; RRF 3.5 and later can have a second movement queue, and a channel that
; selects it (M596) has its moves planned independently of queue 0. The shoe
; then moves WHILE Z moves rather than after it.
;
; Detected rather than assumed, because the secondary queue is build-dependent
; — "some builds of RRF have a secondary movement queue", per M595's own
; documentation. On a build without one this stays 0 and everything behaves
; exactly as it does today, which is the right way to be wrong.
;
; If the second queue turns out to misbehave, `set global.dustShoeQueue = 0`
; from the console puts the shoe straight back on the old single-queue path.
; No file to edit, no restart — which matters because the thing that goes
; wrong with a trigger is a trigger that throws on every firing.
global dustShoeQueue = 0
if {exists(move.queue) && #move.queue > 1}
	set global.dustShoeQueue = 1
	echo "Dust shoe: tracking on movement queue 1, concurrent with the job"
else
	echo "Dust shoe: single movement queue — the shoe follows Z one move behind"

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
