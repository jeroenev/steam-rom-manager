// Before a save adds more Store Account shortcuts (games the store accounts
// own but haven't installed) that Steam doesn't have yet than
// ownedGames.confirmAbove, the app asks first; the command line says so and
// goes on.
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
import * as paths from "../../src/paths";
import { Core } from "../../src/core/core";
import * as cli from "../../src/core/cli-commands";
import {
  confirmOwnedShortcuts,
  ownedShortcutsSaved,
  ownedShortcutsToAdd,
} from "../../src/core/owned-confirm";
import { PreviewData, PreviewDataApp } from "../../src/models";
import { EXPLORER_EXE, galaxyPaths } from "../../src/lib/helpers/launchers";
import {
  setStoreAccountEnvironment,
  setStoreAccountRefreshWait,
} from "../../src/lib/parsers/store-account.parser";
import { readOnlyStoreHost, setStoreHost } from "../../src/lib/stores/host";
import * as refresh from "../../src/lib/stores/refresh";
import * as storage from "../../src/lib/stores/storage";
import { Launchers } from "../../src/lib/stores/targets";
import { STORE_KEYS, ownedGame } from "../../src/lib/stores/types";
import {
  makeConfig,
  makeFakeSteam,
  makeSettings,
  tempDir,
} from "../helpers/fixtures";
import { FakeStoreHost } from "../helpers/fake-store-host";
import { makeFakeNetwork } from "../helpers/fake-network";
import { makeLogger } from "../helpers/services-harness";
import { readSteamUserState } from "../helpers/preview-harness";
import {
  ALICE,
  BOB,
  buildPreview,
  parsedConfig,
  parsedFile,
} from "../helpers/parsed-configs";

const shortcutsParser = require("steam-shortcut-editor");

const GALAXY_EXE = galaxyPaths("Windows_NT").exePath;

const gogGame = (title: string) =>
  parsedFile(GALAXY_EXE, title, `/command=runGame /gameId=${title}`, [
    "Not installed",
  ]);

describe("asking before adding many games that aren't installed", () => {
  it("asks above the limit only; 0 never asks", () => {
    expect(confirmOwnedShortcuts(100, 100)).toBe(false);
    expect(confirmOwnedShortcuts(101, 100)).toBe(true);
    expect(confirmOwnedShortcuts(0, 100)).toBe(false);
    expect(confirmOwnedShortcuts(5000, 0)).toBe(false);
    expect(confirmOwnedShortcuts(2, 1)).toBe(true);
    expect(confirmOwnedShortcuts(2, NaN)).toBe(false);
  });

  it("counts the Store Account shortcuts being added that aren't in Steam", () => {
    const app = (fields: Partial<PreviewDataApp>) =>
      ({ status: "add", parserType: "Store Account", ...fields }) as any;
    const data: PreviewData = {
      steam: {
        "1": {
          username: "alice",
          excluded: [],
          apps: {
            a: app({ notInSteam: true }),
            b: app({ notInSteam: false }),
            c: app({ notInSteam: true, status: "remove" }),
            d: app({ parserType: "Glob" }),
          },
        },
        "2": {
          username: "bob",
          excluded: [],
          apps: { a: app({ notInSteam: true }) },
        },
      },
    };
    expect(ownedShortcutsToAdd(data)).toBe(2);
    expect(ownedShortcutsToAdd(undefined)).toBe(0);
    // Saved: in Steam now (only what was added).
    ownedShortcutsSaved(data);
    expect(ownedShortcutsToAdd(data)).toBe(0);
    expect(data.steam["1"].apps.c.notInSteam).toBe(true);
  });

  describe("the preview says which Store Account shortcuts Steam has", () => {
    let root: string;
    let steamDir: string;

    beforeAll(() => {
      root = tempDir("owned-confirm");
      steamDir = makeFakeSteam(path.join(root, "steam"), [ALICE, BOB]);
      // Alice has GOG's Frostpunk in Steam already (from an earlier save).
      fs.writeFileSync(
        path.join(
          steamDir,
          "userdata",
          ALICE.accountID,
          "config",
          "shortcuts.vdf",
        ),
        shortcutsParser.writeBuffer({
          shortcuts: [
            {
              appid: -1000000002,
              AppName: "Frostpunk",
              Exe: `"${GALAXY_EXE}"`,
              StartDir: `"${path.win32.dirname(GALAXY_EXE)}"`,
            },
          ],
        }),
      );
    });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

    it("per Steam user; other parsers' apps carry nothing", async () => {
      const { result } = await buildPreview([
        parsedConfig(
          steamDir,
          "Store Account",
          "owned-gog",
          [gogGame("Frostpunk"), gogGame("Portal")],
          [ALICE, BOB],
          { store: "gog" },
        ),
        parsedConfig(steamDir, "Glob", "glob", [
          parsedFile("C:\\Emu\\snes9x.exe", "Chrono Trigger", "", []),
        ]),
      ]);
      const notInSteam = (account: string) =>
        Object.values(result.previewData![steamDir][account].apps)
          .map((app) => `${app.title}: ${app.notInSteam}`)
          .sort();
      expect(notInSteam(ALICE.accountID)).toEqual([
        "Chrono Trigger: undefined",
        "Frostpunk: false",
        "Portal: true",
      ]);
      expect(notInSteam(BOB.accountID)).toEqual([
        "Frostpunk: true",
        "Portal: true",
      ]);
      expect(ownedShortcutsToAdd(result.previewData)).toBe(3);
    });
  });

  describe("the command line", () => {
    const ACCOUNT = "11111111";
    const host = new FakeStoreHost(() => new Error("no network in this test"));
    const windows: Launchers = {
      osType: "Windows_NT",
      galaxy: GALAXY_EXE,
      heroicStores: [],
      opener: EXPLORER_EXE,
      flatpak: "/usr/bin/flatpak",
    };
    let root: string;
    let steamDir: string;
    const lines: string[] = [];
    const output: cli.CliOutput = {
      log: (line) => lines.push(line),
      inline: () => {},
    };

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      lines.length = 0;
      for (const file of fs.readdirSync(paths.userDataDir)) {
        fs.rmSync(path.join(paths.userDataDir, file), {
          recursive: true,
          force: true,
        });
      }
      root = tempDir("owned-confirm-cli");
      steamDir = makeFakeSteam(
        path.join(root, "steam"),
        [{ accountID: ACCOUNT, name: "alice" }],
        { userContent: true },
      );
      // A signed-in GOG account, its games as last fetched (now), nothing
      // installed.
      setStoreHost(host);
      host.canRefresh = false;
      setStoreAccountEnvironment({
        launchers: () => windows,
        installed: async () => [],
        steamTitles: () => new Set(),
      });
      storage.saveSession("gog", { accountName: "player", data: {} }, host);
      storage.saveLibrary("gog", {
        accountName: "player",
        fetchedAt: Date.now(),
        games: [
          ownedGame("gog", "1124301003", "Frostpunk"),
          ownedGame("gog", "1500000001", "Portal"),
        ],
        partial: false,
      });
      fs.writeFileSync(
        paths.userConfigurations,
        JSON.stringify([
          makeConfig({
            parserType: "Store Account",
            configTitle: "GOG owned",
            parserId: "owned-gog",
            steamDirectory: steamDir,
            steamCategories: ["Not installed"],
            userAccounts: { specifiedAccounts: ["alice"] },
            imageProviders: [],
            parserInputs: { storeAccount: "gog" },
          }),
        ]),
      );
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      setStoreAccountEnvironment();
      setStoreAccountRefreshWait(null);
      for (const store of STORE_KEYS) {
        await refresh.deleteAccount(store);
      }
      fs.rmSync(root, { recursive: true, force: true });
    });
    afterAll(() => setStoreHost(readOnlyStoreHost));

    async function add(confirmAbove: number) {
      const settings = makeSettings({
        environmentVariables: { steamDirectory: steamDir },
      });
      settings.ownedGames.confirmAbove = confirmAbove;
      fs.writeFileSync(paths.userSettings, JSON.stringify(settings));
      const core = new Core({
        logger: makeLogger().service,
        fetch: makeFakeNetwork(),
      });
      await core.load({ presets: false, refresh: false });
      const ok = await cli.add(core, output);
      // (saved: the list knows they're in Steam now)
      expect(ownedShortcutsToAdd(core.preview.getPreviewData())).toBe(0);
      return ok;
    }

    const added = () =>
      readSteamUserState(steamDir, ACCOUNT)
        .shortcuts.map((s: any) => s.AppName ?? s.appname)
        .sort();

    it("says it adds more than the limit, without asking, and adds them", async () => {
      expect(await add(1)).toBe(true);
      expect(lines).toContain(
        "Adding 2 games your store accounts own but haven't installed (more than 1: the app asks before this)",
      );
      expect(added()).toEqual(["Frostpunk", "My Manual Shortcut", "Portal"]);
    });

    it("says nothing at or under the limit, nor once they're in Steam", async () => {
      expect(await add(2)).toBe(true);
      expect(lines.join("\n")).not.toContain("haven't installed");
      // (in Steam now: a second run adds nothing new)
      lines.length = 0;
      expect(await add(1)).toBe(true);
      expect(lines.join("\n")).not.toContain("haven't installed");
      expect(added()).toEqual(["Frostpunk", "My Manual Shortcut", "Portal"]);
    });
  });
});
