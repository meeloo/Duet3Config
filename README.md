# Duet3Config
This is the Duet3 6HC controller configuration I use for my custom Ultimate Bee CNC (it'a 750x1500 I got from bulkman3D).
I paired it with a Huangyang VFD and 1.5kW air cooled spindle.
The Duet controls the spindle via a PWM to Voltage (0-10v) converter. It also uses a simple relay to switch forward and reverse directions on the VFD.

All the files that start with "atc" are there to use a RapidChangeATC automatic tool changer. The configuration you can use is all in atcConfig.g. You WILL have to update the values in this file depending on how your machine is setup.

I have also included a customized post processor for fusion 360. It is customised to senses:
- It has good default values that work for me and when I use https://github.com/TimPaterson/Fusion360-Batch-Post (as this add on can't edit the default of the secondary post processor, the default values need to already be what you want)
- I added some functionnalities to have better ATC support (like, don't display a message box after each tool change...)

