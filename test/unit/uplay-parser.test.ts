// UPlay (Ubisoft Connect): the games the parser finds (from the registry and
// Ubisoft Connect's configuration cache) and the wrapper they get for "Wait
// for the game to exit".
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parserScript } from "../../src/lib/launch-wrapper";
import {
  gameFolder,
  ubisoftWaitForExitWrapper,
} from "../../src/lib/launch-wrapper/launchers";
import { parseRegQueryValues } from "../../src/lib/helpers/windows/installed-programs";
import {
  CachedConfiguration,
  configurationsFile,
  parseConfigurations,
  ubisoftGameNames,
  ubisoftGames,
  ubisoftInstalls,
} from "../../src/lib/parsers/uplay/installed-games";
import { UPlayParser } from "../../src/lib/parsers/uplay.parser";
import { tempDir } from "../helpers/fixtures";

// The registry as reg.exe prints it, as the parser sees it in these tests
// (the real one would add this machine's games): Ubisoft Connect's Installs
// key (in the 32-bit view) and Windows' installed-programs lists.
const registry = vi.hoisted(() => ({ installs: "", uninstall: "" }));
vi.mock(
  "../../src/lib/helpers/windows/installed-programs",
  async (importOriginal) => {
    const real: any = await importOriginal();
    return {
      ...real,
      queryRegistryValues: async (
        key: string,
        value: string,
        flags: string[],
      ) =>
        key === "HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs" &&
        flags.join(" ") === "/reg:32"
          ? real.parseRegQueryValues(registry.installs, value)
          : [],
      installedProgramValues: async (value: string) =>
        real.parseRegQueryValues(registry.uninstall, value),
    };
  },
);

const installsKey = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs";
const uninstallKey =
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall";

// `reg query HKLM\SOFTWARE\Ubisoft\Launcher\Installs /s /v InstallDir
// /reg:32`, with these games' folders.
function installsOutput(games: [string, string][]) {
  return [
    "",
    ...games.flatMap(([id, dir]) => [
      `${installsKey}\\${id}`,
      `    InstallDir    REG_SZ    ${dir}`,
      "",
    ]),
    `End of search: ${games.length} match(es) found.`,
    "",
  ].join("\r\n");
}

// `reg query <installed-programs list> /s /v DisplayName` (trimmed from
// Windows 11 with Ubisoft Connect 13416)
const uninstallOutput = [
  "",
  `${uninstallKey}\\{1F1C2DFC-2D24-3E06-BCB8-725134ADF989}`,
  "    DisplayName    REG_SZ    Microsoft Visual C++ 2008 Redistributable - x86 9.0.30729.4148",
  "",
  `${uninstallKey}\\Uplay`,
  "    DisplayName    REG_SZ    Ubisoft Connect",
  "",
  `${uninstallKey}\\Uplay Install 273`,
  "    DisplayName    REG_SZ    Assassin's Creed IV Black Flag",
  "",
  `${uninstallKey}\\Uplay Install 420`,
  "    DisplayName    REG_SZ    Far Cry 4",
  "",
  `${uninstallKey}\\Uplay Install 46`,
  "    DisplayName    REG_SZ    Far Cry® 3",
  "",
  "End of search: 5 match(es) found.",
  "",
].join("\r\n");

// Ubisoft Connect's configuration cache: per game a record of its id and its
// YAML configuration, framed as Ubisoft Connect frames them:
// 0a <length> 08 <id> 10 <id> 1a <length> <YAML>.
function varint(n: number) {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return bytes;
}
function record(id: number, configuration: string) {
  const text = Buffer.from(configuration.replace(/\n/g, "\r\n"), "utf8");
  const inner = Buffer.concat([
    Buffer.from([0x08, ...varint(id), 0x10, ...varint(id)]),
    Buffer.from([0x1a, ...varint(text.length)]),
    text,
  ]);
  return Buffer.concat([Buffer.from([0x0a, ...varint(inner.length)]), inner]);
}
// A game's configuration (trimmed from Ubisoft Connect's): its first
// executable `path` and anything more under root.
function configuration(title: string, path: string, more = "") {
  return `version: 2.0
root:
  name: "${title}"
  sort_string: "${title}"
  start_game:
    online:
      executables:
        - path:
            ${path}
          working_directory:
            register: HKEY_LOCAL_MACHINE\\SOFTWARE\\Ubisoft\\Launcher\\Installs\\1\\InstallDir
    offline:
      executables:
        - path:
            ${path}
${more}  installer:
    game_identifier: ${title}
    publisher: Ubisoft
localizations:
  default:
    l1: "${title}"
`;
}
const cache = Buffer.concat([
  // (its first executable named by the registry: SRM never listed it)
  record(
    46,
    configuration(
      "Far Cry 3",
      "register: HKEY_CURRENT_USER\\SOFTWARE\\UBISOFT\\Far Cry 3\\ExecutableName",
    ),
  ),
  record(
    273,
    configuration("Assassin's Creed IV Black Flag", "relative: AC4BFSP.exe"),
  ),
  // (bought on Steam)
  record(
    3539,
    configuration(
      "Assassin's Creed Origins",
      "relative: ACOrigins.exe",
      "  third_party_platform:\n    name: steam\n",
    ),
  ),
  // (a DLC: no start_game)
  record(
    1234,
    "version: 2.0\nroot:\n  name: Season Pass\n  is_dlc: yes\nlocalizations:\n  default:\n    l1: Season Pass\n",
  ),
  record(
    635,
    configuration(
      "Prince of Persia The Forgotten Sands",
      "relative: Prince of Persia.exe",
    ),
  ),
]);
const cached: CachedConfiguration[] = [
  {
    launcherId: 46,
    title: "Far Cry 3",
    relativeExe: undefined,
    thirdPartyPlatform: false,
  },
  {
    launcherId: 273,
    title: "Assassin's Creed IV Black Flag",
    relativeExe: "AC4BFSP.exe",
    thirdPartyPlatform: false,
  },
  {
    launcherId: 3539,
    title: "Assassin's Creed Origins",
    relativeExe: "ACOrigins.exe",
    thirdPartyPlatform: true,
  },
  {
    launcherId: 635,
    title: "Prince of Persia The Forgotten Sands",
    relativeExe: "Prince of Persia.exe",
    thirdPartyPlatform: false,
  },
];

const launchOptions = (id: string) =>
  `-windowStyle hidden -NoProfile -ExecutionPolicy Bypass -Command "&Start-Process \\"uplay://launch/${id}\\""`;

describe("Ubisoft Connect's configuration cache", () => {
  it("reads each game's id, title, exe and store; the file's last game too (was: dropped)", () => {
    expect(parseConfigurations(cache)).toEqual(cached);
  });

  it("is the user's, else the directory override's; there may be none (current Ubisoft Connect only writes configurations.vdat)", () => {
    const root = tempDir("uplay-cache");
    const local = path.join(root, "Local");
    const ubisoft = path.join(root, "Ubisoft");
    const file = (dir: string) =>
      path.join(
        dir,
        "Ubisoft Game Launcher",
        "cache",
        "configuration",
        "configurations",
      );
    fs.mkdirSync(path.dirname(file(local)), { recursive: true });
    fs.writeFileSync(
      path.join(path.dirname(file(local)), "configurations.vdat"),
      "",
    );
    expect(configurationsFile(ubisoft, local)).toBeUndefined();
    fs.mkdirSync(path.dirname(file(ubisoft)), { recursive: true });
    fs.writeFileSync(file(ubisoft), cache);
    expect(configurationsFile(ubisoft, local)).toBe(file(ubisoft));
    fs.writeFileSync(file(local), cache);
    expect(configurationsFile(ubisoft, local)).toBe(file(local));
  });
});

describe("the registry (reg.exe output)", () => {
  beforeEach(() => {
    registry.installs = "";
    registry.uninstall = "";
  });

  it("lists the games Ubisoft Connect installed, from its Installs key in the 32-bit view", async () => {
    // (as `reg query` prints it on Windows 11 with Ubisoft Connect 13416)
    registry.installs = [
      "",
      `${installsKey}\\273`,
      "    InstallDir    REG_SZ    D:/UplayLibrary/Assassin's Creed IV Black Flag/",
      "",
      `${installsKey}\\420`,
      "    InstallDir    REG_SZ    D:/UplayLibrary/Far Cry 4/",
      "",
      `${installsKey}\\46`,
      "    InstallDir    REG_SZ    D:/UplayLibrary/Far Cry 3/",
      "",
      `${installsKey}\\not-an-id`,
      "    InstallDir    REG_SZ    D:/UplayLibrary/Other/",
      "",
      `${installsKey}\\99`,
      "    InstallDir    REG_SZ    ",
      "",
      "End of search: 5 match(es) found.",
      "",
    ].join("\r\n");
    expect(await ubisoftInstalls()).toEqual([
      {
        id: "273",
        installDir: "D:/UplayLibrary/Assassin's Creed IV Black Flag/",
      },
      { id: "420", installDir: "D:/UplayLibrary/Far Cry 4/" },
      { id: "46", installDir: "D:/UplayLibrary/Far Cry 3/" },
    ]);
  });

  it("names the games as Windows' installed-programs lists do (their 'Uplay Install <id>' entries)", async () => {
    registry.uninstall = uninstallOutput;
    expect(await ubisoftGameNames()).toEqual({
      "273": "Assassin's Creed IV Black Flag",
      "420": "Far Cry 4",
      "46": "Far Cry® 3",
    });
  });

  it("reads values with their keys; other values and keys without the value add nothing", () => {
    expect(parseRegQueryValues(uninstallOutput, "DisplayName")).toContainEqual({
      key: `${uninstallKey}\\Uplay Install 420`,
      data: "Far Cry 4",
    });
    expect(
      parseRegQueryValues(
        `\r\n${installsKey}\\46\r\n    InstallDirectory    REG_SZ    D:\\X\r\n    Language    REG_SZ    en-US\r\n`,
        "InstallDir",
      ),
    ).toEqual([]);
    expect(parseRegQueryValues("", "InstallDir")).toEqual([]);
  });
});

describe("games", () => {
  const installs = [
    {
      id: "273",
      installDir: "D:/UplayLibrary/Assassin's Creed IV Black Flag/",
    },
    { id: "3539", installDir: "D:/UplayLibrary/Assassin's Creed Origins/" },
    { id: "420", installDir: "D:/UplayLibrary/Far Cry 4/" },
    { id: "46", installDir: "D:/UplayLibrary/Far Cry 3/" },
    // (no configuration, no installed-programs entry)
    { id: "1771", installDir: "D:/UplayLibrary/Anno 1800/" },
    // (its folder is gone)
    { id: "857", installDir: "D:/UplayLibrary/Rayman Origins/" },
    // (installed by Steam)
    {
      id: "1843",
      installDir:
        "C:/Program Files (x86)/Steam/steamapps/common/Rayman Legends/",
    },
  ];
  const exists = (folder: string) => !folder.includes("Rayman Origins");
  const names = {
    "273": "Assassin's Creed IV Black Flag",
    "420": "Far Cry 4",
    "46": "Far Cry® 3",
  };
  // (what SRM has always listed for Assassin's Creed IV: its app id comes
  // from its title and, in exe mode, its exe)
  const blackFlag = {
    extractedTitle: "Assassin's Creed IV Black Flag",
    extractedAppId: "273",
    launchOptions: launchOptions("273"),
    filePath: "D:\\UplayLibrary\\Assassin's Creed IV Black Flag\\AC4BFSP.exe",
  };

  it("launcher mode lists every game Ubisoft Connect installed, named by the cache, else Windows' list, else its folder", () => {
    expect(
      ubisoftGames({
        installs,
        configurations: cached,
        names,
        launcherMode: true,
        exists,
      }),
    ).toEqual([
      blackFlag,
      // (no exe needed: the link only takes the id)
      {
        extractedTitle: "Far Cry 4",
        extractedAppId: "420",
        launchOptions: launchOptions("420"),
        filePath: "D:\\UplayLibrary\\Far Cry 4",
      },
      {
        extractedTitle: "Far Cry 3",
        extractedAppId: "46",
        launchOptions: launchOptions("46"),
        filePath: "D:\\UplayLibrary\\Far Cry 3",
      },
      {
        extractedTitle: "Anno 1800",
        extractedAppId: "1771",
        launchOptions: launchOptions("1771"),
        filePath: "D:\\UplayLibrary\\Anno 1800",
      },
    ]);
  });

  it("without the cache, launcher mode still lists them", () => {
    expect(
      ubisoftGames({
        installs,
        configurations: [],
        names,
        launcherMode: true,
        exists,
      }).map((game) => [game.extractedTitle, game.filePath]),
    ).toEqual([
      [
        "Assassin's Creed IV Black Flag",
        "D:\\UplayLibrary\\Assassin's Creed IV Black Flag",
      ],
      [
        "Assassin's Creed Origins",
        "D:\\UplayLibrary\\Assassin's Creed Origins",
      ],
      ["Far Cry 4", "D:\\UplayLibrary\\Far Cry 4"],
      ["Far Cry® 3", "D:\\UplayLibrary\\Far Cry 3"],
      ["Anno 1800", "D:\\UplayLibrary\\Anno 1800"],
    ]);
  });

  it("exe mode lists only the games whose exe the cache names, as before", () => {
    const games = ubisoftGames({
      installs,
      configurations: cached,
      names,
      launcherMode: false,
      exists,
      waitForExit: true,
    });
    expect(games).toEqual([blackFlag]);
  });

  it("waits for every game to exit, found by its folder, when launching via Ubisoft Connect", () => {
    const games = ubisoftGames({
      installs,
      configurations: cached,
      names,
      launcherMode: true,
      waitForExit: true,
      steamOverlay: true,
      exists,
    });
    expect(games.map((game) => game.launchWrapper)).toEqual(
      ["273", "420", "46", "1771"].map((id) =>
        ubisoftWaitForExitWrapper(
          id,
          installs.find((install) => install.id === id).installDir,
          { steamOverlay: true },
        ),
      ),
    );
    expect(games[2].launchWrapper.game).toEqual({
      folder: "D:\\UplayLibrary\\Far Cry 3",
      startTimeoutMinutes: 10,
    });
  });
});

describe.runIf(os.type() === "Windows_NT")("UPlay parser", () => {
  const root = tempDir("uplay");
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  const localAppData = process.env.LOCALAPPDATA;
  afterAll(() => {
    process.env.LOCALAPPDATA = localAppData;
  });
  const ubisoftDir = path.join(root, "Ubisoft");
  const library = path.join(root, "UplayLibrary");
  const farCry3 = path.join(library, "Far Cry 3");
  const blackFlag = path.join(library, "Assassin's Creed IV Black Flag");

  beforeEach(() => {
    // (not this machine's cache)
    process.env.LOCALAPPDATA = path.join(root, "Local");
    fs.rmSync(ubisoftDir, { recursive: true, force: true });
    for (const dir of [farCry3, blackFlag]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    registry.installs = installsOutput([
      ["273", `${blackFlag.replace(/\\/g, "/")}/`],
      ["46", `${farCry3.replace(/\\/g, "/")}/`],
    ]);
    registry.uninstall = uninstallOutput;
  });
  const withCache = () => {
    const dir = path.join(
      ubisoftDir,
      "Ubisoft Game Launcher",
      "cache",
      "configuration",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "configurations"), cache);
  };
  const parse = (inputs: { [key: string]: any }) =>
    new UPlayParser().execute([], { uplayDir: ubisoftDir, ...inputs });

  it("in launcher mode, lists the games the cache can't give an exe (was: only Assassin's Creed IV)", async () => {
    withCache();
    const result = await parse({ uplayLauncherMode: true });
    expect(result.executableLocation).toBe(
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(
      result.success.map((game) => [game.extractedTitle, game.filePath]),
    ).toEqual([
      ["Assassin's Creed IV Black Flag", path.join(blackFlag, "AC4BFSP.exe")],
      ["Far Cry 3", farCry3],
    ]);
    expect(result.failed).toEqual([]);
  });

  it("in launcher mode, needs no cache; exe mode does", async () => {
    const result = await parse({ uplayLauncherMode: true });
    expect(result.success.map((game) => game.extractedTitle)).toEqual([
      "Assassin's Creed IV Black Flag",
      "Far Cry® 3",
    ]);
    await expect(parse({ uplayLauncherMode: false })).rejects.toContain(
      "UPlay not installed",
    );
  });

  it("without a cache or an installed game, says Ubisoft Connect isn't installed", async () => {
    registry.installs = "";
    await expect(parse({ uplayLauncherMode: true })).rejects.toContain(
      "UPlay not installed",
    );
  });

  it("in exe mode, lists the games the cache gives an exe", async () => {
    withCache();
    const result = await parse({ uplayLauncherMode: false });
    expect(
      result.success.map((game) => [game.extractedTitle, game.filePath]),
    ).toEqual([
      ["Assassin's Creed IV Black Flag", path.join(blackFlag, "AC4BFSP.exe")],
    ]);
  });

  it("passes its wait-for-exit and Steam overlay settings on, in launcher mode only", async () => {
    withCache();
    const waiting = await parse({
      uplayLauncherMode: true,
      uplayWaitForExit: true,
      uplaySteamOverlay: true,
    });
    expect(waiting.success.map((game) => game.launchWrapper)).toEqual([
      ubisoftWaitForExitWrapper("273", `${blackFlag}\\`, {
        steamOverlay: true,
      }),
      ubisoftWaitForExitWrapper("46", `${farCry3}\\`, { steamOverlay: true }),
    ]);
    const exeMode = await parse({
      uplayLauncherMode: false,
      uplayWaitForExit: true,
    });
    expect(exeMode.success[0].launchWrapper).toBeUndefined();
  });
});

describe("UPlay: wait for the game to exit", () => {
  it("hands the launch to Ubisoft Connect through SRM's launch script, which watches the game's folder", () => {
    // (the registry's InstallDir, as Ubisoft Connect writes it)
    const folder = "D:\\UplayLibrary\\Far Cry 3";
    expect(
      ubisoftWaitForExitWrapper("46", "D:/UplayLibrary/Far Cry 3/"),
    ).toEqual({
      launch: { file: "uplay://launch/46/0" },
      // (by folder only: Far Cry 3's game is farcry3_d3d11.exe, not the
      // executable its configuration names)
      game: { folder, startTimeoutMinutes: 10 },
      preLaunch: [
        {
          script: parserScript("ubisoft-connect-start.ps1"),
          args: ["-GameFolder", folder],
        },
      ],
      postLaunch: [
        { script: parserScript("ubisoft-connect-start.ps1"), args: ["-Mark"] },
      ],
      postExit: [
        {
          script: parserScript("ubisoft-connect-stop.ps1"),
          args: ["-GameFolder", folder],
        },
      ],
    });
  });

  it("with the Steam overlay setting, an open Ubisoft Connect is closed before the launch", () => {
    const wrapper = ubisoftWaitForExitWrapper("420", "D:\\Games\\Far Cry 4\\", {
      steamOverlay: true,
    });
    expect(wrapper.preLaunch).toEqual([
      {
        script: parserScript("ubisoft-connect-start.ps1"),
        args: ["-GameFolder", "D:\\Games\\Far Cry 4", "-Restart"],
      },
    ]);
  });

  it("not for a game in a drive's root or without a folder: every program there would count as the game", () => {
    for (const dir of ["D:/", "D:\\", "D:", "", "games\\Far Cry 3"]) {
      expect(ubisoftWaitForExitWrapper("46", dir), dir).toBeUndefined();
    }
    expect(gameFolder("\\\\server\\share\\")).toBeUndefined();
    expect(gameFolder("\\\\server\\share\\Games\\X\\")).toBe(
      "\\\\server\\share\\Games\\X",
    );
  });
});
