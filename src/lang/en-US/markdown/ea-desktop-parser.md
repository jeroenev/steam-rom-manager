# EA Desktop Parser

This parser imports the games installed by the EA app (EA Desktop), so that artwork can be chosen for them and they can be added into Steam.

SRM finds them in Windows' list of installed programs: a program whose folder holds an `__Installer\installerdata.xml` file was installed by the EA app. That file gives the game's title, its id in EA's catalog and, usually, its executable. Games in the folder set below are added as well.

If it doesn't work it is because EA has altered the structure of their xml files, in which case please let the developers of SRM know and we will resolve the issue.
