import { GenericParser, ParsedData, ParserInfo } from "../../models";
import { APP } from "../../variables";
import * as path from "path";
import {
  InstallWith,
  InstalledGame,
  Launchers,
  OwnedGame,
  STORE_KEYS,
  STORE_NAMES,
  StoreKey,
  cachedLibrary,
  detectLaunchers,
  installTarget,
  isPrerelease,
  isStoreKey,
  normalizeTitle,
  readInstalledGames,
  readSessionInfo,
  refreshIfStale,
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
  installed(store: StoreKey): Promise<InstalledGame[]>;
  steamTitles(steamDir: string): Set<string>;
}

const systemEnvironment: StoreAccountEnvironment = {
  launchers: () => detectLaunchers(),
  installed: (store) => readInstalledGames(store),
  steamTitles: (steamDir) => steamInstalledTitles(steamDir),
};

let environment = systemEnvironment;

// (tests) None puts back this machine's.
export function setStoreAccountEnvironment(
  env?: Partial<StoreAccountEnvironment>,
) {
  environment = { ...systemEnvironment, ...env };
}

export interface OwnedFilter {
  skipPrereleases: boolean;
  skipInstalledElsewhere: boolean;
  skipSteamInstalled: boolean;
}

// The owned games that get a shortcut. A game installed from this same
// store, matched by its store id, never does: the installed game has its
// own (through the store's parser). Then, as set: betas, demos and
// playtests; games installed from any launcher SRM knows (same title); and
// games Steam has installed itself (same title).
export function gamesToAdd(
  games: readonly OwnedGame[],
  installed: { sameStoreIds: Set<string>; titles: Set<string> },
  steamTitles: Set<string>,
  filter: OwnedFilter,
): OwnedGame[] {
  return games.filter((game) => {
    if (storeIds(game).some((id) => installed.sameStoreIds.has(id))) {
      return false;
    }
    if (filter.skipPrereleases && isPrerelease(game.title)) {
      return false;
    }
    const title = normalizeTitle(game.title);
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
// again.
export function storeLibraryStamp(inputs: { [key: string]: any }): string {
  const store = inputs?.storeAccount;
  if (!isStoreKey(store)) {
    return "";
  }
  return JSON.stringify([
    store,
    signedIn(store),
    cachedLibrary(store)?.fetchedAt ?? null,
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
    // (fetched again first when it's old and this SRM can; otherwise, and
    // when that fails, as last fetched)
    let library = cachedLibrary(store);
    try {
      library = await refreshIfStale(store);
    } catch (err) {
      if (!library) {
        throw this.lang.errors.noLibrary__i.interpolate({
          store: name,
          error: messageOf(err),
        });
      }
    }

    // (an option left unset is on: these are on by default)
    const filter: OwnedFilter = {
      skipPrereleases: inputs.storeSkipPrereleases !== false,
      skipInstalledElsewhere: inputs.storeSkipInstalledElsewhere !== false,
      skipSteamInstalled: inputs.storeSkipSteamInstalled !== false,
    };
    const sameStore = await environment.installed(store);
    const titles = new Set<string>();
    if (filter.skipInstalledElsewhere) {
      for (const other of STORE_KEYS) {
        const games =
          other === store ? sameStore : await environment.installed(other);
        for (const game of games) {
          if (game.title) {
            titles.add(normalizeTitle(game.title));
          }
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
      { sameStoreIds: installedIds(store, sameStore), titles },
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
        return {
          extractedTitle: game.title,
          extractedAppId: game.id,
          filePath: target.exe,
          fileLaunchOptions: target.args,
          startInDirectory: target.startDir,
        };
      }),
      failed: [],
    };
  }
}
