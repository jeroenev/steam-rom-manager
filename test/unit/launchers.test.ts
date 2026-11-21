// The launcher paths and programs the platform parsers and the owned-games
// code share: what the parsers produced before these were shared must not
// change (Steam shortcut ids come from the program and the title).
import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  POWERSHELL_EXE,
  amazonGamesDb,
  defaultAmazonGamesExe,
  defaultEpicManifestsDir,
  defaultItchAppDataDir,
  findItchAppDataDir,
  galaxyPaths,
  itchAppDataDirs,
  itchDbPath,
  heroicConfigDirs,
  installedBattleNetProducts,
  powershellOpen,
  readHeroicInstalled,
} from "../../src/lib/helpers/launchers";
import { EpicParser } from "../../src/lib/parsers/epic.parser";
import { EADesktopParser } from "../../src/lib/parsers/ea-desktop.parser";
import { tempDir } from "../helpers/fixtures";

// (the EA parser also finds the games Windows lists as installed: none
// here, not this machine's)
vi.mock(
  "../../src/lib/helpers/windows/installed-programs",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    installLocations: async (): Promise<string[]> => [],
  }),
);

describe("launchers", () => {
  const root = tempDir("launchers");
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("PowerShell opens a link exactly as the Epic and EA parsers always did", () => {
    expect(POWERSHELL_EXE).toBe(
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(powershellOpen("origin2://game/launch/?offerIds=1")).toBe(
      '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=1\\""',
    );
  });

  it("knows where each launcher keeps its data", () => {
    expect(defaultAmazonGamesExe("C:\\Users\\A\\AppData\\Roaming")).toBe(
      "C:\\Users\\A\\AppData\\local\\Amazon Games\\App\\Amazon Games.exe",
    );
    expect(
      amazonGamesDb(
        "C:\\Users\\A\\AppData\\local\\Amazon Games\\App\\Amazon Games.exe",
      ),
    ).toBe(
      "C:\\Users\\A\\AppData\\local\\Amazon Games\\Data\\Games\\Sql\\GameInstallInfo.sqlite",
    );
    expect(defaultEpicManifestsDir("Windows_NT")).toBe(
      "C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests",
    );
    expect(defaultEpicManifestsDir("Linux")).toBeUndefined();
    expect(galaxyPaths("Windows_NT")?.exePath).toBe(
      "C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe",
    );
    expect(galaxyPaths("Linux")).toBeUndefined();
    expect(defaultItchAppDataDir("Linux", "/home/deck")).toBe(
      "/home/deck/.config/itch",
    );
    expect(itchAppDataDirs("Linux", "/home/deck")).toEqual([
      "/home/deck/.config/itch",
      "/home/deck/.var/app/io.itch.itch/config/itch",
    ]);
    expect(itchAppDataDirs("Windows_NT", "C:\\Users\\A", "C:\\AD")).toEqual([
      "C:\\AD\\itch",
    ]);
    expect(heroicConfigDirs("/home/deck")).toEqual([
      "/home/deck/.config/heroic",
      "/home/deck/.var/app/com.heroicgameslauncher.hgl/config/heroic",
    ]);
    expect(
      installedBattleNetProducts({
        productInstall: [
          { uid: "agent" },
          { uid: "battle.net" },
          { uid: "s2" },
        ],
      }),
    ).toEqual([{ uid: "s2" }]);
  });

  it("the itch app's folder: the native app's, the Flatpak's when only it has a database", () => {
    const home = path.join(root, "deck");
    const native = path.join(home, ".config", "itch");
    const flatpak = path.join(home, ".var/app/io.itch.itch/config/itch");
    const found = () => path.normalize(findItchAppDataDir("Linux", home) ?? "");
    // Neither: the native app's (what the parser always looked for).
    expect(found()).toBe(path.normalize(native));
    fs.mkdirSync(path.dirname(itchDbPath(flatpak)), { recursive: true });
    fs.writeFileSync(itchDbPath(flatpak), "");
    expect(found()).toBe(path.normalize(flatpak));
    // Both: the native app's.
    fs.mkdirSync(path.dirname(itchDbPath(native)), { recursive: true });
    fs.writeFileSync(itchDbPath(native), "");
    expect(found()).toBe(path.normalize(native));
  });

  it("reads Heroic's installed lists, without DLC", () => {
    const dir = path.join(root, "heroic");
    const file = path.join(dir, "legendaryConfig/legendary/installed.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        Eider: { app_name: "Eider", title: "HITMAN", is_dlc: false },
        "0a73": { app_name: "0a73", title: "HITMAN DLC", is_dlc: true },
      }),
    );
    expect(readHeroicInstalled(dir, "legendary")).toEqual([
      { id: "Eider", title: "HITMAN" },
    ]);
    expect(readHeroicInstalled(dir, "gog")).toEqual([]);
  });

  describe.runIf(os.type() === "Windows_NT")("parsers", () => {
    it("Epic's launcher mode starts games through PowerShell, as before", async () => {
      const manifests = path.join(root, "Manifests");
      const install = path.join(root, "Games", "Dredge");
      fs.mkdirSync(manifests, { recursive: true });
      fs.mkdirSync(install, { recursive: true });
      fs.writeFileSync(path.join(install, "DREDGE.exe"), "");
      fs.writeFileSync(
        path.join(manifests, "dredge.item"),
        JSON.stringify({
          DisplayName: "DREDGE",
          AppName: "Bluegill",
          InstallLocation: install,
          LaunchExecutable: "DREDGE.exe",
          LaunchCommand: "",
        }),
      );
      const result = await new EpicParser().execute([], {
        epicManifests: manifests,
        epicLauncherMode: true,
      });
      expect(result.executableLocation).toBe(
        "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(
        result.success.map((s) => [s.extractedAppId, s.launchOptions]),
      ).toEqual([
        [
          "Bluegill",
          '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"com.epicgames.launcher://apps/Bluegill?action=launch&silent=true\\""',
        ],
      ]);
    });

    it("EA's launcher mode too", async () => {
      const dir = path.join(root, "EA Games", "Game", "__Installer");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "installerdata.xml"),
        `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <runtime><launcher><filePath>[x]Game.exe</filePath></launcher></runtime>
  <gameTitles><gameTitle>Game</gameTitle></gameTitles>
  <contentIDs><contentID>1002139</contentID></contentIDs>
</DiPManifest>`,
      );
      const result = await new EADesktopParser().execute([], {
        eaGamesDir: path.join(root, "EA Games"),
      });
      expect(result.executableLocation).toBe(POWERSHELL_EXE);
      expect(result.success.map((s) => s.launchOptions)).toEqual([
        '-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=1002139\\""',
      ]);
    });
  });
});
