; Network configuration executed by config.g

; Configure Connection - ENABLE ONLY ONE OF THE BELOW THREE
;M552 S1 ; Enable Wifi Network
;M552 S2 ; Enable Access Point Mode
;M552 S1 P0.0.0.0 ; Enable Ethernet - Change IP Address to suit

; Enable Wifi Module:
G4 P500 ; wait for 500 milliseconds for the Wifi module to warm up
;M552 I1 S0 ; First disable it
;M587 S"Monsieur Le Comte" P"YourWifiPassword"
M552 I1 S1 ; Then enable Wifi

; Network settings
M586 P0 S1 ; Enable HTTP
M586 P1 S0 ; Disable FTP
M586 P2 S0 R23 ; Disable Telnet

; Network machine name
M550 P"Sebs CNC" ; Set machine name
