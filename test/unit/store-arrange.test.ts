// Which owned games go into Steam (ported from BoilR's arrange.rs,
// platform.rs and owned.rs tests).
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ArrangeEntry,
  ArrangeSettings,
  DEFAULT_ARRANGE_SETTINGS,
  arrangeOwned,
  isPrerelease,
  labelledName,
  normalizeTitle,
  steamInstalledGames,
  steamInstalledTitles,
  storeRank,
} from "../../src/lib/stores/arrange";
import { StoreKey } from "../../src/lib/stores/types";
import { tempDir } from "../helpers/fixtures";

const entry = (title: string, store?: StoreKey): ArrangeEntry =>
  store ? { title, installed: false, store } : { title, installed: true };

// Installed from Epic, from a launcher without store ids, and owned on GOG
// and Epic.
const sample = (): ArrangeEntry[] => [
  entry("PREY"),
  entry("Rayman Legends"),
  entry("Prey", "gog"),
  entry("Frostpunk", "gog"),
  entry("Rocket League", "gog"),
  entry("Frostpunk", "epic"),
  entry("Rayman Legends", "epic"),
  entry("Alan Wake", "epic"),
];

function run(settings: ArrangeSettings, steam: string[]) {
  const { entries, arranged } = arrangeOwned(
    sample(),
    settings,
    new Set(steam.map(normalizeTitle)),
  );
  return { names: entries.map((e) => e.title).sort(), entries, arranged };
}

describe("owned games arrangement", () => {
  it("tells betas, demos and test servers from games", () => {
    for (const title of [
      "Barony (Beta)",
      "Shadwen demo",
      "Mortal Shell Tech Beta",
      "KillingFloor2Beta",
      "Some Game Playtest",
      "Game - Public Test Server",
      "Game PTS",
    ]) {
      expect(isPrerelease(title), title).toBe(true);
    }
    for (const title of [
      "DEMON'S TILT",
      "Hell is other demons",
      "Alpha Protocol",
      "Betrayal at Krondor",
      "Demolish & Build",
      "Frostpunk",
    ]) {
      expect(isPrerelease(title), title).toBe(false);
    }
  });

  it("compares titles by letters and digits", () => {
    expect(normalizeTitle("PREY")).toBe(normalizeTitle("Prey"));
    expect(normalizeTitle("Brothers - A Tale of Two Sons")).toBe(
      normalizeTitle("Brothers: A Tale of Two Sons"),
    );
    expect(normalizeTitle("Alice: Madness Returns™")).toBe(
      "alicemadnessreturns",
    );
    expect(normalizeTitle("Fallout 3")).not.toBe(normalizeTitle("Fallout 4"));
    expect(normalizeTitle("Ōkami HD")).toBe("ōkamihd");
  });

  it("the defaults leave one entry per game", () => {
    const { names, arranged } = run(DEFAULT_ARRANGE_SETTINGS, [
      "Rocket League",
    ]);
    expect(names).toEqual(["Alan Wake", "Frostpunk", "PREY", "Rayman Legends"]);
    expect(arranged).toEqual({
      inSteam: 1,
      installedElsewhere: 2,
      otherStore: 1,
    });
  });

  it("the preferred store keeps the game", () => {
    const frostpunk = (settings: ArrangeSettings) =>
      run(settings, [])
        .entries.filter((e) => e.title === "Frostpunk")
        .map((e) => e.store);
    expect(frostpunk(DEFAULT_ARRANGE_SETTINGS)).toEqual(["gog"]);
    expect(
      frostpunk({ ...DEFAULT_ARRANGE_SETTINGS, storeOrder: ["epic"] }),
    ).toEqual(["epic"]);
  });

  it("everything can be kept", () => {
    const { names, arranged } = run(
      {
        ...DEFAULT_ARRANGE_SETTINGS,
        skipGamesInSteam: false,
        skipInstalledElsewhere: false,
        multiStore: "all",
      },
      ["Rocket League"],
    );
    expect(names).toHaveLength(8);
    expect(arranged).toEqual({
      inSteam: 0,
      installedElsewhere: 0,
      otherStore: 0,
    });
  });

  it("copies in several stores can carry their store", () => {
    const { names } = run(
      {
        ...DEFAULT_ARRANGE_SETTINGS,
        skipInstalledElsewhere: false,
        multiStore: "labelStore",
      },
      [],
    );
    expect(names).toEqual([
      "Alan Wake",
      "Frostpunk (Epic)",
      "Frostpunk (GOG)",
      "PREY",
      "Prey",
      "Rayman Legends",
      "Rayman Legends",
      "Rocket League",
    ]);
  });

  it("ranks the listed stores first", () => {
    const order = ["epic", "gog"];
    expect(storeRank("epic", order)).toBeLessThan(storeRank("gog", order));
    expect(storeRank("gog", order)).toBeLessThan(storeRank("amazon", order));
    expect(storeRank("amazon", order)).toBeLessThan(storeRank("humble", order));
    expect(storeRank("humble", order)).toBeLessThan(
      storeRank("unknown", order),
    );
    expect(storeRank("gog")).toBeLessThan(storeRank("epic"));
  });

  it("labels names", () => {
    expect(labelledName("Frostpunk", "gog", false, false)).toBe("Frostpunk");
    expect(labelledName("Frostpunk", "gog", false, true)).toBe(
      "Frostpunk (Not installed)",
    );
    expect(labelledName("Frostpunk", "gog", true, false)).toBe(
      "Frostpunk (GOG)",
    );
    expect(labelledName("Frostpunk", "battlenet", true, true)).toBe(
      "Frostpunk (Battle.net, not installed)",
    );
  });

  describe("games Steam has installed", () => {
    const root = tempDir("steam-installed");
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file: string, content: string) => {
      const full = path.join(root, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    const manifest = (appid: number, name: string) =>
      `"AppState"\n{\n\t"appid"\t\t"${appid}"\n\t"universe"\t\t"1"\n\t"name"\t\t"${name}"\n\t"StateFlags"\t\t"4"\n}\n`;

    it("reads the manifests of every library folder", () => {
      const steam = path.join(root, "Steam");
      const library = path.join(root, "Library");
      // (Steam escapes the backslashes of Windows paths)
      const escaped = (p: string) => p.replace(/\\/g, "\\\\");
      write(
        "Steam/steamapps/libraryfolders.vdf",
        `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${escaped(steam)}"\n\t\t"apps"\n\t\t{\n\t\t}\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${escaped(library)}"\n\t}\n}\n`,
      );
      write(
        "Steam/steamapps/appmanifest_763890.acf",
        manifest(763890, "Wildermyth"),
      );
      write("Library/steamapps/appmanifest_1979.acf", manifest(1979, "1979"));
      write("Library/steamapps/appmanifest_5.acf", "broken");
      write("Library/steamapps/other.acf", manifest(6, "Not a manifest"));
      expect(
        steamInstalledGames(steam).sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        { appId: "1979", name: "1979" },
        { appId: "763890", name: "Wildermyth" },
      ]);
      expect(steamInstalledTitles(steam)).toEqual(
        new Set(["wildermyth", "1979"]),
      );
    });

    it("an older libraryfolders.vdf, or none", () => {
      const steam = path.join(root, "Old");
      write(
        "Old/steamapps/libraryfolders.vdf",
        `"LibraryFolders"\n{\n\t"TimeNextStatsReport"\t\t"1"\n\t"1"\t\t"${path.join(root, "OldLibrary").replace(/\\/g, "\\\\")}"\n}\n`,
      );
      write(
        "OldLibrary/steamapps/appmanifest_10.acf",
        manifest(10, "Counter-Strike"),
      );
      write(
        "Old/steamapps/appmanifest_20.acf",
        manifest(20, "Team Fortress Classic"),
      );
      expect(
        steamInstalledGames(steam)
          .map((g) => g.name)
          .sort(),
      ).toEqual(["Counter-Strike", "Team Fortress Classic"]);
      write("Bare/steamapps/appmanifest_30.acf", manifest(30, "Half-Life"));
      expect(steamInstalledGames(path.join(root, "Bare"))).toEqual([
        { appId: "30", name: "Half-Life" },
      ]);
      expect(steamInstalledGames(path.join(root, "Nothing"))).toEqual([]);
    });
  });
});
