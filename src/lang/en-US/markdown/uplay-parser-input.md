# UPlay Parser Specific Inputs

## Ubisoft Directory Override

By default Steam ROM Manager assumes your UPlay install is located in `C:\Program Files (x86)\Ubisoft`. This field allows you to override that path if your UPlay installation is elsewhere.

## Launch Via UPlay `[Recommend disabled]`

What it sounds like, this toggle let's you set whether games will launch via UPlay or directly from the game's executable.

For UPlay this doesn't matter too much as UPlay games will automatically launch UPlay in the background even when launched from the executable. Both the Steam and Ubisoft overlays work when `Launch via UPlay` is disabled. When it's enabled, the Steam overlay only works when Steam started Ubisoft Connect, that is when Ubisoft Connect was closed before the launch; an open Ubisoft Connect takes the game over without the Steam overlay. Enable **Wait for the game to exit** as well, or Steam shows the game as running until you quit a Ubisoft Connect that it started.

## Wait For Game To Exit `[Windows only]`

Only applies when launching via UPlay. Without it, Steam gets the game's state wrong: it shows the game as stopped right away when Ubisoft Connect was already open (so pressing Play starts it again), and as running until you quit Ubisoft Connect when it wasn't.

With this enabled, the game's shortcut runs SRM's launch script (see **Script wrapper**). It opens the game's link and waits until no program from the game's install folder runs, so Steam shows the game as running exactly as long as it runs. Ubisoft Connect gets up to 10 minutes to start the game, since it may update the game or ask for your password first. What happens to Ubisoft Connect depends on whether it was open:

- **Ubisoft Connect was closed:** the launch starts it inside Steam, so the game gets the Steam overlay. Ubisoft Connect doesn't say when it has synced cloud saves, so SRM gives it 5 seconds after the game, then asks it to quit. If it hasn't quit after 15 seconds, it is ended. A download started in Ubisoft Connect during the game stops when it closes.
- **Ubisoft Connect was open:** it takes the game over and stays open. The game shows as running for the right time, but gets no Steam overlay (see the next option).
- If the game never starts, Ubisoft Connect is left open.

Ubisoft Connect's close button normally only hides it in the tray, and so does asking it to quit. So while a launch has it running, SRM changes `closebehavior: CloseBehavior_Minimize` to `closebehavior: CloseBehavior_Close` in `%LOCALAPPDATA%\Ubisoft Game Launcher\settings.yaml`, and changes it back once Ubisoft Connect has exited. This happens only while Ubisoft Connect is closed, since it saves its settings when it exits. If a launch is cut short (by Steam's **Stop**, for example) or Ubisoft Connect is left open, the setting stays changed until a later launch through SRM changes it back; until then, Ubisoft Connect's close button quits it instead of hiding it.

Turning this on or off changes the shortcut's executable (SRM's launch script instead of PowerShell), so the games get new app IDs: the next save replaces their shortcuts.

## Restart An Open Ubisoft Connect So The Steam Overlay Works `[Windows only]`

Only applies with **Wait for the game to exit**. Off by default.

The Steam overlay only reaches the game when Steam started Ubisoft Connect. With this enabled, a Ubisoft Connect that is open when you start a game is closed first, so that the launch starts it again and the game always gets the overlay. It's ended rather than asked to quit (unless its close setting already says to quit), since that setting can't be changed while it runs. This stops any download in Ubisoft Connect, and another Ubisoft game running at the time loses Ubisoft Connect.
