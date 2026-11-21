// Battle.net's installed games and the games SRM knows, shared by the
// Battle.net parser and the owned-games code.
import { BlizzardParser } from "blizzard-product-parser";

export const DEFAULT_BATTLE_NET_EXE =
  "C:\\Program Files (x86)\\Battle.net\\Battle.net.exe";

// The Battle.net agent's list of installed products.
export const BATTLE_NET_PRODUCT_DB =
  "C:\\ProgramData\\Battle.net\\Agent\\product.db";

// Battle.net product codes (lower case) and what SRM calls the game, with
// the code Battle.net.exe --exec="launch <code>" takes (which is also the
// id a Battle.net account lists the game by).
// shamelessly borrowed from steamgriddb-manager
export const BNET_GAMES: {
  [k: string]: {
    name: string;
    launchId: string;
  };
} = {
  d3: {
    name: "Diablo III",
    launchId: "D3",
  },
  dst2: {
    name: "Destiny 2",
    launchId: "DST2",
  },
  hero: {
    name: "Heroes of the Storm",
    launchId: "Hero",
  },
  odin: {
    name: "Call of Duty: Modern Warfare",
    launchId: "ODIN",
  },
  pro: {
    name: "Overwatch 2",
    launchId: "Pro",
  },
  s1: {
    name: "Starcraft Remastered",
    launchId: "S1",
  },
  s2: {
    name: "Starcraft 2",
    launchId: "S2",
  },
  viper: {
    name: "Call of Duty: Black Ops 4",
    launchId: "VIPR",
  },
  w3: {
    name: "Warcraft 3: Reforged",
    launchId: "W3",
  },
  hsb: {
    name: "Hearthstone",
    launchId: "WTCG",
  },
  wlby: {
    name: "Crash Bandicoot 4",
    launchId: "WLBY",
  },
  wow: {
    name: "World of Warcraft",
    launchId: "WoW",
  },
  zeus: {
    name: "Call of Duty: Black Ops Cold War",
    launchId: "ZEUS",
  },
  fenris: {
    name: "Diablo IV",
    launchId: "Fen",
  },
  anbs: {
    name: "Diablo Immortal",
    launchId: "ANBS",
  },
  osi: {
    name: "Diablo II: Resurrected",
    launchId: "OSI",
  },
  rtro: {
    name: "Blizzard Arcade Collection",
    launchId: "RTRO",
  },
  lazr: {
    name: "Call of Duty: Modern Warfare 2 Campaign Remastered",
    launchId: "LAZR",
  },
  fore: {
    name: "Call of Duty: Vanguard",
    launchId: "FORE",
  },
  auks: {
    name: "Call of Duty",
    launchId: "AUKS",
  },
};

// The installed games in product.db (productCode, settings.installPath,
// ...), without Battle.net itself.
export function readBattleNetProducts(
  dbPath: string = BATTLE_NET_PRODUCT_DB,
): any[] {
  const decoder = new BlizzardParser(dbPath);
  decoder.decode();
  return installedBattleNetProducts(decoder.getRaw());
}

export function installedBattleNetProducts(raw: any): any[] {
  return (raw?.productInstall || []).filter(
    (product: any) =>
      !(product.uid === "battle.net" || product.uid === "agent"),
  );
}
