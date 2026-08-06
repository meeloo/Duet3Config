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

; Report what each firing of trigger2.g actually saw. Off by default — one line
; per correction is a lot of console. `set global.dustShoeDebug = true` turns it
; on without editing a file or restarting.
;
; It prints both Z positions, because the difference between them is the whole
; question: machinePosition updates while the axis moves, userPosition does not
; move until the move completes — which means that during a move userPosition
; is the ENDPOINT. If that holds, the shoe can be sent to where Z is going in
; one move instead of chasing where Z has been in 0.1mm steps.
global dustShoeDebug = false

; How many times trigger2.g has run since the shoe was engaged.
;
; A counter rather than counting console lines, because console lines are not
; evidence: a trigger firing every 0.1mm of a 50mm move would emit hundreds of
; messages in a couple of seconds, and whatever the board's output buffers drop
; is invisible. The count survives regardless — `echo global.dustShoeFires`
; after a jog says exactly how many corrections were attempted.
;
; The number to compare it against: a 50mm Z move with a 0.1mm dead band should
; fire around 500 times if the trigger re-arms during the move, and once if
; trigger polling stays suspended until the whole correction has finished.
; Those two answers mean very different things, and nothing else distinguishes
; them from outside.
global dustShoeFires = 0

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
;
; --- What was actually measured, so none of it is guessed at twice ----------
;
; The trigger is not the problem. It fires 0.3mm into a 50mm move with the
; machine still busy, reading live positions. machinePosition and userPosition
; are BOTH live and differ only by the work offset — neither one holds the
; endpoint of the move, so there is no look-ahead to be had from the object
; model.
;
; dustShoeFires said 1 for a whole 50mm jog, and U ended clamped at its
; maximum: a single correction attempting the entire delta, arriving after Z
; had stopped. So the shoe gets one chance per Z move and it is always late.
; No dead band, trigger rate, motion system or polling interval changes that —
; they all sit downstream of it.
;
; The only software shape that can work is U travelling in the same G1 as Z,
; because that is the one place in RRF where two axes are guaranteed to
; interpolate together. It needs every source of Z motion to emit the U term:
; the jog buttons, these macros, and the Fusion post. Rejected as too easy to
; get silently wrong in one of the three.
;
; Coupled kinematics looked like the answer and is not, for a reason specific
; to this machine rather than to the idea. M669 exposes the movement
; coefficient matrix, so "U motor = U axis - Z axis" would make the shoe hold
; station inside the planner with no tracking at all:
;
;   M669 K0 X1:0:0:0 Y0:1:0:0 Z0:0:1:0 U0:0:-1:1
;
; But a tool change takes Z from atcRetractZ (135) down to atcDropEndZ (10),
; and holding station across 125mm of Z needs 125mm of U motor travel. U has
; 70. Soft limits are checked on the AXIS, not the motor, so nothing would stop
; it: the motor runs out and the shoe is dragged the remaining 55mm into the
; pocket while the spindle is threading a tool. Leaving the coupling on is
; therefore not an option, and switching it off per tool change means a runtime
; kinematics change inside tfree/tpre.
;
; Which is the real conclusion: one 70mm axis is being asked to do two jobs
; with incompatible ranges — hold station against 125mm of Z travel, and park
; clear of the pockets on demand. That is a mounting problem, not a firmware
; one. A shoe carried by the carriage above the Z travel needs no tracking and
; keeps U for parking alone.
;
; Until then this is the resting state and it works: the shoe follows Z one
; move behind, saturates gracefully with a message when it runs out of travel,
; and retracts for tool changes exactly as it always did.

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
