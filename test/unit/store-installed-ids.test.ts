// Which games of a store are installed, by store id: read from the places
// SRM's platform parsers read, plus Heroic's lists.
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as installed from "../../src/lib/stores/installed-ids";
import { tempDir } from "../helpers/fixtures";

const { DatabaseSync } = require("node:sqlite");

const root = tempDir("installed-ids");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file: string, content: string | Buffer) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function makeDb(file: string, sql: string) {
  const full = path.join(root, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const db = new DatabaseSync(full);
  db.exec(sql);
  db.close();
  return full;
}

const ids = (games: installed.InstalledGame[]) => games.map((g) => g.id).sort();

// Nowhere to look but where a test says.
const nowhere: installed.InstalledOptions = {
  osType: "Linux",
  home: path.join(root, "no-home"),
  heroicConfigDirs: [],
  epicManifestsDir: path.join(root, "none"),
  legendaryInstalledFile: path.join(root, "none.json"),
  galaxyDb: path.join(root, "none.db"),
  gogRegistry: false,
  itchAppDataDir: path.join(root, "none"),
};

describe("installed store ids", () => {
  it("Epic: the launcher's manifests, Legendary and Heroic", async () => {
    const manifests = path.join(root, "Manifests");
    write(
      "Manifests/a.item",
      JSON.stringify({ AppName: "Fortnite", DisplayName: "Fortnite" }),
    );
    write(
      "Manifests/b.item",
      JSON.stringify({ AppName: "Bluegill", DisplayName: "DREDGE" }),
    );
    write("Manifests/broken.item", "{");
    write("Manifests/other.txt", JSON.stringify({ AppName: "Nope" }));
    const legendary = write(
      "legendary/installed.json",
      JSON.stringify({
        Eider: { app_name: "Eider", title: "HITMAN", is_dlc: false },
        dlc1: { app_name: "dlc1", title: "HITMAN DLC", is_dlc: true },
      }),
    );
    const heroic = path.join(root, "heroic");
    write(
      "heroic/legendaryConfig/legendary/installed.json",
      JSON.stringify({ Sugar: { app_name: "Sugar", title: "Rocket League" } }),
    );
    const games = await installed.readInstalledGames("epic", {
      ...nowhere,
      epicManifestsDir: manifests,
      legendaryInstalledFile: legendary,
      heroicConfigDirs: [heroic, path.join(root, "no-heroic")],
    });
    expect(ids(games)).toEqual(["Bluegill", "Eider", "Fortnite", "Sugar"]);
    expect(games.find((g) => g.id === "Bluegill")).toEqual({
      store: "epic",
      id: "Bluegill",
      title: "DREDGE",
    });
  });

  it("GOG: Galaxy's database and Heroic", async () => {
    const galaxyDb = makeDb(
      "galaxy-2.0.db",
      `create table LimitedDetails (productId integer, title text);
       create table PlayTasks (id integer, gameReleaseKey text, isPrimary integer);
       create table PlayTaskLaunchParameters (playTaskId integer, executablePath text, commandLineArgs text);
       insert into LimitedDetails values (1207658924, 'Unreal Gold');
       insert into PlayTasks values (10, 'gog_1207658924', 1), (11, 'generic_5', 1), (12, 'gog_1207658924', 0);
       insert into PlayTaskLaunchParameters values (10, 'C:/unreal.exe', null);`,
    );
    write(
      "heroic-gog/gog_store/installed.json",
      JSON.stringify({
        installed: [
          { appName: "1207664663", platform: "windows", install_path: "/x" },
        ],
      }),
    );
    const games = await installed.readInstalledGames("gog", {
      ...nowhere,
      galaxyDb,
      heroicConfigDirs: [path.join(root, "heroic-gog")],
    });
    expect(ids(games)).toEqual(["1207658924", "1207664663"]);
    expect(games.find((g) => g.id === "1207658924")?.title).toBe("Unreal Gold");
  });

  it("Amazon: Heroic's Nile lists, in both shapes", async () => {
    write(
      "heroic-a/nile_config/nile/installed.json",
      JSON.stringify([
        { id: "amzn1.adg.product.1", path: "/games/Fallout New Vegas" },
      ]),
    );
    write(
      "heroic-b/nile_config/nile/installed.json",
      JSON.stringify({
        installed: [{ id: "amzn1.adg.product.2", path: "/games/Morrowind/" }],
      }),
    );
    const games = await installed.readInstalledGames("amazon", {
      ...nowhere,
      heroicConfigDirs: [
        path.join(root, "heroic-a"),
        path.join(root, "heroic-b"),
      ],
    });
    expect(games).toEqual([
      {
        store: "amazon",
        id: "amzn1.adg.product.1",
        title: "Fallout New Vegas",
      },
      { store: "amazon", id: "amzn1.adg.product.2", title: "Morrowind" },
    ]);
  });

  it.runIf(os.type() === "Windows_NT")(
    "Amazon: the Amazon Games app's installed games",
    async () => {
      const exe = write("Amazon Games/App/Amazon Games.exe", "");
      makeDb(
        "Amazon Games/Data/Games/Sql/GameInstallInfo.sqlite",
        `create table DbSet (ProductTitle text, InstallDirectory text, Installed integer, Id text);
         insert into DbSet values ('Installed', 'C:/a', 1, 'amzn1.adg.product.a'), ('Removed', 'C:/b', 0, 'amzn1.adg.product.b');`,
      );
      const games = await installed.readInstalledGames("amazon", {
        ...nowhere,
        osType: "Windows_NT",
        amazonGamesExe: exe,
      });
      expect(games).toEqual([
        { store: "amazon", id: "amzn1.adg.product.a", title: "Installed" },
      ]);
    },
  );

  it("EA: every content id in the installer data, in either shape and encoding", async () => {
    const ea = path.join(root, "EA Games");
    write(
      "EA Games/Game One/__Installer/installerdata.xml",
      `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <gameTitles><gameTitle locale="en_US">Game One</gameTitle></gameTitles>
  <contentIDs><contentID>1002139</contentID><contentID>1002140</contentID></contentIDs>
</DiPManifest>`,
    );
    write(
      "EA Games/Game Two/__Installer/installerdata.xml",
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          `<?xml version="1.0" encoding="utf-16"?>
<game><metadata><localeInfo><title>Game Two</title></localeInfo></metadata>
<contentIDs><contentID>71512</contentID></contentIDs></game>`,
          "utf16le",
        ),
      ]),
    );
    write("EA Games/Broken/__Installer/installerdata.xml", "<DiPManifest>");
    const games = await installed.readInstalledGames("ea", {
      ...nowhere,
      eaGamesDir: ea,
    });
    expect(games.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { store: "ea", id: "1002139", title: "Game One" },
      { store: "ea", id: "1002140", title: "Game One" },
      { store: "ea", id: "71512", title: "Game Two" },
    ]);
  });

  it("EA: wherever Windows lists an EA app install (as the EA Desktop parser), not in a Steam library, each folder once", async () => {
    const manifest = (title: string, contentId: string) =>
      `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <gameTitles><gameTitle locale="en_US">${title}</gameTitle></gameTitles>
  <contentIDs><contentID>${contentId}</contentID></contentIDs>
</DiPManifest>`;
    const folder = (dir: string, title: string, contentId: string) =>
      path.dirname(
        path.dirname(
          write(
            `${dir}/__Installer/installerdata.xml`,
            manifest(title, contentId),
          ),
        ),
      );
    folder("listed/Games/Default/One", "One", "111");
    const alice = folder(
      "listed/OriginLibrary/Alice Madness Returns",
      "Alice",
      "alice2_dd",
    );
    const parserDir = path.join(root, "listed", "Parser");
    const fromParser = folder("listed/Parser/Two", "Two", "222");
    const steam = folder(
      "listed/SteamLibrary/steamapps/common/UnravelTwo",
      "Unravel Two",
      "1035049",
    );
    const notEA = path.join(root, "listed", "Not EA");
    fs.mkdirSync(notEA, { recursive: true });
    const games = await installed.readInstalledGames("ea", {
      ...nowhere,
      osType: "Windows_NT",
      eaGamesDir: path.join(root, "listed", "Games", "Default"),
      installLocations: [
        alice + path.sep,
        alice.toUpperCase(),
        fromParser,
        steam,
        notEA,
        path.join(root, "listed", "Missing"),
      ],
      eaGamesDirs: [parserDir],
    });
    expect(games.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { store: "ea", id: "111", title: "One" },
      { store: "ea", id: "222", title: "Two" },
      { store: "ea", id: "alice2_dd", title: "Alice" },
    ]);
  });

  it("EA: elsewhere than Windows, only where a parser points", async () => {
    const parserDir = path.dirname(
      path.dirname(
        path.dirname(
          write(
            "linux-ea/Games/Three/__Installer/installerdata.xml",
            `<DiPManifest><gameTitles><gameTitle>Three</gameTitle></gameTitles><contentIDs><contentID>333</contentID></contentIDs></DiPManifest>`,
          ),
        ),
      ),
    );
    expect(await installed.readInstalledGames("ea", nowhere)).toEqual([]);
    expect(
      await installed.readInstalledGames("ea", {
        ...nowhere,
        eaGamesDirs: [parserDir],
      }),
    ).toEqual([{ store: "ea", id: "333", title: "Three" }]);
  });

  it("Battle.net: SRM's launch code for known products, the product's own otherwise", () => {
    expect(
      installed.battleNetProductIds([
        { productCode: "pro", uid: "prometheus" },
        { productCode: "hsb", uid: "hs_beta" },
        { productCode: "newgame", uid: "newgame" },
        { uid: "no code" },
      ]),
    ).toEqual([
      { store: "battlenet", id: "Pro", title: "Overwatch 2" },
      { store: "battlenet", id: "WTCG", title: "Hearthstone" },
      { store: "battlenet", id: "newgame", title: undefined },
    ]);
  });

  it("itch: the game of each install in the itch app's database", async () => {
    makeDb(
      "itch/db/butler.db",
      `create table games (id integer, title text);
       create table caves (game_id integer, verdict text);
       insert into games values (284880, 'Pikuniku'), (9, 'Not installed');
       insert into caves values (284880, '{"basePath":"C:/p"}');`,
    );
    const games = await installed.readInstalledGames("itch", {
      ...nowhere,
      itchAppDataDir: path.join(root, "itch"),
    });
    expect(games).toEqual([{ store: "itch", id: "284880", title: "Pikuniku" }]);
  });

  it("itch: the Flatpak's database too, on Linux", async () => {
    const home = path.join(root, "deck");
    makeDb(
      "deck/.var/app/io.itch.itch/config/itch/db/butler.db",
      `create table games (id integer, title text);
       create table caves (game_id integer, verdict text);
       insert into games values (7, 'Flatpak Game');
       insert into caves values (7, '{"basePath":"/f"}');`,
    );
    const games = await installed.readInstalledGames("itch", {
      ...nowhere,
      home,
      itchAppDataDir: undefined,
    });
    expect(games).toEqual([{ store: "itch", id: "7", title: "Flatpak Game" }]);
  });

  it("also reads where the user's parsers are set to read, each place once", async () => {
    write(
      "custom/Manifests/c.item",
      JSON.stringify({ AppName: "Custom", DisplayName: "Custom Game" }),
    );
    const legendary = write(
      "custom/legendary.json",
      JSON.stringify({ Moved: { app_name: "Moved", title: "Moved Game" } }),
    );
    write(
      "custom/EA/Game/__Installer/installerdata.xml",
      `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <gameTitles><gameTitle locale="en_US">Elsewhere</gameTitle></gameTitles>
  <contentIDs><contentID>555</contentID></contentIDs>
</DiPManifest>`,
    );
    const itchData = path.join(root, "custom", "itch");
    makeDb(
      "custom/itch/db/butler.db",
      `create table games (id integer, title text);
       create table caves (game_id integer, verdict text);
       insert into games values (8, 'Custom itch');
       insert into caves values (8, '{"basePath":"/c"}');`,
    );
    const custom: installed.InstalledOptions = {
      ...nowhere,
      epicManifestsDirs: [path.join(root, "custom", "Manifests")],
      legendaryInstalledFiles: [legendary],
      // (the EA app's games, outside Windows only where a parser points)
      eaGamesDirs: [path.join(root, "custom", "EA")],
      itchAppDataDirs: [itchData, `${itchData}${path.sep}`],
    };
    expect(ids(await installed.readInstalledGames("epic", custom))).toEqual([
      "Custom",
      "Moved",
    ]);
    expect(ids(await installed.readInstalledGames("ea", custom))).toEqual([
      "555",
    ]);
    expect(await installed.readInstalledGames("itch", custom)).toEqual([
      { store: "itch", id: "8", title: "Custom itch" },
    ]);
  });

  it("finds nothing, and doesn't fail, where nothing is installed or a file is damaged", async () => {
    write("damaged/legendary.json", "{");
    write("damaged/heroic/gog_store/installed.json", "not json");
    makeDb("damaged/galaxy.db", "create table Other (x integer);");
    for (const store of [
      "epic",
      "gog",
      "amazon",
      "ea",
      "battlenet",
      "humble",
      "itch",
    ] as const) {
      expect(
        await installed.readInstalledGames(store, {
          ...nowhere,
          legendaryInstalledFile: path.join(root, "damaged/legendary.json"),
          heroicConfigDirs: [path.join(root, "damaged/heroic")],
          galaxyDb: path.join(root, "damaged/galaxy.db"),
          eaGamesDir: path.join(root, "none"),
          battleNetProductDb: path.join(root, "none.db"),
        }),
      ).toEqual([]);
    }
  });
});
