; Dust shoe configuration
;
; The shoe hangs off the Z carriage on its own U axis. When engaged, U has to
; move opposite to Z so the bristles stay at a constant height above the work.
;
; That tracking has had three answers. A polling loop in daemon.g, then an
; M581.1 expression trigger, and now M604 — which is the only one that works.
; See dustShoeTracking below for which is in force and why the first two could
; not have worked.
;
; global.dustShoeEngaged is the marker meaning "this machine has a dust shoe",
; and it stays whatever the tracking mechanism is. The tool-change hooks in
; tfree*.g and tpost*.g are written as `if {exists(global.dustShoeEngaged)}`, so
; removing it in favour of asking the firmware would not move the state
; somewhere better — it would stop the hooks firing at all.

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

; Which mechanism does the tracking. One of "m604", "trigger" or "none".
;
; "m604" — the firmware holds U to Z inside the motion planner. The two become
;          one coordinated move, so the shoe does not follow Z, it travels WITH
;          it. Needs the meeloo/RepRapFirmware fork, branch feature/velocity-jog.
;          M604 is a provisional command number there: free in that firmware but
;          not blessed by Duet3D, so it may yet move.
;
; "trigger" — M581.1 expression triggers (RRF 3.7+) firing trigger2.g. Kept
;          selectable, and kept only because it is the thing to fall back to on
;          firmware without M604. It does not work well and cannot be made to:
;          see below.
;
; "none" — no tracking. The shoe still engages, retracts and parks; it simply
;          sits at a fixed height while Z moves.
;
; Why "trigger" cannot be fixed, so that nobody spends another week on it. The
; expression reads move.axes[2].machinePosition, and the object model reports
; where an axis IS, never where a move is GOING — machinePosition and
; userPosition are both live and differ only by the work offset. So the trigger
; cannot become true until Z has already moved, and the correction is always
; late by construction. Measured: dustShoeFires said 1 for a whole 50mm jog,
; with U ending clamped at its limit — one correction, attempting the entire
; delta, arriving after Z had stopped. No dead band, trigger rate, motion system
; or polling interval sits upstream of that.
;
; The polling loop that came before it is worse still and is not on this list:
; with the tracking in its own motion system, a second claimant on U from motion
; system 0 does not idle quietly, it reports "Drive U is already used by a
; different motion system" once per move for as long as the machine is on. That
; is why daemon.g is empty rather than deleted.
global dustShoeTracking   = "m604"

; Does this firmware have M581.1 expression triggers (RRF 3.7 and later)?
;
; Separate from the mechanism above because it is a separate fact, and because
; one of the two triggers is worth having whichever mechanism is tracking: T3
; reports the shoe running out of travel, which happens under M604 exactly as it
; did under the trigger — the firmware clamps the follower to its M208 range and
; leaves it resting on the stop while Z carries on.
;
; Set false on a firmware without M581.1, or registering the triggers below
; fails at boot.
global dustShoeHasTriggers = true

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
; --- What actually fixed it -------------------------------------------------
;
; Everything above is the record of trying to make a WATCHER work, and the
; conclusion that runs through all of it — the information is late, and nothing
; downstream of late information can make it early — turned out to be the answer
; rather than the obstacle. The one shape identified as workable was "U
; travelling in the same G1 as Z, because that is the one place in RRF where two
; axes are guaranteed to interpolate together", and it was rejected because it
; needed every source of Z motion to emit the U term: the jog buttons, these
; macros, and the Fusion post, any one of which could get it silently wrong.
;
; M604 is that shape, moved to where it only has to be right once. The
; relationship is applied inside the motion planner, so every source of Z motion
; gets it for free — including velocity jogging, which no post-processor could
; have covered. Measured skew between the two step trains is 0.0000 ms at the
; start, middle and end of a move.
;
; It is not the coupled-kinematics idea either, and does not inherit its
; problem: the follower is a real axis clamped to its own M208 range, so a tool
; change taking Z from 135 to 10 leaves the shoe resting on its stop rather than
; dragging it 55mm past the end of its travel into a pocket. Trigger 3 below
; still reports that, and it is still worth reporting.

if {global.dustShoeHasTriggers && global.dustShoeTracking == "trigger"}
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

; Trigger 3: U has hit a limit while engaged, so the shoe has stopped tracking.
;
; Registered whichever mechanism is doing the tracking — the M604 firmware
; clamps the follower to its M208 range just as trigger2.g did, so the shoe runs
; out of travel in exactly the same places and the operator needs telling in
; exactly the same way. It is not a corner case here: Z travels 0..135 and U
; travels 0..70, so any Z move longer than 70mm exhausts the shoe by
; construction, and pause.g lifts Z to its maximum.
;
; Guarded on dustShoeSaturated being false so it reports the transition once
; rather than on every re-evaluation while the axis sits on its stop.
if {global.dustShoeHasTriggers && global.dustShoeTracking != "none"}
	M581.1 T3 P"global.dustShoeEngaged && !global.dustShoeSaturated && (move.axes[3].machinePosition <= move.axes[3].min + 0.2 || move.axes[3].machinePosition >= move.axes[3].max - 0.2)" R0
