
      M400
      G91
      M563 P49 S"XYZ-Probe[Seb]"
      
      M585 Z15 P0 F500 S1
      G10 L20 Z5
      G1 Z5 F500
      M500
      G90
      
      M563 P49 D-1 H-1
      M291 P"Probe complete. Please remove probe. [Seb]" R"Success" S1