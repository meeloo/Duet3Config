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
; OFF — on a board that has the second queue and still cannot use it.
;
; This one reports move.queue[1], so detection turned it on, and then every Z
; move produced "Drive U is already used by a different motion system" from
; trigger2.g. An axis belongs to whichever motion system last moved it until
; that system gives it back, and system 0 is holding U: homeu.g and homeall.g
; both drive U and neither ends with an M400, so it is claimed from the first
; homing onwards. The current tool carries a U offset as well (atcProbeZ.g sets
; one with G10 L1), and M400's release explicitly skips axes the current tool
; needs — so adding M400 to the homing files may not be enough to free it.
;
; Kept rather than deleted, because the blockage is ownership and not queues:
; `set global.dustShoeQueue = 1` from the console tries it again once U is
; genuinely free. Detecting the queue and switching it on by itself is what
; must not come back — that reintroduces an error on every Z move at the next
; restart, which is how this was found.
global dustShoeQueue = 0

; Read it back with `echo global.dustShoeQueue` — this is deliberately a global
; and not just a message. config.g runs before any browser has connected, so
; anything echoed here goes to a channel nobody is listening on and is gone by
; the time the console opens. A value in the object model is still there.
echo "Dust shoe: movement queue " ^ global.dustShoeQueue

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
