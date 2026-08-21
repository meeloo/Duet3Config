; daemon.g — nothing to do.
;
; This file used to poll the dust shoe: a `while true` loop waking every 50ms
; to ask whether Z had moved and to nudge U after it. An M581.1 expression
; trigger replaced it, and M604 has since replaced that — the firmware holds U
; to Z inside the motion planner, so there is nothing left to watch for. See
; dustShoeConfig.g.
;
; The loop stayed behind as a fallback for RRF 3.6, which has no M581.1. It had
; to go, because it does not merely idle:
;
;   Once the tracking moved into its own motion system, the daemon became the
;   thing standing on U from the other one. The daemon channel is motion system
;   0, trigger2.g runs in system 1 and now owns U, so every daemon iteration
;   reported "Drive U is already used by a different motion system" — once per
;   move, forever, from a loop that restarts itself every few seconds.
;
; Emptied rather than deleted: tools/put uploads what is here and does not
; remove what is not, so deleting the file would leave the old loop running on
; the board. An empty one actually stops it.
;
; If you ever go back to a firmware without M581.1, the loop is in this file's
; history rather than sitting here waiting to fight the trigger.
