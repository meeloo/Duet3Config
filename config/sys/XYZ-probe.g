
      M400
      G91
      M563 P49 S"XYZ-Probe[Seb]"
      
      G1 Z5 F500
      G1 X20 Y20 F500
      M585 Z10 P0 F500 S1
      M400
      G10 L20 Z5
      G1 Z5 F500
      
      G1 X-35.3 F500
      G1 Z-10 F500
      M585 X10 P0 F500 S0
      M400
      G10 L20 X-10.3
      G1 X-5 F500
      G1 Z10 F500
      G1 X35 Y-35.3 F500
      
      G1 Z-10 F500
      
      M585 Y10 P0 F500 S0
      M400
      G10 L20 Y-10.3
      G1 Y-5 F500
      M400
      M500
      G1 Z10 F500
      G1 X-20 F500
      G90
      G1 X0 Y0 F500
      
      M563 P49 D-1 H-1
      M291 P"Probe complete. Please remove probe. [Seb]" R"Success" S1