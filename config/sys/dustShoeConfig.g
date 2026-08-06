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
; Ownership is the thing to get right, not the queue.
;
; "At any time, each motion system owns a set of physical axes and extruders.
; No other motion system can use those axes/extruders or that tool until the
; owning motion system releases it. Once a motion system starts using an axis
; or extruder, it owns it until it is released, usually with M400."
;
; That is why the first attempt failed with "Drive U is already used by a
; different motion system" on every Z move: homeall.g and homeu.g both drive U
; and neither ended with an M400, so motion system 0 held the axis from the
; first homing onwards and the tracking — running in system 1 — could never
; take it. Both files release it now.
;
; The tool exception in M400 ("except for axes needed by the current tool")
; does not apply here: the spindle tools are declared M563 P1 R0 S"…" with no
; axis mapping at all, so no tool needs U.
;
; `set global.dustShoeQueue = 0` from the console still forces the old
; single-queue path without editing a file or restarting — worth keeping,
; because RRF's own documentation calls multiple motion systems experimental.
global dustShoeQueue = 0
if {exists(move.queue[1])}
	set global.dustShoeQueue = 1

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
