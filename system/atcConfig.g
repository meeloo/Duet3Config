;RapidChange globals:
global atcDirection = 1 ; -1 or 1 depending on the direction to go from tool 0 to tool N
global atcAlignment = 1 ; 0 = along X, 1 = along Y
global atcOffset = 38 ; Offset from slot to slot for your particular ATC. ER11 ATCs have 38 mm offsets
global atcCount = 8 ; The number of tool slots in your ATC
global atcSpindlePause = 2 ; Duration in second to wait for the ATC to start engaging

global atcDropStartZ = 40   ; The Z position to start dropping the tool
global atcDropEndZ = 30   ; The Z position to stop dropping the tool
global atcDropFeed = 1800
global atcDropRPM = 1400 ; The spindle RPM to drop the tool

global atcPickupStartZ = 40
global atcPickupEndZ = 30
global atcPickupRPM = 1400
global atcPickupFeed = 1800

;global atcProbeSlot = 7 ; Uncomment this line if the Z probe is installed in a slot of the ATC. Otherwise set the position of the probe in the next two lines:
global atcProbeX = 24
global atcProbeY = 300

global atcRetractZ = move.axes[2].max  ; Z position to go to when a tool is loaded in the spindle (probably maxZ to make sure we don't hit anything with the end mill)

global atcOriginX = {move.axes[0].min + 24}  ; X position of the first pocket's center
global atcOriginY = {move.axes[1].min + 24}  ; Y position of the first pocket's center

; Compute the X and Y offsets to go from slot to slot, depending on the global parameters (alignement, offset and direction)
global atcAlignmentX = {1 - global.atcAlignment}
global atcAlignmentY = {global.atcAlignment}
global atcOffsetX = {global.atcOffset * global.atcDirection * global.atcAlignmentX} ; X Offset from pocket to pocket
global atcOffsetY = {global.atcOffset * global.atcDirection * global.atcAlignmentY} ; Y Offset from pocket to pocket

if {exists(global.atcProbeSlot)}
    set global.atcProbeX = {global.atcOriginX + global.atcOffsetX * global.atcProbeSlot}
    set global.atcProbeY = {global.atcOriginY + global.atcOffsetY * global.atcProbeSlot}
