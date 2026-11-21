# EA Desktop Parser Specific Inputs

## Extra EA Games Directory `[Optional]`

You don't need this field for games the EA app installed: SRM finds them wherever they are, through Windows' list of installed programs. Fill it in only if a game is missing.

SRM also searches the folder you enter here: each folder directly inside it that holds an EA game (one with an `__Installer\installerdata.xml` file) is added, e.g. `D:\Games\EA Games`. When the field is empty, SRM searches `C:\Program Files\EA Games` and `C:\Program Files (x86)\EA Games` instead.

## Launch Games Via EA Desktop

If enabled SRM will add a shortcut to `origin2://game/launch/?offerIds=${gameid}` instead of just the game's executable. This ensures the game launches via EA and will have access to online services.

That link only needs the game's id, so with this enabled SRM also adds games whose executable it can't find. With it disabled, SRM only adds the games whose executable it finds.
