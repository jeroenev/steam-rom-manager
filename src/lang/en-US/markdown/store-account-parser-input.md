# Store Account Parser Specific Inputs

## Store

The store whose account this parser lists. Use another Store Account parser for each further store.

## Account

Your sign-in to the store, and its games as SRM last fetched them. This is not a setting of the parser: it is the same for every parser of this store, and it is never saved with the parser.

- **Sign in** opens the store's own sign-in page in a window of SRM's. When you have signed in, the window closes and SRM fetches the account's games. The EA app and Battle.net sign in this way only. Their sign-in window (and Humble Bundle's) remembers the sign-in, so to sign in to another account, sign out first.
- **Sign in with your browser** opens the sign-in page in your own browser (useful with a password manager, or when the sign-in window has trouble). Then paste what the store shows, as the box below the buttons says:
  - **Epic Games Store**: the text of the page Epic shows after you sign in (it contains "authorizationCode"), or just the code. The code works for a few minutes only.
  - **GOG**: the address of the blank page GOG ends on (it starts with `https://embed.gog.com/on_login_success`), or the code in it.
  - **Amazon Games**: the address of the Amazon page the sign-in ends on (it contains `openid.oa2.authorization_code`). Paste it in the same SRM session that opened the sign-in page: the address only works with that one.
  - **Humble Bundle**: the Cookie request header of a signed-in page. In your browser, open your Humble library, open the developer tools (F12), go to Network, reload the page, select the request for library, and copy the value of its Cookie request header. It is your login, so do not share it.
  - **itch.io**: an API key. On itch.io, open Settings > API keys, click "Generate new API key", then "View", and copy the key. You can revoke it there at any time.
- **Refresh library** fetches the account's games now. SRM also fetches them by itself when they are older than 6 hours: when the app starts, and before this parser runs (the app waits up to 15 seconds for that, then uses the games fetched before; the next **Add Games** has the new list). After a failed fetch it waits 15 minutes before trying again, and the games fetched before are used meanwhile.
- **Sign out** removes the sign-in and the list of games from SRM. Deleting or disabling the parser doesn't sign out: sign out first if you want SRM to forget the account.

A fetch never makes the list shrink by mistake: an empty list never replaces a list with games, and a fetch SRM made by itself is not used when it lists less than half the games of the last one (with 20 games or more). Refresh the library yourself to take such a list.

With SRM's **Offline mode** on, libraries are not fetched by themselves; the parser uses the games fetched before.

## A game that isn't installed opens

- **The store's launcher** (default): the store's launcher when it is installed, else Heroic (Linux) when it is signed in to the store, else the store page.
- **Heroic first**: Heroic (Linux) when it is signed in to the store, else the store's launcher, else the store page.
- **The store page in your browser**: always the game's page on the store's site.

## Games left out

A game installed through the store's own launcher is always left out (it is matched by the store's id for the game, or by its title): add installed games with the parser for that launcher. So is a game whose shortcut would be the same as one another parser adds (same program and title, so the same shortcut in Steam): that parser's shortcut is kept as it is. SRM looks where the launcher keeps its games by default, and where your parsers for it are set to look (for example the itch.io parser's app data folder).

- **Leave out betas, demos and playtests** (on by default): titles naming a beta, demo, playtest or test server, as whole words ("Barony (Beta)", but not "Demon's Tilt").
- **Leave out games installed through another launcher** (on by default): a game installed through any launcher SRM knows (Epic, Legendary, Heroic, GOG Galaxy, Amazon Games, EA app, Battle.net, itch), with the same title. Titles are compared by their letters and digits only ("PREY" and "Prey" match).
- **Leave out games Steam has installed** (on by default): a game Steam itself has installed, with the same title.
