# EA Desktop Parser Specific Inputs

## Extra EA Games Directory `[Optional]`

You don't need this field for games the EA app installed: SRM finds them wherever they are, through Windows' list of installed programs. Fill it in only if a game is missing.

SRM also searches the folder you enter here: each folder directly inside it that holds an EA game (one with an `__Installer\installerdata.xml` file) is added, e.g. `D:\Games\EA Games`. When the field is empty, SRM searches `C:\Program Files\EA Games` and `C:\Program Files (x86)\EA Games` instead.

## Launch Games Via EA Desktop

If enabled SRM will add a shortcut to `origin2://game/launch/?offerIds=${gameid}` instead of just the game's executable. This ensures the game launches via EA and will have access to online services.

That link only needs the game's id, so with this enabled SRM also adds games whose executable it can't find. With it disabled, SRM only adds the games whose executable it finds.

## Wait For Game To Exit `[Windows only]`

Only applies when launching via EA Desktop. Without it, Steam gets the game's state wrong: it shows the game as stopped right away when the EA app was already open (so pressing Play starts it again), and as running until you quit the EA app when it wasn't.

With this enabled, the game's shortcut runs SRM's launch script (see **Script wrapper**). It opens the game's link and waits until no program from the game's install folder runs, so Steam shows the game as running exactly as long as it runs. The EA app gets up to 10 minutes to start the game, since it may update the game or ask you to sign in first. What happens to the EA app depends on whether it was open:

- **The EA app was closed:** the launch starts it inside Steam, so the game gets the Steam overlay. After the game, SRM waits until the EA app has synced cloud saves (its log says when; at most a minute), then asks the EA app to quit. If it hasn't quit after 15 seconds, it is ended. A download started in the EA app during the game stops when it closes.
- **The EA app was open:** it takes the game over and stays open. The game shows as running for the right time, but gets no Steam overlay (see the next option).
- If the game never starts, the EA app is left open.

Turning this on or off changes the shortcut's executable (SRM's launch script instead of PowerShell), so the games get new app IDs: the next save replaces their shortcuts.

## Restart An Open EA App So The Steam Overlay Works `[Windows only]`

Only applies with **Wait for the game to exit**. Off by default.

The Steam overlay only reaches the game when Steam started the EA app. With this enabled, an EA app that is open when you start a game is asked to quit first (and ended if it hasn't quit after 15 seconds), so that the launch starts it again and the game always gets the overlay. This stops any download in the EA app, and another EA game running at the time loses the EA app.
