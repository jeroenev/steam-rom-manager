import {
  GenericParser,
  ParsedData,
  ParserInfo,
  ParserType,
  UserConfiguration,
} from "../../models";
import { APP } from "../../variables";
import * as path from "path";
import * as _ from "lodash";
import {
  InstallWith,
  InstalledGame,
  InstalledLocations,
  Launchers,
  OwnedGame,
  OwnedLibrary,
  STORE_KEYS,
  STORE_NAMES,
  StoreKey,
  cachedLibrary,
  detectLaunchers,
  getStoreHost,
  installTarget,
  isPrerelease,
  isStoreKey,
  normalizeTitle,
  readInstalledGames,
  readSessionInfo,
  refreshIfStale,
  sgdbPlatformIdOf,
  steamInstalledTitles,
  storeClient,
} from "../stores";
import { messageOf } from "../stores/http";

// Every game a store account owns that isn't installed, as a shortcut that
// installs it: through the store's launcher, else Heroic (Linux), else the
// store's page. The account is signed in to from this parser's settings
// (the "account" input); its games come from the library the app last
// fetched (src/lib/stores), refreshed first when it's old.

// What the parser looks at on this machine besides the library; tests give
// fakes.
export interface StoreAccountEnvironment {
  launchers(): Launchers;
  // (`locations`: where the user's parsers read, besides the defaults)
  installed(
    store: StoreKey,
    locations: InstalledLocations,
  ): Promise<InstalledGame[]>;
  steamTitles(steamDir: string): Set<string>;
}

const systemEnvironment: StoreAccountEnvironment = {
  launchers: () => detectLaunchers(),
  installed: (store, locations) => readInstalledGames(store, locations),
  steamTitles: (steamDir) => steamInstalledTitles(steamDir),
};

let environment = systemEnvironment;

// (tests) None puts back this machine's.
export function setStoreAccountEnvironment(
  env?: Partial<StoreAccountEnvironment>,
) {
  environment = { ...systemEnvironment, ...env };
}

// Where the user's platform parsers read their launchers' data, besides the
// default places (ParsersStore sets it before a run from all the parsers):
// a game installed there is installed too.
let installedLocations: InstalledLocations = {};

export function setInstalledLocations(locations: InstalledLocations) {
  installedLocations = locations;
}

// The places the platform parsers among `configs` are set to read (each
// only where its override is set). Disabled parsers count too: like the
// default places, they say where a launcher keeps its games.
export function installedLocationsOf(
  configs: readonly UserConfiguration[],
): InstalledLocations {
  const set = (type: ParserType, input: string) =>
    _.uniq(
      configs
        .filter((config) => config.parserType === type)
        .map((config) => config.parserInputs?.[input])
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value !== ""),
    ).sort();
  return {
    epicManifestsDirs: set("Epic", "epicManifests"),
    legendaryInstalledFiles: set("Legendary", "legendaryInstalledFile"),
    amazonGamesExes: set("Amazon Games", "amazonGamesExeOverride"),
    eaGamesDirs: set("EA Desktop", "eaGamesDir"),
    itchAppDataDirs: set("itch.io", "itchIoAppDataOverride"),
  };
}

// In the app, how long the parser waits for an old library to be fetched
// before it uses the list from before (the fetch goes on, and the next Add
// Games parses what it brings). The command line waits in full: it has no
// window to hold up, and nothing fetches the library for it. Core.start
// sets it; null waits in full.
export const APP_REFRESH_WAIT_MS = 15 * 1000;
let refreshWaitMs: number | null = null;

export function setStoreAccountRefreshWait(ms: number | null) {
  refreshWaitMs = ms;
}

// The library of `store`: fetched again first when it's old (refreshIfStale
// falls back to the list from before itself when that fails).
async function currentLibrary(store: StoreKey): Promise<OwnedLibrary> {
  const refresh = refreshIfStale(store);
  const waitMs = refreshWaitMs;
  if (waitMs === null || !cachedLibrary(store)) {
    return refresh;
  }
  refresh.catch(() => undefined); // (an error is the account's: it shows it)
  let timer: ReturnType<typeof setTimeout>;
  const waited = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    const fetched = await Promise.race([refresh, waited]);
    if (fetched) {
      return fetched;
    }
  } finally {
    clearTimeout(timer);
  }
  // (read now, not before the wait: a sign-out, or a sign-in to another
  // account, meanwhile wins)
  const before = signedIn(store) ? cachedLibrary(store) : null;
  if (!before) {
    throw new Error(
      `The ${STORE_NAMES[store]} account changed while its games were being fetched`,
    );
  }
  getStoreHost().log?.(
    `Using the ${STORE_NAMES[store]} games fetched on ${new Date(before.fetchedAt).toISOString()}; they are being fetched again in the background.`,
  );
  return before;
}

export interface OwnedFilter {
  skipPrereleases: boolean;
  skipInstalledElsewhere: boolean;
  skipSteamInstalled: boolean;
}

// What's installed, for gamesToAdd: from this same store, its ids and
// titles (normalizeTitle); from every launcher SRM knows, titles (only
// needed with skipInstalledElsewhere).
export interface InstalledForFilter {
  sameStoreIds: Set<string>;
  sameStoreTitles: Set<string>;
  titles: Set<string>;
}

// The owned games that get a shortcut. A game installed from this same
// store, matched by its store id or its title, never does: the installed
// game has its own (through the store's parser, whose launcher-mode
// shortcut has the same program and, with the same title, the same app id).
// Then, as set: betas, demos and playtests; games installed from any
// launcher SRM knows (same title); and games Steam has installed itself
// (same title).
export function gamesToAdd(
  games: readonly OwnedGame[],
  installed: InstalledForFilter,
  steamTitles: Set<string>,
  filter: OwnedFilter,
): OwnedGame[] {
  return games.filter((game) => {
    if (storeIds(game).some((id) => installed.sameStoreIds.has(id))) {
      return false;
    }
    const title = normalizeTitle(game.title);
    if (installed.sameStoreTitles.has(title)) {
      return false;
    }
    if (filter.skipPrereleases && isPrerelease(game.title)) {
      return false;
    }
    if (filter.skipInstalledElsewhere && installed.titles.has(title)) {
      return false;
    }
    if (filter.skipSteamInstalled && steamTitles.has(title)) {
      return false;
    }
    return true;
  });
}

// The ids an installed copy of the game can have: EA's installer data lists
// content ids, the account offer ids; Battle.net's codes vary in case.
function storeIds(game: OwnedGame): string[] {
  const ids = [game.id, game.extra.content_id].filter((id) => !!id);
  return game.store === "battlenet" ? ids.map((id) => id.toLowerCase()) : ids;
}

function installedIds(store: StoreKey, games: InstalledGame[]): Set<string> {
  return new Set(
    games.map((game) =>
      store === "battlenet" ? game.id.toLowerCase() : game.id,
    ),
  );
}

// What a parse depends on besides the parser's settings (SRM's parse cache,
// #908): the library as last fetched, so a refreshed library is parsed
// again, and where installed games are read (other parsers' folders).
export function storeAccountStamp(inputs: { [key: string]: any }): string {
  const store = inputs?.storeAccount;
  if (!isStoreKey(store)) {
    return "";
  }
  return JSON.stringify([
    store,
    signedIn(store),
    cachedLibrary(store)?.fetchedAt ?? null,
    installedLocations,
  ]);
}

function signedIn(store: StoreKey) {
  try {
    return !!readSessionInfo(store);
  } catch {
    return true; // (there, but damaged: the refresh says so)
  }
}

export class StoreAccountParser implements GenericParser {
  private get lang() {
    return APP.lang.storeAccountParser;
  }

  getParserInfo(): ParserInfo {
    const info = this.lang.docs__md.input.join("");
    return {
      title: "Store Account",
      info: this.lang.docs__md.self.join(""),
      inputs: {
        storeAccount: {
          label: this.lang.storeInputTitle,
          placeholder: this.lang.storePlaceholder,
          inputType: "select",
          allowedValues: STORE_KEYS.map((store) => ({
            value: store,
            displayValue: STORE_NAMES[store],
          })),
          required: true,
          info,
        },
        // Sign-in and the library (not saved with the parser: see
        // "account" in parser.model.ts).
        storeAccountStatus: {
          label: this.lang.accountInputTitle,
          inputType: "account",
          accountOf: "storeAccount",
          info,
        },
        storeInstallWith: {
          label: this.lang.installWithInputTitle,
          inputType: "select",
          allowedValues: [
            { value: "auto", displayValue: this.lang.installWith.auto },
            { value: "heroic", displayValue: this.lang.installWith.heroic },
            { value: "browser", displayValue: this.lang.installWith.browser },
          ],
          initialValue: "auto",
          info,
        },
        storeSkipPrereleases: {
          label: this.lang.skipPrereleasesInputTitle,
          inputType: "toggle",
          initialValue: true,
          info,
        },
        storeSkipInstalledElsewhere: {
          label: this.lang.skipInstalledElsewhereInputTitle,
          inputType: "toggle",
          initialValue: true,
          info,
        },
        storeSkipSteamInstalled: {
          label: this.lang.skipSteamInstalledInputTitle,
          inputType: "toggle",
          initialValue: true,
          info,
        },
      },
    };
  }

  async execute(
    directories: string[],
    inputs: { [key: string]: any },
    cache?: { [key: string]: any },
  ): Promise<ParsedData> {
    try {
      return await this.parse(directories, inputs);
    } catch (err) {
      throw typeof err === "string"
        ? err
        : this.lang.errors.fatalError__i.interpolate({
            error: messageOf(err),
          });
    }
  }

  private async parse(
    directories: string[],
    inputs: { [key: string]: any },
  ): Promise<ParsedData> {
    const store = inputs.storeAccount;
    if (!isStoreKey(store)) {
      throw this.lang.errors.noStore;
    }
    const name = STORE_NAMES[store];
    if (!storeClient(store)) {
      throw this.lang.errors.unavailable__i.interpolate({ store: name });
    }
    if (!signedIn(store)) {
      throw this.lang.errors.notSignedIn__i.interpolate({ store: name });
    }
    // (fetched again first when it's old and this SRM can; refreshIfStale
    // itself falls back to the last fetched list while the account is
    // signed in)
    let library: OwnedLibrary;
    try {
      library = await currentLibrary(store);
    } catch (err) {
      // Signed out, or into another account, while it was fetched: that wins.
      if (!signedIn(store)) {
        throw this.lang.errors.notSignedIn__i.interpolate({ store: name });
      }
      throw this.lang.errors.noLibrary__i.interpolate({
        store: name,
        error: messageOf(err),
      });
    }

    // (an option left unset is on: these are on by default)
    const filter: OwnedFilter = {
      skipPrereleases: inputs.storeSkipPrereleases !== false,
      skipInstalledElsewhere: inputs.storeSkipInstalledElsewhere !== false,
      skipSteamInstalled: inputs.storeSkipSteamInstalled !== false,
    };
    const sameStore = await environment.installed(store, installedLocations);
    // (a title of only signs matches nothing)
    const titlesOf = (games: InstalledGame[]) =>
      games
        .map((game) => normalizeTitle(game.title || ""))
        .filter((title) => title !== "");
    const sameStoreTitles = new Set(titlesOf(sameStore));
    const titles = new Set<string>();
    if (filter.skipInstalledElsewhere) {
      for (const other of STORE_KEYS) {
        const games =
          other === store
            ? sameStore
            : await environment.installed(other, installedLocations);
        for (const title of titlesOf(games)) {
          titles.add(title);
        }
      }
    }
    // (directories are the Steam accounts' userdata folders)
    const steamTitles =
      filter.skipSteamInstalled && directories?.length
        ? environment.steamTitles(path.resolve(directories[0], "..", ".."))
        : new Set<string>();
    const games = gamesToAdd(
      library.games,
      {
        sameStoreIds: installedIds(store, sameStore),
        sameStoreTitles,
        titles,
      },
      steamTitles,
      filter,
    );

    const installWith: InstallWith = ["heroic", "browser"].includes(
      inputs.storeInstallWith,
    )
      ? inputs.storeInstallWith
      : "auto";
    const launchers = environment.launchers();
    return {
      success: games.map((game) => {
        const target = installTarget(game, installWith, launchers);
        // (its artwork: by its id at the store, where SteamGridDB knows it)
        const sgdbPlatformId = sgdbPlatformIdOf(game);
        return {
          extractedTitle: game.title,
          extractedAppId: game.id,
          filePath: target.exe,
          fileLaunchOptions: target.args,
          startInDirectory: target.startDir,
          ...(sgdbPlatformId && { sgdbPlatformId }),
        };
      }),
      failed: [],
    };
  }
}
