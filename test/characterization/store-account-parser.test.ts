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
  setWrappingLaunchers,
  storeAccountStamp,
  wrappingLaunchersOf,
} from "../../src/lib/parsers/store-account.parser";
import { wrapperExecutable } from "../../src/lib/launch-wrapper";
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
  writeFiles,
} from "../helpers/fixtures";
import { userDataDir } from "../../src/paths"; // the test stub's temp dir
import { sgdbCalls, sgdbIds, sgdbStoreIds } from "../stubs/sgdb-search";
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
    // (ParsersStore sets it before a run, from its parsers)
    setWrappingLaunchers([]);
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
      ubisoft: [
        ownedGame("ubisoft", "5408", "Rabbids Coding!", {
          space_id: "11111111-2222-3333-4444-555555555555",
        }),
        // Installed: Ubisoft Connect's registry key lists it.
        ownedGame("ubisoft", "46", "Far Cry 3"),
      ],
    };
    const installedHere: Partial<Record<StoreKey, InstalledGame[]>> = {
      epic: [{ store: "epic", id: "Sugar" }],
      amazon: [{ store: "amazon", id: "amzn1.adg.product.2" }],
      ea: [{ store: "ea", id: "71512" }],
      battlenet: [{ store: "battlenet", id: "w3" }],
      ubisoft: [{ store: "ubisoft", id: "46" }],
    };
    setStoreAccountEnvironment({
      launchers: () => ({
        ...windows,
        epic: epicExe,
        amazon: amazonExe,
        ea: eaExe,
        battlenet: DEFAULT_BATTLE_NET_EXE,
        ubisoft:
          "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe",
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
      "Rabbids Coding!",
      "Warcraft III: Reign of Chaos",
      "World of Warcraft",
    ]);
    // (the UPlay parser's program in launcher mode: the same shortcut once
    // it lists the game under this title)
    expect(shortcuts["Rabbids Coding!"]).toEqual([
      POWERSHELL_EXE,
      '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"uplay://install/5408\\""',
      powershell,
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

  it("Epic, EA and Battle.net games carry the id SteamGridDB knows them by; an exception's search replaces it", async () => {
    const owned: Partial<Record<StoreKey, OwnedGame[]>> = {
      epic: [
        ownedGame("epic", "Sugar", "Rocket League", {
          namespace: "ns-rl",
          catalog_item_id: "cat-rl",
        }),
        ownedGame("epic", "Calluna", "Control", {
          namespace: "ns-control",
          catalog_item_id: "cat-control",
        }),
      ],
      ea: [ownedGame("ea", "OFB-EAST:52735", "Zuma's Revenge!")],
      battlenet: [
        ownedGame("battlenet", "Pro", "Overwatch 2", {
          internal_id: "prometheus",
        }),
        ownedGame("battlenet", "W3C", "Warcraft III: Reign of Chaos"),
      ],
      ubisoft: [
        ownedGame("ubisoft", "3279", "STEEP", {
          space_id: "11111111-2222-3333-4444-555555555555",
          partner: "epic",
        }),
        ownedGame("ubisoft", "80", "Rayman Origins"),
      ],
    };
    for (const [store, games] of Object.entries(owned)) {
      storage.saveSession(
        store as StoreKey,
        { accountName: "player", data: {} },
        host,
      );
      library(store as StoreKey, games);
    }
    const parser = fileParser();
    parser.setUserExceptions({
      exceptions: [
        {
          id: "e1",
          matchTitle: "Control",
          timeStamp: 1,
          newTitle: "",
          searchTitle: "Control Ultimate Edition",
          sgdbId: "",
          commandLineArguments: "",
          excludeArtwork: false,
        },
      ],
      exclusions: [],
    });
    const result = await parser.executeFileParser(
      [
        config({}),
        ...Object.keys(owned).map((store) =>
          config(
            { storeAccount: store },
            { configTitle: `${store} owned`, parserId: `owned-${store}` },
          ),
        ),
      ],
      makeSettings(),
    );
    const files = result.parsedConfigs.flatMap((pc) => pc.files);
    expect(
      Object.fromEntries(
        files.map((f) => [f.titles.final, f.sgdbPlatformId ?? null]),
      ),
    ).toEqual({
      "Disco Elysium": null,
      "The Witcher 3: Wild Hunt": null,
      "Rocket League": { platform: "egs", id: "Sugar" },
      Control: null,
      "Zuma's Revenge!": { platform: "origin", id: "OFB-EAST:52735" },
      "Overwatch 2": { platform: "bnet", id: "prometheus" },
      "Warcraft III: Reign of Chaos": null,
      STEEP: {
        platform: "uplay",
        id: "11111111-2222-3333-4444-555555555555",
      },
      "Rayman Origins": null,
    });
    const control = files.find((f) => f.titles.final === "Control");
    expect(control.onlineImageQueries).toEqual(["Control Ultimate Edition"]);
    const rocketLeague = files.find((f) => f.titles.final === "Rocket League");
    expect(rocketLeague.onlineImageQueries).toEqual(["Rocket League"]);
  });

  it("drmProtect: a game's artwork backups are those of the game its store id names", async () => {
    // (a title search would find another game)
    sgdbStoreIds["egs/Sugar"] = 3113;
    sgdbIds["Rocket League"] = [999];
    const backups = path.join(userDataDir, "artworkBackups");
    writeFiles(backups, ["tall/3113.png", "tall/999.png"]);
    sgdbCalls.length = 0;
    try {
      storage.saveSession("epic", { accountName: "player", data: {} }, host);
      library("epic", [ownedGame("epic", "Sugar", "Rocket League")]);
      const result = await parse(
        config({ storeAccount: "epic" }, { drmProtect: true }),
      );
      const [file] = result.parsedConfigs[0].files;
      expect(file.backupImage.tall).toMatch(/3113\.png$/);
      expect(sgdbCalls).toEqual([
        {
          method: "retrieveIdsFromTitle",
          title: "Rocket League",
          platformIds: [{ platform: "egs", id: "Sugar" }],
        },
      ]);
    } finally {
      delete sgdbStoreIds["egs/Sugar"];
      delete sgdbIds["Rocket League"];
      fs.rmSync(backups, { recursive: true, force: true });
    }
  });

  it("uses the GOG Galaxy parser's program, so the shortcut keeps its id once installed", async () => {
    const [file] = (await parse(config({}))).parsedConfigs[0].files;
    expect(file.executableLocation).toBe(GALAXY_EXE);
    // (the GOG Galaxy parser in launcher mode, same title)
    expect(
      generateShortAppId(file.modifiedExecutableLocation, file.titles.final),
    ).toBe(generateShortAppId(`"${GALAXY_EXE}"`, file.titles.final));
  });

  // (the UPlay parser waits for the game only on Windows)
  it.runIf(process.platform === "win32")(
    "goes through SRM's launch script where the UPlay parser waits for the game, so the shortcut keeps its id once installed",
    async () => {
      const upc =
        "C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\upc.exe";
      storage.saveSession("ubisoft", { accountName: null, data: {} }, host);
      library("ubisoft", [ownedGame("ubisoft", "5408", "RabbidsCoding")]);
      setStoreAccountEnvironment({
        launchers: () => ({ ...windows, ubisoft: upc }),
        installed: async () => [],
      });
      const parsers = parsersStore();
      const owned = config(
        { storeAccount: "ubisoft" },
        { configTitle: "Ubisoft owned", parserId: "owned-ubisoft" },
      );
      const fileOf = async () =>
        (await parsers.executeFileParserReusing(owned)).parsedData
          .parsedConfigs[0].files[0];
      const uplay = (inputs: object, extra: object = {}) =>
        makeConfig({
          parserType: "UPlay",
          configTitle: "Ubisoft Connect",
          parserId: "uplay",
          parserInputs: { uplayLauncherMode: true, ...inputs },
          ...extra,
        });

      // The UPlay parser launches through Ubisoft Connect: PowerShell.
      parsers.add(uplay({ uplayWaitForExit: false }));
      const plain = await fileOf();
      expect(plain.modifiedExecutableLocation).toBe(`"${POWERSHELL_EXE}"`);
      expect(plain.launchWrapper).toBeUndefined();

      // It waits for the game: its shortcuts run SRM's launch script, and so
      // does this one, around the same install link, waiting for nothing.
      parsers.add(uplay({ uplayWaitForExit: true }, { parserId: "uplay-2" }));
      const wrapped = await fileOf();
      expect(wrapped.modifiedExecutableLocation).toBe(wrapperExecutable());
      expect(wrapped.launchWrapper).toEqual({
        target: `"${POWERSHELL_EXE}"`,
        noWait: true,
        preLaunch: [],
        postLaunch: [],
        postExit: [],
      });
      expect(wrapped.argumentString).toContain('\\"uplay://install/5408\\"');
      // The UPlay parser's shortcut of the installed game has the same
      // program and title: the same Steam shortcut.
      expect(
        generateShortAppId(
          wrapped.modifiedExecutableLocation,
          wrapped.titles.final,
        ),
      ).toBe(generateShortAppId(wrapperExecutable(), "RabbidsCoding"));
    },
  );

  it("goes through SRM's launch script where the store's launcher parser has the user's script wrapper; Heroic shortcuts don't", async () => {
    const parsers = parsersStore();
    const owned = config({}, { configTitle: "GOG owned", parserId: "o-gog" });
    parsers.add(
      makeConfig({
        parserType: "GOG Galaxy",
        configTitle: "GOG Galaxy",
        parserId: "galaxy",
        parserInputs: { gogLauncherMode: true },
        scriptWrapper: {
          enabled: true,
          preLaunch: { script: "", delay: 0 },
          postLaunch: { script: "", delay: 0 },
          postExit: { script: "", delay: 0 },
        },
      }),
    );
    const files = (await parsers.executeFileParserReusing(owned)).parsedData
      .parsedConfigs[0].files;
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.modifiedExecutableLocation).toBe(wrapperExecutable());
      expect(file.launchWrapper).toMatchObject({
        target: `"${GALAXY_EXE}"`,
        noWait: true,
      });
    }
    // Heroic (Linux) starts the game itself once it has installed it: its
    // shortcut stays as it is.
    setStoreAccountEnvironment({
      launchers: () => steamDeck,
      installed: async () => [],
    });
    const deck = (await parsers.executeFileParserReusing(owned)).parsedData
      .parsedConfigs[0].files;
    expect(deck.length).toBeGreaterThan(0);
    for (const file of deck) {
      expect(file.argumentString).toContain("heroic://launch/gog/");
      expect(file.launchWrapper).toBeUndefined();
    }
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

  it("with the options off, the same store's installed game is also matched by its title", async () => {
    setStoreAccountEnvironment({
      launchers: () => windows,
      installed: async (store) =>
        store === "gog"
          ? [{ store: "gog", id: "999", title: "DISCO ELYSIUM" }]
          : [],
    });
    const result = await parse(
      config({
        storeSkipPrereleases: false,
        storeSkipInstalledElsewhere: false,
        storeSkipSteamInstalled: false,
      }),
    );
    expect(titles(result)).not.toContain("Disco Elysium");
    expect(titles(result)).toContain("Unreal Tournament 2004");
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

  it("Linux: a game installed through Heroic keeps its Heroic shortcut; with store pages it's left out", async () => {
    // (Heroic installed The Witcher 3 from GOG; SRM has no Heroic parser)
    const throughHeroic: InstalledGame = {
      store: "gog",
      id: "1207664643",
      title: "The Witcher 3: Wild Hunt",
      via: "heroic",
    };
    setStoreAccountEnvironment({
      launchers: () => steamDeck,
      installed: async (store) => [
        ...(installed[store] ?? []),
        ...(store === "gog" ? [throughHeroic] : []),
      ],
    });
    const deck = await parse(config({}));
    const witcher = deck.parsedConfigs[0].files.find(
      (f: any) => f.titles.final === "The Witcher 3: Wild Hunt",
    );
    // The same shortcut as before the install (program and title): Heroic
    // starts the installed game.
    expect(witcher?.argumentString).toContain("heroic://launch/gog/1207664643");
    // (a game installed from the store's own launcher is still left out)
    expect(titles(deck)).not.toContain("Unreal Tournament 2004");

    // A shortcut that opens the store page would not start it: left out.
    const browser = await parse(config({ storeInstallWith: "browser" }));
    expect(titles(browser)).not.toContain("The Witcher 3: Wild Hunt");
    // On Windows (no Heroic), the same.
    setStoreAccountEnvironment({
      launchers: () => windows,
      installed: async (store) => [
        ...(installed[store] ?? []),
        ...(store === "gog" ? [throughHeroic] : []),
      ],
    });
    expect(titles(await parse(config({})))).not.toContain(
      "The Witcher 3: Wild Hunt",
    );
  });

  it("not signed in, a library never fetched: no games and says why, a store that comes later: fatal", async () => {
    await refresh.deleteAccount("gog");
    const signedOut = (await parse(config({}))).parsedConfigs[0];
    expect(signedOut.files).toEqual([]);
    expect(signedOut.skipped).toBe(
      "Not signed in to GOG. Sign in under **Account** in this parser's settings.",
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
    const neverFetched = (await parse(config({}))).parsedConfigs[0];
    expect(neverFetched.files).toEqual([]);
    expect(neverFetched.skipped).toContain(
      "The games of the GOG account haven't been fetched",
    );
  });

  it("a signed out parser doesn't stop the other parsers", async () => {
    // GOG's parser is signed out; itch.io's (a second Store Account
    // parser) works.
    await refresh.deleteAccount("gog");
    const { parsedConfigs } = await parse(
      config({}),
      config(
        { storeAccount: "itch" },
        { configTitle: "Itch", parserId: "owned-itch" },
      ),
    );
    const [gog, itch] = parsedConfigs;
    expect(gog.files).toEqual([]);
    expect(gog.skipped).toContain("Not signed in to GOG");
    expect(itch.files.length).toBeGreaterThan(0);
    expect(itch.skipped).toBeUndefined();
    // (signed in again: no longer skipped)
    storage.saveSession("gog", { accountName: "player", data: {} }, host);
    library("gog", gogGames);
    const again = (await parse(config({}))).parsedConfigs[0];
    expect(again.skipped).toBeUndefined();
    expect(again.files.length).toBeGreaterThan(0);
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
      const { parsedConfigs } = await parsed;
      expect(parsedConfigs[0].files).toEqual([]);
      expect(parsedConfigs[0].skipped).toContain("Not signed in to GOG");
    });

    it("another account: the parser has no games of the old one", async () => {
      const parsed = parse(config({}));
      await asked;
      await gogLogin(host, "someone else");
      answer();
      const { parsedConfigs } = await parsed;
      expect(parsedConfigs[0].files).toEqual([]);
      expect(parsedConfigs[0].skipped).toContain(
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

describe("wrappingLaunchersOf", () => {
  const parser = (parserType: string, extra: object = {}) =>
    makeConfig({ parserType, configTitle: parserType, ...extra });
  const wrapper = {
    scriptWrapper: {
      enabled: true,
      preLaunch: { script: "", delay: 0 },
      postLaunch: { script: "", delay: 0 },
      postExit: { script: "", delay: 0 },
    },
  };

  it("names the stores whose enabled launcher parser runs its games through SRM's launch script", () => {
    const configs = [
      // waits for the game (launching via the launcher)
      parser("UPlay", {
        parserInputs: { uplayLauncherMode: true, uplayWaitForExit: true },
      }),
      parser("EA Desktop", {
        parserInputs: { eaLauncherMode: true, eaWaitForExit: true },
      }),
      // (waiting needs launcher mode)
      parser("Epic", {
        parserInputs: { epicLauncherMode: false, epicWaitForExit: true },
      }),
      // Battle.net's always do
      parser("Battle.net"),
      // the user's script wrapper
      parser("itch.io", wrapper),
      // disabled: adds no shortcut
      parser("GOG Galaxy", { ...wrapper, disabled: true }),
      parser("Amazon Games"),
      // (not a launcher parser of a store)
      parser("Glob", wrapper),
    ];
    expect(wrappingLaunchersOf(configs, "Windows_NT")).toEqual([
      "ea",
      "battlenet",
      "itch",
      "ubisoft",
    ]);
    // Waiting for the game is Windows-only; the user's wrapper isn't.
    expect(wrappingLaunchersOf(configs, "Linux")).toEqual(["itch"]);
    // One of a store's parsers is enough.
    expect(
      wrappingLaunchersOf(
        [
          parser("Epic", { parserInputs: { epicLauncherMode: true } }),
          parser("Epic", {
            parserInputs: { epicLauncherMode: true, epicWaitForExit: true },
          }),
        ],
        "Windows_NT",
      ),
    ).toEqual(["epic"]);
    expect(wrappingLaunchersOf([], "Windows_NT")).toEqual([]);
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
      {
        sameStoreIds: new Set(["1234567", "pro"]),
        sameStoreTitles: new Set(),
        titles: new Set(),
      },
      new Set(),
      off,
    );
    expect(kept.map((g) => g.title)).toEqual(["Unravel"]);
  });

  it("leaves out a game installed from the same store by its title too, with the options off", () => {
    // EA: the owned offer id isn't one the installed game's installer data
    // lists (its content id wasn't known), but its launcher-mode shortcut
    // would be this one: the same program and title.
    const kept = gamesToAdd(
      [
        ownedGame("ea", "DR:225064100", "Battlefield 3"),
        ownedGame("ea", "Origin.OFR.50.0001", "Dead Space"),
      ],
      {
        sameStoreIds: new Set(["70619"]),
        sameStoreTitles: new Set(["battlefield3"]),
        titles: new Set(["deadspace"]),
      },
      new Set(),
      off,
    );
    expect(kept.map((g) => g.title)).toEqual(["Dead Space"]);
  });

  it("keeps a game installed through Heroic only where its shortcut starts it through Heroic, whatever another launcher has", () => {
    const games = [
      ownedGame("gog", "1", "Frostpunk"),
      ownedGame("gog", "2", "Disco Elysium"),
      ownedGame("gog", "3", "Portal"),
    ];
    const installed = {
      sameStoreIds: new Set<string>(),
      sameStoreTitles: new Set<string>(),
      // (Frostpunk by its id, Disco Elysium by its title)
      heroicIds: new Set(["1"]),
      heroicTitles: new Set(["discoelysium"]),
      // (Heroic's titles are among those of every launcher)
      titles: new Set(["frostpunk", "discoelysium", "portal"]),
    };
    const filter = { ...off, skipInstalledElsewhere: true };
    expect(
      gamesToAdd(games, installed, new Set(), filter, () => true).map(
        (g) => g.title,
      ),
    ).toEqual(["Frostpunk", "Disco Elysium"]);
    expect(gamesToAdd(games, installed, new Set(), filter)).toEqual([]);
  });

  it("compares titles by their letters and digits", () => {
    const kept = gamesToAdd(
      [
        ownedGame("gog", "1", "PREY"),
        ownedGame("gog", "2", "Brothers - A Tale of Two Sons"),
      ],
      {
        sameStoreIds: new Set(),
        sameStoreTitles: new Set(),
        titles: new Set(["prey"]),
      },
      new Set(["brothersataleoftwosons"]),
      { ...off, skipInstalledElsewhere: true },
    );
    expect(kept.map((g) => g.title)).toEqual(["Brothers - A Tale of Two Sons"]);
  });
});
