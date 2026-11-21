// A game the Store Account parsers of several stores list (the same title)
// gets one shortcut per Steam user: the one of the store that comes first in
// the store order (settings: ownedGames), or one from every store. Only
// among Store Account parsers, and per Steam directory and user account.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  ownedInOtherStores,
  otherParsersAppIds,
} from "../../src/core/preview-builder";
import {
  AppSettings,
  ParsedUserConfigurationFile,
  ParserType,
} from "../../src/models";
import { POWERSHELL_EXE, galaxyPaths } from "../../src/lib/helpers/launchers";
import { StoreKey } from "../../src/lib/stores/types";
import { makeFakeSteam, makeSettings, tempDir } from "../helpers/fixtures";
import {
  ALICE,
  BOB,
  buildPreview,
  parsedConfig,
  parsedFile as file,
} from "../helpers/parsed-configs";

const GALAXY_EXE = galaxyPaths("Windows_NT").exePath;
const AMAZON_EXE =
  "C:\\Users\\alice\\AppData\\Local\\Amazon Games\\App\\Amazon Games.exe";

// One shortcut per store: each store's own program, so different app ids.
const gogGame = (title: string) =>
  file(GALAXY_EXE, title, `/command=runGame /gameId=${title}`, [
    "Not installed",
  ]);
const epicGame = (title: string) =>
  file(
    POWERSHELL_EXE,
    title,
    `-Command "&Start-Process \\"com.epicgames.launcher://apps/${title}?action=launch&silent=true\\""`,
    ["Not installed"],
  );
const amazonGame = (title: string) =>
  file(AMAZON_EXE, title, `amazon-games://install/${title}`, ["Not installed"]);

describe("a game the Store Account parsers of several stores list", () => {
  let root: string;
  let steamDir: string;

  beforeAll(() => {
    root = tempDir("owned-stores");
    steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE, BOB]);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const owned = (
    store: StoreKey,
    files: ParsedUserConfigurationFile[],
    accounts = [ALICE],
  ) =>
    parsedConfig(steamDir, "Store Account", `owned-${store}`, files, accounts, {
      store,
    });
  const other = (
    parserType: ParserType,
    parserId: string,
    files: ParsedUserConfigurationFile[],
  ) => parsedConfig(steamDir, parserType, parserId, files);

  const settings = (ownedGames: Partial<AppSettings["ownedGames"]> = {}) => {
    const s = makeSettings({
      previewSettings: { retrieveCurrentSteamImages: false },
    });
    Object.assign(s.ownedGames, ownedGames);
    return s;
  };

  async function preview(
    configs: Parameters<typeof buildPreview>[0],
    appSettings = settings(),
  ) {
    const { result, logged } = await buildPreview(configs, appSettings);
    // "title (parser)" per Steam user, sorted.
    const apps = (account: string) =>
      Object.values(result.previewData![steamDir][account].apps)
        .map((app) => `${app.title} (${app.parserId})`)
        .sort();
    return { result, apps, logged };
  }

  const gog = () =>
    owned("gog", [gogGame("Frostpunk"), gogGame("Prey"), gogGame("Portal")]);
  const epic = (accounts = [ALICE]) =>
    owned("epic", [epicGame("FROSTPUNK"), epicGame("Control")], accounts);
  const amazon = () => owned("amazon", [amazonGame("Prey™")]);

  it("keeps the shortcut of the store that comes first: GOG by default", async () => {
    const { apps, logged } = await preview([epic(), amazon(), gog()]);
    expect(apps(ALICE.accountID)).toEqual([
      "Control (owned-epic)",
      "Frostpunk (owned-gog)",
      "Portal (owned-gog)",
      "Prey (owned-gog)",
    ]);
    expect(logged.join("\n")).toContain(
      "Left out 2 Store Account shortcut(s) for games another of your store accounts also owns",
    );
  });

  it("follows the store order in the settings", async () => {
    const { apps } = await preview(
      [gog(), epic(), amazon()],
      settings({ storeOrder: ["amazon", "epic"] }),
    );
    expect(apps(ALICE.accountID)).toEqual([
      "Control (owned-epic)",
      "FROSTPUNK (owned-epic)",
      "Portal (owned-gog)",
      "Prey™ (owned-amazon)",
    ]);
  });

  it('keeps a shortcut from every store with "all"', async () => {
    const { apps, logged } = await preview(
      [gog(), epic(), amazon()],
      settings({ multiStore: "all" }),
    );
    expect(apps(ALICE.accountID)).toEqual([
      "Control (owned-epic)",
      "FROSTPUNK (owned-epic)",
      "Frostpunk (owned-gog)",
      "Portal (owned-gog)",
      "Prey (owned-gog)",
      "Prey™ (owned-amazon)",
    ]);
    expect(logged.join("\n")).not.toContain("another of your store accounts");
  });

  it("decides per Steam user: another user's shortcuts are their own", async () => {
    // (GOG's parser is only for Alice)
    const { apps } = await preview([gog(), epic([ALICE, BOB])]);
    expect(apps(ALICE.accountID)).toEqual([
      "Control (owned-epic)",
      "Frostpunk (owned-gog)",
      "Portal (owned-gog)",
      "Prey (owned-gog)",
    ]);
    expect(apps(BOB.accountID)).toEqual([
      "Control (owned-epic)",
      "FROSTPUNK (owned-epic)",
    ]);
  });

  it("leaves other parsers' shortcuts alone", async () => {
    // Frostpunk installed through the Epic parser (another program than the
    // Store Account's): the Store Account parsers' own settings leave out
    // games installed elsewhere, not this.
    const installed = other("Epic", "epic-installed", [
      file("C:\\Games\\Frostpunk\\Frostpunk.exe", "Frostpunk", "", ["Epic"]),
    ]);
    const { apps } = await preview([installed, epic(), gog()]);
    expect(apps(ALICE.accountID)).toEqual([
      "Control (owned-epic)",
      "Frostpunk (epic-installed)",
      "Frostpunk (owned-gog)",
      "Portal (owned-gog)",
      "Prey (owned-gog)",
    ]);
  });

  it("a Store Account shortcut another parser already adds doesn't count", () => {
    // Epic's Frostpunk is the installed Epic parser's (same program and
    // title), so it isn't added; GOG's stays although Epic comes first.
    const installed = other("Epic", "epic-installed", [epicGame("FROSTPUNK")]);
    const configs = [installed, epic(), gog()];
    const leftOut = ownedInOtherStores(
      configs,
      { multiStore: "preferred", storeOrder: ["epic", "gog"] },
      otherParsersAppIds(configs),
    );
    expect(leftOut.size).toBe(0);
    // (without the other parser, GOG's goes)
    const alone = ownedInOtherStores([epic(), gog()], {
      multiStore: "preferred",
      storeOrder: ["epic", "gog"],
    });
    expect(
      [...alone.values()].flatMap((files) =>
        [...files].map((f) => f.titles.final),
      ),
    ).toEqual(["Frostpunk"]);
  });

  it("a Store Account result without its store takes no part", () => {
    const unknown = parsedConfig(steamDir, "Store Account", "owned-unknown", [
      epicGame("Frostpunk"),
    ]);
    expect(
      ownedInOtherStores([unknown, gog()], {
        multiStore: "preferred",
        storeOrder: ["epic", "gog"],
      }).size,
    ).toBe(0);
  });
});
