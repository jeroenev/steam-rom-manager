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
  vi,
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
  setStoreAccountRefreshWait,
  storeAccountStamp,
} from "../../src/lib/parsers/store-account.parser";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import * as refresh from "../../src/lib/stores/refresh";
import {
  registerStoreClient,
  storeClient,
  unregisterStoreClient,
} from "../../src/lib/stores/registry";
import * as storage from "../../src/lib/stores/storage";
import {
  InstalledGame,
  InstalledOptions,
  readInstalledGames,
} from "../../src/lib/stores/installed-ids";
import { Launchers } from "../../src/lib/stores/targets";
import {
  OwnedGame,
  STORE_KEYS,
  StoreKey,
  ownedGame,
} from "../../src/lib/stores/types";
import {
  DEFAULT_BATTLE_NET_EXE,
  EXPLORER_EXE,
  POWERSHELL_EXE,
  galaxyPaths,
  itchDbPath,
} from "../../src/lib/helpers/launchers";
import { generateShortAppId } from "../../src/lib/helpers/steam/generate-app-id";
import {
  makeConfig,
  makeFakeSteam,
  makeSettings,
  tempDir,
} from "../helpers/fixtures";
import { makeLogger } from "../helpers/services-harness";
import {
  FakeHandler,
  FakeStoreHost,
  storeFixture,
} from "../helpers/fake-store-host";

const { DatabaseSync } = require("node:sqlite");

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

// A GOG login whose token is good for an hour and whose name is known: a
// refresh only lists the games.
function gogLogin(host: FakeStoreHost, accountName = "player") {
  return refresh.saveNewLogin(
    "gog",
    {
      accountName,
      data: {
        accessToken: "access",
        refreshToken: "refresh",
        userId: "1",
        expiresAt: Date.now() + 3600 * 1000,
      },
    },
    host,
  );
}

// GOG's library, from the fixtures.
const gogServer: FakeHandler = ({ url }) => {
  const u = new URL(url);
  if (u.pathname !== "/account/getFilteredProducts") {
    return { status: 404 };
  }
  return {
    body: storeFixture(
      "gog",
      u.searchParams.get("page") === "1"
        ? "products_page1.json"
        : "products_page2.json",
    ),
  };
};

const titles = (parsed: { parsedConfigs: any[] }) =>
  parsed.parsedConfigs[0].files.map((f: any) => f.titles.final).sort();

describe("Store Account parser (characterization)", () => {
  let root: string;
  let steamDir: string;
  const noNetwork: FakeHandler = () => new Error("no network in this test");
  const host = new FakeStoreHost(noNetwork);
  const parsersStore = () =>
    new ParsersStore(
      makeLogger().service as any,
      { get: () => makeSettings() } as any,
      {
        fuzzyMatcher: new FuzzyMatcher(undefined, {
          totalGames: 0,
          games: [],
        }),
      },
    );

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
    setStoreAccountRefreshWait(null);
    host.handler = noNetwork;
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

  it("Epic, Amazon, EA, Battle.net and Humble: each game opens its store's launcher; one installed from it is left out by its id", async () => {
    const epicExe =
      "C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe";
    const amazonExe =
      "C:\\Users\\alice\\AppData\\Local\\Amazon Games\\App\\Amazon Games.exe";
    const eaExe =
      "C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe";
    // What each store's client lists (ids and extra as they emit them).
    const owned: Partial<Record<StoreKey, OwnedGame[]>> = {
      epic: [
        ownedGame("epic", "Calluna", "Control", {
          namespace: "ns-control",
          catalog_item_id: "cat-control",
          product_slug: "control",
        }),
        ownedGame("epic", "Sugar", "Rocket League", {
          namespace: "ns-rl",
          catalog_item_id: "cat-rl",
        }),
      ],
      amazon: [
        ownedGame(
          "amazon",
          "amzn1.adg.product.11111111-1111-1111-1111-111111111111",
          "Fallout: New Vegas Ultimate Edition",
          { entitlement_id: "e1", sku: "FNV_SKU" },
        ),
        ownedGame("amazon", "amzn1.adg.product.2", "Morrowind"),
      ],
      ea: [
        ownedGame("ea", "Origin.OFR.50.0001", "Dead Space", {
          content_id: "1028663",
        }),
        // Installed: its installer data lists the content id, not the offer.
        ownedGame("ea", "Origin.OFR.50.0002", "Unravel", {
          content_id: "71512",
        }),
      ],
      battlenet: [
        ownedGame("battlenet", "WoW", "World of Warcraft", {
          internal_id: "wow",
        }),
        // A classic CD-key game: no launcher id, the download page.
        ownedGame("battlenet", "W3C", "Warcraft III: Reign of Chaos"),
        // Installed: product.db's code differs in case.
        ownedGame("battlenet", "W3", "Warcraft 3: Reforged", {
          internal_id: "w3",
        }),
      ],
      humble: [
        ownedGame("humble", "owlboy_subproduct", "Owlboy", {
          url: "https://www.humblebundle.com/home/library/owlboy",
        }),
      ],
    };
    const installedHere: Partial<Record<StoreKey, InstalledGame[]>> = {
      epic: [{ store: "epic", id: "Sugar" }],
      amazon: [{ store: "amazon", id: "amzn1.adg.product.2" }],
      ea: [{ store: "ea", id: "71512" }],
      battlenet: [{ store: "battlenet", id: "w3" }],
    };
    setStoreAccountEnvironment({
      launchers: () => ({
        ...windows,
        epic: epicExe,
        amazon: amazonExe,
        ea: eaExe,
        battlenet: DEFAULT_BATTLE_NET_EXE,
      }),
      installed: async (store) => installedHere[store] ?? [],
    });
    const shortcuts: Record<string, string[]> = {};
    for (const [store, games] of Object.entries(owned)) {
      storage.saveSession(
        store as StoreKey,
        { accountName: "player", data: {} },
        host,
      );
      library(store as StoreKey, games);
      const result = await parse(
        config({ storeAccount: store }, { configTitle: `${store} owned` }),
      );
      for (const file of result.parsedConfigs[0].files) {
        shortcuts[file.titles.final] = [
          file.executableLocation,
          file.argumentString,
          file.startInDirectory,
        ];
      }
    }
    const powershell = path.win32.dirname(POWERSHELL_EXE);
    const explorer = path.win32.dirname(EXPLORER_EXE);
    expect(Object.keys(shortcuts).sort()).toEqual([
      "Control",
      "Dead Space",
      "Fallout: New Vegas Ultimate Edition",
      "Owlboy",
      "Warcraft III: Reign of Chaos",
      "World of Warcraft",
    ]);
    expect(shortcuts["Control"][0]).toBe(POWERSHELL_EXE);
    expect(shortcuts["Control"][1]).toContain(
      "com.epicgames.launcher://apps/ns-control%3Acat-control%3ACalluna?action=launch&silent=true",
    );
    expect(shortcuts["Control"][2]).toBe(powershell);
    expect(shortcuts["Fallout: New Vegas Ultimate Edition"]).toEqual([
      amazonExe,
      "amazon-games://install/amzn1.adg.product.11111111-1111-1111-1111-111111111111",
      path.win32.dirname(amazonExe),
    ]);
    expect(shortcuts["Dead Space"][0]).toBe(POWERSHELL_EXE);
    expect(shortcuts["Dead Space"][1]).toContain(
      "origin2://game/launch/?offerIds=1028663",
    );
    expect(shortcuts["World of Warcraft"]).toEqual([
      DEFAULT_BATTLE_NET_EXE,
      "--game=wow",
      path.win32.dirname(DEFAULT_BATTLE_NET_EXE),
    ]);
    expect(shortcuts["Warcraft III: Reign of Chaos"]).toEqual([
      EXPLORER_EXE,
      '"https://download.battle.net/"',
      explorer,
    ]);
    expect(shortcuts["Owlboy"]).toEqual([
      EXPLORER_EXE,
      '"https://www.humblebundle.com/home/library/owlboy"',
      explorer,
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
    // (a store this version has no client for)
    const epic = storeClient("epic");
    unregisterStoreClient("epic");
    try {
      await expect(parse(config({ storeAccount: "epic" }))).rejects.toThrow(
        "Signing in to Epic Games Store comes with a later version of SRM",
      );
    } finally {
      if (epic) {
        registerStoreClient(epic);
      }
    }
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
    const parsers = parsersStore();
    const gog = config({});
    const itch = (title: string) =>
      config({ storeAccount: "itch" }, { configTitle: title, parserId: "i" });
    const first = await parsers.executeFileParserReusing(gog, itch("A"));
    expect(first.reparsed).toBe(2);
    // (only the edited parser)
    const second = await parsers.executeFileParserReusing(gog, itch("B"));
    expect(second.reparsed).toBe(1);
    const stamp = storeAccountStamp(gog.parserInputs);
    library(
      "gog",
      [...gogGames, ownedGame("gog", "9", "Gris")],
      Date.now() + 1,
    );
    expect(storeAccountStamp(gog.parserInputs)).not.toBe(stamp);
    const third = await parsers.executeFileParserReusing(gog, itch("C"));
    expect(third.reparsed).toBe(2);
    expect(
      third.parsedData.parsedConfigs[0].files.map((f) => f.titles.final),
    ).toContain("Gris");
  });

  it("after a run that fetched a library, a refresh where nothing changed still parses everything", async () => {
    await gogLogin(host);
    library("gog", gogGames, 1);
    host.canRefresh = true;
    host.handler = gogServer;
    const parsers = parsersStore();
    const gog = config({});
    const itch = config(
      { storeAccount: "itch" },
      { configTitle: "itch", parserId: "i" },
    );
    const first = await parsers.executeFileParserReusing(gog, itch);
    expect(first.reparsed).toBe(2);
    // (the parser fetched the old library)
    expect(refresh.cachedLibrary("gog")!.fetchedAt).toBeGreaterThan(1);
    // Nothing changed: that's how new or removed files are picked up.
    const second = await parsers.executeFileParserReusing(gog, itch);
    expect(second.reparsed).toBe(2);
  });

  it("options left unset are on", async () => {
    // (as a parser saved without them has them)
    const bare = makeConfig({
      parserType: "Store Account",
      configTitle: "Owned",
      parserId: "owned",
      steamDirectory: steamDir,
      userAccounts: { specifiedAccounts: ["alice"] },
      parserInputs: { storeAccount: "gog" },
    });
    expect(bare.parserInputs).toEqual({ storeAccount: "gog" });
    expect(titles(await parse(bare))).toEqual([
      "Disco Elysium",
      "The Witcher 3: Wild Hunt",
    ]);
  });

  describe("an account signed out of, or into another, while its library is fetched", () => {
    // GOG answers once the test lets it.
    let asked: Promise<void>;
    let answer: () => void;
    beforeEach(async () => {
      await gogLogin(host);
      library("gog", gogGames, 1);
      host.canRefresh = true;
      let arrived: () => void;
      asked = new Promise((resolve) => (arrived = resolve));
      const answered = new Promise<void>((resolve) => (answer = resolve));
      host.handler = async (request) => {
        arrived();
        await answered;
        return gogServer(request);
      };
    });

    it("signed out: the parser has no games of the old login", async () => {
      const parsed = parse(config({}));
      await asked;
      await refresh.deleteAccount("gog");
      answer();
      await expect(parsed).rejects.toThrow("Not signed in to GOG");
    });

    it("another account: the parser has no games of the old one", async () => {
      const parsed = parse(config({}));
      await asked;
      await gogLogin(host, "someone else");
      answer();
      await expect(parsed).rejects.toThrow(
        "The games of the GOG account haven't been fetched",
      );
    });
  });

  it("in the app, an old library that takes long to fetch is waited for briefly, then the list from before is used", async () => {
    await gogLogin(host);
    library("gog", gogGames, 1);
    host.canRefresh = true;
    let answer: (() => void) | undefined;
    host.handler = () =>
      new Promise((resolve) => {
        answer = () => resolve(new Error("gone"));
      });
    setStoreAccountRefreshWait(50);
    expect(titles(await parse(config({})))).toEqual([
      "Disco Elysium",
      "The Witcher 3: Wild Hunt",
    ]);
    expect(host.logs.join("\n")).toContain(
      "they are being fetched again in the background",
    );
    // The fetch goes on meanwhile; end it.
    await vi.waitFor(() => expect(answer).toBeDefined());
    answer!();
    await vi.waitFor(() =>
      expect(refresh.accountStatus("gog").refreshing).toBe(false),
    );
  });

  it("leaves out games installed where the user's itch.io parser reads, not only where the itch app keeps them by default", async () => {
    // The itch app's data in a folder of the user's choice, with Celeste
    // Classic installed.
    const itchData = path.join(root, "custom-itch");
    fs.mkdirSync(path.dirname(itchDbPath(itchData)), { recursive: true });
    const db = new DatabaseSync(itchDbPath(itchData));
    db.exec(`create table games (id integer, title text);
      create table caves (game_id integer, verdict text);
      insert into games values (107, 'Celeste Classic');
      insert into caves values (107, '{"basePath":"C:/c"}');`);
    db.close();
    // Nowhere else to look.
    const nowhere: InstalledOptions = {
      osType: "Linux",
      home: path.join(root, "no-home"),
      heroicConfigDirs: [],
      epicManifestsDir: path.join(root, "none"),
      legendaryInstalledFile: path.join(root, "none.json"),
      galaxyDb: path.join(root, "none.db"),
      gogRegistry: false,
      itchAppDataDir: path.join(root, "none"),
    };
    setStoreAccountEnvironment({
      launchers: () => windows,
      installed: (store, locations) =>
        readInstalledGames(store, { ...nowhere, ...locations }),
    });
    const parsers = parsersStore();
    const owned = config(
      { storeAccount: "itch", storeSkipPrereleases: false },
      { configTitle: "itch.io owned" },
    );
    const before = await parsers.executeFileParserReusing(owned);
    expect(titles(before.parsedData)).toEqual([
      "Celeste Classic",
      "Shadwen demo",
    ]);
    parsers.add(
      makeConfig({
        parserType: "itch.io",
        configTitle: "itch.io",
        parserInputs: { itchIoAppDataOverride: itchData },
      }),
    );
    // (a parser's folder changing is a change: parsed again)
    const after = await parsers.executeFileParserReusing(owned);
    expect(titles(after.parsedData)).toEqual(["Shadwen demo"]);
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
