// The Store Account parser through the real FileParser: one shortcut per
// game the account owns and hasn't installed, opening the store's launcher
// (with the program SRM's launcher-mode parser for the store uses, so the
// shortcut keeps its id once the game is installed), Heroic, or the store
// page. The library comes from the cache (a fake host that can't refresh),
// the installed games and launchers are fakes; Steam's installed games come
// from a fake Steam folder.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as _ from "lodash";
import { FileParser } from "../../src/lib/file-parser";
import { FuzzyMatcher } from "../../src/lib/fuzzy-matcher";
import { ParsersStore } from "../../src/core/parsers-store";
import {
  gamesToAdd,
  setStoreAccountEnvironment,
  storeLibraryStamp,
} from "../../src/lib/parsers/store-account.parser";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import * as refresh from "../../src/lib/stores/refresh";
import * as storage from "../../src/lib/stores/storage";
import { InstalledGame } from "../../src/lib/stores/installed-ids";
import { Launchers } from "../../src/lib/stores/targets";
import {
  OwnedGame,
  STORE_KEYS,
  StoreKey,
  ownedGame,
} from "../../src/lib/stores/types";
import { EXPLORER_EXE, galaxyPaths } from "../../src/lib/helpers/launchers";
import { generateShortAppId } from "../../src/lib/helpers/steam/generate-app-id";
import {
  makeConfig,
  makeFakeSteam,
  makeSettings,
  tempDir,
} from "../helpers/fixtures";
import { makeLogger } from "../helpers/services-harness";
import { FakeStoreHost } from "../helpers/fake-store-host";

// SRM's GOG Galaxy parser starts games with this program in launcher mode.
const GALAXY_EXE = galaxyPaths("Windows_NT").exePath;

const windows: Launchers = {
  osType: "Windows_NT",
  galaxy: GALAXY_EXE,
  heroicStores: [],
  opener: EXPLORER_EXE,
  flatpak: "/usr/bin/flatpak",
};

const steamDeck: Launchers = {
  osType: "Linux",
  heroic: { kind: "flatpak" },
  heroicStores: ["gog"],
  opener: "/usr/bin/xdg-open",
  flatpak: "/usr/bin/flatpak",
};

const gogGames: OwnedGame[] = [
  ownedGame("gog", "1207658924", "Unreal Tournament 2004", {
    slug: "unreal_tournament_2004",
  }),
  ownedGame("gog", "1308320804", "Barony (Beta)"),
  ownedGame("gog", "1124301003", "Frostpunk", { slug: "frostpunk" }),
  ownedGame("gog", "1500000001", "Portal"),
  ownedGame("gog", "1207664643", "The Witcher 3: Wild Hunt", {
    slug: "the_witcher_3_wild_hunt",
  }),
  ownedGame("gog", "1771589310", "Disco Elysium"),
];

const itchGames: OwnedGame[] = [
  ownedGame("itch", "107", "Celeste Classic", {
    url: "https://mattmakesgames.itch.io/celesteclassic",
  }),
  ownedGame("itch", "209", "Shadwen demo"),
];

// What's installed: GOG's Unreal Tournament (by its id), Frostpunk from
// Epic (by title).
const installed: Partial<Record<StoreKey, InstalledGame[]>> = {
  gog: [{ store: "gog", id: "1207658924", title: "Unreal Tournament 2004" }],
  epic: [{ store: "epic", id: "Fennec", title: "FROSTPUNK" }],
};

function fileParser() {
  const fuzzyMatcher = new FuzzyMatcher(undefined, {
    totalGames: 0,
    games: [],
  });
  return new FileParser({ fuzzyMatcher } as any);
}

// What a shortcut is made of, by title.
function summarize(result: any) {
  return result.parsedConfigs.map((pc: any) => ({
    configurationTitle: pc.configurationTitle,
    failed: pc.failed,
    files: _.sortBy(pc.files, (f: any) => f.titles.final).map((f: any) => ({
      title: f.titles.final,
      executableLocation: f.executableLocation,
      modifiedExecutableLocation: f.modifiedExecutableLocation,
      argumentString: f.argumentString,
      startInDirectory: f.startInDirectory,
      steamCategories: f.steamCategories,
    })),
  }));
}

function library(store: StoreKey, games: OwnedGame[], fetchedAt = Date.now()) {
  storage.saveLibrary(store, {
    accountName: "player",
    fetchedAt,
    games,
    partial: false,
  });
}

describe("Store Account parser (characterization)", () => {
  let root: string;
  let steamDir: string;
  const host = new FakeStoreHost(() => new Error("no network in this test"));

  const config = (inputs: object, extra: object = {}) =>
    makeConfig({
      parserType: "Store Account",
      configTitle: "Owned",
      parserId: "owned",
      steamDirectory: steamDir,
      steamCategories: ["Not installed"],
      userAccounts: { specifiedAccounts: ["alice"] },
      parserInputs: {
        storeAccount: "gog",
        storeInstallWith: "auto",
        storeSkipPrereleases: true,
        storeSkipInstalledElsewhere: true,
        storeSkipSteamInstalled: true,
        ...inputs,
      },
      ...extra,
    });
  const parse = (...configs: any[]) =>
    fileParser().executeFileParser(configs, makeSettings());

  beforeAll(() => {
    root = tempDir("store-account");
    steamDir = makeFakeSteam(path.join(root, "steam"), [
      { accountID: "11111111", name: "alice" },
    ]);
    // Steam has Portal installed.
    const steamapps = path.join(steamDir, "steamapps");
    fs.mkdirSync(steamapps, { recursive: true });
    fs.writeFileSync(
      path.join(steamapps, "appmanifest_400.acf"),
      '"AppState"\n{\n\t"appid"\t\t"400"\n\t"name"\t\t"Portal"\n}\n',
    );
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  beforeEach(() => {
    setStoreHost(host);
    // (the cache only: nothing is fetched)
    host.canRefresh = false;
    setStoreAccountEnvironment({
      launchers: () => windows,
      installed: async (store) => installed[store] ?? [],
    });
    storage.saveSession("gog", { accountName: "player", data: {} }, host);
    storage.saveSession("itch", { accountName: "player", data: {} }, host);
    library("gog", gogGames);
    library("itch", itchGames);
  });
  afterEach(async () => {
    setStoreAccountEnvironment();
    for (const store of STORE_KEYS) {
      await refresh.deleteAccount(store);
    }
  });
  afterAll(() => setStoreHost(readOnlyStoreHost));

  it("GOG on Windows: Galaxy opens the game; installed, prerelease, installed elsewhere and Steam's games are left out", async () => {
    const result = await parse(config({}));
    expect(summarize(result)).toMatchSnapshot();
    const titles = result.parsedConfigs[0].files.map((f) => f.titles.final);
    expect(titles.sort()).toEqual([
      "Disco Elysium",
      "The Witcher 3: Wild Hunt",
    ]);
  });

  it("uses the GOG Galaxy parser's program, so the shortcut keeps its id once installed", async () => {
    const [file] = (await parse(config({}))).parsedConfigs[0].files;
    expect(file.executableLocation).toBe(GALAXY_EXE);
    // (the GOG Galaxy parser in launcher mode, same title)
    expect(
      generateShortAppId(file.modifiedExecutableLocation, file.titles.final),
    ).toBe(generateShortAppId(`"${GALAXY_EXE}"`, file.titles.final));
  });

  it("with the options off, only the same store's installed game is left out", async () => {
    const result = await parse(
      config({
        storeSkipPrereleases: false,
        storeSkipInstalledElsewhere: false,
        storeSkipSteamInstalled: false,
      }),
    );
    expect(
      result.parsedConfigs[0].files.map((f) => f.titles.final).sort(),
    ).toEqual([
      "Barony (Beta)",
      "Disco Elysium",
      "Frostpunk",
      "Portal",
      "The Witcher 3: Wild Hunt",
    ]);
  });

  it("itch.io without the itch app, and Linux with Heroic: store pages and Heroic links", async () => {
    const itch = await parse(
      config({ storeAccount: "itch" }, { configTitle: "itch.io owned" }),
    );
    setStoreAccountEnvironment({
      launchers: () => steamDeck,
      installed: async (store) => installed[store] ?? [],
    });
    const deck = await parse(
      config({}, { configTitle: "GOG owned on a Steam Deck" }),
    );
    const browser = await parse(
      config(
        { storeInstallWith: "browser" },
        { configTitle: "GOG owned, store pages" },
      ),
    );
    expect([
      ...summarize(itch),
      ...summarize(deck),
      ...summarize(browser),
    ]).toMatchSnapshot();
  });

  it("not signed in, a store that comes later, a library never fetched: says which", async () => {
    await refresh.deleteAccount("gog");
    await expect(parse(config({}))).rejects.toThrow(
      "Not signed in to GOG. Sign in under **Account**",
    );
    await expect(parse(config({ storeAccount: "epic" }))).rejects.toThrow(
      "Signing in to Epic Games Store comes with a later version of SRM",
    );
    storage.saveSession("gog", { accountName: "player", data: {} }, host);
    await expect(parse(config({}))).rejects.toThrow(
      "The games of the GOG account haven't been fetched",
    );
  });

  it("an old library is used as it is where it can't be fetched", async () => {
    library("gog", gogGames, 1);
    const result = await parse(config({}));
    expect(result.parsedConfigs[0].files).toHaveLength(2);
  });

  it("Add Games' refresh parses a Store Account parser again once its library was fetched again", async () => {
    const parsers = new ParsersStore(
      makeLogger().service as any,
      { get: () => makeSettings() } as any,
      {
        fuzzyMatcher: new FuzzyMatcher(undefined, {
          totalGames: 0,
          games: [],
        }),
      },
    );
    const gog = config({});
    const itch = (title: string) =>
      config({ storeAccount: "itch" }, { configTitle: title, parserId: "i" });
    const first = await parsers.executeFileParserReusing(gog, itch("A"));
    expect(first.reparsed).toBe(2);
    // (only the edited parser)
    const second = await parsers.executeFileParserReusing(gog, itch("B"));
    expect(second.reparsed).toBe(1);
    const stamp = storeLibraryStamp(gog.parserInputs);
    library(
      "gog",
      [...gogGames, ownedGame("gog", "9", "Gris")],
      Date.now() + 1,
    );
    expect(storeLibraryStamp(gog.parserInputs)).not.toBe(stamp);
    const third = await parsers.executeFileParserReusing(gog, itch("C"));
    expect(third.reparsed).toBe(2);
    expect(
      third.parsedData.parsedConfigs[0].files.map((f) => f.titles.final),
    ).toContain("Gris");
  });
});

describe("gamesToAdd", () => {
  const off = {
    skipPrereleases: false,
    skipInstalledElsewhere: false,
    skipSteamInstalled: false,
  };

  it("matches an installed EA game by its content id, Battle.net's by any case", () => {
    const games = [
      ownedGame("ea", "Origin.OFR.50.0001", "Dead Space", {
        content_id: "1234567",
      }),
      ownedGame("ea", "Origin.OFR.50.0002", "Unravel"),
      ownedGame("battlenet", "Pro", "Overwatch"),
    ];
    const kept = gamesToAdd(
      games,
      { sameStoreIds: new Set(["1234567", "pro"]), titles: new Set() },
      new Set(),
      off,
    );
    expect(kept.map((g) => g.title)).toEqual(["Unravel"]);
  });

  it("compares titles by their letters and digits", () => {
    const kept = gamesToAdd(
      [
        ownedGame("gog", "1", "PREY"),
        ownedGame("gog", "2", "Brothers - A Tale of Two Sons"),
      ],
      { sameStoreIds: new Set(), titles: new Set(["prey"]) },
      new Set(["brothersataleoftwosons"]),
      { ...off, skipInstalledElsewhere: true },
    );
    expect(kept.map((g) => g.title)).toEqual(["Brothers - A Tale of Two Sons"]);
  });
});
