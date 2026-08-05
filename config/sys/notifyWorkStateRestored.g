; Show restored work coordinates at startup so user can verify before proceeding
; Built up in a var first. RRF reads a line into a 255-character buffer and
; refuses anything longer with "GCode command too long" — this M291 was 335,
; so the notification config.g asks for at every boot has never once appeared.
; The string is the same length either way; only the line holding it shrinks.
var g54 = {"X" ^ move.axes[0].workplaceOffsets[0] ^ " Y" ^ move.axes[1].workplaceOffsets[0]}
set var.g54 = {var.g54 ^ " Z" ^ move.axes[2].workplaceOffsets[0] ^ " U" ^ move.axes[3].workplaceOffsets[0]}
var note = {"Work state restored from the last save. G54: " ^ var.g54}
set var.note = {var.note ^ ". Use 'Restore Work State' to reload, or 'Save Work State' to overwrite."}
M291 P{var.note} R"Startup: Work Coordinates" S1 T10
