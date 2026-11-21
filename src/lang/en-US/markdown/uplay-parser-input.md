# UPlay Parser Specific Inputs

## Ubisoft Directory Override

By default Steam ROM Manager assumes your UPlay install is located in `C:\Program Files (x86)\Ubisoft`. This field allows you to override that path if your UPlay installation is elsewhere.

SRM reads Ubisoft Connect's configuration cache there (`Ubisoft Game Launcher\cache\configuration\configurations`), or in `%LOCALAPPDATA%\Ubisoft Game Launcher`: it holds the games' titles and executables. Current versions of Ubisoft Connect no longer update that file, so it can be old or missing (see the next option).

## Launch Via UPlay `[Recommend disabled]`

What it sounds like, this toggle let's you set whether games will launch via UPlay or directly from the game's executable.

For UPlay this doesn't matter too much as UPlay games will automatically launch UPlay in the background even when launched from the executable. When `Launch via UPlay` is disabled, both the Steam and Ubisoft overlays work if Ubisoft Connect is already running. If it isn't, the game starts Ubisoft Connect itself, and the Steam overlay can fail (with Far Cry 3 it flashed and disappeared). When `Launch via UPlay` is enabled, the Steam overlay only works when Steam started Ubisoft Connect, that is when Ubisoft Connect was closed before the launch; an open Ubisoft Connect takes the game over without the Steam overlay. Enable **Wait for the game to exit** as well, or Steam shows the game as running until you quit a Ubisoft Connect that it started. To have Steam start Ubisoft Connect, so the game can get the Steam overlay, use `Launch via UPlay` with **Wait for the game to exit**, and the restart option below if Ubisoft Connect may already be open.

This option also decides which games SRM adds. With it enabled, SRM adds every game Ubisoft Connect lists as installed (in the registry) whose folder exists, since the link only needs the game's id. Its title comes from the configuration cache, or else from Windows' list of installed programs, or else from its folder's name. Games installed through Steam (in a Steam library) are left out: Steam lists them already. With it disabled, SRM only adds the games whose executable the configuration cache names by its place in the game's folder. That leaves out games installed since Ubisoft Connect stopped updating the cache, and games whose executable Ubisoft Connect looks up in the registry (Far Cry 3, for example).

## Wait For Game To Exit `[Windows only]`

Only applies when launching via UPlay. Without it, Steam gets the game's state wrong: it shows the game as stopped right away when Ubisoft Connect was already open (so pressing Play starts it again), and as running until you quit Ubisoft Connect when it wasn't.

With this enabled, the game's shortcut runs SRM's launch script (see **Script wrapper**). It opens the game's link and waits until no program from the game's install folder runs, so Steam shows the game as running while it runs (and a few seconds after: SRM checks for 5 seconds that it's gone). Ubisoft Connect gets up to 10 minutes to start the game, since it may update the game or ask for your password first. What happens to Ubisoft Connect depends on whether it was open:

- **Ubisoft Connect was closed:** the launch starts it inside Steam, so the game gets the Steam overlay. Ubisoft Connect doesn't say when it has synced cloud saves, so SRM gives it 5 seconds after the game, then asks it to quit. If it hasn't quit after 15 seconds, it is ended. Steam shows the game as running until then: usually 15 to 20 seconds after the game, at most about 40 seconds. A download started in Ubisoft Connect during the game stops when it closes. If another game Ubisoft Connect started still runs (one you started from Ubisoft Connect, for example), Ubisoft Connect stays open, and Steam shows this game as running until you quit Ubisoft Connect.
- **Ubisoft Connect was open:** it takes the game over and stays open. The game shows as running for the right time, but gets no Steam overlay (see the next option).
- If the game closes within seconds of starting (it crashes, for example), SRM waits up to 2 minutes for it to start again (some games restart themselves), then counts it as a game that ran and exited: Steam shows it as running until then, and Ubisoft Connect is closed (if the launch started it) as after any game.
- Some games hand their start over to Ubisoft Connect: the game's first program starts Ubisoft Connect's `UbisoftGameLauncher.exe` and closes, and Ubisoft Connect starts the game again (Far Cry 3 does this). While `UbisoftGameLauncher.exe` runs, SRM keeps waiting for the game, within the 10 minutes.
- If the game doesn't start within the 10 minutes (you cancel a password prompt or an update, for example, or Ubisoft Connect stalls after a game handed its start over to it), Ubisoft Connect is left open. If the launch started it, Steam keeps showing the game as running until you quit Ubisoft Connect from its tray icon (its close button also quits it then, see below), because Ubisoft Connect runs inside Steam. **Stop** in Steam may not end it (see below).

Steam's **Stop** button may not end the game: Ubisoft Connect starts the game, so Steam may not count it among the shortcut's programs (it never does when Ubisoft Connect was already open). Quit the game from its own menu instead. **Stop** does end SRM's launch script, so whatever still runs afterwards (the game, Ubisoft Connect) isn't closed for you, and Ubisoft Connect's close setting stays changed until the next launch (see below).

Ubisoft Connect's close button normally only hides it in the tray, and so does asking it to quit. So while a launch has it running, SRM changes `closebehavior: CloseBehavior_Minimize` to `closebehavior: CloseBehavior_Close` in `%LOCALAPPDATA%\Ubisoft Game Launcher\settings.yaml`, and changes it back once Ubisoft Connect has exited. This happens only while Ubisoft Connect is closed, since it saves its settings when it exits. If a launch is cut short (by Steam's **Stop**, for example) or Ubisoft Connect is left open, the setting stays changed until the next launch through SRM that starts Ubisoft Connect, which changes it back after its game; until then, Ubisoft Connect's close button quits it instead of hiding it. If you turn **Wait for the game to exit** (or `Launch via UPlay`) off after that, no launch changes it back: tick **Minimize Ubisoft Connect to the system tray when the application window is closed** in Ubisoft Connect's settings, or change the line back in `settings.yaml` yourself while Ubisoft Connect is closed.

Turning this on or off changes the shortcut's executable (SRM's launch script instead of PowerShell), so the games get new app IDs: the next save replaces their shortcuts.

## Restart An Open Ubisoft Connect So The Steam Overlay Works `[Windows only]`

Only applies with **Wait for the game to exit**. Off by default.

The Steam overlay only reaches the game when Steam started Ubisoft Connect. With this enabled, a Ubisoft Connect that is open when you start a game is closed first, so that the launch starts it again and the game gets the overlay. It's ended rather than asked to quit (unless its close setting already says to quit), since that setting can't be changed while it runs. This stops any download in Ubisoft Connect. While another game Ubisoft Connect started runs, Ubisoft Connect is left open instead, and the game gets no Steam overlay.
