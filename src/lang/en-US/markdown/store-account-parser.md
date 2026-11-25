# Store Account Parser

This parser signs in to your account at a game store and adds every game the account owns but **hasn't installed** to Steam. Its shortcut installs the game: it opens the store's launcher on the game, so you can install it from Steam (for example in Steam's Game Mode on a Steam Deck).

Games you have installed are not added by this parser: add those with the parser for the store's launcher (Epic, GOG Galaxy, Amazon Games, EA Desktop, Battle.net, itch.io, UPlay, Legendary). On Linux, a game you installed through Heroic is the exception: SRM has no parser for Heroic's games, so when this parser's shortcut starts the game through Heroic, it keeps that shortcut (see [Keeping the shortcut when you install the game](#keeping-the-shortcut-when-you-install-the-game)).

SRM can't see every install, though: a Humble Bundle game, and on Linux an EA app or Battle.net game installed under Wine (Lutris, Bottles), keeps its shortcut here after you have installed it. Exclude such a game on the **Add Games** page (a game's details, or `Manage Excludes`).

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
| Ubisoft Connect  | Ubisoft Connect on this PC (Windows only): SRM reads the games of the account it is signed in to           |

- **EA app, Battle.net and Humble Bundle** keep their sign-in in the store's cookies. SRM keeps them for that store apart from SRM's window, and sends them and takes the store's renewals as a browser does. While they are valid, the sign-in window signs straight back into the same account: to sign in to another account, sign out first.
- **Battle.net**: the classic games of an account (Warcraft III, Diablo II) and games SRM doesn't know open Battle.net's download page. Battle.net's China region is not supported.
- **Ubisoft Connect** has no sign-in in SRM. **Use Ubisoft Connect on this PC** reads the list of owned games that Ubisoft Connect keeps on disk for the account it signed in to last, and sends nothing to Ubisoft. Ubisoft Connect saves that list when it signs in, so a game you bought since shows up once Ubisoft Connect has run again; the account shows the list's date as when its games were fetched. Windows only. Games bought on Steam and Ubisoft+ games are left out. A game's title is the one SRM's UPlay parser gives it (for example `RabbidsCoding`), so its shortcut stays the same once you install it. A Ubisoft game linked to an Epic Games account is also in the Epic Games Store's library: by default, Epic comes first in the store order (see below).
- **Humble Bundle** lists the DRM-free games with a Windows or Linux download. A game that came with a key for another store (such as Steam) is left out: it is in that store's library. Humble has no launcher, so a shortcut opens the game's page in your Humble library, where you download it. SRM can't tell when you have installed a Humble game, so its shortcut stays once you have: exclude it on the **Add Games** page.

## A game several stores own

When the Store Account parsers of two stores list the same game (the same title, compared by its letters and digits only, so "PREY" and "Prey" match) for the same Steam user, SRM adds **one** shortcut: the one of the store that comes first in the store order. The others are left out, and the log says how many. The default order is GOG, Epic Games Store, Amazon Games, EA app, Battle.net, Ubisoft Connect, Humble Bundle, itch.io: DRM-free first, then the stores with the most complete launchers.

Change the order, or have a shortcut from every store, in **Settings**, **Owned Games**. Those shortcuts have the same title; to tell them apart, give each parser a title modifier (for example `${title} (GOG)`). A title is part of a shortcut's id in Steam, so changing it makes a new shortcut.

A shortcut's id is made from its program and its title, so where two stores' shortcuts run the same program, the same title is the same Steam shortcut: the browser runs those of Humble Bundle, of itch.io without the itch app, and of any store whose launcher isn't installed; PowerShell runs those of the Epic Games Store, the EA app and Ubisoft Connect. Then only the shortcut of the store that comes first in the store order is added, also with a shortcut from every store, and the log counts the others. A title modifier per parser keeps them apart.

This is only between Store Account parsers: a game installed through a launcher SRM reads is left out by the parser itself (see its settings), and the shortcut of another parser is never left out.

## Settings

In **Settings**, **Owned Games**, for every Store Account parser:

- **A game several store accounts own**: one shortcut, from the first store in the store order (default), or a shortcut from every store.
- **Store order**: the stores, most preferred first.
- **Ask before adding more games that aren't installed than this** (default 100): before **Save to Steam** adds more games that aren't installed and that Steam doesn't have yet (for any of your Steam users) than this, SRM asks first. A first save with a large library adds every game the account owns, so this is where you can still stop. `0` never asks. The command line never asks: it says so in its output and adds them.
- **Fetch a store account's games again when they are older than** (default 6 hours): see the parser's Account input.

## What a shortcut opens

A game that isn't installed opens, in this order:

1. **The store's launcher**, on the game's page or install dialog, when it's installed: on Windows, the Epic Games Launcher, GOG Galaxy, Amazon Games, the EA app, Battle.net, Ubisoft Connect or the itch app; on Linux, only the itch app.
2. **Heroic** (Linux), for Epic, GOG and Amazon games, when Heroic is signed in to that store. Both Heroic's Flatpak and a native Heroic work.
3. **A page in your browser**: the game's page at the Epic Games Store, GOG and itch.io (a search, account or purchases page when SRM doesn't know the game's page), and the game's page in your Humble library. For the EA app, Amazon Games, Battle.net and Ubisoft Connect it is the store's own page, not the game's: the EA app's download page, Amazon Gaming's home page, and Battle.net's and Ubisoft Connect's download pages.

On macOS, SRM doesn't look for launchers: every shortcut opens the browser. On Linux, EA app, Battle.net and Humble Bundle shortcuts always open the browser, and Epic, GOG and Amazon ones do when Heroic isn't signed in to that store.

## Artwork

SteamGridDB knows Epic Games Store, EA app, Battle.net and Ubisoft Connect games by their id at the store, so for those games SRM asks SteamGridDB for the game by that id first: the right game even when its title is shared or written differently. When SteamGridDB doesn't know the game by its id, SRM searches for its title, as it does for GOG, Amazon Games, Humble Bundle and itch.io games. This is for both SteamGridDB and Steam Official artwork, and for finding artwork backups.

SteamGridDB knows a Battle.net game by the launcher's id for it (such as `prometheus` for Overwatch). Battle.net's classic games (Warcraft III, Diablo II) and games SRM doesn't know have no such id: their title is searched.

SteamGridDB knows a Ubisoft Connect game by its `space_id`, from the game's configuration in Ubisoft Connect. Some old games have none (such as Rayman Origins): their title is searched.

A search you set for a game on Add Games (**Fix match**, or a search title) is used instead of the store's id.

## Keeping the shortcut when you install the game

A Steam shortcut's id is made from its program and its title. Where SRM has a parser for the store's launcher, a Store Account shortcut uses the program that parser uses when it **launches through the launcher** (for example PowerShell for Epic, EA and UPlay, `GalaxyClient.exe` for GOG, `Amazon Games.exe`, `Battle.net.exe`). So once you install the game and that parser adds it, under the same title and with launching through the launcher turned on, it is the same shortcut: its artwork and exceptions stay, and this parser leaves the game out from then on.

When the titles differ (the store's launcher can name a game differently from the store's account page), the installed game gets a new shortcut and the old one is removed.

**Heroic (Linux)**: SRM has no parser for the games Heroic installs. A shortcut that goes through Heroic starts the game once Heroic has installed it, so this parser keeps it: the same shortcut, with its artwork and exceptions, now starts the installed game. It stays in this parser's Steam collection (**Not installed** by default), since the collection is the parser's, not the game's. A game Heroic installed whose shortcut would open the store page instead is left out, and SRM adds nothing for it. When Heroic's own **Add games to Steam automatically** is on, Heroic adds a second shortcut for the game: turn it off, or have this parser's shortcuts open the store page so that only Heroic's stays.

## Your sign-in and your privacy

- Every sign-in is kept in SRM's data folder, under `stores/<store>/session.json`, **encrypted** with your system's secret storage (through Electron's safeStorage: Windows' DPAPI, the macOS keychain, or a keyring on Linux such as GNOME Keyring or KWallet).
- **Linux without a keyring**: Electron then falls back to a fixed key that is the same in every copy of SRM, so the encryption doesn't protect your sign-ins: anyone who can read your files can decrypt them. The parser's settings say so when this is the case. Set up a keyring to keep them safe.
- For the EA app, Battle.net and Humble Bundle, the sign-in is the store's cookies. While SRM runs, it keeps them in memory only; they are saved in the same encrypted `session.json`, nowhere else. Only the store's own cookies are kept: what another site's sign-in leaves (for example signing in to the EA app with Google or Steam) is never saved, and is removed once the sign-in window closes. When you weren't signed in, a sign-in that fails or that you cancel leaves nothing behind, so the next try asks for the whole sign-in again, two-factor authentication included.
- **Ubisoft Connect** keeps no sign-in in SRM. SRM reads two files of Ubisoft Connect's cache, which are encrypted for your Windows user: the list of games the account owns, and the games' configurations. Windows PowerShell unlocks their key for SRM (with Windows' DPAPI); SRM uses it for those two files only and never saves it. SRM never opens the files that hold your Ubisoft sign-in, and never keeps the CD keys that the list of owned games holds. Its `session.json` holds only which account's list to read.
- The list of owned games is kept next to it, in `stores/<store>/library.json`.
- Sign-ins are never part of the parser's settings (`userConfigurations.json`), never in bug reports and never in SRM's log.
- SRM's sign-in window is the store's own page, in a window apart from SRM, with no access to SRM.
- **Sign out** removes the sign-in and the list from SRM. It also ends SRM's session at Epic, removes SRM's device from your Amazon account, and clears the cookies SRM keeps for the EA app, Battle.net and Humble Bundle. You can also end SRM's access on the store's site (itch.io: revoke the API key).
- Deleting or disabling the parser keeps the sign-in: it belongs to the store, not to the parser. To remove it, add a new parser (you don't need to save it), choose Store Account and the store, and click **Sign out**. Or, while SRM is closed, delete `stores/<store>/` from SRM's data folder.

## The command line

`srm add` lists the games the app last fetched. The app's own command line fetches an old library again when it can read the app's sign-in (it can't always: on Windows it has a secret storage of its own); the standalone command line never fetches at all. Sign in and out in the app.
