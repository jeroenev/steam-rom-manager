# Store Account Parser

This parser signs in to your account at a game store and adds every game the account owns but **hasn't installed** to Steam. Its shortcut installs the game: it opens the store's launcher on the game, so you can install it from Steam (for example in Steam's Game Mode on a Steam Deck).

Games you have installed are not added by this parser: add those with the parser for the store's launcher (Epic, GOG Galaxy, Amazon Games, EA Desktop, Battle.net, itch.io, Legendary).

Use one Store Account parser per store account. By default its games go into the Steam collection **Not installed**: Steam has no "not installed" state for a shortcut, so the collection is where that shows.

## Stores

| Store            | Sign-in                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| Epic Games Store | SRM's sign-in window, or your browser (paste the page text containing "authorizationCode", or the code)    |
| GOG              | SRM's sign-in window, or your browser (paste the address GOG ends on)                                      |
| Amazon Games     | SRM's sign-in window, or your browser (paste the address Amazon ends on)                                   |
| EA app           | SRM's sign-in window only                                                                                  |
| Battle.net       | SRM's sign-in window only                                                                                  |
| Humble Bundle    | SRM's sign-in window, or your browser (paste the Cookie header of a signed-in request to humblebundle.com) |
| itch.io          | An API key, made on your itch.io account settings                                                          |

- **EA app, Battle.net and Humble Bundle** keep their sign-in in the store's cookies, which SRM keeps for that store as a browser does, apart from SRM's window. While they are valid, the sign-in window signs straight back into the same account: to sign in to another account, sign out first.
- **Battle.net**: the classic games of an account (Warcraft III, Diablo II) and games SRM doesn't know open Battle.net's download page. Battle.net's China region is not supported.
- **Humble Bundle** lists the DRM-free games with a Windows or Linux download. A game that came with a key for another store (such as Steam) is left out: it is in that store's library. Humble has no launcher, so a shortcut opens the game's page in your Humble library, where you download it.

## What a shortcut opens

A game that isn't installed opens, in this order:

1. **The store's launcher**, on the game's page or install dialog (the Epic Games Launcher, GOG Galaxy, Amazon Games, the EA app, Battle.net, the itch app), when it's installed.
2. **Heroic** (Linux), for Epic, GOG and Amazon games, when Heroic is signed in to that store. Both Heroic's Flatpak and a native Heroic work.
3. **The game's store page** in your browser.

## Keeping the shortcut when you install the game

A Steam shortcut's id is made from its program and its title. Where SRM has a parser for the store's launcher, a Store Account shortcut uses the program that parser uses when it **launches through the launcher** (for example PowerShell for Epic and EA, `GalaxyClient.exe` for GOG, `Amazon Games.exe`, `Battle.net.exe`). So once you install the game and that parser adds it, under the same title and with launching through the launcher turned on, it is the same shortcut: its artwork and exceptions stay, and this parser leaves the game out from then on.

When the titles differ (the store's launcher can name a game differently from the store's account page), the installed game gets a new shortcut and the old one is removed.

## Your sign-in and your privacy

- Sign-ins are kept in SRM's data folder, under `stores/<store>/session.json`, **encrypted** with your system's secret storage (Windows' DPAPI, the macOS keychain, or a keyring on Linux). Without a keyring on Linux, they are saved with Chromium's built-in key, which anyone who can read your files can undo; the parser's settings say so when this is the case.
- For the EA app, Battle.net and Humble Bundle, the sign-in is the store's cookies. SRM keeps them in its own browser data for that store, as a browser keeps cookies; `session.json` then holds no secret.
- The list of owned games is kept next to it, in `stores/<store>/library.json`.
- Sign-ins are never part of the parser's settings (`userConfigurations.json`), never in bug reports and never in SRM's log.
- SRM's sign-in window is the store's own page, in a window apart from SRM, with no access to SRM.
- **Sign out** removes the sign-in and the list from SRM. It also ends SRM's session at Epic, removes SRM's device from your Amazon account, and clears the cookies SRM keeps for the EA app, Battle.net and Humble Bundle. You can also end SRM's access on the store's site (itch.io: revoke the API key).
- Deleting or disabling the parser keeps the sign-in: it belongs to the store, not to the parser. To remove it, add a new parser (you don't need to save it), choose Store Account and the store, and click **Sign out**. Or, while SRM is closed, delete `stores/<store>/` from SRM's data folder (for the EA app, Battle.net and Humble Bundle this leaves their cookies in SRM's browser data: sign out instead).

## The command line

`srm add` lists the games the app last fetched. The app's own command line fetches an old Epic Games Store, GOG, Amazon Games or itch.io library again when it can read the app's sign-in (it can't always: on Windows it has a secret storage of its own). It never fetches an EA app, Battle.net or Humble Bundle library, whose sign-in is the app's cookies, and the standalone command line never fetches at all. Sign in and out in the app.
