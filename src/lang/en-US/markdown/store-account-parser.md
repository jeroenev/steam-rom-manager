# Store Account Parser

This parser signs in to your account at a game store and adds every game the account owns but **hasn't installed** to Steam. Its shortcut installs the game: it opens the store's launcher on the game, so you can install it from Steam (for example in Steam's Game Mode on a Steam Deck).

Games you have installed are not added by this parser: add those with the parser for the store's launcher (Epic, GOG Galaxy, Amazon Games, EA Desktop, Battle.net, itch.io, Legendary).

Use one Store Account parser per store account. By default its games go into the Steam collection **Not installed**: Steam has no "not installed" state for a shortcut, so the collection is where that shows.

## Stores

| Store   | Sign-in                                                               |
| ------- | --------------------------------------------------------------------- |
| GOG     | SRM's sign-in window, or your browser (paste the address GOG ends on) |
| itch.io | An API key, made on your itch.io account settings                     |

Epic Games Store, Amazon Games, EA app, Battle.net and Humble Bundle come with later versions of SRM.

## What a shortcut opens

A game that isn't installed opens, in this order:

1. **The store's launcher**, on the game's page or install dialog (GOG Galaxy, the itch app; later the Epic Games Launcher, Amazon Games, the EA app and Battle.net), when it's installed.
2. **Heroic** (Linux), for Epic, GOG and Amazon games, when Heroic is signed in to that store. Both Heroic's Flatpak and a native Heroic work.
3. **The game's store page** in your browser.

## Keeping the shortcut when you install the game

A Steam shortcut's id is made from its program and its title. Where SRM has a parser for the store's launcher, a Store Account shortcut uses the program that parser uses when it **launches through the launcher** (for example PowerShell for Epic and EA, `GalaxyClient.exe` for GOG, `Amazon Games.exe`, `Battle.net.exe`). So once you install the game and that parser adds it, under the same title and with launching through the launcher turned on, it is the same shortcut: its artwork and exceptions stay, and this parser leaves the game out from then on.

When the titles differ (the store's launcher can name a game differently from the store's account page), the installed game gets a new shortcut and the old one is removed.

## Your sign-in and your privacy

- Sign-ins are kept in SRM's data folder, under `stores/<store>/session.json`, **encrypted** with your system's secret storage (Windows' DPAPI, the macOS keychain, or a keyring on Linux). Without a keyring on Linux, they are saved with Chromium's built-in key, which anyone who can read your files can undo; the parser's settings say so when this is the case.
- The list of owned games is kept next to it, in `stores/<store>/library.json`.
- Sign-ins are never part of the parser's settings (`userConfigurations.json`), never in bug reports and never in SRM's log.
- SRM's sign-in window is the store's own page, in a window apart from SRM, with no access to SRM.
- **Sign out** removes the sign-in and the list from SRM. You can also end SRM's access on the store's site (itch.io: revoke the API key).

## The command line

`srm add` lists the games the app last fetched. The app's own command line fetches an old GOG or itch.io library again when it can read the app's sign-in (it can't always: on Windows it has a secret storage of its own); the standalone command line never does. Sign in and out in the app.
