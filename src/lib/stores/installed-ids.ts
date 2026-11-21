// Which games of a store are installed on this machine, by the store's own
// id: an owned game whose id is here is installed, so the Store Account
// parser leaves it out (the installed game has its own shortcut). Read
// from the same places SRM's platform parsers read (src/lib/helpers/
// launchers, and the folders the user's parsers are set to), plus Heroic's
// lists and the itch Flatpak on Linux.
//
// Every reader returns nothing rather than fail: a launcher that isn't
// there, or a file that can't be read, means no installed games from it.

import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as _ from "lodash";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import languageEncoding from "detect-file-encoding-and-language";
import * as json from "../helpers/json";
import { SqliteWrapper } from "../helpers/sqlite";
import {
  BATTLE_NET_PRODUCT_DB,
  BNET_GAMES,
  DEFAULT_EA_GAMES_DIR,
  HeroicRunner,
  amazonGamesDb,
  defaultAmazonGamesExe,
  defaultEpicManifestsDir,
  defaultLegendaryInstalledFile,
  eaInstallerDataFiles,
  epicManifestFiles,
  galaxyPaths,
  heroicConfigDirs,
  itchAppDataDirs,
  itchDbPath,
  readBattleNetProducts,
  readEpicManifest,
  readGogRegistryGames,
  readHeroicInstalled,
  readLegendaryInstalled,
} from "../helpers/launchers";
import { StoreKey } from "./types";

export interface InstalledGame {
  store: StoreKey;
  // The store's id, as in OwnedGame.id (EA: a content id; see eaInstalled).
  id: string;
  title?: string;
}

// The places the user's platform parsers are set to read (their overrides of
// where a launcher keeps its data): read as well as the default places, so a
// game installed there counts as installed too.
export interface InstalledLocations {
  epicManifestsDirs?: string[];
  legendaryInstalledFiles?: string[];
  amazonGamesExes?: string[];
  eaGamesDirs?: string[];
  itchAppDataDirs?: string[];
}

// Where to look; each defaults to where the launcher keeps its data on this
// system (tests point them at temporary folders).
export interface InstalledOptions extends InstalledLocations {
  osType?: string;
  home?: string;
  appData?: string;
  epicManifestsDir?: string;
  legendaryInstalledFile?: string;
  heroicConfigDirs?: string[];
  galaxyDb?: string;
  // Windows' list of GOG installs (default: on Windows).
  gogRegistry?: boolean;
  amazonGamesExe?: string;
  eaGamesDir?: string;
  battleNetProductDb?: string;
  itchAppDataDir?: string;
}

// The installed games of `store`, from every place they can be installed.
export async function readInstalledGames(
  store: StoreKey,
  options: InstalledOptions = {},
): Promise<InstalledGame[]> {
  const osType = options.osType ?? os.type();
  const home = options.home ?? os.homedir();
  const onWindows = osType == "Windows_NT";
  const heroicDirs =
    options.heroicConfigDirs ??
    (osType == "Linux" ? heroicConfigDirs(home) : []);
  const fromHeroic = (runner: HeroicRunner) =>
    heroicDirs.map((dir) =>
      quietly(() => tagged(store, readHeroicInstalled(dir, runner))),
    );
  // Reads each place once: the defaults and the parsers' own.
  const fromEach = (
    places: (string | undefined)[],
    read: (place: string) => InstalledGame[] | Promise<InstalledGame[]>,
  ) =>
    _.uniqBy(
      places.filter((place) => !!place),
      (place) => path.resolve(place),
    ).map((place) => quietly(() => read(place)));
  let sources: Promise<InstalledGame[]>[] = [];
  switch (store) {
    case "epic":
      sources = [
        ...fromEach(
          [
            options.epicManifestsDir ?? defaultEpicManifestsDir(osType, home),
            ...(options.epicManifestsDirs ?? []),
          ],
          epicInstalled,
        ),
        ...fromEach(
          [
            options.legendaryInstalledFile ??
              defaultLegendaryInstalledFile(home),
            ...(options.legendaryInstalledFiles ?? []),
          ],
          legendaryInstalled,
        ),
        ...fromHeroic("legendary"),
      ];
      break;
    case "gog":
      sources = [
        quietly(() =>
          galaxyInstalled(options.galaxyDb ?? galaxyPaths(osType)?.dbPath),
        ),
        ...((options.gogRegistry ?? osType == "Windows_NT")
          ? [quietly(gogRegistryInstalled)]
          : []),
        ...fromHeroic("gog"),
      ];
      break;
    case "amazon":
      sources = [
        // (the app is Windows-only: elsewhere only where a parser points)
        ...fromEach(
          [
            options.amazonGamesExe ??
              (onWindows ? defaultAmazonGamesExe(options.appData) : undefined),
            ...(options.amazonGamesExes ?? []),
          ],
          amazonInstalled,
        ),
        ...fromHeroic("nile"),
      ];
      break;
    case "ea":
      sources = fromEach(
        [
          options.eaGamesDir ?? (onWindows ? DEFAULT_EA_GAMES_DIR : undefined),
          ...(options.eaGamesDirs ?? []),
        ],
        eaInstalled,
      );
      break;
    case "battlenet":
      sources = [
        quietly(() =>
          osType == "Windows_NT" || options.battleNetProductDb
            ? battleNetInstalled(
                options.battleNetProductDb ?? BATTLE_NET_PRODUCT_DB,
              )
            : [],
        ),
      ];
      break;
    case "itch":
      sources = fromEach(
        [
          ...(options.itchAppDataDir !== undefined
            ? [options.itchAppDataDir]
            : itchAppDataDirs(osType, home, options.appData)),
          ...(options.itchAppDataDirs ?? []),
        ],
        itchInstalled,
      );
      break;
    case "humble":
      // (Humble has no launcher)
      break;
  }
  return (await Promise.all(sources)).flat();
}

// The ids of the installed games of `store`.
export async function installedIds(
  store: StoreKey,
  options: InstalledOptions = {},
): Promise<Set<string>> {
  const games = await readInstalledGames(store, options);
  return new Set(games.map((game) => game.id));
}

async function quietly(
  read: () => InstalledGame[] | Promise<InstalledGame[]>,
): Promise<InstalledGame[]> {
  try {
    return (await read()).filter((game) => game.id !== "");
  } catch {
    return [];
  }
}

function tagged(
  store: StoreKey,
  games: { id: string; title?: string }[],
): InstalledGame[] {
  return games.map((game) => ({ store, ...game }));
}

// The Epic Games Launcher's manifests (as the Epic parser): AppName.
export async function epicInstalled(
  manifestsDir: string | undefined,
): Promise<InstalledGame[]> {
  if (!manifestsDir || !fs.existsSync(manifestsDir)) {
    return [];
  }
  const games: InstalledGame[] = [];
  for (const file of await epicManifestFiles(manifestsDir)) {
    try {
      const item = readEpicManifest(file);
      if (typeof item?.AppName === "string") {
        games.push({
          store: "epic",
          id: item.AppName,
          title: item.DisplayName,
        });
      }
    } catch {
      // (one bad manifest: that game only)
    }
  }
  return games;
}

// Legendary's installed.json (as the Legendary parser): its keys.
export function legendaryInstalled(file: string): InstalledGame[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  return Object.entries(readLegendaryInstalled(file))
    .filter(([, app]) => app?.is_dlc !== true)
    .map(([key, app]) => ({
      store: "epic" as StoreKey,
      id: String(app?.app_name || key),
      title: typeof app?.title === "string" ? app.title : undefined,
    }));
}

// GOG Galaxy's database (as the GOG Galaxy parser): product ids.
export async function galaxyInstalled(
  dbPath: string | undefined,
): Promise<InstalledGame[]> {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return [];
  }
  const tasks = await new SqliteWrapper("gog-galaxy", dbPath, {
    externals: false,
  }).read();
  return tasks.map((task) => ({
    store: "gog" as StoreKey,
    id: String(task.productId ?? ""),
    title: task.title || undefined,
  }));
}

// Windows' list of GOG installs (as the GOG Galaxy parser's registry
// option), which has the games of GOG's offline installers too.
export async function gogRegistryInstalled(): Promise<InstalledGame[]> {
  return (await readGogRegistryGames()).map((values) => ({
    store: "gog" as StoreKey,
    id: String(values.gameID ?? ""),
    title: values.gameName,
  }));
}

// The Amazon Games app's database (as the Amazon Games parser): the Id of
// each installed game, which is the product id the account lists.
export async function amazonInstalled(
  amazonGamesExe: string,
): Promise<InstalledGame[]> {
  const dbPath = amazonGamesDb(amazonGamesExe);
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const games = await new SqliteWrapper("amazon-games", dbPath).read();
  return games
    .filter((game) => game.Installed)
    .map((game) => ({
      store: "amazon" as StoreKey,
      id: String(game.Id ?? ""),
      title: game.ProductTitle || undefined,
    }));
}

// The EA app's installer data of each game: its content ids (an owned EA
// game is matched by its content id). The same folders as the EA Desktop
// parser; when that parser learns to find games through Windows' list of
// installed programs, this is the one function to move along with it.
export async function eaInstalled(
  eaGamesDir: string,
): Promise<InstalledGame[]> {
  if (!fs.existsSync(eaGamesDir)) {
    return [];
  }
  const xmlParser = new XMLParser();
  const games: InstalledGame[] = [];
  for (const file of await eaInstallerDataFiles(eaGamesDir)) {
    try {
      const buffer = fs.readFileSync(file);
      const { encoding } = await languageEncoding(buffer);
      const xml =
        encoding == "UTF-16LE" ? buffer.toString("utf16le") : buffer.toString();
      if (XMLValidator.validate(xml, {}) !== true) {
        continue;
      }
      games.push(...eaManifestIds(xmlParser.parse(xml)));
    } catch {
      // (one bad file: that game only)
    }
  }
  return games;
}

// The content ids (and title) in a parsed installerdata.xml, in either of
// its two shapes (DiPManifest, or game), as the EA Desktop parser reads it.
export function eaManifestIds(manifest: any): InstalledGame[] {
  const contentIds = json.caselessGet(
    manifest,
    [["DiPManifest", "game"], ["contentIDs"], ["contentID"]],
    true,
  );
  const ids = (Array.isArray(contentIds) ? contentIds : [contentIds])
    .filter((id) => id !== null && id !== undefined && id !== "")
    .map(String);
  let title: any = json.caselessGet(
    manifest,
    [["DiPManifest"], ["gameTitles"], ["gameTitle"]],
    true,
  );
  if (!title) {
    const localeInfo = json.caselessGet(
      manifest,
      [["game"], ["metadata"], ["localeInfo"]],
      true,
    );
    title = Array.isArray(localeInfo)
      ? localeInfo[0]?.title
      : localeInfo?.title;
  }
  title = Array.isArray(title) ? title[0] : title;
  return ids.map((id) => ({
    store: "ea" as StoreKey,
    id,
    title: title ? String(title) : undefined,
  }));
}

// The Battle.net agent's product.db (as the Battle.net parser): the launch
// code SRM knows a product by, which is the id the account lists; an
// unknown product by its own code.
export function battleNetInstalled(dbPath: string): InstalledGame[] {
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  return battleNetProductIds(readBattleNetProducts(dbPath));
}

export function battleNetProductIds(products: any[]): InstalledGame[] {
  return products
    .filter((product) => typeof product?.productCode === "string")
    .map((product) => {
      const known = BNET_GAMES[product.productCode.toLowerCase()];
      return {
        store: "battlenet" as StoreKey,
        id: known ? known.launchId : product.productCode,
        title: known?.name,
      };
    });
}

// The itch app's database (as the itch.io parser): the game of each
// install.
export async function itchInstalled(
  appDataDir: string | undefined,
): Promise<InstalledGame[]> {
  if (!appDataDir) {
    return [];
  }
  const dbPath = itchDbPath(appDataDir);
  if (!fs.existsSync(dbPath)) {
    return [];
  }
  const caves = await new SqliteWrapper("itch.io", dbPath).read();
  return caves.map((cave) => ({
    store: "itch" as StoreKey,
    id:
      cave.game_id === null || cave.game_id === undefined
        ? ""
        : String(cave.game_id),
    title: cave.title || undefined,
  }));
}
