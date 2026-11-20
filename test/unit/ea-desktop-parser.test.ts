import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EADesktopParser } from "../../src/lib/parsers/ea-desktop.parser";
import { parseRegQueryOutput } from "../../src/lib/helpers/windows/installed-programs";
import {
  gameFolders,
  installedGames,
  parseInstallerData,
  powershellPath,
} from "../../src/lib/parsers/ea-desktop/installed-games";
import { tempDir } from "../helpers/fixtures";

// Windows' installed-programs lists, as the parser sees them in these tests
// (the real ones would add this machine's EA games).
const registry = vi.hoisted(() => ({ locations: [] as string[] }));
vi.mock(
  "../../src/lib/helpers/windows/installed-programs",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    installLocations: async () => registry.locations,
  }),
);

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, "../fixtures/ea-desktop", name), "utf8");

// EA Desktop writes installerdata.xml as UTF-8 or UTF-16LE (with BOM).
function installerData(title: string, contentId: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <runtime>
    <launcher>
      <filePath>[HKEY_LOCAL_MACHINE\\SOFTWARE\\EA Games\\${title}\\Install Dir]${title}.exe</filePath>
      <parameters>-silent</parameters>
    </launcher>
  </runtime>
  <gameTitles>
    <gameTitle locale="en_US">${title}</gameTitle>
  </gameTitles>
  <contentIDs>
    <contentID>${contentId}</contentID>
  </contentIDs>
</DiPManifest>`;
}

// Installer data that doesn't name the game's exe.
function withoutRuntime(title: string, contentId: string) {
  return `<?xml version="1.0" encoding="utf-8"?>
<DiPManifest version="4.0">
  <gameTitles>
    <gameTitle locale="en_US">${title}</gameTitle>
  </gameTitles>
  <contentIDs>
    <contentID>${contentId}</contentID>
  </contentIDs>
</DiPManifest>`;
}

const root = tempDir("ea");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
// A game folder, with its installer data.
function game(dir: string, xml: string | Buffer) {
  fs.mkdirSync(path.join(dir, "__Installer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "__Installer", "installerdata.xml"), xml);
  return dir;
}

describe("Windows' installed-programs lists (reg.exe output)", () => {
  it("reads each program's InstallLocation, without quotes or blank values", () => {
    // (trimmed from `reg query <list> /s /v InstallLocation` on Windows 11)
    expect(parseRegQueryOutput(fixture("reg-query-wow6432node.txt"))).toEqual([
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools",
      "C:\\Program Files (x86)\\AMD\\Chipset_IODrivers\\",
      "C:\\Program Files (x86)\\Battle.net",
      "D:/UplayLibrary/Far Cry 4/",
      "C:\\Program Files (x86)\\Lenovo\\VantageService\\\\5.1.2609.9",
      "D:\\OriginLibrary\\Alice Madness Returns\\",
    ]);
    expect(parseRegQueryOutput(fixture("reg-query-hkcu.txt"))).toEqual([
      "C:\\Users\\Player\\AppData\\Local\\Discord",
      "D:/Riot Games/VALORANT/live",
      "C:\\Users\\Player\\AppData\\Local\\Wealthfolio",
      "C:\\Program Files (x86)\\WinDirStat",
      "C:\\Users\\Player\\AppData\\Roaming\\Telegram Desktop\\",
    ]);
  });

  it("expands REG_EXPAND_SZ values' variables (any case), not REG_SZ's", () => {
    const key =
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const stdout = [
      "",
      `${key}\\Game`,
      "    InstallLocation    REG_EXPAND_SZ    %programfiles%\\EA Games\\Game",
      "",
      `${key}\\Other`,
      "    InstallLocation    REG_SZ    %ProgramFiles%\\Other",
      "",
      `${key}\\Unknown`,
      "    InstallLocation    REG_EXPAND_SZ    %NOT_SET%\\Unknown",
      "",
      "End of search: 3 match(es) found.",
      "",
    ].join("\r\n");
    expect(
      parseRegQueryOutput(stdout, { ProgramFiles: "C:\\Program Files" }),
    ).toEqual([
      "C:\\Program Files\\EA Games\\Game",
      "%ProgramFiles%\\Other",
      "%NOT_SET%\\Unknown",
    ]);
  });

  it("takes InstallLocation values only; a key without one adds nothing", () => {
    const key =
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
    const stdout = [
      "",
      `${key}\\{93A3AB24-36E8-41BA-80C6-CCEC237836DC}`,
      "    DisplayName    REG_SZ    Alice: Madness ReturnsT",
      '    DisplayIcon    REG_SZ    "D:\\OriginLibrary\\Alice Madness Returns\\Game\\Alice2\\Binaries\\Win32\\AliceMadnessReturns.exe"',
      "    InstallLocation    REG_SZ    D:\\OriginLibrary\\Alice Madness Returns\\",
      "    EstimatedSize    REG_DWORD    0x7e9c5d",
      "",
      `${key}\\NoLocation`,
      "    DisplayName    REG_SZ    No Location",
      "",
      `${key}\\InstallLocation`,
      "",
    ].join("\r\n");
    expect(parseRegQueryOutput(stdout)).toEqual([
      "D:\\OriginLibrary\\Alice Madness Returns\\",
    ]);
    expect(parseRegQueryOutput("")).toEqual([]);
    expect(
      parseRegQueryOutput(
        "ERROR: The system was unable to find the specified registry key or value.\r\n",
      ),
    ).toEqual([]);
  });
});

describe("installerdata.xml", () => {
  // (not read: the exe check is passed in)
  const gameDir = path.join(root, "OriginLibrary", "Alice Madness Returns");

  it("reads the EA app's manifest (Alice: Madness Returns, EA app 13.827)", () => {
    const alice = {
      title: "Alice: Madness Returns™",
      contentId: "alice2_dd",
      filePath: path.join(
        gameDir,
        "Game\\Alice2\\Binaries\\Win32\\AliceMadnessReturns.exe",
      ),
      args: "",
    };
    const xml = fixture("installerdata-alice.xml");
    expect(parseInstallerData(xml, gameDir)).toEqual(alice);
    expect(parseInstallerData(xml, gameDir, { launcherMode: true })).toEqual(
      alice,
    );
  });

  it("in launcher mode needs no exe, only the title and content id", () => {
    const none = () => false;
    const xml = withoutRuntime("No Exe", "Origin.OFR.50.0001");
    expect(parseInstallerData(xml, gameDir, { exists: none })).toMatch(
      /unrecognizable format/,
    );
    expect(
      parseInstallerData(xml, gameDir, { launcherMode: true, exists: none }),
    ).toEqual({
      title: "No Exe",
      contentId: "Origin.OFR.50.0001",
      filePath: gameDir,
      args: undefined,
    });

    // (the older format: no runtime, and no exe named after the folder)
    const older = `<game><metadata><localeInfo><title>Older</title></localeInfo></metadata><contentIDs><contentID>222</contentID></contentIDs></game>`;
    expect(parseInstallerData(older, gameDir, { exists: none })).toMatch(
      /contained no runtime/,
    );
    expect(
      parseInstallerData(older, gameDir, { launcherMode: true, exists: none }),
    ).toMatchObject({ title: "Older", contentId: "222", filePath: gameDir });
  });

  it("skips a file that isn't XML", () => {
    expect(parseInstallerData("<DiPManifest>", gameDir)).toBeUndefined();
  });
});

describe("game folders", () => {
  const library = path.join(root, "folders", "Library");
  const one = game(path.join(library, "Game One"), installerData("One", "1"));
  const alice = game(
    path.join(root, "folders", "OriginLibrary", "Alice Madness Returns"),
    fixture("installerdata-alice.xml"),
  );
  const notEA = path.join(root, "folders", "Not EA");
  fs.mkdirSync(notEA, { recursive: true });

  it("adds the folders Windows lists that hold EA installer data, outside the folder field too", async () => {
    expect(
      await gameFolders({
        gamesDir: library,
        installLocations: [alice + path.sep, notEA, "Alice Madness Returns"],
      }),
    ).toEqual([one, alice]);
  });

  it("lists a folder once, however many lists name it and however they write it", async () => {
    expect(
      await gameFolders({
        gamesDir: library,
        installLocations: [
          one,
          one + path.sep,
          one.replaceAll("\\", "/"),
          one.toUpperCase(),
          alice,
          alice,
        ],
      }),
    ).toEqual([one, alice]);
  });

  it("searches EA's default folders (those that exist) only when the folder field is empty", async () => {
    const missing = path.join(root, "folders", "Missing");
    expect(
      await gameFolders({
        gamesDir: "",
        installLocations: [],
        defaultDirs: [missing, library],
      }),
    ).toEqual([one]);
    expect(
      await gameFolders({
        gamesDir: path.join(root, "folders", "OriginLibrary"),
        installLocations: [],
        defaultDirs: [library],
      }),
    ).toEqual([alice]);
  });
});

describe("games", () => {
  const dir = path.join(root, "games");
  const noExe = game(
    path.join(dir, "No Exe"),
    withoutRuntime("No Exe", "Origin.OFR.50.0001"),
  );

  it("in launcher mode, lists a game whose exe can't be found; exe mode doesn't", async () => {
    expect(await installedGames([noExe], true)).toEqual({
      success: [
        {
          extractedTitle: "No Exe",
          extractedAppId: "Origin.OFR.50.0001",
          launchOptions: `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=Origin.OFR.50.0001\\""`,
          filePath: noExe,
          fileLaunchOptions: undefined,
        },
      ],
      failed: [],
    });
    const exeMode = await installedGames([noExe], false);
    expect(exeMode.success).toEqual([]);
    expect(exeMode.failed).toEqual([
      expect.stringMatching(/unrecognizable format/),
    ]);
  });

  it("lists a game once, by its first content id", async () => {
    const first = game(path.join(dir, "First"), installerData("First", "333"));
    const copy = game(path.join(dir, "Copy"), installerData("Copy", "333"));
    const { success } = await installedGames([first, copy], true);
    expect(success.map((s) => [s.extractedTitle, s.extractedAppId])).toEqual([
      ["First", "333"],
    ]);
  });
});

describe("PowerShell, which launcher-mode shortcuts start", () => {
  it("keeps the path existing shortcuts (and so their app ids) have", () => {
    const usual =
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    for (const systemRoot of [
      "C:\\WINDOWS",
      "C:\\Windows",
      "c:\\windows\\",
      undefined,
    ]) {
      expect(powershellPath(systemRoot)).toBe(usual);
    }
    expect(powershellPath("D:\\Win")).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe.runIf(os.type() === "Windows_NT")("EA Desktop parser", () => {
  beforeEach(() => {
    registry.locations = [];
  });
  const dir = path.join(root, "parser");
  game(
    path.join(dir, "Game One"),
    Buffer.from(installerData("Game One", "111"), "utf8"),
  );
  game(
    path.join(dir, "Game Two"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(installerData("Game Two", "222"), "utf16le"),
    ]),
  );

  it("reads UTF-8 and UTF-16LE installer data (was: failed on a Blob in the main process)", async () => {
    const result = await new EADesktopParser().execute([], {
      eaGamesDir: dir,
    });
    expect(result.failed).toEqual([]);
    expect(
      result.success
        .map((s) => [s.extractedTitle, s.extractedAppId, s.fileLaunchOptions])
        .sort(),
    ).toEqual([
      ["Game One", "111", "-silent"],
      ["Game Two", "222", "-silent"],
    ]);
    // (the exe SRM always made of the folder found and the installer data:
    // shortcuts keep their app ids, which come from exe and title)
    expect(result.success.map((s) => s.filePath).sort()).toEqual([
      path.join(dir, "Game One", "Game One.exe"),
      path.join(dir, "Game Two", "Game Two.exe"),
    ]);
  });

  it("finds the games Windows lists as installed, wherever the EA app put them", async () => {
    const alice = game(
      path.join(root, "parser-elsewhere", "Alice Madness Returns"),
      fixture("installerdata-alice.xml"),
    );
    // (Game One also from the list, written differently: listed once)
    registry.locations = [
      alice + "\\",
      path.join(dir, "Game One").toUpperCase(),
    ];
    const result = await new EADesktopParser().execute([], {
      eaGamesDir: dir,
      eaLauncherMode: true,
    });
    expect(result.executableLocation).toBe(
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(
      result.success.map((s) => [s.extractedTitle, s.launchOptions]).sort(),
    ).toEqual([
      [
        "Alice: Madness Returns™",
        `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"origin2://game/launch/?offerIds=alice2_dd\\""`,
      ],
      ["Game One", expect.stringContaining("offerIds=111")],
      ["Game Two", expect.stringContaining("offerIds=222")],
    ]);
  });
});
