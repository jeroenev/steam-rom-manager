// Which games of a store are installed on this machine, by the store's own
// id: an owned game whose id is here is installed, so the Store Account
// parser leaves it out (the installed game has its own shortcut). Read
// from the same places SRM's platform parsers read (src/lib/helpers/
// launchers, the EA Desktop parser's own search, and the folders the user's
// parsers are set to), plus Heroic's lists and the itch Flatpak on Linux.
//
// Every reader returns nothing rather than fail: a launcher that isn't
// there, or a file that can't be read, means no installed games from it.

import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as _ from "lodash";
import { SqliteWrapper } from "../helpers/sqlite";
import { installLocations } from "../helpers/windows/installed-programs";
import {
  defaultGamesDirs as defaultEaGamesDirs,
  gameFolders as eaGameFolders,
  readInstallerData,
} from "../parsers/ea-desktop/installed-games";
import {
  BATTLE_NET_PRODUCT_DB,
  BNET_GAMES,
  HeroicRunner,
  amazonGamesDb,
  defaultAmazonGamesExe,
  defaultEpicManifestsDir,
  defaultLegendaryInstalledFile,
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
  // Installed through Heroic (Linux). SRM has no parser for Heroic's games,
  // so the Store Account parser keeps such a game when its shortcut starts
  // it through Heroic.
  via?: "heroic";
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
  // Where the EA app's games are searched instead of EA's default folders
  // (as the EA Desktop parser's folder field).
  eaGamesDir?: string;
  // The folders of the programs Windows lists as installed, where the EA
  // app's games are found wherever they are (default: Windows' lists, on
  // Windows).
  installLocations?: string[];
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
      quietly(() =>
        tagged(store, readHeroicInstalled(dir, runner)).map((game) => ({
          ...game,
          via: "heroic" as const,
        })),
      ),
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
      sources = [
        quietly(async () => eaInstalled(await eaFolders(options, onWindows))),
      ];
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

// The folders the EA app installed games in, found as the EA Desktop parser
// finds them (src/lib/parsers/ea-desktop): on Windows, those in EA's default
// folders (or `eaGamesDir`) and wherever Windows' installed programs say,
// except in a Steam library; on any system, those in the folders the user's
// EA Desktop parsers are set to. Each folder once.
export async function eaFolders(
  options: InstalledOptions,
  onWindows: boolean,
): Promise<string[]> {
  const searches: Promise<string[]>[] = [];
  if (
    onWindows ||
    options.eaGamesDir !== undefined ||
    options.installLocations !== undefined
  ) {
    searches.push(
      eaGameFolders({
        gamesDir: options.eaGamesDir,
        installLocations:
          options.installLocations ??
          (onWindows ? await installLocations() : []),
        defaultDirs: onWindows ? defaultEaGamesDirs : [],
      }),
    );
  }
  for (const dir of options.eaGamesDirs ?? []) {
    searches.push(eaGameFolders({ gamesDir: dir, installLocations: [] }));
  }
  // (a folder that can't be searched adds nothing)
  const found = await Promise.all(
    searches.map((search) => search.catch((): string[] => [])),
  );
  // (case-insensitively, as gameFolders and Windows compare them)
  return _.uniqBy(found.flat(), (folder) => path.resolve(folder).toLowerCase());
}

// The content ids (and title) of the game in each of `folders`, from its
// installer data, read as the EA Desktop parser reads it: an owned EA game
// is matched by any of its content ids. A game counts whether or not its exe
// is where the installer data says (as in the parser's launcher mode).
export async function eaInstalled(folders: string[]): Promise<InstalledGame[]> {
  const games: InstalledGame[] = [];
  for (const folder of folders) {
    try {
      const game = await readInstallerData(folder, { launcherMode: true });
      if (typeof game === "string") {
        continue; // (one bad file: that game only)
      }
      games.push(
        ...game.contentIds.map((id) => ({
          store: "ea" as StoreKey,
          id,
          title: game.title,
        })),
      );
    } catch {
      // (one bad file: that game only)
    }
  }
  return games;
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
