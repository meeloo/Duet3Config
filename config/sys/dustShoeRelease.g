; Stop the dust shoe following Z. Does not move anything.
;
; Split out of dustShoeRetract.g because there are two different reasons to stop
; tracking and only one of them wants a move. Retracting parks the shoe out of
; the way for a tool change; this one just lets go — which is what homing needs,
; where parking is either pointless (U is about to be homed anyway) or
; impossible (G53 on an unhomed axis is refused).
;
; Why homing has to let go at all, under M604: the relationship is
; `U = -Z + offset` in MACHINE coordinates, so `G1 H1 Z…` drags U to its stop
; while Z travels, and the `G92 Z…` that follows redefines Z's machine position
; underneath an offset that was captured against the old one. The shoe would
; then hold station against a coordinate frame that no longer exists. Letting go
; first costs nothing; the operator re-engages when the machine is homed.
;
; Safe to call unconditionally: it checks its own globals, so a machine whose
; dust shoe configuration has been removed — or one running an older
; dustShoeConfig.g that predates M604 — runs it as a no-op rather than failing
; to home.
;
; Parameters:
;   S1   say so, if it was actually engaged. See below.

if {!exists(global.dustShoeEngaged)}
	M99

; Nested rather than one `exists(x) && x == …` expression. RRF is documented to
; evaluate && lazily, but nothing else in this configuration relies on it and the
; cost of being wrong is a macro that fails on a machine that cannot be tested
; from here. Two extra lines are cheaper than that bet.
var inFirmware = false
if {exists(global.dustShoeTracking)}
	set var.inFirmware = {global.dustShoeTracking == "m604"}

; Announced only when asked, because the two callers want different things said.
; A tool change releases and re-engages either side of itself and has nothing to
; report; homing releases and does NOT put it back, and a shoe that quietly
; stopped following is noticed when the dust starts going everywhere.
if {exists(param.S)}
	if {param.S == 1 && global.dustShoeEngaged}
		echo "Dust shoe released — it is no longer following Z. Engage it again when the machine is homed."

; Sent whether or not the global says engaged, because the two can disagree: the
; firmware keeps the relationship across a macro that failed halfway, and the
; global is only this file's opinion of it. Guarded on the mechanism rather than
; on the state, since that is what decides whether the command exists at all.
if {var.inFirmware}
	M604 E0

set global.dustShoeEngaged = false
